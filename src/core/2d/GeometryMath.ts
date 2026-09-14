import { Point2D, ArcEntity, CADEntity2D, CircleEntity, LineEntity } from '../../types/cad';

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

/**
 * 求解無限長直線與圓的 0~2 個交點（幾何投影法與代數判定）。
 *
 * @param linePt 直線上的一點
 * @param lineDir 直線的方向向量 (dx, dy)
 * @param center 圓心座標
 * @param radius 圓半徑
 * @returns 交點座標陣列 (Point2D[])
 */
export function intersectLineAndCircle(
  linePt: Point2D,
  lineDir: Point2D,
  center: Point2D,
  radius: number
): Point2D[] {
  const dirLen = Math.hypot(lineDir.x, lineDir.y);
  if (dirLen < 1e-10 || radius < 1e-10) {
    return [];
  }

  // 單位方向向量
  const ux = lineDir.x / dirLen;
  const uy = lineDir.y / dirLen;

  // linePt 到圓心向量
  const wx = center.x - linePt.x;
  const wy = center.y - linePt.y;

  // 投影長度 tProj
  const tProj = wx * ux + wy * uy;
  const pClosest: Point2D = {
    x: linePt.x + tProj * ux,
    y: linePt.y + tProj * uy,
  };

  // 圓心至直線距離的平方
  const distSq =
    (pClosest.x - center.x) * (pClosest.x - center.x) +
    (pClosest.y - center.y) * (pClosest.y - center.y);
  const rSq = radius * radius;
  const eps = 1e-7;

  // 距離大於半徑：無交點
  if (distSq > rSq + eps) {
    return [];
  }

  // 切點（單一交點）
  if (Math.abs(distSq - rSq) <= eps) {
    return [pClosest];
  }

  // 割線（兩個交點）
  const h = Math.sqrt(Math.max(0, rSq - distSq));
  const p1: Point2D = {
    x: pClosest.x + h * ux,
    y: pClosest.y + h * uy,
  };
  const p2: Point2D = {
    x: pClosest.x - h * ux,
    y: pClosest.y - h * uy,
  };

  if (Math.hypot(p1.x - p2.x, p1.y - p2.y) < 1e-5) {
    return [pClosest];
  }

  return [p1, p2];
}

/**
 * 求解無限長直線與圓弧的交點。
 * 先求出與圓的交點，再利用 atan2 驗證交點是否落在圓弧的 startAngle 與 endAngle 的掃掠範圍內。
 *
 * @param linePt 直線上的一點
 * @param lineDir 直線的方向向量 (dx, dy)
 * @param arc 圓弧實體 (ArcEntity)
 * @returns 交點座標陣列 (Point2D[])
 */
export function intersectLineAndArc(
  linePt: Point2D,
  lineDir: Point2D,
  arc: ArcEntity
): Point2D[] {
  const circleIntersections = intersectLineAndCircle(
    linePt,
    lineDir,
    arc.center,
    arc.radius
  );

  if (circleIntersections.length === 0) {
    return [];
  }

  // 若圓弧為完整封閉 360° 圓
  const isFullCircle = Math.abs(arc.endAngle - arc.startAngle) >= 2 * Math.PI - 1e-5;
  if (isFullCircle) {
    return circleIntersections;
  }

  const validPoints: Point2D[] = [];
  for (const pt of circleIntersections) {
    const theta = Math.atan2(pt.y - arc.center.y, pt.x - arc.center.x);
    if (isAngleInArcSweep(theta, arc.startAngle, arc.endAngle, false)) {
      validPoints.push(pt);
    }
  }

  return validPoints;
}

/**
 * 求解兩個圓 (c1, r1) 與 (c2, r2) 的 0~2 個交點
 */
export function intersectTwoCircles(
  c1: Point2D,
  r1: number,
  c2: Point2D,
  r2: number
): Point2D[] {
  if (r1 < 0 || r2 < 0) return [];
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);

  // 兩圓同心或距離過小
  if (d < 1e-9) {
    return [];
  }

  // 兩圓相離或包含
  if (d > r1 + r2 + 1e-7 || d < Math.abs(r1 - r2) - 1e-7) {
    return [];
  }

  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const hSq = r1 * r1 - a * a;
  const h = Math.sqrt(Math.max(0, hSq));

  const ux = dx / d;
  const uy = dy / d;

  const pMid: Point2D = {
    x: c1.x + a * ux,
    y: c1.y + a * uy,
  };

  if (h < 1e-7) {
    return [pMid];
  }

  const p1: Point2D = {
    x: pMid.x + h * (-uy),
    y: pMid.y + h * ux,
  };
  const p2: Point2D = {
    x: pMid.x - h * (-uy),
    y: pMid.y - h * ux,
  };

  return [p1, p2];
}

