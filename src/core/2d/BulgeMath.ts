import { Point2D, ArcEntity } from '../../types/cad';

export interface BulgeArcDefinition {
  center: Point2D;
  radius: number;
  startAngle: number; // 弧度 [0, 2π)
  endAngle: number;   // 弧度 [0, 2π)
  sweepAngle: number; // 包含角大小 (絕對值, 弧度)
  isClockwise: boolean;
}

/**
 * 將角度標準化至 [0, 2π) 區間
 * @param angle 待轉換的角度 (弧度)
 * @returns 標準化後位於 [0, 2π) 區間的角度
 */
export function normalizeAngle(angle: number): number {
  if (!Number.isFinite(angle)) {
    return 0;
  }
  let normalized = angle % (2 * Math.PI);
  if (normalized < 0) {
    normalized += 2 * Math.PI;
  }
  if (Math.abs(normalized - 2 * Math.PI) < 1e-12) {
    normalized = 0;
  }
  return normalized;
}

/**
 * 1. Bulge 轉圓弧幾何參數
 * @param p1 起點
 * @param p2 終點
 * @param bulge 凸度值 b = tan(θ / 4)
 * @param tolerance 浮點容差（預設 1e-8）
 * @returns 圓弧幾何定義；若退化為直線或點則回傳 null
 */
export function bulgeToArc(
  p1: Point2D,
  p2: Point2D,
  bulge: number,
  tolerance: number = 1e-8
): BulgeArcDefinition | null {
  // 數值有效性檢查
  if (
    !Number.isFinite(p1.x) ||
    !Number.isFinite(p1.y) ||
    !Number.isFinite(p2.x) ||
    !Number.isFinite(p2.y) ||
    !Number.isFinite(bulge)
  ) {
    return null;
  }

  // 凸度值過小代表退化為直線段
  if (Math.abs(bulge) < tolerance) {
    return null;
  }

  // 計算弦向量與弦長
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const d = Math.hypot(dx, dy);

  // 起終點重合或距離過小，無法構成幾何圓弧
  if (d < tolerance) {
    return null;
  }

  // 弦中點 M
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;

  // 弦左側垂直單位法向量 n = (-dy/d, dx/d)
  const nx = -dy / d;
  const ny = dx / d;

  // 圓心偏置距離：h = (d / 2) * ((1 - b^2) / (2 * b))
  const h = (d / 2) * ((1 - bulge * bulge) / (2 * bulge));

  // 圓心座標 C = M + h * n
  const cx = mx + h * nx;
  const cy = my + h * ny;
  const center: Point2D = { x: cx, y: cy };

  // 半徑 R = (d / 4) * (|b| + 1 / |b|)
  const absB = Math.abs(bulge);
  const radius = (d / 4) * (absB + 1 / absB);

  // 計算起訖點相對於圓心的角度，並正規化至 [0, 2π)
  const startAngle = normalizeAngle(Math.atan2(p1.y - cy, p1.x - cx));
  const endAngle = normalizeAngle(Math.atan2(p2.y - cy, p2.x - cx));

  // 包含角 (Sweep Angle) θ = 4 * atan(|b|)
  const sweepAngle = 4 * Math.atan(absB);
  const isClockwise = bulge < 0;

  return {
    center,
    radius,
    startAngle,
    endAngle,
    sweepAngle,
    isClockwise,
  };
}

/**
 * 2. Bulge 轉系統標準 ArcEntity 圖元
 * @param p1 起點
 * @param p2 終點
 * @param bulge 凸度值
 * @param entityProps 附加屬性（如 layerId, color, lineWidth 等）
 * @param tolerance 浮點容差
 */
