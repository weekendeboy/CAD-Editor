import {
  SolidTaskRequest,
  SolidTaskResponse,
  WorkerRequest,
  WorkerResponse,
  ExtrudeProfileResponseData,
  FeatureEvalOp,
  MeshResult,
  KernelDiagnostic,
  BodyResult,
  FeatureResult,
  KernelResult,
} from './SolidEngine.types';
import type { SketchProfile, ProfileSegment } from '../../types/cad';

let oc: any = null;
let currentSolid: any = null; // Store the current solid compound for evaluation and export
const featureSolidCache = new Map<string, any>(); // Feature-level solid cache for parametric regeneration

interface FeatureSnapshot {
  featureId: string;
  shape: any; // TopoDS_Shape 實體快照
  mesh: MeshResult; // 已離散化的網格快照
  featureResult: FeatureResult;
  topologyMap?: any;
}

const snapshotStore = new Map<string, FeatureSnapshot>();

// Set to track WASM pointers deleted in the current task session to prevent double-delete crashes
const deletedPointers = new Set<number>();

/**
 * Safe delete wrapper for OpenCASCADE WASM objects.
 * Uses pointer tracking to prevent double-deletion memory corruption.
 */
function safeDelete(obj: any): void {
  if (!obj) return;
  try {
    let ptr: number | null = null;
    if (obj.$$ && typeof obj.$$.ptr === 'number') {
      ptr = obj.$$.ptr;
    } else if (typeof obj.getPointer === 'function') {
      ptr = obj.getPointer();
    }
    if (ptr !== null && ptr !== undefined && ptr !== 0) {
      if (deletedPointers.has(ptr)) {
        return; // Already deleted in this session, skip
      }
      deletedPointers.add(ptr);
    }
    if (typeof obj.delete === 'function') {
      obj.delete();
    }
  } catch (_) {
    // Ignore C++ deletion exceptions
  }
}

const getBaseUrl = () => {
  // 生產環境 (Production)：Vite 會將 Worker 打包進 /assets/ 資料夾
  if (self.location.pathname.includes('/assets/')) {
    return self.location.origin + self.location.pathname.split('/assets/')[0] + '/';
  }
  // 開發環境 (Development)：直接返回 origin
  return self.location.origin + '/';
};

