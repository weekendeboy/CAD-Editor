import { LineEntity, ArcEntity, Point2D, Constraint, CADEntity2D } from '../../types/cad';

export interface FilletResult {
  arc: ArcEntity;
  trimmedEntity1: CADEntity2D; // Line 或 Arc
  trimmedEntity2: CADEntity2D; // Line 或 Arc
  generatedConstraints: Constraint[];
}

const normalizeAngle = (angle: number): number => {
  let res = angle % (2 * Math.PI);
  if (res < 0) res += 2 * Math.PI;
  return res;
};

const isAngleOnArc = (angle: number, start: number, end: number): boolean => {
  const s = normalizeAngle(start);
  const e = normalizeAngle(end);
  const a = normalizeAngle(angle);
  if (s <= e) {
    return a >= s && a <= e;
  } else {
    return a >= s || a <= e;
  }
};

/**
 * 通用倒角 (Fillet) 引擎。支援：
 * 1. 直線與直線 (Line-Line)
 * 2. 直線與圓弧 (Line-Arc)
 */
export function createFillet(
  ent1: LineEntity | ArcEntity,
  ent2: LineEntity | ArcEntity,
  radius: number = 10,
  pickPt1?: Point2D,
  pickPt2?: Point2D
): FilletResult | null {
  if (ent1.type === 'line' && ent2.type === 'line') {
    return createLineLineFillet(ent1, ent2, radius, pickPt1, pickPt2);
  } else if (ent1.type === 'line' && ent2.type === 'arc') {
    return createLineArcFillet(ent1, ent2, radius, pickPt1, pickPt2);
  } else if (ent1.type === 'arc' && ent2.type === 'line') {
    // 呼叫 Line-Arc 然後將回傳的修剪後圖元對調
    const res = createLineArcFillet(ent2, ent1, radius, pickPt2, pickPt1);
    if (!res) return null;
    return {
      arc: res.arc,
      trimmedEntity1: res.trimmedEntity2,
      trimmedEntity2: res.trimmedEntity1,
      generatedConstraints: res.generatedConstraints,
    };
  }
  return null;
}

/**
 * 直線與直線的倒角計算
 */
