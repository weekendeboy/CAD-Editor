import { Point2D, ArcEntity, CircleEntity } from '../../types/cad';
import { isAngleOnArc } from './IntersectionEngine';

/**
 * 圓弧角度區間限定介面
 */
export interface ArcSweepLimits {
  startAngle: number;
  endAngle: number;
}

/**
 * 公切線段資料結構
 */
export interface TangentSegment {
  p1: Point2D;
  p2: Point2D;
}

/**
 * 二維幾何點與點之間距離平方
 */
function distanceSq(p1: Point2D, p2: Point2D): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return dx * dx + dy * dy;
}

/**
 * 消除重複公切線段輔助函式
 */
function deduplicateTangentSegments(
  segments: TangentSegment[],
  tolerance: number = 1e-6
): TangentSegment[] {
  const result: TangentSegment[] = [];
  for (const seg of segments) {
    let duplicate = false;
    for (const existing of result) {
      const d1 = distanceSq(seg.p1, existing.p1);
      const d2 = distanceSq(seg.p2, existing.p2);
      if (d1 < tolerance * tolerance && d2 < tolerance * tolerance) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      result.push(seg);
    }
  }
  return result;
}

/**
 * 檢查點相對於圓心的角度是否落在指定圓弧角度範圍內
 */
export function isTangentPointOnArc(
  point: Point2D,
  center: Point2D,
  arcLimits: ArcSweepLimits,
  tolerance: number = 1e-5
): boolean {
  const theta = Math.atan2(point.y - center.y, point.x - center.x);
  return isAngleOnArc(theta, arcLimits.startAngle, arcLimits.endAngle, tolerance);
}

/**
 * 精確計算兩圓 (c1, r1) 與 (c2, r2) 的所有候選公切線段 (最多 4 條)
 * 可選擇性傳入 arc1Limits / arc2Limits 來過濾落在圓弧範圍外的切點
 *
 * @param c1 第一個圓 (或圓弧) 的圓心
 * @param r1 第一個圓 (或圓弧) 的半徑
 * @param c2 第二個圓 (或圓弧) 的圓心
 * @param r2 第二個圓 (或圓弧) 的半徑
 * @param arc1Limits 第一個圓弧角度邊界 (選填)
 * @param arc2Limits 第二個圓弧角度邊界 (選填)
 * @returns 候選公切線段陣列 [{ p1, p2 }, ...]
 */
export function calculateCircleCircleTangents(
  c1: Point2D,
  r1: number,
  c2: Point2D,
  r2: number,
  arc1Limits?: ArcSweepLimits,
  arc2Limits?: ArcSweepLimits
): TangentSegment[] {
  if (r1 <= 0 || r2 <= 0) {
    return [];
  }

  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const D = Math.hypot(dx, dy);

  // 圓心重合 (Concentric circles)
  if (D < 1e-9) {
    return [];
  }

  // 兩圓連心線基準方位角 theta
  const theta = Math.atan2(dy, dx);
  const candidates: TangentSegment[] = [];

  // 1. 計算外公切線 (External Tangents)
  // 存在條件：D >= |r1 - r2|
  const diffR = r1 - r2;
  if (D >= Math.abs(diffR) - 1e-9) {
    // 夾角 alpha = acos((r1 - r2) / D)
    const cosAlpha = Math.max(-1, Math.min(1, diffR / D));
    const alpha = Math.acos(cosAlpha);

    // 外公切線 1: Normal angle = theta + alpha
    const angleExt1 = theta + alpha;
    const p1_ext1: Point2D = {
      x: c1.x + r1 * Math.cos(angleExt1),
      y: c1.y + r1 * Math.sin(angleExt1),
    };
    const p2_ext1: Point2D = {
      x: c2.x + r2 * Math.cos(angleExt1),
      y: c2.y + r2 * Math.sin(angleExt1),
    };
    candidates.push({ p1: p1_ext1, p2: p2_ext1 });

    // 外公切線 2: Normal angle = theta - alpha
    const angleExt2 = theta - alpha;
    const p1_ext2: Point2D = {
      x: c1.x + r1 * Math.cos(angleExt2),
      y: c1.y + r1 * Math.sin(angleExt2),
    };
    const p2_ext2: Point2D = {
      x: c2.x + r2 * Math.cos(angleExt2),
      y: c2.y + r2 * Math.sin(angleExt2),
    };
    candidates.push({ p1: p1_ext2, p2: p2_ext2 });
  }

  // 2. 計算內公切線 (Internal Tangents)
  // 存在條件：當兩圓不相交 / 外離時 (D >= r1 + r2)
  const sumR = r1 + r2;
  if (D >= sumR - 1e-9) {
    // 夾角 beta = acos((r1 + r2) / D)
    const cosBeta = Math.max(-1, Math.min(1, sumR / D));
    const beta = Math.acos(cosBeta);

    // 內公切線 1: Angle = theta + beta
    // 內公切線跨越連心線，第二個圓切點方位角相差 180 度 (-r2)
    const angleInt1 = theta + beta;
    const p1_int1: Point2D = {
      x: c1.x + r1 * Math.cos(angleInt1),
      y: c1.y + r1 * Math.sin(angleInt1),
    };
    const p2_int1: Point2D = {
      x: c2.x - r2 * Math.cos(angleInt1),
      y: c2.y - r2 * Math.sin(angleInt1),
    };
    candidates.push({ p1: p1_int1, p2: p2_int1 });

    // 內公切線 2: Angle = theta - beta
    const angleInt2 = theta - beta;
    const p1_int2: Point2D = {
      x: c1.x + r1 * Math.cos(angleInt2),
      y: c1.y + r1 * Math.sin(angleInt2),
    };
    const p2_int2: Point2D = {
      x: c2.x - r2 * Math.cos(angleInt2),
      y: c2.y - r2 * Math.sin(angleInt2),
    };
    candidates.push({ p1: p1_int2, p2: p2_int2 });
  }

  // 3. 去重並過濾邊界 (圓弧區間檢驗)
  const uniqueCandidates = deduplicateTangentSegments(candidates);

  return uniqueCandidates.filter((seg) => {
    if (arc1Limits && !isTangentPointOnArc(seg.p1, c1, arc1Limits)) {
      return false;
    }
    if (arc2Limits && !isTangentPointOnArc(seg.p2, c2, arc2Limits)) {
      return false;
    }
    return true;
  });
}