async function initWorker(wasmBuffer?: ArrayBuffer, occBaseUrl?: string) {
  if (!oc) {
    const baseUrl = occBaseUrl || getBaseUrl();
    const jsUrl = `${baseUrl}opencascade.wasm.js`;
    const wasmUrl = `${baseUrl}opencascade.wasm.wasm`;

    // 由於我們現在使用 classic worker (?worker)，可以直接使用 importScripts
    try {
      (self as any).importScripts(jsUrl);
    } catch (e) {
      console.warn('importScripts failed, falling back to fetch+eval.', e);
      const scriptRes = await fetch(jsUrl);
      if (!scriptRes.ok) {
        throw new Error(`Failed to fetch OCC JS: ${scriptRes.status}`);
      }
      const scriptText = await scriptRes.text();
      new Function(scriptText)();
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
    safeDelete(pt1);
    safeDelete(v1);
    vExp.Next();
  }

  if (vExp.More()) {
    const v2 = occ.TopoDS.Vertex_1(vExp.Current());
    const pt2 = occ.BRep_Tool.Pnt(v2);
    p2 = { x: pt2.X(), y: pt2.Y(), z: pt2.Z() };
    safeDelete(pt2);
    safeDelete(v2);
    vExp.Next();
  }

  safeDelete(vExp);

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
 * 從 2D 輪廓段（ProfileSegment）構建封閉的 TopoDS_Wire
 * 採用三點定弧法，若圓弧構建失敗絕不靜默降級為直線 Edge，而是拋出異常由上層診斷擷取。
 */
function buildWireFromSegments(segments: ProfileSegment[], occ: any): any {
  const wireMaker = new occ.BRepBuilderAPI_MakeWire_1();

  for (const seg of segments) {
    if (seg.type === 'line') {
      const p1 = new occ.gp_Pnt_3(seg.start.x, seg.start.y, 0);
      const p2 = new occ.gp_Pnt_3(seg.end.x, seg.end.y, 0);

      const mkEdge =
        typeof occ.BRepBuilderAPI_MakeEdge_3 === 'function'
          ? new occ.BRepBuilderAPI_MakeEdge_3(p1, p2)
          : new occ.BRepBuilderAPI_MakeEdge_1(p1, p2);

      if (!mkEdge.IsDone()) {
        safeDelete(mkEdge);
        safeDelete(p1);
        safeDelete(p2);
        safeDelete(wireMaker);
        throw new Error(`Line edge construction failed for segment (entity: ${(seg as any).id || 'unknown'})`);
      }

      wireMaker.Add_1(mkEdge.Edge());
      safeDelete(mkEdge);
      safeDelete(p1);
      safeDelete(p2);
    } else if (seg.type === 'arc' && seg.center && typeof seg.radius === 'number' && seg.radius > 0) {
      let sAng = seg.startAngle;
      let eAng = seg.endAngle;

      if (sAng === undefined || eAng === undefined) {
        sAng = Math.atan2(seg.start.y - seg.center.y, seg.start.x - seg.center.x);
        eAng = Math.atan2(seg.end.y - seg.center.y, seg.end.x - seg.center.x);
      }

      let sweep = eAng - sAng;
      const isCW = seg.sweepFlag === 1;

      if (isCW) {
        while (sweep >= 0) sweep -= 2 * Math.PI;
        while (sweep < -2 * Math.PI) sweep += 2 * Math.PI;
      } else {
        while (sweep <= 0) sweep += 2 * Math.PI;
        while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
      }

      const midAng = sAng + sweep / 2;
      const midX = seg.center.x + seg.radius * Math.cos(midAng);
      const midY = seg.center.y + seg.radius * Math.sin(midAng);

      const pStart = new occ.gp_Pnt_3(seg.start.x, seg.start.y, 0);
      const pMid = new occ.gp_Pnt_3(midX, midY, 0);
      const pEnd = new occ.gp_Pnt_3(seg.end.x, seg.end.y, 0);

      let edgeAdded = false;

      if (typeof occ.GC_MakeArcOfCircle_4 === 'function') {
        try {
          const arcMaker = new occ.GC_MakeArcOfCircle_4(pStart, pMid, pEnd);
          if (arcMaker.IsDone()) {
            const trimmedCurve = arcMaker.Value();
            let geomCurve: any = null;
            if (typeof occ.Handle_Geom_Curve_2 === 'function') {
              geomCurve = new occ.Handle_Geom_Curve_2(trimmedCurve.get());
            }
            const curveHandle = geomCurve || trimmedCurve;

            if (typeof occ.BRepBuilderAPI_MakeEdge_24 === 'function') {
              const edgeMaker = new occ.BRepBuilderAPI_MakeEdge_24(curveHandle);
              if (edgeMaker.IsDone()) {
                wireMaker.Add_1(edgeMaker.Edge());
                edgeAdded = true;
              }
              safeDelete(edgeMaker);
            }

            if (geomCurve) safeDelete(geomCurve);
            safeDelete(trimmedCurve);
          }
          safeDelete(arcMaker);
        } catch (arcErr: any) {
          console.warn('SolidWorker: 3-point arc construction exception:', arcErr);
        }
      }

      safeDelete(pStart);
      safeDelete(pMid);
      safeDelete(pEnd);

      if (!edgeAdded) {
        safeDelete(wireMaker);
        throw new Error(`Arc construction failed for segment (entity: ${(seg as any).id || 'unknown'}). Geometric degeneration detected.`);
      }
    } else {
      const p1 = new occ.gp_Pnt_3(seg.start.x, seg.start.y, 0);
      const p2 = new occ.gp_Pnt_3(seg.end.x, seg.end.y, 0);
      const mkEdge =
        typeof occ.BRepBuilderAPI_MakeEdge_3 === 'function'
          ? new occ.BRepBuilderAPI_MakeEdge_3(p1, p2)
          : new occ.BRepBuilderAPI_MakeEdge_1(p1, p2);
      if (!mkEdge.IsDone()) {
        safeDelete(mkEdge);
        safeDelete(p1);
        safeDelete(p2);
        safeDelete(wireMaker);
        throw new Error(`Edge construction failed for segment (entity: ${(seg as any).id || 'unknown'})`);
      }
      wireMaker.Add_1(mkEdge.Edge());
      safeDelete(mkEdge);
      safeDelete(p1);
      safeDelete(p2);
    }
  }

  if (!wireMaker.IsDone()) {
    safeDelete(wireMaker);
    throw new Error('Invalid Wire: wire construction failed or discontinuous edges.');
  }

  const wire = wireMaker.Wire();
  safeDelete(wireMaker);
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
    const mkEdge =
      typeof occ.BRepBuilderAPI_MakeEdge_3 === 'function'
        ? new occ.BRepBuilderAPI_MakeEdge_3(p1, p2)
        : new occ.BRepBuilderAPI_MakeEdge_1(p1, p2);
    if (!mkEdge.IsDone()) {
      safeDelete(mkEdge);
      safeDelete(p1);
      safeDelete(p2);
      safeDelete(wireMaker);
      throw new Error(`Edge construction failed between points ${i} and ${(i + 1) % len}`);
    }
    wireMaker.Add_1(mkEdge.Edge());
    safeDelete(mkEdge);
    safeDelete(p1);
    safeDelete(p2);
  }

  if (!wireMaker.IsDone()) {
    safeDelete(wireMaker);
    throw new Error('Invalid Wire: wire construction from points failed.');
  }

  const wire = wireMaker.Wire();
  safeDelete(wireMaker);
  return wire;
}

function createFaceFromProfile(profile: SketchProfile, occ: any): any {
  let outerWire: any;
  if (profile.segments && profile.segments.length > 0) {
    outerWire = buildWireFromSegments(profile.segments, occ);
  } else if (profile.outerLoop && profile.outerLoop.length > 1) {
    outerWire = buildWireFromPoints(profile.outerLoop, occ);
  } else {
    throw new Error(`Profile ${profile.id || ''} has no valid segments or outer loop`);
  }

  const faceMaker = new occ.BRepBuilderAPI_MakeFace_15(outerWire, true);

  if (profile.innerSegments && profile.innerSegments.length > 0) {
    for (const innerSegs of profile.innerSegments) {
      if (innerSegs.length > 0) {
        const innerWire = buildWireFromSegments(innerSegs, occ);
        faceMaker.Add(innerWire);
        safeDelete(innerWire);
      }
    }
  } else if (profile.innerLoops && profile.innerLoops.length > 0) {
    for (const innerLoop of profile.innerLoops) {
      if (innerLoop.length > 1) {
        const innerWire = buildWireFromPoints(innerLoop, occ);
        faceMaker.Add(innerWire);
        safeDelete(innerWire);
      }
    }
  }

  if (!faceMaker.IsDone()) {
    safeDelete(outerWire);
    safeDelete(faceMaker);
    throw new Error(`Invalid Face: face construction from profile ${profile.id || ''} failed.`);
  }

  const face = faceMaker.Face();
  safeDelete(outerWire);
  safeDelete(faceMaker);
  return face;
}

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
  safeDelete(transformedShape);

  safeDelete(fromOrig);
  safeDelete(fromNorm);
  safeDelete(fromXDir);
  safeDelete(fromAx);
  safeDelete(toOrig);
  safeDelete(toNorm);
  safeDelete(toXDir);
  safeDelete(toAx);
  safeDelete(alignTrsf);
  safeDelete(alignXform);

  return transformedWire;
}

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
    z: normal.x * xAxis.y - normal.y * xAxis.x,
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
  safeDelete(transformedShape);

  safeDelete(fromOrig);
  safeDelete(fromNorm);
  safeDelete(fromXDir);
  safeDelete(fromAx);
  safeDelete(toOrig);
  safeDelete(toNorm);
  safeDelete(toXDir);
  safeDelete(toAx);
  safeDelete(alignTrsf);
  safeDelete(alignXform);

  return transformedFace;
}

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
      const mkEdge =
        typeof occ.BRepBuilderAPI_MakeEdge_3 === 'function'
          ? new occ.BRepBuilderAPI_MakeEdge_3(p1, p2)
          : new occ.BRepBuilderAPI_MakeEdge_1(p1, p2);
      if (!mkEdge.IsDone()) {
        safeDelete(mkEdge);
        safeDelete(p1);
        safeDelete(p2);
        safeDelete(wireMaker);
        throw new Error('Path line edge construction failed');
      }
      wireMaker.Add_1(mkEdge.Edge());
      safeDelete(mkEdge);
    } else if (seg.type === 'arc' && seg.center) {
      let midX: number;
      let midY: number;
      let midZ: number;

      if ((seg as any).mid) {
        midX = (seg as any).mid.x;
        midY = (seg as any).mid.y;
        midZ = (seg as any).mid.z;
      } else {
        const v1x = seg.start.x - seg.center.x;
        const v1y = seg.start.y - seg.center.y;
        const v1z = seg.start.z - seg.center.z;
        const v2x = seg.end.x - seg.center.x;
        const v2y = seg.end.y - seg.center.y;
        const v2z = seg.end.z - seg.center.z;

        const r = seg.radius || Math.hypot(v1x, v1y, v1z);

        let midVx = v1x + v2x;
        let midVy = v1y + v2y;
        let midVz = v1z + v2z;
        const midVLen = Math.hypot(midVx, midVy, midVz);

        if (midVLen > 1e-6) {
          midX = seg.center.x + (midVx / midVLen) * r;
          midY = seg.center.y + (midVy / midVLen) * r;
          midZ = seg.center.z + (midVz / midVLen) * r;
        } else {
          midX = (seg.start.x + seg.end.x) / 2;
          midY = (seg.start.y + seg.end.y) / 2;
          midZ = (seg.start.z + seg.end.z) / 2;
        }
      }

      const pMid = new occ.gp_Pnt_3(midX, midY, midZ);
      let arcAdded = false;

      if (typeof occ.GC_MakeArcOfCircle_4 === 'function') {
        try {
          const arcMaker = new occ.GC_MakeArcOfCircle_4(p1, pMid, p2);
          if (arcMaker.IsDone()) {
            const trimmed = arcMaker.Value();
            let geomCurve: any = null;
            if (typeof occ.Handle_Geom_Curve_2 === 'function') {
              geomCurve = new occ.Handle_Geom_Curve_2(trimmed.get());
            }
            const curveHandle = geomCurve || trimmed;
            if (typeof occ.BRepBuilderAPI_MakeEdge_24 === 'function') {
              const edgeMaker = new occ.BRepBuilderAPI_MakeEdge_24(curveHandle);
              if (edgeMaker.IsDone()) {
                wireMaker.Add_1(edgeMaker.Edge());
                arcAdded = true;
              }
              safeDelete(edgeMaker);
            }
            if (geomCurve) safeDelete(geomCurve);
            safeDelete(trimmed);
          }
          safeDelete(arcMaker);
        } catch (arcErr) {
          console.warn('SolidWorker: 3D path arc failed:', arcErr);
        }
      }

      safeDelete(pMid);

      if (!arcAdded) {
        safeDelete(p1);
        safeDelete(p2);
        safeDelete(wireMaker);
        throw new Error('Path 3D arc construction failed for sweep path. Geometric degeneration detected.');
      }
    }
    safeDelete(p1);
    safeDelete(p2);
  }

  if (!wireMaker.IsDone()) {
    safeDelete(wireMaker);
    throw new Error('Invalid Path Wire: path construction failed or discontinuous edges.');
  }

  const wire = wireMaker.Wire();
  safeDelete(wireMaker);
  return wire;
}

