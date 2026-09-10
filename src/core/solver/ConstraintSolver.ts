import { CADEntity2D, Constraint, Point2D, LineEntity, CircleEntity, ArcEntity } from '../../types/cad';
import { SolverResult, SketchDofState, SOLVER_MAX_ITERATIONS, SOLVER_TOLERANCE } from './solverTypes';

export type { SolverResult, SketchDofState };

/**
 * Deep clones a CADEntity2D to ensure immutable operations.
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
  if (entity.type === 'polyline') {
    return {
      ...entity,
      points: entity.points.map((p) => ({ ...p })),
    };
  }
  return JSON.parse(JSON.stringify(entity));
}

/**
 * Gets a reference to a point on an entity based on index.
 */
function getEntityPoint(entity: CADEntity2D, pointIndex: number = 0): Point2D | null {
  if (entity.type === 'line') {
    return pointIndex === 1 ? entity.end : entity.start;
  }
  if (entity.type === 'arc') {
    if (pointIndex === 0) {
      return {
        x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
        y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
      };
    }
    if (pointIndex === 1) {
      return {
        x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
        y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
      };
    }
    return entity.center;
  }
  if (entity.type === 'circle') {
    return entity.center;
  }
  if (entity.type === 'polyline') {
    return entity.points[pointIndex] || entity.points[0] || null;
  }
  return null;
}

/**
 * Updates a point on an entity based on index.
 */
function setEntityPoint(entity: CADEntity2D, pointIndex: number, newPoint: Point2D): void {
  if (entity.type === 'line') {
    if (pointIndex === 1) {
      entity.end = { ...newPoint };
    } else {
      entity.start = { ...newPoint };
    }
  } else if (entity.type === 'arc') {
    if (pointIndex === 0) {
      entity.startAngle = Math.atan2(newPoint.y - entity.center.y, newPoint.x - entity.center.x);
    } else if (pointIndex === 1) {
      entity.endAngle = Math.atan2(newPoint.y - entity.center.y, newPoint.x - entity.center.x);
    } else {
      entity.center = { ...newPoint };
    }
  } else if (entity.type === 'circle') {
    entity.center = { ...newPoint };
  } else if (entity.type === 'polyline') {
    if (entity.points[pointIndex]) {
      entity.points[pointIndex] = { ...newPoint };
    }
  }
}

/**
 * Finds all line entity IDs that simultaneously have conflicting constraints:
 * - A single line having both horizontal and vertical constraints.
 * - A pair of lines simultaneously having both parallel and perpendicular constraints.
 */
function findConflictingLineEntityIds(entities: CADEntity2D[], constraints: Constraint[]): string[] {
  const lineIds = new Set(entities.filter((e) => e.type === 'line').map((e) => e.id));
  const horizontalEntities = new Set<string>();
  const verticalEntities = new Set<string>();
  const pairConstraintsMap = new Map<string, Set<string>>();

  for (const c of constraints) {
    if (c.type === 'horizontal') {
      for (const id of c.entityIds) {
        if (lineIds.has(id)) {
          horizontalEntities.add(id);
        }
      }
    } else if (c.type === 'vertical') {
      for (const id of c.entityIds) {
        if (lineIds.has(id)) {
          verticalEntities.add(id);
        }
      }
    } else if (c.type === 'parallel' || c.type === 'perpendicular') {
      if (c.entityIds.length >= 2) {
        const id1 = c.entityIds[0];
        const id2 = c.entityIds[1];
        if (lineIds.has(id1) && lineIds.has(id2)) {
          const pairKey = id1 < id2 ? `${id1}_${id2}` : `${id2}_${id1}`;
          if (!pairConstraintsMap.has(pairKey)) {
            pairConstraintsMap.set(pairKey, new Set<string>());
          }
          pairConstraintsMap.get(pairKey)!.add(c.type);
        }
      }
    }
  }

  const conflictSet = new Set<string>();

  // Single line conflicting: both horizontal and vertical
  for (const id of lineIds) {
    if (horizontalEntities.has(id) && verticalEntities.has(id)) {
      conflictSet.add(id);
    }
  }

  // Pair of lines conflicting: both parallel and perpendicular
  for (const [pairKey, types] of pairConstraintsMap.entries()) {
    if (types.has('parallel') && types.has('perpendicular')) {
      const [id1, id2] = pairKey.split('_');
      conflictSet.add(id1);
      conflictSet.add(id2);
    }
  }

  return Array.from(conflictSet);
}

/**
 * Helper to check if a point is fixed.
 */
function isPointFixed(
  fixedPositionsMap: Map<string, Point2D>,
  entityId: string,
  pointIndex: number
): boolean {
  return fixedPositionsMap.has(`${entityId}_${pointIndex}`);
}

/**
 * Applies a single constraint to the working entity array and returns the maximum displacement.
 */