interface VirtualLine {
  kind: 'line';
  pt: Point2D;
  dir: Point2D;
}

interface VirtualCircle {
  kind: 'circle';
  center: Point2D;
  radius: number;
}

type VirtualGeometry = VirtualLine | VirtualCircle;

function getVirtualGeometries(entity: CADEntity2D, radius: number, pickPt: Point2D): VirtualGeometry[] {
  const geoms: VirtualGeometry[] = [];
  if (radius <= 1e-6) return geoms;

  if (entity.type === 'line') {
    const dx = entity.end.x - entity.start.x;
    const dy = entity.end.y - entity.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-7) return geoms;

    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;

    geoms.push({
      kind: 'line',
      pt: { x: entity.start.x + nx * radius, y: entity.start.y + ny * radius },
      dir: { x: ux, y: uy },
    });
    geoms.push({
      kind: 'line',
      pt: { x: entity.start.x - nx * radius, y: entity.start.y - ny * radius },
      dir: { x: ux, y: uy },
    });
  } else if (entity.type === 'circle' || entity.type === 'arc') {
    const r0 = entity.radius;
    // 外切同心圓：r0 + radius
    geoms.push({
      kind: 'circle',
      center: entity.center,
      radius: r0 + radius,
    });
    // 內切同心圓：|r0 - radius|
    if (Math.abs(r0 - radius) > 1e-6) {
      geoms.push({
        kind: 'circle',
        center: entity.center,
        radius: Math.abs(r0 - radius),
      });
    }
  } else if (entity.type === 'polyline' && entity.points && entity.points.length >= 2) {
    let bestDist = Infinity;
    let bestSeg: { start: Point2D; end: Point2D } | null = null;
    const pts = entity.points;
    const count = entity.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % pts.length];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) {
        const t = Math.max(0, Math.min(1, ((pickPt.x - p1.x) * dx + (pickPt.y - p1.y) * dy) / (len * len)));
        const proj = { x: p1.x + t * dx, y: p1.y + t * dy };
        const dist = Math.hypot(pickPt.x - proj.x, pickPt.y - proj.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestSeg = { start: p1, end: p2 };
        }
      }
    }
    if (bestSeg) {
      const dx = bestSeg.end.x - bestSeg.start.x;
      const dy = bestSeg.end.y - bestSeg.start.y;
      const len = Math.hypot(dx, dy);
      const ux = dx / len;
      const uy = dy / len;
      const nx = -uy;
      const ny = ux;
      geoms.push({
        kind: 'line',
        pt: { x: bestSeg.start.x + nx * radius, y: bestSeg.start.y + ny * radius },
        dir: { x: ux, y: uy },
      });
      geoms.push({
        kind: 'line',
        pt: { x: bestSeg.start.x - nx * radius, y: bestSeg.start.y - ny * radius },
        dir: { x: ux, y: uy },
      });
    }
  }

  return geoms;
}

function getTangentContactPoint(entity: CADEntity2D, center: Point2D, radius: number): Point2D {
  if (entity.type === 'line') {
    const dx = entity.end.x - entity.start.x;
    const dy = entity.end.y - entity.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-7) return { ...entity.start };
    const ux = dx / len;
    const uy = dy / len;
    const t = (center.x - entity.start.x) * ux + (center.y - entity.start.y) * uy;
    return { x: entity.start.x + t * ux, y: entity.start.y + t * uy };
  } else if (entity.type === 'circle' || entity.type === 'arc') {
    const dc = Math.hypot(center.x - entity.center.x, center.y - entity.center.y);
    if (dc > 1e-6) {
      return {
        x: entity.center.x + ((center.x - entity.center.x) / dc) * entity.radius,
        y: entity.center.y + ((center.y - entity.center.y) / dc) * entity.radius,
      };
    }
    return { ...entity.center };
  } else if (entity.type === 'polyline' && entity.points && entity.points.length >= 2) {
    let bestDist = Infinity;
    let bestProj: Point2D = entity.points[0];
    const pts = entity.points;
    const count = entity.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % pts.length];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) {
        const t = ((center.x - p1.x) * dx + (center.y - p1.y) * dy) / (len * len);
        const proj = { x: p1.x + t * dx, y: p1.y + t * dy };
        const dist = Math.hypot(center.x - proj.x, center.y - proj.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestProj = proj;
        }
      }
    }
    return bestProj;
  }
  return { ...center };
}

