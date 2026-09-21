/**
 * ArcGeometryHelper.ts
 * 負責 3D 空間圓弧與曲線邊線之幾何取樣、真實曲線上點生成與 Fat Hitbox 區段計算
 */

import type { RuntimeBRepEdgeRef } from './MeshSubshapeMapping.types';

export interface Point3DCoord {
  x: number;
  y: number;
  z: number;
}

export interface ArcHitboxSegment {
  segmentIndex: number;
  start: Point3DCoord;
  end: Point3DCoord;
  mid: Point3DCoord;
  length: number;
  direction: Point3DCoord;
}

/** 向量模長 */
function length3D(v: Point3DCoord): number {
  return Math.hypot(v.x, v.y, v.z);
}

/** 向量相減 a - b */
function sub3D(a: Point3DCoord, b: Point3DCoord): Point3DCoord {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** 向量相加 a + b */
function add3D(a: Point3DCoord, b: Point3DCoord): Point3DCoord {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/** 向量數乘 v * s */
function scale3D(v: Point3DCoord, s: number): Point3DCoord {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

/** 向量內積 (Dot product) */
function dot3D(a: Point3DCoord, b: Point3DCoord): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** 向量外積 (Cross product) a × b */
function cross3D(a: Point3DCoord, b: Point3DCoord): Point3DCoord {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** 向量正規化 (單位向量) */
function normalize3D(v: Point3DCoord, fallback: Point3DCoord = { x: 0, y: 0, z: 1 }): Point3DCoord {
  const len = length3D(v);
  if (len < 1e-7) return fallback;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * 沿真實圓弧或曲線幾何取樣 N 段 (N+1 個 3D 點)
 * 所有取樣點嚴格座落在真實圓弧曲線上 (半徑恆等於 radius，且共面於 normal 定義的平面)
 */
export function sampleArcPoints(edge: RuntimeBRepEdgeRef, numSegments: number = 32): Point3DCoord[] {
  // 1. 若已有執行期取樣點，直接優先採用
  if (edge.sampledPoints && edge.sampledPoints.length >= 2) {
    return edge.sampledPoints;
  }

  const isCircleOrArc = edge.curveType === 'circle' || (edge.center !== undefined && edge.radius !== undefined);

  if (isCircleOrArc && edge.center && typeof edge.radius === 'number' && edge.radius > 1e-6) {
    const C = edge.center;
    const R = edge.radius;
    const N = normalize3D(edge.normal || { x: 0, y: 0, z: 1 });

    // 決定圓弧所在平面的第一基底向量 U (由圓心指向起點，若無起點則尋求垂直於法向的標準基底)
    let U: Point3DCoord;
    if (edge.startPoint) {
      const fromCenter = sub3D(edge.startPoint, C);
      U = normalize3D(fromCenter);
    } else {
      // 若 N 接近 Z 軸，U 取 X 軸方向 ( (0,1,0) × (0,0,1) = (1,0,0) )
      if (Math.abs(N.x) < 0.8 && Math.abs(N.y) < 0.8) {
        U = normalize3D(cross3D({ x: 0, y: 1, z: 0 }, N));
      } else {
        U = normalize3D(cross3D({ x: 0, y: 0, z: 1 }, N));
      }
    }

    // 決定圓弧所在平面的第二基底向量 V = N × U
    const V = normalize3D(cross3D(N, U));

    // 計算起點與終點角度
    let thetaStart = 0;
    let sweepAngle = 2 * Math.PI;

    if (edge.startAngle !== undefined && edge.endAngle !== undefined) {
      if (edge.startPoint) {
        // 若有明確 startPoint，已作為 U 軸，則從 0 掃動到 (endAngle - startAngle)
        thetaStart = 0;
        sweepAngle = edge.endAngle - edge.startAngle;
      } else {
        thetaStart = edge.startAngle;
        sweepAngle = edge.endAngle - edge.startAngle;
      }
    } else if (edge.endPoint) {
      const W = sub3D(edge.endPoint, C);
      const cosVal = dot3D(normalize3D(W), U);
      const sinVal = dot3D(normalize3D(W), V);
      let angle = Math.atan2(sinVal, cosVal);
      if (angle <= 1e-6) {
        angle += 2 * Math.PI;
      }
      sweepAngle = angle;
    }

    const segmentsCount = Math.max(8, Math.min(64, numSegments));
    const points: Point3DCoord[] = [];

    for (let i = 0; i <= segmentsCount; i++) {
      const t = i / segmentsCount;
      const theta = thetaStart + t * sweepAngle;
      // P = C + R * (cos(theta) * U + sin(theta) * V)
      const uComp = scale3D(U, R * Math.cos(theta));
      const vComp = scale3D(V, R * Math.sin(theta));
      let pt = add3D(C, add3D(uComp, vComp));

      // 若為起訖端點且有定義 startPoint / endPoint，做精準對齊保證連續性
      if (i === 0 && edge.startPoint) {
        pt = { ...edge.startPoint };
      } else if (i === segmentsCount && edge.endPoint) {
        pt = { ...edge.endPoint };
      }

      points.push({
        x: Math.round(pt.x * 10000) / 10000,
        y: Math.round(pt.y * 10000) / 10000,
        z: Math.round(pt.z * 10000) / 10000,
      });
    }

    return points;
  }

  // 2. 直線或無圓弧參數的普通邊線：回傳起點與終點
  if (edge.startPoint && edge.endPoint) {
    return [{ ...edge.startPoint }, { ...edge.endPoint }];
  }

  return [];
}

/**
 * 依據取樣點序列建立 Fat Hitbox 圓柱/膠囊段落
 * 相鄰兩點組成一段圓柱體，共同構成涵蓋整個圓弧的完整拾取體
 */
export function generateArcHitboxSegments(points: Point3DCoord[]): ArcHitboxSegment[] {
  const segments: ArcHitboxSegment[] = [];
  if (points.length < 2) return segments;

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const delta = sub3D(p2, p1);
    const len = length3D(delta);
    if (len < 1e-6) continue;

    const mid = scale3D(add3D(p1, p2), 0.5);
    const dir = normalize3D(delta);

    segments.push({
      segmentIndex: i,
      start: p1,
      end: p2,
      mid,
      length: len,
      direction: dir,
    });
  }

  return segments;
}

/**
 * 判斷空間點是否落在邊線 Hitbox 寬容範圍內 (可精準測試圓弧 Apex / 中間點)
 */
export function isPointNearEdge(
  point: Point3DCoord,
  edge: RuntimeBRepEdgeRef,
  tolerance: number = 6
): { isNear: boolean; minDistance: number; closestSegmentIndex: number } {
  const points = sampleArcPoints(edge, 32);
  if (points.length < 2) {
    return { isNear: false, minDistance: Infinity, closestSegmentIndex: -1 };
  }

  let minDistance = Infinity;
  let closestIndex = -1;

  for (let i = 0; i < points.length - 1; i++) {
    const s = points[i];
    const e = points[i + 1];
    const v = sub3D(e, s);
    const w = sub3D(point, s);

    const c1 = dot3D(w, v);
    const c2 = dot3D(v, v);

    let d: number;
    if (c1 <= 0) {
      d = length3D(sub3D(point, s));
    } else if (c2 <= c1) {
      d = length3D(sub3D(point, e));
    } else {
      const b = c1 / c2;
      const proj = add3D(s, scale3D(v, b));
      d = length3D(sub3D(point, proj));
    }

    if (d < minDistance) {
      minDistance = d;
      closestIndex = i;
    }
  }

  return {
    isNear: minDistance <= tolerance,
    minDistance,
    closestSegmentIndex: closestIndex,
  };
}
