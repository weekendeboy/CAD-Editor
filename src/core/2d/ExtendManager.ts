import { Point2D, CADEntity2D, LineEntity, ArcEntity, Constraint, CircleEntity, PolylineEntity } from '../../types/cad';
import { normalizeAngle, isAngleOnArc } from './IntersectionEngine';
import { getArcSweepAngle } from './GeometryMath';

export interface ExtendResult {
  originalEntityId: string;
  extendedEntity: LineEntity | ArcEntity;
  boundaryEntityId: string;
  targetPoint: Point2D;
  generatedConstraint?: Constraint; // 自動生成的 coincident 約束
}

// ==========================================
// 向量與幾何基礎工具
// ==========================================

function getDistance(p1: Point2D, p2: Point2D): number {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
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

// ==========================================
// 射線 (Ray) 與各類圖元的求交
// 射線方程: R(t) = O + t * v, 限制 t > 1e-4
// ==========================================

interface RayIntersection {
  point: Point2D;
  t: number;
}

/**
 * 射線與線段 (Line) 求交
 */
function intersectRayLine(
  origin: Point2D,
  dir: Point2D,
  line: LineEntity
): RayIntersection[] {
  const p1 = line.start;
  const p2 = line.end;

  const vx = dir.x;
  const vy = dir.y;
  const wx = p2.x - p1.x;
  const wy = p2.y - p1.y;

  // 行列式 (外積)
  const D = vy * wx - vx * wy;
  if (Math.abs(D) < 1e-10) {
    return []; // 平行或共線
  }

  const dx = p1.x - origin.x;
  const dy = p1.y - origin.y;

  // 克拉瑪公式求解參數 t 與 u
  // t * vx - u * wx = dx
  // t * vy - u * wy = dy
  const detT = dy * wx - dx * wy;
  const detU = vx * dy - vy * dx;

  const t = detT / D;
  const u = detU / D;

  const eps = 1e-5;
  if (t > 1e-4 && u >= -eps && u <= 1 + eps) {
    const uClamped = Math.max(0, Math.min(1, u));
    return [
      {
        point: {
          x: p1.x + uClamped * wx,
          y: p1.y + uClamped * wy,
        },
        t: t,
      },
    ];
  }

  return [];
}

/**
 * 射線與圓/圓弧求交的通用輔助函式
 */
function intersectRayCircleGeneral(
  origin: Point2D,
  dir: Point2D,
  center: Point2D,
  radius: number
): RayIntersection[] {
  const dx = origin.x - center.x;
  const dy = origin.y - center.y;

  // 射線與圓交點二次方程式: t^2 + 2*(d.dir)*t + (d^2 - R^2) = 0
  const b = 2 * (dx * dir.x + dy * dir.y);
  const c = dx * dx + dy * dy - radius * radius;

  const discriminant = b * b - 4 * c;
  if (discriminant < 0) {
    return [];
  }

  const sqrtDisc = Math.sqrt(discriminant);
  const t1 = (-b + sqrtDisc) / 2;
  const t2 = (-b - sqrtDisc) / 2;

  const results: RayIntersection[] = [];
  for (const t of [t1, t2]) {
    if (t > 1e-4) {
      results.push({
        point: {
          x: origin.x + t * dir.x,
          y: origin.y + t * dir.y,
        },
        t: t,
      });
    }
  }

  return results;
}

/**
 * 射線與圓弧 (Arc) 求交
 */
function intersectRayArc(
  origin: Point2D,
  dir: Point2D,
  arc: ArcEntity
): RayIntersection[] {
  const candidates = intersectRayCircleGeneral(origin, dir, arc.center, arc.radius);
  const results: RayIntersection[] = [];

  for (const cand of candidates) {
    const theta = Math.atan2(cand.point.y - arc.center.y, cand.point.x - arc.center.x);
    if (isAngleOnArc(theta, arc.startAngle, arc.endAngle, arc.clockwise, 1e-5)) {
      results.push(cand);
    }
  }

  return results;
}

/**
 * 射線與圓形 (Circle) 求交
 */
function intersectRayCircle(
  origin: Point2D,
  dir: Point2D,
  circle: CircleEntity
): RayIntersection[] {
  return intersectRayCircleGeneral(origin, dir, circle.center, circle.radius);
}

/**
 * 射線與多段線 (Polyline) 求交
 */
function intersectRayPolyline(
  origin: Point2D,
  dir: Point2D,
  polyline: PolylineEntity
): RayIntersection[] {
  const results: RayIntersection[] = [];
  const pts = polyline.points;
  if (pts.length < 2) return [];

  const segmentsCount = polyline.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segmentsCount; i++) {
    const segmentLine: LineEntity = {
      id: polyline.id,
      layerId: polyline.layerId,
      visible: polyline.visible,
      locked: polyline.locked,
      type: 'line',
      start: pts[i],
      end: pts[(i + 1) % pts.length],
    };

    results.push(...intersectRayLine(origin, dir, segmentLine));
  }

  return results;
}