/**
 * 計算相切、相切、半徑 (TTR: Tangent, Tangent, Radius) 畫圓幾何求解。
 *
 * 演算法流程：
 * 1. 若為直線：向兩側偏移 radius 距離產生平行虛擬直線。
 * 2. 若為圓/圓弧：以其圓心向外 (R + radius) 及向內 (|R - radius|) 偏移產生虛擬同心圓。
 * 3. 求解虛擬幾何之間所有交點，作為候選圓心。
 * 4. 計算各候選圓心與切點對應使用者點擊點 (pickPt1, pickPt2) 之距離評分，回傳最佳匹配的圓實體 (CircleEntity)。
 *
 * @param ent1 第一個相切幾何實體
 * @param ent2 第二個相切幾何實體
 * @param radius 目標相切圓半徑 (必須 > 0)
 * @param pickPt1 使用者選取第一個實體時的點擊座標
 * @param pickPt2 使用者選取第二個實體時的點擊座標
 * @returns 求解成功回傳 CircleEntity，若無相切解則回傳 null
 */
export function calculateTTRCircle(
  ent1: CADEntity2D,
  ent2: CADEntity2D,
  radius: number,
  pickPt1: Point2D,
  pickPt2: Point2D
): CircleEntity | null {
  if (radius <= 1e-6 || !ent1 || !ent2) {
    return null;
  }

  const vGeoms1 = getVirtualGeometries(ent1, radius, pickPt1);
  const vGeoms2 = getVirtualGeometries(ent2, radius, pickPt2);

  if (vGeoms1.length === 0 || vGeoms2.length === 0) {
    return null;
  }

  const candidateCenters: Point2D[] = [];

  for (const g1 of vGeoms1) {
    for (const g2 of vGeoms2) {
      if (g1.kind === 'line' && g2.kind === 'line') {
        const det = g1.dir.x * g2.dir.y - g1.dir.y * g2.dir.x;
        if (Math.abs(det) > 1e-7) {
          const dx = g2.pt.x - g1.pt.x;
          const dy = g2.pt.y - g1.pt.y;
          const t1 = (dx * g2.dir.y - dy * g2.dir.x) / det;
          candidateCenters.push({
            x: g1.pt.x + t1 * g1.dir.x,
            y: g1.pt.y + t1 * g1.dir.y,
          });
        }
      } else if (g1.kind === 'line' && g2.kind === 'circle') {
        const pts = intersectLineAndCircle(g1.pt, g1.dir, g2.center, g2.radius);
        candidateCenters.push(...pts);
      } else if (g1.kind === 'circle' && g2.kind === 'line') {
        const pts = intersectLineAndCircle(g2.pt, g2.dir, g1.center, g1.radius);
        candidateCenters.push(...pts);
      } else if (g1.kind === 'circle' && g2.kind === 'circle') {
        const pts = intersectTwoCircles(g1.center, g1.radius, g2.center, g2.radius);
        candidateCenters.push(...pts);
      }
    }
  }

  if (candidateCenters.length === 0) {
    return null;
  }

  // 候選點去重
  const uniqueCandidates: Point2D[] = [];
  for (const pt of candidateCenters) {
    if (!uniqueCandidates.some((c) => Math.hypot(c.x - pt.x, c.y - pt.y) < 1e-5)) {
      uniqueCandidates.push(pt);
    }
  }

  if (uniqueCandidates.length === 0) {
    return null;
  }

  // 評估每個候選圓心與 pickPt1, pickPt2 的匹配程度
  let bestCenter: Point2D | null = null;
  let minScore = Infinity;

  for (const center of uniqueCandidates) {
    const t1 = getTangentContactPoint(ent1, center, radius);
    const t2 = getTangentContactPoint(ent2, center, radius);

    const distT1 = Math.hypot(t1.x - pickPt1.x, t1.y - pickPt1.y);
    const distT2 = Math.hypot(t2.x - pickPt2.x, t2.y - pickPt2.y);
    const distC1 = Math.hypot(center.x - pickPt1.x, center.y - pickPt1.y);
    const distC2 = Math.hypot(center.x - pickPt2.x, center.y - pickPt2.y);

    // 綜合切點距離與圓心距離進行評分
    const score = distT1 + distT2 + 0.1 * (distC1 + distC2);

    if (score < minScore) {
      minScore = score;
      bestCenter = center;
    }
  }

  if (!bestCenter) {
    return null;
  }

  const resultCircle: CircleEntity = {
    id: crypto.randomUUID(),
    layerId: (ent1 as any).layerId || '0',
    visible: true,
    locked: false,
    type: 'circle',
    center: bestCenter,
    radius,
  };

  return resultCircle;
}