function applyConstraint(
  entitiesMap: Map<string, CADEntity2D>,
  constraint: Constraint,
  fixedPositionsMap: Map<string, Point2D>,
  allConstraints?: Constraint[]
): number {
  let maxDisp = 0;

  switch (constraint.type) {
    case 'fix': {
      if (constraint.entityIds.length >= 1) {
        const entityId = constraint.entityIds[0];
        const ptIdx = constraint.pointIndices?.[0] ?? 0;
        const entity = entitiesMap.get(entityId);
        if (!entity) break;

        const anchor = fixedPositionsMap.get(`${entityId}_${ptIdx}`);
        if (anchor) {
          const currentPt = getEntityPoint(entity, ptIdx);
          if (currentPt) {
            const disp = Math.hypot(currentPt.x - anchor.x, currentPt.y - anchor.y);
            if (disp > 1e-7) {
              setEntityPoint(entity, ptIdx, { ...anchor });
              maxDisp = disp;
            }
          }
        }
      }
      break;
    }

    case 'coincident': {
      if (constraint.entityIds.length >= 2) {
        const id1 = constraint.entityIds[0];
        const id2 = constraint.entityIds[1];
        const e1 = entitiesMap.get(id1);
        const e2 = entitiesMap.get(id2);
        if (!e1 || !e2) break;

        const idx1 = constraint.pointIndices?.[0] ?? 0;
        const idx2 = constraint.pointIndices?.[1] ?? 0;
        const p1 = getEntityPoint(e1, idx1);
        const p2 = getEntityPoint(e2, idx2);

        if (p1 && p2) {
          const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

          // 端點合併容差微調：防止極微小浮點數漂移導致約束發散
          if (dist < 1e-7) {
            break;
          }

          const p1Fixed = isPointFixed(fixedPositionsMap, id1, idx1);
          const p2Fixed = isPointFixed(fixedPositionsMap, id2, idx2);

          if (p1Fixed && !p2Fixed) {
            // p1 為固定點：p2 單向向 p1 靠攏
            setEntityPoint(e2, idx2, { x: p1.x, y: p1.y });
            maxDisp = dist;
          } else if (p2Fixed && !p1Fixed) {
            // p2 為固定點：p1 單向向 p2 靠攏
            setEntityPoint(e1, idx1, { x: p2.x, y: p2.y });
            maxDisp = dist;
          } else {
            // 兩者皆未固定（或兩者皆固定）：向中點各 50% 靠攏
            const midX = (p1.x + p2.x) * 0.5;
            const midY = (p1.y + p2.y) * 0.5;

            const disp1 = Math.hypot(p1.x - midX, p1.y - midY);
            const disp2 = Math.hypot(p2.x - midX, p2.y - midY);

            setEntityPoint(e1, idx1, { x: midX, y: midY });
            setEntityPoint(e2, idx2, { x: midX, y: midY });

            maxDisp = Math.max(disp1, disp2);
          }
        }
      } else if (constraint.entityIds.length === 1 && constraint.pointIndices && constraint.pointIndices.length >= 2) {
        const id1 = constraint.entityIds[0];
        const e1 = entitiesMap.get(id1);
        if (!e1) break;

        const idx1 = constraint.pointIndices[0];
        const idx2 = constraint.pointIndices[1];
        const p1 = getEntityPoint(e1, idx1);
        const p2 = getEntityPoint(e1, idx2);

        if (p1 && p2) {
          const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

          // 端點合併容差微調
          if (dist < 1e-7) {
            break;
          }

          const p1Fixed = isPointFixed(fixedPositionsMap, id1, idx1);
          const p2Fixed = isPointFixed(fixedPositionsMap, id1, idx2);

          if (p1Fixed && !p2Fixed) {
            setEntityPoint(e1, idx2, { x: p1.x, y: p1.y });
            maxDisp = dist;
          } else if (p2Fixed && !p1Fixed) {
            setEntityPoint(e1, idx1, { x: p2.x, y: p2.y });
            maxDisp = dist;
          } else {
            const midX = (p1.x + p2.x) * 0.5;
            const midY = (p1.y + p2.y) * 0.5;

            const disp1 = Math.hypot(p1.x - midX, p1.y - midY);
            const disp2 = Math.hypot(p2.x - midX, p2.y - midY);

            setEntityPoint(e1, idx1, { x: midX, y: midY });
            setEntityPoint(e1, idx2, { x: midX, y: midY });

            maxDisp = Math.max(disp1, disp2);
          }
        }
      }
      break;
    }

    case 'horizontal': {
      if (constraint.entityIds.length === 1) {
        const id1 = constraint.entityIds[0];
        const e1 = entitiesMap.get(id1);
        if (!e1) break;

        if (e1.type === 'line') {
          const p0Fixed = isPointFixed(fixedPositionsMap, id1, 0);
          const p1Fixed = isPointFixed(fixedPositionsMap, id1, 1);

          if (p0Fixed && !p1Fixed) {
            const disp = Math.abs(e1.end.y - e1.start.y);
            if (disp > 1e-7) {
              e1.end.y = e1.start.y;
              maxDisp = disp;
            }
          } else if (p1Fixed && !p0Fixed) {
            const disp = Math.abs(e1.start.y - e1.end.y);
            if (disp > 1e-7) {
              e1.start.y = e1.end.y;
              maxDisp = disp;
            }
          } else {
            const avgY = (e1.start.y + e1.end.y) * 0.5;
            const disp1 = Math.abs(e1.start.y - avgY);
            const disp2 = Math.abs(e1.end.y - avgY);

            if (disp1 > 1e-7 || disp2 > 1e-7) {
              e1.start.y = avgY;
              e1.end.y = avgY;
              maxDisp = Math.max(disp1, disp2);
            }
          }
        }
      } else if (constraint.entityIds.length >= 2) {
        const id1 = constraint.entityIds[0];
        const id2 = constraint.entityIds[1];
        const e1 = entitiesMap.get(id1);
        const e2 = entitiesMap.get(id2);
        if (!e1 || !e2) break;

        const idx1 = constraint.pointIndices?.[0] ?? 0;
        const idx2 = constraint.pointIndices?.[1] ?? 0;
        const p1 = getEntityPoint(e1, idx1);
        const p2 = getEntityPoint(e2, idx2);

        if (p1 && p2) {
          const p1Fixed = isPointFixed(fixedPositionsMap, id1, idx1);
          const p2Fixed = isPointFixed(fixedPositionsMap, id2, idx2);

          if (p1Fixed && !p2Fixed) {
            const disp = Math.abs(p2.y - p1.y);
            if (disp > 1e-7) {
              setEntityPoint(e2, idx2, { x: p2.x, y: p1.y });
              maxDisp = disp;
            }
          } else if (p2Fixed && !p1Fixed) {
            const disp = Math.abs(p1.y - p2.y);
            if (disp > 1e-7) {
              setEntityPoint(e1, idx1, { x: p1.x, y: p2.y });
              maxDisp = disp;
            }
          } else {
            const avgY = (p1.y + p2.y) * 0.5;
            const disp1 = Math.abs(p1.y - avgY);
            const disp2 = Math.abs(p2.y - avgY);

            if (disp1 > 1e-7 || disp2 > 1e-7) {
              setEntityPoint(e1, idx1, { x: p1.x, y: avgY });
              setEntityPoint(e2, idx2, { x: p2.x, y: avgY });
              maxDisp = Math.max(disp1, disp2);
            }
          }
        }
      }
      break;
    }

    case 'vertical': {
      if (constraint.entityIds.length === 1) {
        const id1 = constraint.entityIds[0];
        const e1 = entitiesMap.get(id1);
        if (!e1) break;

        if (e1.type === 'line') {
          const p0Fixed = isPointFixed(fixedPositionsMap, id1, 0);
          const p1Fixed = isPointFixed(fixedPositionsMap, id1, 1);

          if (p0Fixed && !p1Fixed) {
            const disp = Math.abs(e1.end.x - e1.start.x);
            if (disp > 1e-7) {
              e1.end.x = e1.start.x;
              maxDisp = disp;
            }
          } else if (p1Fixed && !p0Fixed) {
            const disp = Math.abs(e1.start.x - e1.end.x);
            if (disp > 1e-7) {
              e1.start.x = e1.end.x;
              maxDisp = disp;
            }
          } else {
            const avgX = (e1.start.x + e1.end.x) * 0.5;
            const disp1 = Math.abs(e1.start.x - avgX);
            const disp2 = Math.abs(e1.end.x - avgX);

            if (disp1 > 1e-7 || disp2 > 1e-7) {
              e1.start.x = avgX;
              e1.end.x = avgX;
              maxDisp = Math.max(disp1, disp2);
            }
          }
        }
      } else if (constraint.entityIds.length >= 2) {
        const id1 = constraint.entityIds[0];
        const id2 = constraint.entityIds[1];
        const e1 = entitiesMap.get(id1);
        const e2 = entitiesMap.get(id2);
        if (!e1 || !e2) break;

        const idx1 = constraint.pointIndices?.[0] ?? 0;
        const idx2 = constraint.pointIndices?.[1] ?? 0;
        const p1 = getEntityPoint(e1, idx1);
        const p2 = getEntityPoint(e2, idx2);

        if (p1 && p2) {
          const p1Fixed = isPointFixed(fixedPositionsMap, id1, idx1);
          const p2Fixed = isPointFixed(fixedPositionsMap, id2, idx2);

          if (p1Fixed && !p2Fixed) {
            const disp = Math.abs(p2.x - p1.x);
            if (disp > 1e-7) {
              setEntityPoint(e2, idx2, { x: p1.x, y: p2.y });
              maxDisp = disp;
            }
          } else if (p2Fixed && !p1Fixed) {
            const disp = Math.abs(p1.x - p2.x);
            if (disp > 1e-7) {
              setEntityPoint(e1, idx1, { x: p2.x, y: p1.y });
              maxDisp = disp;
            }
          } else {
            const avgX = (p1.x + p2.x) * 0.5;
            const disp1 = Math.abs(p1.x - avgX);
            const disp2 = Math.abs(p2.x - avgX);

            if (disp1 > 1e-7 || disp2 > 1e-7) {
              setEntityPoint(e1, idx1, { x: avgX, y: p1.y });
              setEntityPoint(e2, idx2, { x: avgX, y: p2.y });
              maxDisp = Math.max(disp1, disp2);
            }
          }
        }
      }
      break;
    }

    case 'length':
    case 'distance': {
      const targetVal = constraint.value;
      if (targetVal === undefined || targetVal <= 0) break;

      if (constraint.entityIds.length === 1) {
        const id1 = constraint.entityIds[0];
        const e1 = entitiesMap.get(id1);
        if (!e1) break;

        if (e1.type === 'line') {
          let dx = e1.end.x - e1.start.x;
          let dy = e1.end.y - e1.start.y;
          let len = Math.hypot(dx, dy);

          if (len === 0) {
            dx = 1;
            dy = 0;
            len = 1;
          }

          const dirX = dx / len;
          const dirY = dy / len;
          const p0Fixed = isPointFixed(fixedPositionsMap, id1, 0);
          const p1Fixed = isPointFixed(fixedPositionsMap, id1, 1);

          if (p0Fixed && !p1Fixed) {
            const newEndX = e1.start.x + dirX * targetVal;
            const newEndY = e1.start.y + dirY * targetVal;
            const disp = Math.hypot(e1.end.x - newEndX, e1.end.y - newEndY);
            e1.end = { x: newEndX, y: newEndY };
            maxDisp = disp;
          } else if (p1Fixed && !p0Fixed) {
            const newStartX = e1.end.x - dirX * targetVal;
            const newStartY = e1.end.y - dirY * targetVal;
            const disp = Math.hypot(e1.start.x - newStartX, e1.start.y - newStartY);
            e1.start = { x: newStartX, y: newStartY };
            maxDisp = disp;
          } else {
            const midX = (e1.start.x + e1.end.x) * 0.5;
            const midY = (e1.start.y + e1.end.y) * 0.5;
            const halfVal = targetVal * 0.5;

            const newStartX = midX - dirX * halfVal;
            const newStartY = midY - dirY * halfVal;
            const newEndX = midX + dirX * halfVal;
            const newEndY = midY + dirY * halfVal;

            const disp1 = Math.hypot(e1.start.x - newStartX, e1.start.y - newStartY);
            const disp2 = Math.hypot(e1.end.x - newEndX, e1.end.y - newEndY);

            e1.start = { x: newStartX, y: newStartY };
            e1.end = { x: newEndX, y: newEndY };

            maxDisp = Math.max(disp1, disp2);
          }
        } else if (e1.type === 'circle' || e1.type === 'arc') {
          const disp = Math.abs(e1.radius - targetVal);
          e1.radius = targetVal;
          maxDisp = disp;
        }
      } else if (constraint.entityIds.length >= 2) {
        const id1 = constraint.entityIds[0];
        const id2 = constraint.entityIds[1];
        const e1 = entitiesMap.get(id1);
        const e2 = entitiesMap.get(id2);
        if (!e1 || !e2) break;

        const idx1 = constraint.pointIndices?.[0] ?? 0;
        const idx2 = constraint.pointIndices?.[1] ?? 0;
        const p1 = getEntityPoint(e1, idx1);
        const p2 = getEntityPoint(e2, idx2);

        if (p1 && p2) {
          let dx = p2.x - p1.x;
          let dy = p2.y - p1.y;
          let len = Math.hypot(dx, dy);

          if (len === 0) {
            dx = 1;
            dy = 0;
            len = 1;
          }

          const dirX = dx / len;
          const dirY = dy / len;
          const p1Fixed = isPointFixed(fixedPositionsMap, id1, idx1);
          const p2Fixed = isPointFixed(fixedPositionsMap, id2, idx2);

          if (p1Fixed && !p2Fixed) {
            const newP2X = p1.x + dirX * targetVal;
            const newP2Y = p1.y + dirY * targetVal;
            const disp = Math.hypot(p2.x - newP2X, p2.y - newP2Y);
            setEntityPoint(e2, idx2, { x: newP2X, y: newP2Y });
            maxDisp = disp;
          } else if (p2Fixed && !p1Fixed) {
            const newP1X = p2.x - dirX * targetVal;
            const newP1Y = p2.y - dirY * targetVal;
            const disp = Math.hypot(p1.x - newP1X, p1.y - newP1Y);
            setEntityPoint(e1, idx1, { x: newP1X, y: newP1Y });
            maxDisp = disp;
          } else {
            const midX = (p1.x + p2.x) * 0.5;
            const midY = (p1.y + p2.y) * 0.5;
            const halfVal = targetVal * 0.5;

            const newP1X = midX - dirX * halfVal;
            const newP1Y = midY - dirY * halfVal;
            const newP2X = midX + dirX * halfVal;
            const newP2Y = midY + dirY * halfVal;

            const disp1 = Math.hypot(p1.x - newP1X, p1.y - newP1Y);
            const disp2 = Math.hypot(p2.x - newP2X, p2.y - newP2Y);

            setEntityPoint(e1, idx1, { x: newP1X, y: newP1Y });
            setEntityPoint(e2, idx2, { x: newP2X, y: newP2Y });

            maxDisp = Math.max(disp1, disp2);
          }
        }
      }
      break;
    }

    case 'tangent': {
      if (constraint.entityIds.length >= 2) {
        const id1 = constraint.entityIds[0];
        const id2 = constraint.entityIds[1];
        const e1 = entitiesMap.get(id1);
        const e2 = entitiesMap.get(id2);
        if (!e1 || !e2) break;

        const isLine1 = e1.type === 'line';
        const isLine2 = e2.type === 'line';
        const isCircle1 = e1.type === 'circle' || e1.type === 'arc';
        const isCircle2 = e2.type === 'circle' || e2.type === 'arc';

        if ((isLine1 && isCircle2) || (isLine2 && isCircle1)) {
          const lineEntity = (isLine1 ? e1 : e2) as LineEntity;
          const circleEntity = (isLine1 ? e2 : e1) as CircleEntity | ArcEntity;
          const lineId = isLine1 ? id1 : id2;
          const circleId = isLine1 ? id2 : id1;

          const P1 = lineEntity.start;
          const P2 = lineEntity.end;
          const C = circleEntity.center;
          const R = circleEntity.radius;

          const dx = P2.x - P1.x;
          const dy = P2.y - P1.y;
          const L = Math.hypot(dx, dy);
          if (L < 1e-7) break;

          // 1. Check if there is a coincident endpoint constraint/overlap between the line and the circle/arc
          let isEndPointTangent = false;
          let sharedPtLineIdx: number | null = null;
          let sharedPt: Point2D | null = null;

          // Check A: Search allConstraints for a coincident constraint containing both lineId and circleId
          const connConstraint = allConstraints?.find(c => 
            c.type === 'coincident' && 
            c.entityIds.includes(lineId) && 
            c.entityIds.includes(circleId)
          );

          if (connConstraint && connConstraint.pointIndices && connConstraint.pointIndices.length >= 2) {
            const idxLineInConstraint = connConstraint.entityIds.indexOf(lineId);
            if (idxLineInConstraint !== -1) {
              sharedPtLineIdx = connConstraint.pointIndices[idxLineInConstraint];
              sharedPt = getEntityPoint(lineEntity, sharedPtLineIdx);
              if (sharedPt) {
                isEndPointTangent = true;
              }
            }
          }

          // Check B: Or directly check geometric endpoints within 1e-4 tolerance
          if (!isEndPointTangent && circleEntity.type === 'arc') {
            const arcP0 = getEntityPoint(circleEntity, 0); // start of arc
            const arcP1 = getEntityPoint(circleEntity, 1); // end of arc
            
            const lineP0 = P1;
            const lineP1 = P2;

            if (arcP0 && arcP1) {
              const d00 = Math.hypot(lineP0.x - arcP0.x, lineP0.y - arcP0.y);
              const d01 = Math.hypot(lineP0.x - arcP1.x, lineP0.y - arcP1.y);
              const d10 = Math.hypot(lineP1.x - arcP0.x, lineP1.y - arcP0.y);
              const d11 = Math.hypot(lineP1.x - arcP1.x, lineP1.y - arcP1.y);

              if (d00 < 1e-4) {
                isEndPointTangent = true;
                sharedPtLineIdx = 0;
                sharedPt = lineP0;
              } else if (d01 < 1e-4) {
                isEndPointTangent = true;
                sharedPtLineIdx = 0;
                sharedPt = lineP0;
              } else if (d10 < 1e-4) {
                isEndPointTangent = true;
                sharedPtLineIdx = 1;
                sharedPt = lineP1;
              } else if (d11 < 1e-4) {
                isEndPointTangent = true;
                sharedPtLineIdx = 1;
                sharedPt = lineP1;
              }
            }
          }

          if (isEndPointTangent && sharedPt && sharedPtLineIdx !== null) {
            // Branch A: End-point Tangent (Most common case)
            // Keep the shared connection point motionless to satisfy the coincident constraint
            const Pshared = { ...sharedPt };
            const isStartShared = sharedPtLineIdx === 0;
            const Pfree = isStartShared ? { ...P2 } : { ...P1 };

            // Calculate the radial vector from circle center to the shared endpoint
            const rx = Pshared.x - C.x;
            const ry = Pshared.y - C.y;
            const rLen = Math.hypot(rx, ry);

            if (rLen > 1e-7) {
              // Target tangent vectors (perpendicular to radial vector)
              const T1x = -ry / rLen;
              const T1y = rx / rLen;
              const T2x = ry / rLen;
              const T2y = -rx / rLen;

              // Vector from shared endpoint to free endpoint
              const VfreeX = Pfree.x - Pshared.x;
              const VfreeY = Pfree.y - Pshared.y;

              // Choose the direction of tangent closest to the current free endpoint (positive dot product)
              const dot1 = T1x * VfreeX + T1y * VfreeY;
              const dot2 = T2x * VfreeX + T2y * VfreeY;

              const Tx = dot1 > dot2 ? T1x : T2x;
              const Ty = dot1 > dot2 ? T1y : T2y;

              // Maintain original line length L and rotate free endpoint
              const newPfreeX = Pshared.x + Tx * L;
              const newPfreeY = Pshared.y + Ty * L;

              const disp = Math.hypot(newPfreeX - Pfree.x, newPfreeY - Pfree.y);

              // Update only the free endpoint of the line, leaving the coincident endpoint pristine
              if (isStartShared) {
                lineEntity.end.x = newPfreeX;
                lineEntity.end.y = newPfreeY;
              } else {
                lineEntity.start.x = newPfreeX;
                lineEntity.start.y = newPfreeY;
              }

              maxDisp = disp;
            }
          } else {
            // Branch B: Ordinary line body tangent (Translational displacement correction)
            const tx = dx / L;
            const ty = dy / L;
            const ux = C.x - P1.x;
            const uy = C.y - P1.y;
            const proj = ux * tx + uy * ty;

            const projX = P1.x + proj * tx;
            const projY = P1.y + proj * ty;

            const px = C.x - projX;
            const py = C.y - projY;
            const d = Math.hypot(px, py);

            let nx = 0;
            let ny = 0;
            if (d >= 1e-7) {
              nx = px / d;
              ny = py / d;
            } else {
              nx = -ty;
              ny = tx;
            }

            const delta = d - R;
            if (Math.abs(delta) > 1e-7) {
              const isCenterFixed = circleEntity.type === 'circle'
                ? (isPointFixed(fixedPositionsMap, circleId, 0) || isPointFixed(fixedPositionsMap, circleId, 1) || isPointFixed(fixedPositionsMap, circleId, 2))
                : isPointFixed(fixedPositionsMap, circleId, 2);

              const isLineFixed = isPointFixed(fixedPositionsMap, lineId, 0) || isPointFixed(fixedPositionsMap, lineId, 1);

              if (isCenterFixed && !isLineFixed) {
                const disp = Math.abs(delta);
                lineEntity.start.x += delta * nx;
                lineEntity.start.y += delta * ny;
                lineEntity.end.x += delta * nx;
                lineEntity.end.y += delta * ny;
                maxDisp = disp;
              } else if (isLineFixed && !isCenterFixed) {
                const disp = Math.abs(delta);
                circleEntity.center.x -= delta * nx;
                circleEntity.center.y -= delta * ny;
                maxDisp = disp;
              } else if (!isCenterFixed && !isLineFixed) {
                const disp = Math.abs(delta) * 0.5;
                lineEntity.start.x += 0.5 * delta * nx;
                lineEntity.start.y += 0.5 * delta * ny;
                lineEntity.end.x += 0.5 * delta * nx;
                lineEntity.end.y += 0.5 * delta * ny;
                circleEntity.center.x -= 0.5 * delta * nx;
                circleEntity.center.y -= 0.5 * delta * ny;
                maxDisp = disp;
              }
            }
          }
        } else if (isCircle1 && isCircle2) {
          const arc1 = e1 as CircleEntity | ArcEntity;
          const arc2 = e2 as CircleEntity | ArcEntity;

          const C1 = arc1.center;
          const C2 = arc2.center;
          const R1 = arc1.radius;
          const R2 = arc2.radius;

          const dx = C2.x - C1.x;
          const dy = C2.y - C1.y;
          let D = Math.hypot(dx, dy);

          let dirX = 1;
          let dirY = 0;
          if (D >= 1e-7) {
            dirX = dx / D;
            dirY = dy / D;
          } else {
            D = 0;
          }

          const dExt = R1 + R2;
          const dInt = Math.abs(R1 - R2);
          const targetD = Math.abs(D - dExt) < Math.abs(D - dInt) ? dExt : dInt;

          const delta = D - targetD;
          if (Math.abs(delta) > 1e-7) {
            const c1Fixed = arc1.type === 'circle'
              ? (isPointFixed(fixedPositionsMap, id1, 0) || isPointFixed(fixedPositionsMap, id1, 1) || isPointFixed(fixedPositionsMap, id1, 2))
              : isPointFixed(fixedPositionsMap, id1, 2);

            const c2Fixed = arc2.type === 'circle'
              ? (isPointFixed(fixedPositionsMap, id2, 0) || isPointFixed(fixedPositionsMap, id2, 1) || isPointFixed(fixedPositionsMap, id2, 2))
              : isPointFixed(fixedPositionsMap, id2, 2);

            if (c1Fixed && !c2Fixed) {
              const disp = Math.abs(delta);
              C2.x -= delta * dirX;
              C2.y -= delta * dirY;
              maxDisp = disp;
            } else if (c2Fixed && !c1Fixed) {
              const disp = Math.abs(delta);
              C1.x += delta * dirX;
              C1.y += delta * dirY;
              maxDisp = disp;
            } else if (!c1Fixed && !c2Fixed) {
              const disp = Math.abs(delta) * 0.5;
              C1.x += 0.5 * delta * dirX;
              C1.y += 0.5 * delta * dirY;
              C2.x -= 0.5 * delta * dirX;
              C2.y -= 0.5 * delta * dirY;
              maxDisp = disp;
            }
          }
        }
      }
      break;
    }

    case 'parallel': {
      if (constraint.entityIds.length >= 2) {
        const id1 = constraint.entityIds[0];
        const id2 = constraint.entityIds[1];
        const e1 = entitiesMap.get(id1);
        const e2 = entitiesMap.get(id2);
        if (!e1 || !e2 || e1.type !== 'line' || e2.type !== 'line') break;

        const line1 = e1 as LineEntity;
        const line2 = e2 as LineEntity;

        const dx1 = line1.end.x - line1.start.x;
        const dy1 = line1.end.y - line1.start.y;
        const len1 = Math.hypot(dx1, dy1);

        const dx2 = line2.end.x - line2.start.x;
        const dy2 = line2.end.y - line2.start.y;
        const len2 = Math.hypot(dx2, dy2);

        if (len1 < 1e-7 || len2 < 1e-7) break;

        const theta1 = Math.atan2(dy1, dx1);
        const theta2 = Math.atan2(dy2, dx2);

        const dTheta = Math.atan2(Math.sin(theta2 - theta1), Math.cos(theta2 - theta1));
        let angleError = dTheta;
        if (dTheta > Math.PI / 2) {
          angleError = dTheta - Math.PI;
        } else if (dTheta < -Math.PI / 2) {
          angleError = dTheta + Math.PI;
        }

        if (Math.abs(angleError) > 1e-7) {
          const fixCount1 = (isPointFixed(fixedPositionsMap, id1, 0) ? 1 : 0) + (isPointFixed(fixedPositionsMap, id1, 1) ? 1 : 0);
          const fixCount2 = (isPointFixed(fixedPositionsMap, id2, 0) ? 1 : 0) + (isPointFixed(fixedPositionsMap, id2, 1) ? 1 : 0);

          let rot1 = 0;
          let rot2 = 0;

          if (fixCount1 > 0 && fixCount2 === 0) {
            rot2 = -angleError;
          } else if (fixCount2 > 0 && fixCount1 === 0) {
            rot1 = angleError;
          } else {
            rot1 = angleError * 0.5;
            rot2 = -angleError * 0.5;
          }

          const oldP1s = { ...line1.start };
          const oldP2s = { ...line2.start };

          if (Math.abs(rot1) > 1e-9) {
            const mx1 = (line1.start.x + line1.end.x) * 0.5;
            const my1 = (line1.start.y + line1.end.y) * 0.5;
            const hx1 = line1.end.x - mx1;
            const hy1 = line1.end.y - my1;
            const cos1 = Math.cos(rot1);
            const sin1 = Math.sin(rot1);
            line1.start = { x: mx1 - (hx1 * cos1 - hy1 * sin1), y: my1 - (hx1 * sin1 + hy1 * cos1) };
            line1.end = { x: mx1 + (hx1 * cos1 - hy1 * sin1), y: my1 + (hx1 * sin1 + hy1 * cos1) };
          }

          if (Math.abs(rot2) > 1e-9) {
            const mx2 = (line2.start.x + line2.end.x) * 0.5;
            const my2 = (line2.start.y + line2.end.y) * 0.5;
            const hx2 = line2.end.x - mx2;
            const hy2 = line2.end.y - my2;
            const cos2 = Math.cos(rot2);
            const sin2 = Math.sin(rot2);
            line2.start = { x: mx2 - (hx2 * cos2 - hy2 * sin2), y: my2 - (hx2 * sin2 + hy2 * cos2) };
            line2.end = { x: mx2 + (hx2 * cos2 - hy2 * sin2), y: my2 + (hx2 * sin2 + hy2 * cos2) };
          }

          const disp1 = Math.hypot(line1.start.x - oldP1s.x, line1.start.y - oldP1s.y);
          const disp2 = Math.hypot(line2.start.x - oldP2s.x, line2.start.y - oldP2s.y);
          maxDisp = Math.max(disp1, disp2);
        }
      }
      break;
    }

    case 'perpendicular': {
      if (constraint.entityIds.length >= 2) {
        const id1 = constraint.entityIds[0];
        const id2 = constraint.entityIds[1];
        const e1 = entitiesMap.get(id1);
        const e2 = entitiesMap.get(id2);
        if (!e1 || !e2 || e1.type !== 'line' || e2.type !== 'line') break;

        const line1 = e1 as LineEntity;
        const line2 = e2 as LineEntity;

        const dx1 = line1.end.x - line1.start.x;
        const dy1 = line1.end.y - line1.start.y;
        const len1 = Math.hypot(dx1, dy1);

        const dx2 = line2.end.x - line2.start.x;
        const dy2 = line2.end.y - line2.start.y;
        const len2 = Math.hypot(dx2, dy2);

        if (len1 < 1e-7 || len2 < 1e-7) break;

        const theta1 = Math.atan2(dy1, dx1);
        const theta2 = Math.atan2(dy2, dx2);

        const dTheta = Math.atan2(Math.sin(theta2 - theta1), Math.cos(theta2 - theta1));
        const err1 = Math.atan2(Math.sin(dTheta - Math.PI / 2), Math.cos(dTheta - Math.PI / 2));
        const err2 = Math.atan2(Math.sin(dTheta + Math.PI / 2), Math.cos(dTheta + Math.PI / 2));
        const angleError = Math.abs(err1) < Math.abs(err2) ? err1 : err2;

        if (Math.abs(angleError) > 1e-7) {
          const fixCount1 = (isPointFixed(fixedPositionsMap, id1, 0) ? 1 : 0) + (isPointFixed(fixedPositionsMap, id1, 1) ? 1 : 0);
          const fixCount2 = (isPointFixed(fixedPositionsMap, id2, 0) ? 1 : 0) + (isPointFixed(fixedPositionsMap, id2, 1) ? 1 : 0);

          let rot1 = 0;
          let rot2 = 0;

          if (fixCount1 > 0 && fixCount2 === 0) {
            rot2 = -angleError;
          } else if (fixCount2 > 0 && fixCount1 === 0) {
            rot1 = angleError;
          } else {
            rot1 = angleError * 0.5;
            rot2 = -angleError * 0.5;
          }

          const oldP1s = { ...line1.start };
          const oldP2s = { ...line2.start };

          if (Math.abs(rot1) > 1e-9) {
            const mx1 = (line1.start.x + line1.end.x) * 0.5;
            const my1 = (line1.start.y + line1.end.y) * 0.5;
            const hx1 = line1.end.x - mx1;
            const hy1 = line1.end.y - my1;
            const cos1 = Math.cos(rot1);
            const sin1 = Math.sin(rot1);
            line1.start = { x: mx1 - (hx1 * cos1 - hy1 * sin1), y: my1 - (hx1 * sin1 + hy1 * cos1) };
            line1.end = { x: mx1 + (hx1 * cos1 - hy1 * sin1), y: my1 + (hx1 * sin1 + hy1 * cos1) };
          }

          if (Math.abs(rot2) > 1e-9) {
            const mx2 = (line2.start.x + line2.end.x) * 0.5;
            const my2 = (line2.start.y + line2.end.y) * 0.5;
            const hx2 = line2.end.x - mx2;
            const hy2 = line2.end.y - my2;
            const cos2 = Math.cos(rot2);
            const sin2 = Math.sin(rot2);
            line2.start = { x: mx2 - (hx2 * cos2 - hy2 * sin2), y: my2 - (hx2 * sin2 + hy2 * cos2) };
            line2.end = { x: mx2 + (hx2 * cos2 - hy2 * sin2), y: my2 + (hx2 * sin2 + hy2 * cos2) };
          }

          const disp1 = Math.hypot(line1.start.x - oldP1s.x, line1.start.y - oldP1s.y);
          const disp2 = Math.hypot(line2.start.x - oldP2s.x, line2.start.y - oldP2s.y);
          maxDisp = Math.max(disp1, disp2);
        }
      }
      break;
    }

    case 'equal_length': {
      if (constraint.entityIds.length >= 2) {
        const id1 = constraint.entityIds[0];
        const id2 = constraint.entityIds[1];
        const e1 = entitiesMap.get(id1);
        const e2 = entitiesMap.get(id2);
        if (!e1 || !e2 || e1.type !== 'line' || e2.type !== 'line') break;

        const line1 = e1 as LineEntity;
        const line2 = e2 as LineEntity;

        const len1 = Math.hypot(line1.end.x - line1.start.x, line1.end.y - line1.start.y);
        const len2 = Math.hypot(line2.end.x - line2.start.x, line2.end.y - line2.start.y);

        const L_avg = (len1 + len2) * 0.5;
        if (L_avg < 1e-7) break;

        const adjustLineLength = (line: LineEntity, lineId: string, targetVal: number): number => {
          let dx = line.end.x - line.start.x;
          let dy = line.end.y - line.start.y;
          let len = Math.hypot(dx, dy);

          if (len === 0) {
            dx = 1;
            dy = 0;
            len = 1;
          }

          const dirX = dx / len;
          const dirY = dy / len;
          const p0Fixed = isPointFixed(fixedPositionsMap, lineId, 0);
          const p1Fixed = isPointFixed(fixedPositionsMap, lineId, 1);

          if (p0Fixed && !p1Fixed) {
            const newEndX = line.start.x + dirX * targetVal;
            const newEndY = line.start.y + dirY * targetVal;
            const disp = Math.hypot(line.end.x - newEndX, line.end.y - newEndY);
            line.end = { x: newEndX, y: newEndY };
            return disp;
          } else if (p1Fixed && !p0Fixed) {
            const newStartX = line.end.x - dirX * targetVal;
            const newStartY = line.end.y - dirY * targetVal;
            const disp = Math.hypot(line.start.x - newStartX, line.start.y - newStartY);
            line.start = { x: newStartX, y: newStartY };
            return disp;
          } else {
            const midX = (line.start.x + line.end.x) * 0.5;
            const midY = (line.start.y + line.end.y) * 0.5;
            const halfVal = targetVal * 0.5;

            const newStartX = midX - dirX * halfVal;
            const newStartY = midY - dirY * halfVal;
            const newEndX = midX + dirX * halfVal;
            const newEndY = midY + dirY * halfVal;

            const disp1 = Math.hypot(line.start.x - newStartX, line.start.y - newStartY);
            const disp2 = Math.hypot(line.end.x - newEndX, line.end.y - newEndY);

            line.start = { x: newStartX, y: newStartY };
            line.end = { x: newEndX, y: newEndY };

            return Math.max(disp1, disp2);
          }
        };

        const d1 = adjustLineLength(line1, id1, L_avg);
        const d2 = adjustLineLength(line2, id2, L_avg);
        maxDisp = Math.max(d1, d2);
      }
      break;
    }

    case 'equal_radius': {
      if (constraint.entityIds.length >= 2) {
        const id1 = constraint.entityIds[0];
        const id2 = constraint.entityIds[1];
        const e1 = entitiesMap.get(id1);
        const e2 = entitiesMap.get(id2);
        if (!e1 || !e2) break;

        const isE1Valid = e1.type === 'circle' || e1.type === 'arc';
        const isE2Valid = e2.type === 'circle' || e2.type === 'arc';

        if (isE1Valid && isE2Valid) {
          const arc1 = e1 as CircleEntity | ArcEntity;
          const arc2 = e2 as CircleEntity | ArcEntity;

          const r1 = arc1.radius;
          const r2 = arc2.radius;
          const avgR = (r1 + r2) * 0.5;

          const disp1 = Math.abs(arc1.radius - avgR);
          const disp2 = Math.abs(arc2.radius - avgR);

          arc1.radius = avgR;
          arc2.radius = avgR;

          maxDisp = Math.max(disp1, disp2);
        }
      }
      break;
    }

    default:
      break;
  }

  return maxDisp;
}