/**
 * 依據點選位置 (pickPt1, pickPt2)，從所有候選公切線中選取距離平方和最小的最佳幾何匹配切線
 *
 * @param c1 第一個圓圓心
 * @param r1 第一個圓半徑
 * @param c2 第二個圓圓心
 * @param r2 第二個圓半徑
 * @param pickPt1 第一點點擊位置 (Deferred Tangent Pick Point 1)
 * @param pickPt2 第二點點擊位置 (Deferred Tangent Pick Point 2)
 * @param arc1Limits 第一個圓弧區間限制 (選填)
 * @param arc2Limits 第二個圓弧區間限制 (選填)
 * @returns 最佳適配公切線段 { p1, p2 }，若無有效切線則回傳 null
 */
export function findBestTangentSegment(
  c1: Point2D,
  r1: number,
  c2: Point2D,
  r2: number,
  pickPt1: Point2D,
  pickPt2: Point2D,
  arc1Limits?: ArcSweepLimits,
  arc2Limits?: ArcSweepLimits
): TangentSegment | null {
  const candidates = calculateCircleCircleTangents(
    c1,
    r1,
    c2,
    r2,
    arc1Limits,
    arc2Limits
  );

  if (candidates.length === 0) {
    return null;
  }

  let bestSegment: TangentSegment | null = null;
  let minCostSq = Infinity;

  for (const seg of candidates) {
    const costSq = distanceSq(seg.p1, pickPt1) + distanceSq(seg.p2, pickPt2);
    if (costSq < minCostSq) {
      minCostSq = costSq;
      bestSegment = seg;
    }
  }

  return bestSegment;
}

/**
 * 支援 CircleEntity 及 ArcEntity 圖元的通用雙圖元公切線求解器
 */
export function calculateEntityEntityTangents(
  e1: CircleEntity | ArcEntity,
  e2: CircleEntity | ArcEntity
): TangentSegment[] {
  const arc1Limits: ArcSweepLimits | undefined =
    e1.type === 'arc'
      ? { startAngle: e1.startAngle, endAngle: e1.endAngle }
      : undefined;
  const arc2Limits: ArcSweepLimits | undefined =
    e2.type === 'arc'
      ? { startAngle: e2.startAngle, endAngle: e2.endAngle }
      : undefined;

  return calculateCircleCircleTangents(
    e1.center,
    e1.radius,
    e2.center,
    e2.radius,
    arc1Limits,
    arc2Limits
  );
}

/**
 * 支援 CircleEntity 及 ArcEntity 圖元的通用公切線最佳匹配選取器
 */
export function findBestEntityTangentSegment(
  e1: CircleEntity | ArcEntity,
  e2: CircleEntity | ArcEntity,
  pickPt1: Point2D,
  pickPt2: Point2D
): TangentSegment | null {
  const arc1Limits: ArcSweepLimits | undefined =
    e1.type === 'arc'
      ? { startAngle: e1.startAngle, endAngle: e1.endAngle }
      : undefined;
  const arc2Limits: ArcSweepLimits | undefined =
    e2.type === 'arc'
      ? { startAngle: e2.startAngle, endAngle: e2.endAngle }
      : undefined;

  return findBestTangentSegment(
    e1.center,
    e1.radius,
    e2.center,
    e2.radius,
    pickPt1,
    pickPt2,
    arc1Limits,
    arc2Limits
  );
}

/**
 * 外部點對圓的切點求解函式 (Point-to-Circle Tangent)
 *
 * @param point 游標點 / 外部點 P
 * @param center 圓心 C
 * @param radius 圓半徑
 * @param arcLimits 圓弧角度區間限制 (選填)
 * @returns 落在圓周上的切點座標陣列 [T1, T2] 或空陣列 []
 */