/**
 * 求解 3x3 線性方程組 A * x = b (高斯消去法含主元選取)
 * 回傳解向量 [x0, x1, x2]，若奇異無解則回傳 null。
 */
function solve3x3LinearSystem(A: number[][], b: number[]): number[] | null {
  const M: number[][] = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]],
  ];

  for (let i = 0; i < 3; i++) {
    let maxRow = i;
    let maxVal = Math.abs(M[i][i]);
    for (let r = i + 1; r < 3; r++) {
      const val = Math.abs(M[r][i]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = r;
      }
    }

    if (maxVal < 1e-12) {
      return null;
    }

    if (maxRow !== i) {
      const temp = M[i];
      M[i] = M[maxRow];
      M[maxRow] = temp;
    }

    const pivot = M[i][i];
    for (let c = i; c <= 3; c++) {
      M[i][c] /= pivot;
    }

    for (let r = 0; r < 3; r++) {
      if (r !== i) {
        const factor = M[r][i];
        if (Math.abs(factor) > 1e-15) {
          for (let c = i; c <= 3; c++) {
            M[r][c] -= factor * M[i][c];
          }
        }
      }
    }
  }

  const res = [M[0][3], M[1][3], M[2][3]];
  if (res.some((v) => isNaN(v) || !isFinite(v))) {
    return null;
  }
  return res;
}

interface Normalized3TLine {
  type: 'line';
  p1: Point2D;
  p2: Point2D;
  A: number; // A*x + B*y + C = 0, with A^2 + B^2 = 1
  B: number;
  C: number;
}

interface Normalized3TCircle {
  type: 'circle';
  center: Point2D;
  radius: number;
}

type Normalized3TEntity = Normalized3TLine | Normalized3TCircle;

/**
 * 將 CADEntity2D 轉化為便於幾何計算之規格化表示（直線或圓）
 */
function normalizeEntityFor3T(entity: CADEntity2D, pickPt: Point2D): Normalized3TEntity | null {
  if (entity.type === 'line') {
    const dx = entity.end.x - entity.start.x;
    const dy = entity.end.y - entity.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-7) return null;
    const ux = dx / len;
    const uy = dy / len;
    const A = -uy;
    const B = ux;
    const C = -(A * entity.start.x + B * entity.start.y);
    return {
      type: 'line',
      p1: entity.start,
      p2: entity.end,
      A,
      B,
      C,
    };
  } else if (entity.type === 'circle' || entity.type === 'arc') {
    if (entity.radius < 1e-6) return null;
    return {
      type: 'circle',
      center: entity.center,
      radius: entity.radius,
    };
  } else if (entity.type === 'polyline' && entity.points && entity.points.length >= 2) {
    let bestDist = Infinity;
    let bestSeg: { start: Point2D; end: Point2D } | null = null;
    const pts = entity.points;
    const count = entity.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % pts.length];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) {
        const t = Math.max(0, Math.min(1, ((pickPt.x - p1.x) * dx + (pickPt.y - p1.y) * dy) / (len * len)));
        const proj = { x: p1.x + t * dx, y: p1.y + t * dy };
        const dist = Math.hypot(pickPt.x - proj.x, pickPt.y - proj.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestSeg = { start: p1, end: p2 };
        }
      }
    }
    if (!bestSeg) return null;
    const dx = bestSeg.end.x - bestSeg.start.x;
    const dy = bestSeg.end.y - bestSeg.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-7) return null;
    const ux = dx / len;
    const uy = dy / len;
    const A = -uy;
    const B = ux;
    const C = -(A * bestSeg.start.x + B * bestSeg.start.y);
    return {
      type: 'line',
      p1: bestSeg.start,
      p2: bestSeg.end,
      A,
      B,
      C,
    };
  }
  return null;
}

/**
 * 針對兩平行線與一截線求解相切圓
 */
