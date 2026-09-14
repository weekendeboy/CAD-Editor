import { Point2D } from '../../types/cad';

export interface ProfileSegment {
  type: 'line' | 'arc';
  start: Point2D;
  end: Point2D;
  center?: Point2D;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  isLargeArc?: boolean;
  sweepFlag?: number;
}

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
  const A1 = p3.x - p1.x;
  const B1 = p3.y - p1.y;
  const C1 = (p3.x * p3.x - p1.x * p1.x + p3.y * p3.y - p1.y * p1.y) / 2;

  // 中垂線 2 (p3 與 p2)：
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

  const a1 = normalizeAngle(theta1);
  const a2 = normalizeAngle(theta2);
  const a3 = normalizeAngle(theta3);

  // 以 a1 為基準，計算逆時針掃掠至 a2 與 a3 的角位移
  const diff12 = normalizeAngle(a2 - a1);
  const diff13 = normalizeAngle(a3 - a1);

  // 若從 a1 逆時針方向掃到 a2 的過程中包含 a3，表示 p1 -> p3 -> p2 為逆時針 (CCW)
  const isCCW = diff13 > 0 && diff13 < diff12;

  let startAngle: number;
  let endAngle: number;

  if (isCCW) {
    startAngle = a1;
    endAngle = a2;
  } else {
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

/**
 * 角度正規化輔助函式至 [0, 2π)
 */
export function normalizeAngle(angle: number): number {
  let res = angle % (2 * Math.PI);
  if (res < 0) res += 2 * Math.PI;
  return res;
}

/**
 * 驗證角度 angle 是否落在 startAngle 與 endAngle 的掃掠區間內。
 */
export function isAngleInArcSweep(
  angle: number,
  startAngle: number,
  endAngle: number,
  isCW: boolean = false
): boolean {
  const eps = 1e-7;
  const a = normalizeAngle(angle);
  const sa = normalizeAngle(startAngle);
  const ea = normalizeAngle(endAngle);

  if (isCW) {
    let sweep = sa - ea;
    if (sweep <= eps) {
      sweep += 2 * Math.PI;
    }
    let diff = sa - a;
    if (diff < -eps) {
      diff += 2 * Math.PI;
    }
    return diff >= -eps && diff <= sweep + eps;
  } else {
    let sweep = ea - sa;
    if (sweep <= eps) {
      sweep += 2 * Math.PI;
    }
    let diff = a - sa;
    if (diff < -eps) {
      diff += 2 * Math.PI;
    }
    return diff >= -eps && diff <= sweep + eps;
  }
}

/**
 * 高精度射線求交點包含測試（Ray-Casting Point-in-Profile Loop Test）
 *
 * 從待測點發射水平向右射線 (y = point.y, x >= point.x)，檢驗其與封閉輪廓交點數之奇偶性。
 * - 針對直線段：半開半閉區間判定 (y1 <= point.y && point.y < y2) || (y2 <= point.y && point.y < y1)，避免頂點重複計數；計算交點 x 座標，大於 point.x 則計數 +1。
 * - 針對圓弧段 (ProfileSegment type='arc')：求 y = point.y 與圓的交點，驗證交點 x >= point.x，並利用 atan2 驗證該交點角度是否落在 startAngle 與 endAngle 的掃掠區間內。
 * - 若未提供 segments：自動退化為針對 loop 頂點的經典多邊形射線交叉法。
 * - 交點總數為奇數回傳 true，偶數回傳 false。加入 1e-7 浮點擾動防護。
 *
 * @param point 待測點 (2D LCS)
 * @param loop 輪廓多邊形頂點序列
 * @param segments 輪廓各段邊界幾何 (含 Line 與 Arc)
 * @returns boolean true 表示在輪廓內部，false 表示在外部
 */
export function isPointInsideProfileLoop(
  point: Point2D,
  loop: Point2D[],
  segments?: ProfileSegment[]
): boolean {
  const eps = 1e-7;
  const testX = point.x;
  let testY = point.y;

  // 1. 收集所有邊界頂點及圓弧極值點的 Y 座標，進行微小擾動檢驗，避免射線貼齊水平邊界或頂點奇異點
  const criticalY: number[] = [];
  if (segments && segments.length > 0) {
    for (const seg of segments) {
      criticalY.push(seg.start.y, seg.end.y);
      if (seg.type === 'arc' && seg.center && seg.radius !== undefined) {
        criticalY.push(seg.center.y, seg.center.y + seg.radius, seg.center.y - seg.radius);
      }
    }
  } else if (loop && loop.length > 0) {
    for (const pt of loop) {
      criticalY.push(pt.y);
    }
  }

  // 數值微小擾動檢驗 (1e-7 浮點奇異點防護)，避免射線貼齊水平邊界或頂點
  let perturbed = true;
  let attempts = 0;
  while (perturbed && attempts < 10) {
    perturbed = false;
    attempts++;
    for (const cy of criticalY) {
      if (Math.abs(cy - testY) < eps) {
        testY += 1.0000001e-5;
        perturbed = true;
        break;
      }
    }
  }

  let intersectionCount = 0;

  // 2. 當提供 segments 時，依據直線與圓弧 segment 類型分別計算水平向右射線交點
  if (segments && segments.length > 0) {
    for (const seg of segments) {
      if (seg.type === 'line') {
        const p1 = seg.start;
        const p2 = seg.end;

        // 直線段：半開半閉區間判定 (避免頂點重複計數)
        const crossesY = (p1.y <= testY && testY < p2.y) || (p2.y <= testY && testY < p1.y);
        if (crossesY) {
          const dy = p2.y - p1.y;
          if (Math.abs(dy) > eps) {
            const xInt = p1.x + ((testY - p1.y) / dy) * (p2.x - p1.x);
            if (xInt >= testX) {
              intersectionCount++;
            }
          }
        }
      } else if (seg.type === 'arc') {
        const { center, radius } = seg;

        if (center && radius !== undefined && radius > eps) {
          const dy = testY - center.y;

          // 若水平射線 y 與圓心距離小於半徑，求交點
          if (Math.abs(dy) < radius - eps) {
            const dx = Math.sqrt(Math.max(0, radius * radius - dy * dy));
            const x1 = center.x - dx;
            const x2 = center.x + dx;
            const candXList = [x1, x2];

            const sAngle = seg.startAngle !== undefined
              ? seg.startAngle
              : Math.atan2(seg.start.y - center.y, seg.start.x - center.x);
            const eAngle = seg.endAngle !== undefined
              ? seg.endAngle
              : Math.atan2(seg.end.y - center.y, seg.end.x - center.x);
            const isCW = seg.sweepFlag === 1;

            for (const candX of candXList) {
              if (candX >= testX) {
                const candAngle = Math.atan2(testY - center.y, candX - center.x);
                if (isAngleInArcSweep(candAngle, sAngle, eAngle, isCW)) {
                  intersectionCount++;
                }
              }
            }
          }
        } else {
          // 退化備用：若圓弧缺乏 center/radius，以端點直線計算
          const p1 = seg.start;
          const p2 = seg.end;
          const crossesY = (p1.y <= testY && testY < p2.y) || (p2.y <= testY && testY < p1.y);
          if (crossesY) {
            const dy = p2.y - p1.y;
            if (Math.abs(dy) > eps) {
              const xInt = p1.x + ((testY - p1.y) / dy) * (p2.x - p1.x);
              if (xInt >= testX) {
                intersectionCount++;
              }
            }
          }
        }
      }
    }

    return intersectionCount % 2 === 1;
  }

  // 3. 退化為多邊形：若 segments 未提供或為空，針對 loop 頂點做經典多邊形射線交叉法
  if (!loop || loop.length < 3) {
    return false;
  }

  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const p1 = loop[i];
    const p2 = loop[(i + 1) % n];

    const crossesY = (p1.y <= testY && testY < p2.y) || (p2.y <= testY && testY < p1.y);
    if (crossesY) {
      const dy = p2.y - p1.y;
      if (Math.abs(dy) > eps) {
        const xInt = p1.x + ((testY - p1.y) / dy) * (p2.x - p1.x);
        if (xInt >= testX) {
          intersectionCount++;
        }
      }
    }
  }

  return intersectionCount % 2 === 1;
}

