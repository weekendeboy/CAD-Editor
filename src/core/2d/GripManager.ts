import { CADEntity2D, Point2D, Constraint } from '../../types/cad';
import { calculate3PointArc, normalizeAngle } from './GeometryMath';
import { solveConstraints } from '../solver/NumericalConstraintSolver';

export type GripType =
  | 'line_start'
  | 'line_mid'
  | 'line_end'
  | 'circle_center'
  | 'circle_quadrant'
  | 'arc_center'
  | 'arc_start'
  | 'arc_mid'
  | 'arc_end'
  | 'polyline_vertex';

export interface EntityGrip {
  id: string;          // 格式: `${entityId}_${gripType}_${index}`
  entityId: string;
  type: GripType;
  point: Point2D;      // 夾點當前世界座標
  cursorStyle: string; // CSS 游標樣式，例如 'crosshair', 'move', 'nwse-resize'
}

/**
 * 提取單一圖元的所有夾點 (Grips)
 *
 * @param entity CAD 2D 圖元物件
 * @returns 該圖元對應的夾點清單
 */
export function getEntityGrips(entity: CADEntity2D): EntityGrip[] {
  if (
    entity.isProjected ||
    entity.id.startsWith('virtual_') ||
    entity.id.startsWith('proj_') ||
    entity.id.includes('_proj_')
  ) {
    return [];
  }

  const grips: EntityGrip[] = [];

  switch (entity.type) {
    case 'line': {
      const { start, end } = entity;
      const midPoint: Point2D = {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
      };

      grips.push({
        id: `${entity.id}_line_start_0`,
        entityId: entity.id,
        type: 'line_start',
        point: { x: start.x, y: start.y },
        cursorStyle: 'crosshair',
      });

      grips.push({
        id: `${entity.id}_line_mid_0`,
        entityId: entity.id,
        type: 'line_mid',
        point: midPoint,
        cursorStyle: 'move',
      });

      grips.push({
        id: `${entity.id}_line_end_0`,
        entityId: entity.id,
        type: 'line_end',
        point: { x: end.x, y: end.y },
        cursorStyle: 'crosshair',
      });
      break;
    }

    case 'circle': {
      const { center, radius } = entity;
      const safeRadius = Math.max(0.001, radius);

      grips.push({
        id: `${entity.id}_circle_center_0`,
        entityId: entity.id,
        type: 'circle_center',
        point: { x: center.x, y: center.y },
        cursorStyle: 'move',
      });

      // 4 個四分點: 0°, 90°, 180°, 270°
      const quadrants: { pt: Point2D; cursor: string }[] = [
        { pt: { x: center.x + safeRadius, y: center.y }, cursor: 'ew-resize' },
        { pt: { x: center.x, y: center.y + safeRadius }, cursor: 'ns-resize' },
        { pt: { x: center.x - safeRadius, y: center.y }, cursor: 'ew-resize' },
        { pt: { x: center.x, y: center.y - safeRadius }, cursor: 'ns-resize' },
      ];

      quadrants.forEach((q, idx) => {
        grips.push({
          id: `${entity.id}_circle_quadrant_${idx}`,
          entityId: entity.id,
          type: 'circle_quadrant',
          point: q.pt,
          cursorStyle: q.cursor,
        });
      });
      break;
    }

    case 'arc': {
      const { center, radius, startAngle, endAngle } = entity;
      const safeRadius = Math.max(0.001, radius);
      const sa = normalizeAngle(startAngle);
      const ea = normalizeAngle(endAngle);

      grips.push({
        id: `${entity.id}_arc_center_0`,
        entityId: entity.id,
        type: 'arc_center',
        point: { x: center.x, y: center.y },
        cursorStyle: 'move',
      });

      // 起點座標
      const startPt: Point2D = {
        x: center.x + safeRadius * Math.cos(sa),
        y: center.y + safeRadius * Math.sin(sa),
      };
      grips.push({
        id: `${entity.id}_arc_start_0`,
        entityId: entity.id,
        type: 'arc_start',
        point: startPt,
        cursorStyle: 'crosshair',
      });

      // 中點角度計算
      let sweep = normalizeAngle(ea - sa);
      if (sweep <= 1e-9) {
        sweep = 2 * Math.PI;
      }
      const midAngle = normalizeAngle(sa + sweep / 2);
      const midPt: Point2D = {
        x: center.x + safeRadius * Math.cos(midAngle),
        y: center.y + safeRadius * Math.sin(midAngle),
      };
      grips.push({
        id: `${entity.id}_arc_mid_0`,
        entityId: entity.id,
        type: 'arc_mid',
        point: midPt,
        cursorStyle: 'crosshair',
      });

      // 終點座標
      const endPt: Point2D = {
        x: center.x + safeRadius * Math.cos(ea),
        y: center.y + safeRadius * Math.sin(ea),
      };
      grips.push({
        id: `${entity.id}_arc_end_0`,
        entityId: entity.id,
        type: 'arc_end',
        point: endPt,
        cursorStyle: 'crosshair',
      });
      break;
    }

    case 'polyline': {
      entity.points.forEach((pt, idx) => {
        grips.push({
          id: `${entity.id}_polyline_vertex_${idx}`,
          entityId: entity.id,
          type: 'polyline_vertex',
          point: { x: pt.x, y: pt.y },
          cursorStyle: 'crosshair',
        });
      });
      break;
    }

    default:
      break;
  }

  return grips;
}