function createFeatureSolid(op: FeatureEvalOp, occ: any): any {
  if (!op.profiles || op.profiles.length === 0) {
    throw new Error(`Feature ${op.featureId || op.type} has no profiles to evaluate`);
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
      const transformedFace = transformFaceTo3D(localFace, { origin, normal, xAxis, yAxis }, occ);
      safeDelete(localFace);

      const axisOrigin = op.axis?.origin || { x: 0, y: 0, z: 0 };
      const axisDirVec = op.axis?.direction || { x: 0, y: 1, z: 0 };

      let angle = typeof op.angle === 'number' && !isNaN(op.angle) ? op.angle : 2 * Math.PI;
      if (Math.abs(angle) > 2 * Math.PI + 1e-4) {
        angle = (angle * Math.PI) / 180;
      }

      const axPnt = new occ.gp_Pnt_3(axisOrigin.x, axisOrigin.y, axisOrigin.z);
      const axDir = new occ.gp_Dir_4(axisDirVec.x, axisDirVec.y, axisDirVec.z);
      const axis = new occ.gp_Ax1_2(axPnt, axDir);

      const isFullCircle = Math.abs(Math.abs(angle) - 2 * Math.PI) < 1e-4;

      let revolSolid = null;
      try {
        if (isFullCircle && typeof occ.BRepPrimAPI_MakeRevol_2 === 'function') {
          const revolMaker = new occ.BRepPrimAPI_MakeRevol_2(transformedFace, axis, false);
          revolSolid = revolMaker.Shape();
          safeDelete(revolMaker);
        } else {
          const revolMaker = new occ.BRepPrimAPI_MakeRevol_1(transformedFace, axis, angle, false);
          revolSolid = revolMaker.Shape();
          safeDelete(revolMaker);
        }
      } catch (err: any) {
        console.error('SolidWorker: Failed to create Revolve feature:', err);
        safeDelete(transformedFace);
        safeDelete(axPnt);
        safeDelete(axDir);
        safeDelete(axis);
        throw new Error(`Revolve creation failed: ${err.message || 'Unknown error'}`);
      }

      safeDelete(transformedFace);
      safeDelete(axPnt);
      safeDelete(axDir);
      safeDelete(axis);

      if (revolSolid && !revolSolid.IsNull()) {
        featureSolids.push(revolSolid);
      }
    } else {
      const depth = typeof op.depth === 'number' && !isNaN(op.depth) ? op.depth : 10;

      const vec = new occ.gp_Vec_4(0, 0, depth);
      let localSolid = null;
      try {
        const prismMaker = new occ.BRepPrimAPI_MakePrism_1(localFace, vec, false, true);
        localSolid = prismMaker.Shape();
        safeDelete(prismMaker);
      } catch (err: any) {
        console.error('SolidWorker: Failed to create Extrude feature:', err);
        safeDelete(localFace);
        safeDelete(vec);
        throw new Error(`Extrude prism creation failed: ${err.message || 'Unknown error'}`);
      }

      safeDelete(localFace);
      safeDelete(vec);

      if (!localSolid || localSolid.IsNull()) {
        continue;
      }

      if (op.direction === 'mid-plane') {
        const trsfMid = new occ.gp_Trsf_1();
        const vecMid = new occ.gp_Vec_4(0, 0, -depth / 2);
        trsfMid.SetTranslation_1(vecMid);
        const xformMid = new occ.BRepBuilderAPI_Transform_2(localSolid, trsfMid, true);
        const shiftedSolid = xformMid.Shape();

        safeDelete(localSolid);
        safeDelete(trsfMid);
        safeDelete(vecMid);
        safeDelete(xformMid);

        localSolid = shiftedSolid;
      } else if (op.direction === 'reversed') {
        const trsfRev = new occ.gp_Trsf_1();
        const vecRev = new occ.gp_Vec_4(0, 0, -depth);
        trsfRev.SetTranslation_1(vecRev);
        const xformRev = new occ.BRepBuilderAPI_Transform_2(localSolid, trsfRev, true);
        const shiftedSolid = xformRev.Shape();

        safeDelete(localSolid);
        safeDelete(trsfRev);
        safeDelete(vecRev);
        safeDelete(xformRev);

        localSolid = shiftedSolid;
      }

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
        z: normal.x * xAxis.y - normal.y * xAxis.x,
      };
      const dot = calcY.x * yAxis.x + calcY.y * yAxis.y + calcY.z * yAxis.z;
      if (dot < 0) {
        toAx.YReverse();
      }

      const alignTrsf = new occ.gp_Trsf_1();
      alignTrsf.SetDisplacement(fromAx, toAx);

      const alignXform = new occ.BRepBuilderAPI_Transform_2(localSolid, alignTrsf, true);
      const transformedSolid = alignXform.Shape();

      safeDelete(localSolid);
      safeDelete(fromOrig);
      safeDelete(fromNorm);
      safeDelete(fromXDir);
      safeDelete(fromAx);
      safeDelete(toOrig);
      safeDelete(toNorm);
      safeDelete(toXDir);
      safeDelete(toAx);
      safeDelete(alignTrsf);
      safeDelete(alignXform);

      featureSolids.push(transformedSolid);
    }
  }

  if (featureSolids.length === 0) {
    throw new Error(`Feature ${op.featureId || op.type} produced no valid 3D geometry`);
  }

  if (featureSolids.length === 1) {
    return featureSolids[0];
  }

  const builder = new occ.BRep_Builder();
  const compound = new occ.TopoDS_Compound();
  builder.MakeCompound(compound);

  for (const fs of featureSolids) {
    builder.Add(compound, fs);
    safeDelete(fs);
  }

  safeDelete(builder);
  return compound;
}