function solveParallelPairWithTransversal(
  LA: Normalized3TLine,
  LB: Normalized3TLine,
  LC: Normalized3TLine
): Array<{ center: Point2D; radius: number }> {
  const results: Array<{ center: Point2D; radius: number }> = [];
  let bA = LB.A;
  let bB = LB.B;
  let bC = LB.C;
  const dot = LA.A * bA + LA.B * bB;
  if (dot < 0) {
    bA = -bA;
    bB = -bB;
    bC = -bC;
  }

  const dist = Math.abs(LA.C - bC);
  if (dist < 1e-4) {
    return results;
  }

  const r = dist / 2;
  const midC = (LA.C + bC) / 2;

  // 中線：LA.A * x + LA.B * y + midC = 0
  const det = LA.A * LC.B - LA.B * LC.A;
  if (Math.abs(det) < 1e-6) {
    return results; // 三線皆平行
  }

  const Pmid: Point2D = {
    x: (LA.B * LC.C - LC.B * midC) / det,
    y: (LC.A * midC - LA.A * LC.C) / det,
  };

  const dirX = -LA.B;
  const dirY = LA.A;
  const k = LC.A * dirX + LC.B * dirY;
  if (Math.abs(k) < 1e-6) {
    return results;
  }

  const t = r / Math.abs(k);
  results.push({
    center: { x: Pmid.x + t * dirX, y: Pmid.y + t * dirY },
    radius: r,
  });
  results.push({
    center: { x: Pmid.x - t * dirX, y: Pmid.y - t * dirY },
    radius: r,
  });

  return results;
}

/**
 * 求解三條直線之內切圓與旁切圓 (精確代數解)
 */
function solve3LinesTangency(
  L1: Normalized3TLine,
  L2: Normalized3TLine,
  L3: Normalized3TLine
): Array<{ center: Point2D; radius: number }> {
  const candidates: Array<{ center: Point2D; radius: number }> = [];

  const det12 = L1.A * L2.B - L1.B * L2.A;
  const det23 = L2.A * L3.B - L2.B * L3.A;
  const det31 = L3.A * L1.B - L3.B * L1.A;

  const isParallel12 = Math.abs(det12) < 1e-6;
  const isParallel23 = Math.abs(det23) < 1e-6;
  const isParallel31 = Math.abs(det31) < 1e-6;

  if (isParallel12 && isParallel23) {
    return []; // 三條皆平行
  }

  if (isParallel12) {
    return solveParallelPairWithTransversal(L1, L2, L3);
  }
  if (isParallel23) {
    return solveParallelPairWithTransversal(L2, L3, L1);
  }
  if (isParallel31) {
    return solveParallelPairWithTransversal(L3, L1, L2);
  }

  // 三線兩兩相交，構成三角形頂點
  const V3: Point2D = {
    x: (L1.B * L2.C - L2.B * L1.C) / det12,
    y: (L2.A * L1.C - L1.A * L2.C) / det12,
  };
  const V1: Point2D = {
    x: (L2.B * L3.C - L3.B * L2.C) / det23,
    y: (L3.A * L2.C - L2.A * L3.C) / det23,
  };
  const V2: Point2D = {
    x: (L3.B * L1.C - L1.B * L3.C) / det31,
    y: (L1.A * L3.C - L3.A * L1.C) / det31,
  };

  const a = Math.hypot(V2.x - V3.x, V2.y - V3.y);
  const b = Math.hypot(V3.x - V1.x, V3.y - V1.y);
  const c = Math.hypot(V1.x - V2.x, V1.y - V2.y);

  if (a < 1e-5 || b < 1e-5 || c < 1e-5) {
    return [];
  }

  const s = (a + b + c) / 2;
  const area2 = Math.abs((V2.x - V1.x) * (V3.y - V1.y) - (V2.y - V1.y) * (V3.x - V1.x));
  const area = area2 / 2;

  if (area < 1e-6 || s < 1e-6) {
    return [];
  }

  // 1. 內切圓 (Incircle)
  const denomIn = a + b + c;
  if (denomIn > 1e-6) {
    candidates.push({
      center: {
        x: (a * V1.x + b * V2.x + c * V3.x) / denomIn,
        y: (a * V1.y + b * V2.y + c * V3.y) / denomIn,
      },
      radius: area / s,
    });
  }

  // 2. 旁切圓 1 (Excircle opposite V1)
  const d1 = -a + b + c;
  const sa = Math.abs(s - a);
  if (Math.abs(d1) > 1e-6 && sa > 1e-6) {
    candidates.push({
      center: {
        x: (-a * V1.x + b * V2.x + c * V3.x) / d1,
        y: (-a * V1.y + b * V2.y + c * V3.y) / d1,
      },
      radius: area / sa,
    });
  }

  // 3. 旁切圓 2 (Excircle opposite V2)
  const d2 = a - b + c;
  const sb = Math.abs(s - b);
  if (Math.abs(d2) > 1e-6 && sb > 1e-6) {
    candidates.push({
      center: {
        x: (a * V1.x - b * V2.x + c * V3.x) / d2,
        y: (a * V1.y - b * V2.y + c * V3.y) / d2,
      },
      radius: area / sb,
    });
  }

  // 4. 旁切圓 3 (Excircle opposite V3)
  const d3 = a + b - c;
  const sc = Math.abs(s - c);
  if (Math.abs(d3) > 1e-6 && sc > 1e-6) {
    candidates.push({
      center: {
        x: (a * V1.x + b * V2.x - c * V3.x) / d3,
        y: (a * V1.y + b * V2.y - c * V3.y) / d3,
      },
      radius: area / sc,
    });
  }

  return candidates;
}