/**
 * 計算正多邊形頂點序列 (Inscribed 內接於圓 / Circumscribed 外切於圓)
 *
 * @param center 多邊形中心點
 * @param cursorPt 游標定位點 (決定外接/內切半徑與基準旋轉角度)
 * @param sides 邊數 n (3 ~ 1024)
 * @param method 幾何方法 ('inscribed' | 'circumscribed')
 */
export function calculatePolygonVertices(
  center: Point2D,
  cursorPt: Point2D,
  sides: number,
  method: 'inscribed' | 'circumscribed'
): Point2D[] {
  const n = Math.max(3, Math.min(1024, Math.round(sides)));
  const dx = cursorPt.x - center.x;
  const dy = cursorPt.y - center.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-9) {
    return Array.from({ length: n }, () => ({ ...center }));
  }
  const theta0 = Math.atan2(dy, dx);
  const deltaTheta = (2 * Math.PI) / n;
  const points: Point2D[] = [];

  if (method === 'inscribed') {
    const R = dist;
    for (let k = 0; k < n; k++) {
      const theta = theta0 + k * deltaTheta;
      points.push({
        x: center.x + R * Math.cos(theta),
        y: center.y + R * Math.sin(theta),
      });
    }
  } else {
    // 外切於圓 (Circumscribed)
    const halfAngle = Math.PI / n;
    const R_prime = dist / Math.cos(halfAngle);
    for (let k = 0; k < n; k++) {
      const theta = theta0 + halfAngle + k * deltaTheta;
      points.push({
        x: center.x + R_prime * Math.cos(theta),
        y: center.y + R_prime * Math.sin(theta),
      });
    }
  }

  return points;
}

export interface Ray2D {
  origin: Point2D;
  angle: number; // 弧度
}

/**
 * 求解兩條射線的無限延伸交點
 *
 * @param ray1 第一條射線
 * @param ray2 第二條射線
 * @returns 交點座標 (Point2D) 或 null (若兩線平行/共線)
 */
export function calculateRayIntersection(ray1: Ray2D, ray2: Ray2D): Point2D | null {
  const v1 = { x: Math.cos(ray1.angle), y: Math.sin(ray1.angle) };
  const v2 = { x: Math.cos(ray2.angle), y: Math.sin(ray2.angle) };

  const det = v1.x * v2.y - v1.y * v2.x;

  if (Math.abs(det) < 1e-6) {
    return null;
  }

  const dx = ray2.origin.x - ray1.origin.x;
  const dy = ray2.origin.y - ray1.origin.y;

  const t1 = (dx * v2.y - dy * v2.x) / det;

  return {
    x: ray1.origin.x + t1 * v1.x,
    y: ray1.origin.y + t1 * v1.y,
  };
}

