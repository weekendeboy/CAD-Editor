import { LineEntity, Point2D, Constraint } from '../../types/cad';

export interface ChamferResult {
  chamferLine: LineEntity;
  trimmedEntity1: LineEntity;
  trimmedEntity2: LineEntity;
  generatedConstraints: Constraint[];
}

/**
 * 倒角 (Chamfer) 幾何運算引擎。
 * 支援兩相交直線 (Line-Line) 的等距倒角 (D1 = D2 = distance)。
 *
 * 步驟：
 * 1. 計算兩線段的虛擬交點 I。
 * 2. 判定兩線段朝向遠端（保留端）的單位向量。
 * 3. 沿遠端方向退縮指定的 distance，計算新的退縮端點。
 * 4. 修改兩線段靠近交點處的端點至退縮端點。
 * 5. 產生連接兩退縮端點的全新直線 (Chamfer Line)。
 * 6. 生成新倒角線與兩原線段端點間的重合約束 (Coincident Constraints)。
 */
export function createChamfer(
  ent1: LineEntity,
  ent2: LineEntity,
  distance: number = 10,
  pickPt1?: Point2D,
  pickPt2?: Point2D
): ChamferResult | null {
  if (ent1.type !== 'line' || ent2.type !== 'line') {
    return null;
  }
  if (distance <= 0) {
    return null;
  }

  const p1 = ent1.start;
  const p2 = ent1.end;
  const p3 = ent2.start;
  const p4 = ent2.end;

  const vx1 = p2.x - p1.x;
  const vy1 = p2.y - p1.y;
  const vx2 = p4.x - p3.x;
  const vy2 = p4.y - p3.y;

  const D = vx1 * vy2 - vy1 * vx2;
  if (Math.abs(D) < 1e-10) {
    return null; // 兩直線平行或共線，無法形成倒角
  }

  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;
  const t = (dx * vy2 - dy * vx2) / D;

  // 虛擬交點 I (Intersection Point)
  const I: Point2D = {
    x: p1.x + t * vx1,
    y: p1.y + t * vy1,
  };

  // 判定線段 1 靠近交點與遠離交點的端點
  const distA1 = Math.hypot(p1.x - I.x, p1.y - I.y);
  const distB1 = Math.hypot(p2.x - I.x, p2.y - I.y);
  let p1_near = distA1 < distB1 ? p1 : p2;
  let p1_far = distA1 < distB1 ? p2 : p1;

  // 判定線段 2 靠近交點與遠離交點的端點
  const distA2 = Math.hypot(p3.x - I.x, p3.y - I.y);
  const distB2 = Math.hypot(p4.x - I.x, p4.y - I.y);
  let p2_near = distA2 < distB2 ? p3 : p4;
  let p2_far = distA2 < distB2 ? p4 : p3;

  // 若使用者有點擊特定點，且點擊點可明確區分在交點哪一側（針對完全交叉的十字線）
  if (pickPt1) {
    const dotPick1 = (pickPt1.x - I.x) * (p1_far.x - I.x) + (pickPt1.y - I.y) * (p1_far.y - I.y);
    const dotNear1 = (pickPt1.x - I.x) * (p1_near.x - I.x) + (pickPt1.y - I.y) * (p1_near.y - I.y);
    if (dotNear1 > 0 && dotNear1 > dotPick1) {
      // 點擊在 near 側
      const tmp = p1_near;
      p1_near = p1_far;
      p1_far = tmp;
    }
  }

  if (pickPt2) {
    const dotPick2 = (pickPt2.x - I.x) * (p2_far.x - I.x) + (pickPt2.y - I.y) * (p2_far.y - I.y);
    const dotNear2 = (pickPt2.x - I.x) * (p2_near.x - I.x) + (pickPt2.y - I.y) * (p2_near.y - I.y);
    if (dotNear2 > 0 && dotNear2 > dotPick2) {
      // 點擊在 near 側
      const tmp = p2_near;
      p2_near = p2_far;
      p2_far = tmp;
    }
  }

  const distFar1 = Math.hypot(p1_far.x - I.x, p1_far.y - I.y);
  const distFar2 = Math.hypot(p2_far.x - I.x, p2_far.y - I.y);

  if (distFar1 < 1e-5 || distFar2 < 1e-5) {
    return null;
  }

  // 單位方向向量（由交點 I 指向遠端）
  const u1 = {
    x: (p1_far.x - I.x) / distFar1,
    y: (p1_far.y - I.y) / distFar1,
  };

  const u2 = {
    x: (p2_far.x - I.x) / distFar2,
    y: (p2_far.y - I.y) / distFar2,
  };

  const cosAlpha = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
  const alpha = Math.acos(cosAlpha);

  // 夾角過小或接近 180 度共線無法形成倒角
  if (alpha < 1e-4 || alpha > Math.PI - 1e-4) {
    return null;
  }

  // 檢查倒角距離是否過大超出線段長度
  if (distance >= distFar1 || distance >= distFar2) {
    return null;
  }

  // 沿著兩線段方向往回退縮指定的 distance，得到兩個新的退縮端點
  const P1_retract: Point2D = {
    x: I.x + distance * u1.x,
    y: I.y + distance * u1.y,
  };

  const P2_retract: Point2D = {
    x: I.x + distance * u2.x,
    y: I.y + distance * u2.y,
  };

  // 修改原線段的端點座標至退縮端點
  const isStartNear1 = p1_near === p1;
  const trimmedLine1: LineEntity = {
    ...ent1,
    start: isStartNear1 ? P1_retract : ent1.start,
    end: isStartNear1 ? ent1.end : P1_retract,
  };

  const isStartNear2 = p2_near === p3;
  const trimmedLine2: LineEntity = {
    ...ent2,
    start: isStartNear2 ? P2_retract : ent2.start,
    end: isStartNear2 ? ent2.end : P2_retract,
  };

  const line1PtIdx = isStartNear1 ? 0 : 1;
  const line2PtIdx = isStartNear2 ? 0 : 1;

  // 生成一條連接兩個退縮端點的全新直線 (Chamfer Line)
  const chamferLineId = 'chamfer-' + Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
  const chamferLine: LineEntity = {
    id: chamferLineId,
    layerId: ent1.layerId || 'layer-0',
    visible: ent1.visible !== undefined ? ent1.visible : true,
    locked: ent1.locked !== undefined ? ent1.locked : false,
    color: ent1.color,
    lineWidth: ent1.lineWidth,
    isConstruction: ent1.isConstruction,
    type: 'line',
    start: P1_retract,
    end: P2_retract,
  };

  // 生成約束：在兩交點處建立重合約束 (Coincident Constraints)
  const uuid = () => Math.random().toString(36).substring(2, 11);

  const coincident1: Constraint = {
    id: `c-coincident-${ent1.id}-${chamferLineId}-${uuid()}`,
    type: 'coincident',
    entityIds: [ent1.id, chamferLineId],
    pointIndices: [line1PtIdx, 0], // 連接 ent1 的退縮端點與 chamferLine 的 start
  };

  const coincident2: Constraint = {
    id: `c-coincident-${ent2.id}-${chamferLineId}-${uuid()}`,
    type: 'coincident',
    entityIds: [ent2.id, chamferLineId],
    pointIndices: [line2PtIdx, 1], // 連接 ent2 的退縮端點與 chamferLine 的 end
  };

  return {
    chamferLine,
    trimmedEntity1: trimmedLine1,
    trimmedEntity2: trimmedLine2,
    generatedConstraints: [coincident1, coincident2],
  };
}
