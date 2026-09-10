import { LineEntity, ArcEntity, Point2D, Constraint } from '../../types/cad';

export interface FilletResult {
  arc: ArcEntity;
  trimmedLine1: LineEntity;
  trimmedLine2: LineEntity;
  generatedConstraints: Constraint[];
}

/**
 * 實作純函式：計算兩直線交點，依指定半徑計算切點位置，修剪兩線端點並插入相切過渡圓弧，
 * 並自動產生相應的幾何約束（重合 coincident, 相切 tangent, 距離/半徑 distance）。
 *
 * @param line1 第一條線段
 * @param line2 第二條線段
 * @param radius 圓角半徑
 */
export function createFilletArc(
  line1: LineEntity,
  line2: LineEntity,
  radius: number = 10
): FilletResult | null {
  const p1 = line1.start;
  const p2 = line1.end;
  const p3 = line2.start;
  const p4 = line2.end;

  const vx1 = p2.x - p1.x;
  const vy1 = p2.y - p1.y;
  const vx2 = p4.x - p3.x;
  const vy2 = p4.y - p3.y;

  // 計算兩無限長直線的交點
  // Line 1: P(t) = p1 + t * v1
  // Line 2: Q(u) = p3 + u * v2
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

  // 尋找兩線段中，最接近交點 I 的端點 (near point)
  const distA1 = Math.hypot(p1.x - I.x, p1.y - I.y);
  const distB1 = Math.hypot(p2.x - I.x, p2.y - I.y);
  const p1_near = distA1 < distB1 ? p1 : p2;
  const p1_far = distA1 < distB1 ? p2 : p1;

  const distA2 = Math.hypot(p3.x - I.x, p3.y - I.y);
  const distB2 = Math.hypot(p4.x - I.x, p4.y - I.y);
  const p2_near = distA2 < distB2 ? p3 : p4;
  const p2_far = distA2 < distB2 ? p4 : p3;

  // 計算自 I 往遠端 (far point) 的方向向量
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

  // 計算兩方向向量夾角 alpha
  const cosAlpha = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
  const alpha = Math.acos(cosAlpha);

  // 若夾角接近 0 或 PI，視為平行或共線，無法圓角
  if (alpha < 1e-4 || alpha > Math.PI - 1e-4) {
    return null;
  }

  // 交點 I 到切點 (Tangent Points) 的距離
  const d_tangent = radius / Math.tan(alpha / 2);

  // 檢查半徑是否過大，導致切點超出了線段長度
  if (d_tangent >= distFar1 || d_tangent >= distFar2) {
    return null;
  }

  // 計算切點 T1 與 T2
  const T1: Point2D = {
    x: I.x + d_tangent * u1.x,
    y: I.y + d_tangent * u1.y,
  };

  const T2: Point2D = {
    x: I.x + d_tangent * u2.x,
    y: I.y + d_tangent * u2.y,
  };

  // 利用角平分線方向計算圓弧中心
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

  // 計算圓心到兩切點的極角
  const theta1 = Math.atan2(T1.y - center.y, T1.x - center.x);
  const theta2 = Math.atan2(T2.y - center.y, T2.x - center.x);

  const normalizeAngle = (angle: number): number => {
    let res = angle % (2 * Math.PI);
    if (res < 0) res += 2 * Math.PI;
    return res;
  };

  const a1 = normalizeAngle(theta1);
  const a2 = normalizeAngle(theta2);

  const d1 = normalizeAngle(a2 - a1);
  const d2 = normalizeAngle(a1 - a2);

  // 選擇角度差小於 PI (180 度) 的短圓弧路徑，對應切點過渡
  let startAngle = 0;
  let endAngle = 0;
  let arcPtIdxForT1 = 0;
  let arcPtIdxForT2 = 1;

  if (d1 < d2) {
    startAngle = a1;
    endAngle = a2;
    arcPtIdxForT1 = 0; // T1 位於圓弧起點 (startAngle)
    arcPtIdxForT2 = 1; // T2 位於圓弧終點 (endAngle)
  } else {
    startAngle = a2;
    endAngle = a1;
    arcPtIdxForT1 = 1; // T1 位於圓弧終點 (endAngle)
    arcPtIdxForT2 = 0; // T2 位於圓弧起點 (startAngle)
  }

  // 建立圓弧圖元 (ArcEntity)
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

  // 進行修剪：把最接近交點 I 的那端端點，替換成圓弧切點
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

  // 判斷線段端點替換對應的 pointIndex (0 代表 start, 1 代表 end)
  const line1PtIdx = distA1 < distB1 ? 0 : 1;
  const line2PtIdx = distA2 < distB2 ? 0 : 1;

  // 輔助產生唯一隨機 ID 的閉包
  const uuid = () => Math.random().toString(36).substring(2, 11);

  // 建立 5 個幾何約束
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
    trimmedLine1,
    trimmedLine2,
    generatedConstraints: [
      coincident1,
      coincident2,
      tangent1,
      tangent2,
      distanceRadius,
    ],
  };
}

