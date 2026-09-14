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
import {
  SolverResult,
  SketchDofState,
  SOLVER_MAX_ITERATIONS,
  SOLVER_TOLERANCE,
} from './solverTypes';

export { SOLVER_MAX_ITERATIONS, SOLVER_TOLERANCE } from './solverTypes';

function getEntityPoint(entity: CADEntity2D, pointIndex: number = 0): Point2D | null {
  if (entity.type === 'line') {
    return pointIndex === 1 ? entity.end : entity.start;
  }
  if (entity.type === 'circle') {
    return entity.center;
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
  if (entity.type === 'polyline') {
    return entity.points[pointIndex] || entity.points[0] || null;
  }
  return null;
}

function setEntityPoint(
  entity: CADEntity2D,
  pointIndex: number = 0,
  newPt: Point2D
): CADEntity2D {
  if (entity.type === 'line') {
    if (pointIndex === 1) {
      return { ...entity, end: { ...newPt } };
    }
    return { ...entity, start: { ...newPt } };
  }
  if (entity.type === 'circle') {
    return { ...entity, center: { ...newPt } };
  }
  if (entity.type === 'arc') {
    if (pointIndex === 0) {
      const angle = Math.atan2(newPt.y - entity.center.y, newPt.x - entity.center.x);
      return { ...entity, startAngle: angle };
    }
    if (pointIndex === 1) {
      const angle = Math.atan2(newPt.y - entity.center.y, newPt.x - entity.center.x);
      return { ...entity, endAngle: angle };
    }
    return { ...entity, center: { ...newPt } };
  }
  if (entity.type === 'polyline') {
    const updated = [...entity.points];
    if (pointIndex >= 0 && pointIndex < updated.length) {
      updated[pointIndex] = { ...newPt };
    }
    return { ...entity, points: updated };
  }
  return entity;
}

export function solveConstraints(
  entities: CADEntity2D[],
  constraints: Constraint[]
): SolverResult {
  if (!constraints || constraints.length === 0) {
    return {
      entities: JSON.parse(JSON.stringify(entities)),
      iterations: 0,
      maxDisp: 0,
      converged: true,
      conflictEntityIds: [],
    };
  }

  let workingEntities: Record<string, CADEntity2D> = {};
  for (const ent of entities) {
    workingEntities[ent.id] = JSON.parse(JSON.stringify(ent));
  }

  const fixedPoints = new Set<string>();
  for (const c of constraints) {
    if (c.type === 'fix' && c.entityIds.length > 0) {
      const entId = c.entityIds[0];
      const ptIdx = c.pointIndices?.[0] ?? 0;
      fixedPoints.add(`${entId}_${ptIdx}`);
    }
  }

  let iterations = 0;
  let maxDisp = 0;
  let converged = false;

  for (iterations = 0; iterations < SOLVER_MAX_ITERATIONS; iterations++) {
    maxDisp = 0;

    for (const c of constraints) {
      if (c.type === 'fix') continue;

      if (c.type === 'coincident' && c.entityIds.length >= 2) {
        const idA = c.entityIds[0];
        const idB = c.entityIds[1];
        const entA = workingEntities[idA];
        const entB = workingEntities[idB];
        if (!entA || !entB) continue;

        const idxA = c.pointIndices?.[0] ?? 0;
        const idxB = c.pointIndices?.[1] ?? 0;
        const ptA = getEntityPoint(entA, idxA);
        const ptB = getEntityPoint(entB, idxB);
        if (!ptA || !ptB) continue;

        const isFixedA = fixedPoints.has(`${idA}_${idxA}`);
        const isFixedB = fixedPoints.has(`${idB}_${idxB}`);

        const dx = ptB.x - ptA.x;
        const dy = ptB.y - ptA.y;
        const dist = Math.hypot(dx, dy);
        maxDisp = Math.max(maxDisp, dist);

        if (dist > SOLVER_TOLERANCE) {
          if (isFixedA && !isFixedB) {
            workingEntities[idB] = setEntityPoint(entB, idxB, ptA);
          } else if (!isFixedA && isFixedB) {
            workingEntities[idA] = setEntityPoint(entA, idxA, ptB);
          } else if (!isFixedA && !isFixedB) {
            const mid = { x: (ptA.x + ptB.x) / 2, y: (ptA.y + ptB.y) / 2 };
            workingEntities[idA] = setEntityPoint(entA, idxA, mid);
            workingEntities[idB] = setEntityPoint(entB, idxB, mid);
          }
        }
      } else if (c.type === 'horizontal' && c.entityIds.length >= 1) {
        const ent = workingEntities[c.entityIds[0]];
        if (ent && ent.type === 'line') {
          const dy = ent.end.y - ent.start.y;
          maxDisp = Math.max(maxDisp, Math.abs(dy));
          if (Math.abs(dy) > SOLVER_TOLERANCE) {
            const isFixed0 = fixedPoints.has(`${ent.id}_0`);
            const isFixed1 = fixedPoints.has(`${ent.id}_1`);
            if (isFixed0 && !isFixed1) {
              workingEntities[ent.id] = { ...ent, end: { ...ent.end, y: ent.start.y } };
            } else if (!isFixed0 && isFixed1) {
              workingEntities[ent.id] = { ...ent, start: { ...ent.start, y: ent.end.y } };
            } else {
              const avgY = (ent.start.y + ent.end.y) / 2;
              workingEntities[ent.id] = {
                ...ent,
                start: { ...ent.start, y: avgY },
                end: { ...ent.end, y: avgY },
              };
            }
          }
        }
      } else if (c.type === 'vertical' && c.entityIds.length >= 1) {
        const ent = workingEntities[c.entityIds[0]];
        if (ent && ent.type === 'line') {
          const dx = ent.end.x - ent.start.x;
          maxDisp = Math.max(maxDisp, Math.abs(dx));
          if (Math.abs(dx) > SOLVER_TOLERANCE) {
            const isFixed0 = fixedPoints.has(`${ent.id}_0`);
            const isFixed1 = fixedPoints.has(`${ent.id}_1`);
            if (isFixed0 && !isFixed1) {
              workingEntities[ent.id] = { ...ent, end: { ...ent.end, x: ent.start.x } };
            } else if (!isFixed0 && isFixed1) {
              workingEntities[ent.id] = { ...ent, start: { ...ent.start, x: ent.end.x } };
            } else {
              const avgX = (ent.start.x + ent.end.x) / 2;
              workingEntities[ent.id] = {
                ...ent,
                start: { ...ent.start, x: avgX },
                end: { ...ent.end, x: avgX },
              };
            }
          }
        }
      } else if (
        (c.type === 'length' || c.type === 'distance') &&
        c.value !== undefined &&
        c.value > 0
      ) {
        if (c.entityIds.length === 1) {
          const ent = workingEntities[c.entityIds[0]];
          if (ent && ent.type === 'line') {
            const dx = ent.end.x - ent.start.x;
            const dy = ent.end.y - ent.start.y;
            const currentLen = Math.hypot(dx, dy);
            const diff = currentLen - c.value;
            maxDisp = Math.max(maxDisp, Math.abs(diff));
            if (Math.abs(diff) > SOLVER_TOLERANCE && currentLen > 1e-9) {
              const scale = c.value / currentLen;
              const isFixed0 = fixedPoints.has(`${ent.id}_0`);
              const isFixed1 = fixedPoints.has(`${ent.id}_1`);
              if (isFixed0 && !isFixed1) {
                workingEntities[ent.id] = {
                  ...ent,
                  end: { x: ent.start.x + dx * scale, y: ent.start.y + dy * scale },
                };
              } else if (!isFixed0 && isFixed1) {
                workingEntities[ent.id] = {
                  ...ent,
                  start: { x: ent.end.x - dx * scale, y: ent.end.y - dy * scale },
                };
              } else {
                const midX = (ent.start.x + ent.end.x) / 2;
                const midY = (ent.start.y + ent.end.y) / 2;
                const halfX = (dx * scale) / 2;
                const halfY = (dy * scale) / 2;
                workingEntities[ent.id] = {
                  ...ent,
                  start: { x: midX - halfX, y: midY - halfY },
                  end: { x: midX + halfX, y: midY + halfY },
                };
              }
            }
          } else if (ent && (ent.type === 'circle' || ent.type === 'arc')) {
            const diff = Math.abs(ent.radius - c.value);
            maxDisp = Math.max(maxDisp, diff);
            if (diff > SOLVER_TOLERANCE) {
              workingEntities[ent.id] = {
                ...ent,
                radius: c.value,
              };
            }
          }
        }
      } else if (c.type === 'equal_radius' && c.entityIds.length >= 2) {
        const entA = workingEntities[c.entityIds[0]];
        const entB = workingEntities[c.entityIds[1]];
        if (
          entA &&
          entB &&
          (entA.type === 'circle' || entA.type === 'arc') &&
          (entB.type === 'circle' || entB.type === 'arc')
        ) {
          const diff = Math.abs(entA.radius - entB.radius);
          maxDisp = Math.max(maxDisp, diff);
          if (diff > SOLVER_TOLERANCE) {
            const avgR = (entA.radius + entB.radius) / 2;
            workingEntities[entA.id] = { ...entA, radius: avgR };
            workingEntities[entB.id] = { ...entB, radius: avgR };
          }
        }
      } else if (c.type === 'distance_x' && c.value !== undefined) {
        if (c.entityIds.length === 1) {
          const ent = workingEntities[c.entityIds[0]];
          if (ent && ent.type === 'line') {
            const curDX = ent.end.x - ent.start.x;
            const sign = curDX >= 0 ? 1 : -1;
            const targetDX = sign * Math.abs(c.value);
            const err = Math.abs(curDX - targetDX);
            maxDisp = Math.max(maxDisp, err);
            if (err > SOLVER_TOLERANCE) {
              const isFixed0 = fixedPoints.has(`${ent.id}_0`);
              const isFixed1 = fixedPoints.has(`${ent.id}_1`);
              if (isFixed0 && !isFixed1) {
                workingEntities[ent.id] = { ...ent, end: { ...ent.end, x: ent.start.x + targetDX } };
              } else if (!isFixed0 && isFixed1) {
                workingEntities[ent.id] = { ...ent, start: { ...ent.start, x: ent.end.x - targetDX } };
              } else {
                const midX = (ent.start.x + ent.end.x) / 2;
                workingEntities[ent.id] = {
                  ...ent,
                  start: { ...ent.start, x: midX - targetDX / 2 },
                  end: { ...ent.end, x: midX + targetDX / 2 },
                };
              }
            }
          }
        }
      } else if (c.type === 'distance_y' && c.value !== undefined) {
        if (c.entityIds.length === 1) {
          const ent = workingEntities[c.entityIds[0]];
          if (ent && ent.type === 'line') {
            const curDY = ent.end.y - ent.start.y;
            const sign = curDY >= 0 ? 1 : -1;
            const targetDY = sign * Math.abs(c.value);
            const err = Math.abs(curDY - targetDY);
            maxDisp = Math.max(maxDisp, err);
            if (err > SOLVER_TOLERANCE) {
              const isFixed0 = fixedPoints.has(`${ent.id}_0`);
              const isFixed1 = fixedPoints.has(`${ent.id}_1`);
              if (isFixed0 && !isFixed1) {
                workingEntities[ent.id] = { ...ent, end: { ...ent.end, y: ent.start.y + targetDY } };
              } else if (!isFixed0 && isFixed1) {
                workingEntities[ent.id] = { ...ent, start: { ...ent.start, y: ent.end.y - targetDY } };
              } else {
                const midY = (ent.start.y + ent.end.y) / 2;
                workingEntities[ent.id] = {
                  ...ent,
                  start: { ...ent.start, y: midY - targetDY / 2 },
                  end: { ...ent.end, y: midY + targetDY / 2 },
                };
              }
            }
          }
        }
      } else if (c.type === 'tangent' && c.entityIds.length === 2) {
        const entA = workingEntities[c.entityIds[0]];
        const entB = workingEntities[c.entityIds[1]];
        const line = entA?.type === 'line' ? entA : entB?.type === 'line' ? entB : null;
        const circle = entA?.type === 'circle' ? entA : entB?.type === 'circle' ? entB : null;
        if (line && circle) {
          const vx = line.end.x - line.start.x;
          const vy = line.end.y - line.start.y;
          const len = Math.hypot(vx, vy);
          if (len > 1e-6) {
            const dist =
              Math.abs(
                (line.end.y - line.start.y) * circle.center.x -
                  (line.end.x - line.start.x) * circle.center.y +
                  line.end.x * line.start.y -
                  line.end.y * line.start.x
              ) / len;
            const diff = dist - circle.radius;
            maxDisp = Math.max(maxDisp, Math.abs(diff));
          }
        }
      } else if (c.type === 'angle' && c.entityIds.length === 2 && c.value !== undefined) {
        const entA = workingEntities[c.entityIds[0]];
        const entB = workingEntities[c.entityIds[1]];
        if (entA && entB && entA.type === 'line' && entB.type === 'line') {
          const dxA = entA.end.x - entA.start.x;
          const dyA = entA.end.y - entA.start.y;
          const dxB = entB.end.x - entB.start.x;
          const dyB = entB.end.y - entB.start.y;

          const lenA = Math.hypot(dxA, dyA);
          const lenB = Math.hypot(dxB, dyB);

          if (lenA > 1e-6 && lenB > 1e-6) {
            const dot = dxA * dxB + dyA * dyB;
            const cross = dxA * dyB - dyA * dxB;
            const cosAngle = dot / (lenA * lenB);
            const currentAngleRad = Math.acos(Math.max(-1, Math.min(1, cosAngle))); // [0, PI]

            // 標準化 UI 輸入的角度度數為 0~180 的無方向內角
            let targetDeg = c.value % 360;
            if (targetDeg < 0) targetDeg += 360;
            if (targetDeg > 180) targetDeg = 360 - targetDeg;
            const targetAngleRad = (targetDeg * Math.PI) / 180;

            let useSupplementary = false;
            let err = currentAngleRad - targetAngleRad;

            // 判斷原拓撲與哪一側角度比較近，避免翻轉破壞原本圖形
            if (Math.abs((Math.PI - currentAngleRad) - targetAngleRad) < Math.abs(err)) {
              err = (Math.PI - currentAngleRad) - targetAngleRad;
              useSupplementary = true;
            }

            maxDisp = Math.max(maxDisp, Math.abs(err) * Math.min(lenA, lenB));

            if (Math.abs(err) > SOLVER_TOLERANCE) {
              const effectiveTargetRad = useSupplementary ? Math.PI - targetAngleRad : targetAngleRad;
              let rotationDiff = effectiveTargetRad - currentAngleRad;

              if (cross < 0) {
                rotationDiff = -rotationDiff;
              }

              let rotB = rotationDiff / 2;
              let rotA = -rotationDiff / 2;

              const isFixedA0 = fixedPoints.has(`${entA.id}_0`);
              const isFixedA1 = fixedPoints.has(`${entA.id}_1`);
              const isFixedB0 = fixedPoints.has(`${entB.id}_0`);
              const isFixedB1 = fixedPoints.has(`${entB.id}_1`);
              const isFixedA = isFixedA0 || isFixedA1;
              const isFixedB = isFixedB0 || isFixedB1;

              if (isFixedA && !isFixedB) {
                rotB = rotB - rotA;
                rotA = 0;
              } else if (!isFixedA && isFixedB) {
                rotA = rotA - rotB;
                rotB = 0;
              }

              const rotatePoint = (pt: Point2D, pivot: Point2D, angle: number) => {
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);
                return {
                  x: cos * (pt.x - pivot.x) - sin * (pt.y - pivot.y) + pivot.x,
                  y: sin * (pt.x - pivot.x) + cos * (pt.y - pivot.y) + pivot.y,
                };
              };

              const midA = { x: (entA.start.x + entA.end.x) / 2, y: (entA.start.y + entA.end.y) / 2 };
              const midB = { x: (entB.start.x + entB.end.x) / 2, y: (entB.start.y + entB.end.y) / 2 };
              const pivotA = isFixedA0 ? entA.start : isFixedA1 ? entA.end : midA;
              const pivotB = isFixedB0 ? entB.start : isFixedB1 ? entB.end : midB;

              if (Math.abs(rotA) > 1e-6) {
                workingEntities[entA.id] = {
                  ...entA,
                  start: rotatePoint(entA.start, pivotA, rotA),
                  end: rotatePoint(entA.end, pivotA, rotA),
                };
              }
              if (Math.abs(rotB) > 1e-6) {
                workingEntities[entB.id] = {
                  ...entB,
                  start: rotatePoint(entB.start, pivotB, rotB),
                  end: rotatePoint(entB.end, pivotB, rotB),
                };
              }
            }
          }
        }
      }
    }

    if (maxDisp <= SOLVER_TOLERANCE) {
      converged = true;
      break;
    }
  }

  return {
    entities: Object.values(workingEntities),
    iterations,
    maxDisp,
    converged,
    conflictEntityIds: converged ? [] : constraints.flatMap((c) => c.entityIds),
  };
}

