// Load opencascade.js dynamically
import {
  SolidTaskRequest,
  SolidTaskResponse,
  WorkerRequest,
  WorkerResponse,
  ExtrudeProfileResponseData,
  FeatureEvalOp,
  MeshResult,
} from './SolidEngine.types';
import type { SketchProfile, ProfileSegment } from '../../types/cad';

let oc: any = null;
let currentSolid: any = null; // Store the current solid compound for evaluation and export

const getBaseUrl = () => {
  // 生產環境 (Production)：Vite 會將 Worker 打包進 /assets/ 資料夾
  if (self.location.pathname.includes('/assets/')) {
    return self.location.origin + self.location.pathname.split('/assets/')[0] + '/';
  }
  // 開發環境 (Development)：直接返回 origin
  return self.location.origin + '/';
};

async function initWorker(wasmBuffer?: ArrayBuffer) {
  if (!oc) {
    const baseUrl = getBaseUrl();
    const jsUrl = `${baseUrl}occ/opencascade.wasm.js`;
    const wasmUrl = `${baseUrl}occ/opencascade.wasm.wasm`;

    // 由於我們現在使用 classic worker (?worker)，可以直接使用 importScripts
    try {
      (self as any).importScripts(jsUrl);
    } catch (e) {
      console.warn("importScripts failed, falling back to fetch+eval.", e);
      const scriptRes = await fetch(jsUrl);
      if (!scriptRes.ok) {
        throw new Error(`Failed to fetch OCC JS: ${scriptRes.status}`);
      }
      const scriptText = await scriptRes.text();
      (new Function(scriptText))();
    }

    let activeWasmBuffer = wasmBuffer;
    if (!activeWasmBuffer) {
      try {
        const parts = [
          'opencascade.wasm.part0.bin',
          'opencascade.wasm.part1.bin',
          'opencascade.wasm.part2.bin',
          'opencascade.wasm.part3.bin',
        ];
        const buffers = await Promise.all(
          parts.map(async (part) => {
            const res = await fetch(`${baseUrl}occ/${part}`);
            if (!res.ok) throw new Error(`Chunk ${part} fetch failed: ${res.status}`);
            return res.arrayBuffer();
          })
        );
        const total = buffers.reduce((acc, b) => acc + b.byteLength, 0);
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const b of buffers) {
          combined.set(new Uint8Array(b), offset);
          offset += b.byteLength;
        }
        activeWasmBuffer = combined.buffer;
      } catch (chunkErr) {
        console.warn('Worker chunk fetch failed, falling back to monolithic wasm:', chunkErr);
        const wasmRes = await fetch(wasmUrl);
        if (!wasmRes.ok) {
          throw new Error(`Failed to fetch OpenCASCADE WASM from ${wasmUrl}: ${wasmRes.statusText}`);
        }
        activeWasmBuffer = await wasmRes.arrayBuffer();
      }
    }

    (self as any).opencascade = {
      wasmBinary: activeWasmBuffer,
    };

    oc = await (self as any).initOpenCascade((self as any).opencascade);
  }
}

function setTranslationVec(trsf: any, vec: any) {
  if (typeof trsf.SetTranslation_1 === 'function') {
    trsf.SetTranslation_1(vec);
  } else {
    trsf.SetTranslation(vec);
  }
}

function setRotationAx1(trsf: any, ax1: any, angle: number) {
  if (typeof trsf.SetRotation_1 === 'function') {
    trsf.SetRotation_1(ax1, angle);
  } else {
    trsf.SetRotation(ax1, angle);
  }
}

function setMirrorAx2(trsf: any, ax2: any) {
  if (typeof trsf.SetMirror_3 === 'function') {
    trsf.SetMirror_3(ax2);
  } else if (typeof trsf.SetMirror_2 === 'function') {
    trsf.SetMirror_2(ax2);
  } else {
    trsf.SetMirror(ax2);
  }
}

/**
 * 拓撲邊界方向判斷輔助函式：
 * 透過取 Edge 頂點座標：
 * 若 Math.abs(p1.z - p2.z) > Math.hypot(p1.x - p2.x, p1.y - p2.y) * 2 判定為垂直邊；
 * 若 Math.abs(p1.z - p2.z) < 1e-3 判定為水平邊。
 */
function getEdgeDirection(
  edge: any,
  occ: any
): 'vertical' | 'horizontal' | 'other' {
  const vExp = new occ.TopExp_Explorer_2(
    edge,
    occ.TopAbs_ShapeEnum.TopAbs_VERTEX,
    occ.TopAbs_ShapeEnum.TopAbs_SHAPE
  );

  let p1: { x: number; y: number; z: number } | null = null;
  let p2: { x: number; y: number; z: number } | null = null;

  if (vExp.More()) {
    const v1 = occ.TopoDS.Vertex_1(vExp.Current());
    const pt1 = occ.BRep_Tool.Pnt(v1);
    p1 = { x: pt1.X(), y: pt1.Y(), z: pt1.Z() };
    pt1.delete();
    v1.delete();
    vExp.Next();
  }

  if (vExp.More()) {
    const v2 = occ.TopoDS.Vertex_1(vExp.Current());
    const pt2 = occ.BRep_Tool.Pnt(v2);
    p2 = { x: pt2.X(), y: pt2.Y(), z: pt2.Z() };
    pt2.delete();
    v2.delete();
    vExp.Next();
  }

  vExp.delete();

  if (!p1 || !p2) {
    return 'other';
  }

  const dz = Math.abs(p1.z - p2.z);
  const dxy = Math.hypot(p1.x - p2.x, p1.y - p2.y);

  if (dz > dxy * 2) {
    return 'vertical';
  }
  if (dz < 1e-3) {
    return 'horizontal';
  }
  return 'other';
}

/**
 * 輔助函式：從圓形、起點、終點與旋向安全構建 TopoDS_Edge 圓弧段
 * 修正 OpenCASCADE.js embind 簽章：
 * 1. 使用 GC_MakeArcOfCircle_3(circ, p1, p2, sense)（4個參數）
 * 2. mkArc.Value() 回傳 Handle_Geom_TrimmedCurve，透過 Handle_Geom_Curve_2 向上轉型為 Handle_Geom_Curve
 * 3. 傳入 BRepBuilderAPI_MakeEdge_24(curveHandle) 構建邊
 * 4. 具備 BRepBuilderAPI_MakeEdge_10 與直線連通的健壯回退機制
 */