function createLineLineFillet(
  line1: LineEntity,
  line2: LineEntity,
  radius: number,
  pickPt1?: Point2D,
  pickPt2?: Point2D
): FilletResult | null {
  const p1 = line1.start;
  const p2 = line1.end;
  const p3 = line2.start;
  const p4 = line2.end;

  const vx1 = p2.x - p1.x;
  const vy1 = p2.y - p1.y;
  const vx2 = p4.x - p3.x;
  const vy2 = p4.y - p3.y;

  const D = vx1 * vy2 - vy1 * vx2;
  if (Math.abs(D) < 1e-10) {
    return null; // 平行或共線，無法形成圓角
  }

  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;
  const t = (dx * vy2 - dy * vx2) / D;
  
  // 交點 I
  const I: Point2D = {
    x: p1.x + t * vx1,
    y: p1.y + t * vy1,
  };

  // 尋找兩線段中最靠近交點 I 的端點 (near point)
  const distA1 = Math.hypot(p1.x - I.x, p1.y - I.y);
  const distB1 = Math.hypot(p2.x - I.x, p2.y - I.y);
  const p1_near = distA1 < distB1 ? p1 : p2;
  const p1_far = distA1 < distB1 ? p2 : p1;

  const distA2 = Math.hypot(p3.x - I.x, p3.y - I.y);
  const distB2 = Math.hypot(p4.x - I.x, p4.y - I.y);
  const p2_near = distA2 < distB2 ? p3 : p4;
  const p2_far = distA2 < distB2 ? p4 : p3;

  const distFar1 = Math.hypot(p1_far.x - I.x, p1_far.y - I.y);
  const distFar2 = Math.hypot(p2_far.x - I.x, p2_far.y - I.y);

  if (distFar1 < 1e-5 || distFar2 < 1e-5) {
    return null;
  }

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

  if (alpha < 1e-4 || alpha > Math.PI - 1e-4) {
    return null;
  }

  // 交點到切點的距離
  const d_tangent = radius / Math.tan(alpha / 2);

  // 檢查半徑是否過大，導致切點超出線段長度
  if (d_tangent >= distFar1 || d_tangent >= distFar2) {
    return null;
  }

  const T1: Point2D = {
    x: I.x + d_tangent * u1.x,
    y: I.y + d_tangent * u1.y,
  };

  const T2: Point2D = {
    x: I.x + d_tangent * u2.x,
    y: I.y + d_tangent * u2.y,
  };

  const u_sum = { x: u1.x + u2.x, y: u1.y + u2.y };
  const u_sum_len = Math.hypot(u_sum.x, u_sum.y);
  if (u_sum_len < 1e-5) {
    return null;
  }
  const u_bisector = { x: u_sum.x / u_sum_len, y: u_sum.y / u_sum_len };

  const d_bisector = radius / Math.sin(alpha / 2);
  const center: Point2D = {
    x: I.x + d_bisector * u_bisector.x,
    y: I.y + d_bisector * u_bisector.y,
  };

  const theta1 = Math.atan2(T1.y - center.y, T1.x - center.x);
  const theta2 = Math.atan2(T2.y - center.y, T2.x - center.x);

  const a1 = normalizeAngle(theta1);
  const a2 = normalizeAngle(theta2);

  const d1 = normalizeAngle(a2 - a1);
  const d2 = normalizeAngle(a1 - a2);

  let startAngle = 0;
  let endAngle = 0;
  let arcPtIdxForT1 = 0;
  let arcPtIdxForT2 = 1;

  if (d1 < d2) {
    startAngle = a1;
    endAngle = a2;
    arcPtIdxForT1 = 0;
    arcPtIdxForT2 = 1;
  } else {
    startAngle = a2;
    endAngle = a1;
    arcPtIdxForT1 = 1;
    arcPtIdxForT2 = 0;
  }

  const arcId = 'arc-' + Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
  const arc: ArcEntity = {
    id: arcId,
    layerId: line1.layerId || 'layer-0',
    visible: line1.visible !== undefined ? line1.visible : true,
    locked: line1.locked !== undefined ? line1.locked : false,
    color: line1.color,
    lineWidth: line1.lineWidth,
    isConstruction: line1.isConstruction,
    type: 'arc',
    center,
    radius,
    startAngle,
    endAngle,
  };

  const trimmedLine1: LineEntity = {
    ...line1,
    start: distA1 < distB1 ? T1 : line1.start,
    end: distA1 < distB1 ? line1.end : T1,
  };

  const trimmedLine2: LineEntity = {
    ...line2,
    start: distA2 < distB2 ? T2 : line2.start,
    end: distA2 < distB2 ? line2.end : T2,
  };

  const line1PtIdx = distA1 < distB1 ? 0 : 1;
  const line2PtIdx = distA2 < distB2 ? 0 : 1;

  const uuid = () => Math.random().toString(36).substring(2, 11);

  const coincident1: Constraint = {
    id: `c-coincident-${line1.id}-${arcId}-${uuid()}`,
    type: 'coincident',
    entityIds: [line1.id, arcId],
    pointIndices: [line1PtIdx, arcPtIdxForT1],
  };

  const coincident2: Constraint = {
    id: `c-coincident-${line2.id}-${arcId}-${uuid()}`,
    type: 'coincident',
    entityIds: [line2.id, arcId],
    pointIndices: [line2PtIdx, arcPtIdxForT2],
  };

  const tangent1: Constraint = {
    id: `c-tangent-${line1.id}-${arcId}-${uuid()}`,
    type: 'tangent',
    entityIds: [line1.id, arcId],
  };

  const tangent2: Constraint = {
    id: `c-tangent-${line2.id}-${arcId}-${uuid()}`,
    type: 'tangent',
    entityIds: [line2.id, arcId],
  };

  const distanceRadius: Constraint = {
    id: `c-distance-${arcId}-${uuid()}`,
    type: 'distance',
    entityIds: [arcId],
    value: radius,
  };

  return {
    arc,
    trimmedEntity1: trimmedLine1,
    trimmedEntity2: trimmedLine2,
    generatedConstraints: [
      coincident1,
      coincident2,
      tangent1,
      tangent2,
      distanceRadius,
    ],
  };
}