export function analyzeSketchDOF(
  entities: CADEntity2D[],
  constraints: Constraint[]
): SketchDofState {
  const activeEntities = entities.filter((e) => !e.isConstruction && e.visible !== false);
  const entityStates: Record<string, EntityState> = {};

  let totalDof = 0;
  for (const ent of activeEntities) {
    if (ent.type === 'line') totalDof += 4;
    else if (ent.type === 'circle') totalDof += 3;
    else if (ent.type === 'arc') totalDof += 5;
    else if (ent.type === 'polyline') totalDof += ent.points.length * 2;
    entityStates[ent.id] = 'UnderDefined';
  }

  let consumedDof = 0;
  for (const c of constraints) {
    switch (c.type) {
      case 'fix':
      case 'coincident':
        consumedDof += 2;
        break;
      case 'horizontal':
      case 'vertical':
      case 'length':
      case 'distance':
      case 'distance_x':
      case 'distance_y':
      case 'parallel':
      case 'perpendicular':
      case 'tangent':
      case 'equal_length':
      case 'equal_radius':
      case 'angle':
        consumedDof += 1;
        break;
    }
  }

  const remainingDof = totalDof - consumedDof;
  let overallState: EntityState = 'UnderDefined';

  if (remainingDof < 0) {
    overallState = 'OverDefined';
    activeEntities.forEach((e) => {
      entityStates[e.id] = 'OverDefined';
    });
  } else if (remainingDof === 0 && activeEntities.length > 0) {
    overallState = 'FullyDefined';
    activeEntities.forEach((e) => {
      entityStates[e.id] = 'FullyDefined';
    });
  }

  return {
    totalDof: Math.max(0, remainingDof),
    state: overallState,
    entityStates,
  };
}