function createArcEdge(
  occ: any,
  circle: any,
  p1: any,
  p2: any,
  sense: boolean
): any {
  // 方法一：標準 GC_MakeArcOfCircle_3 (gp_Circ, gp_Pnt, gp_Pnt, Standard_Boolean sense)
  if (typeof occ.GC_MakeArcOfCircle_3 === 'function') {
    try {
      const mkArc = new occ.GC_MakeArcOfCircle_3(circle, p1, p2, sense);
      if (mkArc.IsDone()) {
        const trimmed = mkArc.Value();
        let geomCurve: any = null;
        if (typeof occ.Handle_Geom_Curve_2 === 'function') {
          geomCurve = new occ.Handle_Geom_Curve_2(trimmed.get());
        }
        const curveHandle = geomCurve || trimmed;
        if (typeof occ.BRepBuilderAPI_MakeEdge_24 === 'function') {
          const mkEdge = new occ.BRepBuilderAPI_MakeEdge_24(curveHandle);
          if (mkEdge.IsDone()) {
            const edge = mkEdge.Edge();
            mkEdge.delete();
            if (geomCurve) geomCurve.delete();
            trimmed.delete();
            mkArc.delete();
            return edge;
          }
          mkEdge.delete();
        }
        if (geomCurve) geomCurve.delete();
        trimmed.delete();
      }
      mkArc.delete();
    } catch (arcErr) {
      console.warn('createArcEdge via GC_MakeArcOfCircle_3 failed:', arcErr);
    }
  }

  // 方法二：直接以圓形與起迄點構建邊（BRepBuilderAPI_MakeEdge_10）
  if (typeof occ.BRepBuilderAPI_MakeEdge_10 === 'function') {
    try {
      const mkEdge = sense
        ? new occ.BRepBuilderAPI_MakeEdge_10(circle, p1, p2)
        : new occ.BRepBuilderAPI_MakeEdge_10(circle, p2, p1);
      if (mkEdge.IsDone()) {
        const edge = mkEdge.Edge();
        mkEdge.delete();
        return edge;
      }
      mkEdge.delete();
    } catch (edgeErr) {
      console.warn('createArcEdge via BRepBuilderAPI_MakeEdge_10 failed:', edgeErr);
    }
  }

  // 方法三：降級回退為直線段，確保拓撲閉合不崩潰
  try {
    const mkEdge = (typeof occ.BRepBuilderAPI_MakeEdge_3 === 'function')
      ? new occ.BRepBuilderAPI_MakeEdge_3(p1, p2)
      : new occ.BRepBuilderAPI_MakeEdge_1(p1, p2);
    if (mkEdge.IsDone()) {
      const edge = mkEdge.Edge();
      mkEdge.delete();
      return edge;
    }
    mkEdge.delete();
  } catch (lineErr) {
    console.warn('createArcEdge fallback line failed:', lineErr);
  }

  return null;
}

function buildWireFromSegments(segments: ProfileSegment[], occ: any): any {
  const wireMaker = new occ.BRepBuilderAPI_MakeWire_1();

  for (const seg of segments) {
    const p1 = new occ.gp_Pnt_3(seg.start.x, seg.start.y, 0);
    const p2 = new occ.gp_Pnt_3(seg.end.x, seg.end.y, 0);

    if (seg.type === 'line') {
      const mkEdge = (typeof occ.BRepBuilderAPI_MakeEdge_3 === 'function')
        ? new occ.BRepBuilderAPI_MakeEdge_3(p1, p2)
        : new occ.BRepBuilderAPI_MakeEdge_1(p1, p2);
      if (mkEdge.IsDone()) {
        wireMaker.Add_1(mkEdge.Edge());
      }
      mkEdge.delete();
    } else if (seg.type === 'arc' && seg.center && seg.radius) {
      const center = new occ.gp_Pnt_3(seg.center.x, seg.center.y, 0);
      const dir = new occ.gp_Dir_4(0, 0, 1);
      const ax2 = new occ.gp_Ax2_3(center, dir);
      const circle = new occ.gp_Circ_2(ax2, seg.radius);

      const sense = seg.sweepFlag !== undefined ? seg.sweepFlag === 1 : true;
      const arcEdge = createArcEdge(occ, circle, p1, p2, sense);
      if (arcEdge) {
        wireMaker.Add_1(arcEdge);
        arcEdge.delete();
      }
      circle.delete();
      ax2.delete();
      dir.delete();
      center.delete();
    }
    p1.delete();
    p2.delete();
  }

  const wire = wireMaker.Wire();
  wireMaker.delete();
  return wire;
}

function buildWireFromPoints(points: { x: number; y: number }[], occ: any): any {
  const wireMaker = new occ.BRepBuilderAPI_MakeWire_1();
  const len = points.length;
  for (let i = 0; i < len; i++) {
    const pt1 = points[i];
    const pt2 = points[(i + 1) % len];
    const p1 = new occ.gp_Pnt_3(pt1.x, pt1.y, 0);
    const p2 = new occ.gp_Pnt_3(pt2.x, pt2.y, 0);
    const mkEdge = (typeof occ.BRepBuilderAPI_MakeEdge_3 === 'function')
      ? new occ.BRepBuilderAPI_MakeEdge_3(p1, p2)
      : new occ.BRepBuilderAPI_MakeEdge_1(p1, p2);
    if (mkEdge.IsDone()) {
      wireMaker.Add_1(mkEdge.Edge());
    }
    mkEdge.delete();
    p1.delete();
    p2.delete();
  }
  const wire = wireMaker.Wire();
  wireMaker.delete();
  return wire;
}

function createFaceFromProfile(profile: SketchProfile, occ: any): any {
  // 1. Build Outer Wire
  let outerWire: any;
  if (profile.segments && profile.segments.length > 0) {
    outerWire = buildWireFromSegments(profile.segments, occ);
  } else if (profile.outerLoop && profile.outerLoop.length > 1) {
    outerWire = buildWireFromPoints(profile.outerLoop, occ);
  } else {
    throw new Error(`Profile ${profile.id || ''} has no valid segments or outer loop`);
  }

  // 2. Build Face
  const faceMaker = new occ.BRepBuilderAPI_MakeFace_15(outerWire, true);

  // 3. Build Inner Wires (Holes)
  if (profile.innerSegments && profile.innerSegments.length > 0) {
    for (const innerSegs of profile.innerSegments) {
      if (innerSegs.length > 0) {
        const innerWire = buildWireFromSegments(innerSegs, occ);
        faceMaker.Add(innerWire);
        innerWire.delete();
      }
    }
  } else if (profile.innerLoops && profile.innerLoops.length > 0) {
    for (const innerLoop of profile.innerLoops) {
      if (innerLoop.length > 1) {
        const innerWire = buildWireFromPoints(innerLoop, occ);
        faceMaker.Add(innerWire);
        innerWire.delete();
      }
    }
  }

  const face = faceMaker.Face();

  // Clean up
  outerWire.delete();
  faceMaker.delete();

  return face;
}

/**
 * 空間 Wire 變換函式：將 2D LCS 的 Wire 變換為 3D WCS 基準面下的空間 Wire
 */
function transformWireTo3D(
  wire2D: any,
  plane: {
    origin?: { x: number; y: number; z: number };
    normal?: { x: number; y: number; z: number };
    xAxis?: { x: number; y: number; z: number };
    yAxis?: { x: number; y: number; z: number };
  },
  occ: any
): any {
  const origin = plane?.origin || { x: 0, y: 0, z: 0 };
  const normal = plane?.normal || { x: 0, y: 0, z: 1 };
  const xAxis = plane?.xAxis || { x: 1, y: 0, z: 0 };

  const fromOrig = new occ.gp_Pnt_3(0, 0, 0);
  const fromNorm = new occ.gp_Dir_4(0, 0, 1);
  const fromXDir = new occ.gp_Dir_4(1, 0, 0);
  const fromAx = new occ.gp_Ax3_3(fromOrig, fromNorm, fromXDir);

  const toOrig = new occ.gp_Pnt_3(origin.x, origin.y, origin.z);
  const toNorm = new occ.gp_Dir_4(normal.x, normal.y, normal.z);
  const toXDir = new occ.gp_Dir_4(xAxis.x, xAxis.y, xAxis.z);
  const toAx = new occ.gp_Ax3_3(toOrig, toNorm, toXDir);

  const alignTrsf = new occ.gp_Trsf_1();
  alignTrsf.SetDisplacement(fromAx, toAx);

  const alignXform = new occ.BRepBuilderAPI_Transform_2(wire2D, alignTrsf, true);
  const transformedShape = alignXform.Shape();
  const transformedWire = occ.TopoDS.Wire_1(transformedShape);

  // Clean up intermediate transformation objects
  fromOrig.delete();
  fromNorm.delete();
  fromXDir.delete();
  fromAx.delete();
  toOrig.delete();
  toNorm.delete();
  toXDir.delete();
  toAx.delete();
  alignTrsf.delete();
  alignXform.delete();

  return transformedWire;
}

