import { Point2D, CADEntity2D } from '../../types/cad';

export interface SelectionBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  isCrossing: boolean; // 向左拉 (Crossing): true；向右拉 (Window): false
}

/**
 * 判斷點是否在框內（包含邊界）。
 */
export function isPointInBox(p: Point2D, box: SelectionBox): boolean {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

/**
 * 輔助函數：求兩線段 A-B 與 C-D 是否相交。
 */
function intersectSegments(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const det = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(det) < 1e-10) {
    // 平行或共線：檢查共線重疊
    const cross1 = (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x);
    if (Math.abs(cross1) > 1e-9) return false;
    
    const minAbX = Math.min(a.x, b.x);
    const maxAbX = Math.max(a.x, b.x);
    const minAbY = Math.min(a.y, b.y);
    const maxAbY = Math.max(a.y, b.y);
    const minCdX = Math.min(c.x, d.x);
    const maxCdX = Math.max(c.x, d.x);
    const minCdY = Math.min(c.y, d.y);
    const maxCdY = Math.max(c.y, d.y);
    
    return Math.max(minAbX, minCdX) <= Math.min(maxAbX, maxCdX) &&
           Math.max(minAbY, minCdY) <= Math.min(maxAbY, maxCdY);
  }
  
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / det;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / det;
  const eps = 1e-9;
  return t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps;
}

/**
 * 判斷線段與框是否相交。
 * 若線段起終點任一點在框內，回傳 true。
 * 若線段與框的 4 條邊（上、下、左、右）任一條相交，回傳 true。
 */
export function isLineIntersectBox(p1: Point2D, p2: Point2D, box: SelectionBox): boolean {
  if (isPointInBox(p1, box) || isPointInBox(p2, box)) {
    return true;
  }

  const edges = [
    [{ x: box.minX, y: box.minY }, { x: box.minX, y: box.maxY }], // 左
    [{ x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }], // 右
    [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }], // 下
    [{ x: box.minX, y: box.maxY }, { x: box.maxX, y: box.maxY }], // 上
  ];

  for (const [e1, e2] of edges) {
    if (intersectSegments(p1, p2, e1, e2)) {
      return true;
    }
  }

  return false;
}

/**
 * 輔助函數：求線段 P1-P2 與圓心 Center、半徑 Radius 的交點。
 */
function intersectSegmentCircle(p1: Point2D, p2: Point2D, center: Point2D, radius: number): Point2D[] {
  const vx = p2.x - p1.x;
  const vy = p2.y - p1.y;
  const A = vx * vx + vy * vy;
  if (A < 1e-10) {
    return [];
  }
  const dx = p1.x - center.x;
  const dy = p1.y - center.y;
  const B = 2 * (vx * dx + vy * dy);
  const C = dx * dx + dy * dy - radius * radius;

  const disc = B * B - 4 * A * C;
  if (disc < 0) {
    return [];
  }

  const points: Point2D[] = [];
  const sqrtDisc = Math.sqrt(disc);
  const eps = 1e-9;

  const t1 = (-B - sqrtDisc) / (2 * A);
  const t2 = (-B + sqrtDisc) / (2 * A);

  for (const t of [t1, t2]) {
    if (t >= -eps && t <= 1 + eps) {
      const tClamped = Math.max(0, Math.min(1, t));
      points.push({
        x: p1.x + tClamped * vx,
        y: p1.y + tClamped * vy,
      });
    }
  }
  return points;
}

/**
 * 輔助函數：標準化角度至 [0, 2π)
 */
function normalizeAngle(angle: number): number {
  let res = angle % (2 * Math.PI);
  if (res < 0) res += 2 * Math.PI;
  return res;
}

/**
 * 輔助函數：判斷角度是否在圓弧內。
 */
function isAngleOnArc(theta: number, startAngle: number, endAngle: number, tolerance: number = 1e-5): boolean {
  if (Math.abs(endAngle - startAngle) >= 2 * Math.PI - tolerance) {
    return true;
  }
  const start = normalizeAngle(startAngle);
  const end = normalizeAngle(endAngle);
  const target = normalizeAngle(theta);

  const sweep = normalizeAngle(end - start);
  const targetSweep = normalizeAngle(target - start);

  return targetSweep <= sweep + tolerance || (2 * Math.PI - targetSweep) <= tolerance;
}

/**
 * 判斷圓弧與框是否相交。
 * 圓弧起點、終點任一點在框內，或圓弧邊界與框的 4 條邊有交點（可使用線弧求交）。
 */