/**
 * Solves geometric constraints using relaxation loop.
 * Pure function returning new solved entities, conflict entities, and convergence metrics.
 */
export function solveConstraints(
  entities: CADEntity2D[],
  constraints: Constraint[]
): SolverResult {
  const clonedEntities = entities.map(cloneEntity);
  const entitiesMap = new Map<string, CADEntity2D>();
  for (const entity of clonedEntities) {
    entitiesMap.set(entity.id, entity);
  }

  // 1. 建立固定點錨點位置映射表 (Fixed Points Map)
  const fixedPositionsMap = new Map<string, Point2D>();
  for (const c of constraints) {
    if (c.type === 'fix' && c.entityIds.length > 0) {
      const entityId = c.entityIds[0];
      const ptIdx = c.pointIndices?.[0] ?? 0;
      const entity = entitiesMap.get(entityId);
      if (entity) {
        const pt = getEntityPoint(entity, ptIdx);
        if (pt) {
          fixedPositionsMap.set(`${entityId}_${ptIdx}`, { ...pt });
        }
      }
    }
  }

  // 2. 約束衝突 / 過定義檢查
  const conflictEntityIds = findConflictingLineEntityIds(clonedEntities, constraints);
  const conflictSet = new Set(conflictEntityIds);

  // 若發生衝突，過濾衝突圖元的 horizontal, vertical, parallel 與 perpendicular 約束，避免起終點被平均成一個點而退化或幾何無限角震盪退化
  const activeConstraints = constraints.filter((c) => {
    if (
      c.type === 'horizontal' ||
      c.type === 'vertical' ||
      c.type === 'parallel' ||
      c.type === 'perpendicular'
    ) {
      return !c.entityIds.some((id) => conflictSet.has(id));
    }
    return true;
  });

  let totalIterations = 0;
  let lastMaxDisp = 0;
  let converged = false;

  for (let iter = 0; iter < SOLVER_MAX_ITERATIONS; iter++) {
    totalIterations = iter + 1;
    let iterationMaxDisp = 0;

    for (const constraint of activeConstraints) {
      const disp = applyConstraint(entitiesMap, constraint, fixedPositionsMap, activeConstraints);
      if (disp > iterationMaxDisp) {
        iterationMaxDisp = disp;
      }
    }

    lastMaxDisp = iterationMaxDisp;

    if (iterationMaxDisp < SOLVER_TOLERANCE) {
      converged = true;
      break;
    }
  }

  // 若存在約束衝突，標記為未收斂
  if (conflictEntityIds.length > 0) {
    converged = false;
  }

  return {
    entities: clonedEntities,
    iterations: totalIterations,
    maxDisp: lastMaxDisp,
    converged,
    conflictEntityIds,
  };
}