/**
 * 空間 Face 變換函式：將 2D LCS 的帶孔 Face 轉換至 3D 空間基準面姿態
 */
function transformFaceTo3D(
  face2D: any,
  plane: {
    origin?: { x: number; y: number; z: number };
    normal?: { x: number; y: number; z: number };
    xAxis?: { x: number; y: number; z: number };
    yAxis?: { x: number; y: number; z: number };
  },
  occ: any
): any {
  const origin = plane?.origin || { x: 0, y: 0, z: 0 };
  const normal = plane?.normal || { x: 0, y: 0, z: 1 };
  const xAxis = plane?.xAxis || { x: 1, y: 0, z: 0 };
  const yAxis = plane?.yAxis || { x: 0, y: 1, z: 0 };

  const fromOrig = new occ.gp_Pnt_3(0, 0, 0);
  const fromNorm = new occ.gp_Dir_4(0, 0, 1);
  const fromXDir = new occ.gp_Dir_4(1, 0, 0);
  const fromAx = new occ.gp_Ax3_3(fromOrig, fromNorm, fromXDir);

  const toOrig = new occ.gp_Pnt_3(origin.x, origin.y, origin.z);
  const toNorm = new occ.gp_Dir_4(normal.x, normal.y, normal.z);
  const toXDir = new occ.gp_Dir_4(xAxis.x, xAxis.y, xAxis.z);
  const toAx = new occ.gp_Ax3_3(toOrig, toNorm, toXDir);
  
  const calcY = {
    x: normal.y * xAxis.z - normal.z * xAxis.y,
    y: normal.z * xAxis.x - normal.x * xAxis.z,
    z: normal.x * xAxis.y - normal.y * xAxis.x
  };
  const dot = calcY.x * yAxis.x + calcY.y * yAxis.y + calcY.z * yAxis.z;
  if (dot < 0) {
    toAx.YReverse();
  }

  const alignTrsf = new occ.gp_Trsf_1();
  alignTrsf.SetDisplacement(fromAx, toAx);

  const alignXform = new occ.BRepBuilderAPI_Transform_2(face2D, alignTrsf, true);
  const transformedShape = alignXform.Shape();
  const transformedFace = occ.TopoDS.Face_1(transformedShape);

  // Clean up intermediate transformation objects
  fromOrig.delete();
  fromNorm.delete();
  fromXDir.delete();
  fromAx.delete();
  toOrig.delete();
  toNorm.delete();
  toXDir.delete();
  toAx.delete();
  alignTrsf.delete();
  alignXform.delete();

  return transformedFace;
}

/**
 * 路徑 Wire 構建函式：從 3D 導引路徑段（line/arc）縫合為 TopoDS_Wire
 */
function buildPathWire(
  segments: {
    type: 'line' | 'arc';
    start: { x: number; y: number; z: number };
    end: { x: number; y: number; z: number };
    center?: { x: number; y: number; z: number };
    radius?: number;
    sweepFlag?: number | boolean;
  }[],
  occ: any
): any {
  const wireMaker = new occ.BRepBuilderAPI_MakeWire_1();

  for (const seg of segments) {
    const p1 = new occ.gp_Pnt_3(seg.start.x, seg.start.y, seg.start.z);
    const p2 = new occ.gp_Pnt_3(seg.end.x, seg.end.y, seg.end.z);

    if (seg.type === 'line') {
      const mkEdge = (typeof occ.BRepBuilderAPI_MakeEdge_3 === 'function')
        ? new occ.BRepBuilderAPI_MakeEdge_3(p1, p2)
        : new occ.BRepBuilderAPI_MakeEdge_1(p1, p2);
      if (mkEdge.IsDone()) {
        wireMaker.Add_1(mkEdge.Edge());
      }
      mkEdge.delete();
    } else if (seg.type === 'arc') {
      if (seg.center) {
        const center = new occ.gp_Pnt_3(seg.center.x, seg.center.y, seg.center.z);
        // Calculate normal vector from center, start, end
        const v1x = seg.start.x - seg.center.x;
        const v1y = seg.start.y - seg.center.y;
        const v1z = seg.start.z - seg.center.z;
        const v2x = seg.end.x - seg.center.x;
        const v2y = seg.end.y - seg.center.y;
        const v2z = seg.end.z - seg.center.z;

        // Cross product v1 x v2
        const nx = v1y * v2z - v1z * v2y;
        const ny = v1z * v2x - v1x * v2z;
        const nz = v1x * v2y - v1y * v2x;
        const nLen = Math.hypot(nx, ny, nz);

        let dir: any;
        if (nLen > 1e-6) {
          dir = new occ.gp_Dir_4(nx / nLen, ny / nLen, nz / nLen);
        } else {
          dir = new occ.gp_Dir_4(0, 0, 1);
        }

        const radius = seg.radius || Math.hypot(v1x, v1y, v1z);
        const ax2 = new occ.gp_Ax2_3(center, dir);
        const circle = new occ.gp_Circ_2(ax2, radius);

        const sense = seg.sweepFlag !== undefined ? (seg.sweepFlag === 1 || seg.sweepFlag === true) : true;
        const arcEdge = createArcEdge(occ, circle, p1, p2, sense);
        if (arcEdge) {
          wireMaker.Add_1(arcEdge);
          arcEdge.delete();
        }
        circle.delete();
        ax2.delete();
        dir.delete();
        center.delete();
      }
    }
    p1.delete();
    p2.delete();
  }

  const wire = wireMaker.Wire();
  wireMaker.delete();
  return wire;
}

/**
 * Creates a 3D feature solid from 2D profiles using either Extrusion or Revolve operations.
 * Performs face creation, 3D spatial alignment (or axis configuration), and feature generation.
 */