/**
 * 直線與圓弧的倒角計算 (Line-Arc Fillet)
 */
function createLineArcFillet(
  line: LineEntity,
  arcEnt: ArcEntity,
  radius: number,
  pickPt1?: Point2D,
  pickPt2?: Point2D
): FilletResult | null {
  const p1 = line.start;
  const p2 = line.end;
  const C_arc = arcEnt.center;
  const R_arc = arcEnt.radius;

  // 1. 計算圓弧端點座標
  const ptStart = {
    x: C_arc.x + R_arc * Math.cos(arcEnt.startAngle),
    y: C_arc.y + R_arc * Math.sin(arcEnt.startAngle),
  };
  const ptEnd = {
    x: C_arc.x + R_arc * Math.cos(arcEnt.endAngle),
    y: C_arc.y + R_arc * Math.sin(arcEnt.endAngle),
  };

  // 2. 尋找兩圖元中最靠近的兩個端點 (meeting endpoints)
  const d11 = Math.hypot(p1.x - ptStart.x, p1.y - ptStart.y);
  const d12 = Math.hypot(p1.x - ptEnd.x, p1.y - ptEnd.y);
  const d21 = Math.hypot(p2.x - ptStart.x, p2.y - ptStart.y);
  const d22 = Math.hypot(p2.x - ptEnd.x, p2.y - ptEnd.y);

  const minDist = Math.min(d11, d12, d21, d22);
  let L_near = p1;
  let L_far = p2;
  let A_near = ptStart;
  let A_far = ptEnd;
  let arcPtIdx = 0; // 0 for start, 1 for end

  if (minDist === d11) {
    L_near = p1; L_far = p2; A_near = ptStart; A_far = ptEnd; arcPtIdx = 0;
  } else if (minDist === d12) {
    L_near = p1; L_far = p2; A_near = ptEnd; A_far = ptStart; arcPtIdx = 1;
  } else if (minDist === d21) {
    L_near = p2; L_far = p1; A_near = ptStart; A_far = ptEnd; arcPtIdx = 0;
  } else {
    L_near = p2; L_far = p1; A_near = ptEnd; A_far = ptStart; arcPtIdx = 1;
  }

  // 3. 尋找直線與圓弧圓周的交點 I
  const V_line = { x: L_far.x - L_near.x, y: L_far.y - L_near.y };
  const a_line_len_sq = V_line.x * V_line.x + V_line.y * V_line.y;
  if (a_line_len_sq < 1e-10) return null;

  const D_offset = { x: L_near.x - C_arc.x, y: L_near.y - C_arc.y };

  const a_quad = a_line_len_sq;
  const b_quad = 2 * (D_offset.x * V_line.x + D_offset.y * V_line.y);
  const c_quad = D_offset.x * D_offset.x + D_offset.y * D_offset.y - R_arc * R_arc;

  const delta = b_quad * b_quad - 4 * a_quad * c_quad;
  let I: Point2D = L_near;

  if (delta >= 0) {
    const t1 = (-b_quad + Math.sqrt(delta)) / (2 * a_quad);
    const t2 = (-b_quad - Math.sqrt(delta)) / (2 * a_quad);
    const I1 = { x: L_near.x + t1 * V_line.x, y: L_near.y + t1 * V_line.y };
    const I2 = { x: L_near.x + t2 * V_line.x, y: L_near.y + t2 * V_line.y };

    // 選擇離 L_near 最近的交點
    I = Math.abs(t1) < Math.abs(t2) ? I1 : I2;
  } else {
    // 平行或無交點，以兩者靠近點的中心為虛擬交點
    I = { x: (L_near.x + A_near.x) / 2, y: (L_near.y + A_near.y) / 2 };
  }

  // 4. 計算直線單位方向
  const L_len = Math.hypot(V_line.x, V_line.y);
  const u = { x: V_line.x / L_len, y: V_line.y / L_len };
  const n = { x: -u.y, y: u.x }; // 法線

  // 5. 聯立求解：
  // 圓心到直線距離為 R => 圓心位於 L 兩側偏置 R 的平行線上：C(s) = I + s * u + d * n (d = +R 或 -R)
  // 圓心到圓弧圓心 C_arc 距離為 R_arc + k * R (k = +1 外凸切, k = -1 內凹切)
  const d_vals = [radius, -radius];
  const k_vals = [1, -1];

  interface Candidate {
    C: Point2D;
    T_line: Point2D;
    T_arc: Point2D;
    cost: number;
    thetaT_on_arc: number;
  }

  const candidates: Candidate[] = [];

  for (const d of d_vals) {
    for (const k of k_vals) {
      const R_target = R_arc + k * radius;
      if (R_target <= 0) continue;

      // 偏置直線上的點滿足：|| C(s) - C_arc ||^2 = R_target^2
      // C(s) = I + d * n + s * u
      // 令 W = I + d * n - C_arc
      // || W + s * u ||^2 = R_target^2 => s^2 + 2*(W.u)*s + ||W||^2 - R_target^2 = 0
      const W = { x: I.x + d * n.x - C_arc.x, y: I.y + d * n.y - C_arc.y };
      const b_val = 2 * (W.x * u.x + W.y * u.y);
      const c_val = W.x * W.x + W.y * W.y - R_target * R_target;

      const delta_s = b_val * b_val - 4 * c_val;
      if (delta_s >= 0) {
        const s_solutions = [
          (-b_val + Math.sqrt(delta_s)) / 2,
          (-b_val - Math.sqrt(delta_s)) / 2,
        ];

        for (const s of s_solutions) {
          const C = {
            x: I.x + s * u.x + d * n.x,
            y: I.y + s * u.y + d * n.y,
          };

          const T_line = {
            x: I.x + s * u.x,
            y: I.y + s * u.y,
          };

          const to_C = { x: C.x - C_arc.x, y: C.y - C_arc.y };
          const dist_to_C = Math.hypot(to_C.x, to_C.y);
          if (dist_to_C < 1e-5) continue;

          const T_arc = {
            x: C_arc.x + R_arc * (to_C.x / dist_to_C),
            y: C_arc.y + R_arc * (to_C.y / dist_to_C),
          };

          // 計算切點極角
          const thetaT_on_arc = Math.atan2(T_arc.y - C_arc.y, T_arc.x - C_arc.x);

          // 評估與過濾此候選點：
          let penalty = 0;

          // 1. 切點 T_line 必須是在遠端 (L_far) 的方向上 (朝向線段內)
          const dotLine = (T_line.x - I.x) * u.x + (T_line.y - I.y) * u.y;
          if (dotLine <= 1e-3) {
            penalty += 1e9;
          }

          // 2. 切點 T_line 不能超出線段總長度
          const distLine = Math.hypot(T_line.x - I.x, T_line.y - I.y);
          if (distLine >= L_len) {
            penalty += 1e9;
          }

          // 3. 切點 T_arc 必須在圓弧上
          const isOnArc = isAngleOnArc(thetaT_on_arc, arcEnt.startAngle, arcEnt.endAngle);
          if (!isOnArc) {
            penalty += 1e5; // 給予次高處罰
          }

          // 4. 修剪防呆：確保修剪後的圓弧長度不會縮至負數或大於原弧
          const originalSweep = normalizeAngle(arcEnt.endAngle - arcEnt.startAngle);
          const newSweep = arcPtIdx === 0
            ? normalizeAngle(arcEnt.endAngle - thetaT_on_arc)
            : normalizeAngle(thetaT_on_arc - arcEnt.startAngle);

          if (newSweep > originalSweep || newSweep < 1e-4) {
            penalty += 1e9;
          }

          // 優先選擇最靠近預期鎖點/點擊區域的 C
          const refPt1 = pickPt1 || L_near;
          const refPt2 = pickPt2 || A_near;
          const distToRef = Math.hypot(T_line.x - refPt1.x, T_line.y - refPt1.y) +
                            Math.hypot(T_arc.x - refPt2.x, T_arc.y - refPt2.y);

          candidates.push({
            C,
            T_line,
            T_arc,
            cost: penalty + distToRef,
            thetaT_on_arc,
          });
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  // 依成本排序並選擇最佳候選人
  candidates.sort((a, b) => a.cost - b.cost);
  const best = candidates[0];

  if (best.cost >= 1e8) {
    return null; // 無合理過渡圓角
  }

  const center = best.C;
  const T1 = best.T_line;
  const T2 = best.T_arc;

  // 6. 計算 fillet 圓弧角度
  const theta1 = Math.atan2(T1.y - center.y, T1.x - center.x);
  const theta2 = Math.atan2(T2.y - center.y, T2.x - center.x);

  const a1 = normalizeAngle(theta1);
  const a2 = normalizeAngle(theta2);

  const d1 = normalizeAngle(a2 - a1);
  const d2 = normalizeAngle(a1 - a2);

  let startAngle = 0;
  let endAngle = 0;
  let arcPtIdxForT1 = 0; // 對應 T1
  let arcPtIdxForT2 = 1; // 對應 T2

  if (d1 < d2) {
    startAngle = a1;
    endAngle = a2;
    arcPtIdxForT1 = 0;
    arcPtIdxForT2 = 1;
  } else {
    startAngle = a2;
    endAngle = a1;
    arcPtIdxForT1 = 1;
    arcPtIdxForT2 = 0;
  }

  const arcId = 'arc-' + Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
  const arc: ArcEntity = {
    id: arcId,
    layerId: line.layerId || 'layer-0',
    visible: line.visible !== undefined ? line.visible : true,
    locked: line.locked !== undefined ? line.locked : false,
    color: line.color,
    lineWidth: line.lineWidth,
    isConstruction: line.isConstruction,
    type: 'arc',
    center,
    radius,
    startAngle,
    endAngle,
  };

  // 7. 修剪直線與圓弧
  const trimmedLine: LineEntity = {
    ...line,
    start: L_near === p1 ? T1 : line.start,
    end: L_near === p1 ? line.end : T1,
  };

  const trimmedArc: ArcEntity = {
    ...arcEnt,
    startAngle: arcPtIdx === 0 ? normalizeAngle(best.thetaT_on_arc) : arcEnt.startAngle,
    endAngle: arcPtIdx === 0 ? arcEnt.endAngle : normalizeAngle(best.thetaT_on_arc),
  };

  const linePtIdx = L_near === p1 ? 0 : 1;

  // 8. 建立約束
  const uuid = () => Math.random().toString(36).substring(2, 11);

  const coincident1: Constraint = {
    id: `c-coincident-${line.id}-${arcId}-${uuid()}`,
    type: 'coincident',
    entityIds: [line.id, arcId],
    pointIndices: [linePtIdx, arcPtIdxForT1],
  };

  const coincident2: Constraint = {
    id: `c-coincident-${arcEnt.id}-${arcId}-${uuid()}`,
    type: 'coincident',
    entityIds: [arcEnt.id, arcId],
    pointIndices: [arcPtIdx, arcPtIdxForT2],
  };

  const tangent1: Constraint = {
    id: `c-tangent-${line.id}-${arcId}-${uuid()}`,
    type: 'tangent',
    entityIds: [line.id, arcId],
  };

  const tangent2: Constraint = {
    id: `c-tangent-${arcEnt.id}-${arcId}-${uuid()}`,
    type: 'tangent',
    entityIds: [arcEnt.id, arcId],
  };

  const distanceRadius: Constraint = {
    id: `c-distance-${arcId}-${uuid()}`,
    type: 'distance',
    entityIds: [arcId],
    value: radius,
  };

  return {
    arc,
    trimmedEntity1: trimmedLine,
    trimmedEntity2: trimmedArc,
    generatedConstraints: [
      coincident1,
      coincident2,
      tangent1,
      tangent2,
      distanceRadius,
    ],
  };
}