/**
 * 提取複數圖元的所有夾點清單
 *
 * @param entities CAD 2D 圖元陣列
 * @returns 展平後的所有夾點清單
 */
export function getAllGrips(entities: CADEntity2D[]): EntityGrip[] {
  return entities.flatMap((entity) => getEntityGrips(entity));
}

/**
 * 夾點命中檢測 (findHitGrip)
 *
 * @param worldPt 滑鼠世界座標
 * @param grips 選取圖元的夾點清單
 * @param threshold 容差距離 (通常為 8 / scale)
 * @returns 距離最近的 EntityGrip，若未命中回傳 null
 */
export function findHitGrip(
  worldPt: Point2D,
  grips: EntityGrip[],
  threshold: number
): EntityGrip | null {
  if (grips.length === 0 || threshold <= 0) {
    return null;
  }

  let closestGrip: EntityGrip | null = null;
  let minDistance = threshold;

  for (const grip of grips) {
    const dist = Math.hypot(worldPt.x - grip.point.x, worldPt.y - grip.point.y);
    if (dist <= minDistance) {
      minDistance = dist;
      closestGrip = grip;
    }
  }

  return closestGrip;
}

/**
 * 動態形變純函數 (applyGripDrag)
 * 傳入原始圖元、拖曳的夾點與當前游標世界座標，回傳變形後的全新圖元物件。
 *
 * @param entity 原始 CAD 圖元
 * @param grip 當前拖曳的夾點
 * @param currentPt 當前游標世界座標
 * @returns 變形後的全新 CAD 圖元物件
 */
export function applyGripDrag(
  entity: CADEntity2D,
  grip: EntityGrip,
  currentPt: Point2D
): CADEntity2D {
  switch (entity.type) {
    case 'line': {
      if (grip.type === 'line_start') {
        return {
          ...entity,
          start: { x: currentPt.x, y: currentPt.y },
        };
      }
      if (grip.type === 'line_end') {
        return {
          ...entity,
          end: { x: currentPt.x, y: currentPt.y },
        };
      }
      if (grip.type === 'line_mid') {
        const dx = currentPt.x - grip.point.x;
        const dy = currentPt.y - grip.point.y;
        return {
          ...entity,
          start: {
            x: entity.start.x + dx,
            y: entity.start.y + dy,
          },
          end: {
            x: entity.end.x + dx,
            y: entity.end.y + dy,
          },
        };
      }
      break;
    }

    case 'circle': {
      if (grip.type === 'circle_center') {
        return {
          ...entity,
          center: { x: currentPt.x, y: currentPt.y },
        };
      }
      if (grip.type === 'circle_quadrant') {
        const newRadius = Math.max(
          0.001,
          Math.hypot(currentPt.x - entity.center.x, currentPt.y - entity.center.y)
        );
        return {
          ...entity,
          radius: newRadius,
        };
      }
      break;
    }

    case 'arc': {
      if (grip.type === 'arc_center') {
        return {
          ...entity,
          center: { x: currentPt.x, y: currentPt.y },
        };
      }
      if (grip.type === 'arc_start') {
        const dx = currentPt.x - entity.center.x;
        const dy = currentPt.y - entity.center.y;
        if (Math.hypot(dx, dy) < 1e-9) {
          return entity;
        }
        const newStartAngle = normalizeAngle(Math.atan2(dy, dx));
        return {
          ...entity,
          startAngle: newStartAngle,
        };
      }
      if (grip.type === 'arc_end') {
        const dx = currentPt.x - entity.center.x;
        const dy = currentPt.y - entity.center.y;
        if (Math.hypot(dx, dy) < 1e-9) {
          return entity;
        }
        const newEndAngle = normalizeAngle(Math.atan2(dy, dx));
        return {
          ...entity,
          endAngle: newEndAngle,
        };
      }
      if (grip.type === 'arc_mid') {
        const sa = normalizeAngle(entity.startAngle);
        const ea = normalizeAngle(entity.endAngle);
        const p1: Point2D = {
          x: entity.center.x + entity.radius * Math.cos(sa),
          y: entity.center.y + entity.radius * Math.sin(sa),
        };
        const p2: Point2D = {
          x: entity.center.x + entity.radius * Math.cos(ea),
          y: entity.center.y + entity.radius * Math.sin(ea),
        };

        const arcRes = calculate3PointArc(p1, p2, currentPt);
        if (!arcRes) {
          return entity;
        }

        return {
          ...entity,
          center: arcRes.center,
          radius: Math.max(0.001, arcRes.radius),
          startAngle: normalizeAngle(arcRes.startAngle),
          endAngle: normalizeAngle(arcRes.endAngle),
        };
      }
      break;
    }

    case 'polyline': {
      if (grip.type === 'polyline_vertex') {
        const match = grip.id.match(/_(\d+)$/);
        if (match) {
          const idx = parseInt(match[1], 10);
          const newPoints = [...entity.points];
          newPoints[idx] = { x: currentPt.x, y: currentPt.y };
          return {
            ...entity,
            points: newPoints,
          };
        }
      }
      break;
    }

    default:
      break;
  }

  return entity;
}

