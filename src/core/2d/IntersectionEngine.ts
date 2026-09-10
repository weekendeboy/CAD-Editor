import { Point2D, CADEntity2D, LineEntity, ArcEntity } from '../../types/cad';

export interface IntersectionResult {
  point: Point2D;
  entityAId: string;
  entityBId: string;
  paramA: number; // 線段為 t in [0, 1]，圓弧為角度 theta (弧度)
  paramB: number;
}

/**
 * 正規化角度至 [0, 2π) 區間。
 */
export function normalizeAngle(angle: number): number {
  let res = angle % (2 * Math.PI);
  if (res < 0) res += 2 * Math.PI;
  return res;
}

/**
 * 判斷目標角度 theta 是否落在指定圓弧角度範圍內（考慮逆時針方向與跨 0 弧度邊界）。
 */
export function isAngleOnArc(
  theta: number,
  startAngle: number,
  endAngle: number,
  tolerance: number = 1e-5
): boolean {
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
 * 二維點去重/合併輔助函式，避免切點或精度誤差產生重複交點。
 */
function deduplicatePoints(pts: Point2D[], tolerance: number = 1e-5): Point2D[] {
  const result: Point2D[] = [];
  for (const p of pts) {
    let duplicate = false;
    for (const existing of result) {
      if (Math.hypot(p.x - existing.x, p.y - existing.y) < tolerance) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      result.push(p);
    }
  }
  return result;
}

/**
 * 利用 2D 外積與行列式精準求出線段交點（需落在雙方起終點區間內，容差 1e-5）。
 */
export function intersectLineLine(l1: LineEntity, l2: LineEntity): Point2D | null {
  const p1 = l1.start;
  const p2 = l1.end;
  const p3 = l2.start;
  const p4 = l2.end;

  const vx = p2.x - p1.x;
  const vy = p2.y - p1.y;
  const wx = p4.x - p3.x;
  const wy = p4.y - p3.y;

  // 行列式 (外積)
  const D = vx * wy - vy * wx;
  if (Math.abs(D) < 1e-10) {
    return null; // 平行或共線
  }

  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;

  // 克拉瑪公式求解參數 t 與 u
  const t = (dx * wy - dy * wx) / D;
  const u = (dx * vy - dy * vx) / D;

  const eps = 1e-5;
  if (t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps) {
    const tClamped = Math.max(0, Math.min(1, t));
    return {
      x: p1.x + tClamped * vx,
      y: p1.y + tClamped * vy,
    };
  }

  return null;
}

/**
 * 求解直線與圓交點，並過濾出落在圓弧角度範圍及線段長度內的有效點。
 */
export function intersectLineArc(line: LineEntity, arc: ArcEntity): Point2D[] {
  const p1 = line.start;
  const p2 = line.end;
  const center = arc.center;
  const radius = arc.radius;

  const vx = p2.x - p1.x;
  const vy = p2.y - p1.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-10) {
    return [];
  }

  const dx = center.x - p1.x;
  const dy = center.y - p1.y;

  // 投影點參數
  const tProj = (dx * vx + dy * vy) / lenSq;
  const pClosest = {
    x: p1.x + tProj * vx,
    y: p1.y + tProj * vy,
  };

  const distSq = (pClosest.x - center.x) * (pClosest.x - center.x) +
                 (pClosest.y - center.y) * (pClosest.y - center.y);

  const rSq = radius * radius;
  const eps = 1e-5;

  // 投影點到圓心的距離大於半徑（考慮容差）
  if (distSq > rSq + eps) {
    return [];
  }

  const points: Point2D[] = [];

  // 半弦長平方
  const hSq = Math.max(0, rSq - distSq);
  const h = Math.sqrt(hSq);
  const dt = h / Math.sqrt(lenSq);

  const t1 = tProj - dt;
  const t2 = tProj + dt;

  for (const t of [t1, t2]) {
    if (t >= -eps && t <= 1 + eps) {
      const p = {
        x: p1.x + t * vx,
        y: p1.y + t * vy,
      };
      const theta = Math.atan2(p.y - center.y, p.x - center.x);
      if (isAngleOnArc(theta, arc.startAngle, arc.endAngle, eps)) {
        points.push(p);
      }
    }
  }

  return deduplicatePoints(points, eps);
}

/**
 * 兩圓交點幾何求交，並過濾角度範圍。
 */
