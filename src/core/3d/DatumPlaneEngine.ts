import { Point2D, Point3D, CustomPlane } from '../../types/cad';

/**
 * 3D 空間向量輔助型別與計算函數
 */
export type Vector3D = Point3D;

/**
 * 向量加法: v1 + v2
 */
export function add3D(v1: Point3D, v2: Point3D): Point3D {
  return {
    x: v1.x + v2.x,
    y: v1.y + v2.y,
    z: v1.z + v2.z,
  };
}

/**
 * 向量減法: v1 - v2
 */
export function sub3D(v1: Point3D, v2: Point3D): Point3D {
  return {
    x: v1.x - v2.x,
    y: v1.y - v2.y,
    z: v1.z - v2.z,
  };
}

/**
 * 向量數乘: s * v
 */
export function scale3D(v: Point3D, s: number): Point3D {
  return {
    x: v.x * s,
    y: v.y * s,
    z: v.z * s,
  };
}

/**
 * 向量點積 (Dot Product): v1 · v2
 */
export function dot3D(v1: Point3D, v2: Point3D): number {
  return v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
}

/**
 * 向量外積 (Cross Product): v1 × v2 (遵循右手定則)
 */
export function cross3D(v1: Point3D, v2: Point3D): Point3D {
  return {
    x: v1.y * v2.z - v1.z * v2.y,
    y: v1.z * v2.x - v1.x * v2.z,
    z: v1.x * v2.y - v1.y * v2.x,
  };
}

/**
 * 向量模長 (Length / Norm): ||v||
 */
export function length3D(v: Point3D): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/**
 * 單位化向量 (Normalize): v / ||v||
 */
export function normalize3D(v: Point3D): Point3D {
  const len = length3D(v);
  if (len < 1e-12) {
    return { x: 0, y: 0, z: 0 };
  }
  return {
    x: v.x / len,
    y: v.y / len,
    z: v.z / len,
  };
}

/**
 * 羅德里格旋轉公式 (Rodrigues' Rotation Formula):
 * 將向量 v 繞著單位旋轉軸 k 旋轉 θ (angleRad) 弧度
 * v_rot = v * cos(θ) + (k × v) * sin(θ) + k * (k · v) * (1 - cos(θ))
 */
export function rodriguesRotate(v: Point3D, kUnit: Point3D, angleRad: number): Point3D {
  const cosTheta = Math.cos(angleRad);
  const sinTheta = Math.sin(angleRad);

  const term1 = scale3D(v, cosTheta);
  const term2 = scale3D(cross3D(kUnit, v), sinTheta);
  const kDotV = dot3D(kUnit, v);
  const term3 = scale3D(kUnit, kDotV * (1 - cosTheta));

  return add3D(add3D(term1, term2), term3);
}

// ============================================================================
// 三大預設標準基準面 (Default Primary Planes)
// ============================================================================

/**
 * 前基準面 Front Plane (XY 平面)
 * Normal: (0, 0, 1), xAxis: (1, 0, 0), yAxis: (0, 1, 0)
 */
export const FRONT_PLANE: CustomPlane = {
  id: 'datum-front',
  name: 'Front Plane (XY)',
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
};

/**
 * 上基準面 Top Plane (XZ 平面)
 * Normal: (0, 1, 0), xAxis: (1, 0, 0), yAxis: (0, 0, -1)
 * 滿足 X × Y = Normal 右手定則: (1,0,0) × (0,0,-1) = (0, 1, 0)
 */
export const TOP_PLANE: CustomPlane = {
  id: 'datum-top',
  name: 'Top Plane (XZ)',
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 1, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 0, z: -1 },
};

/**
 * 右基準面 Right Plane (YZ 平面)
 * Normal: (1, 0, 0), xAxis: (0, 0, -1), yAxis: (0, 1, 0)
 * 滿足 X × Y = Normal 右手定則: (0,0,-1) × (0,1,0) = (1, 0, 0)
 */
export const RIGHT_PLANE: CustomPlane = {
  id: 'datum-right',
  name: 'Right Plane (YZ)',
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 1, y: 0, z: 0 },
  xAxis: { x: 0, y: 0, z: -1 },
  yAxis: { x: 0, y: 1, z: 0 },
};

// ============================================================================
// 基準面核心演算法
// ============================================================================