/**
 * Analyzes Degrees of Freedom (DOF) for a sketch given its entities and constraints.
 */
export function analyzeSketchDOF(
  entities: CADEntity2D[],
  constraints: Constraint[]
): SketchDofState {
  let initialDof = 0;
  const entityInitialDof: Record<string, number> = {};
  const entityDofReductions: Record<string, number> = {};

  for (const entity of entities) {
    let dof = 0;
    if (entity.type === 'line') {
      dof = 4;
    } else if (entity.type === 'circle') {
      dof = 3;
    } else if (entity.type === 'arc') {
      dof = 4;
    } else if (entity.type === 'polyline') {
      dof = entity.points.length * 2;
    }
    entityInitialDof[entity.id] = dof;
    entityDofReductions[entity.id] = 0;
    initialDof += dof;
  }

  let dofReduction = 0;

  for (const constraint of constraints) {
    let constraintDof = 0;
    switch (constraint.type) {
      case 'horizontal':
        constraintDof = 1;
        break;
      case 'vertical':
        constraintDof = 1;
        break;
      case 'coincident':
        constraintDof = 2;
        break;
      case 'length':
      case 'distance':
        constraintDof = 1;
        break;
      case 'fix':
        constraintDof = 2;
        break;
      case 'parallel':
      case 'perpendicular':
      case 'tangent':
      case 'equal_length':
      case 'equal_radius':
        constraintDof = 1;
        break;
      default:
        constraintDof = 1;
        break;
    }

    dofReduction += constraintDof;

    if (constraint.entityIds.length > 0) {
      const share = constraintDof / constraint.entityIds.length;
      for (const id of constraint.entityIds) {
        if (entityDofReductions[id] !== undefined) {
          entityDofReductions[id] += share;
        }
      }
    }
  }

  const conflictEntityIds = findConflictingLineEntityIds(entities, constraints);
  const conflictSet = new Set(conflictEntityIds);

  const totalDof = initialDof - dofReduction;

  let state: 'UnderDefined' | 'FullyDefined' | 'OverDefined';
  if (conflictSet.size > 0 || totalDof < 0) {
    state = 'OverDefined';
  } else if (totalDof === 0) {
    state = 'FullyDefined';
  } else {
    state = 'UnderDefined';
  }

  const entityStates: Record<string, 'UnderDefined' | 'FullyDefined' | 'OverDefined'> = {};
  for (const entity of entities) {
    if (conflictSet.has(entity.id)) {
      entityStates[entity.id] = 'OverDefined';
      continue;
    }

    const initD = entityInitialDof[entity.id] ?? 0;
    const redD = entityDofReductions[entity.id] ?? 0;
    const remaining = initD - redD;

    if (remaining < 0) {
      entityStates[entity.id] = 'OverDefined';
    } else if (remaining === 0) {
      entityStates[entity.id] = 'FullyDefined';
    } else {
      entityStates[entity.id] = 'UnderDefined';
    }
  }

  return {
    totalDof,
    state,
    entityStates,
  };
}
