import { LineEntity, ArcEntity, Point2D, Constraint, CADEntity2D } from '../../types/cad';
import { isAngleOnArc } from './IntersectionEngine';
import { getArcSweepAngle } from './GeometryMath';

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

/**
 * 兩圓交點計算函式 (Circle-Circle Intersection)
 * 回傳兩圓交點陣列 (0, 1 或 2 個點)
 */
function intersectCircles(
  c1: Point2D,
  r1: number,
  c2: Point2D,
  r2: number
): Point2D[] {
  if (r1 < 1e-5 && r2 < 1e-5) {
    if (Math.hypot(c1.x - c2.x, c1.y - c2.y) < 1e-4) return [{ ...c1 }];
    return [];
  }
  if (r1 < 1e-5) {
    const d = Math.hypot(c1.x - c2.x, c1.y - c2.y);
    if (Math.abs(d - r2) < 1e-4) return [{ ...c1 }];
    return [];
  }
  if (r2 < 1e-5) {
    const d = Math.hypot(c1.x - c2.x, c1.y - c2.y);
    if (Math.abs(d - r1) < 1e-4) return [{ ...c2 }];
    return [];
  }

  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);

  // 同心圓無唯一交點
  if (d < 1e-7) {
    return [];
  }

  // 兩圓相離或包含無交點
  if (d > r1 + r2 + 1e-5 || d < Math.abs(r1 - r2) - 1e-5) {
    return [];
  }

  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const hSq = r1 * r1 - a * a;
  const h = Math.sqrt(Math.max(0, hSq));

  const p0x = c1.x + (a * dx) / d;
  const p0y = c1.y + (a * dy) / d;

  if (h < 1e-6) {
    return [{ x: p0x, y: p0y }];
  }

  const rx = -dy * (h / d);
  const ry = dx * (h / d);

  return [
    { x: p0x + rx, y: p0y + ry },
    { x: p0x - rx, y: p0y - ry },
  ];
}

/**
 * 通用倒角 (Fillet) 引擎。支援：
 * 1. 直線與直線 (Line-Line)
 * 2. 直線與圓弧 (Line-Arc)
 * 3. 圓弧與圓弧 (Arc-Arc)
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
  } else if (ent1.type === 'arc' && ent2.type === 'arc') {
    return createArcArcFillet(ent1, ent2, radius, pickPt1, pickPt2);
  }
  return null;
}

/**
 * 直線與直線的倒角計算 (Line-Line Fillet)
 * 藉由 pickPt1 / pickPt2 判定應在交點形成的 4 個象限中哪一個建立圓角，
 * 並正確縮短原線段至切點 (切點距離 pickPt 最近，捨棄靠近交點側)。
 */