export function intersectArcArc(arc1: ArcEntity, arc2: ArcEntity): Point2D[] {
  const c1 = arc1.center;
  const r1 = arc1.radius;
  const c2 = arc2.center;
  const r2 = arc2.radius;

  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);

  // 圓心重合
  if (d < 1e-10) {
    return [];
  }

  const eps = 1e-5;

  // 太遠無交點或包含於內部無交點
  if (d > r1 + r2 + eps || d < Math.abs(r1 - r2) - eps) {
    return [];
  }

  // 圓心 1 到弦交線的投影距離 x
  const x = (d * d + r1 * r1 - r2 * r2) / (2 * d);

  // 弦交點到中線的垂直半高度 y
  const ySq = r1 * r1 - x * x;
  const y = Math.sqrt(Math.max(0, ySq));

  // 連心線單位向量
  const ux = dx / d;
  const uy = dy / d;

  // 垂直連心線向量
  const wx = -uy;
  const wy = ux;

  const p1 = {
    x: c1.x + x * ux + y * wx,
    y: c1.y + x * uy + y * wy,
  };
  const p2 = {
    x: c1.x + x * ux - y * wx,
    y: c1.y + x * uy - y * wy,
  };

  const points: Point2D[] = [];

  for (const p of [p1, p2]) {
    const theta1 = Math.atan2(p.y - c1.y, p.x - c1.x);
    const theta2 = Math.atan2(p.y - c2.y, p.x - c2.x);
    if (
      isAngleOnArc(theta1, arc1.startAngle, arc1.endAngle, eps) &&
      isAngleOnArc(theta2, arc2.startAngle, arc2.endAngle, eps)
    ) {
      points.push(p);
    }
  }

  return deduplicatePoints(points, eps);
}

/**
 * 計算指定點在圖元 (LineEntity 或 ArcEntity) 上的參數。
 */
function getEntityParameter(entity: LineEntity | ArcEntity, point: Point2D): number {
  if (entity.type === 'line') {
    const p1 = entity.start;
    const p2 = entity.end;
    const vx = p2.x - p1.x;
    const vy = p2.y - p1.y;
    const lenSq = vx * vx + vy * vy;
    if (lenSq < 1e-10) return 0;
    const t = ((point.x - p1.x) * vx + (point.y - p1.y) * vy) / lenSq;
    return Math.max(0, Math.min(1, t));
  } else {
    const center = entity.center;
    const theta = Math.atan2(point.y - center.y, point.x - center.x);
    return normalizeAngle(theta);
  }
}

/**
 * 將各種複雜/簡單圖元 (如多段線、圓形) 拆解/轉換為基礎的 LineEntity 與 ArcEntity
 */
function decomposeEntity(entity: CADEntity2D): Array<LineEntity | ArcEntity> {
  if (entity.visible === false) {
    return [];
  }

  switch (entity.type) {
    case 'line':
      return [entity];

    case 'arc':
      return [entity];

    case 'circle': {
      // 圓形視為 0 至 2π 的圓弧
      const arc: ArcEntity = {
        ...entity,
        type: 'arc',
        startAngle: 0,
        endAngle: 2 * Math.PI,
      };
      return [arc];
    }

    case 'polyline': {
      const segments: LineEntity[] = [];
      const pts = entity.points;
      if (pts.length < 2) return [];

      for (let i = 0; i < pts.length - 1; i++) {
        segments.push({
          id: entity.id,
          layerId: entity.layerId,
          visible: entity.visible,
          locked: entity.locked,
          type: 'line',
          start: pts[i],
          end: pts[i + 1],
        });
      }

      if (entity.closed && pts.length > 2) {
        segments.push({
          id: entity.id,
          layerId: entity.layerId,
          visible: entity.visible,
          locked: entity.locked,
          type: 'line',
          start: pts[pts.length - 1],
          end: pts[0],
        });
      }

      return segments;
    }

    default:
      return [];
  }
}

/**
 * 遍歷圖元陣列，計算所有兩兩相交的交點清單。
 */
export function findAllIntersections(entities: CADEntity2D[]): IntersectionResult[] {
  // 1. 先將所有複雜/基礎圖元展平成基礎圖元列表 (LineEntity / ArcEntity)
  const prims: Array<{ segment: LineEntity | ArcEntity; parentId: string }> = [];
  for (const entity of entities) {
    const decomposed = decomposeEntity(entity);
    for (const d of decomposed) {
      prims.push({ segment: d, parentId: entity.id });
    }
  }

  const results: IntersectionResult[] = [];

  // 2. 兩兩進行求交 (i 與 j + 1)
  for (let i = 0; i < prims.length; i++) {
    for (let j = i + 1; j < prims.length; j++) {
      const pA = prims[i];
      const pB = prims[j];

      // 若原屬於同一個實體 (例如同一多段線的相鄰段)，不計為相交交點
      if (pA.parentId === pB.parentId) {
        continue;
      }

      const segA = pA.segment;
      const segB = pB.segment;

      let pts: Point2D[] = [];

      if (segA.type === 'line' && segB.type === 'line') {
        const pt = intersectLineLine(segA, segB);
        if (pt) pts.push(pt);
      } else if (segA.type === 'line' && segB.type === 'arc') {
        pts = intersectLineArc(segA, segB);
      } else if (segA.type === 'arc' && segB.type === 'line') {
        pts = intersectLineArc(segB, segA);
      } else if (segA.type === 'arc' && segB.type === 'arc') {
        pts = intersectArcArc(segA, segB);
      }

      for (const pt of pts) {
        results.push({
          point: pt,
          entityAId: pA.parentId,
          entityBId: pB.parentId,
          paramA: getEntityParameter(segA, pt),
          paramB: getEntityParameter(segB, pt),
        });
      }
    }
  }

  return results;
}