function createFeatureSolid(op: FeatureEvalOp, occ: any): any {
  if (!op.profiles || op.profiles.length === 0) {
    throw new Error(`Feature ${op.featureId || ''} has no profiles to evaluate`);
  }

  const isRevolve = op.type === 'REVOLVE' || op.type === 'REVOLVE_CUT';
  const featureSolids: any[] = [];

  const plane: any = op.plane || {};
  const origin = plane.origin || { x: 0, y: 0, z: 0 };
  const normal = plane.normal || { x: 0, y: 0, z: 1 };
  const xAxis = plane.xAxis || { x: 1, y: 0, z: 0 };
  const yAxis = plane.yAxis || { x: 0, y: 1, z: 0 };

  for (const profile of op.profiles) {
    const localFace = createFaceFromProfile(profile, occ);

    if (isRevolve) {
      // 1. Transform local 2D face to 3D datum plane position
      const transformedFace = transformFaceTo3D(localFace, { origin, normal, xAxis, yAxis }, occ);
      localFace.delete();

      // 2. Setup 3D Axis of Revolution
      const axisOrigin = op.axis?.origin || { x: 0, y: 0, z: 0 };
      const axisDirVec = op.axis?.direction || { x: 0, y: 1, z: 0 };
      const angle = typeof op.angle === 'number' && !isNaN(op.angle) ? op.angle : 2 * Math.PI;

      const axPnt = new occ.gp_Pnt_3(axisOrigin.x, axisOrigin.y, axisOrigin.z);
      const axDir = new occ.gp_Dir_4(axisDirVec.x, axisDirVec.y, axisDirVec.z);
      const axis = new occ.gp_Ax1_2(axPnt, axDir);

      // 3. Revolve around 3D axis
      let revolSolid = null;
      try {
        const revolMaker = new occ.BRepPrimAPI_MakeRevol_1(transformedFace, axis, angle, false);
        revolSolid = revolMaker.Shape();
        revolMaker.delete();
      } catch (err) {
        console.error('SolidWorker: Failed to create Revolve feature:', err);
      }

      // Clean up revolve objects
      transformedFace.delete();
      axPnt.delete();
      axDir.delete();
      axis.delete();

      if (revolSolid) {
        featureSolids.push(revolSolid);
      }
    } else {
      // EXTRUDE / CUT_EXTRUDE
      const depth = typeof op.depth === 'number' && !isNaN(op.depth) ? op.depth : 10;

      // 1. Local extrusion along Z-axis (0, 0, depth)
      const vec = new occ.gp_Vec_4(0, 0, depth);
      let localSolid = null;
      try {
        const prismMaker = new occ.BRepPrimAPI_MakePrism_1(localFace, vec, false, true);
        localSolid = prismMaker.Shape();
        prismMaker.delete();
      } catch (err) {
        console.error('SolidWorker: Failed to create Extrude feature:', err);
      }

      // Clean up face and vector
      localFace.delete();
      vec.delete();

      if (!localSolid) {
        continue;
      }

      // 2. Local direction offset shift
      if (op.direction === 'mid-plane') {
        const trsfMid = new occ.gp_Trsf_1();
        const vecMid = new occ.gp_Vec_4(0, 0, -depth / 2);
        trsfMid.SetTranslation_1(vecMid);
        const xformMid = new occ.BRepBuilderAPI_Transform_2(localSolid, trsfMid, true);
        const shiftedSolid = xformMid.Shape();

        localSolid.delete();
        trsfMid.delete();
        vecMid.delete();
        xformMid.delete();

        localSolid = shiftedSolid;
      } else if (op.direction === 'reversed') {
        const trsfRev = new occ.gp_Trsf_1();
        const vecRev = new occ.gp_Vec_4(0, 0, -depth);
        trsfRev.SetTranslation_1(vecRev);
        const xformRev = new occ.BRepBuilderAPI_Transform_2(localSolid, trsfRev, true);
        const shiftedSolid = xformRev.Shape();

        localSolid.delete();
        trsfRev.delete();
        vecRev.delete();
        xformRev.delete();

        localSolid = shiftedSolid;
      }

      // 3. Spatial posture alignment (affine transform to 3D sketch plane coordinate system)
      const fromOrig = new occ.gp_Pnt_3(0, 0, 0);
      const fromNorm = new occ.gp_Dir_4(0, 0, 1);
      const fromXDir = new occ.gp_Dir_4(1, 0, 0);
      const fromAx = new occ.gp_Ax3_3(fromOrig, fromNorm, fromXDir);

      const toOrig = new occ.gp_Pnt_3(origin.x, origin.y, origin.z);
      const toNorm = new occ.gp_Dir_4(normal.x, normal.y, normal.z);
      const toXDir = new occ.gp_Dir_4(xAxis.x, xAxis.y, xAxis.z);
      const toAx = new occ.gp_Ax3_3(toOrig, toNorm, toXDir);

      const calcY = {
        x: normal.y * xAxis.z - normal.z * xAxis.y,
        y: normal.z * xAxis.x - normal.x * xAxis.z,
        z: normal.x * xAxis.y - normal.y * xAxis.x
      };
      const dot = calcY.x * yAxis.x + calcY.y * yAxis.y + calcY.z * yAxis.z;
      if (dot < 0) {
        toAx.YReverse();
      }

      const alignTrsf = new occ.gp_Trsf_1();
      alignTrsf.SetDisplacement(fromAx, toAx);

      const alignXform = new occ.BRepBuilderAPI_Transform_2(localSolid, alignTrsf, true);
      const transformedSolid = alignXform.Shape();

      // Clean up temporary alignment objects and local solid
      localSolid.delete();
      fromOrig.delete();
      fromNorm.delete();
      fromXDir.delete();
      fromAx.delete();
      toOrig.delete();
      toNorm.delete();
      toXDir.delete();
      toAx.delete();
      alignTrsf.delete();
      alignXform.delete();

      featureSolids.push(transformedSolid);
    }
  }

  if (featureSolids.length === 1) {
    return featureSolids[0];
  }

  // Bundle multiple profiles into a TopoDS_Compound
  const builder = new occ.BRep_Builder();
  const compound = new occ.TopoDS_Compound();
  builder.MakeCompound(compound);

  for (const fs of featureSolids) {
    builder.Add(compound, fs);
    fs.delete();
  }

  builder.delete();
  return compound;
}

function tessellateSolid(solid: any, occ: any): ExtrudeProfileResponseData {
  if (!solid || solid.IsNull()) {
    return {
      vertices: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
    };
  }

  // Incremental mesh
  const mesher = new occ.BRepMesh_IncrementalMesh_2(solid, 0.1, false, 0.5, false);

  const vertices: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let indexOffset = 0;

  const explorer = new occ.TopExp_Explorer_2(
    solid,
    occ.TopAbs_ShapeEnum.TopAbs_FACE,
    occ.TopAbs_ShapeEnum.TopAbs_SHAPE
  );

  while (explorer.More()) {
    const face = occ.TopoDS.Face_1(explorer.Current());
    const loc = new occ.TopLoc_Location_1();
    const triangulation = occ.BRep_Tool.Triangulation(face, loc);

    if (!triangulation.IsNull()) {
      const tri = triangulation.get();
      const numNodes = tri.NbNodes();
      const numTriangles = tri.NbTriangles();

      const nodeArray = tri.Nodes();

      let normalArray = null;
      if (tri.HasNormals()) {
        normalArray = tri.Normals();
      }

      const trsf = loc.Transformation();

      for (let i = 1; i <= numNodes; i++) {
        const origPnt = nodeArray.Value(i);
        const pnt = origPnt.Transformed(trsf);
        vertices.push(pnt.X(), pnt.Y(), pnt.Z());
        pnt.delete();
        origPnt.delete();

        if (normalArray) {
          const n = normalArray.Value(i);
          normals.push(n.X(), n.Y(), n.Z());
          n.delete();
        } else {
          normals.push(0, 0, 1); // fallback normal
        }
      }

      trsf.delete();

      const triangleArray = tri.Triangles();
      const faceOrientation = (face as any).Orientation_1 ? (face as any).Orientation_1() : (face as any).Orientation();
      const reverse = faceOrientation === occ.TopAbs_Orientation.TopAbs_REVERSED;

      for (let i = 1; i <= numTriangles; i++) {
        const triangle = triangleArray.Value(i);
        const n1 = triangle.Value(1);
        const n2 = triangle.Value(2);
        const n3 = triangle.Value(3);

        if (reverse) {
          indices.push(indexOffset + n1 - 1, indexOffset + n3 - 1, indexOffset + n2 - 1);
        } else {
          indices.push(indexOffset + n1 - 1, indexOffset + n2 - 1, indexOffset + n3 - 1);
        }
        triangle.delete();
      }

      indexOffset += numNodes;

      nodeArray.delete();
      triangleArray.delete();
      if (normalArray) normalArray.delete();
      triangulation.delete();
    } else {
      triangulation.delete();
    }

    face.delete();
    loc.delete();
    explorer.Next();
  }

  mesher.delete();
  explorer.delete();

  const vArray = new Float32Array(vertices);
  const nArray = new Float32Array(normals);
  const iArray = indexOffset > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);

  return { vertices: vArray, normals: nArray, indices: iArray };
}