export function calculatePointCircleTangents(
  point: Point2D,
  center: Point2D,
  radius: number,
  arcLimits?: ArcSweepLimits
): Point2D[] {
  if (radius <= 0) {
    return [];
  }

  // 1. 計算游標點 P 與圓心 C 的距離 d = hypot(P.x - C.x, P.y - C.y)
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const d = Math.hypot(dx, dy);

  // 2. 若 d < radius（游標在圓內部），切線無實數解，回傳空陣列 []
  if (d < radius - 1e-9) {
    return [];
  }

  // 3. 切線長度 L = Math.sqrt(Math.max(0, d * d - radius * radius))
  // (備用幾何長度純運算)
  const L = Math.sqrt(Math.max(0, d * d - radius * radius));
  void L;

  // 4. 連心線角度 alpha = Math.atan2(P.y - C.y, P.x - C.x)
  const alpha = Math.atan2(dy, dx);

  // 5. 半頂角 theta = Math.asin(Math.min(1, radius / d))
  const theta = Math.asin(Math.min(1, radius / d));

  // 6. 兩個切點在圓上的極角分別為 alpha + Math.PI/2 - theta 與 alpha - Math.PI/2 + theta
  const angle1 = alpha + Math.PI / 2 - theta;
  const angle2 = alpha - Math.PI / 2 + theta;

  // 7. 精確推導出落在圓周上的 2 個切點座標 (T1, T2)
  const t1: Point2D = {
    x: center.x + radius * Math.cos(angle1),
    y: center.y + radius * Math.sin(angle1),
  };
  const t2: Point2D = {
    x: center.x + radius * Math.cos(angle2),
    y: center.y + radius * Math.sin(angle2),
  };

  const candidates = [t1, t2];

  if (!arcLimits) {
    return candidates;
  }

  return candidates.filter((pt) => isTangentPointOnArc(pt, center, arcLimits));
}

/**
 * 外部點對圓弧的切點求解函式 (Point-to-Arc Tangent)
 *
 * @param point 外部點 P
 * @param center 圓心 C
 * @param radius 圓弧半徑
 * @param startAngle 圓弧起始角度 (弧度)
 * @param endAngle 圓弧終止角度 (弧度)
 * @returns 落在圓弧範圍內的切點座標陣列
 */
export function calculatePointArcTangents(
  point: Point2D,
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number
): Point2D[] {
  // 1. 先以 calculatePointCircleTangents 取得候選切點
  const candidates = calculatePointCircleTangents(point, center, radius);

  // 2. 檢驗每個切點相對於圓心的極角（atan2），驗證該角度是否落在圓弧的 startAngle 至 endAngle 逆時針有效角度區間內
  // 3. 只回傳落在圓弧範圍內的切點
  return candidates.filter((pt) => {
    const angle = Math.atan2(pt.y - center.y, pt.x - center.x);
    return isAngleOnArc(angle, startAngle, endAngle);
  });
}

/**
 * 最佳切點挑選函式 (Get Best Tangent Point)
 *
 * @param point 外部點 P (例如游標點)
 * @param center 圓心 C
 * @param radius 圓或圓弧半徑
 * @param hintPoint 最初鎖點/點擊位置
 * @param startAngle 圓弧起始角度 (選填)
 * @param endAngle 圓弧終止角度 (選填)
 * @returns 距離 hintPoint 最近的切點，若無切點則回傳 null
 */
export function getBestTangentPoint(
  point: Point2D,
  center: Point2D,
  radius: number,
  hintPoint: Point2D,
  startAngle?: number,
  endAngle?: number
): Point2D | null {
  let candidates: Point2D[] = [];

  if (startAngle !== undefined && endAngle !== undefined) {
    candidates = calculatePointArcTangents(point, center, radius, startAngle, endAngle);
  } else {
    candidates = calculatePointCircleTangents(point, center, radius);
  }

  if (candidates.length === 0) {
    return null;
  }

  // 比對候選切點與最初鎖點/點擊位置 hintPoint 的距離，回傳距離最近的切點
  let bestPoint: Point2D | null = null;
  let minDistanceSq = Infinity;

  for (const pt of candidates) {
    const dSq = distanceSq(pt, hintPoint);
    if (dSq < minDistanceSq) {
      minDistanceSq = dSq;
      bestPoint = pt;
    }
  }

  return bestPoint;
}

/**
 * 依據預選點 pickPt（點選圓時的位置），從點到圓的切點中選出最佳切點 T
 */
export function findBestPointCircleTangent(
  p: Point2D,
  center: Point2D,
  radius: number,
  pickPt?: Point2D,
  arcLimits?: ArcSweepLimits
): Point2D | null {
  const tangents = calculatePointCircleTangents(p, center, radius, arcLimits);
  if (tangents.length === 0) return null;
  if (!pickPt || tangents.length === 1) return tangents[0];

  const d1Sq = distanceSq(tangents[0], pickPt);
  const d2Sq = distanceSq(tangents[1], pickPt);
  return d1Sq <= d2Sq ? tangents[0] : tangents[1];
}