/**
 * 包含圓/圓弧或混合圖元的 Apollonius 相切圓數值求解器 (Levenberg-Marquardt + Newton-Raphson)
 */
function solveApolloniusGeneral(
  entities: [Normalized3TEntity, Normalized3TEntity, Normalized3TEntity],
  pickPoints: [Point2D, Point2D, Point2D]
): Array<{ center: Point2D; radius: number }> {
  const candidates: Array<{ center: Point2D; radius: number }> = [];

  // 產生高品質初值：
  const initGuesses: Array<{ x: number; y: number; r: number }> = [];

  // 1. 三選取點的外接圓
  const arc3p = calculate3PointArc(pickPoints[0], pickPoints[1], pickPoints[2]);
  if (arc3p && arc3p.radius > 0.1 && arc3p.radius < 50000) {
    initGuesses.push({
      x: arc3p.center.x,
      y: arc3p.center.y,
      r: arc3p.radius,
    });
  }

  // 2. 三選取點的質心與平均半徑
  const cx = (pickPoints[0].x + pickPoints[1].x + pickPoints[2].x) / 3;
  const cy = (pickPoints[0].y + pickPoints[1].y + pickPoints[2].y) / 3;
  const rAvg =
    (Math.hypot(pickPoints[0].x - cx, pickPoints[0].y - cy) +
      Math.hypot(pickPoints[1].x - cx, pickPoints[1].y - cy) +
      Math.hypot(pickPoints[2].x - cx, pickPoints[2].y - cy)) /
    3;
  initGuesses.push({
    x: cx,
    y: cy,
    r: Math.max(1.0, rAvg),
  });

  // 8 種分支符號組合 (σ1, σ2, σ3)
  const signCombinations: Array<[number, number, number]> = [
    [1, 1, 1],
    [1, 1, -1],
    [1, -1, 1],
    [1, -1, -1],
    [-1, 1, 1],
    [-1, 1, -1],
    [-1, -1, 1],
    [-1, -1, -1],
  ];

  for (const init of initGuesses) {
    for (const signs of signCombinations) {
      let x = init.x;
      let y = init.y;
      let r = init.r;
      let lambda = 1e-3;
      let converged = false;

      for (let iter = 0; iter < 16; iter++) {
        // 計算殘差向量 F 與雅可比矩陣 J
        const F: number[] = [0, 0, 0];
        const J: number[][] = [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ];

        for (let i = 0; i < 3; i++) {
          const ent = entities[i];
          const sign = signs[i];

          if (ent.type === 'line') {
            const dist = ent.A * x + ent.B * y + ent.C;
            F[i] = dist - sign * r;
            J[i][0] = ent.A;
            J[i][1] = ent.B;
            J[i][2] = -sign;
          } else {
            const dx = x - ent.center.x;
            const dy = y - ent.center.y;
            const D = Math.hypot(dx, dy);
            const safeD = Math.max(1e-7, D);
            const ux = dx / safeD;
            const uy = dy / safeD;

            if (sign === 1) {
              // 外切: D = R + r => D - R - r = 0
              F[i] = D - ent.radius - r;
              J[i][0] = ux;
              J[i][1] = uy;
              J[i][2] = -1;
            } else {
              // 內切: |D - R| = r 或 D = |R - r|
              if (ent.radius >= r) {
                // ent.radius >= r: D = R - r => D - R + r = 0
                F[i] = D - ent.radius + r;
                J[i][0] = ux;
                J[i][1] = uy;
                J[i][2] = 1;
              } else {
                // r > ent.radius: D = r - R => D + R - r = 0
                F[i] = D + ent.radius - r;
                J[i][0] = ux;
                J[i][1] = uy;
                J[i][2] = -1;
              }
            }
          }
        }

        const maxResidual = Math.max(Math.abs(F[0]), Math.abs(F[1]), Math.abs(F[2]));
        if (maxResidual < 1e-6 && r > 1e-4) {
          converged = true;
          break;
        }

        // Levenberg-Marquardt 正規化方程: (J^T * J + lambda * I) * delta = -J^T * F
        const JTJ: number[][] = [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ];
        const JTF: number[] = [0, 0, 0];

        for (let rIdx = 0; rIdx < 3; rIdx++) {
          for (let cIdx = 0; cIdx < 3; cIdx++) {
            let sum = 0;
            for (let k = 0; k < 3; k++) {
              sum += J[k][rIdx] * J[k][cIdx];
            }
            JTJ[rIdx][cIdx] = sum;
          }
          let sumF = 0;
          for (let k = 0; k < 3; k++) {
            sumF += J[k][rIdx] * F[k];
          }
          JTF[rIdx] = sumF;
        }

        // 加入阻尼項 lambda * I
        JTJ[0][0] += lambda;
        JTJ[1][1] += lambda;
        JTJ[2][2] += lambda;

        const rhs = [-JTF[0], -JTF[1], -JTF[2]];
        const delta = solve3x3LinearSystem(JTJ, rhs);
        if (!delta) {
          lambda *= 5;
          continue;
        }

        let stepFactor = 1.0;
        let nextR = r + stepFactor * delta[2];
        if (nextR <= 1e-4) {
          stepFactor = Math.max(0.01, ((r - 1e-4) / (Math.abs(delta[2]) + 1e-7)) * 0.5);
          nextR = r + stepFactor * delta[2];
        }

        x += stepFactor * delta[0];
        y += stepFactor * delta[1];
        r = Math.max(1e-4, nextR);

        // 殘差減小則降低阻尼，否則增加阻尼
        if (maxResidual < 1.0) {
          lambda = Math.max(1e-8, lambda * 0.5);
        } else {
          lambda = Math.min(1e3, lambda * 2.0);
        }
      }

      if (converged && r > 1e-4) {
        // 驗證相切幾何精度
        let isValid = true;
        for (let i = 0; i < 3; i++) {
          const ent = entities[i];
          if (ent.type === 'line') {
            const d = Math.abs(ent.A * x + ent.B * y + ent.C);
            if (Math.abs(d - r) > 0.05) {
              isValid = false;
              break;
            }
          } else {
            const D = Math.hypot(x - ent.center.x, y - ent.center.y);
            const errExt = Math.abs(D - (ent.radius + r));
            const errInt = Math.abs(D - Math.abs(ent.radius - r));
            if (Math.min(errExt, errInt) > 0.05) {
              isValid = false;
              break;
            }
          }
        }

        if (isValid) {
          const isDuplicate = candidates.some(
            (c) => Math.hypot(c.center.x - x, c.center.y - y) < 1e-3 && Math.abs(c.radius - r) < 1e-3
          );
          if (!isDuplicate) {
            candidates.push({
              center: { x, y },
              radius: r,
            });
          }
        }
      }
    }
  }

  return candidates;
}

