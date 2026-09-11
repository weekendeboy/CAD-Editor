import {
  CADEntity2D,
  LineEntity,
  CircleEntity,
  ArcEntity,
  PolylineEntity,
  Point2D,
  Constraint,
  EntityState,
} from '../../types/cad';

export const SOLVER_MAX_ITERATIONS = 80;
export const SOLVER_TOLERANCE = 1e-4;

export interface SolverResult {
  entities: CADEntity2D[];
  iterations: number;
  maxDisp: number;
  converged: boolean;
  conflictEntityIds: string[];
}

export interface SketchDofState {
  totalDof: number;
  state: EntityState;
  entityStates: Record<string, EntityState>;
}

interface PointRef {
  get: () => Point2D;
  set: (p: Point2D) => void;
  entityId: string;
  pointIndex: number;
}

/**
 * Gets a reference object with getter and setter for a specific point on an entity based on pointIndex.
 */
function getPointRef(entity: CADEntity2D, pointIndex: number = 0): PointRef | null {
  if (entity.type === 'line') {
    if (pointIndex === 1) {
      return {
        get: () => ({ ...entity.end }),
        set: (p: Point2D) => {
          entity.end = { ...p };
        },
        entityId: entity.id,
        pointIndex: 1,
      };
    }
    return {
      get: () => ({ ...entity.start }),
      set: (p: Point2D) => {
        entity.start = { ...p };
      },
      entityId: entity.id,
      pointIndex: 0,
    };
  }

  if (entity.type === 'circle') {
    return {
      get: () => ({ ...entity.center }),
      set: (p: Point2D) => {
        entity.center = { ...p };
      },
      entityId: entity.id,
      pointIndex: 0,
    };
  }

  if (entity.type === 'arc') {
    if (pointIndex === 0) {
      return {
        get: () => ({
          x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
          y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
        }),
        set: (p: Point2D) => {
          const dx = p.x - entity.center.x;
          const dy = p.y - entity.center.y;
          entity.startAngle = Math.atan2(dy, dx);
        },
        entityId: entity.id,
        pointIndex: 0,
      };
    }
    if (pointIndex === 1) {
      return {
        get: () => ({
          x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
          y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
        }),
        set: (p: Point2D) => {
          const dx = p.x - entity.center.x;
          const dy = p.y - entity.center.y;
          entity.endAngle = Math.atan2(dy, dx);
        },
        entityId: entity.id,
        pointIndex: 1,
      };
    }
    return {
      get: () => ({ ...entity.center }),
      set: (p: Point2D) => {
        entity.center = { ...p };
      },
      entityId: entity.id,
      pointIndex: 2,
    };
  }

  if (entity.type === 'polyline') {
    const idx = Math.min(Math.max(0, pointIndex), entity.points.length - 1);
    return {
      get: () => ({ ...entity.points[idx] }),
      set: (p: Point2D) => {
        if (entity.points[idx]) {
          entity.points[idx] = { ...p };
        }
      },
      entityId: entity.id,
      pointIndex: idx,
    };
  }

  return null;
}

/**
 * Shallow/selective clone for single entity (Zero GC for unconstrained entities).
 */
function cloneEntity(entity: CADEntity2D): CADEntity2D {
  if (entity.type === 'line') {
    return {
      ...entity,
      start: { ...entity.start },
      end: { ...entity.end },
    };
  }
  if (entity.type === 'circle') {
    return {
      ...entity,
      center: { ...entity.center },
    };
  }
  if (entity.type === 'arc') {
    return {
      ...entity,
      center: { ...entity.center },
    };
  }
  return {
    ...entity,
    points: entity.points.map((p) => ({ ...p })),
    bulges: entity.bulges ? [...entity.bulges] : undefined,
  };
}

/**
 * Identifies set of fixed point keys ("entityId:pointIndex") from 'fix' constraints.
 */
