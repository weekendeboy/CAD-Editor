/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

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
  FeatureEvaluationResult,
  FeatureResult,
  KernelResult,
} from './SolidEngine.types';
import type {
  MeshSubshapeMapping,
  RuntimeBRepFaceRef,
  RuntimeBRepEdgeRef,
  RuntimeBRepVertexRef,
  FaceTriangleRange,
  EdgeSegmentRange,
} from './MeshSubshapeMapping.types';
import {
  FeatureEvaluationCache,
  HistoryReplaySnapshot,
} from './FeatureEvaluationCache';
import {
  extractTopologyMap,
  resolveTopoReferenceToOCC,
} from './TopologyExtractor';
import type { SketchProfile, ProfileSegment } from '../../types/cad';

let oc: any = null;
let currentSolid: any = null; // Store the current solid compound for evaluation and export (History Replay Body State)

/**
 * 特徵評估結果快取 (Feature Evaluation Cache)
 * 專門保存特徵自身的評估產物（如 Extrude 生成的獨立 toolShape）。
 * 嚴禁將當前累積的整顆零件實體 (currentSolid) 誤存為特徵的 toolShape。
 */
const featureEvaluationCache = new FeatureEvaluationCache<any>();

/** 向下相容映射介面 (相容既有 cache 存取方法) */
const featureSolidCache = {
  get: (id: string) => featureEvaluationCache.getToolShape(id),
  has: (id: string) => featureEvaluationCache.hasToolShape(id),
  set: (id: string, shape: any) => {
    const existing = featureEvaluationCache.get(id);
    if (existing) {
      existing.toolShape = shape;
    } else {
      featureEvaluationCache.set(id, {
        featureId: id,
        toolShape: shape,
        result: {
          featureId: id,
          success: true,
          createdBodyIds: ['main-body'],
          modifiedBodyIds: [],
          diagnostics: [],
          error: null,
          executionTimeMs: 0,
        },
      });
    }
  },
  delete: (id: string) => {
    return featureEvaluationCache.delete(id, (s) => safeDelete(s));
  },
  clear: () => {
    featureEvaluationCache.clear((s) => safeDelete(s));
  },
  entries: function* () {
    for (const [id, entry] of featureEvaluationCache.entries()) {
      if (entry.toolShape) {
        yield [id, entry.toolShape] as [string, any];
      }
    }
  },
};

/**
 * 歷史回放快照儲存 (History Replay Snapshot Store)
 * 專門用於增量重算與回退優化 (Rollback / Incremental Replay)。
 * 保存整顆零件在此步驟後的累計 currentSolid 快照。
 */
const snapshotStore = new Map<string, HistoryReplaySnapshot<any>>();

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

/**
 * 【P4 架構修復】在寫入快取時，強制建立一份深拷貝的 Shape。
 * 保證即使上層管線中途刪除了 currentSolid，快取仍擁有自己獨立的 C++ 實體記憶體指標。
 */
function cacheShapeClone(featureId: string, sourceShape: any, occ: any, cacheMap: { set: (id: string, shape: any) => void }) {
  if (!sourceShape || sourceShape.IsNull()) return;
  const copyMaker = new occ.BRepBuilderAPI_Copy_2(sourceShape, true, false);
  const copy = copyMaker.Shape();
  safeDelete(copyMaker);
  cacheMap.set(featureId, copy);
}

const getBaseUrl = () => {
  if (self.location.pathname.includes('/assets/')) {
    return self.location.origin + self.location.pathname.split('/assets/')[0] + '/';
  }
  return self.location.origin + '/';
};

