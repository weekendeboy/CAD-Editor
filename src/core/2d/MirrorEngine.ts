import { Point2D, LineEntity, ArcEntity, CircleEntity, PolylineEntity, CADEntity2D, Constraint } from '../../types/cad';

export interface MirrorResult {
  mirroredEntities: CADEntity2D[];
  generatedConstraints: Constraint[];
}

const uuid = () => Math.random().toString(36).substring(2, 11);

/**
 * 計算點 pt 投影至軸線 L 上的正交投影點 P_proj。
 * 鏡射點為 P_mirrored = 2 * P_proj - pt。
 *
 * @param pt 待鏡射的二維點
 * @param axisStart 軸線起點
 * @param axisEnd 軸線終點
 */
export function mirrorPointAcrossLine(pt: Point2D, axisStart: Point2D, axisEnd: Point2D): Point2D {
  const dx = axisEnd.x - axisStart.x;
  const dy = axisEnd.y - axisStart.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    return { ...pt };
  }

  // 投影因子 t = ((pt - axisStart) · (axisEnd - axisStart)) / lenSq
  const t = ((pt.x - axisStart.x) * dx + (pt.y - axisStart.y) * dy) / lenSq;

  // 正交投影點 P_proj
  const projX = axisStart.x + t * dx;
  const projY = axisStart.y + t * dy;

  // 鏡射點
  return {
    x: 2 * projX - pt.x,
    y: 2 * projY - pt.y,
  };
}

/**
 * 將方向向量繞軸線方向鏡射。
 *
 * @param v 待鏡射的向量
 * @param axisDir 軸線方向向量
 */
export function mirrorVectorAcrossLine(v: Point2D, axisDir: Point2D): Point2D {
  const lenSq = axisDir.x * axisDir.x + axisDir.y * axisDir.y;
  if (lenSq < 1e-12) {
    return { ...v };
  }

  // 投影因子 t = (v · axisDir) / lenSq
  const t = (v.x * axisDir.x + v.y * axisDir.y) / lenSq;

  // 鏡射後的向量為 2 * proj - v
  return {
    x: 2 * t * axisDir.x - v.x,
    y: 2 * t * axisDir.y - v.y,
  };
}

/**
 * 主函式：計算對稱圖元與其對應的約束關係
 *
 * @param sourceEntities 來源圖元陣列
 * @param axisLine 鏡射軸線（直線圖元）
 * @returns 鏡射結果物件，若軸線退化或無效則回傳 null
 */
export function calculateMirror(sourceEntities: CADEntity2D[], axisLine: LineEntity): MirrorResult | null {
  const { start: axisStart, end: axisEnd } = axisLine;
  const dx = axisEnd.x - axisStart.x;
  const dy = axisEnd.y - axisStart.y;
  const axisLength = Math.hypot(dx, dy);

  // 軸線退化防呆：長度極小，則不進行鏡射
  if (axisLength < 1e-10) {
    return null;
  }

  const mirroredEntities: CADEntity2D[] = [];
  const generatedConstraints: Constraint[] = [];

  const normalizeAngle = (angle: number): number => {
    let res = angle % (2 * Math.PI);
    if (res < 0) res += 2 * Math.PI;
    return res;
  };

  for (const entity of sourceEntities) {
    const newId = crypto.randomUUID();

    switch (entity.type) {
      case 'line': {
        const mirroredStart = mirrorPointAcrossLine(entity.start, axisStart, axisEnd);
        const mirroredEnd = mirrorPointAcrossLine(entity.end, axisStart, axisEnd);

        const mirroredLine: LineEntity = {
          ...entity,
          id: newId,
          start: mirroredStart,
          end: mirroredEnd,
          isConstruction: entity.isConstruction,
          layerId: entity.layerId,
          lineWidth: entity.lineWidth,
        };

        mirroredEntities.push(mirroredLine);

        // 為直線生成 equal_length 約束
        const lengthConstraint: Constraint = {
          id: `c-eqlen-${entity.id}-${newId}-${uuid()}`,
          type: 'equal_length',
          entityIds: [entity.id, newId],
        };
        generatedConstraints.push(lengthConstraint);
        break;
      }

      case 'circle': {
        const mirroredCenter = mirrorPointAcrossLine(entity.center, axisStart, axisEnd);

        const mirroredCircle: CircleEntity = {
          ...entity,
          id: newId,
          center: mirroredCenter,
          radius: entity.radius,
          isConstruction: entity.isConstruction,
          layerId: entity.layerId,
          lineWidth: entity.lineWidth,
        };

        mirroredEntities.push(mirroredCircle);

        // 為圓形生成 equal_radius 約束
        const radiusConstraint: Constraint = {
          id: `c-eqrad-${entity.id}-${newId}-${uuid()}`,
          type: 'equal_radius',
          entityIds: [entity.id, newId],
        };
        generatedConstraints.push(radiusConstraint);
        break;
      }

      case 'arc': {
        const { center, radius, startAngle, endAngle } = entity;

        // 原圓弧的起終端點
        const pStart = {
          x: center.x + radius * Math.cos(startAngle),
          y: center.y + radius * Math.sin(startAngle),
        };
        const pEnd = {
          x: center.x + radius * Math.cos(endAngle),
          y: center.y + radius * Math.sin(endAngle),
        };

        const mirroredCenter = mirrorPointAcrossLine(center, axisStart, axisEnd);
        const mirroredStart = mirrorPointAcrossLine(pStart, axisStart, axisEnd);
        const mirroredEnd = mirrorPointAcrossLine(pEnd, axisStart, axisEnd);

        // 由於幾何翻轉，原逆時針方向會變為順時針。
        // 為保持 CAD 系統中的 CCW 標準，對稱弧應從鏡射後的『終點』掃向鏡射後的『起點』。
        let newStartAngle = Math.atan2(mirroredEnd.y - mirroredCenter.y, mirroredEnd.x - mirroredCenter.x);
        let newEndAngle = Math.atan2(mirroredStart.y - mirroredCenter.y, mirroredStart.x - mirroredCenter.x);

        newStartAngle = normalizeAngle(newStartAngle);
        newEndAngle = normalizeAngle(newEndAngle);

        const mirroredArc: ArcEntity = {
          ...entity,
          id: newId,
          center: mirroredCenter,
          radius: radius,
          startAngle: newStartAngle,
          endAngle: newEndAngle,
          isConstruction: entity.isConstruction,
          layerId: entity.layerId,
          lineWidth: entity.lineWidth,
        };

        mirroredEntities.push(mirroredArc);

        // 為圓弧生成 equal_radius 約束
        const radiusConstraint: Constraint = {
          id: `c-eqrad-${entity.id}-${newId}-${uuid()}`,
          type: 'equal_radius',
          entityIds: [entity.id, newId],
        };
        generatedConstraints.push(radiusConstraint);
        break;
      }

      case 'polyline': {
        const mirroredPoints = entity.points.map((pt) =>
          mirrorPointAcrossLine(pt, axisStart, axisEnd)
        );

        const mirroredPolyline: PolylineEntity = {
          ...entity,
          id: newId,
          points: mirroredPoints,
          closed: entity.closed,
          isConstruction: entity.isConstruction,
          layerId: entity.layerId,
          lineWidth: entity.lineWidth,
        };

        mirroredEntities.push(mirroredPolyline);
        break;
      }
    }
  }

  return {
    mirroredEntities,
    generatedConstraints,
  };
}