export function isArcIntersectBox(
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number,
  box: SelectionBox
): boolean {
  const pStart = {
    x: center.x + radius * Math.cos(startAngle),
    y: center.y + radius * Math.sin(startAngle),
  };
  const pEnd = {
    x: center.x + radius * Math.cos(endAngle),
    y: center.y + radius * Math.sin(endAngle),
  };

  if (isPointInBox(pStart, box) || isPointInBox(pEnd, box)) {
    return true;
  }

  const edges = [
    [{ x: box.minX, y: box.minY }, { x: box.minX, y: box.maxY }], // 左
    [{ x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }], // 右
    [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }], // 下
    [{ x: box.minX, y: box.maxY }, { x: box.maxX, y: box.maxY }], // 上
  ];

  for (const [e1, e2] of edges) {
    const pts = intersectSegmentCircle(e1, e2, center, radius);
    for (const pt of pts) {
      const theta = Math.atan2(pt.y - center.y, pt.x - center.x);
      if (isAngleOnArc(theta, startAngle, endAngle)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 判斷圓形與框是否相交。
 * 圓心到矩形的最短距離 <= radius，且圓形非完全包覆矩形外部時視為相交。
 */
export function isCircleIntersectBox(center: Point2D, radius: number, box: SelectionBox): boolean {
  const closestX = Math.max(box.minX, Math.min(center.x, box.maxX));
  const closestY = Math.max(box.minY, Math.min(center.y, box.maxY));
  const minDist = Math.hypot(center.x - closestX, center.y - closestY);

  if (minDist > radius) {
    return false;
  }

  // 檢查是否完全包覆（矩形四個角都在圓內）
  const d1 = Math.hypot(box.minX - center.x, box.minY - center.y);
  const d2 = Math.hypot(box.minX - center.x, box.maxY - center.y);
  const d3 = Math.hypot(box.maxX - center.x, box.minY - center.y);
  const d4 = Math.hypot(box.maxX - center.x, box.maxY - center.y);

  if (d1 <= radius && d2 <= radius && d3 <= radius && d4 <= radius) {
    return false;
  }

  return true;
}

/**
 * 輔助函數：計算圓弧的緊密包圍盒（Bounding Box）。
 */
function getArcBoundingBox(
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number
): { minX: number; maxX: number; minY: number; maxY: number } {
  const pStart = {
    x: center.x + radius * Math.cos(startAngle),
    y: center.y + radius * Math.sin(startAngle),
  };
  const pEnd = {
    x: center.x + radius * Math.cos(endAngle),
    y: center.y + radius * Math.sin(endAngle),
  };

  let minX = Math.min(pStart.x, pEnd.x);
  let maxX = Math.max(pStart.x, pEnd.x);
  let minY = Math.min(pStart.y, pEnd.y);
  let maxY = Math.max(pStart.y, pEnd.y);

  // 圓的極值點角度為 0, π/2, π, 3π/2
  const testAngles = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
  for (const angle of testAngles) {
    if (isAngleOnArc(angle, startAngle, endAngle)) {
      const px = center.x + radius * Math.cos(angle);
      const py = center.y + radius * Math.sin(angle);
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
  }

  return { minX, maxX, minY, maxY };
}

/**
 * 實作並匯出主判定函式
 */
export function isEntityInSelectionBox(entity: CADEntity2D, box: SelectionBox): boolean {
  if (!box.isCrossing) {
    // 向右拉 (Window 藍框，完全包含)
    switch (entity.type) {
      case 'line': {
        return isPointInBox(entity.start, box) && isPointInBox(entity.end, box);
      }
      case 'circle': {
        return (
          isPointInBox(entity.center, box) &&
          entity.center.x - entity.radius >= box.minX &&
          entity.center.x + entity.radius <= box.maxX &&
          entity.center.y - entity.radius >= box.minY &&
          entity.center.y + entity.radius <= box.maxY
        );
      }
      case 'arc': {
        const pStart = {
          x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
          y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
        };
        const pEnd = {
          x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
          y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
        };
        
        if (!isPointInBox(pStart, box) || !isPointInBox(pEnd, box)) {
          return false;
        }
        
        const arcBox = getArcBoundingBox(entity.center, entity.radius, entity.startAngle, entity.endAngle);
        return (
          arcBox.minX >= box.minX &&
          arcBox.maxX <= box.maxX &&
          arcBox.minY >= box.minY &&
          arcBox.maxY <= box.maxY
        );
      }
      case 'polyline': {
        return entity.points.every((p) => isPointInBox(p, box));
      }
      default:
        return false;
    }
  } else {
    // 向左拉 (Crossing 綠框，碰觸即選)
    switch (entity.type) {
      case 'line': {
        return isLineIntersectBox(entity.start, entity.end, box);
      }
      case 'circle': {
        return (
          isPointInBox(entity.center, box) ||
          isCircleIntersectBox(entity.center, entity.radius, box)
        );
      }
      case 'arc': {
        return isArcIntersectBox(entity.center, entity.radius, entity.startAngle, entity.endAngle, box);
      }
      case 'polyline': {
        const pts = entity.points;
        if (pts.length < 2) {
          return pts.some((p) => isPointInBox(p, box));
        }

        for (let i = 0; i < pts.length - 1; i++) {
          if (isLineIntersectBox(pts[i], pts[i + 1], box)) {
            return true;
          }
        }

        if (entity.closed && pts.length > 2) {
          if (isLineIntersectBox(pts[pts.length - 1], pts[0], box)) {
            return true;
          }
        }

        return pts.some((p) => isPointInBox(p, box));
      }
      default:
        return false;
    }
  }
}