// ==========================================
// 圓 (Circle) 與各類圖元的求交
// 用於圓弧延伸時，尋找與無限圓弧的交點
// ==========================================

/**
 * 圓與線段 (Line) 求交
 */
function intersectCircleLine(
  center: Point2D,
  radius: number,
  line: LineEntity
): Point2D[] {
  const p1 = line.start;
  const p2 = line.end;
  const vx = p2.x - p1.x;
  const vy = p2.y - p1.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-10) {
    return [];
  }

  const dx = center.x - p1.x;
  const dy = center.y - p1.y;

  const tProj = (dx * vx + dy * vy) / lenSq;
  const pClosest = {
    x: p1.x + tProj * vx,
    y: p1.y + tProj * vy,
  };

  const distSq = (pClosest.x - center.x) * (pClosest.x - center.x) +
                 (pClosest.y - center.y) * (pClosest.y - center.y);

  const rSq = radius * radius;
  const eps = 1e-5;

  if (distSq > rSq + eps) {
    return [];
  }

  const hSq = Math.max(0, rSq - distSq);
  const h = Math.sqrt(hSq);
  const dt = h / Math.sqrt(lenSq);

  const t1 = tProj - dt;
  const t2 = tProj + dt;

  const points: Point2D[] = [];
  for (const t of [t1, t2]) {
    if (t >= -eps && t <= 1 + eps) {
      points.push({
        x: p1.x + t * vx,
        y: p1.y + t * vy,
      });
    }
  }

  return deduplicatePoints(points, eps);
}

/**
 * 兩圓相交
 */
function intersectCircleCircle(
  c1: Point2D,
  r1: number,
  c2: Point2D,
  r2: number
): Point2D[] {
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);

  if (d < 1e-10) {
    return [];
  }

  const eps = 1e-5;
  if (d > r1 + r2 + eps || d < Math.abs(r1 - r2) - eps) {
    return [];
  }

  const x = (d * d + r1 * r1 - r2 * r2) / (2 * d);
  const ySq = r1 * r1 - x * x;
  const y = Math.sqrt(Math.max(0, ySq));

  const ux = dx / d;
  const uy = dy / d;
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

  return deduplicatePoints([p1, p2], eps);
}

/**
 * 圓與圓弧 (Arc) 求交
 */
function intersectCircleArc(
  center: Point2D,
  radius: number,
  arc: ArcEntity
): Point2D[] {
  const pts = intersectCircleCircle(center, radius, arc.center, arc.radius);
  return pts.filter((p) => {
    const theta = Math.atan2(p.y - arc.center.y, p.x - arc.center.x);
    return isAngleOnArc(theta, arc.startAngle, arc.endAngle, arc.clockwise, 1e-5);
  });
}

/**
 * 圓與圓 (Circle) 求交
 */
function intersectCircleCircleEntity(
  center: Point2D,
  radius: number,
  circle: CircleEntity
): Point2D[] {
  return intersectCircleCircle(center, radius, circle.center, circle.radius);
}

/**
 * 圓與多段線 (Polyline) 求交
 */