async function initWorker(wasmBuffer?: ArrayBuffer, occBaseUrl?: string) {
  if (!oc) {
    const baseUrl = occBaseUrl || getBaseUrl();
    const jsUrl = `${baseUrl}opencascade.wasm.js`;
    const wasmUrl = `${baseUrl}opencascade.wasm.wasm`;

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
        if (typeof innerWire.Reverse === 'function') {
          innerWire.Reverse();
        }
        faceMaker.Add(innerWire);
        safeDelete(innerWire);
      }
    }
  } else if (profile.innerLoops && profile.innerLoops.length > 0) {
    for (const innerLoop of profile.innerLoops) {
      if (innerLoop.length > 1) {
        const innerWire = buildWireFromPoints(innerLoop, occ);
        if (typeof innerWire.Reverse === 'function') {
          innerWire.Reverse();
        }
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

function tessellateSolid(
  solid: any,
  occ: any,
  options?: { bodyId?: string; generation?: number; featureId?: string }
): ExtrudeProfileResponseData {
  const bodyId = options?.bodyId || 'main-body';
  const generation = options?.generation ?? 1;

  if (!solid || solid.IsNull()) {
    return {
      success: false,
      vertices: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      mapping: {
        bodyId,
        generation,
        faces: [],
        edges: [],
        vertices: [],
        triangleToFaceIndex: new Int32Array(0),
        faceTriangleRanges: [],
        meshEdgeToBRepEdgeIndex: new Int32Array(0),
        edgeSegmentRanges: [],
        meshVertexToBRepVertexIndex: new Int32Array(0),
      },
    };
  }

  const mesher = new occ.BRepMesh_IncrementalMesh_2(solid, 0.1, false, 0.5, false);

  const featureId = options?.featureId || 'feature';
  let topologyMap: any = null;
  try {
    topologyMap = extractTopologyMap(solid, occ, featureId, bodyId, generation);
  } catch (_) {
    topologyMap = null;
  }

  const vertices: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let indexOffset = 0;

  const brepFaces: RuntimeBRepFaceRef[] = [];
  const triangleToFaceIndex: number[] = [];
  const faceTriangleRanges: FaceTriangleRange[] = [];

  const explorer = new occ.TopExp_Explorer_2(
    solid,
    occ.TopAbs_ShapeEnum.TopAbs_FACE,
    occ.TopAbs_ShapeEnum.TopAbs_SHAPE
  );

  let faceIndex = 0;
  while (explorer.More()) {
    const face = occ.TopoDS.Face_1(explorer.Current());
    const loc = new occ.TopLoc_Location_1();
    const triangulation = occ.BRep_Tool.Triangulation(face, loc);

    let surfaceType: RuntimeBRepFaceRef['surfaceType'] = 'other';
    let normal: { x: number; y: number; z: number } | undefined = undefined;
    let centroid: { x: number; y: number; z: number } | undefined = undefined;
    let area: number | undefined = undefined;

    let adaptor: any = null;
    try {
      adaptor = new occ.BRepAdaptor_Surface_2(face, true);
      const sType = adaptor.GetType();
      if (sType === occ.GeomAbs_SurfaceType.GeomAbs_Plane) {
        surfaceType = 'plane';
        const planeObj = adaptor.Plane();
        const ax3 = planeObj.Axis();
        const dir = ax3.Direction();
        normal = {
          x: Math.round(dir.X() * 10000) / 10000,
          y: Math.round(dir.Y() * 10000) / 10000,
          z: Math.round(dir.Z() * 10000) / 10000,
        };
        safeDelete(dir);
        safeDelete(ax3);
        safeDelete(planeObj);
      } else if (sType === occ.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
        surfaceType = 'cylinder';
      } else if (sType === occ.GeomAbs_SurfaceType.GeomAbs_Cone) {
        surfaceType = 'cone';
      } else if (sType === occ.GeomAbs_SurfaceType.GeomAbs_Sphere) {
        surfaceType = 'sphere';
      } else if (sType === occ.GeomAbs_SurfaceType.GeomAbs_Torus) {
        surfaceType = 'torus';
      } else if (
        sType === occ.GeomAbs_SurfaceType.GeomAbs_BSplineSurface ||
        sType === occ.GeomAbs_SurfaceType.GeomAbs_BezierSurface
      ) {
        surfaceType = 'bspline';
      }
    } catch (_) {
      surfaceType = 'other';
    } finally {
      safeDelete(adaptor);
    }

    let gprops: any = null;
    try {
      gprops = new occ.GProp_GProps();
      if (typeof occ.BRepGProp.SurfaceProperties_1 === 'function') {
        occ.BRepGProp.SurfaceProperties_1(face, gprops);
      } else if (typeof occ.BRepGProp.SurfaceProperties === 'function') {
        occ.BRepGProp.SurfaceProperties(face, gprops);
      }
      area = gprops.Mass();
      const cMass = gprops.CentreOfMass();
      centroid = {
        x: Math.round(cMass.X() * 10000) / 10000,
        y: Math.round(cMass.Y() * 10000) / 10000,
        z: Math.round(cMass.Z() * 10000) / 10000,
      };
      safeDelete(cMass);
    } catch (_) {
      // optional
    } finally {
      safeDelete(gprops);
    }

    const runtimeFaceRef: RuntimeBRepFaceRef = {
      bodyId,
      faceIndex,
      runtimeId: `brep_face_${bodyId}_${faceIndex}`,
      surfaceType,
      normal,
      area: typeof area === 'number' ? Math.round(area * 10000) / 10000 : undefined,
      centroid,
      topoRef: topologyMap?.faces?.[faceIndex],
    };
    brepFaces.push(runtimeFaceRef);

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

      const startTriangle = indices.length / 3;
      const triangleCount = numTriangles;

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

      faceTriangleRanges.push({
        faceIndex,
        startTriangle,
        triangleCount,
      });

      for (let t = 0; t < triangleCount; t++) {
        triangleToFaceIndex.push(faceIndex);
      }

      indexOffset += numNodes;

      safeDelete(nodeArray);
      safeDelete(triangleArray);
      if (normalArray) safeDelete(normalArray);
      safeDelete(triangulation);
    } else {
      faceTriangleRanges.push({
        faceIndex,
        startTriangle: indices.length / 3,
        triangleCount: 0,
      });
      safeDelete(triangulation);
    }

    safeDelete(face);
    safeDelete(loc);
    faceIndex++;
    explorer.Next();
  }

  safeDelete(explorer);

  const edges: number[] = [];
  const brepEdges: RuntimeBRepEdgeRef[] = [];
  const meshEdgeToBRepEdgeIndex: number[] = [];
  const edgeSegmentRanges: EdgeSegmentRange[] = [];

  const edgeExplorer = new occ.TopExp_Explorer_2(
    solid,
    occ.TopAbs_ShapeEnum.TopAbs_EDGE,
    occ.TopAbs_ShapeEnum.TopAbs_SHAPE
  );

  const edgeSet = new Set<number>();
  let edgeIndex = 0;

  while (edgeExplorer.More()) {
    const edge = occ.TopoDS.Edge_1(edgeExplorer.Current());
    const hashCode =
      typeof edge.HashCode === 'function'
        ? edge.HashCode(0x7fffffff)
        : typeof edge.HashCode_1 === 'function'
        ? edge.HashCode_1(0x7fffffff)
        : edgeIndex;

    if (!edgeSet.has(hashCode)) {
      edgeSet.add(hashCode);
      const loc = new occ.TopLoc_Location_1();
      let extracted = false;
      const startSegment = edges.length / 6;

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

      let curveType: RuntimeBRepEdgeRef['curveType'] = 'other';
      let curveAdaptor: any = null;
      let direction: { x: number; y: number; z: number } | undefined = undefined;
      let center: { x: number; y: number; z: number } | undefined = undefined;
      let radius: number | undefined = undefined;
      let normal: { x: number; y: number; z: number } | undefined = undefined;
      let startAngle: number | undefined = undefined;
      let endAngle: number | undefined = undefined;
      let sampledArcPoints: { x: number; y: number; z: number }[] | undefined = undefined;

      try {
        curveAdaptor = new occ.BRepAdaptor_Curve_2(edge);
        const cType = curveAdaptor.GetType();
        if (cType === occ.GeomAbs_CurveType.GeomAbs_Line) {
          curveType = 'line';
          const lineObj = curveAdaptor.Line();
          const dir = lineObj.Direction();
          direction = {
            x: Math.round(dir.X() * 10000) / 10000,
            y: Math.round(dir.Y() * 10000) / 10000,
            z: Math.round(dir.Z() * 10000) / 10000,
          };
          safeDelete(dir);
          safeDelete(lineObj);
        } else if (cType === occ.GeomAbs_CurveType.GeomAbs_Circle) {
          curveType = 'circle';
          try {
            const circ = curveAdaptor.Circle();
            const locPt = circ.Location();
            center = {
              x: Math.round(locPt.X() * 10000) / 10000,
              y: Math.round(locPt.Y() * 10000) / 10000,
              z: Math.round(locPt.Z() * 10000) / 10000,
            };
            radius = Math.round(circ.Radius() * 10000) / 10000;
            const ax = circ.Axis();
            const axDir = ax.Direction();
            normal = {
              x: Math.round(axDir.X() * 10000) / 10000,
              y: Math.round(axDir.Y() * 10000) / 10000,
              z: Math.round(axDir.Z() * 10000) / 10000,
            };
            startAngle = curveAdaptor.FirstParameter();
            endAngle = curveAdaptor.LastParameter();

            safeDelete(axDir);
            safeDelete(ax);
            safeDelete(locPt);
            safeDelete(circ);

            // 使用 curveAdaptor.Value 沿曲線精密取樣 32 段
            if (typeof curveAdaptor.Value === 'function' && typeof startAngle === 'number' && typeof endAngle === 'number') {
              const numSegs = 32;
              sampledArcPoints = [];
              for (let s = 0; s <= numSegs; s++) {
                const u = startAngle + (endAngle - startAngle) * (s / numSegs);
                const pVal = curveAdaptor.Value(u);
                sampledArcPoints.push({
                  x: Math.round(pVal.X() * 10000) / 10000,
                  y: Math.round(pVal.Y() * 10000) / 10000,
                  z: Math.round(pVal.Z() * 10000) / 10000,
                });
                safeDelete(pVal);
              }
            }
          } catch (eCirc) {
            console.warn('Failed to extract circle parameters from curveAdaptor:', eCirc);
          }
        } else if (cType === occ.GeomAbs_CurveType.GeomAbs_Ellipse) {
          curveType = 'ellipse';
        } else if (
          cType === occ.GeomAbs_CurveType.GeomAbs_BSplineCurve ||
          cType === occ.GeomAbs_CurveType.GeomAbs_BezierCurve
        ) {
          curveType = 'bspline';
        }
      } catch (_) {
        curveType = 'other';
      } finally {
        safeDelete(curveAdaptor);
      }

      if (!extracted && sampledArcPoints && sampledArcPoints.length >= 2) {
        for (let s = 0; s < sampledArcPoints.length - 1; s++) {
          const p1 = sampledArcPoints[s];
          const p2 = sampledArcPoints[s + 1];
          edges.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
        }
        extracted = true;
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

      const segmentCount = edges.length / 6 - startSegment;

      let length: number | undefined = undefined;
      try {
        const gprops = new occ.GProp_GProps();
        occ.BRepGProp.LinearProperties(edge, gprops);
        length = gprops.Mass();
        safeDelete(gprops);
      } catch (_) {}

      let startPoint: { x: number; y: number; z: number } | undefined = undefined;
      let endPoint: { x: number; y: number; z: number } | undefined = undefined;
      if (segmentCount > 0) {
        const firstIdx = startSegment * 6;
        startPoint = {
          x: Math.round(edges[firstIdx] * 10000) / 10000,
          y: Math.round(edges[firstIdx + 1] * 10000) / 10000,
          z: Math.round(edges[firstIdx + 2] * 10000) / 10000,
        };
        const lastIdx = (startSegment + segmentCount - 1) * 6;
        endPoint = {
          x: Math.round(edges[lastIdx + 3] * 10000) / 10000,
          y: Math.round(edges[lastIdx + 4] * 10000) / 10000,
          z: Math.round(edges[lastIdx + 5] * 10000) / 10000,
        };
      }

      const runtimeEdgeRef: RuntimeBRepEdgeRef = {
        bodyId,
        edgeIndex,
        runtimeId: `brep_edge_${bodyId}_${edgeIndex}`,
        curveType,
        length: typeof length === 'number' ? Math.round(length * 10000) / 10000 : undefined,
        direction,
        startPoint,
        endPoint,
        center,
        radius,
        normal,
        startAngle,
        endAngle,
        sampledPoints: sampledArcPoints,
        topoRef: topologyMap?.edges?.[edgeIndex],
      };
      brepEdges.push(runtimeEdgeRef);

      if (segmentCount > 0) {
        edgeSegmentRanges.push({
          edgeIndex,
          startSegment,
          segmentCount,
        });
        for (let s = 0; s < segmentCount; s++) {
          meshEdgeToBRepEdgeIndex.push(edgeIndex);
        }
      }

      edgeIndex++;
      safeDelete(loc);
    }
    safeDelete(edge);
    edgeExplorer.Next();
  }

  safeDelete(edgeExplorer);

  // 遍歷實體角落 B-Rep 頂點
  const brepVertices: RuntimeBRepVertexRef[] = [];
  const meshVertexToBRepVertexIndex: number[] = [];

  const vertexExplorer = new occ.TopExp_Explorer_2(
    solid,
    occ.TopAbs_ShapeEnum.TopAbs_VERTEX,
    occ.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  let vertexIndex = 0;
  const vertexSet = new Set<number>();

  while (vertexExplorer.More()) {
    const vertex = occ.TopoDS.Vertex_1(vertexExplorer.Current());
    const hashCode =
      typeof vertex.HashCode === 'function'
        ? vertex.HashCode(0x7fffffff)
        : typeof vertex.HashCode_1 === 'function'
        ? vertex.HashCode_1(0x7fffffff)
        : vertexIndex;

    if (!vertexSet.has(hashCode)) {
      vertexSet.add(hashCode);
      const pt = occ.BRep_Tool.Pnt(vertex);
      brepVertices.push({
        bodyId,
        vertexIndex,
        runtimeId: `brep_vertex_${bodyId}_${vertexIndex}`,
        point: {
          x: Math.round(pt.X() * 10000) / 10000,
          y: Math.round(pt.Y() * 10000) / 10000,
          z: Math.round(pt.Z() * 10000) / 10000,
        },
        topoRef: topologyMap?.vertices?.[vertexIndex],
      });
      safeDelete(pt);
      vertexIndex++;
    }
    safeDelete(vertex);
    vertexExplorer.Next();
  }
  safeDelete(vertexExplorer);

  // 建立 Mesh 節點 (vertices) -> B-Rep 頂點映射 (若非角落頂點則為 -1)
  const totalMeshNodes = vertices.length / 3;
  for (let m = 0; m < totalMeshNodes; m++) {
    const mx = vertices[m * 3];
    const my = vertices[m * 3 + 1];
    const mz = vertices[m * 3 + 2];
    let matchedIdx = -1;
    for (let b = 0; b < brepVertices.length; b++) {
      const bp = brepVertices[b].point;
      const d = Math.hypot(mx - bp.x, my - bp.y, mz - bp.z);
      if (d < 0.05) {
        matchedIdx = b;
        break;
      }
    }
    meshVertexToBRepVertexIndex.push(matchedIdx);
  }

  safeDelete(mesher);

  const vArray = new Float32Array(vertices);
  const nArray = new Float32Array(normals);
  const iArray = indexOffset > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  const eArray = new Float32Array(edges);

  const mapping: MeshSubshapeMapping = {
    bodyId,
    generation,
    faces: brepFaces,
    edges: brepEdges,
    vertices: brepVertices,
    triangleToFaceIndex: new Int32Array(triangleToFaceIndex),
    faceTriangleRanges,
    meshEdgeToBRepEdgeIndex: new Int32Array(meshEdgeToBRepEdgeIndex),
    edgeSegmentRanges,
    meshVertexToBRepVertexIndex: new Int32Array(meshVertexToBRepVertexIndex),
  };

  return {
    success: true,
    vertices: vArray,
    normals: nArray,
    indices: iArray,
    edgeVertices: eArray,
    edges: eArray,
    mapping,
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

        // Architecture Contract v1:
        // Worker 接收 dirtyOpIndex 作為 FeatureEvalOp[] 的 Operation Index。
        // null 表示無髒操作（如純回退移動、或末端草圖被編輯）。
        let dirtyOpIndex: number | null = null;
        if (typeof req.payload?.dirtyOpIndex === 'number') {
          dirtyOpIndex = req.payload.dirtyOpIndex;
        } else if (typeof req.payload?.dirtyFromIndex === 'number' && req.payload.dirtyFromIndex >= 0) {
          dirtyOpIndex = req.payload.dirtyFromIndex;
        }

        const isPureRollback: boolean = !!req.payload?.isPureRollback || dirtyOpIndex === null || dirtyOpIndex === -1;

        // 1. 純回退或完全命中快取檢查 (Pure Rollback / Full Cache Hit)
        if (isPureRollback && operations.length > 0) {
          const lastOp = operations[operations.length - 1];
          if (lastOp && lastOp.featureId && snapshotStore.has(lastOp.featureId)) {
            const cachedSnap = snapshotStore.get(lastOp.featureId)!;
            if (cachedSnap.cumulativeBody && !cachedSnap.cumulativeBody.IsNull()) {
              if (currentSolid && currentSolid !== cachedSnap.cumulativeBody) {
                safeDelete(currentSolid);
              }
              const copyMaker = new occ.BRepBuilderAPI_Copy_2(cachedSnap.cumulativeBody, true, false);
              currentSolid = copyMaker.Shape();
              safeDelete(copyMaker);

              const featureResults: Record<string, FeatureEvaluationResult> = {};
              const allDiagnostics: KernelDiagnostic[] = [];
              for (const op of operations) {
                if (op.featureId && snapshotStore.has(op.featureId)) {
                  const snap = snapshotStore.get(op.featureId)!;
                  featureResults[op.featureId] = snap.featureResult;
                  if (snap.cumulativeMesh.diagnostics) {
                    allDiagnostics.push(...snap.cumulativeMesh.diagnostics);
                  }
                }
              }

              let boundingBox: BodyResult['boundingBox'] = undefined;
              try {
                const bbox = new occ.Bnd_Box_1();
                if (typeof occ.BRepBndLib?.Add === 'function') {
                  try {
                    occ.BRepBndLib.Add(currentSolid, bbox, false);
                  } catch (_) {
                    try {
                      occ.BRepBndLib.Add(currentSolid, bbox);
                    } catch (_) {}
                  }
                } else if (typeof occ.BRepBndLib?.Add_1 === 'function') {
                  try {
                    occ.BRepBndLib.Add_1(currentSolid, bbox, false);
                  } catch (_) {}
                }
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

              // 【P4 核心修復】隔離 Mesh Buffer，切斷 Transferable 的 Detached Bug
              const vClone = cachedSnap.cumulativeMesh.vertices.slice();
              const nClone = cachedSnap.cumulativeMesh.normals.slice();
              const iClone = cachedSnap.cumulativeMesh.indices.slice();
              const eClone = cachedSnap.cumulativeMesh.edgeVertices ? cachedSnap.cumulativeMesh.edgeVertices.slice() : undefined;

              let safeMapping: MeshSubshapeMapping | undefined = undefined;
              if (cachedSnap.cumulativeMesh.mapping) {
                safeMapping = {
                  ...cachedSnap.cumulativeMesh.mapping,
                  triangleToFaceIndex: cachedSnap.cumulativeMesh.mapping.triangleToFaceIndex.slice(),
                  meshEdgeToBRepEdgeIndex: cachedSnap.cumulativeMesh.mapping.meshEdgeToBRepEdgeIndex.slice(),
                  meshVertexToBRepVertexIndex: cachedSnap.cumulativeMesh.mapping.meshVertexToBRepVertexIndex.slice(),
                };
              }

              const safeMeshResult: MeshResult = {
                ...cachedSnap.cumulativeMesh,
                vertices: vClone,
                normals: nClone,
                indices: iClone,
                edgeVertices: eClone,
                edges: eClone,
                mapping: safeMapping,
              };

              const kernelResult: KernelResult = {
                taskId: req.taskId,
                success: true,
                finalMesh: safeMeshResult,
                featureResults,
                bodies,
                diagnostics: allDiagnostics,
                mapping: safeMapping,
              };

              const transferBuffers: Transferable[] = [vClone.buffer, nClone.buffer, iClone.buffer];
              if (eClone) transferBuffers.push(eClone.buffer);

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
        if (dirtyOpIndex !== null && dirtyOpIndex > 0 && dirtyOpIndex < operations.length) {
          const prevOp = operations[dirtyOpIndex - 1];
          if (prevOp && prevOp.featureId && snapshotStore.has(prevOp.featureId)) {
            const prevSnap = snapshotStore.get(prevOp.featureId)!;
            if (prevSnap.cumulativeBody && !prevSnap.cumulativeBody.IsNull()) {
              if (currentSolid) {
                safeDelete(currentSolid);
                currentSolid = null;
              }
              const copyMaker = new occ.BRepBuilderAPI_Copy_2(prevSnap.cumulativeBody, true, false);
              currentSolid = copyMaker.Shape();
              safeDelete(copyMaker);
              evalStartIndex = dirtyOpIndex;
            }
          }
        }

        if (evalStartIndex === 0) {
          if (currentSolid) {
            safeDelete(currentSolid);
            currentSolid = null;
          }
          featureEvaluationCache.clear((shape) => safeDelete(shape));
          for (const snap of snapshotStore.values()) {
            if (snap.cumulativeBody) {
              safeDelete(snap.cumulativeBody);
            }
          }
          snapshotStore.clear();
        } else {
          for (let k = evalStartIndex; k < operations.length; k++) {
            const opId = operations[k].featureId;
            if (opId) {
              if (snapshotStore.has(opId)) {
                const snap = snapshotStore.get(opId)!;
                if (snap.cumulativeBody) {
                  safeDelete(snap.cumulativeBody);
                }
                snapshotStore.delete(opId);
              }
              featureEvaluationCache.delete(opId, (shape) => safeDelete(shape));
            }
          }
        }

        const allDiagnostics: KernelDiagnostic[] = [];
        const featureResults: Record<string, FeatureEvaluationResult> = {};

        for (let i = 0; i < evalStartIndex; i++) {
          const op = operations[i];
          if (op.featureId && snapshotStore.has(op.featureId)) {
            const snap = snapshotStore.get(op.featureId)!;
            featureResults[op.featureId] = snap.featureResult;
            if (snap.cumulativeMesh.diagnostics) {
              allDiagnostics.push(...snap.cumulativeMesh.diagnostics);
            }
            // 語意分離關鍵 (Architecture Contract v1):
            // 嚴禁將整顆零件的累計實體快照 snap.cumulativeBody 覆蓋回 featureEvaluationCache！
            // 前序未受影響特徵自身的獨立 toolShape 已在 featureEvaluationCache 中妥善保留。
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

              // 【P4 核心修復】隔離 Cache 記憶體所有權
              if (op.featureId) {
                cacheShapeClone(op.featureId, featureSolid, occ, featureSolidCache);
              }

              const isCut =
                op.operation === 'CUT' || op.type === 'CUT_EXTRUDE' || op.type === 'REVOLVE_CUT';

              if (currentSolid === null) {
                if (!isCut && (op.operation === 'JOIN' || op.type === 'EXTRUDE' || op.type === 'REVOLVE')) {
                  currentSolid = featureSolid; // 直接接管所有權
                } else if (isCut) {
                  featureDiag.push({
                    level: 'warning',
                    message: `Cut operation '${op.featureId || op.type}' ignored because no base solid exists.`,
                    featureId: op.featureId,
                  });
                  safeDelete(featureSolid);
                }
              } else {
                if (!isCut) {
                  const fuse = new occ.BRepAlgoAPI_Fuse_3(currentSolid, featureSolid);
                  fuse.Build();
                  if (fuse.IsDone()) {
                    const newSolid = fuse.Shape();
                    safeDelete(currentSolid);
                    safeDelete(featureSolid); // 【P4 核心修復】工具本體完成任務後強制釋放
                    currentSolid = newSolid;
                  } else {
                    safeDelete(fuse);
                    safeDelete(featureSolid);
                    throw new Error(`Boolean Fuse failed for feature ${op.featureId || op.type}`);
                  }
                  safeDelete(fuse);
                } else {
                  const cut = new occ.BRepAlgoAPI_Cut_3(currentSolid, featureSolid);
                  cut.Build();
                  if (cut.IsDone()) {
                    const newSolid = cut.Shape();
                    safeDelete(currentSolid);
                    safeDelete(featureSolid); // 【P4 核心修復】工具本體完成任務後強制釋放
                    currentSolid = newSolid;
                  } else {
                    safeDelete(cut);
                    safeDelete(featureSolid);
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
                  cacheShapeClone(op.featureId, featureSolid, occ, featureSolidCache);
                }

                const isCut = op.operation === 'CUT';

                if (currentSolid === null) {
                  if (!isCut) {
                    currentSolid = featureSolid;
                  } else {
                    safeDelete(featureSolid);
                  }
                } else {
                  if (!isCut) {
                    const fuse = new occ.BRepAlgoAPI_Fuse_3(currentSolid, featureSolid);
                    fuse.Build();
                    if (fuse.IsDone()) {
                      const newSolid = fuse.Shape();
                      safeDelete(currentSolid);
                      currentSolid = newSolid;
                    }
                    safeDelete(fuse);
                    safeDelete(featureSolid);
                  } else {
                    const cut = new occ.BRepAlgoAPI_Cut_3(currentSolid, featureSolid);
                    cut.Build();
                    if (cut.IsDone()) {
                      const newSolid = cut.Shape();
                      safeDelete(currentSolid);
                      currentSolid = newSolid;
                    }
                    safeDelete(cut);
                    safeDelete(featureSolid);
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
                  cacheShapeClone(op.featureId, featureSolid, occ, featureSolidCache);
                }

                const isCut = op.operation === 'CUT';

                if (currentSolid === null) {
                  if (!isCut) {
                    currentSolid = featureSolid;
                  } else {
                    safeDelete(featureSolid);
                  }
                } else {
                  if (!isCut) {
                    const fuse = new occ.BRepAlgoAPI_Fuse_3(currentSolid, featureSolid);
                    fuse.Build();
                    if (fuse.IsDone()) {
                      const newSolid = fuse.Shape();
                      safeDelete(currentSolid);
                      currentSolid = newSolid;
                    }
                    safeDelete(fuse);
                    safeDelete(featureSolid);
                  } else {
                    const cut = new occ.BRepAlgoAPI_Cut_3(currentSolid, featureSolid);
                    cut.Build();
                    if (cut.IsDone()) {
                      const newSolid = cut.Shape();
                      safeDelete(currentSolid);
                      currentSolid = newSolid;
                    }
                    safeDelete(cut);
                    safeDelete(featureSolid);
                  }
                }
              }
              success = true;
            } else if (
              op.type === 'LINEAR_PATTERN' ||
              op.type === 'CIRCULAR_PATTERN' ||
              op.type === 'MIRROR_3D'
            ) {
              // Architecture Contract v1: Feature Result 語意隔離
              // 嚴禁以快取中的全域累積實體 (currentSolid) 進行複製。
              // 必須精準取得目標特徵的純粹幾何 toolShape，並依其原始性質 (JOIN / CUT) 套用布林運算。
              if (!op.targetFeatureIds || op.targetFeatureIds.length === 0) {
                featureDiag.push({
                  level: 'error',
                  message: `Pattern/Mirror 特徵 '${op.featureId || op.type}' 執行失敗：未指定目標特徵 (targetFeatureIds 為空)。`,
                  featureId: op.featureId,
                });
                success = false;
              } else {
                interface TargetToolItem {
                  id: string;
                  toolShape: any;
                  isCut: boolean;
                }
                const targetTools: TargetToolItem[] = [];

                for (const tid of op.targetFeatureIds) {
                  const toolShape = featureEvaluationCache.getToolShape(tid);
                  if (toolShape && !toolShape.IsNull()) {
                    const targetOp = operations.find((o) => o.featureId === tid);
                    const isCut = targetOp
                      ? targetOp.operation === 'CUT' ||
                        targetOp.type === 'CUT_EXTRUDE' ||
                        targetOp.type === 'REVOLVE_CUT'
                      : op.operation === 'CUT';
                    targetTools.push({
                      id: tid,
                      toolShape,
                      isCut,
                    });
                  } else {
                    featureDiag.push({
                      level: 'warning',
                      message: `目標特徵 '${tid}' 無法在快取中找到有效的獨立 toolShape (可能為修飾特徵或尚未生成)。`,
                      featureId: op.featureId,
                    });
                  }
                }

                if (targetTools.length === 0) {
                  featureDiag.push({
                    level: 'error',
                    message: `Pattern/Mirror 特徵 '${op.featureId || op.type}' 執行失敗：所有目標特徵皆無可用的 toolShape。`,
                    featureId: op.featureId,
                  });
                  success = false;
                } else {
                  if (op.type === 'LINEAR_PATTERN') {
                    const pat = op.patternLinear;
                    if (!pat) {
                      throw new Error(`Linear Pattern requires patternLinear configuration`);
                    }
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

                        for (const tool of targetTools) {
                          const xform = new occ.BRepBuilderAPI_Transform_2(tool.toolShape, trsf, true);
                          const transformedCopy = xform.Shape();

                          if (tool.isCut) {
                            if (currentSolid !== null) {
                              const cut = new occ.BRepAlgoAPI_Cut_3(currentSolid, transformedCopy);
                              cut.Build();
                              if (cut.IsDone()) {
                                const newSolid = cut.Shape();
                                safeDelete(currentSolid);
                                currentSolid = newSolid;
                              } else {
                                safeDelete(cut);
                                safeDelete(transformedCopy);
                                safeDelete(xform);
                                safeDelete(trsf);
                                safeDelete(vec);
                                throw new Error(`Boolean Cut failed during linear pattern of ${tool.id}`);
                              }
                              safeDelete(cut);
                            }
                          } else {
                            if (currentSolid === null) {
                              currentSolid = transformedCopy;
                            } else {
                              const fuse = new occ.BRepAlgoAPI_Fuse_3(currentSolid, transformedCopy);
                              fuse.Build();
                              if (fuse.IsDone()) {
                                const newSolid = fuse.Shape();
                                safeDelete(currentSolid);
                                currentSolid = newSolid;
                              } else {
                                safeDelete(fuse);
                                safeDelete(transformedCopy);
                                safeDelete(xform);
                                safeDelete(trsf);
                                safeDelete(vec);
                                throw new Error(`Boolean Fuse failed during linear pattern of ${tool.id}`);
                              }
                              safeDelete(fuse);
                            }
                          }
                          safeDelete(transformedCopy);
                          safeDelete(xform);
                        }

                        safeDelete(trsf);
                        safeDelete(vec);
                      }
                    }
                    success = true;
                  } else if (op.type === 'CIRCULAR_PATTERN') {
                    const pat = op.patternCircular;
                    if (!pat) {
                      throw new Error(`Circular Pattern requires patternCircular configuration`);
                    }
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

                      for (const tool of targetTools) {
                        const xform = new occ.BRepBuilderAPI_Transform_2(tool.toolShape, trsf, true);
                        const transformedCopy = xform.Shape();

                        if (tool.isCut) {
                          if (currentSolid !== null) {
                            const cut = new occ.BRepAlgoAPI_Cut_3(currentSolid, transformedCopy);
                            cut.Build();
                            if (cut.IsDone()) {
                              const newSolid = cut.Shape();
                              safeDelete(currentSolid);
                              currentSolid = newSolid;
                            } else {
                              safeDelete(cut);
                              safeDelete(transformedCopy);
                              safeDelete(xform);
                              safeDelete(trsf);
                              safeDelete(rotAxis);
                              safeDelete(axDir);
                              safeDelete(axPnt);
                              throw new Error(`Boolean Cut failed during circular pattern of ${tool.id}`);
                            }
                            safeDelete(cut);
                          }
                        } else {
                          if (currentSolid === null) {
                            currentSolid = transformedCopy;
                          } else {
                            const fuse = new occ.BRepAlgoAPI_Fuse_3(currentSolid, transformedCopy);
                            fuse.Build();
                            if (fuse.IsDone()) {
                              const newSolid = fuse.Shape();
                              safeDelete(currentSolid);
                              currentSolid = newSolid;
                            } else {
                              safeDelete(fuse);
                              safeDelete(transformedCopy);
                              safeDelete(xform);
                              safeDelete(trsf);
                              safeDelete(rotAxis);
                              safeDelete(axDir);
                              safeDelete(axPnt);
                              throw new Error(`Boolean Fuse failed during circular pattern of ${tool.id}`);
                            }
                            safeDelete(fuse);
                          }
                        }
                        safeDelete(transformedCopy);
                        safeDelete(xform);
                      }

                      safeDelete(trsf);
                    }

                    safeDelete(rotAxis);
                    safeDelete(axDir);
                    safeDelete(axPnt);
                    success = true;
                  } else if (op.type === 'MIRROR_3D') {
                    const plane = op.mirrorPlane;
                    if (!plane) {
                      throw new Error(`Mirror 3D requires mirrorPlane configuration`);
                    }
                    const origin = plane.origin || { x: 0, y: 0, z: 0 };
                    const normal = plane.normal || { x: 0, y: 0, z: 1 };

                    const pnt = new occ.gp_Pnt_3(origin.x, origin.y, origin.z);
                    const dir = new occ.gp_Dir_4(normal.x, normal.y, normal.z);
                    const ax2 = new occ.gp_Ax2_3(pnt, dir);

                    const trsf = new occ.gp_Trsf_1();
                    setMirrorAx2(trsf, ax2);

                    for (const tool of targetTools) {
                      const xform = new occ.BRepBuilderAPI_Transform_2(tool.toolShape, trsf, true);
                      const mirroredCopy = xform.Shape();

                      if (tool.isCut) {
                        if (currentSolid !== null) {
                          const cut = new occ.BRepAlgoAPI_Cut_3(currentSolid, mirroredCopy);
                          cut.Build();
                          if (cut.IsDone()) {
                            const newSolid = cut.Shape();
                            safeDelete(currentSolid);
                            currentSolid = newSolid;
                          } else {
                            safeDelete(cut);
                            safeDelete(mirroredCopy);
                            safeDelete(xform);
                            safeDelete(trsf);
                            safeDelete(ax2);
                            safeDelete(dir);
                            safeDelete(pnt);
                            throw new Error(`Boolean Cut failed during mirror of ${tool.id}`);
                          }
                          safeDelete(cut);
                        }
                      } else {
                        if (currentSolid === null) {
                          currentSolid = mirroredCopy;
                        } else {
                          const fuse = new occ.BRepAlgoAPI_Fuse_3(currentSolid, mirroredCopy);
                          fuse.Build();
                          if (fuse.IsDone()) {
                            const newSolid = fuse.Shape();
                            safeDelete(currentSolid);
                            currentSolid = newSolid;
                          } else {
                            safeDelete(fuse);
                            safeDelete(mirroredCopy);
                            safeDelete(xform);
                            safeDelete(trsf);
                            safeDelete(ax2);
                            safeDelete(dir);
                            safeDelete(pnt);
                            throw new Error(`Boolean Fuse failed during mirror of ${tool.id}`);
                          }
                          safeDelete(fuse);
                        }
                      }
                      safeDelete(mirroredCopy);
                      safeDelete(xform);
                    }

                    safeDelete(trsf);
                    safeDelete(ax2);
                    safeDelete(dir);
                    safeDelete(pnt);
                    success = true;
                  }
                }
              }

              // 語意邊界 (Architecture Contract v1):
              // Pattern/Mirror 成果已布林融合至 currentSolid。
              // 嚴禁將整顆零件的 currentSolid 當成該特徵的 toolShape 存入 featureEvaluationCache。
              success = true;
            } else if (op.type === 'FILLET_3D') {
              if (!currentSolid || currentSolid.IsNull()) {
                throw new Error(`Fillet 3D requires an existing base solid`);
              }

              const radius =
                typeof op.fillet3D?.radius === 'number' && !isNaN(op.fillet3D.radius)
                  ? op.fillet3D.radius
                  : 1.0;

              if (radius <= 0) {
                throw new Error(`Fillet 3D radius must be greater than 0, got ${radius}`);
              }

              const edgeRefs = op.fillet3D?.edgeRefs || [];
              const prevOpId = i > 0 ? operations[i - 1].featureId : 'base';
              const currentGeneration = i;
              const topologyMap = extractTopologyMap(
                currentSolid,
                occ,
                prevOpId,
                'main-body',
                currentGeneration
              );

              const validOccEdges: any[] = [];
              let unresolvedCount = 0;

              for (const ref of edgeRefs) {
                const res = resolveTopoReferenceToOCC(ref, topologyMap, occ, currentSolid);
                if (
                  res.status === 'resolved' &&
                  res.occShape &&
                  (typeof res.occShape.IsNull !== 'function' || !res.occShape.IsNull())
                ) {
                  if (occ.BRep_Tool.Degenerated(res.occShape)) {
                    unresolvedCount++;
                    featureDiag.push({
                      level: 'warning',
                      message: `邊線 ${ref.persistentId} 為退化邊，已跳過 Fillet 3D 運算。`,
                      featureId: op.featureId,
                    });
                    safeDelete(res.occShape);
                  } else {
                    validOccEdges.push(res.occShape);
                  }
                } else {
                  unresolvedCount++;
                  featureDiag.push({
                    level: 'warning',
                    message:
                      res.error ||
                      `邊線拓撲參照 ${ref.persistentId} 解析失敗 (${res.status})。`,
                    featureId: op.featureId,
                  });
                }
              }

              if (unresolvedCount > 0 && edgeRefs.length > 0) {
                featureDiag.push({
                  level: 'warning',
                  message: `有 ${unresolvedCount} 條邊線拓撲解析失敗或已遺失 (共 ${edgeRefs.length} 條邊)`,
                  featureId: op.featureId,
                });
              }

              // 2. 若傳入 edgeIndices 但沒有 edgeRefs，進行向下相容映射
              if (validOccEdges.length === 0 && op.fillet3D?.edgeIndices && op.fillet3D.edgeIndices.length > 0) {
                for (const idx of op.fillet3D.edgeIndices) {
                  if (idx >= 0 && idx < topologyMap.edges.length) {
                    const fallbackRef = topologyMap.edges[idx];
                    const res = resolveTopoReferenceToOCC(fallbackRef, topologyMap, occ, currentSolid);
                    if (res.status === 'resolved' && res.occShape && !res.occShape.IsNull()) {
                      validOccEdges.push(res.occShape);
                    }
                  }
                }
              }

              // 3. 若均未選取特定邊線，依照 edgeSelectionMode (all / vertical / horizontal) 自動篩選
              if (validOccEdges.length === 0 && (!edgeRefs || edgeRefs.length === 0) && (!op.fillet3D?.edgeIndices || op.fillet3D.edgeIndices.length === 0)) {
                const mode = op.fillet3D?.edgeSelectionMode || 'all';
                for (const edgeRef of topologyMap.edges) {
                  let matches = false;
                  if (mode === 'all') {
                    matches = true;
                  } else if (mode === 'vertical' && edgeRef.signature?.direction) {
                    matches = Math.abs(edgeRef.signature.direction.z) > 0.9;
                  } else if (mode === 'horizontal' && edgeRef.signature?.direction) {
                    matches = Math.abs(edgeRef.signature.direction.z) < 0.1;
                  }
                  if (matches) {
                    const res = resolveTopoReferenceToOCC(edgeRef, topologyMap, occ, currentSolid);
                    if (res.status === 'resolved' && res.occShape && !res.occShape.IsNull()) {
                      if (!occ.BRep_Tool.Degenerated(res.occShape)) {
                        validOccEdges.push(res.occShape);
                      } else {
                        safeDelete(res.occShape);
                      }
                    }
                  }
                }

                // 備援方案：若 topologyMap 提取邊線為空，直接透過 OCC TopExp_Explorer 遍歷實體所有 Edge
                if (validOccEdges.length === 0) {
                  const edgeExp = new occ.TopExp_Explorer_2(
                    currentSolid,
                    occ.TopAbs_ShapeEnum.TopAbs_EDGE,
                    occ.TopAbs_ShapeEnum.TopAbs_SHAPE
                  );
                  const visitedEdgeHashes = new Set<number>();
                  while (edgeExp.More()) {
                    const candidateEdge = occ.TopoDS.Edge_1(edgeExp.Current());
                    const h = candidateEdge.HashCode(1000000);
                    if (!visitedEdgeHashes.has(h) && !occ.BRep_Tool.Degenerated(candidateEdge)) {
                      visitedEdgeHashes.add(h);
                      let matches = true;
                      if (mode === 'vertical' || mode === 'horizontal') {
                        try {
                          const curveAdaptor = new occ.BRepAdaptor_Curve_2(candidateEdge);
                          if (curveAdaptor.GetType() === occ.GeomAbs_CurveType.GeomAbs_Line) {
                            const p1 = curveAdaptor.Value(curveAdaptor.FirstParameter());
                            const p2 = curveAdaptor.Value(curveAdaptor.LastParameter());
                            const dz = Math.abs(p2.Z() - p1.Z());
                            const dist = p1.Distance(p2);
                            if (dist > 1e-4) {
                              const isVert = (dz / dist) > 0.9;
                              matches = mode === 'vertical' ? isVert : !isVert;
                            }
                            safeDelete(p1);
                            safeDelete(p2);
                          }
                          safeDelete(curveAdaptor);
                        } catch (_) {}
                      }
                      if (matches) {
                        validOccEdges.push(candidateEdge);
                      } else {
                        safeDelete(candidateEdge);
                      }
                    } else {
                      safeDelete(candidateEdge);
                    }
                    edgeExp.Next();
                  }
                  safeDelete(edgeExp);
                }
              }

              if (validOccEdges.length === 0) {
                featureDiag.push({
                  level: 'error',
                  message: `Fillet 3D 特徵執行失敗：沒有任何有效的邊線可供圓角運算 (已傳入 ${edgeRefs.length} 條參照)`,
                  featureId: op.featureId,
                });
                success = false;
              } else {
                let fillet: any = null;
                try {
                  fillet =
                    typeof occ.BRepFilletAPI_MakeFillet_1 === 'function'
                      ? new occ.BRepFilletAPI_MakeFillet_1(currentSolid, 0)
                      : new occ.BRepFilletAPI_MakeFillet(currentSolid, 0);

                  for (const edge of validOccEdges) {
                    if (typeof fillet.Add_2 === 'function') {
                      fillet.Add_2(radius, edge);
                    } else if (typeof fillet.Add_1 === 'function') {
                      fillet.Add_1(radius, edge);
                    } else {
                      fillet.Add(radius, edge);
                    }
                  }

                  fillet.Build();
                  if (fillet.IsDone()) {
                    const newSolid = fillet.Shape();
                    safeDelete(currentSolid);
                    currentSolid = newSolid;
                    success = true;
                  } else {
                    featureDiag.push({
                      level: 'error',
                      message: `Fillet operation failed to build shape with radius ${radius}`,
                      featureId: op.featureId,
                    });
                    success = false;
                  }
                } catch (filletErr: any) {
                  featureDiag.push({
                    level: 'error',
                    message: `Fillet operation threw error: ${filletErr?.message || filletErr}`,
                    featureId: op.featureId,
                  });
                  success = false;
                } finally {
                  for (const edge of validOccEdges) {
                    safeDelete(edge);
                  }
                  safeDelete(fillet);
                }
              }

              // 語意邊界 (Architecture Contract v1):
              // Fillet 為修飾特徵，成果已反映於 currentSolid。
              // 嚴禁將整顆零件的 currentSolid 當成該特徵的 toolShape 存入 featureEvaluationCache。
            } else if (op.type === 'CHAMFER_3D') {
              if (!currentSolid || currentSolid.IsNull()) {
                throw new Error(`Chamfer 3D requires an existing base solid`);
              }

              const distance =
                typeof op.chamfer3D?.distance === 'number' && !isNaN(op.chamfer3D.distance)
                  ? op.chamfer3D.distance
                  : 1.0;

              if (distance <= 0) {
                throw new Error(`Chamfer 3D distance must be greater than 0, got ${distance}`);
              }

              const edgeRefs = op.chamfer3D?.edgeRefs || [];
              const prevOpId = i > 0 ? operations[i - 1].featureId : 'base';
              const currentGeneration = i;
              const topologyMap = extractTopologyMap(
                currentSolid,
                occ,
                prevOpId,
                'main-body',
                currentGeneration
              );

              const validOccEdges: any[] = [];
              let unresolvedCount = 0;

              for (const ref of edgeRefs) {
                const res = resolveTopoReferenceToOCC(ref, topologyMap, occ, currentSolid);
                if (
                  res.status === 'resolved' &&
                  res.occShape &&
                  (typeof res.occShape.IsNull !== 'function' || !res.occShape.IsNull())
                ) {
                  if (occ.BRep_Tool.Degenerated(res.occShape)) {
                    unresolvedCount++;
                    featureDiag.push({
                      level: 'warning',
                      message: `邊線 ${ref.persistentId} 為退化邊，已跳過 Chamfer 3D 運算。`,
                      featureId: op.featureId,
                    });
                    safeDelete(res.occShape);
                  } else {
                    validOccEdges.push(res.occShape);
                  }
                } else {
                  unresolvedCount++;
                  featureDiag.push({
                    level: 'warning',
                    message:
                      res.error ||
                      `邊線拓撲參照 ${ref.persistentId} 解析失敗 (${res.status})。`,
                    featureId: op.featureId,
                  });
                }
              }

              if (unresolvedCount > 0 && edgeRefs.length > 0) {
                featureDiag.push({
                  level: 'warning',
                  message: `有 ${unresolvedCount} 條邊線拓撲解析失敗或已遺失 (共 ${edgeRefs.length} 條邊)`,
                  featureId: op.featureId,
                });
              }

              // 2. 若傳入 edgeIndices 但沒有 edgeRefs，進行向下相容映射
              if (validOccEdges.length === 0 && op.chamfer3D?.edgeIndices && op.chamfer3D.edgeIndices.length > 0) {
                for (const idx of op.chamfer3D.edgeIndices) {
                  if (idx >= 0 && idx < topologyMap.edges.length) {
                    const fallbackRef = topologyMap.edges[idx];
                    const res = resolveTopoReferenceToOCC(fallbackRef, topologyMap, occ, currentSolid);
                    if (res.status === 'resolved' && res.occShape && !res.occShape.IsNull()) {
                      validOccEdges.push(res.occShape);
                    }
                  }
                }
              }

              // 3. 若均未選取特定邊線，依照 edgeSelectionMode (all / vertical / horizontal) 自動篩選
              if (validOccEdges.length === 0 && (!edgeRefs || edgeRefs.length === 0) && (!op.chamfer3D?.edgeIndices || op.chamfer3D.edgeIndices.length === 0)) {
                const mode = op.chamfer3D?.edgeSelectionMode || 'all';
                for (const edgeRef of topologyMap.edges) {
                  let matches = false;
                  if (mode === 'all') {
                    matches = true;
                  } else if (mode === 'vertical' && edgeRef.signature?.direction) {
                    matches = Math.abs(edgeRef.signature.direction.z) > 0.9;
                  } else if (mode === 'horizontal' && edgeRef.signature?.direction) {
                    matches = Math.abs(edgeRef.signature.direction.z) < 0.1;
                  }
                  if (matches) {
                    const res = resolveTopoReferenceToOCC(edgeRef, topologyMap, occ, currentSolid);
                    if (res.status === 'resolved' && res.occShape && !res.occShape.IsNull()) {
                      if (!occ.BRep_Tool.Degenerated(res.occShape)) {
                        validOccEdges.push(res.occShape);
                      } else {
                        safeDelete(res.occShape);
                      }
                    }
                  }
                }

                // 備援方案：若 topologyMap 提取邊線為空，直接透過 OCC TopExp_Explorer 遍歷實體所有 Edge
                if (validOccEdges.length === 0) {
                  const edgeExp = new occ.TopExp_Explorer_2(
                    currentSolid,
                    occ.TopAbs_ShapeEnum.TopAbs_EDGE,
                    occ.TopAbs_ShapeEnum.TopAbs_SHAPE
                  );
                  const visitedEdgeHashes = new Set<number>();
                  while (edgeExp.More()) {
                    const candidateEdge = occ.TopoDS.Edge_1(edgeExp.Current());
                    const h = candidateEdge.HashCode(1000000);
                    if (!visitedEdgeHashes.has(h) && !occ.BRep_Tool.Degenerated(candidateEdge)) {
                      visitedEdgeHashes.add(h);
                      let matches = true;
                      if (mode === 'vertical' || mode === 'horizontal') {
                        try {
                          const curveAdaptor = new occ.BRepAdaptor_Curve_2(candidateEdge);
                          if (curveAdaptor.GetType() === occ.GeomAbs_CurveType.GeomAbs_Line) {
                            const p1 = curveAdaptor.Value(curveAdaptor.FirstParameter());
                            const p2 = curveAdaptor.Value(curveAdaptor.LastParameter());
                            const dz = Math.abs(p2.Z() - p1.Z());
                            const dist = p1.Distance(p2);
                            if (dist > 1e-4) {
                              const isVert = (dz / dist) > 0.9;
                              matches = mode === 'vertical' ? isVert : !isVert;
                            }
                            safeDelete(p1);
                            safeDelete(p2);
                          }
                          safeDelete(curveAdaptor);
                        } catch (_) {}
                      }
                      if (matches) {
                        validOccEdges.push(candidateEdge);
                      } else {
                        safeDelete(candidateEdge);
                      }
                    } else {
                      safeDelete(candidateEdge);
                    }
                    edgeExp.Next();
                  }
                  safeDelete(edgeExp);
                }
              }

              if (validOccEdges.length === 0) {
                featureDiag.push({
                  level: 'error',
                  message: `Chamfer 3D 特徵執行失敗：沒有任何有效的邊線可供倒角運算 (已傳入 ${edgeRefs.length} 條參照)`,
                  featureId: op.featureId,
                });
                success = false;
              } else {
                let chamfer: any = null;
                try {
                  chamfer =
                    typeof occ.BRepFilletAPI_MakeChamfer_1 === 'function'
                      ? new occ.BRepFilletAPI_MakeChamfer_1(currentSolid)
                      : new occ.BRepFilletAPI_MakeChamfer(currentSolid);

                  for (const edge of validOccEdges) {
                    if (typeof chamfer.Add_2 === 'function') {
                      chamfer.Add_2(distance, edge);
                    } else {
                      chamfer.Add(distance, edge);
                    }
                  }

                  chamfer.Build();
                  if (chamfer.IsDone()) {
                    const newSolid = chamfer.Shape();
                    safeDelete(currentSolid);
                    currentSolid = newSolid;
                    success = true;
                  } else {
                    featureDiag.push({
                      level: 'error',
                      message: `Chamfer operation failed to build shape with distance ${distance}`,
                      featureId: op.featureId,
                    });
                    success = false;
                  }
                } catch (chamferErr: any) {
                  featureDiag.push({
                    level: 'error',
                    message: `Chamfer operation threw error: ${chamferErr?.message || chamferErr}`,
                    featureId: op.featureId,
                  });
                  success = false;
                } finally {
                  for (const edge of validOccEdges) {
                    safeDelete(edge);
                  }
                  safeDelete(chamfer);
                }
              }

              // 語意邊界 (Architecture Contract v1):
              // Chamfer 為修飾特徵，成果已反映於 currentSolid。
              // 嚴禁將整顆零件的 currentSolid 當成該特徵的 toolShape 存入 featureEvaluationCache。
            } else if (op.type === 'SHELL_3D') {
              if (!currentSolid || currentSolid.IsNull()) {
                throw new Error(`Shell 3D requires an existing base solid`);
              }

              const rawThickness =
                typeof op.shell3D?.thickness === 'number' && !isNaN(op.shell3D.thickness)
                  ? op.shell3D.thickness
                  : 1.5;
              if (rawThickness <= 0) {
                throw new Error(`Shell 3D thickness must be greater than 0, got ${rawThickness}`);
              }
              const isInside = op.shell3D?.direction !== 'outside';
              const offset = isInside ? -Math.abs(rawThickness) : Math.abs(rawThickness);

              const removedFaceRefs = op.shell3D?.removedFaceRefs || [];
              const prevOpId = i > 0 ? operations[i - 1].featureId : 'base';
              const currentGeneration = i;
              const topologyMap = extractTopologyMap(
                currentSolid,
                occ,
                prevOpId,
                'main-body',
                currentGeneration
              );

              const validOccFaces: any[] = [];
              let unresolvedCount = 0;

              for (const ref of removedFaceRefs) {
                const res = resolveTopoReferenceToOCC(ref, topologyMap, occ, currentSolid);
                console.log(`[SolidWorker SHELL_3D Diagnostic] Ref resolution:`, {
                  refPersistentId: ref?.persistentId,
                  refFeatureId: ref?.featureId,
                  refGeneration: ref?.generation,
                  status: res.status,
                  error: res.error,
                  resMessage: res.resolution?.message,
                  mapBodyId: topologyMap?.bodyId,
                  mapGeneration: (topologyMap as any)?.generation,
                  mapFaceCount: topologyMap?.faces?.length,
                });
                if (
                  res.status === 'resolved' &&
                  res.occShape &&
                  (typeof res.occShape.IsNull !== 'function' || !res.occShape.IsNull())
                ) {
                  validOccFaces.push(res.occShape);
                } else {
                  unresolvedCount++;
                  featureDiag.push({
                    level: 'warning',
                    message:
                      res.error ||
                      `表面拓撲參照 ${ref.persistentId} 解析失敗 (${res.status})。`,
                    featureId: op.featureId,
                  });
                }
              }

              console.log(`[SolidWorker SHELL_3D Diagnostic] Total removedFaceRefs: ${removedFaceRefs.length}, validOccFaces: ${validOccFaces.length}, unresolved: ${unresolvedCount}`);

              if (unresolvedCount > 0 && removedFaceRefs.length > 0) {
                featureDiag.push({
                  level: 'warning',
                  message: `有 ${unresolvedCount} 個表面拓撲解析失敗或已遺失 (共 ${removedFaceRefs.length} 個表面)`,
                  featureId: op.featureId,
                });
              }

              if (removedFaceRefs.length > 0 && validOccFaces.length === 0) {
                featureDiag.push({
                  level: 'error',
                  message: `Shell 3D 特徵執行失敗：指定移除之表面拓撲解析失敗，無有效表面可供薄殼運算 (已傳入 ${removedFaceRefs.length} 個參照)`,
                  featureId: op.featureId,
                });
                success = false;
              } else {
                const closingFaces = new occ.TopTools_ListOfShape_1();
                for (const face of validOccFaces) {
                  if (typeof closingFaces.Append_1 === 'function') {
                    closingFaces.Append_1(face);
                  } else {
                    closingFaces.Append(face);
                  }
                }

                let hollow: any = null;
                try {
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
                    const isDone = hollow.IsDone();
                    console.log(`[SolidWorker SHELL_3D Diagnostic] BRepOffsetAPI_MakeThickSolid Build complete, IsDone: ${isDone}`);
                    if (isDone) {
                      const newSolid = hollow.Shape();
                      safeDelete(currentSolid);
                      currentSolid = newSolid;
                      success = true;
                    } else {
                      featureDiag.push({
                        level: 'error',
                        message: `Shell operation failed to build thick solid with thickness ${rawThickness}`,
                        featureId: op.featureId,
                      });
                      success = false;
                    }
                  }
                } catch (shellErr: any) {
                  featureDiag.push({
                    level: 'error',
                    message: `Shell operation threw error: ${shellErr?.message || shellErr}`,
                    featureId: op.featureId,
                  });
                  success = false;
                } finally {
                  for (const face of validOccFaces) {
                    safeDelete(face);
                  }
                  safeDelete(closingFaces);
                  safeDelete(hollow);
                }
              }

              // 語意邊界 (Architecture Contract v1):
              // Shell 為修飾特徵，成果已反映於 currentSolid。
              // 嚴禁將整顆零件的 currentSolid 當成該特徵的 toolShape 存入 featureEvaluationCache。
              if (success) {
                hasAnySuccess = true;
              }
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
            success = false;
          }

          if (featureDiag.length > 0) {
            allDiagnostics.push(...featureDiag);
          }

          const isGenerative =
            op.type === 'EXTRUDE' ||
            op.type === 'CUT_EXTRUDE' ||
            op.type === 'REVOLVE' ||
            op.type === 'REVOLVE_CUT' ||
            op.type === 'SWEEP' ||
            op.type === 'LOFT';

          const fRes: FeatureEvaluationResult = {
            featureId: op.featureId,
            success,
            createdBodyIds: success && isGenerative && op.operation !== 'CUT' ? ['main-body'] : [],
            modifiedBodyIds: success ? ['main-body'] : [],
            diagnostics: featureDiag,
            error: errorMessage,
            executionTimeMs: performance.now() - tStart,
            // 語意契約欄位 (Architecture Contract v1):
            // 明確標記工具體與結果實體參照，嚴禁將整顆零件的 currentSolid 當作單一特徵自身產物
            toolShape: isGenerative ? op.type : undefined,
            resultBody: success ? 'main-body' : undefined,
          };

          if (op.featureId) {
            featureResults[op.featureId] = fRes;

            // 更新 FeatureEvaluationCache 中該特徵的評估結果資訊 (維持 toolShape 與 fRes 一致)
            const existingEntry = featureEvaluationCache.get(op.featureId);
            if (existingEntry) {
              existingEntry.result = fRes;
            } else {
              featureEvaluationCache.set(op.featureId, {
                featureId: op.featureId,
                toolShape: undefined,
                result: fRes,
              });
            }

            // 存入歷史回放實體快照 (snapshotStore)
            // 保存「執行至此特徵後整顆零件的累計 currentSolid 快照」，專供歷史重播與回退優化使用
            if (success && currentSolid && !currentSolid.IsNull()) {
              const copyMaker = new occ.BRepBuilderAPI_Copy_2(currentSolid, true, false);
              const shapeCopy = copyMaker.Shape();
              safeDelete(copyMaker);

              const meshCopy = tessellateSolid(shapeCopy, occ, {
                bodyId: 'main-body',
                generation: i + 1,
                featureId: op.featureId,
              });

              snapshotStore.set(op.featureId, {
                featureId: op.featureId,
                stepIndex: i,
                cumulativeBody: shapeCopy,
                cumulativeMesh: meshCopy,
                featureResult: fRes,
              });
            }
          }
        }

        let meshResult: MeshResult | null = null;
        let bodies: BodyResult[] = [];

        if (currentSolid && !currentSolid.IsNull()) {
          const lastOp = operations.length > 0 ? operations[operations.length - 1] : null;
          meshResult = tessellateSolid(currentSolid, occ, {
            bodyId: 'main-body',
            generation: operations.length,
            featureId: lastOp ? lastOp.featureId : 'final',
          });
          meshResult.diagnostics = allDiagnostics;

          let boundingBox: BodyResult['boundingBox'] = undefined;
          try {
            const bbox = new occ.Bnd_Box_1();
            if (typeof occ.BRepBndLib?.Add === 'function') {
              try {
                occ.BRepBndLib.Add(currentSolid, bbox, false);
              } catch (_) {
                try {
                  occ.BRepBndLib.Add(currentSolid, bbox);
                } catch (_) {}
              }
            } else if (typeof occ.BRepBndLib?.Add_1 === 'function') {
              try {
                occ.BRepBndLib.Add_1(currentSolid, bbox, false);
              } catch (_) {}
            }
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

        // 【P4 核心修復】隔離 Mesh Buffer，切斷 Transferable 的 Detached Bug
        const vClone = meshResult.vertices.slice();
        const nClone = meshResult.normals.slice();
        const iClone = meshResult.indices.slice();
        const eClone = meshResult.edgeVertices ? meshResult.edgeVertices.slice() : undefined;

        let safeMapping: MeshSubshapeMapping | undefined = undefined;
        if (meshResult.mapping) {
          safeMapping = {
            ...meshResult.mapping,
            triangleToFaceIndex: meshResult.mapping.triangleToFaceIndex.slice(),
            meshEdgeToBRepEdgeIndex: meshResult.mapping.meshEdgeToBRepEdgeIndex.slice(),
            meshVertexToBRepVertexIndex: meshResult.mapping.meshVertexToBRepVertexIndex.slice(),
          };
        }

        const safeMeshResult: MeshResult = {
          ...meshResult,
          vertices: vClone,
          normals: nClone,
          indices: iClone,
          edgeVertices: eClone,
          edges: eClone,
          mapping: safeMapping,
        };

        const kernelResult: KernelResult = {
          taskId: req.taskId,
          success: hasAnySuccess,
          finalMesh: safeMeshResult,
          featureResults,
          bodies,
          diagnostics: allDiagnostics,
          mapping: safeMapping,
        };

        const transferBuffers: Transferable[] = [vClone.buffer, nClone.buffer, iClone.buffer];
        if (eClone) transferBuffers.push(eClone.buffer);

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

        // 【P4 核心修復】隔離 Mesh Buffer，切斷 Transferable 的 Detached Bug
        const vClone = meshData.vertices.slice();
        const nClone = meshData.normals.slice();
        const iClone = meshData.indices.slice();
        const eClone = meshData.edgeVertices ? meshData.edgeVertices.slice() : undefined;

        const safeMeshData: MeshResult = {
          ...meshData,
          vertices: vClone,
          normals: nClone,
          indices: iClone,
          edgeVertices: eClone,
          edges: eClone,
        };

        const transferBuffers: Transferable[] = [vClone.buffer, nClone.buffer, iClone.buffer];
        if (eClone) transferBuffers.push(eClone.buffer);

        _self.postMessage(
          {
            taskId: req.taskId,
            type: req.type,
            success: true,
            data: safeMeshData,
          } as SolidTaskResponse,
          transferBuffers
        );
        break;
      }

      case 'PREVIEW_OPERATION': {
        if (!oc) throw new Error('Worker not initialized');
        if (!currentSolid || (typeof currentSolid.IsNull === 'function' && currentSolid.IsNull())) {
          throw new Error('No active solid body available for preview');
        }
        const occ = oc;
        const op = req.payload?.operation as FeatureEvalOp;
        if (!op) {
          throw new Error('No operation provided for preview');
        }

        let tempSolid: any = null;
        try {
          const copyMaker = new occ.BRepBuilderAPI_Copy_2(currentSolid, true, false);
          tempSolid = copyMaker.Shape();
          safeDelete(copyMaker);
        } catch (_) {
          const copyMaker = new occ.BRepBuilderAPI_Copy_1(currentSolid, true);
          tempSolid = copyMaker.Shape();
          safeDelete(copyMaker);
        }

        const validOccEdges: any[] = [];
        let previewMaker: any = null;

        try {
          if (op.type === 'FILLET_3D') {
            const radius = typeof op.fillet3D?.radius === 'number' && !isNaN(op.fillet3D.radius) ? op.fillet3D.radius : 2.0;
            const edgeRefs = op.fillet3D?.edgeRefs || [];
            const edgeIndices = op.fillet3D?.edgeIndices || [];
            const mode = op.fillet3D?.edgeSelectionMode || 'all';

            // 1. Resolve explicit edgeRefs
            if (edgeRefs.length > 0) {
              const refFeatId = edgeRefs[0]?.featureId || 'preview-base';
              const refGen = edgeRefs[0]?.generation ?? 1;
              const topologyMap = extractTopologyMap(tempSolid, occ, refFeatId, 'main-body', refGen);
              for (const ref of edgeRefs) {
                const res = resolveTopoReferenceToOCC(ref, topologyMap, occ, tempSolid);
                if (res.status === 'resolved' && res.occShape && !res.occShape.IsNull()) {
                  if (!occ.BRep_Tool.Degenerated(res.occShape)) {
                    validOccEdges.push(res.occShape);
                  } else {
                    safeDelete(res.occShape);
                  }
                }
              }
            }

            // 2. Resolve edgeIndices fallback
            if (validOccEdges.length === 0 && edgeIndices.length > 0) {
              const topologyMap = extractTopologyMap(tempSolid, occ, 'preview-base', 'main-body', 0);
              for (const idx of edgeIndices) {
                if (idx >= 0 && idx < topologyMap.edges.length) {
                  const fallbackRef = topologyMap.edges[idx];
                  const res = resolveTopoReferenceToOCC(fallbackRef, topologyMap, occ, tempSolid);
                  if (res.status === 'resolved' && res.occShape && !res.occShape.IsNull()) {
                    validOccEdges.push(res.occShape);
                  }
                }
              }
            }

            // 3. Fallback to mode (all, vertical, horizontal)
            if (validOccEdges.length === 0 && edgeRefs.length === 0 && edgeIndices.length === 0) {
              const edgeExp = new occ.TopExp_Explorer_2(
                tempSolid,
                occ.TopAbs_ShapeEnum.TopAbs_EDGE,
                occ.TopAbs_ShapeEnum.TopAbs_SHAPE
              );
              const visited = new Set<number>();
              while (edgeExp.More()) {
                const candidateEdge = occ.TopoDS.Edge_1(edgeExp.Current());
                const h = candidateEdge.HashCode(1000000);
                if (!visited.has(h) && !occ.BRep_Tool.Degenerated(candidateEdge)) {
                  visited.add(h);
                  let matches = true;
                  if (mode === 'vertical' || mode === 'horizontal') {
                    try {
                      const curveAdaptor = new occ.BRepAdaptor_Curve_2(candidateEdge);
                      if (curveAdaptor.GetType() === occ.GeomAbs_CurveType.GeomAbs_Line) {
                        const p1 = curveAdaptor.Value(curveAdaptor.FirstParameter());
                        const p2 = curveAdaptor.Value(curveAdaptor.LastParameter());
                        const dz = Math.abs(p2.Z() - p1.Z());
                        const dist = p1.Distance(p2);
                        if (dist > 1e-4) {
                          const isVert = (dz / dist) > 0.9;
                          matches = mode === 'vertical' ? isVert : !isVert;
                        }
                        safeDelete(p1);
                        safeDelete(p2);
                      }
                      safeDelete(curveAdaptor);
                    } catch (_) {}
                  }
                  if (matches) {
                    validOccEdges.push(candidateEdge);
                  } else {
                    safeDelete(candidateEdge);
                  }
                } else {
                  safeDelete(candidateEdge);
                }
                edgeExp.Next();
              }
              safeDelete(edgeExp);
            }

            if (validOccEdges.length === 0) {
              throw new Error('No valid edges found for Fillet preview');
            }

            previewMaker = typeof occ.BRepFilletAPI_MakeFillet_1 === 'function'
              ? new occ.BRepFilletAPI_MakeFillet_1(tempSolid, 0)
              : new occ.BRepFilletAPI_MakeFillet(tempSolid, 0);

            for (const edge of validOccEdges) {
              if (typeof previewMaker.Add_2 === 'function') {
                previewMaker.Add_2(radius, edge);
              } else if (typeof previewMaker.Add_1 === 'function') {
                previewMaker.Add_1(radius, edge);
              } else {
                previewMaker.Add(radius, edge);
              }
            }

            previewMaker.Build();
            if (!previewMaker.IsDone()) {
              throw new Error(`Fillet preview failed to build with radius ${radius}`);
            }

            const filletedShape = previewMaker.Shape();
            safeDelete(tempSolid);
            tempSolid = filletedShape;

          } else if (op.type === 'CHAMFER_3D') {
            const distance = typeof op.chamfer3D?.distance === 'number' && !isNaN(op.chamfer3D.distance) ? op.chamfer3D.distance : 2.0;
            const edgeRefs = op.chamfer3D?.edgeRefs || [];
            const edgeIndices = op.chamfer3D?.edgeIndices || [];
            const mode = op.chamfer3D?.edgeSelectionMode || 'all';

            // 1. Resolve explicit edgeRefs
            if (edgeRefs.length > 0) {
              const refFeatId = edgeRefs[0]?.featureId || 'preview-base';
              const refGen = edgeRefs[0]?.generation ?? 1;
              const topologyMap = extractTopologyMap(tempSolid, occ, refFeatId, 'main-body', refGen);
              for (const ref of edgeRefs) {
                const res = resolveTopoReferenceToOCC(ref, topologyMap, occ, tempSolid);
                if (res.status === 'resolved' && res.occShape && !res.occShape.IsNull()) {
                  if (!occ.BRep_Tool.Degenerated(res.occShape)) {
                    validOccEdges.push(res.occShape);
                  } else {
                    safeDelete(res.occShape);
                  }
                }
              }
            }

            // 2. Resolve edgeIndices fallback
            if (validOccEdges.length === 0 && edgeIndices.length > 0) {
              const topologyMap = extractTopologyMap(tempSolid, occ, 'preview-base', 'main-body', 0);
              for (const idx of edgeIndices) {
                if (idx >= 0 && idx < topologyMap.edges.length) {
                  const fallbackRef = topologyMap.edges[idx];
                  const res = resolveTopoReferenceToOCC(fallbackRef, topologyMap, occ, tempSolid);
                  if (res.status === 'resolved' && res.occShape && !res.occShape.IsNull()) {
                    validOccEdges.push(res.occShape);
                  }
                }
              }
            }

            // 3. Fallback to mode (all, vertical, horizontal)
            if (validOccEdges.length === 0 && edgeRefs.length === 0 && edgeIndices.length === 0) {
              const edgeExp = new occ.TopExp_Explorer_2(
                tempSolid,
                occ.TopAbs_ShapeEnum.TopAbs_EDGE,
                occ.TopAbs_ShapeEnum.TopAbs_SHAPE
              );
              const visited = new Set<number>();
              while (edgeExp.More()) {
                const candidateEdge = occ.TopoDS.Edge_1(edgeExp.Current());
                const h = candidateEdge.HashCode(1000000);
                if (!visited.has(h) && !occ.BRep_Tool.Degenerated(candidateEdge)) {
                  visited.add(h);
                  let matches = true;
                  if (mode === 'vertical' || mode === 'horizontal') {
                    try {
                      const curveAdaptor = new occ.BRepAdaptor_Curve_2(candidateEdge);
                      if (curveAdaptor.GetType() === occ.GeomAbs_CurveType.GeomAbs_Line) {
                        const p1 = curveAdaptor.Value(curveAdaptor.FirstParameter());
                        const p2 = curveAdaptor.Value(curveAdaptor.LastParameter());
                        const dz = Math.abs(p2.Z() - p1.Z());
                        const dist = p1.Distance(p2);
                        if (dist > 1e-4) {
                          const isVert = (dz / dist) > 0.9;
                          matches = mode === 'vertical' ? isVert : !isVert;
                        }
                        safeDelete(p1);
                        safeDelete(p2);
                      }
                      safeDelete(curveAdaptor);
                    } catch (_) {}
                  }
                  if (matches) {
                    validOccEdges.push(candidateEdge);
                  } else {
                    safeDelete(candidateEdge);
                  }
                } else {
                  safeDelete(candidateEdge);
                }
                edgeExp.Next();
              }
              safeDelete(edgeExp);
            }

            if (validOccEdges.length === 0) {
              throw new Error('No valid edges found for Chamfer preview');
            }

            previewMaker = typeof occ.BRepFilletAPI_MakeChamfer_1 === 'function'
              ? new occ.BRepFilletAPI_MakeChamfer_1(tempSolid)
              : new occ.BRepFilletAPI_MakeChamfer(tempSolid);

            for (const edge of validOccEdges) {
              if (typeof previewMaker.Add_2 === 'function') {
                previewMaker.Add_2(distance, edge);
              } else {
                previewMaker.Add(distance, edge);
              }
            }

            previewMaker.Build();
            if (!previewMaker.IsDone()) {
              throw new Error(`Chamfer preview failed to build with distance ${distance}`);
            }

            const chamferedShape = previewMaker.Shape();
            safeDelete(tempSolid);
            tempSolid = chamferedShape;
          } else if (op.type === 'SHELL_3D') {
            const rawThickness =
              typeof op.shell3D?.thickness === 'number' && !isNaN(op.shell3D.thickness)
                ? Math.max(0.1, op.shell3D.thickness)
                : 1.5;
            const isInside = op.shell3D?.direction !== 'outside';
            const offset = isInside ? -Math.abs(rawThickness) : Math.abs(rawThickness);

            const removedFaceRefs = op.shell3D?.removedFaceRefs || [];
            const faceIndices = op.shell3D?.faceIndices || [];
            const topologyMap = extractTopologyMap(
              tempSolid,
              occ,
              'preview-base',
              'main-body',
              0
            );

            const validOccFaces: any[] = [];
            for (const ref of removedFaceRefs) {
              const targetRef = (ref as any)?.topoRef || ref;
              if (targetRef) {
                const res = resolveTopoReferenceToOCC(targetRef, topologyMap, occ, tempSolid);
                if (
                  res.status === 'resolved' &&
                  res.occShape &&
                  (typeof res.occShape.IsNull !== 'function' || !res.occShape.IsNull())
                ) {
                  validOccFaces.push(res.occShape);
                }
              }
            }

            // 索引 Fallback 機制（當依據 Topology Reference 解析失敗時，退回使用面索引從 topologyMap 提面）
            if (validOccFaces.length === 0 && faceIndices.length > 0) {
              for (const idx of faceIndices) {
                if (idx >= 0 && idx < topologyMap.faces.length) {
                  const fallbackRef = topologyMap.faces[idx];
                  const res = resolveTopoReferenceToOCC(fallbackRef, topologyMap, occ, tempSolid);
                  if (
                    res.status === 'resolved' &&
                    res.occShape &&
                    (typeof res.occShape.IsNull !== 'function' || !res.occShape.IsNull())
                  ) {
                    validOccFaces.push(res.occShape);
                  }
                }
              }
            }

            // 防呆判斷：若仍無有效開口面，直接拋出例外，避免產生看似沒開口的全封閉空心網格
            if (validOccFaces.length === 0) {
              throw new Error('薄殼預覽尚未解析出有效的開口面 (Shell preview requires resolved open face)');
            }

            const closingFaces = new occ.TopTools_ListOfShape_1();
            for (const face of validOccFaces) {
              if (typeof closingFaces.Append_1 === 'function') {
                closingFaces.Append_1(face);
              } else {
                closingFaces.Append(face);
              }
            }

            let hollow: any = null;
            try {
              if (typeof occ.BRepOffsetAPI_MakeThickSolid_ByJoin === 'function') {
                hollow = new occ.BRepOffsetAPI_MakeThickSolid_ByJoin(
                  tempSolid,
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
                  tempSolid,
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
                  tempSolid,
                  closingFaces,
                  offset,
                  1e-4
                );
              } else {
                hollow = new occ.BRepOffsetAPI_MakeThickSolid();
                if (typeof hollow.MakeThickSolidByJoin === 'function') {
                  hollow.MakeThickSolidByJoin(
                    tempSolid,
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
                  const shelledShape = hollow.Shape();
                  safeDelete(tempSolid);
                  tempSolid = shelledShape;
                } else {
                  throw new Error(`Shell preview failed to build thick solid with thickness ${rawThickness}`);
                }
              } else {
                throw new Error('Shell preview API not available in OpenCASCADE environment');
              }
            } finally {
              for (const face of validOccFaces) {
                safeDelete(face);
              }
              safeDelete(closingFaces);
              safeDelete(hollow);
            }
          } else {
            throw new Error(`Unsupported preview operation type: ${op.type}`);
          }

          const meshData = tessellateSolid(tempSolid, occ);

          const vClone = meshData.vertices.slice();
          const nClone = meshData.normals.slice();
          const iClone = meshData.indices.slice();
          const eClone = meshData.edgeVertices ? meshData.edgeVertices.slice() : undefined;

          const safeMeshData: MeshResult = {
            ...meshData,
            vertices: vClone,
            normals: nClone,
            indices: iClone,
            edgeVertices: eClone,
            edges: eClone,
          };

          const transferBuffers: Transferable[] = [vClone.buffer, nClone.buffer, iClone.buffer];
          if (eClone) transferBuffers.push(eClone.buffer);

          _self.postMessage(
            {
              taskId: req.taskId,
              type: req.type,
              success: true,
              data: safeMeshData,
            } as SolidTaskResponse,
            transferBuffers
          );
        } catch (previewErr: any) {
          _self.postMessage({
            taskId: req.taskId,
            type: req.type,
            success: false,
            error: previewErr?.message || String(previewErr),
          } as SolidTaskResponse);
        } finally {
          for (const e of validOccEdges) {
            safeDelete(e);
          }
          safeDelete(previewMaker);
          safeDelete(tempSolid);
        }
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
            stepContent = occ.FS.readFile(fileName.replace(/^\//, ''));
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