/**
 * 結合約束求解器的夾點拖曳動態形變純函數 (applyGripDragWithConstraints)
 *
 * @param entities 目前草圖中的所有圖元陣列
 * @param constraints 目前草圖中的約束條件陣列
 * @param activeGrip 包含當前被拖曳夾點與其對應原始圖元的物件
 * @param currentPt 當前游標的世界座標
 * @returns 經過約束求解後最新的全圖元陣列
 */
export function applyGripDragWithConstraints(
  entities: CADEntity2D[],
  constraints: Constraint[],
  activeGrip: { grip: EntityGrip; originalEntity: CADEntity2D },
  currentPt: Point2D
): CADEntity2D[] {
  // 步驟 A：呼叫既有的 applyGripDrag 取得初步變形後的圖元 draggedEntity
  const draggedEntity = applyGripDrag(
    activeGrip.originalEntity,
    activeGrip.grip,
    currentPt
  );

  // 步驟 B：構建基礎工作圖元清單
  const workingEntities = entities.map((ent) =>
    ent.id === draggedEntity.id ? draggedEntity : ent
  );

  // 步驟 C：若草圖無約束（!constraints || constraints.length === 0），直接回傳 workingEntities
  if (!constraints || constraints.length === 0) {
    return workingEntities;
  }

  // 步驟 D：若草圖存在約束，依據當前夾點類型生成低權重軟拖曳目標約束（Soft Drag Target Constraint）
  const tempFixConstraints: Constraint[] = [];
  const { grip } = activeGrip;

  if (grip.type === 'line_start') {
    tempFixConstraints.push({
      id: '__temp_fix_start',
      type: 'fix',
      entityIds: [draggedEntity.id],
      pointIndices: [0],
      weight: 0.05,
      isSoft: true,
    });
  } else if (grip.type === 'line_end') {
    tempFixConstraints.push({
      id: '__temp_fix_end',
      type: 'fix',
      entityIds: [draggedEntity.id],
      pointIndices: [1],
      weight: 0.05,
      isSoft: true,
    });
  } else if (grip.type === 'line_mid') {
    tempFixConstraints.push({
      id: '__temp_fix_start',
      type: 'fix',
      entityIds: [draggedEntity.id],
      pointIndices: [0],
      weight: 0.05,
      isSoft: true,
    });
    tempFixConstraints.push({
      id: '__temp_fix_end',
      type: 'fix',
      entityIds: [draggedEntity.id],
      pointIndices: [1],
      weight: 0.05,
      isSoft: true,
    });
  } else if (grip.type === 'circle_center' || grip.type === 'arc_center') {
    tempFixConstraints.push({
      id: '__temp_fix_center',
      type: 'fix',
      entityIds: [draggedEntity.id],
      pointIndices: [0],
      weight: 0.05,
      isSoft: true,
    });
  } else if (grip.type === 'polyline_vertex') {
    const match = grip.id.match(/_(\d+)$/);
    if (match) {
      tempFixConstraints.push({
        id: '__temp_fix_vertex',
        type: 'fix',
        entityIds: [draggedEntity.id],
        pointIndices: [parseInt(match[1], 10)],
        weight: 0.05,
        isSoft: true,
      });
    }
  }

  // 步驟 E：呼叫 solveConstraints 求解
  const result = solveConstraints(workingEntities, [
    ...constraints,
    ...tempFixConstraints,
  ]);

  // 步驟 F：回傳 result.entities
  return result.entities;
}