function intersectCirclePolyline(
  center: Point2D,
  radius: number,
  polyline: PolylineEntity
): Point2D[] {
  const points: Point2D[] = [];
  const pts = polyline.points;
  if (pts.length < 2) return [];

  const segmentsCount = polyline.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segmentsCount; i++) {
    const segmentLine: LineEntity = {
      id: polyline.id,
      layerId: polyline.layerId,
      visible: polyline.visible,
      locked: polyline.locked,
      type: 'line',
      start: pts[i],
      end: pts[(i + 1) % pts.length],
    };

    points.push(...intersectCircleLine(center, radius, segmentLine));
  }

  return deduplicatePoints(points, 1e-5);
}

// ==========================================
// 尋找邊界圖元上最靠近交點的點索引 (用於建立 coincident 約束)
// ==========================================

function findClosestPointIndex(
  entity: CADEntity2D,
  pt: Point2D
): number {
  if (entity.type === 'line') {
    const d0 = getDistance(entity.start, pt);
    const d1 = getDistance(entity.end, pt);
    return d0 < d1 ? 0 : 1;
  } else if (entity.type === 'arc') {
    const pStart = {
      x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
      y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
    };
    const pEnd = {
      x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
      y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
    };
    const d0 = getDistance(pStart, pt);
    const d1 = getDistance(pEnd, pt);
    return d0 < d1 ? 0 : 1;
  } else if (entity.type === 'polyline') {
    let minD = Infinity;
    let closestIdx = 0;
    for (let i = 0; i < entity.points.length; i++) {
      const d = getDistance(entity.points[i], pt);
      if (d < minD) {
        minD = d;
        closestIdx = i;
      }
    }
    return closestIdx;
  }
  return 0; // 圓形或其它預設回傳 0
}

// ==========================================
// 核心延伸計算引擎
// ==========================================