export function bulgeToArcEntity(
  p1: Point2D,
  p2: Point2D,
  bulge: number,
  entityProps?: Partial<ArcEntity>,
  tolerance: number = 1e-8
): ArcEntity | null {
  const arcDef = bulgeToArc(p1, p2, bulge, tolerance);
  if (!arcDef) {
    return null;
  }

  const startAngle = arcDef.startAngle;
  const endAngle = arcDef.endAngle;
  const clockwise = arcDef.isClockwise;

  return {
    id: entityProps?.id || `arc-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    type: 'arc',
    layerId: entityProps?.layerId || 'layer-0',
    visible: entityProps?.visible ?? true,
    locked: entityProps?.locked ?? false,
    color: entityProps?.color,
    lineWidth: entityProps?.lineWidth,
    isConstruction: entityProps?.isConstruction,
    state: entityProps?.state || 'UnderDefined',
    center: arcDef.center,
    radius: arcDef.radius,
    startAngle,
    endAngle,
    clockwise,
  };
}

/**
 * 3. ArcEntity 轉 Bulge
 * 根據圓弧的起訖角度與方向計算包含角，並輸出凸度值 b = ±tan(θ / 4)
 */
export function arcToBulge(arc: ArcEntity): number {
  if (
    !arc ||
    !Number.isFinite(arc.startAngle) ||
    !Number.isFinite(arc.endAngle) ||
    !Number.isFinite(arc.radius) ||
    arc.radius <= 0
  ) {
    return 0;
  }

  const isCW = Boolean(arc.clockwise);
  const start = normalizeAngle(arc.startAngle);
  const end = normalizeAngle(arc.endAngle);

  let sweep = isCW ? start - end : end - start;
  while (sweep < 0) sweep += 2 * Math.PI;
  while (sweep >= 2 * Math.PI) sweep -= 2 * Math.PI;

  if (Math.abs(sweep) < 1e-12 || Math.abs(sweep - 2 * Math.PI) < 1e-12) {
    return 0;
  }

  const sign = isCW ? -1 : 1;
  return sign * Math.tan(sweep / 4);
}

/**
 * 4. 由兩端點與圓心推導 Bulge
 * @param p1 起點
 * @param p2 終點
 * @param center 圓心
 * @param isClockwise 是否為順時針
 */
export function endpointsToBulge(
  p1: Point2D,
  p2: Point2D,
  center: Point2D,
  isClockwise: boolean = false
): number {
  if (
    !Number.isFinite(p1.x) ||
    !Number.isFinite(p1.y) ||
    !Number.isFinite(p2.x) ||
    !Number.isFinite(p2.y) ||
    !Number.isFinite(center.x) ||
    !Number.isFinite(center.y)
  ) {
    return 0;
  }

  const r1 = Math.hypot(p1.x - center.x, p1.y - center.y);
  const r2 = Math.hypot(p2.x - center.x, p2.y - center.y);
  if (r1 < 1e-8 || r2 < 1e-8) {
    return 0;
  }

  const chordLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (chordLen < 1e-8) {
    return 0;
  }

  const a1 = normalizeAngle(Math.atan2(p1.y - center.y, p1.x - center.x));
  const a2 = normalizeAngle(Math.atan2(p2.y - center.y, p2.x - center.x));

  let sweep = 0;
  if (isClockwise) {
    sweep = a1 - a2;
    if (sweep < 0) {
      sweep += 2 * Math.PI;
    }
  } else {
    sweep = a2 - a1;
    if (sweep < 0) {
      sweep += 2 * Math.PI;
    }
  }

  if (Math.abs(sweep) < 1e-12 || Math.abs(sweep - 2 * Math.PI) < 1e-12) {
    return 0;
  }

  const bulge = Math.tan(sweep / 4);
  return isClockwise ? -bulge : bulge;
}

/**
 * 5. 雙向轉譯數值往返驗證（單元測試防護）
 * 檢驗 bulge -> arc -> bulge 的數值一致性
 */
export function verifyBulgeRoundTrip(
  p1: Point2D,
  p2: Point2D,
  bulge: number,
  tolerance: number = 1e-8
): boolean {
  if (
    !Number.isFinite(p1.x) ||
    !Number.isFinite(p1.y) ||
    !Number.isFinite(p2.x) ||
    !Number.isFinite(p2.y) ||
    !Number.isFinite(bulge)
  ) {
    return false;
  }

  if (Math.abs(bulge) < tolerance) {
    return true;
  }

  const arcDef = bulgeToArc(p1, p2, bulge, tolerance);
  if (!arcDef) {
    return false;
  }

  const recalculatedBulge = endpointsToBulge(
    p1,
    p2,
    arcDef.center,
    arcDef.isClockwise
  );

  return Math.abs(recalculatedBulge - bulge) <= tolerance;
}