function getFixedPointKeys(constraints: Constraint[]): Set<string> {
  const fixedKeys = new Set<string>();
  for (const c of constraints) {
    if (c.type === 'fix') {
      for (let i = 0; i < c.entityIds.length; i++) {
        const entId = c.entityIds[i];
        const ptIdx = c.pointIndices ? c.pointIndices[i] ?? 0 : 0;
        fixedKeys.add(`${entId}:${ptIdx}`);
      }
    }
  }
  return fixedKeys;
}

/**
 * Main solver function using Position-Based Relaxation with Subgraph Partitioning.
 */
export function solveConstraints(
  entities: CADEntity2D[],
  constraints: Constraint[]
): SolverResult {
  // Fast path for zero constraints
  if (!constraints || constraints.length === 0) {
    return {
      entities,
      iterations: 0,
      maxDisp: 0,
      converged: true,
      conflictEntityIds: [],
    };
  }

  // Subgraph filtering: collect only entity IDs involved in constraints
  const constrainedIdSet = new Set<string>();
  for (const c of constraints) {
    if (c.entityIds) {
      for (const id of c.entityIds) {
        if (id) {
          constrainedIdSet.add(id);
        }
      }
    }
  }

  if (constrainedIdSet.size === 0) {
    return {
      entities,
      iterations: 0,
      maxDisp: 0,
      converged: true,
      conflictEntityIds: [],
    };
  }

  // Work map: only clone constrained entities
  const workingMap = new Map<string, CADEntity2D>();
  for (const e of entities) {
    if (constrainedIdSet.has(e.id)) {
      workingMap.set(e.id, cloneEntity(e));
    }
  }

  const fixedPointKeys = getFixedPointKeys(constraints);

  const isFixed = (entityId: string, pointIndex: number): boolean => {
    return fixedPointKeys.has(`${entityId}:${pointIndex}`);
  };

  let maxDisp = 0;
  let converged = false;
  let iterations = 0;

  for (iterations = 0; iterations < SOLVER_MAX_ITERATIONS; iterations++) {
    maxDisp = 0;

    for (const constraint of constraints) {
      const e1 = workingMap.get(constraint.entityIds[0] || '');
      const e2 = workingMap.get(constraint.entityIds[1] || '');

      switch (constraint.type) {
        case 'fix': {
          break;
        }

        case 'coincident': {
          if (!e1) break;
          const idx1 = constraint.pointIndices?.[0] ?? 0;
          const idx2 = constraint.pointIndices?.[1] ?? 0;

          const ref1 = getPointRef(e1, idx1);
          const ref2 = e2 ? getPointRef(e2, idx2) : null;

          if (ref1 && ref2) {
            const p1 = ref1.get();
            const p2 = ref2.get();

            const f1 = isFixed(e1.id, idx1);
            const f2 = isFixed(e2.id, idx2);

            if (f1 && f2) break;

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const dist = Math.hypot(dx, dy);
            maxDisp = Math.max(maxDisp, dist);

            if (f1) {
              ref2.set(p1);
            } else if (f2) {
              ref1.set(p2);
            } else {
              const midX = (p1.x + p2.x) / 2;
              const midY = (p1.y + p2.y) / 2;
              ref1.set({ x: midX, y: midY });
              ref2.set({ x: midX, y: midY });
            }
          }
          break;
        }

        case 'horizontal': {
          if (!e1) break;
          if (e1.type === 'line') {
            const f0 = isFixed(e1.id, 0);
            const f1 = isFixed(e1.id, 1);
            const dy = Math.abs(e1.end.y - e1.start.y);
            maxDisp = Math.max(maxDisp, dy);

            if (f0 && f1) break;
            if (f0) {
              e1.end.y = e1.start.y;
            } else if (f1) {
              e1.start.y = e1.end.y;
            } else {
              const midY = (e1.start.y + e1.end.y) / 2;
              e1.start.y = midY;
              e1.end.y = midY;
            }
          } else if (e2) {
            const idx1 = constraint.pointIndices?.[0] ?? 0;
            const idx2 = constraint.pointIndices?.[1] ?? 0;
            const ref1 = getPointRef(e1, idx1);
            const ref2 = getPointRef(e2, idx2);
            if (ref1 && ref2) {
              const p1 = ref1.get();
              const p2 = ref2.get();
              const dy = Math.abs(p2.y - p1.y);
              maxDisp = Math.max(maxDisp, dy);
              const f1 = isFixed(e1.id, idx1);
              const f2 = isFixed(e2.id, idx2);

              if (f1 && !f2) {
                ref2.set({ x: p2.x, y: p1.y });
              } else if (f2 && !f1) {
                ref1.set({ x: p1.x, y: p2.y });
              } else if (!f1 && !f2) {
                const midY = (p1.y + p2.y) / 2;
                ref1.set({ x: p1.x, y: midY });
                ref2.set({ x: p2.x, y: midY });
              }
            }
          }
          break;
        }

        case 'vertical': {
          if (!e1) break;
          if (e1.type === 'line') {
            const f0 = isFixed(e1.id, 0);
            const f1 = isFixed(e1.id, 1);
            const dx = Math.abs(e1.end.x - e1.start.x);
            maxDisp = Math.max(maxDisp, dx);

            if (f0 && f1) break;
            if (f0) {
              e1.end.x = e1.start.x;
            } else if (f1) {
              e1.start.x = e1.end.x;
            } else {
              const midX = (e1.start.x + e1.end.x) / 2;
              e1.start.x = midX;
              e1.end.x = midX;
            }
          } else if (e2) {
            const idx1 = constraint.pointIndices?.[0] ?? 0;
            const idx2 = constraint.pointIndices?.[1] ?? 0;
            const ref1 = getPointRef(e1, idx1);
            const ref2 = getPointRef(e2, idx2);
            if (ref1 && ref2) {
              const p1 = ref1.get();
              const p2 = ref2.get();
              const dx = Math.abs(p2.x - p1.x);
              maxDisp = Math.max(maxDisp, dx);
              const f1 = isFixed(e1.id, idx1);
              const f2 = isFixed(e2.id, idx2);

              if (f1 && !f2) {
                ref2.set({ x: p1.x, y: p2.y });
              } else if (f2 && !f1) {
                ref1.set({ x: p2.x, y: p1.y });
              } else if (!f1 && !f2) {
                const midX = (p1.x + p2.x) / 2;
                ref1.set({ x: midX, y: p1.y });
                ref2.set({ x: midX, y: p2.y });
              }
            }
          }
          break;
        }

        case 'length': {
          if (!e1 || e1.type !== 'line') break;
          const targetLen = constraint.value ?? Math.hypot(e1.end.x - e1.start.x, e1.end.y - e1.start.y);
          const dx = e1.end.x - e1.start.x;
          const dy = e1.end.y - e1.start.y;
          const currLen = Math.hypot(dx, dy);

          if (currLen < 1e-9) break;

          const err = Math.abs(currLen - targetLen);
          maxDisp = Math.max(maxDisp, err);

          const factor = targetLen / currLen;
          const midX = (e1.start.x + e1.end.x) / 2;
          const midY = (e1.start.y + e1.end.y) / 2;

          const halfDx = (dx * factor) / 2;
          const halfDy = (dy * factor) / 2;

          const f0 = isFixed(e1.id, 0);
          const f1 = isFixed(e1.id, 1);

          if (f0 && !f1) {
            e1.end.x = e1.start.x + dx * factor;
            e1.end.y = e1.start.y + dy * factor;
          } else if (f1 && !f0) {
            e1.start.x = e1.end.x - dx * factor;
            e1.start.y = e1.end.y - dy * factor;
          } else if (!f0 && !f1) {
            e1.start.x = midX - halfDx;
            e1.start.y = midY - halfDy;
            e1.end.x = midX + halfDx;
            e1.end.y = midY + halfDy;
          }
          break;
        }

        case 'distance': {
          if (!e1) break;
          const idx1 = constraint.pointIndices?.[0] ?? 0;
          const idx2 = constraint.pointIndices?.[1] ?? 0;

          const ref1 = getPointRef(e1, idx1);
          const ref2 = e2 ? getPointRef(e2, idx2) : null;

          if (ref1 && ref2) {
            const p1 = ref1.get();
            const p2 = ref2.get();
            const targetDist = constraint.value ?? Math.hypot(p2.x - p1.x, p2.y - p1.y);

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const currDist = Math.hypot(dx, dy);

            if (currDist < 1e-9) break;

            const err = Math.abs(currDist - targetDist);
            maxDisp = Math.max(maxDisp, err);

            const scale = targetDist / currDist;
            const shiftX = (dx * (scale - 1)) / 2;
            const shiftY = (dy * (scale - 1)) / 2;

            const f1 = isFixed(e1.id, idx1);
            const f2 = isFixed(e2.id, idx2);

            if (f1 && !f2) {
              ref2.set({ x: p1.x + dx * scale, y: p1.y + dy * scale });
            } else if (f2 && !f1) {
              ref1.set({ x: p2.x - dx * scale, y: p2.y - dy * scale });
            } else if (!f1 && !f2) {
              ref1.set({ x: p1.x - shiftX, y: p1.y - shiftY });
              ref2.set({ x: p2.x + shiftX, y: p2.y + shiftY });
            }
          }
          break;
        }

        case 'distance_x': {
          if (!e1 || !e2) break;
          const idx1 = constraint.pointIndices?.[0] ?? 0;
          const idx2 = constraint.pointIndices?.[1] ?? 0;

          const ref1 = getPointRef(e1, idx1);
          const ref2 = getPointRef(e2, idx2);

          if (ref1 && ref2) {
            const p1 = ref1.get();
            const p2 = ref2.get();
            const targetDx = constraint.value ?? Math.abs(p2.x - p1.x);
            const currDx = p2.x - p1.x;
            const err = Math.abs(Math.abs(currDx) - targetDx);
            maxDisp = Math.max(maxDisp, err);

            const sign = currDx >= 0 ? 1 : -1;
            const targetX = p1.x + sign * targetDx;
            const diffX = p2.x - targetX;

            const f1 = isFixed(e1.id, idx1);
            const f2 = isFixed(e2.id, idx2);

            if (f1 && !f2) {
              ref2.set({ x: targetX, y: p2.y });
            } else if (f2 && !f1) {
              ref1.set({ x: p2.x - sign * targetDx, y: p1.y });
            } else if (!f1 && !f2) {
              ref1.set({ x: p1.x + diffX / 2, y: p1.y });
              ref2.set({ x: p2.x - diffX / 2, y: p2.y });
            }
          }
          break;
        }

        case 'distance_y': {
          if (!e1 || !e2) break;
          const idx1 = constraint.pointIndices?.[0] ?? 0;
          const idx2 = constraint.pointIndices?.[1] ?? 0;

          const ref1 = getPointRef(e1, idx1);
          const ref2 = getPointRef(e2, idx2);

          if (ref1 && ref2) {
            const p1 = ref1.get();
            const p2 = ref2.get();
            const targetDy = constraint.value ?? Math.abs(p2.y - p1.y);
            const currDy = p2.y - p1.y;
            const err = Math.abs(Math.abs(currDy) - targetDy);
            maxDisp = Math.max(maxDisp, err);

            const sign = currDy >= 0 ? 1 : -1;
            const targetY = p1.y + sign * targetDy;
            const diffY = p2.y - targetY;

            const f1 = isFixed(e1.id, idx1);
            const f2 = isFixed(e2.id, idx2);

            if (f1 && !f2) {
              ref2.set({ x: p2.x, y: targetY });
            } else if (f2 && !f1) {
              ref1.set({ x: p1.x, y: p2.y - sign * targetDy });
            } else if (!f1 && !f2) {
              ref1.set({ x: p1.x, y: p1.y + diffY / 2 });
              ref2.set({ x: p2.x, y: p2.y - diffY / 2 });
            }
          }
          break;
        }

        case 'parallel': {
          if (!e1 || !e2 || e1.type !== 'line' || e2.type !== 'line') break;

          const dx1 = e1.end.x - e1.start.x;
          const dy1 = e1.end.y - e1.start.y;
          const len1 = Math.hypot(dx1, dy1);

          const dx2 = e2.end.x - e2.start.x;
          const dy2 = e2.end.y - e2.start.y;
          const len2 = Math.hypot(dx2, dy2);

          if (len1 < 1e-9 || len2 < 1e-9) break;

          const angle1 = Math.atan2(dy1, dx1);
          const angle2 = Math.atan2(dy2, dx2);

          let diffAngle = angle2 - angle1;
          while (diffAngle > Math.PI / 2) diffAngle -= Math.PI;
          while (diffAngle < -Math.PI / 2) diffAngle += Math.PI;

          maxDisp = Math.max(maxDisp, Math.abs(diffAngle) * ((len1 + len2) / 2));

          const f1_0 = isFixed(e1.id, 0);
          const f1_1 = isFixed(e1.id, 1);
          const f2_0 = isFixed(e2.id, 0);
          const f2_1 = isFixed(e2.id, 1);

          if (!f2_0 && !f2_1) {
            const mid2X = (e2.start.x + e2.end.x) / 2;
            const mid2Y = (e2.start.y + e2.end.y) / 2;
            const nx = Math.cos(angle1) * len2;
            const ny = Math.sin(angle1) * len2;
            e2.start.x = mid2X - nx / 2;
            e2.start.y = mid2Y - ny / 2;
            e2.end.x = mid2X + nx / 2;
            e2.end.y = mid2Y + ny / 2;
          } else if (!f1_0 && !f1_1) {
            const mid1X = (e1.start.x + e1.end.x) / 2;
            const mid1Y = (e1.start.y + e1.end.y) / 2;
            const nx = Math.cos(angle2) * len1;
            const ny = Math.sin(angle2) * len1;
            e1.start.x = mid1X - nx / 2;
            e1.start.y = mid1Y - ny / 2;
            e1.end.x = mid1X + nx / 2;
            e1.end.y = mid1Y + ny / 2;
          }
          break;
        }

        case 'perpendicular': {
          if (!e1 || !e2 || e1.type !== 'line' || e2.type !== 'line') break;

          const dx1 = e1.end.x - e1.start.x;
          const dy1 = e1.end.y - e1.start.y;
          const len1 = Math.hypot(dx1, dy1);

          const dx2 = e2.end.x - e2.start.x;
          const dy2 = e2.end.y - e2.start.y;
          const len2 = Math.hypot(dx2, dy2);

          if (len1 < 1e-9 || len2 < 1e-9) break;

          const dot = dx1 * dx2 + dy1 * dy2;
          const normDot = dot / (len1 * len2);
          maxDisp = Math.max(maxDisp, Math.abs(normDot) * ((len1 + len2) / 2));

          const f2_0 = isFixed(e2.id, 0);
          const f2_1 = isFixed(e2.id, 1);

          if (!f2_0 && !f2_1) {
            const perpX = -dy1 / len1;
            const perpY = dx1 / len1;
            const mid2X = (e2.start.x + e2.end.x) / 2;
            const mid2Y = (e2.start.y + e2.end.y) / 2;
            e2.start.x = mid2X - (perpX * len2) / 2;
            e2.start.y = mid2Y - (perpY * len2) / 2;
            e2.end.x = mid2X + (perpX * len2) / 2;
            e2.end.y = mid2Y + (perpY * len2) / 2;
          }
          break;
        }

        case 'tangent': {
          if (!e1 || !e2) break;

          if (e1.type === 'line' && (e2.type === 'circle' || e2.type === 'arc')) {
            const circle = e2;
            const dx = e1.end.x - e1.start.x;
            const dy = e1.end.y - e1.start.y;
            const len = Math.hypot(dx, dy);

            if (len > 1e-9) {
              const nx = -dy / len;
              const ny = dx / len;
              const dist = Math.abs(
                (circle.center.x - e1.start.x) * nx + (circle.center.y - e1.start.y) * ny
              );
              const err = Math.abs(dist - circle.radius);
              maxDisp = Math.max(maxDisp, err);

              const proj =
                (circle.center.x - e1.start.x) * (dx / len) +
                (circle.center.y - e1.start.y) * (dy / len);
              const closestX = e1.start.x + proj * (dx / len);
              const closestY = e1.start.y + proj * (dy / len);

              const cToX = closestX - circle.center.x;
              const cToY = closestY - circle.center.y;
              const cDist = Math.hypot(cToX, cToY);

              if (cDist > 1e-9 && !isFixed(circle.id, 0)) {
                circle.center.x = closestX - (cToX / cDist) * circle.radius;
                circle.center.y = closestY - (cToY / cDist) * circle.radius;
              }
            }
          } else if ((e1.type === 'circle' || e1.type === 'arc') && e2.type === 'line') {
            const circle = e1;
            const line = e2;
            const dx = line.end.x - line.start.x;
            const dy = line.end.y - line.start.y;
            const len = Math.hypot(dx, dy);

            if (len > 1e-9) {
              const nx = -dy / len;
              const ny = dx / len;
              const dist = Math.abs(
                (circle.center.x - line.start.x) * nx + (circle.center.y - line.start.y) * ny
              );
              const err = Math.abs(dist - circle.radius);
              maxDisp = Math.max(maxDisp, err);

              const proj =
                (circle.center.x - line.start.x) * (dx / len) +
                (circle.center.y - line.start.y) * (dy / len);
              const closestX = line.start.x + proj * (dx / len);
              const closestY = line.start.y + proj * (dy / len);

              const cToX = closestX - circle.center.x;
              const cToY = closestY - circle.center.y;
              const cDist = Math.hypot(cToX, cToY);

              if (cDist > 1e-9 && !isFixed(circle.id, 0)) {
                circle.center.x = closestX - (cToX / cDist) * circle.radius;
                circle.center.y = closestY - (cToY / cDist) * circle.radius;
              }
            }
          } else if (
            (e1.type === 'circle' || e1.type === 'arc') &&
            (e2.type === 'circle' || e2.type === 'arc')
          ) {
            const c1 = e1;
            const c2 = e2;
            const dx = c2.center.x - c1.center.x;
            const dy = c2.center.y - c1.center.y;
            const centerDist = Math.hypot(dx, dy);

            if (centerDist > 1e-9) {
              const targetDist = c1.radius + c2.radius;
              const err = Math.abs(centerDist - targetDist);
              maxDisp = Math.max(maxDisp, err);

              const scale = targetDist / centerDist;
              const f1 = isFixed(c1.id, 0);
              const f2 = isFixed(c2.id, 0);

              if (f1 && !f2) {
                c2.center.x = c1.center.x + dx * scale;
                c2.center.y = c1.center.y + dy * scale;
              } else if (f2 && !f1) {
                c1.center.x = c2.center.x - dx * scale;
                c1.center.y = c2.center.y - dy * scale;
              } else if (!f1 && !f2) {
                const midX = (c1.center.x + c2.center.x) / 2;
                const midY = (c1.center.y + c2.center.y) / 2;
                const halfDx = (dx * scale) / 2;
                const halfDy = (dy * scale) / 2;
                c1.center.x = midX - halfDx;
                c1.center.y = midY - halfDy;
                c2.center.x = midX + halfDx;
                c2.center.y = midY + halfDy;
              }
            }
          }
          break;
        }

        case 'equal_length': {
          if (!e1 || !e2 || e1.type !== 'line' || e2.type !== 'line') break;

          const len1 = Math.hypot(e1.end.x - e1.start.x, e1.end.y - e1.start.y);
          const len2 = Math.hypot(e2.end.x - e2.start.x, e2.end.y - e2.start.y);

          const err = Math.abs(len1 - len2);
          maxDisp = Math.max(maxDisp, err);

          const avgLen = (len1 + len2) / 2;

          if (len1 > 1e-9) {
            const dx1 = e1.end.x - e1.start.x;
            const dy1 = e1.end.y - e1.start.y;
            const s1 = avgLen / len1;
            const mid1X = (e1.start.x + e1.end.x) / 2;
            const mid1Y = (e1.start.y + e1.end.y) / 2;
            if (!isFixed(e1.id, 0) && !isFixed(e1.id, 1)) {
              e1.start.x = mid1X - (dx1 * s1) / 2;
              e1.start.y = mid1Y - (dy1 * s1) / 2;
              e1.end.x = mid1X + (dx1 * s1) / 2;
              e1.end.y = mid1Y + (dy1 * s1) / 2;
            }
          }

          if (len2 > 1e-9) {
            const dx2 = e2.end.x - e2.start.x;
            const dy2 = e2.end.y - e2.start.y;
            const s2 = avgLen / len2;
            const mid2X = (e2.start.x + e2.end.x) / 2;
            const mid2Y = (e2.start.y + e2.end.y) / 2;
            if (!isFixed(e2.id, 0) && !isFixed(e2.id, 1)) {
              e2.start.x = mid2X - (dx2 * s2) / 2;
              e2.start.y = mid2Y - (dy2 * s2) / 2;
              e2.end.x = mid2X + (dx2 * s2) / 2;
              e2.end.y = mid2Y + (dy2 * s2) / 2;
            }
          }
          break;
        }

        case 'equal_radius': {
          if (
            !e1 ||
            !e2 ||
            (e1.type !== 'circle' && e1.type !== 'arc') ||
            (e2.type !== 'circle' && e2.type !== 'arc')
          )
            break;

          const r1 = e1.radius;
          const r2 = e2.radius;
          const err = Math.abs(r1 - r2);
          maxDisp = Math.max(maxDisp, err);

          const avgR = (r1 + r2) / 2;
          e1.radius = avgR;
          e2.radius = avgR;
          break;
        }

        case 'angle': {
          if (!e1 || !e2 || e1.type !== 'line' || e2.type !== 'line') break;

          const dx1 = e1.end.x - e1.start.x;
          const dy1 = e1.end.y - e1.start.y;
          const len1 = Math.hypot(dx1, dy1);

          const dx2 = e2.end.x - e2.start.x;
          const dy2 = e2.end.y - e2.start.y;
          const len2 = Math.hypot(dx2, dy2);

          if (len1 < 1e-9 || len2 < 1e-9) break;

          const targetAngleRad = constraint.value ?? Math.PI / 2;
          const currentAngle1 = Math.atan2(dy1, dx1);
          const currentAngle2 = Math.atan2(dy2, dx2);
          const diff = currentAngle2 - currentAngle1 - targetAngleRad;

          maxDisp = Math.max(maxDisp, Math.abs(diff) * ((len1 + len2) / 2));

          if (!isFixed(e2.id, 0) && !isFixed(e2.id, 1)) {
            const newAngle2 = currentAngle1 + targetAngleRad;
            const mid2X = (e2.start.x + e2.end.x) / 2;
            const mid2Y = (e2.start.y + e2.end.y) / 2;
            const nx = Math.cos(newAngle2) * len2;
            const ny = Math.sin(newAngle2) * len2;
            e2.start.x = mid2X - nx / 2;
            e2.start.y = mid2Y - ny / 2;
            e2.end.x = mid2X + nx / 2;
            e2.end.y = mid2Y + ny / 2;
          }
          break;
        }

        default:
          break;
      }
    }

    if (maxDisp < SOLVER_TOLERANCE) {
      converged = true;
      break;
    }
  }

  const conflictEntityIds: string[] = [];
  if (!converged) {
    const conflictSet = new Set<string>();
    constraints.forEach((c) => {
      c.entityIds.forEach((id) => {
        if (id && workingMap.has(id)) {
          conflictSet.add(id);
        }
      });
    });
    conflictEntityIds.push(...Array.from(conflictSet));
  }

  // Result assembly: merge solved working entities with untouched entities in original order
  const resultEntities = entities.map((e) => workingMap.get(e.id) || e);

  return {
    entities: resultEntities,
    iterations: Math.min(iterations + 1, SOLVER_MAX_ITERATIONS),
    maxDisp,
    converged,
    conflictEntityIds,
  };
}

