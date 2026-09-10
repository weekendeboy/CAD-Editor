import { CADEntity2D, Point2D } from '../../types/cad';

export type SnapType = 'endpoint' | 'midpoint' | 'center';

export interface SnapResult {
  point: Point2D;
  type: SnapType;
  entityId: string;
  pointIndex?: number;
}

function getDistance(p1: Point2D, p2: Point2D): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function getMidpoint(p1: Point2D, p2: Point2D): Point2D {
  return {
    x: (p1.x + p2.x) / 2,
    y: (p1.y + p2.y) / 2,
  };
}

export function findSnapPoint(
  mouseWorld: Point2D,
  entities: CADEntity2D[],
  scale: number,
  screenThreshold: number = 15
): SnapResult | null {
  const worldThreshold = screenThreshold / scale;
  let closestSnap: SnapResult | null = null;
  let minDistance = worldThreshold;

  const checkSnap = (
    point: Point2D,
    type: SnapType,
    entityId: string,
    pointIndex?: number
  ) => {
    const dist = getDistance(mouseWorld, point);
    if (dist <= minDistance) {
      minDistance = dist;
      closestSnap = { point, type, entityId, pointIndex };
    }
  };

  for (const entity of entities) {
    if (entity.type === 'line') {
      checkSnap(entity.start, 'endpoint', entity.id, 0);
      checkSnap(entity.end, 'endpoint', entity.id, 1);
      checkSnap(getMidpoint(entity.start, entity.end), 'midpoint', entity.id);
    } else if (entity.type === 'circle') {
      checkSnap(entity.center, 'center', entity.id, 0);
    } else if (entity.type === 'arc') {
      const arcStart = {
        x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
        y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
      };
      const arcEnd = {
        x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
        y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
      };
      checkSnap(arcStart, 'endpoint', entity.id, 0);
      checkSnap(arcEnd, 'endpoint', entity.id, 1);
      checkSnap(entity.center, 'center', entity.id, 2);
    } else if (entity.type === 'polyline') {
      // endpoints
      for (let i = 0; i < entity.points.length; i++) {
        checkSnap(entity.points[i], 'endpoint', entity.id, i);
      }

      // midpoints
      const len = entity.points.length;
      if (len > 1) {
        const segmentsCount = entity.closed ? len : len - 1;
        for (let i = 0; i < segmentsCount; i++) {
          const p1 = entity.points[i];
          const p2 = entity.points[(i + 1) % len];
          checkSnap(getMidpoint(p1, p2), 'midpoint', entity.id);
        }
      }
    }
  }

  return closestSnap;
}