/**
 * 計算指定候選圓於實體上的相切接觸點
 */
function getContactPointFor3T(entity: Normalized3TEntity, center: Point2D, radius: number): Point2D {
  if (entity.type === 'line') {
    const ux = entity.B;
    const uy = -entity.A;
    const t = (center.x - entity.p1.x) * ux + (center.y - entity.p1.y) * uy;
    return {
      x: entity.p1.x + t * ux,
      y: entity.p1.y + t * uy,
    };
  } else {
    const dx = center.x - entity.center.x;
    const dy = center.y - entity.center.y;
    const D = Math.hypot(dx, dy);
    if (D > 1e-7) {
      return {
        x: entity.center.x + (dx / D) * entity.radius,
        y: entity.center.y + (dy / D) * entity.radius,
      };
    }
    return { ...entity.center };
  }
}

/**
 * 計算三相切 (3-Tangent / 3T) 畫圓幾何求解。
 *
 * 演算法規格：
 * 1. 若三個實體皆為直線 (Line / Polyline 直線段)：
 *    轉化為求「三角形內切圓 (Incircle)」或「旁切圓 (Excircle)」。
 *    以三線之兩兩交點構成三角形，並以角平分線求得圓心與半徑；
 *    若存在兩平行線，則取其中線並與截線求切圓。
 * 2. 進階混合實體 (包含圓 Circle、圓弧 Arc、直線 Line)：
 *    採用多初值 Levenberg-Marquardt 與牛頓迭代逼近法求解非線性幾何方程組。
 * 3. 根據使用者點擊點 (pickPt1, pickPt2, pickPt3) 評估候選圓的切點與圓心距離，
 *    選取最符合使用者意圖之唯一最佳解。
 *
 * @param ent1 第一個幾何實體
 * @param ent2 第二個幾何實體
 * @param ent3 第三個幾何實體
 * @param pickPt1 使用者點選第一個實體的座標
 * @param pickPt2 使用者點選第二個實體的座標
 * @param pickPt3 使用者點選第三個實體的座標
 * @returns 求解成功回傳 CircleEntity，否則回傳 null
 */