/**
 * Analyzes the degrees of freedom (DOF) of a sketch based on entities and constraints.
 */
export function analyzeSketchDOF(
  entities: CADEntity2D[],
  constraints: Constraint[]
): SketchDofState {
  const constrainedIdSet = new Set<string>();
  if (constraints) {
    for (const c of constraints) {
      if (c.entityIds) {
        for (const id of c.entityIds) {
          if (id) {
            constrainedIdSet.add(id);
          }
        }
      }
    }
  }

  let totalDof = 0;
  const entityDofs: Record<string, number> = {};
  const entityConstraints: Record<string, number> = {};

  entities.forEach((entity) => {
    let dof = 0;
    if (entity.type === 'line') {
      dof = 4;
    } else if (entity.type === 'circle') {
      dof = 3;
    } else if (entity.type === 'arc') {
      dof = 5;
    } else if (entity.type === 'polyline') {
      dof = entity.points.length * 2;
    }
    entityDofs[entity.id] = dof;
    entityConstraints[entity.id] = 0;
  });

  let constrainedTotalDof = 0;
  constrainedIdSet.forEach((id) => {
    if (entityDofs[id] !== undefined) {
      constrainedTotalDof += entityDofs[id];
    }
  });

  if (constraints) {
    constraints.forEach((constraint) => {
      let consumedDof = 1;
      if (constraint.type === 'fix' || constraint.type === 'coincident') {
        consumedDof = 2;
      } else if (constraint.type === 'distance_x' || constraint.type === 'distance_y') {
        consumedDof = 1;
      } else {
        consumedDof = 1;
      }

      constrainedTotalDof -= consumedDof;

      constraint.entityIds.forEach((id) => {
        if (entityConstraints[id] !== undefined) {
          entityConstraints[id] += consumedDof;
        }
      });
    });
  }

  totalDof = constrainedTotalDof;

  let overallState: EntityState = 'UnderDefined';
  if (constrainedIdSet.size > 0) {
    if (totalDof === 0) {
      overallState = 'FullyDefined';
    } else if (totalDof < 0) {
      overallState = 'OverDefined';
    }
  }

  const entityStates: Record<string, EntityState> = {};
  entities.forEach((entity) => {
    if (!constrainedIdSet.has(entity.id)) {
      entityStates[entity.id] = 'UnderDefined';
      return;
    }

    const baseDof = entityDofs[entity.id] || 0;
    const removedDof = entityConstraints[entity.id] || 0;
    const remainingDof = baseDof - removedDof;

    if (overallState === 'OverDefined' || remainingDof < 0) {
      entityStates[entity.id] = 'OverDefined';
    } else if (remainingDof === 0) {
      entityStates[entity.id] = 'FullyDefined';
    } else {
      entityStates[entity.id] = 'UnderDefined';
    }
  });

  return {
    totalDof,
    state: overallState,
    entityStates,
  };
}