/**
 * 格拉姆-施密特正交化 (Gram-Schmidt Orthogonalization)
 * 修正並正規化 CustomPlane 的正交基底 (Normal, xAxis, yAxis)
 * 1. 確保 normal 為單位向量: N = N / ||N||
 * 2. 確保 xAxis 與 normal 垂直並為單位向量: X = X - (X · N)N, X = X / ||X||
 * 3. 根據右手定則重算 yAxis: Y = N × X
 */
export function orthogonalizePlane(plane: CustomPlane): CustomPlane {
  // 1. 正規化 Normal 向量
  let N = normalize3D(plane.normal);
  if (length3D(N) < 1e-12) {
    N = { x: 0, y: 0, z: 1 }; // 退化保護預設值
  }

  // 2. 將 xAxis 投影至垂直於 Normal 的子空間並正規化
  let X_proj = sub3D(plane.xAxis, scale3D(N, dot3D(plane.xAxis, N)));
  let lenX = length3D(X_proj);

  // 若 xAxis 與 Normal 平行導致退化，選擇替代獨立向量作為候選
  if (lenX < 1e-12) {
    const candidate = Math.abs(N.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    X_proj = sub3D(candidate, scale3D(N, dot3D(candidate, N)));
    lenX = length3D(X_proj);
  }

  const X = normalize3D(X_proj);

  // 3. 根據右手定則重算 yAxis: Y = N × X
  const Y = cross3D(N, X);

  return {
    ...plane,
    normal: N,
    xAxis: X,
    yAxis: Y,
  };
}

/**
 * 偏移基準面計算 (Offset Plane)
 * 新原點: O_new = O_ref + offsetDistance * N_ref
 * 姿勢向量 N, X, Y 保持與參照面相同
 */
export function createOffsetPlane(
  refPlane: CustomPlane,
  offsetDistance: number,
  name?: string,
  id?: string
): CustomPlane {
  const normRef = normalize3D(refPlane.normal);
  const newOrigin = add3D(refPlane.origin, scale3D(normRef, offsetDistance));

  const planeId = id || `plane-offset-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const planeName = name || `${refPlane.name} Offset (${offsetDistance >= 0 ? '+' : ''}${offsetDistance}mm)`;

  const rawPlane: CustomPlane = {
    id: planeId,
    name: planeName,
    origin: newOrigin,
    normal: { ...refPlane.normal },
    xAxis: { ...refPlane.xAxis },
    yAxis: { ...refPlane.yAxis },
    parentFeatureId: refPlane.parentFeatureId,
  };

  return orthogonalizePlane(rawPlane);
}

/**
 * 角度基準面計算 (Angled Plane / 繞軸旋轉)
 * 使用羅德里格旋轉公式 (Rodrigues' Rotation Formula)，
 * 將參照面的 Normal, xAxis, yAxis 及原點繞指定軸線 (axisOrigin, axisDirection) 旋轉 angleRad。
 * 套用正交化處理後回傳全新 CustomPlane。
 */
export function createAngledPlane(
  refPlane: CustomPlane,
  axisOrigin: Point3D,
  axisDirection: Point3D,
  angleRad: number,
  name?: string,
  id?: string
): CustomPlane {
  const kUnit = normalize3D(axisDirection);

  // 若旋轉軸無效，回傳副本
  if (length3D(kUnit) < 1e-12) {
    return orthogonalizePlane({ ...refPlane });
  }

  // 旋轉方向姿態向量
  const newNormal = rodriguesRotate(refPlane.normal, kUnit, angleRad);
  const newXAxis = rodriguesRotate(refPlane.xAxis, kUnit, angleRad);
  const newYAxis = rodriguesRotate(refPlane.yAxis, kUnit, angleRad);

  // 旋轉原點向量 (繞軸點 axisOrigin 旋轉)
  const vecFromAxis = sub3D(refPlane.origin, axisOrigin);
  const rotatedVecFromAxis = rodriguesRotate(vecFromAxis, kUnit, angleRad);
  const newOrigin = add3D(axisOrigin, rotatedVecFromAxis);

  const angleDeg = ((angleRad * 180) / Math.PI).toFixed(1);
  const planeId = id || `plane-angled-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const planeName = name || `${refPlane.name} Angled (${angleDeg}°)`;

  const rawPlane: CustomPlane = {
    id: planeId,
    name: planeName,
    origin: newOrigin,
    normal: newNormal,
    xAxis: newXAxis,
    yAxis: newYAxis,
    parentFeatureId: refPlane.parentFeatureId,
  };

  return orthogonalizePlane(rawPlane);
}

/**
 * 三點建基準面 (Three-Point Plane)
 * 由不共線的三點 P1, P2, P3 建立 CustomPlane
 * P1 作為原點, P1->P2 作為 xAxis, (P1->P2) × (P1->P3) 作為 Normal
 */
export function createThreePointPlane(
  p1: Point3D,
  p2: Point3D,
  p3: Point3D,
  name?: string,
  id?: string
): CustomPlane {
  const v12 = sub3D(p2, p1);
  const v13 = sub3D(p3, p1);

  const xAxis = normalize3D(v12);
  const normal = normalize3D(cross3D(v12, v13));

  const planeId = id || `plane-3pt-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const planeName = name || 'Three-Point Plane';

  const rawPlane: CustomPlane = {
    id: planeId,
    name: planeName,
    origin: { ...p1 },
    normal,
    xAxis,
    yAxis: cross3D(normal, xAxis),
  };

  return orthogonalizePlane(rawPlane);
}

// ============================================================================
// 座標投影純函數 (2D LCS <-> 3D WCS)
// ============================================================================

/**
 * 3D 世界座標投影至 2D 平面局部座標 (3D WCS -> 2D LCS)
 * V = P_3D - O_plane
 * u = V · X_plane
 * v = V · Y_plane
 */
export function project3DTo2DPlane(p3d: Point3D, plane: CustomPlane): Point2D {
  const V = sub3D(p3d, plane.origin);
  const u = dot3D(V, plane.xAxis);
  const v = dot3D(V, plane.yAxis);
  return { x: u, y: v };
}

/**
 * 2D 平面局部座標映射至 3D 世界座標 (2D LCS -> 3D WCS)
 * P_3D = O_plane + p2d.x * X_plane + p2d.y * Y_plane
 */
export function map2DTo3DWorld(p2d: Point2D, plane: CustomPlane): Point3D {
  const termX = scale3D(plane.xAxis, p2d.x);
  const termY = scale3D(plane.yAxis, p2d.y);
  return add3D(plane.origin, add3D(termX, termY));
}

/**
 * 計算 3D 點到基準面的垂直距離 (帶正負號: 正號表示在 Normal 方向一側)
 */
export function signedDistanceToPlane(p3d: Point3D, plane: CustomPlane): number {
  const V = sub3D(p3d, plane.origin);
  const norm = normalize3D(plane.normal);
  return dot3D(V, norm);
}

/**
 * 將 3D 點垂直投影到 3D 基準面上 (回傳 3D 投影點)
 */
export function projectPointOntoPlane3D(p3d: Point3D, plane: CustomPlane): Point3D {
  const dist = signedDistanceToPlane(p3d, plane);
  const norm = normalize3D(plane.normal);
  return sub3D(p3d, scale3D(norm, dist));
}

/**
 * 判斷兩基準面是否平行
 */
export function arePlanesParallel(planeA: CustomPlane, planeB: CustomPlane, tolerance = 1e-6): boolean {
  const normA = normalize3D(planeA.normal);
  const normB = normalize3D(planeB.normal);
  const cross = cross3D(normA, normB);
  return length3D(cross) < tolerance;
}

/**
 * 由實體表面法向推導正交基準面
 * 1. 確保法向量 normal 正規化
 * 2. 利用外積 (Cross Product) 與右手定則，推導出嚴格垂直的 xAxis 與 yAxis
 *    (若 normal 平行 Z 軸則參考 Y 軸，否則參考 Z 軸)
 */
export function createPlaneFromFaceNormal(origin: Point3D, normal: Point3D, name?: string): CustomPlane {
  let N = normalize3D(normal);
  if (length3D(N) < 1e-12) {
    N = { x: 0, y: 0, z: 1 };
  }

  // 若 normal 平行 Z 軸 (|N.z| > 0.9) 則參考 Y 軸，否則參考 Z 軸
  const refAxis: Point3D = Math.abs(N.z) > 0.9 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };

  // 外積推導 X 軸與 Y 軸 (遵循右手定則 X × Y = N)
  let X = cross3D(refAxis, N);
  if (length3D(X) < 1e-6) {
    X = cross3D({ x: 1, y: 0, z: 0 }, N);
  }
  X = normalize3D(X);

  const Y = normalize3D(cross3D(N, X));

  const planeId = `plane-face-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  return {
    id: planeId,
    name: name || 'Face Plane',
    origin: { ...origin },
    normal: N,
    xAxis: X,
    yAxis: Y,
  };
}
