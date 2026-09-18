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
 * 1. 計算兩線段的交點 I。
 * 2. 根據 pickPt1 / pickPt2 判定兩線段在交點形成的 4 個象限中欲保留的射線方向 (u1, u2)。
 * 3. 沿保留方向退縮指定的 distance，計算新的退縮端點。
 * 4. 將原線段靠近交點側的端點縮短至退縮端點。
 * 5. 產生連接兩退縮端點的全新直線 (Chamfer Line)。
 * 6. 生成重合約束 (Coincident Constraints)。
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
  const len1 = Math.hypot(vx1, vy1);
  if (len1 < 1e-6) return null;

  const vx2 = p4.x - p3.x;
  const vy2 = p4.y - p3.y;
  const len2 = Math.hypot(vx2, vy2);
  if (len2 < 1e-6) return null;

  const D = vx1 * vy2 - vy1 * vx2;
  if (Math.abs(D) < 1e-10) {
    return null; // 兩直線平行或共線，無法形成倒角
  }

  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;
  const t = (dx * vy2 - dy * vx2) / D;

  // 交點 I (Intersection Point)
  const I: Point2D = {
    x: p1.x + t * vx1,
    y: p1.y + t * vy1,
  };

  // 判定 Line 1 在交點 I 哪一側建立倒角 (u1 方向)
  const e1 = { x: vx1 / len1, y: vy1 / len1 };
  let dir1 = 1;
  if (pickPt1) {
    const projPick1 = (pickPt1.x - I.x) * e1.x + (pickPt1.y - I.y) * e1.y;
    if (Math.abs(projPick1) > 1e-5) {
      dir1 = projPick1 > 0 ? 1 : -1;
    } else {
      const midProj1 = ((p1.x + p2.x) / 2 - I.x) * e1.x + ((p1.y + p2.y) / 2 - I.y) * e1.y;
      dir1 = midProj1 >= 0 ? 1 : -1;
    }
  } else {
    const midProj1 = ((p1.x + p2.x) / 2 - I.x) * e1.x + ((p1.y + p2.y) / 2 - I.y) * e1.y;
    dir1 = midProj1 >= 0 ? 1 : -1;
  }
  const u1 = { x: dir1 * e1.x, y: dir1 * e1.y };

  const sA1 = (p1.x - I.x) * u1.x + (p1.y - I.y) * u1.y;
  const sB1 = (p2.x - I.x) * u1.x + (p2.y - I.y) * u1.y;
  const sFar1 = Math.max(sA1, sB1);
  if (sFar1 < 1e-5) return null; // 該方向無可保留之線段

  // 判定 Line 2 在交點 I 哪一側建立倒角 (u2 方向)
  const e2 = { x: vx2 / len2, y: vy2 / len2 };
  let dir2 = 1;
  if (pickPt2) {
    const projPick2 = (pickPt2.x - I.x) * e2.x + (pickPt2.y - I.y) * e2.y;
    if (Math.abs(projPick2) > 1e-5) {
      dir2 = projPick2 > 0 ? 1 : -1;
    } else {
      const midProj2 = ((p3.x + p4.x) / 2 - I.x) * e2.x + ((p3.y + p4.y) / 2 - I.y) * e2.y;
      dir2 = midProj2 >= 0 ? 1 : -1;
    }
  } else {
    const midProj2 = ((p3.x + p4.x) / 2 - I.x) * e2.x + ((p3.y + p4.y) / 2 - I.y) * e2.y;
    dir2 = midProj2 >= 0 ? 1 : -1;
  }
  const u2 = { x: dir2 * e2.x, y: dir2 * e2.y };

  const sA2 = (p3.x - I.x) * u2.x + (p3.y - I.y) * u2.y;
  const sB2 = (p4.x - I.x) * u2.x + (p4.y - I.y) * u2.y;
  const sFar2 = Math.max(sA2, sB2);
  if (sFar2 < 1e-5) return null;

  const cosAlpha = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
  const alpha = Math.acos(cosAlpha);
  if (alpha < 1e-4 || alpha > Math.PI - 1e-4) {
    return null;
  }

  // 檢查倒角距離是否過大超出線段長度
  if (distance >= sFar1 - 1e-5 || distance >= sFar2 - 1e-5) {
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

  // 修改原線段：捨棄近交點端，縮短至退縮端點
  const isStartNear1 = sA1 < sB1;
  const trimmedLine1: LineEntity = {
    ...ent1,
    start: isStartNear1 ? P1_retract : ent1.start,
    end: isStartNear1 ? ent1.end : P1_retract,
  };

  const isStartNear2 = sA2 < sB2;
  const trimmedLine2: LineEntity = {
    ...ent2,
    start: isStartNear2 ? P2_retract : ent2.start,
    end: isStartNear2 ? ent2.end : P2_retract,
  };

  const line1PtIdx = isStartNear1 ? 0 : 1;
  const line2PtIdx = isStartNear2 ? 0 : 1;

  // 生成連接兩個退縮端點的全新直線 (Chamfer Line)
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