export function calculateExtend(
  targetEntityId: string,
  clickPoint: Point2D,
  allEntities: CADEntity2D[]
): ExtendResult | null {
  const target = allEntities.find((e) => e.id === targetEntityId);
  if (!target || (target.type !== 'line' && target.type !== 'arc')) {
    return null;
  }

  const boundaryEntities = allEntities.filter((e) => e.id !== targetEntityId && e.visible !== false);

  if (target.type === 'line') {
    // 1. 決定要延伸的端點與方向
    const pStart = target.start;
    const pEnd = target.end;
    const len = getDistance(pStart, pEnd);
    if (len < 1e-6) return null;

    const distStart = getDistance(pStart, clickPoint);
    const distEnd = getDistance(pEnd, clickPoint);

    let origin: Point2D;
    let dir: Point2D;
    let extendedPointIndex: number; // 0 for start, 1 for end

    if (distEnd < distStart) {
      // 靠近終點：由起點朝終點射出
      origin = pEnd;
      dir = {
        x: (pEnd.x - pStart.x) / len,
        y: (pEnd.y - pStart.y) / len,
      };
      extendedPointIndex = 1;
    } else {
      // 靠近起點：由終點朝起點射出
      origin = pStart;
      dir = {
        x: (pStart.x - pEnd.x) / len,
        y: (pStart.y - pEnd.y) / len,
      };
      extendedPointIndex = 0;
    }

    // 2. 遍歷其餘所有圖元計算正向交點 (t > 1e-4)
    let closestIntersection: RayIntersection | null = null;
    let boundaryEntityId = '';

    for (const boundary of boundaryEntities) {
      let intersections: RayIntersection[] = [];

      if (boundary.type === 'line') {
        intersections = intersectRayLine(origin, dir, boundary);
      } else if (boundary.type === 'arc') {
        intersections = intersectRayArc(origin, dir, boundary);
      } else if (boundary.type === 'circle') {
        intersections = intersectRayCircle(origin, dir, boundary);
      } else if (boundary.type === 'polyline') {
        intersections = intersectRayPolyline(origin, dir, boundary);
      }

      for (const inter of intersections) {
        if (!closestIntersection || inter.t < closestIntersection.t) {
          closestIntersection = inter;
          boundaryEntityId = boundary.id;
        }
      }
    }

    // 3. 若找到有效交點，生成結果
    if (closestIntersection && boundaryEntityId) {
      const targetPoint = closestIntersection.point;
      const boundaryEntity = boundaryEntities.find((e) => e.id === boundaryEntityId)!;

      const extendedEntity: LineEntity = {
        ...target,
        start: extendedPointIndex === 0 ? targetPoint : { ...target.start },
        end: extendedPointIndex === 1 ? targetPoint : { ...target.end },
      };

      let generatedConstraint: Constraint | undefined = undefined;
      let isEndpoint = false;
      let boundaryPointIndex = 0;

      if (boundaryEntity.type === 'line') {
        const dStart = getDistance(boundaryEntity.start, targetPoint);
        const dEnd = getDistance(boundaryEntity.end, targetPoint);
        if (dStart < 1e-3 || dEnd < 1e-3) {
          isEndpoint = true;
          boundaryPointIndex = dStart < dEnd ? 0 : 1;
        }
      } else if (boundaryEntity.type === 'arc') {
        const pStart = {
          x: boundaryEntity.center.x + boundaryEntity.radius * Math.cos(boundaryEntity.startAngle),
          y: boundaryEntity.center.y + boundaryEntity.radius * Math.sin(boundaryEntity.startAngle),
        };
        const pEnd = {
          x: boundaryEntity.center.x + boundaryEntity.radius * Math.cos(boundaryEntity.endAngle),
          y: boundaryEntity.center.y + boundaryEntity.radius * Math.sin(boundaryEntity.endAngle),
        };
        const dStart = getDistance(pStart, targetPoint);
        const dEnd = getDistance(pEnd, targetPoint);
        if (dStart < 1e-3 || dEnd < 1e-3) {
          isEndpoint = true;
          boundaryPointIndex = dStart < dEnd ? 0 : 1;
        }
      } else if (boundaryEntity.type === 'polyline') {
        let minD = Infinity;
        let closestIdx = 0;
        for (let i = 0; i < boundaryEntity.points.length; i++) {
          const d = getDistance(boundaryEntity.points[i], targetPoint);
          if (d < minD) {
            minD = d;
            closestIdx = i;
          }
        }
        if (minD < 1e-3) {
          isEndpoint = true;
          boundaryPointIndex = closestIdx;
        }
      }

      if (isEndpoint) {
        const uuid = Math.random().toString(36).substring(2, 11);
        generatedConstraint = {
          id: `c-coincident-${targetEntityId}-${boundaryEntityId}-${uuid}`,
          type: 'coincident',
          entityIds: [targetEntityId, boundaryEntityId],
          pointIndices: [extendedPointIndex, boundaryPointIndex],
        };
      }

      return {
        originalEntityId: targetEntityId,
        extendedEntity,
        boundaryEntityId,
        targetPoint,
        generatedConstraint,
      };
    }
  } else if (target.type === 'arc') {
    // 1. 決定要延伸的端點與方向
    const center = target.center;
    const radius = target.radius;
    const isCW = Boolean(target.clockwise);

    const sAngle = normalizeAngle(target.startAngle);
    const eAngle = normalizeAngle(target.endAngle);

    const pStart = {
      x: center.x + radius * Math.cos(sAngle),
      y: center.y + radius * Math.sin(sAngle),
    };
    const pEnd = {
      x: center.x + radius * Math.cos(eAngle),
      y: center.y + radius * Math.sin(eAngle),
    };

    const distStart = getDistance(pStart, clickPoint);
    const distEnd = getDistance(pEnd, clickPoint);

    const originalSweep = getArcSweepAngle(sAngle, eAngle, isCW);
    const unSweptRegion = 2 * Math.PI - originalSweep;
    let extendedPointIndex: number; // 0 for startAngle, 1 for endAngle
    let minSweep = Infinity;
    let targetPoint: Point2D | null = null;
    let targetTheta = 0;
    let boundaryEntityId = '';

    const isExtendingEnd = distEnd < distStart;
    extendedPointIndex = isExtendingEnd ? 1 : 0;

    // 2. 遍歷其他圖元，尋找與目標圓周的交點
    for (const boundary of boundaryEntities) {
      let pts: Point2D[] = [];

      if (boundary.type === 'line') {
        pts = intersectCircleLine(center, radius, boundary);
      } else if (boundary.type === 'arc') {
        pts = intersectCircleArc(center, radius, boundary);
      } else if (boundary.type === 'circle') {
        pts = intersectCircleCircleEntity(center, radius, boundary);
      } else if (boundary.type === 'polyline') {
        pts = intersectCirclePolyline(center, radius, boundary);
      }

      for (const p of pts) {
        const theta = normalizeAngle(Math.atan2(p.y - center.y, p.x - center.x));

        let sweep = 0;
        if (isExtendingEnd) {
          // 延伸終點: 沿著圓弧既有方向向前延伸
          sweep = isCW ? normalizeAngle(eAngle - theta) : normalizeAngle(theta - eAngle);
        } else {
          // 延伸起點: 朝圓弧既有方向的反方向延伸
          sweep = isCW ? normalizeAngle(theta - sAngle) : normalizeAngle(sAngle - theta);
        }

        // 交點必須落在未掃掠區間內 (sweep > 1e-4) 且小於等於未掃掠最大跨度
        if (sweep > 1e-4 && sweep <= unSweptRegion + 1e-5) {
          if (sweep < minSweep) {
            minSweep = sweep;
            targetPoint = p;
            targetTheta = theta;
            boundaryEntityId = boundary.id;
          }
        }
      }
    }

    // 3. 若找到有效交點，生成結果
    if (targetPoint && boundaryEntityId) {
      const boundaryEntity = boundaryEntities.find((e) => e.id === boundaryEntityId)!;

      // 計算延伸後的 startAngle 與 endAngle
      let newStartAngle = sAngle;
      let newEndAngle = eAngle;
      if (isExtendingEnd) {
        newEndAngle = isCW ? normalizeAngle(eAngle - minSweep) : normalizeAngle(eAngle + minSweep);
      } else {
        newStartAngle = isCW ? normalizeAngle(sAngle + minSweep) : normalizeAngle(sAngle - minSweep);
      }

      const extendedEntity: ArcEntity = {
        ...target,
        startAngle: newStartAngle,
        endAngle: newEndAngle,
        clockwise: isCW,
      };

      let generatedConstraint: Constraint | undefined = undefined;
      let isEndpoint = false;
      let boundaryPointIndex = 0;

      if (boundaryEntity.type === 'line') {
        const dStart = getDistance(boundaryEntity.start, targetPoint);
        const dEnd = getDistance(boundaryEntity.end, targetPoint);
        if (dStart < 1e-3 || dEnd < 1e-3) {
          isEndpoint = true;
          boundaryPointIndex = dStart < dEnd ? 0 : 1;
        }
      } else if (boundaryEntity.type === 'arc') {
        const pStart = {
          x: boundaryEntity.center.x + boundaryEntity.radius * Math.cos(boundaryEntity.startAngle),
          y: boundaryEntity.center.y + boundaryEntity.radius * Math.sin(boundaryEntity.startAngle),
        };
        const pEnd = {
          x: boundaryEntity.center.x + boundaryEntity.radius * Math.cos(boundaryEntity.endAngle),
          y: boundaryEntity.center.y + boundaryEntity.radius * Math.sin(boundaryEntity.endAngle),
        };
        const dStart = getDistance(pStart, targetPoint);
        const dEnd = getDistance(pEnd, targetPoint);
        if (dStart < 1e-3 || dEnd < 1e-3) {
          isEndpoint = true;
          boundaryPointIndex = dStart < dEnd ? 0 : 1;
        }
      } else if (boundaryEntity.type === 'polyline') {
        let minD = Infinity;
        let closestIdx = 0;
        for (let i = 0; i < boundaryEntity.points.length; i++) {
          const d = getDistance(boundaryEntity.points[i], targetPoint);
          if (d < minD) {
            minD = d;
            closestIdx = i;
          }
        }
        if (minD < 1e-3) {
          isEndpoint = true;
          boundaryPointIndex = closestIdx;
        }
      }

      if (isEndpoint) {
        const uuid = Math.random().toString(36).substring(2, 11);
        generatedConstraint = {
          id: `c-coincident-${targetEntityId}-${boundaryEntityId}-${uuid}`,
          type: 'coincident',
          entityIds: [targetEntityId, boundaryEntityId],
          pointIndices: [extendedPointIndex, boundaryPointIndex],
        };
      }

      return {
        originalEntityId: targetEntityId,
        extendedEntity,
        boundaryEntityId,
        targetPoint,
        generatedConstraint,
      };
    }
  }

  return null;
}