function createLineLineFillet(
  line1: LineEntity,
  line2: LineEntity,
  radius: number,
  pickPt1?: Point2D,
  pickPt2?: Point2D
): FilletResult | null {
  if (radius <= 1e-6) return null;

  const p1 = line1.start;
  const p2 = line1.end;
  const p3 = line2.start;
  const p4 = line2.end;

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
    return null; // 平行或共線
  }

  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;
  const t = (dx * vy2 - dy * vx2) / D;

  // 兩直線交點 I
  const I: Point2D = {
    x: p1.x + t * vx1,
    y: p1.y + t * vy1,
  };

  // 判定 Line 1 在交點 I 哪一側建立圓角 (u1 方向)
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

  // 判定 Line 2 在交點 I 哪一側建立圓角 (u2 方向)
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

  // 交點到切點的距離
  const d_tangent = radius / Math.tan(alpha / 2);
  if (d_tangent > sFar1 - 1e-5 || d_tangent > sFar2 - 1e-5) {
    return null; // 半徑過大超出線段在該側的長度
  }

  // 切點 T1 與 T2
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
  if (u_sum_len < 1e-5) return null;
  const u_bisector = { x: u_sum.x / u_sum_len, y: u_sum.y / u_sum_len };

  const d_bisector = radius / Math.sin(alpha / 2);
  const center: Point2D = {
    x: I.x + d_bisector * u_bisector.x,
    y: I.y + d_bisector * u_bisector.y,
  };

  const theta1 = normalizeAngle(Math.atan2(T1.y - center.y, T1.x - center.x));
  const theta2 = normalizeAngle(Math.atan2(T2.y - center.y, T2.x - center.x));

  const sweepCCW = normalizeAngle(theta2 - theta1);
  const sweepCW = normalizeAngle(theta1 - theta2);

  let startAngle = theta1;
  let endAngle = theta2;
  let clockwise = false;

  // 正確利用 clockwise 確保小角度過渡 (< π)
  if (sweepCCW <= sweepCW) {
    startAngle = theta1;
    endAngle = theta2;
    clockwise = false;
  } else {
    startAngle = theta1;
    endAngle = theta2;
    clockwise = true;
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
    clockwise,
  };

  // 修剪原線段：捨棄近交點側 (sNear)，保留遠端 (sFar)，將端點縮短至切點
  const trimmedLine1: LineEntity = {
    ...line1,
    start: sA1 < sB1 ? T1 : line1.start,
    end: sA1 < sB1 ? line1.end : T1,
  };

  const trimmedLine2: LineEntity = {
    ...line2,
    start: sA2 < sB2 ? T2 : line2.start,
    end: sA2 < sB2 ? line2.end : T2,
  };

  const line1PtIdx = sA1 < sB1 ? 0 : 1;
  const line2PtIdx = sA2 < sB2 ? 0 : 1;

  const uuid = () => Math.random().toString(36).substring(2, 11);

  const coincident1: Constraint = {
    id: `c-coincident-${line1.id}-${arcId}-${uuid()}`,
    type: 'coincident',
    entityIds: [line1.id, arcId],
    pointIndices: [line1PtIdx, 1], // T1 為 arc 的 startPoint (index 1)
  };

  const coincident2: Constraint = {
    id: `c-coincident-${line2.id}-${arcId}-${uuid()}`,
    type: 'coincident',
    entityIds: [line2.id, arcId],
    pointIndices: [line2PtIdx, 2], // T2 為 arc 的 endPoint (index 2)
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

  return {
    arc,
    trimmedEntity1: trimmedLine1,
    trimmedEntity2: trimmedLine2,
    generatedConstraints: [
      coincident1,
      coincident2,
      tangent1,
      tangent2,
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
  if (radius <= 1e-6) return null;

  const p1 = line.start;
  const p2 = line.end;
  const vx = p2.x - p1.x;
  const vy = p2.y - p1.y;
  const len = Math.hypot(vx, vy);
  if (len < 1e-6) return null;

  const u = { x: vx / len, y: vy / len };
  const n = { x: -u.y, y: u.x }; // 法向量

  const C_arc = arcEnt.center;
  const R_arc = arcEnt.radius;

  // 1. 產生候選圓心：直線兩側平行偏移 radius 與圓心同心偏移 (R_arc ± radius) 的交點
  interface Candidate {
    C: Point2D;
    T_line: Point2D;
    T_arc: Point2D;
    linePtIdx: number;
    arcPtIdx: number;
    thetaT_on_arc: number;
    cost: number;
  }

  const candidates: Candidate[] = [];
  const offsetDists = [radius, -radius];

  const targetRadii = [R_arc + radius];
  if (R_arc > radius) {
    targetRadii.push(R_arc - radius);
  } else if (radius > R_arc) {
    targetRadii.push(radius - R_arc);
  }

  for (const d of offsetDists) {
    const P_off: Point2D = {
      x: p1.x + d * n.x,
      y: p1.y + d * n.y,
    };

    for (const rTarget of targetRadii) {
      const W = { x: P_off.x - C_arc.x, y: P_off.y - C_arc.y };
      const b = 2 * (W.x * u.x + W.y * u.y);
      const c = (W.x * W.x + W.y * W.y) - rTarget * rTarget;
      const disc = b * b - 4 * c;

      if (disc < -1e-6) continue;
      const sqrtDisc = Math.sqrt(Math.max(0, disc));
      const sList = sqrtDisc < 1e-6 ? [-b / 2] : [(-b + sqrtDisc) / 2, (-b - sqrtDisc) / 2];

      for (const s of sList) {
        const C: Point2D = {
          x: P_off.x + s * u.x,
          y: P_off.y + s * u.y,
        };

        const T_line: Point2D = {
          x: C.x - d * n.x,
          y: C.y - d * n.y,
        };

        const vArc = { x: C.x - C_arc.x, y: C.y - C_arc.y };
        const lenArc = Math.hypot(vArc.x, vArc.y);
        if (lenArc < 1e-6) continue;

        const T_arc: Point2D = {
          x: C_arc.x + (vArc.x / lenArc) * R_arc,
          y: C_arc.y + (vArc.y / lenArc) * R_arc,
        };

        if (Math.hypot(T_line.x - T_arc.x, T_line.y - T_arc.y) < 1e-5) continue;

        // 檢查切點是否在直線線段上
        const t_line = ((T_line.x - p1.x) * u.x + (T_line.y - p1.y) * u.y) / len;
        let basePenalty = 0;
        if (t_line < -1e-3 || t_line > 1 + 1e-3) {
          basePenalty += 1e9;
        }

        // 決定直線要修剪的端點
        let linePtIdx = 0;
        if (pickPt1) {
          const t_pick1 = ((pickPt1.x - p1.x) * u.x + (pickPt1.y - p1.y) * u.y) / len;
          // 若點擊點靠近 end (t_pick1 >= t_line)，保留 end 側，修剪 start (linePtIdx = 0)
          // 若點擊點靠近 start (t_pick1 < t_line)，保留 start 側，修剪 end (linePtIdx = 1)
          linePtIdx = t_pick1 >= t_line ? 0 : 1;
        } else {
          linePtIdx = Math.hypot(p1.x - T_arc.x, p1.y - T_arc.y) < Math.hypot(p2.x - T_arc.x, p2.y - T_arc.y) ? 0 : 1;
        }

        // 檢查切點是否在圓弧上
        const thetaT_on_arc = normalizeAngle(Math.atan2(T_arc.y - C_arc.y, T_arc.x - C_arc.x));
        const isOnArc = isAngleOnArc(thetaT_on_arc, arcEnt.startAngle, arcEnt.endAngle, arcEnt.clockwise);
        if (!isOnArc) {
          basePenalty += 1e5;
        }

        const origSweep = getArcSweepAngle(arcEnt.startAngle, arcEnt.endAngle, arcEnt.clockwise);

        // 評估修剪圓弧的端點 (0 = startAngle, 1 = endAngle)
        for (const arcPtIdx of [0, 1]) {
          let penalty = basePenalty;

          const newSweep = arcPtIdx === 0
            ? getArcSweepAngle(thetaT_on_arc, arcEnt.endAngle, arcEnt.clockwise)
            : getArcSweepAngle(arcEnt.startAngle, thetaT_on_arc, arcEnt.clockwise);

          if (newSweep > origSweep + 1e-4 || newSweep < 1e-4) {
            penalty += 1e9;
          }

          const remStart = arcPtIdx === 0 ? thetaT_on_arc : arcEnt.startAngle;
          const remEnd = arcPtIdx === 0 ? arcEnt.endAngle : thetaT_on_arc;

          if (pickPt2) {
            const thetaPick2 = normalizeAngle(Math.atan2(pickPt2.y - C_arc.y, pickPt2.x - C_arc.x));
            if (!isAngleOnArc(thetaPick2, remStart, remEnd, arcEnt.clockwise)) {
              penalty += 1e6;
            }
          } else {
            const ptStart = { x: C_arc.x + R_arc * Math.cos(arcEnt.startAngle), y: C_arc.y + R_arc * Math.sin(arcEnt.startAngle) };
            const ptEnd = { x: C_arc.x + R_arc * Math.cos(arcEnt.endAngle), y: C_arc.y + R_arc * Math.sin(arcEnt.endAngle) };
            const prefIdx = Math.hypot(ptStart.x - T_line.x, ptStart.y - T_line.y) < Math.hypot(ptEnd.x - T_line.x, ptEnd.y - T_line.y) ? 0 : 1;
            if (arcPtIdx !== prefIdx) penalty += 500;
          }

          const refPt1 = pickPt1 || (linePtIdx === 0 ? p1 : p2);
          const ptStart = { x: C_arc.x + R_arc * Math.cos(arcEnt.startAngle), y: C_arc.y + R_arc * Math.sin(arcEnt.startAngle) };
          const ptEnd = { x: C_arc.x + R_arc * Math.cos(arcEnt.endAngle), y: C_arc.y + R_arc * Math.sin(arcEnt.endAngle) };
          const refPt2 = pickPt2 || (arcPtIdx === 0 ? ptStart : ptEnd);

          const distRef = Math.hypot(T_line.x - refPt1.x, T_line.y - refPt1.y) + Math.hypot(T_arc.x - refPt2.x, T_arc.y - refPt2.y);

          candidates.push({
            C,
            T_line,
            T_arc,
            linePtIdx,
            arcPtIdx,
            thetaT_on_arc,
            cost: penalty + distRef,
          });
        }
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.cost - b.cost);
  const best = candidates[0];
  if (best.cost >= 1e8) return null;

  // 建立圓角弧
  const theta1 = normalizeAngle(Math.atan2(best.T_line.y - best.C.y, best.T_line.x - best.C.x));
  const theta2 = normalizeAngle(Math.atan2(best.T_arc.y - best.C.y, best.T_arc.x - best.C.x));

  const sweepCCW = normalizeAngle(theta2 - theta1);
  const sweepCW = normalizeAngle(theta1 - theta2);

  const clockwise = sweepCCW > sweepCW;
  const startAngle = theta1;
  const endAngle = theta2;

  const arcId = 'arc-' + Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
  const filletArc: ArcEntity = {
    id: arcId,
    layerId: line.layerId || 'layer-0',
    visible: line.visible !== undefined ? line.visible : true,
    locked: line.locked !== undefined ? line.locked : false,
    color: line.color,
    lineWidth: line.lineWidth,
    isConstruction: line.isConstruction,
    type: 'arc',
    center: best.C,
    radius,
    startAngle,
    endAngle,
    clockwise,
  };

  const trimmedLine: LineEntity = {
    ...line,
    start: best.linePtIdx === 0 ? best.T_line : line.start,
    end: best.linePtIdx === 0 ? line.end : best.T_line,
  };

  const trimmedArc: ArcEntity = {
    ...arcEnt,
    startAngle: best.arcPtIdx === 0 ? normalizeAngle(best.thetaT_on_arc) : arcEnt.startAngle,
    endAngle: best.arcPtIdx === 0 ? arcEnt.endAngle : normalizeAngle(best.thetaT_on_arc),
  };

  const uuid = () => Math.random().toString(36).substring(2, 11);

  const coincident1: Constraint = {
    id: `c-coincident-${line.id}-${arcId}-${uuid()}`,
    type: 'coincident',
    entityIds: [line.id, arcId],
    pointIndices: [best.linePtIdx, 1], // T_line 為 filletArc 的 startPoint (index 1)
  };

  const coincident2: Constraint = {
    id: `c-coincident-${arcEnt.id}-${arcId}-${uuid()}`,
    type: 'coincident',
    entityIds: [arcEnt.id, arcId],
    pointIndices: [best.arcPtIdx === 0 ? 1 : 2, 2], // T_arc 為 filletArc 的 endPoint (index 2)
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

  return {
    arc: filletArc,
    trimmedEntity1: trimmedLine,
    trimmedEntity2: trimmedArc,
    generatedConstraints: [
      coincident1,
      coincident2,
      tangent1,
      tangent2,
    ],
  };
}

/**
 * 圓弧與圓弧的倒角計算 (Arc-Arc Fillet)
 */
function createArcArcFillet(
  arc1: ArcEntity,
  arc2: ArcEntity,
  radius: number,
  pickPt1?: Point2D,
  pickPt2?: Point2D
): FilletResult | null {
  if (radius <= 1e-6) return null;

  const C1 = arc1.center;
  const R1 = arc1.radius;
  const C2 = arc2.center;
  const R2 = arc2.radius;

  const d12 = Math.hypot(C1.x - C2.x, C1.y - C2.y);
  if (d12 < 1e-5) return null; // 同心圓

  const r1Candidates = [R1 + radius];
  if (R1 > radius) r1Candidates.push(R1 - radius);
  else if (radius > R1) r1Candidates.push(radius - R1);

  const r2Candidates = [R2 + radius];
  if (R2 > radius) r2Candidates.push(R2 - radius);
  else if (radius > R2) r2Candidates.push(radius - R2);

  interface ArcArcCandidate {
    C: Point2D;
    T1: Point2D;
    T2: Point2D;
    thetaT1: number;
    thetaT2: number;
    arc1PtIdx: number;
    arc2PtIdx: number;
    cost: number;
  }

  const P1s: Point2D = { x: C1.x + R1 * Math.cos(arc1.startAngle), y: C1.y + R1 * Math.sin(arc1.startAngle) };
  const P1e: Point2D = { x: C1.x + R1 * Math.cos(arc1.endAngle), y: C1.y + R1 * Math.sin(arc1.endAngle) };
  const P2s: Point2D = { x: C2.x + R2 * Math.cos(arc2.startAngle), y: C2.y + R2 * Math.sin(arc2.startAngle) };
  const P2e: Point2D = { x: C2.x + R2 * Math.cos(arc2.endAngle), y: C2.y + R2 * Math.sin(arc2.endAngle) };

  const origSweep1 = getArcSweepAngle(arc1.startAngle, arc1.endAngle, arc1.clockwise);
  const origSweep2 = getArcSweepAngle(arc2.startAngle, arc2.endAngle, arc2.clockwise);

  const candidates: ArcArcCandidate[] = [];

  for (const r1c of r1Candidates) {
    for (const r2c of r2Candidates) {
      const centers = intersectCircles(C1, r1c, C2, r2c);
      for (const C of centers) {
        const v1 = { x: C.x - C1.x, y: C.y - C1.y };
        const len1 = Math.hypot(v1.x, v1.y);
        if (len1 < 1e-6) continue;
        const T1: Point2D = { x: C1.x + (v1.x / len1) * R1, y: C1.y + (v1.y / len1) * R1 };

        const v2 = { x: C.x - C2.x, y: C.y - C2.y };
        const len2 = Math.hypot(v2.x, v2.y);
        if (len2 < 1e-6) continue;
        const T2: Point2D = { x: C2.x + (v2.x / len2) * R2, y: C2.y + (v2.y / len2) * R2 };

        if (Math.hypot(T1.x - T2.x, T1.y - T2.y) < 1e-5) continue;

        const thetaT1 = normalizeAngle(Math.atan2(T1.y - C1.y, T1.x - C1.x));
        const thetaT2 = normalizeAngle(Math.atan2(T2.y - C2.y, T2.x - C2.x));

        const isOnArc1 = isAngleOnArc(thetaT1, arc1.startAngle, arc1.endAngle, arc1.clockwise);
        const isOnArc2 = isAngleOnArc(thetaT2, arc2.startAngle, arc2.endAngle, arc2.clockwise);

        let basePenalty = 0;
        if (!isOnArc1) basePenalty += 1e5;
        if (!isOnArc2) basePenalty += 1e5;

        for (const idx1 of [0, 1]) {
          for (const idx2 of [0, 1]) {
            let penalty = basePenalty;

            const newSweep1 = idx1 === 0
              ? getArcSweepAngle(thetaT1, arc1.endAngle, arc1.clockwise)
              : getArcSweepAngle(arc1.startAngle, thetaT1, arc1.clockwise);

            const newSweep2 = idx2 === 0
              ? getArcSweepAngle(thetaT2, arc2.endAngle, arc2.clockwise)
              : getArcSweepAngle(arc2.startAngle, thetaT2, arc2.clockwise);

            if (newSweep1 > origSweep1 + 1e-4 || newSweep1 < 1e-4) penalty += 1e9;
            if (newSweep2 > origSweep2 + 1e-4 || newSweep2 < 1e-4) penalty += 1e9;

            const remStart1 = idx1 === 0 ? thetaT1 : arc1.startAngle;
            const remEnd1 = idx1 === 0 ? arc1.endAngle : thetaT1;
            if (pickPt1) {
              const thetaPick1 = normalizeAngle(Math.atan2(pickPt1.y - C1.y, pickPt1.x - C1.x));
              if (!isAngleOnArc(thetaPick1, remStart1, remEnd1, arc1.clockwise)) {
                penalty += 1e6;
              }
            } else {
              const prefIdx1 = Math.hypot(P1s.x - T2.x, P1s.y - T2.y) < Math.hypot(P1e.x - T2.x, P1e.y - T2.y) ? 0 : 1;
              if (idx1 !== prefIdx1) penalty += 500;
            }

            const remStart2 = idx2 === 0 ? thetaT2 : arc2.startAngle;
            const remEnd2 = idx2 === 0 ? arc2.endAngle : thetaT2;
            if (pickPt2) {
              const thetaPick2 = normalizeAngle(Math.atan2(pickPt2.y - C2.y, pickPt2.x - C2.x));
              if (!isAngleOnArc(thetaPick2, remStart2, remEnd2, arc2.clockwise)) {
                penalty += 1e6;
              }
            } else {
              const prefIdx2 = Math.hypot(P2s.x - T1.x, P2s.y - T1.y) < Math.hypot(P2e.x - T1.x, P2e.y - T1.y) ? 0 : 1;
              if (idx2 !== prefIdx2) penalty += 500;
            }

            const refPt1 = pickPt1 || (idx1 === 0 ? P1s : P1e);
            const refPt2 = pickPt2 || (idx2 === 0 ? P2s : P2e);
            const distRef = Math.hypot(T1.x - refPt1.x, T1.y - refPt1.y) + Math.hypot(T2.x - refPt2.x, T2.y - refPt2.y);

            candidates.push({
              C,
              T1,
              T2,
              thetaT1,
              thetaT2,
              arc1PtIdx: idx1,
              arc2PtIdx: idx2,
              cost: penalty + distRef,
            });
          }
        }
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.cost - b.cost);
  const best = candidates[0];
  if (best.cost >= 1e8) return null;

  const theta1 = normalizeAngle(Math.atan2(best.T1.y - best.C.y, best.T1.x - best.C.x));
  const theta2 = normalizeAngle(Math.atan2(best.T2.y - best.C.y, best.T2.x - best.C.x));

  const sweepCCW = normalizeAngle(theta2 - theta1);
  const sweepCW = normalizeAngle(theta1 - theta2);

  const clockwise = sweepCCW > sweepCW;
  const startAngle = theta1;
  const endAngle = theta2;

  const arcId = 'arc-' + Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
  const arc: ArcEntity = {
    id: arcId,
    layerId: arc1.layerId || 'layer-0',
    visible: arc1.visible !== undefined ? arc1.visible : true,
    locked: arc1.locked !== undefined ? arc1.locked : false,
    color: arc1.color,
    lineWidth: arc1.lineWidth,
    isConstruction: arc1.isConstruction,
    type: 'arc',
    center: best.C,
    radius,
    startAngle,
    endAngle,
    clockwise,
  };

  const trimmedArc1: ArcEntity = {
    ...arc1,
    startAngle: best.arc1PtIdx === 0 ? normalizeAngle(best.thetaT1) : arc1.startAngle,
    endAngle: best.arc1PtIdx === 0 ? arc1.endAngle : normalizeAngle(best.thetaT1),
  };

  const trimmedArc2: ArcEntity = {
    ...arc2,
    startAngle: best.arc2PtIdx === 0 ? normalizeAngle(best.thetaT2) : arc2.startAngle,
    endAngle: best.arc2PtIdx === 0 ? arc2.endAngle : normalizeAngle(best.thetaT2),
  };

  const uuid = () => Math.random().toString(36).substring(2, 11);

  const coincident1: Constraint = {
    id: `c-coincident-${arc1.id}-${arcId}-${uuid()}`,
    type: 'coincident',
    entityIds: [arc1.id, arcId],
    pointIndices: [best.arc1PtIdx === 0 ? 1 : 2, 1], // T1 為 arc 的 startPoint (index 1)
  };

  const coincident2: Constraint = {
    id: `c-coincident-${arc2.id}-${arcId}-${uuid()}`,
    type: 'coincident',
    entityIds: [arc2.id, arcId],
    pointIndices: [best.arc2PtIdx === 0 ? 1 : 2, 2], // T2 為 arc 的 endPoint (index 2)
  };

  const tangent1: Constraint = {
    id: `c-tangent-${arc1.id}-${arcId}-${uuid()}`,
    type: 'tangent',
    entityIds: [arc1.id, arcId],
  };

  const tangent2: Constraint = {
    id: `c-tangent-${arc2.id}-${arcId}-${uuid()}`,
    type: 'tangent',
    entityIds: [arc2.id, arcId],
  };

  return {
    arc,
    trimmedEntity1: trimmedArc1,
    trimmedEntity2: trimmedArc2,
    generatedConstraints: [
      coincident1,
      coincident2,
      tangent1,
      tangent2,
    ],
  };
}
