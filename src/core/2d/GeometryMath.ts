import { Point2D } from '../../types/cad';

export interface Arc3PResult {
  center: Point2D;
  radius: number;
  startAngle: number;
  endAngle: number;
  isCCW?: boolean;
}

/**
 * 透過兩條中垂線交點精準求解外接圓心 (cx, cy) 與半徑 R。
 * 判定 p1 -> p3 -> p2 的旋轉方向，計算 CAD 逆時針標準的起始角與終止角。
 *
 * @param p1 圓弧起點 (Start point)
 * @param p2 圓弧終點 (End point)
 * @param p3 圓弧通過點 (Pass-through point on arc)
 */
export function calculate3PointArc(
  p1: Point2D,
  p2: Point2D,
  p3: Point2D
): { center: Point2D; radius: number; startAngle: number; endAngle: number } | null {
  // 1. 檢查點與點之間距離，避免重合點退化
  const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const d23 = Math.hypot(p3.x - p2.x, p3.y - p2.y);
  const d31 = Math.hypot(p1.x - p3.x, p1.y - p3.y);
  if (d12 < 1e-4 || d23 < 1e-4 || d31 < 1e-4) {
    return null;
  }

  // 2. 共線檢驗 (Collinearity check via 2D Cross Product)
  const cross = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
  if (Math.abs(cross) < 1e-7) {
    return null;
  }

  // 3. 兩條中垂線方程：
  // 中垂線 1 (p1 與 p3)：
  // 法向量為 (p3.x - p1.x, p3.y - p1.y)
  // 中點 M13 = ((p1.x + p3.x)/2, (p1.y + p3.y)/2)
  // 方程：(p3.x - p1.x) * x + (p3.y - p1.y) * y = (p3.x^2 - p1.x^2 + p3.y^2 - p1.y^2) / 2
  const A1 = p3.x - p1.x;
  const B1 = p3.y - p1.y;
  const C1 = (p3.x * p3.x - p1.x * p1.x + p3.y * p3.y - p1.y * p1.y) / 2;

  // 中垂線 2 (p3 與 p2)：
  // 法向量為 (p2.x - p3.x, p2.y - p3.y)
  // 中點 M32 = ((p3.x + p2.x)/2, (p3.y + p2.y)/2)
  // 方程：(p2.x - p3.x) * x + (p2.y - p3.y) * y = (p2.x^2 - p3.x^2 + p2.y^2 - p3.y^2) / 2
  const A2 = p2.x - p3.x;
  const B2 = p2.y - p3.y;
  const C2 = (p2.x * p2.x - p3.x * p3.x + p2.y * p2.y - p3.y * p3.y) / 2;

  // 行列式求解二元一次聯立方程式 (Cramer's Rule)
  const det = A1 * B2 - B1 * A2;
  if (Math.abs(det) < 1e-9) {
    return null;
  }

  const cx = (C1 * B2 - B1 * C2) / det;
  const cy = (A1 * C2 - C1 * A2) / det;
  const center: Point2D = { x: cx, y: cy };
  const radius = Math.hypot(p1.x - cx, p1.y - cy);

  if (radius < 1e-4) {
    return null;
  }

  // 4. 計算極角
  const theta1 = Math.atan2(p1.y - cy, p1.x - cx);
  const theta2 = Math.atan2(p2.y - cy, p2.x - cx);
  const theta3 = Math.atan2(p3.y - cy, p3.x - cx);

  // 正規化角度至 [0, 2π)
  const normalize = (angle: number): number => {
    let res = angle % (2 * Math.PI);
    if (res < 0) res += 2 * Math.PI;
    return res;
  };

  const a1 = normalize(theta1);
  const a2 = normalize(theta2);
  const a3 = normalize(theta3);

  // 以 a1 為基準，計算逆時針掃掠至 a2 與 a3 的角位移
  const diff12 = normalize(a2 - a1);
  const diff13 = normalize(a3 - a1);

  // 若從 a1 逆時針方向掃到 a2 的過程中包含 a3，表示 p1 -> p3 -> p2 為逆時針 (CCW)
  const isCCW = diff13 > 0 && diff13 < diff12;

  let startAngle: number;
  let endAngle: number;

  if (isCCW) {
    // 逆時針方向：起點為 p1，終點為 p2
    startAngle = a1;
    endAngle = a2;
  } else {
    // 順時針方向：在 CAD 標準逆時針規範中，由 p2 逆時針掃至 p1 通過 p3
    startAngle = a2;
    endAngle = a1;
  }

  return {
    center,
    radius,
    startAngle,
    endAngle,
  };
}
