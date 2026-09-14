import { CADEntity2D, Point2D } from '../../types/cad';
import { findAllIntersections, isAngleOnArc } from './IntersectionEngine';

export type SnapType =
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'quadrant'
  | 'intersection'
  | 'extension'
  | 'perpendicular'
  | 'tangent'
  | 'parallel'
  | 'nearest';

export interface SnapResult {
  point: Point2D;
  type: SnapType;
  entityId: string;
  pointIndex?: number;
}

interface SnapCandidate {
  point: Point2D;
  type: SnapType;
  entityId: string;
  pointIndex?: number;
  distance: number;
}

export const SNAP_PRIORITY: Record<string, number> = {
  endpoint: 1,
  center: 2,
  midpoint: 3,
  quadrant: 4,
  intersection: 5,
  perpendicular: 6,
  tangent: 7,
  extension: 8,
  parallel: 9,
  nearest: 10
};

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
  screenThreshold: number = 15,
  basePoint?: Point2D,
  activeModes?: Record<string, boolean>
): SnapResult | null {
  const worldThreshold = screenThreshold / scale;
  const candidates: SnapCandidate[] = [];

  const checkSnap = (
    point: Point2D,
    type: SnapType,
    entityId: string,
    pointIndex?: number
  ) => {
    if (activeModes && activeModes[type] === false) {
      return;
    }

    const dist = getDistance(mouseWorld, point);
    let threshold = worldThreshold;
    if (type === 'extension') {
      threshold = Math.max(worldThreshold, 18 / scale);
    }
    if (dist > threshold) {
      return;
    }

    candidates.push({
      point,
      type,
      entityId,
      pointIndex,
      distance: dist,
    });
  };

  for (const entity of entities) {
    if (entity.visible === false) {
      continue;
    }

    if (entity.type === 'line') {
      checkSnap(entity.start, 'endpoint', entity.id, 0);
      checkSnap(entity.end, 'endpoint', entity.id, 1);
      checkSnap(getMidpoint(entity.start, entity.end), 'midpoint', entity.id);

      // Perpendicular snap
      if (basePoint) {
        const A = entity.start;
        const B = entity.end;
        const distToStart = getDistance(basePoint, A);
        const distToEnd = getDistance(basePoint, B);
        if (distToStart >= 1e-4 && distToEnd >= 1e-4) {
          const dx = B.x - A.x;
          const dy = B.y - A.y;
          const lenSq = dx * dx + dy * dy;
          if (lenSq > 1e-9) {
            const t = ((basePoint.x - A.x) * dx + (basePoint.y - A.y) * dy) / lenSq;
            if (t >= 0 && t <= 1) {
              const pProj = {
                x: A.x + t * dx,
                y: A.y + t * dy,
              };
              checkSnap(pProj, 'perpendicular', entity.id);
            }
          }
        }
      }

      // Extension snap
      if (activeModes?.extension !== false) {
        const A = entity.start;
        const B = entity.end;
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq > 1e-9) {
          const t = ((mouseWorld.x - A.x) * dx + (mouseWorld.y - A.y) * dy) / lenSq;
          if (t < 0 || t > 1) {
            const P = {
              x: A.x + t * dx,
              y: A.y + t * dy,
            };
            const distToLine = getDistance(mouseWorld, P);
            if (distToLine <= Math.max(worldThreshold, 18 / scale)) {
              const nearestEnd = t < 0 ? A : B;
              const distToEndpoint = getDistance(P, nearestEnd);
              if (distToEndpoint <= 2000 / scale) {
                checkSnap(P, 'extension', entity.id);
              }
            }
          }
        }
      }

      // Parallel snap
      if (basePoint && activeModes?.parallel !== false) {
        const A = entity.start;
        const B = entity.end;
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const lenV2 = dx * dx + dy * dy;
        if (lenV2 > 1e-9) {
          const u = {
            x: mouseWorld.x - basePoint.x,
            y: mouseWorld.y - basePoint.y,
          };
          const lenU2 = u.x * u.x + u.y * u.y;
          if (lenU2 > 1e-9) {
            const lenV = Math.sqrt(lenV2);
            const lenU = Math.sqrt(lenU2);
            const dot = u.x * dx + u.y * dy;
            const cosTheta = Math.abs(dot) / (lenU * lenV);
            if (cosTheta >= 0.9990482) { // Math.cos(2.5 * Math.PI / 180)
              const sign = dot >= 0 ? 1 : -1;
              const P = {
                x: basePoint.x + sign * lenU * (dx / lenV),
                y: basePoint.y + sign * lenU * (dy / lenV),
              };
              checkSnap(P, 'parallel', entity.id);
            }
          }
        }
      }
    } else if (entity.type === 'circle') {
      checkSnap(entity.center, 'center', entity.id, 0);

      // Quadrants: 0, pi/2, pi, 3pi/2
      const angles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
      for (const angle of angles) {
        const quadPoint = {
          x: entity.center.x + entity.radius * Math.cos(angle),
          y: entity.center.y + entity.radius * Math.sin(angle),
        };
        checkSnap(quadPoint, 'quadrant', entity.id);
      }

      // Tangent snap
      if (basePoint) {
        const C = entity.center;
        const R = entity.radius;
        const dx = basePoint.x - C.x;
        const dy = basePoint.y - C.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > R + 1e-9) {
          const theta = Math.atan2(dy, dx);
          const alpha = Math.acos(R / d);
          const theta1 = theta + alpha;
          const theta2 = theta - alpha;

          const t1 = {
            x: C.x + R * Math.cos(theta1),
            y: C.y + R * Math.sin(theta1),
          };
          const t2 = {
            x: C.x + R * Math.cos(theta2),
            y: C.y + R * Math.sin(theta2),
          };

          checkSnap(t1, 'tangent', entity.id);
          checkSnap(t2, 'tangent', entity.id);
        }
      } else {
        const C = entity.center;
        const R = entity.radius;
        const d = Math.hypot(mouseWorld.x - C.x, mouseWorld.y - C.y);
        const distToCircumference = Math.abs(d - R);
        if (distToCircumference <= worldThreshold) {
          const angle = Math.atan2(mouseWorld.y - C.y, mouseWorld.x - C.x);
          const projPt = {
            x: C.x + R * Math.cos(angle),
            y: C.y + R * Math.sin(angle),
          };
          checkSnap(projPt, 'tangent', entity.id);
        }
      }
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

      // Arc midpoint snap calculation
      const startAngle = entity.startAngle;
      const endAngle = entity.endAngle;
      const sweep = endAngle < startAngle
        ? (endAngle + 2 * Math.PI) - startAngle
        : endAngle - startAngle;
      const midAngle = (startAngle + sweep / 2) % (2 * Math.PI);
      const arcMid = {
        x: entity.center.x + entity.radius * Math.cos(midAngle),
        y: entity.center.y + entity.radius * Math.sin(midAngle),
      };
      checkSnap(arcMid, 'midpoint', entity.id);

      // Quadrants: 0, pi/2, pi, 3pi/2 (check if angle lies on arc)
      const angles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
      for (const angle of angles) {
        if (isAngleOnArc(angle, entity.startAngle, entity.endAngle)) {
          const quadPoint = {
            x: entity.center.x + entity.radius * Math.cos(angle),
            y: entity.center.y + entity.radius * Math.sin(angle),
          };
          checkSnap(quadPoint, 'quadrant', entity.id);
        }
      }

      // Tangent snap
      if (basePoint) {
        const C = entity.center;
        const R = entity.radius;
        const dx = basePoint.x - C.x;
        const dy = basePoint.y - C.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > R + 1e-9) {
          const theta = Math.atan2(dy, dx);
          const alpha = Math.acos(R / d);
          const theta1 = theta + alpha;
          const theta2 = theta - alpha;

          if (isAngleOnArc(theta1, entity.startAngle, entity.endAngle)) {
            const t1 = {
              x: C.x + R * Math.cos(theta1),
              y: C.y + R * Math.sin(theta1),
            };
            checkSnap(t1, 'tangent', entity.id);
          }

          if (isAngleOnArc(theta2, entity.startAngle, entity.endAngle)) {
            const t2 = {
              x: C.x + R * Math.cos(theta2),
              y: C.y + R * Math.sin(theta2),
            };
            checkSnap(t2, 'tangent', entity.id);
          }
        }
      } else {
        const C = entity.center;
        const R = entity.radius;
        const d = Math.hypot(mouseWorld.x - C.x, mouseWorld.y - C.y);
        const distToCircumference = Math.abs(d - R);
        if (distToCircumference <= worldThreshold) {
          const angle = Math.atan2(mouseWorld.y - C.y, mouseWorld.x - C.x);
          if (isAngleOnArc(angle, entity.startAngle, entity.endAngle)) {
            const projPt = {
              x: C.x + R * Math.cos(angle),
              y: C.y + R * Math.sin(angle),
            };
            checkSnap(projPt, 'tangent', entity.id);
          }
        }
      }
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

      // Perpendicular snap
      if (basePoint) {
        const len = entity.points.length;
        if (len > 1) {
          const segmentsCount = entity.closed ? len : len - 1;
          for (let i = 0; i < segmentsCount; i++) {
            const A = entity.points[i];
            const B = entity.points[(i + 1) % len];
            const distToA = getDistance(basePoint, A);
            const distToB = getDistance(basePoint, B);
            if (distToA >= 1e-4 && distToB >= 1e-4) {
              const dx = B.x - A.x;
              const dy = B.y - A.y;
              const lenSq = dx * dx + dy * dy;
              if (lenSq > 1e-9) {
                const t = ((basePoint.x - A.x) * dx + (basePoint.y - A.y) * dy) / lenSq;
                if (t >= 0 && t <= 1) {
                  const pProj = {
                    x: A.x + t * dx,
                    y: A.y + t * dy,
                  };
                  checkSnap(pProj, 'perpendicular', entity.id);
                }
              }
            }
          }
        }
      }

      // Extension snap
      if (activeModes?.extension !== false) {
        const len = entity.points.length;
        if (len > 1) {
          const segmentsCount = entity.closed ? len : len - 1;
          for (let i = 0; i < segmentsCount; i++) {
            const A = entity.points[i];
            const B = entity.points[(i + 1) % len];
            const dx = B.x - A.x;
            const dy = B.y - A.y;
            const lenSq = dx * dx + dy * dy;
            if (lenSq > 1e-9) {
              const t = ((mouseWorld.x - A.x) * dx + (mouseWorld.y - A.y) * dy) / lenSq;
              if (t < 0 || t > 1) {
                const P = {
                  x: A.x + t * dx,
                  y: A.y + t * dy,
                };
                const distToLine = getDistance(mouseWorld, P);
                if (distToLine <= Math.max(worldThreshold, 18 / scale)) {
                  const nearestEnd = t < 0 ? A : B;
                  const distToEndpoint = getDistance(P, nearestEnd);
                  if (distToEndpoint <= 2000 / scale) {
                    checkSnap(P, 'extension', entity.id);
                  }
                }
              }
            }
          }
        }
      }

      // Parallel snap
      if (basePoint && activeModes?.parallel !== false) {
        const len = entity.points.length;
        if (len > 1) {
          const segmentsCount = entity.closed ? len : len - 1;
          for (let i = 0; i < segmentsCount; i++) {
            const A = entity.points[i];
            const B = entity.points[(i + 1) % len];
            const dx = B.x - A.x;
            const dy = B.y - A.y;
            const lenV2 = dx * dx + dy * dy;
            if (lenV2 > 1e-9) {
              const u = {
                x: mouseWorld.x - basePoint.x,
                y: mouseWorld.y - basePoint.y,
              };
              const lenU2 = u.x * u.x + u.y * u.y;
              if (lenU2 > 1e-9) {
                const lenV = Math.sqrt(lenV2);
                const lenU = Math.sqrt(lenU2);
                const dot = u.x * dx + u.y * dy;
                const cosTheta = Math.abs(dot) / (lenU * lenV);
                if (cosTheta >= 0.9990482) { // Math.cos(2.5 * Math.PI / 180)
                  const sign = dot >= 0 ? 1 : -1;
                  const P = {
                    x: basePoint.x + sign * lenU * (dx / lenV),
                    y: basePoint.y + sign * lenU * (dy / lenV),
                  };
                  checkSnap(P, 'parallel', entity.id);
                }
              }
            }
          }
        }
      }
    }
  }

  // Intersections
  const intersections = findAllIntersections(entities);
  for (const inter of intersections) {
    checkSnap(inter.point, 'intersection', inter.entityAId);
  }

  if (candidates.length === 0) {
    return null;
  }

  // Dual-sorting: priority first (smaller value = higher priority), then distance (closer = higher priority)
  candidates.sort((a, b) => (SNAP_PRIORITY[a.type] - SNAP_PRIORITY[b.type]) || (a.distance - b.distance));

  const best = candidates[0];
  return {
    point: best.point,
    type: best.type,
    entityId: best.entityId,
    pointIndex: best.pointIndex,
  };
}