function tessellateSolid(solid: any, occ: any): ExtrudeProfileResponseData {
  if (!solid || solid.IsNull()) {
    return {
      success: false,
      vertices: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
    };
  }

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
        safeDelete(pnt);
        safeDelete(origPnt);

        if (normalArray) {
          const n = normalArray.Value(i);
          normals.push(n.X(), n.Y(), n.Z());
          safeDelete(n);
        } else {
          normals.push(0, 0, 1);
        }
      }

      safeDelete(trsf);

      const triangleArray = tri.Triangles();
      const faceOrientation = (face as any).Orientation_1
        ? (face as any).Orientation_1()
        : (face as any).Orientation();
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
        safeDelete(triangle);
      }

      indexOffset += numNodes;

      safeDelete(nodeArray);
      safeDelete(triangleArray);
      if (normalArray) safeDelete(normalArray);
      safeDelete(triangulation);
    } else {
      safeDelete(triangulation);
    }

    safeDelete(face);
    safeDelete(loc);
    explorer.Next();
  }

  safeDelete(explorer);

  const edges: number[] = [];
  const edgeExplorer = new occ.TopExp_Explorer_2(
    solid,
    occ.TopAbs_ShapeEnum.TopAbs_EDGE,
    occ.TopAbs_ShapeEnum.TopAbs_SHAPE
  );

  const edgeSet = new Set<number>();

  while (edgeExplorer.More()) {
    const edge = occ.TopoDS.Edge_1(edgeExplorer.Current());
    const hashCode =
      typeof edge.HashCode === 'function'
        ? edge.HashCode(0x7fffffff)
        : typeof edge.HashCode_1 === 'function'
        ? edge.HashCode_1(0x7fffffff)
        : Math.random();

    if (!edgeSet.has(hashCode)) {
      edgeSet.add(hashCode);
      const loc = new occ.TopLoc_Location_1();
      let extracted = false;

      if (typeof occ.BRep_Tool.Polygon3D === 'function') {
        const poly = occ.BRep_Tool.Polygon3D(edge, loc);
        if (poly && !poly.IsNull()) {
          const polyObj = poly.get();
          const nodes = polyObj.Nodes();
          const nbNodes = polyObj.NbNodes();
          const trsf = loc.Transformation();

          for (let i = 1; i < nbNodes; i++) {
            const p1 = nodes.Value(i).Transformed(trsf);
            const p2 = nodes.Value(i + 1).Transformed(trsf);
            edges.push(p1.X(), p1.Y(), p1.Z(), p2.X(), p2.Y(), p2.Z());
            safeDelete(p1);
            safeDelete(p2);
          }
          safeDelete(trsf);
          safeDelete(nodes);
          safeDelete(poly);
          extracted = true;
        } else if (poly) {
          safeDelete(poly);
        }
      }

      if (!extracted) {
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
          safeDelete(pt1);
          safeDelete(v1);
          vExp.Next();
        }
        if (vExp.More()) {
          const v2 = occ.TopoDS.Vertex_1(vExp.Current());
          const pt2 = occ.BRep_Tool.Pnt(v2);
          p2 = { x: pt2.X(), y: pt2.Y(), z: pt2.Z() };
          safeDelete(pt2);
          safeDelete(v2);
          vExp.Next();
        }
        safeDelete(vExp);

        if (p1 && p2) {
          edges.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
        }
      }

      safeDelete(loc);
    }
    safeDelete(edge);
    edgeExplorer.Next();
  }

  safeDelete(edgeExplorer);
  safeDelete(mesher);

  const vArray = new Float32Array(vertices);
  const nArray = new Float32Array(normals);
  const iArray = indexOffset > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  const eArray = new Float32Array(edges);

  return {
    success: true,
    vertices: vArray,
    normals: nArray,
    indices: iArray,
    edgeVertices: eArray,
    edges: eArray,
  };
}

const _self = self as any;