const _self = self as any;

_self.onmessage = async (e: MessageEvent<SolidTaskRequest | WorkerRequest>) => {
  const req = e.data;

  try {
    switch (req.type) {
      case 'INIT': {
        await initWorker(req.payload?.wasmBuffer);
        _self.postMessage({ taskId: req.taskId, type: req.type, success: true } as SolidTaskResponse);
        break;
      }

      case 'EVALUATE_FEATURE_TREE': {
        if (!oc) throw new Error('Worker not initialized');
        const occ = oc;

        const operations: FeatureEvalOp[] = req.payload?.operations || [];

        // Clean up previous global solid if present
        if (currentSolid) {
          currentSolid.delete();
          currentSolid = null;
        }

        // 維護特徵獨立實體字典 (Per-Feature Solid Cache)
        const featureSolids = new Map<string, any>();

        try {
          for (const op of operations) {
            if (
              op.type === 'EXTRUDE' ||
              op.type === 'CUT_EXTRUDE' ||
              op.type === 'REVOLVE' ||
              op.type === 'REVOLVE_CUT'
            ) {
            const featureSolid = createFeatureSolid(op, occ);
            if (!featureSolid || featureSolid.IsNull()) {
              continue;
            }

            if (op.featureId) {
              featureSolids.set(op.featureId, featureSolid);
            }

            const isCut = op.operation === 'CUT' || op.type === 'CUT_EXTRUDE' || op.type === 'REVOLVE_CUT';

            if (currentSolid === null) {
              // First feature evaluation
              if (!isCut && (op.operation === 'JOIN' || op.type === 'EXTRUDE' || op.type === 'REVOLVE')) {
                currentSolid = featureSolid;
              } else {
                // CUT operation requires an existing base body
              }
            } else {
              if (!isCut) {
                // Boolean Fuse (JOIN)
                const fuse = new occ.BRepAlgoAPI_Fuse_3(currentSolid, featureSolid);
                fuse.Build();
                if (fuse.IsDone()) {
                  const newSolid = fuse.Shape();
                  if (currentSolid !== featureSolid) {
                    currentSolid.delete();
                  }
                  currentSolid = newSolid;
                }
                fuse.delete();
              } else {
                // Boolean Cut (CUT)
                const cut = new occ.BRepAlgoAPI_Cut_3(currentSolid, featureSolid);
                cut.Build();
                if (cut.IsDone()) {
                  const newSolid = cut.Shape();
                  if (currentSolid !== featureSolid) {
                    currentSolid.delete();
                  }
                  currentSolid = newSolid;
                }
                cut.delete();
              }
            }
          } else if (op.type === 'SWEEP') {
            if (!op.sweepData || !op.sweepData.pathSegments || op.sweepData.pathSegments.length === 0) {
              continue;
            }
            if (!op.profiles || op.profiles.length === 0) {
              continue;
            }

            // 1. 構建 3D 導引路徑 pathWire
            const pathWire = buildPathWire(op.sweepData.pathSegments, occ);

            const sweepSolids: any[] = [];

            for (const profile of op.profiles) {
              // 2. 建立截面 2D TopoDS_Face
              const localFace = createFaceFromProfile(profile, occ);
              // 3. 轉換至 op.plane 的 3D 空間姿態
              const spatialFace = transformFaceTo3D(localFace, op.plane || {}, occ);
              localFace.delete();

              // 4. 實例化 BRepOffsetAPI_MakePipe 生成實體
              const pipeMaker = (typeof occ.BRepOffsetAPI_MakePipe_1 === 'function')
                ? new occ.BRepOffsetAPI_MakePipe_1(pathWire, spatialFace)
                : new occ.BRepOffsetAPI_MakePipe(pathWire, spatialFace);

              pipeMaker.Build();
              if (pipeMaker.IsDone()) {
                const pipeSolid = pipeMaker.Shape();
                sweepSolids.push(pipeSolid);
              }

              spatialFace.delete();
              pipeMaker.delete();
            }

            pathWire.delete();

            if (sweepSolids.length === 0) {
              continue;
            }

            let featureSolid: any = null;
            if (sweepSolids.length === 1) {
              featureSolid = sweepSolids[0];
            } else {
              const builder = new occ.BRep_Builder();
              const compound = new occ.TopoDS_Compound();
              builder.MakeCompound(compound);
              for (const s of sweepSolids) {
                builder.Add(compound, s);
                s.delete();
              }
              builder.delete();
              featureSolid = compound;
            }

            if (featureSolid && !featureSolid.IsNull()) {
              if (op.featureId) {
                featureSolids.set(op.featureId, featureSolid);
              }

              const isCut = op.operation === 'CUT';

              if (currentSolid === null) {
                if (!isCut) {
                  currentSolid = featureSolid;
                }
              } else {
                if (!isCut) {
                  const fuse = new occ.BRepAlgoAPI_Fuse_3(currentSolid, featureSolid);
                  fuse.Build();
                  if (fuse.IsDone()) {
                    const newSolid = fuse.Shape();
                    if (currentSolid !== featureSolid) {
                      currentSolid.delete();
                    }
                    currentSolid = newSolid;
                  }
                  fuse.delete();
                } else {
                  const cut = new occ.BRepAlgoAPI_Cut_3(currentSolid, featureSolid);
                  cut.Build();
                  if (cut.IsDone()) {
                    const newSolid = cut.Shape();
                    if (currentSolid !== featureSolid) {
                      currentSolid.delete();
                    }
                    currentSolid = newSolid;
                  }
                  cut.delete();
                }
              }
            }
          } else if (op.type === 'LOFT') {
            if (!op.loftData || !op.loftData.sections || op.loftData.sections.length < 2) {
              continue;
            }

            const isSolid = op.loftData.isSolid ?? true;
            const ruled = op.loftData.ruled ?? false;
            const thruSections = new occ.BRepOffsetAPI_ThruSections(isSolid, ruled, 1.0e-6);

            const intermediateWires: any[] = [];

            for (const section of op.loftData.sections) {
              if (!section.profiles || section.profiles.length === 0) continue;
              for (const profile of section.profiles) {
                let localWire: any = null;
                if (profile.segments && profile.segments.length > 0) {
                  localWire = buildWireFromSegments(profile.segments, occ);
                } else if (profile.outerLoop && profile.outerLoop.length > 1) {
                  localWire = buildWireFromPoints(profile.outerLoop, occ);
                }
                if (!localWire) continue;

                const spatialWire = transformWireTo3D(localWire, section.plane, occ);
                localWire.delete();

                thruSections.AddWire(spatialWire);
                intermediateWires.push(spatialWire);
              }
            }

            thruSections.Build();

            let featureSolid: any = null;
            if (thruSections.IsDone()) {
              featureSolid = thruSections.Shape();
            }

            // 釋放中繼 Wire 與構建器
            for (const w of intermediateWires) {
              w.delete();
            }
            thruSections.delete();

            if (featureSolid && !featureSolid.IsNull()) {
              if (op.featureId) {
                featureSolids.set(op.featureId, featureSolid);
              }

              const isCut = op.operation === 'CUT';

              if (currentSolid === null) {
                if (!isCut) {
                  currentSolid = featureSolid;
                }
              } else {
                if (!isCut) {
                  const fuse = new occ.BRepAlgoAPI_Fuse_3(currentSolid, featureSolid);
                  fuse.Build();
                  if (fuse.IsDone()) {
                    const newSolid = fuse.Shape();
                    if (currentSolid !== featureSolid) {
                      currentSolid.delete();
                    }
                    currentSolid = newSolid;
                  }
                  fuse.delete();
                } else {
                  const cut = new occ.BRepAlgoAPI_Cut_3(currentSolid, featureSolid);
                  cut.Build();
                  if (cut.IsDone()) {
                    const newSolid = cut.Shape();
                    if (currentSolid !== featureSolid) {
                      currentSolid.delete();
                    }
                    currentSolid = newSolid;
                  }
                  cut.delete();
                }
              }
            }
          } else if (
            op.type === 'LINEAR_PATTERN' ||
            op.type === 'CIRCULAR_PATTERN' ||
            op.type === 'MIRROR_3D'
          ) {
            // 從 featureSolids 取得目標特徵實體（若未指定或找不到，退化取 currentSolid 作為母體）
            let sourceSolid: any = null;
            let shouldDeleteSourceSolid = false;
            if (op.targetFeatureIds && op.targetFeatureIds.length > 0) {
              const sources: any[] = [];
              for (const tid of op.targetFeatureIds) {
                if (featureSolids.has(tid)) {
                  sources.push(featureSolids.get(tid));
                }
              }
              if (sources.length === 1) {
                sourceSolid = sources[0];
              } else if (sources.length > 1) {
                const builder = new occ.BRep_Builder();
                const compound = new occ.TopoDS_Compound();
                builder.MakeCompound(compound);
                for (const s of sources) {
                  builder.Add(compound, s);
                }
                builder.delete();
                sourceSolid = compound;
                shouldDeleteSourceSolid = true;
              }
            }
            if (!sourceSolid || sourceSolid.IsNull()) {
              sourceSolid = currentSolid;
              shouldDeleteSourceSolid = false;
            }

            if (!sourceSolid || sourceSolid.IsNull()) {
              continue;
            }

            if (op.type === 'LINEAR_PATTERN') {
              const pat = op.patternLinear;
              if (pat) {
                const dir1 = pat.dir1 || { x: 1, y: 0, z: 0 };
                const count1 = typeof pat.count1 === 'number' && pat.count1 > 0 ? pat.count1 : 1;
                const spacing1 = typeof pat.spacing1 === 'number' ? pat.spacing1 : 0;

                const dir2 = pat.dir2 || { x: 0, y: 1, z: 0 };
                const count2 = typeof pat.count2 === 'number' && pat.count2 > 0 ? pat.count2 : 1;
                const spacing2 = typeof pat.spacing2 === 'number' ? pat.spacing2 : 0;

                for (let i = 0; i < count1; i++) {
                  for (let j = 0; j < count2; j++) {
                    if (i === 0 && j === 0) continue;

                    const dx = i * spacing1 * dir1.x + j * spacing2 * (dir2?.x || 0);
                    const dy = i * spacing1 * dir1.y + j * spacing2 * (dir2?.y || 0);
                    const dz = i * spacing1 * dir1.z + j * spacing2 * (dir2?.z || 0);

                    const vec = new occ.gp_Vec_4(dx, dy, dz);
                    const trsf = new occ.gp_Trsf_1();
                    setTranslationVec(trsf, vec);

                    const xform = new occ.BRepBuilderAPI_Transform_2(sourceSolid, trsf, true);
                    const transformedCopy = xform.Shape();

                    if (currentSolid === null) {
                      currentSolid = transformedCopy;
                    } else {
                      const fuse = new occ.BRepAlgoAPI_Fuse_3(currentSolid, transformedCopy);
                      fuse.Build();
                      if (fuse.IsDone()) {
                        const newSolid = fuse.Shape();
                        currentSolid.delete();
                        currentSolid = newSolid;
                      }
                      fuse.delete();
                      transformedCopy.delete();
                    }

                    xform.delete();
                    trsf.delete();
                    vec.delete();
                  }
                }
              }
            } else if (op.type === 'CIRCULAR_PATTERN') {
              const pat = op.patternCircular;
              if (pat) {
                const axisOrigin = pat.axis?.origin || { x: 0, y: 0, z: 0 };
                const axisDirVec = pat.axis?.direction || { x: 0, y: 0, z: 1 };
                const count = typeof pat.count === 'number' && pat.count > 0 ? pat.count : 1;
                let totalAngle = typeof pat.totalAngle === 'number' && !isNaN(pat.totalAngle) ? pat.totalAngle : 2 * Math.PI;

                if (totalAngle > 2 * Math.PI + 0.1) {
                  totalAngle = (totalAngle * Math.PI) / 180;
                }

                const equalSpacing = pat.equalSpacing !== false;

                let deltaTheta = 0;
                if (equalSpacing) {
                  const isFullCircle = Math.abs(totalAngle - 2 * Math.PI) < 1e-4;
                  if (isFullCircle) {
                    deltaTheta = totalAngle / count;
                  } else {
                    deltaTheta = count > 1 ? totalAngle / (count - 1) : totalAngle;
                  }
                } else {
                  deltaTheta = totalAngle;
                }

                const axPnt = new occ.gp_Pnt_3(axisOrigin.x, axisOrigin.y, axisOrigin.z);
                const axDir = new occ.gp_Dir_4(axisDirVec.x, axisDirVec.y, axisDirVec.z);
                const rotAxis = new occ.gp_Ax1_2(axPnt, axDir);

                for (let k = 1; k < count; k++) {
                  const angle = k * deltaTheta;
                  const trsf = new occ.gp_Trsf_1();
                  setRotationAx1(trsf, rotAxis, angle);

                  const xform = new occ.BRepBuilderAPI_Transform_2(sourceSolid, trsf, true);
                  const transformedCopy = xform.Shape();

                  if (currentSolid === null) {
                    currentSolid = transformedCopy;
                  } else {
                    const fuse = new occ.BRepAlgoAPI_Fuse_3(currentSolid, transformedCopy);
                    fuse.Build();
                    if (fuse.IsDone()) {
                      const newSolid = fuse.Shape();
                      currentSolid.delete();
                      currentSolid = newSolid;
                    }
                    fuse.delete();
                    transformedCopy.delete();
                  }

                  xform.delete();
                  trsf.delete();
                }

                rotAxis.delete();
                axDir.delete();
                axPnt.delete();
              }
            } else if (op.type === 'MIRROR_3D') {
              const plane = op.mirrorPlane;
              if (plane) {
                const origin = plane.origin || { x: 0, y: 0, z: 0 };
                const normal = plane.normal || { x: 0, y: 0, z: 1 };

                const pnt = new occ.gp_Pnt_3(origin.x, origin.y, origin.z);
                const dir = new occ.gp_Dir_4(normal.x, normal.y, normal.z);
                const ax2 = new occ.gp_Ax2_3(pnt, dir);

                const trsf = new occ.gp_Trsf_1();
                setMirrorAx2(trsf, ax2);

                const xform = new occ.BRepBuilderAPI_Transform_2(sourceSolid, trsf, true);
                const mirroredCopy = xform.Shape();

                if (currentSolid === null) {
                  currentSolid = mirroredCopy;
                } else {
                  const fuse = new occ.BRepAlgoAPI_Fuse_3(currentSolid, mirroredCopy);
                  fuse.Build();
                  if (fuse.IsDone()) {
                    const newSolid = fuse.Shape();
                    currentSolid.delete();
                    currentSolid = newSolid;
                  }
                  fuse.delete();
                  mirroredCopy.delete();
                }

                xform.delete();
                trsf.delete();
                ax2.delete();
                dir.delete();
                pnt.delete();
              }
            }

            if (shouldDeleteSourceSolid && sourceSolid) {
              sourceSolid.delete();
            }

            if (op.featureId && currentSolid) {
              featureSolids.set(op.featureId, currentSolid);
            }
          } else if (op.type === 'FILLET_3D') {
            if (!currentSolid || currentSolid.IsNull()) {
              continue;
            }

            const radius = typeof op.fillet3D?.radius === 'number' && !isNaN(op.fillet3D.radius)
              ? op.fillet3D.radius
              : 1.0;
            const mode = op.fillet3D?.edgeSelectionMode || 'all';

            const fillet = (typeof occ.BRepFilletAPI_MakeFillet_1 === 'function')
              ? new occ.BRepFilletAPI_MakeFillet_1(currentSolid, 0)
              : new occ.BRepFilletAPI_MakeFillet(currentSolid, 0);

            const exp = new occ.TopExp_Explorer_2(
              currentSolid,
              occ.TopAbs_ShapeEnum.TopAbs_EDGE,
              occ.TopAbs_ShapeEnum.TopAbs_SHAPE
            );

            let addedCount = 0;
            while (exp.More()) {
              const edgeShape = exp.Current();
              const edge = occ.TopoDS.Edge_1(edgeShape);

              let shouldAdd = false;
              if (mode === 'all') {
                shouldAdd = true;
              } else {
                const dir = getEdgeDirection(edge, occ);
                if (mode === 'vertical' && dir === 'vertical') {
                  shouldAdd = true;
                } else if (mode === 'horizontal' && dir === 'horizontal') {
                  shouldAdd = true;
                }
              }

              if (shouldAdd) {
                if (typeof fillet.Add_2 === 'function') {
                  fillet.Add_2(radius, edge);
                } else {
                  fillet.Add(radius, edge);
                }
                addedCount++;
              }

              edge.delete();
              exp.Next();
            }
            exp.delete();

            if (addedCount > 0) {
              fillet.Build();
              if (fillet.IsDone()) {
                const newSolid = fillet.Shape();
                currentSolid.delete();
                currentSolid = newSolid;
              }
            }

            fillet.delete();

            if (op.featureId && currentSolid) {
              featureSolids.set(op.featureId, currentSolid);
            }
          } else if (op.type === 'CHAMFER_3D') {
            if (!currentSolid || currentSolid.IsNull()) {
              continue;
            }

            const distance = typeof op.chamfer3D?.distance === 'number' && !isNaN(op.chamfer3D.distance)
              ? op.chamfer3D.distance
              : 1.0;
            const mode = op.chamfer3D?.edgeSelectionMode || 'all';

            const chamfer = (typeof occ.BRepFilletAPI_MakeChamfer_1 === 'function')
              ? new occ.BRepFilletAPI_MakeChamfer_1(currentSolid)
              : new occ.BRepFilletAPI_MakeChamfer(currentSolid);

            const exp = new occ.TopExp_Explorer_2(
              currentSolid,
              occ.TopAbs_ShapeEnum.TopAbs_EDGE,
              occ.TopAbs_ShapeEnum.TopAbs_SHAPE
            );

            let addedCount = 0;
            while (exp.More()) {
              const edgeShape = exp.Current();
              const edge = occ.TopoDS.Edge_1(edgeShape);

              let shouldAdd = false;
              if (mode === 'all') {
                shouldAdd = true;
              } else {
                const dir = getEdgeDirection(edge, occ);
                if (mode === 'vertical' && dir === 'vertical') {
                  shouldAdd = true;
                } else if (mode === 'horizontal' && dir === 'horizontal') {
                  shouldAdd = true;
                }
              }

              if (shouldAdd) {
                if (typeof chamfer.Add_2 === 'function') {
                  chamfer.Add_2(distance, edge);
                } else {
                  chamfer.Add(distance, edge);
                }
                addedCount++;
              }

              edge.delete();
              exp.Next();
            }
            exp.delete();

            if (addedCount > 0) {
              chamfer.Build();
              if (chamfer.IsDone()) {
                const newSolid = chamfer.Shape();
                currentSolid.delete();
                currentSolid = newSolid;
              }
            }

            chamfer.delete();

            if (op.featureId && currentSolid) {
              featureSolids.set(op.featureId, currentSolid);
            }
          } else if (op.type === 'SHELL_3D') {
            if (!currentSolid || currentSolid.IsNull()) {
              continue;
            }

            const rawThickness = typeof op.shell3D?.thickness === 'number' && !isNaN(op.shell3D.thickness)
              ? op.shell3D.thickness
              : 1.0;
            const isInside = op.shell3D?.direction !== 'outside';
            const offset = isInside ? -Math.abs(rawThickness) : Math.abs(rawThickness);

            const closingFaces = new occ.TopTools_ListOfShape_1();

            // 遍歷母體實體面 TopExp_Explorer(currentSolid, TopAbs_FACE)
            const expFace = new occ.TopExp_Explorer_2(
              currentSolid,
              occ.TopAbs_ShapeEnum.TopAbs_FACE,
              occ.TopAbs_ShapeEnum.TopAbs_SHAPE
            );

            let highestFace: any = null;
            let maxZ = -Infinity;

            while (expFace.More()) {
              const faceShape = expFace.Current();
              const face = occ.TopoDS.Face_1(faceShape);

              // 計算該面的平均 Z 座標
              const vExp = new occ.TopExp_Explorer_2(
                face,
                occ.TopAbs_ShapeEnum.TopAbs_VERTEX,
                occ.TopAbs_ShapeEnum.TopAbs_SHAPE
              );

              let zSum = 0;
              let vCount = 0;
              while (vExp.More()) {
                const v = occ.TopoDS.Vertex_1(vExp.Current());
                const pnt = occ.BRep_Tool.Pnt(v);
                zSum += pnt.Z();
                vCount++;
                pnt.delete();
                v.delete();
                vExp.Next();
              }
              vExp.delete();

              const avgZ = vCount > 0 ? zSum / vCount : 0;
              if (avgZ > maxZ) {
                maxZ = avgZ;
                if (highestFace) {
                  highestFace.delete();
                }
                highestFace = face;
              } else {
                face.delete();
              }

              expFace.Next();
            }
            expFace.delete();

            if (highestFace) {
              closingFaces.Append_1(highestFace);
              highestFace.delete();
            }

            let hollow: any = null;
            if (typeof occ.BRepOffsetAPI_MakeThickSolid_ByJoin === 'function') {
              hollow = new occ.BRepOffsetAPI_MakeThickSolid_ByJoin(
                currentSolid,
                closingFaces,
                offset,
                1e-4,
                0,
                false,
                false,
                0,
                false
              );
            } else if (typeof occ.BRepOffsetAPI_MakeThickSolid_1 === 'function') {
              hollow = new occ.BRepOffsetAPI_MakeThickSolid_1();
              hollow.MakeThickSolidByJoin(
                currentSolid,
                closingFaces,
                offset,
                1e-4,
                0,
                false,
                false,
                0,
                false
              );
            } else if (typeof occ.BRepOffsetAPI_MakeThickSolid_2 === 'function') {
              hollow = new occ.BRepOffsetAPI_MakeThickSolid_2(
                currentSolid,
                closingFaces,
                offset,
                1e-4
              );
            } else {
              hollow = new occ.BRepOffsetAPI_MakeThickSolid();
              if (typeof hollow.MakeThickSolidByJoin === 'function') {
                hollow.MakeThickSolidByJoin(
                  currentSolid,
                  closingFaces,
                  offset,
                  1e-4,
                  0,
                  false,
                  false,
                  0,
                  false
                );
              }
            }

            if (hollow) {
              hollow.Build();
              if (hollow.IsDone()) {
                const newSolid = hollow.Shape();
                currentSolid.delete();
                currentSolid = newSolid;
              }
              hollow.delete();
            }

            closingFaces.delete();

            if (op.featureId && currentSolid) {
              featureSolids.set(op.featureId, currentSolid);
            }
          }
        }
        } finally {
          // Clean up per-feature solid cache
          for (const [, s] of featureSolids) {
            if (s && s !== currentSolid && typeof s.delete === 'function') {
              try {
                if (!s.IsNull()) {
                  s.delete();
                }
              } catch (_) {}
            }
          }
          featureSolids.clear();
        }

        if (currentSolid) {
          const meshData = tessellateSolid(currentSolid, occ);
          _self.postMessage(
            {
              taskId: req.taskId,
              type: req.type,
              success: true,
              data: meshData,
            } as SolidTaskResponse,
            [meshData.vertices.buffer, meshData.normals.buffer, meshData.indices.buffer]
          );
        } else {
          const emptyMesh: MeshResult = {
            vertices: new Float32Array(0),
            normals: new Float32Array(0),
            indices: new Uint32Array(0),
          };
          _self.postMessage({
            taskId: req.taskId,
            type: req.type,
            success: true,
            data: emptyMesh,
          } as SolidTaskResponse);
        }
        break;
      }

      case 'EXTRUDE_PROFILES':
      case 'EXTRUDE_PROFILE': {
        if (!oc) throw new Error('Worker not initialized');
        const occ = oc;

        const profiles: SketchProfile[] =
          req.type === 'EXTRUDE_PROFILES' ? req.payload.profiles : [req.payload.profile];
        const depth = req.payload.depth;

        if (!profiles || profiles.length === 0) {
          throw new Error('No profiles provided for extrusion');
        }

        // Clean up previous solid if exists
        if (currentSolid) {
          currentSolid.delete();
          currentSolid = null;
        }

        // Create Compound container using BRep_Builder
        const builder = new occ.BRep_Builder();
        const compound = new occ.TopoDS_Compound();
        builder.MakeCompound(compound);

        for (const profile of profiles) {
          const face = createFaceFromProfile(profile, occ);
          const vec = new occ.gp_Vec_4(0, 0, depth);
          const prismMaker = new occ.BRepPrimAPI_MakePrism_1(face, vec, false, true);
          const prismSolid = prismMaker.Shape();

          builder.Add(compound, prismSolid);

          // Clean up intermediate per-profile C++ objects
          face.delete();
          vec.delete();
          prismSolid.delete();
          prismMaker.delete();
        }

        builder.delete();

        // Store the compound as the current solid for subsequent export (STEP / STL)
        currentSolid = compound;

        // Tessellate compound to get triangulated mesh
        const meshData = tessellateSolid(compound, occ);

        _self.postMessage(
          {
            taskId: req.taskId,
            type: req.type,
            success: true,
            data: meshData,
          } as SolidTaskResponse,
          [meshData.vertices.buffer, meshData.normals.buffer, meshData.indices.buffer]
        );
        break;
      }

      case 'EXPORT_STEP': {
        if (!oc || !currentSolid) throw new Error('No solid available to export');
        const occ = oc;

        const unit = req.payload?.unit || 'mm';
        occ.Interface_Static.SetCVal('write.step.unit', unit);

        const stepWriter = new occ.STEPControl_Writer_1();
        const transferResult = stepWriter.Transfer(
          currentSolid,
          occ.STEPControl_StepModelType.STEPControl_AsIs,
          true
        );
        if (transferResult !== occ.IFSelect_ReturnStatus.IFSelect_RetDone) {
          stepWriter.delete();
          throw new Error('STEP transfer failed');
        }

        const fileName = `export_${Date.now()}.step`;
        const writeResult = stepWriter.Write(fileName);
        if (writeResult !== occ.IFSelect_ReturnStatus.IFSelect_RetDone) {
          stepWriter.delete();
          throw new Error('STEP write failed');
        }

        let stepContent = '';
        try {
          stepContent = occ.FS.readFile(fileName, { encoding: 'utf8' });
          occ.FS.unlink(fileName);
        } catch (fsErr) {
          console.warn('FS error reading STEP:', fsErr);
          throw new Error('STEP file generation failed on FS layer');
        }
        stepWriter.delete();

        _self.postMessage({
          taskId: req.taskId,
          type: req.type,
          success: true,
          data: stepContent,
        } as SolidTaskResponse);
        break;
      }

      case 'EXPORT_STL': {
        if (!oc || !currentSolid) throw new Error('No solid available to export');
        const occ = oc;

        // Ensure the solid has a mesh before exporting to STL
        let mesher = null;
        try {
          mesher = new occ.BRepMesh_IncrementalMesh_2(currentSolid, 0.1, false, 0.5, false);
        } catch (err) {
          console.warn('Meshing failed before STL export:', err);
        }

        const stlWriter = new occ.StlAPI_Writer();
        stlWriter.ASCIIMode = false; // Binary
        const fileName = `export_${Date.now()}.stl`;
        
        let result = false;
        try {
          result = stlWriter.Write(currentSolid, fileName);
        } catch (err) {
          console.error('StlAPI_Writer Write exception:', err);
        }

        if (mesher) {
          mesher.delete();
        }

        if (!result) {
          stlWriter.delete();
          throw new Error('STL write failed');
        }

        let stlContent: Uint8Array | null = null;
        try {
          stlContent = occ.FS.readFile(fileName);
          occ.FS.unlink(fileName);
        } catch (fsErr) {
          console.warn('FS error reading STL:', fsErr);
          throw new Error('STL file generation failed on FS layer');
        }
        stlWriter.delete();

        if (stlContent) {
          _self.postMessage(
            {
              taskId: req.taskId,
              type: req.type,
              success: true,
              data: stlContent,
            } as SolidTaskResponse,
            [stlContent.buffer]
          );
        } else {
          throw new Error('STL content is empty');
        }
        break;
      }

      default:
        throw new Error(`Unknown task type: ${(req as any).type}`);
    }
  } catch (err: any) {
    _self.postMessage({
      taskId: req.taskId,
      type: req.type,
      success: false,
      error: err.message || 'Unknown error',
    } as SolidTaskResponse);
  }
};