export function calculate3TCircle(
  ent1: CADEntity2D,
  ent2: CADEntity2D,
  ent3: CADEntity2D,
  pickPt1: Point2D,
  pickPt2: Point2D,
  pickPt3: Point2D
): CircleEntity | null {
  if (!ent1 || !ent2 || !ent3 || !pickPt1 || !pickPt2 || !pickPt3) {
    return null;
  }

  const norm1 = normalizeEntityFor3T(ent1, pickPt1);
  const norm2 = normalizeEntityFor3T(ent2, pickPt2);
  const norm3 = normalizeEntityFor3T(ent3, pickPt3);

  if (!norm1 || !norm2 || !norm3) {
    return null;
  }

  let candidates: Array<{ center: Point2D; radius: number }> = [];

  // 若三個圖元全為直線，優先採用三角形內切圓/旁切圓的精確解析解
  if (norm1.type === 'line' && norm2.type === 'line' && norm3.type === 'line') {
    candidates = solve3LinesTangency(norm1, norm2, norm3);
  }

  // 若直線解析解無結果或圖元包含圓/弧，啟動通用 Apollonius 數值求解
  if (candidates.length === 0) {
    candidates = solveApolloniusGeneral([norm1, norm2, norm3], [pickPt1, pickPt2, pickPt3]);
  }

  if (candidates.length === 0) {
    return null;
  }

  // 根據 pickPt1, pickPt2, pickPt3 評估最佳解
  let bestCircle: { center: Point2D; radius: number } | null = null;
  let minScore = Infinity;

  for (const cand of candidates) {
    const t1 = getContactPointFor3T(norm1, cand.center, cand.radius);
    const t2 = getContactPointFor3T(norm2, cand.center, cand.radius);
    const t3 = getContactPointFor3T(norm3, cand.center, cand.radius);

    const distT1 = Math.hypot(t1.x - pickPt1.x, t1.y - pickPt1.y);
    const distT2 = Math.hypot(t2.x - pickPt2.x, t2.y - pickPt2.y);
    const distT3 = Math.hypot(t3.x - pickPt3.x, t3.y - pickPt3.y);

    const distC1 = Math.hypot(cand.center.x - pickPt1.x, cand.center.y - pickPt1.y);
    const distC2 = Math.hypot(cand.center.x - pickPt2.x, cand.center.y - pickPt2.y);
    const distC3 = Math.hypot(cand.center.x - pickPt3.x, cand.center.y - pickPt3.y);

    // 切點越接近使用者點選點，分數越低 (優先)
    const score = distT1 + distT2 + distT3 + 0.05 * (distC1 + distC2 + distC3);

    if (score < minScore) {
      minScore = score;
      bestCircle = cand;
    }
  }

  if (!bestCircle || bestCircle.radius <= 1e-4) {
    return null;
  }

  const result: CircleEntity = {
    id: crypto.randomUUID(),
    layerId: (ent1 as any).layerId || '0',
    visible: true,
    locked: false,
    type: 'circle',
    center: bestCircle.center,
    radius: bestCircle.radius,
  };

  return result;
}