_self.onmessage = async (e: MessageEvent<SolidTaskRequest | WorkerRequest>) => {
  const req = e.data;
  deletedPointers.clear(); // Task-level reset of safe deletion tracker

  try {
    switch (req.type) {
      case 'INIT': {
        await initWorker(req.payload?.wasmBuffer, req.payload?.occBaseUrl);
        _self.postMessage({ taskId: req.taskId, type: req.type, success: true } as SolidTaskResponse);
        break;
      }

      case 'EVALUATE_FEATURE_TREE': {
        if (!oc) throw new Error('Worker not initialized');
        const occ = oc;

        const operations: FeatureEvalOp[] = req.payload?.operations || [];
        const dirtyFromIndex: number = typeof req.payload?.dirtyFromIndex === 'number' ? req.payload.dirtyFromIndex : -1;
        const isPureRollback: boolean = !!req.payload?.isPureRollback || dirtyFromIndex === -1;

        // 1. 純回退或完全命中快取檢查 (Pure Rollback / Full Cache Hit)
        if (isPureRollback && operations.length > 0) {
          const lastOp = operations[operations.length - 1];
          if (lastOp && lastOp.featureId && snapshotStore.has(lastOp.featureId)) {
            const cachedSnap = snapshotStore.get(lastOp.featureId)!;
            if (cachedSnap.shape && !cachedSnap.shape.IsNull()) {
              if (currentSolid && currentSolid !== cachedSnap.shape) {
                safeDelete(currentSolid);
              }
              // Clone shape reference for currentSolid
              const copyMaker = new occ.BRepBuilderAPI_Copy_2(cachedSnap.shape, true, false);
              currentSolid = copyMaker.Shape();
              safeDelete(copyMaker);

              const featureResults: Record<string, FeatureResult> = {};
              const allDiagnostics: KernelDiagnostic[] = [];
              for (const op of operations) {
                if (op.featureId && snapshotStore.has(op.featureId)) {
                  const snap = snapshotStore.get(op.featureId)!;
                  featureResults[op.featureId] = snap.featureResult;
                  if (snap.mesh.diagnostics) {
                    allDiagnostics.push(...snap.mesh.diagnostics);
                  }
                }
              }

              let boundingBox: BodyResult['boundingBox'] = undefined;
              try {
                const bbox = new occ.Bnd_Box_1();
                occ.BRepBndLib.Add(currentSolid, bbox);
                const minPnt = bbox.CornerMin();
                const maxPnt = bbox.CornerMax();
                boundingBox = {
                  min: { x: minPnt.X(), y: minPnt.Y(), z: minPnt.Z() },
                  max: { x: maxPnt.X(), y: maxPnt.Y(), z: maxPnt.Z() },
                };
                safeDelete(minPnt);
                safeDelete(maxPnt);
                safeDelete(bbox);
              } catch (bbErr) {
                console.warn('SolidWorker: Failed to calculate bounding box during pure rollback:', bbErr);
              }

              const bodies: BodyResult[] = [
                {
                  bodyId: 'main-body',
                  name: 'Solid Body 1',
                  isSolid: true,
                  boundingBox,
                },
              ];

              const kernelResult: KernelResult = {
                taskId: req.taskId,
                success: true,
                finalMesh: cachedSnap.mesh,
                featureResults,
                bodies,
                diagnostics: allDiagnostics,
              };

              const transferBuffers: Transferable[] = [];
              if (cachedSnap.mesh && cachedSnap.mesh.vertices) {
                transferBuffers.push(cachedSnap.mesh.vertices.buffer);
                transferBuffers.push(cachedSnap.mesh.normals.buffer);
                transferBuffers.push(cachedSnap.mesh.indices.buffer);
                if (cachedSnap.mesh.edgeVertices && cachedSnap.mesh.edgeVertices.buffer) {
                  transferBuffers.push(cachedSnap.mesh.edgeVertices.buffer);
                }
              }

              _self.postMessage(
                {
                  taskId: req.taskId,
                  type: req.type,
                  success: true,
                  data: kernelResult,
                } as SolidTaskResponse,
                transferBuffers
              );
              break;
            }
          }
        }

        // 2. 增量重算評估 (Incremental Evaluation)
        let evalStartIndex = 0;
        if (dirtyFromIndex > 0 && dirtyFromIndex < operations.length) {
          const prevOp = operations[dirtyFromIndex - 1];
          if (prevOp && prevOp.featureId && snapshotStore.has(prevOp.featureId)) {
            const prevSnap = snapshotStore.get(prevOp.featureId)!;
            if (prevSnap.shape && !prevSnap.shape.IsNull()) {
              if (currentSolid) {
                safeDelete(currentSolid);
                currentSolid = null;
              }
              const copyMaker = new occ.BRepBuilderAPI_Copy_2(prevSnap.shape, true, false);
              currentSolid = copyMaker.Shape();
              safeDelete(copyMaker);
              evalStartIndex = dirtyFromIndex;
            }
          }
        }

        if (evalStartIndex === 0) {
          if (currentSolid) {
            safeDelete(currentSolid);
            currentSolid = null;
          }
          snapshotStore.clear();
          featureSolidCache.clear();
        } else {
          // 清理從 dirtyFromIndex 開始及其之後的快照
          const keysToDelete: string[] = [];
          for (let k = evalStartIndex; k < operations.length; k++) {
            const opId = operations[k].featureId;
            if (opId) {
              keysToDelete.push(opId);
              if (snapshotStore.has(opId)) {
                const snap = snapshotStore.get(opId)!;
                safeDelete(snap.shape);
                snapshotStore.delete(opId);
              }
              if (featureSolidCache.has(opId)) {
                featureSolidCache.delete(opId);
              }
            }
          }
        }

        const allDiagnostics: KernelDiagnostic[] = [];
        const featureResults: Record<string, FeatureResult> = {};

        // 恢復已計算且位於 evalStartIndex 之前的快照與特徵結果
        for (let i = 0; i < evalStartIndex; i++) {
          const op = operations[i];
          if (op.featureId && snapshotStore.has(op.featureId)) {
            const snap = snapshotStore.get(op.featureId)!;
            featureResults[op.featureId] = snap.featureResult;
            if (snap.mesh.diagnostics) {
              allDiagnostics.push(...snap.mesh.diagnostics);
            }
            if (snap.shape && !snap.shape.IsNull()) {
              featureSolidCache.set(op.featureId, snap.shape);
            }
          }
        }

        let hasAnySuccess = evalStartIndex > 0;

        for (let i = evalStartIndex; i < operations.length; i++) {
          const op = operations[i];
          const tStart = performance.now();
          const featureDiag: KernelDiagnostic[] = [];
          let success = false;
          let errorMessage: string | null = null;

          try {
            if (
              op.type === 'EXTRUDE' ||
              op.type === 'CUT_EXTRUDE' ||
              op.type === 'REVOLVE' ||
              op.type === 'REVOLVE_CUT'
            ) {
              const featureSolid = createFeatureSolid(op, occ);
              if (!featureSolid || featureSolid.IsNull()) {
                throw new Error(`Feature ${op.featureId || op.type} returned an empty solid`);
              }

              if (op.featureId) {
                featureSolidCache.set(op.featureId, featureSolid);
              }

              const isCut =
                op.operation === 'CUT' || op.type === 'CUT_EXTRUDE' || op.type === 'REVOLVE_CUT';

              if (currentSolid === null) {
                if (!isCut && (op.operation === 'JOIN' || op.type === 'EXTRUDE' || op.type === 'REVOLVE')) {
                  currentSolid = featureSolid;
                } else if (isCut) {
                  featureDiag.push({
                    level: 'warning',
                    message: `Cut operation '${op.featureId || op.type}' ignored because no base solid exists.`,
                    featureId: op.featureId,
                  });
                }
              } else {
                if (!isCut) {
                  const fuse = new occ.BRepAlgoAPI_Fuse_3(currentSolid, featureSolid);
                  fuse.Build();
                  if (fuse.IsDone()) {
                    const newSolid = fuse.Shape();
                    if (currentSolid !== featureSolid) {
                      safeDelete(currentSolid);
                    }
                    currentSolid = newSolid;
                  } else {
                    safeDelete(fuse);
                    throw new Error(`Boolean Fuse failed for feature ${op.featureId || op.type}`);
                  }
                  safeDelete(fuse);
                } else {
                  const cut = new occ.BRepAlgoAPI_Cut_3(currentSolid, featureSolid);
                  cut.Build();
                  if (cut.IsDone()) {
                    const newSolid = cut.Shape();
                    if (currentSolid !== featureSolid) {
                      safeDelete(currentSolid);
                    }
                    currentSolid = newSolid;
                  } else {
                    safeDelete(cut);
                    throw new Error(`Boolean Cut failed for feature ${op.featureId || op.type}`);
                  }
                  safeDelete(cut);
                }
              }
              success = true;
            } else if (op.type === 'SWEEP') {
              if (!op.sweepData || !op.sweepData.pathSegments || op.sweepData.pathSegments.length === 0) {
                throw new Error(`Sweep feature ${op.featureId || ''} missing path segments`);
              }
              if (!op.profiles || op.profiles.length === 0) {
                throw new Error(`Sweep feature ${op.featureId || ''} missing profiles`);
              }

              const pathWire = buildPathWire(op.sweepData.pathSegments, occ);
              const sweepSolids: any[] = [];

              for (const profile of op.profiles) {
                const localFace = createFaceFromProfile(profile, occ);
                const spatialFace = transformFaceTo3D(localFace, op.plane || {}, occ);
                safeDelete(localFace);

                const pipeMaker =
                  typeof occ.BRepOffsetAPI_MakePipe_1 === 'function'
                    ? new occ.BRepOffsetAPI_MakePipe_1(pathWire, spatialFace)
                    : new occ.BRepOffsetAPI_MakePipe(pathWire, spatialFace);

                pipeMaker.Build();
                if (pipeMaker.IsDone()) {
                  const pipeSolid = pipeMaker.Shape();
                  sweepSolids.push(pipeSolid);
                } else {
                  safeDelete(spatialFace);
                  safeDelete(pipeMaker);
                  safeDelete(pathWire);
                  throw new Error(`Pipe sweep failed for profile ${profile.id || ''}`);
                }

                safeDelete(spatialFace);
                safeDelete(pipeMaker);
              }

              safeDelete(pathWire);

              if (sweepSolids.length === 0) {
                throw new Error(`Sweep feature ${op.featureId || ''} produced no valid solids`);
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
                  safeDelete(s);
                }
                safeDelete(builder);
                featureSolid = compound;
              }

              if (featureSolid && !featureSolid.IsNull()) {
                if (op.featureId) {
                  featureSolidCache.set(op.featureId, featureSolid);
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
                        safeDelete(currentSolid);
                      }
                      currentSolid = newSolid;
                    }
                    safeDelete(fuse);
                  } else {
                    const cut = new occ.BRepAlgoAPI_Cut_3(currentSolid, featureSolid);
                    cut.Build();
                    if (cut.IsDone()) {
                      const newSolid = cut.Shape();
                      if (currentSolid !== featureSolid) {
                        safeDelete(currentSolid);
                      }
                      currentSolid = newSolid;
                    }
                    safeDelete(cut);
                  }
                }
              }
              success = true;
            } else if (op.type === 'LOFT') {
              if (!op.loftData || !op.loftData.sections || op.loftData.sections.length < 2) {
                throw new Error(`Loft feature ${op.featureId || ''} requires at least 2 sections`);
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
                  safeDelete(localWire);

                  thruSections.AddWire(spatialWire);
                  intermediateWires.push(spatialWire);
                }
              }

              thruSections.Build();

              let featureSolid: any = null;
              if (thruSections.IsDone()) {
                featureSolid = thruSections.Shape();
              } else {
                for (const w of intermediateWires) safeDelete(w);
                safeDelete(thruSections);
                throw new Error(`Loft section connection failed for ${op.featureId || ''}`);
              }

              for (const w of intermediateWires) {
                safeDelete(w);
              }
              safeDelete(thruSections);

              if (featureSolid && !featureSolid.IsNull()) {
                if (op.featureId) {
                  featureSolidCache.set(op.featureId, featureSolid);
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
                        safeDelete(currentSolid);
                      }
                      currentSolid = newSolid;
                    }
                    safeDelete(fuse);
                  } else {
                    const cut = new occ.BRepAlgoAPI_Cut_3(currentSolid, featureSolid);
                    cut.Build();
                    if (cut.IsDone()) {
                      const newSolid = cut.Shape();
                      if (currentSolid !== featureSolid) {
                        safeDelete(currentSolid);
                      }
                      currentSolid = newSolid;
                    }
                    safeDelete(cut);
                  }
                }
              }
              success = true;
            } else if (
              op.type === 'LINEAR_PATTERN' ||
              op.type === 'CIRCULAR_PATTERN' ||
              op.type === 'MIRROR_3D'
            ) {
              let sourceSolid: any = null;
              let shouldDeleteSourceSolid = false;
              if (op.targetFeatureIds && op.targetFeatureIds.length > 0) {
                const sources: any[] = [];
                for (const tid of op.targetFeatureIds) {
                  if (featureSolidCache.has(tid)) {
                    sources.push(featureSolidCache.get(tid));
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
                  safeDelete(builder);
                  sourceSolid = compound;
                  shouldDeleteSourceSolid = true;
                }
              }
              if (!sourceSolid || sourceSolid.IsNull()) {
                sourceSolid = currentSolid;
                shouldDeleteSourceSolid = false;
              }

              if (!sourceSolid || sourceSolid.IsNull()) {
                throw new Error(`Pattern/Mirror feature '${op.featureId || op.type}' has no valid target solid.`);
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

                  for (let pIdx = 0; pIdx < count1; pIdx++) {
                    for (let qIdx = 0; qIdx < count2; qIdx++) {
                      if (pIdx === 0 && qIdx === 0) continue;

                      const dx = pIdx * spacing1 * dir1.x + qIdx * spacing2 * (dir2?.x || 0);
                      const dy = pIdx * spacing1 * dir1.y + qIdx * spacing2 * (dir2?.y || 0);
                      const dz = pIdx * spacing1 * dir1.z + qIdx * spacing2 * (dir2?.z || 0);

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
                          safeDelete(currentSolid);
                          currentSolid = newSolid;
                        }
                        safeDelete(fuse);
                        safeDelete(transformedCopy);
                      }

                      safeDelete(xform);
                      safeDelete(trsf);
                      safeDelete(vec);
                    }
                  }
                }
              } else if (op.type === 'CIRCULAR_PATTERN') {
                const pat = op.patternCircular;
                if (pat) {
                  const axisOrigin = pat.axis?.origin || { x: 0, y: 0, z: 0 };
                  const axisDirVec = pat.axis?.direction || { x: 0, y: 0, z: 1 };
                  const count = typeof pat.count === 'number' && pat.count > 0 ? pat.count : 1;
                  let totalAngle =
                    typeof pat.totalAngle === 'number' && !isNaN(pat.totalAngle)
                      ? pat.totalAngle
                      : 2 * Math.PI;

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
                        safeDelete(currentSolid);
                        currentSolid = newSolid;
                      }
                      safeDelete(fuse);
                      safeDelete(transformedCopy);
                    }

                    safeDelete(xform);
                    safeDelete(trsf);
                  }

                  safeDelete(rotAxis);
                  safeDelete(axDir);
                  safeDelete(axPnt);
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
                      safeDelete(currentSolid);
                      currentSolid = newSolid;
                    }
                    safeDelete(fuse);
                    safeDelete(mirroredCopy);
                  }

                  safeDelete(xform);
                  safeDelete(trsf);
                  safeDelete(ax2);
                  safeDelete(dir);
                  safeDelete(pnt);
                }
              }

              if (shouldDeleteSourceSolid && sourceSolid) {
                safeDelete(sourceSolid);
              }

              if (op.featureId && currentSolid) {
                featureSolidCache.set(op.featureId, currentSolid);
              }
              success = true;
            } else if (op.type === 'FILLET_3D') {
              if (!currentSolid || currentSolid.IsNull()) {
                throw new Error(`Fillet 3D requires an existing base solid`);
              }

              const radius =
                typeof op.fillet3D?.radius === 'number' && !isNaN(op.fillet3D.radius)
                  ? op.fillet3D.radius
                  : 1.0;
              const mode = op.fillet3D?.edgeSelectionMode || 'all';

              const fillet =
                typeof occ.BRepFilletAPI_MakeFillet_1 === 'function'
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

                safeDelete(edge);
                exp.Next();
              }
              safeDelete(exp);

              if (addedCount > 0) {
                fillet.Build();
                if (fillet.IsDone()) {
                  const newSolid = fillet.Shape();
                  safeDelete(currentSolid);
                  currentSolid = newSolid;
                } else {
                  safeDelete(fillet);
                  throw new Error(`Fillet operation failed to build`);
                }
              }

              safeDelete(fillet);

              if (op.featureId && currentSolid) {
                featureSolidCache.set(op.featureId, currentSolid);
              }
              success = true;
            } else if (op.type === 'CHAMFER_3D') {
              if (!currentSolid || currentSolid.IsNull()) {
                throw new Error(`Chamfer 3D requires an existing base solid`);
              }

              const distance =
                typeof op.chamfer3D?.distance === 'number' && !isNaN(op.chamfer3D.distance)
                  ? op.chamfer3D.distance
                  : 1.0;
              const mode = op.chamfer3D?.edgeSelectionMode || 'all';

              const chamfer =
                typeof occ.BRepFilletAPI_MakeChamfer_1 === 'function'
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

                safeDelete(edge);
                exp.Next();
              }
              safeDelete(exp);

              if (addedCount > 0) {
                chamfer.Build();
                if (chamfer.IsDone()) {
                  const newSolid = chamfer.Shape();
                  safeDelete(currentSolid);
                  currentSolid = newSolid;
                } else {
                  safeDelete(chamfer);
                  throw new Error(`Chamfer operation failed to build`);
                }
              }

              safeDelete(chamfer);

              if (op.featureId && currentSolid) {
                featureSolidCache.set(op.featureId, currentSolid);
              }
              success = true;
            } else if (op.type === 'SHELL_3D') {
              if (!currentSolid || currentSolid.IsNull()) {
                throw new Error(`Shell 3D requires an existing base solid`);
              }

              const rawThickness =
                typeof op.shell3D?.thickness === 'number' && !isNaN(op.shell3D.thickness)
                  ? op.shell3D.thickness
                  : 1.0;
              const isInside = op.shell3D?.direction !== 'outside';
              const offset = isInside ? -Math.abs(rawThickness) : Math.abs(rawThickness);

              const closingFaces = new occ.TopTools_ListOfShape_1();

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
                  safeDelete(pnt);
                  safeDelete(v);
                  vExp.Next();
                }
                safeDelete(vExp);

                const avgZ = vCount > 0 ? zSum / vCount : 0;
                if (avgZ > maxZ) {
                  maxZ = avgZ;
                  if (highestFace) {
                    safeDelete(highestFace);
                  }
                  highestFace = face;
                } else {
                  safeDelete(face);
                }

                expFace.Next();
              }
              safeDelete(expFace);

              if (highestFace) {
                closingFaces.Append_1(highestFace);
                safeDelete(highestFace);
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
                  safeDelete(currentSolid);
                  currentSolid = newSolid;
                } else {
                  safeDelete(hollow);
                  safeDelete(closingFaces);
                  throw new Error(`Shell operation failed to build thick solid`);
                }
                safeDelete(hollow);
              }

              safeDelete(closingFaces);

              if (op.featureId && currentSolid) {
                featureSolidCache.set(op.featureId, currentSolid);
              }
              success = true;
            }

            if (success) {
              hasAnySuccess = true;
            }
          } catch (featureErr: any) {
            errorMessage = featureErr?.message || 'Feature evaluation failed';
            console.error(`SolidWorker: Feature ${op.featureId || op.type} error:`, featureErr);
            featureDiag.push({
              level: 'error',
              message: errorMessage,
              featureId: op.featureId,
            });
            allDiagnostics.push(...featureDiag);
            success = false;
          }

          const fRes: FeatureResult = {
            featureId: op.featureId,
            success,
            createdBodyIds: success ? ['main-body'] : [],
            modifiedBodyIds: success ? ['main-body'] : [],
            diagnostics: featureDiag,
            error: errorMessage,
            executionTimeMs: performance.now() - tStart,
          };

          if (op.featureId) {
            featureResults[op.featureId] = fRes;

            // 存入快照快取 (snapshotStore)
            if (success && currentSolid && !currentSolid.IsNull()) {
              const copyMaker = new occ.BRepBuilderAPI_Copy_2(currentSolid, true, false);
              const shapeCopy = copyMaker.Shape();
              safeDelete(copyMaker);

              const meshCopy = tessellateSolid(shapeCopy, occ);

              snapshotStore.set(op.featureId, {
                featureId: op.featureId,
                shape: shapeCopy,
                mesh: meshCopy,
                featureResult: fRes,
              });
            }
          }
        }

        let meshResult: MeshResult | null = null;
        let bodies: BodyResult[] = [];

        if (currentSolid && !currentSolid.IsNull()) {
          meshResult = tessellateSolid(currentSolid, occ);
          meshResult.diagnostics = allDiagnostics;

          let boundingBox: BodyResult['boundingBox'] = undefined;
          try {
            const bbox = new occ.Bnd_Box_1();
            occ.BRepBndLib.Add(currentSolid, bbox);
            const minPnt = bbox.CornerMin();
            const maxPnt = bbox.CornerMax();
            boundingBox = {
              min: { x: minPnt.X(), y: minPnt.Y(), z: minPnt.Z() },
              max: { x: maxPnt.X(), y: maxPnt.Y(), z: maxPnt.Z() },
            };
            safeDelete(minPnt);
            safeDelete(maxPnt);
            safeDelete(bbox);
          } catch (bbErr) {
            console.warn('SolidWorker: Failed to calculate bounding box:', bbErr);
          }

          bodies = [
            {
              bodyId: 'main-body',
              name: 'Solid Body 1',
              isSolid: true,
              boundingBox,
            },
          ];
        } else {
          meshResult = {
            success: false,
            vertices: new Float32Array(0),
            normals: new Float32Array(0),
            indices: new Uint32Array(0),
            diagnostics: allDiagnostics,
          };
        }

        const kernelResult: KernelResult = {
          taskId: req.taskId,
          success: hasAnySuccess,
          finalMesh: meshResult,
          featureResults,
          bodies,
          diagnostics: allDiagnostics,
        };

        const transferBuffers: Transferable[] = [];
        if (meshResult && meshResult.vertices) {
          transferBuffers.push(meshResult.vertices.buffer);
          transferBuffers.push(meshResult.normals.buffer);
          transferBuffers.push(meshResult.indices.buffer);
          if (meshResult.edgeVertices && meshResult.edgeVertices.buffer) {
            transferBuffers.push(meshResult.edgeVertices.buffer);
          }
        }

        _self.postMessage(
          {
            taskId: req.taskId,
            type: req.type,
            success: true,
            data: kernelResult,
          } as SolidTaskResponse,
          transferBuffers
        );
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

        if (currentSolid) {
          safeDelete(currentSolid);
          currentSolid = null;
        }

        const builder = new occ.BRep_Builder();
        const compound = new occ.TopoDS_Compound();
        builder.MakeCompound(compound);

        for (const profile of profiles) {
          const face = createFaceFromProfile(profile, occ);
          const vec = new occ.gp_Vec_4(0, 0, depth);
          const prismMaker = new occ.BRepPrimAPI_MakePrism_1(face, vec, false, true);
          const prismSolid = prismMaker.Shape();

          builder.Add(compound, prismSolid);

          safeDelete(face);
          safeDelete(vec);
          safeDelete(prismSolid);
          safeDelete(prismMaker);
        }

        safeDelete(builder);

        currentSolid = compound;

        const meshData = tessellateSolid(compound, occ);
        const transferBuffers: Transferable[] = [
          meshData.vertices.buffer,
          meshData.normals.buffer,
          meshData.indices.buffer,
        ];
        if (meshData.edgeVertices && meshData.edgeVertices.buffer) {
          transferBuffers.push(meshData.edgeVertices.buffer);
        }

        _self.postMessage(
          {
            taskId: req.taskId,
            type: req.type,
            success: true,
            data: meshData,
          } as SolidTaskResponse,
          transferBuffers
        );
        break;
      }

      case 'EXPORT_STEP': {
        if (!oc || !currentSolid) throw new Error('No solid available to export');
        const occ = oc;

        const unit = req.payload?.unit || 'mm';
        try {
          if (occ.Interface_Static && typeof occ.Interface_Static.SetCVal === 'function') {
            occ.Interface_Static.SetCVal('write.step.unit', unit);
          }
        } catch (uErr) {
          console.warn('Failed to set STEP unit:', uErr);
        }

        const stepWriter = new occ.STEPControl_Writer_1();
        const transferResult = stepWriter.Transfer(
          currentSolid,
          occ.STEPControl_StepModelType.STEPControl_AsIs,
          true
        );

        const nbRoots =
          typeof stepWriter.NbRootsForTransfer === 'function' ? stepWriter.NbRootsForTransfer() : 1;
        const isTransferOk =
          nbRoots > 0 ||
          transferResult === true ||
          transferResult === 1 ||
          (occ.IFSelect_ReturnStatus &&
            transferResult === occ.IFSelect_ReturnStatus.IFSelect_RetDone);

        if (!isTransferOk) {
          safeDelete(stepWriter);
          throw new Error('STEP transfer failed');
        }

        const fileName = `/export_${Date.now()}.step`;
        try {
          stepWriter.Write(fileName);
        } catch (writeErr) {
          console.error('STEP write exception:', writeErr);
          try {
            stepWriter.Write(fileName.replace(/^\//, ''));
          } catch (writeErr2) {
            console.error('STEP write fallback exception:', writeErr2);
          }
        }

        let stepContent = '';
        try {
          try {
            stepContent = occ.FS.readFile(fileName, { encoding: 'utf8' });
          } catch {
            stepContent = occ.FS.readFile(fileName.replace(/^\//, ''), { encoding: 'utf8' });
          }
          try {
            occ.FS.unlink(fileName);
          } catch {
            occ.FS.unlink(fileName.replace(/^\//, ''));
          }
        } catch (fsErr) {
          console.warn('FS error reading STEP:', fsErr);
          throw new Error('STEP file generation failed on FS layer');
        }
        safeDelete(stepWriter);

        if (!stepContent) {
          throw new Error('STEP file generation failed on FS layer');
        }

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

        let mesher = null;
        try {
          mesher = new occ.BRepMesh_IncrementalMesh_2(currentSolid, 0.1, false, 0.5, false);
        } catch (err) {
          console.warn('Meshing failed before STL export:', err);
        }

        const stlWriter = new occ.StlAPI_Writer();
        try {
          if (typeof stlWriter.SetASCIIMode === 'function') {
            stlWriter.SetASCIIMode(false);
          } else if ('ASCIIMode' in stlWriter) {
            (stlWriter as any).ASCIIMode = false;
          }
        } catch (modeErr) {
          console.warn('Failed to set STL binary mode:', modeErr);
        }

        const fileName = `/export_${Date.now()}.stl`;

        let result = false;
        try {
          result = stlWriter.Write(currentSolid, fileName);
        } catch (err) {
          console.error('StlAPI_Writer Write exception:', err);
          try {
            result = stlWriter.Write(currentSolid, fileName.replace(/^\//, ''));
          } catch (err2) {
            console.error('StlAPI_Writer Write fallback exception:', err2);
          }
        }

        if (mesher) {
          safeDelete(mesher);
        }

        if (!result) {
          safeDelete(stlWriter);
          throw new Error('STL write failed');
        }

        let stlContent: Uint8Array | null = null;
        try {
          try {
            stlContent = occ.FS.readFile(fileName);
          } catch {
            stlContent = occ.FS.readFile(fileName.replace(/^\//, ''));
          }
          try {
            occ.FS.unlink(fileName);
          } catch {
            occ.FS.unlink(fileName.replace(/^\//, ''));
          }
        } catch (fsErr) {
          console.warn('FS error reading STL:', fsErr);
          throw new Error('STL file generation failed on FS layer');
        }
        safeDelete(stlWriter);

        if (stlContent && stlContent.byteLength > 0) {
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
          throw new Error('STL write failed');
        }
        break;
      }

      case 'EXPORT_MODEL': {
        if (!oc) throw new Error('OpenCASCADE engine not initialized');
        const occ = oc;
        const format = req.payload?.format || 'STEP';
        const operations = req.payload?.operations as FeatureEvalOp[] | undefined;

        if (operations && Array.isArray(operations) && operations.length > 0) {
          if (currentSolid) {
            safeDelete(currentSolid);
            currentSolid = null;
          }

          let accumSolid: any = null;
          for (const op of operations) {
            if (op.operation === 'JOIN') {
              const featSolid = createFeatureSolid(op, occ);
              if (featSolid && !featSolid.IsNull()) {
                if (!accumSolid) {
                  accumSolid = featSolid;
                } else {
                  const fuseMaker = new occ.BRepAlgoAPI_Fuse_3(accumSolid, featSolid);
                  fuseMaker.Build();
                  if (fuseMaker.IsDone()) {
                    const fused = fuseMaker.Shape();
                    safeDelete(accumSolid);
                    safeDelete(featSolid);
                    safeDelete(fuseMaker);
                    accumSolid = fused;
                  } else {
                    safeDelete(fuseMaker);
                    safeDelete(featSolid);
                  }
                }
              }
            } else if (op.operation === 'CUT' && accumSolid) {
              const cutSolid = createFeatureSolid(op, occ);
              if (cutSolid && !cutSolid.IsNull()) {
                const cutMaker = new occ.BRepAlgoAPI_Cut_3(accumSolid, cutSolid);
                cutMaker.Build();
                if (cutMaker.IsDone()) {
                  const resultShape = cutMaker.Shape();
                  safeDelete(accumSolid);
                  safeDelete(cutSolid);
                  safeDelete(cutMaker);
                  accumSolid = resultShape;
                } else {
                  safeDelete(cutMaker);
                  safeDelete(cutSolid);
                }
              }
            }
          }
          currentSolid = accumSolid;
        }

        if (!currentSolid) {
          throw new Error('No solid available to export. Make sure to generate a 3D solid first.');
        }

        if (format === 'STEP') {
          const unit = req.payload?.unit || 'mm';
          try {
            if (occ.Interface_Static && typeof occ.Interface_Static.SetCVal === 'function') {
              occ.Interface_Static.SetCVal('write.step.unit', unit);
            }
          } catch (uErr) {
            console.warn('Failed to set STEP unit:', uErr);
          }

          const stepWriter = new occ.STEPControl_Writer_1();
          stepWriter.Transfer(
            currentSolid,
            occ.STEPControl_StepModelType.STEPControl_AsIs,
            true
          );

          const fileName = `/export_${Date.now()}.step`;
          try {
            stepWriter.Write(fileName);
          } catch {
            stepWriter.Write(fileName.replace(/^\//, ''));
          }

          let stepContentBuffer: Uint8Array | null = null;
          try {
            try {
              stepContentBuffer = occ.FS.readFile(fileName);
            } catch {
              stepContentBuffer = occ.FS.readFile(fileName.replace(/^\//, ''));
            }
            try {
              occ.FS.unlink(fileName);
            } catch {}
          } catch (fsErr) {
            console.warn('FS error reading STEP:', fsErr);
            throw new Error('STEP file generation failed on FS layer');
          }
          safeDelete(stepWriter);

          if (stepContentBuffer && stepContentBuffer.byteLength > 0) {
            _self.postMessage(
              {
                taskId: req.taskId,
                type: req.type,
                success: true,
                data: stepContentBuffer,
              } as SolidTaskResponse,
              [stepContentBuffer.buffer]
            );
          } else {
            throw new Error('STEP file generation failed on FS layer');
          }
        } else {
          let mesher = null;
          try {
            mesher = new occ.BRepMesh_IncrementalMesh_2(currentSolid, 0.1, false, 0.5, false);
          } catch (err) {
            console.warn('Meshing failed before STL export:', err);
          }

          const stlWriter = new occ.StlAPI_Writer();
          try {
            if (typeof stlWriter.SetASCIIMode === 'function') {
              stlWriter.SetASCIIMode(false);
            } else if ('ASCIIMode' in stlWriter) {
              (stlWriter as any).ASCIIMode = false;
            }
          } catch (modeErr) {
            console.warn('Failed to set STL binary mode:', modeErr);
          }

          const fileName = `/export_${Date.now()}.stl`;
          let result = false;
          try {
            result = stlWriter.Write(currentSolid, fileName);
          } catch {
            result = stlWriter.Write(currentSolid, fileName.replace(/^\//, ''));
          }

          if (mesher) {
            safeDelete(mesher);
          }

          let stlContentBuffer: Uint8Array | null = null;
          try {
            try {
              stlContentBuffer = occ.FS.readFile(fileName);
            } catch {
              stlContentBuffer = occ.FS.readFile(fileName.replace(/^\//, ''));
            }
            try {
              occ.FS.unlink(fileName);
            } catch {}
          } catch (fsErr) {
            console.warn('FS error reading STL:', fsErr);
            throw new Error('STL file generation failed on FS layer');
          }
          safeDelete(stlWriter);

          if (stlContentBuffer && stlContentBuffer.byteLength > 0) {
            _self.postMessage(
              {
                taskId: req.taskId,
                type: req.type,
                success: true,
                data: stlContentBuffer,
              } as SolidTaskResponse,
              [stlContentBuffer.buffer]
            );
          } else {
            throw new Error('STL write failed');
          }
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
