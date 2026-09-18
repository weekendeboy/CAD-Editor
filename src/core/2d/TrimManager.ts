import { Point2D, CADEntity2D, LineEntity, ArcEntity, CircleEntity } from '../../types/cad';
import { findAllIntersections, isAngleOnArc, normalizeAngle } from './IntersectionEngine';
import { getArcSweepAngle } from './GeometryMath';

export interface TrimResult {
  toRemoveIds: string[];
  toAddEntities: CADEntity2D[];
}

export interface TrimSubsegments {
  subsegmentToRemove: CADEntity2D;
  remainingSubsegments: CADEntity2D[];
}

/**
 * 核心演算法：根據點擊座標 clickPoint 與所有實體的相交情形，
 * 將 target 分割為多個子區間，辨識出包含點擊點的子區間作為待刪除段，並重構其餘子區間。
 */
export function findTrimSubsegments(
  target: CADEntity2D,
  clickPoint: Point2D,
  allEntities: CADEntity2D[]
): TrimSubsegments | null {
  if (!target || (target.type !== 'line' && target.type !== 'arc' && target.type !== 'circle')) {
    return null;
  }

  // 1. 找出 target 與其他圖元的所有有效交點
  const otherEntities = allEntities.filter((e) => e.id !== target.id);
  if (otherEntities.length === 0) {
    return null;
  }

  const intersections = findAllIntersections(target, otherEntities);
  if (intersections.length === 0) {
    return null;
  }

  // 2. 根據圖元幾何類型進行分段與點擊測試
  if (target.type === 'line') {
    return trimLine(target, clickPoint, intersections);
  } else if (target.type === 'circle') {
    return trimCircle(target, clickPoint, intersections);
  } else if (target.type === 'arc') {
    return trimArc(target, clickPoint, intersections);
  }

  return null;
}

/**
 * 線段修剪演算
 */
function trimLine(
  target: LineEntity,
  clickPoint: Point2D,
  intersections: { point: Point2D }[]
): TrimSubsegments | null {
  const p0 = target.start;
  const p1 = target.end;
  const vx = p1.x - p0.x;
  const vy = p1.y - p0.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-10) return null;

  // A. 計算交點於線段上的投影參數 t
  const rawT: number[] = [];
  for (const item of intersections) {
    const pt = item.point;
    const t = ((pt.x - p0.x) * vx + (pt.y - p0.y) * vy) / lenSq;
    // 排除線段端點 (t ≈ 0 或 t ≈ 1)
    if (t > 1e-4 && t < 1 - 1e-4) {
      rawT.push(t);
    }
  }

  // 去除重複 t 參數
  const deduplicatedT: number[] = [];
  for (const t of rawT) {
    if (!deduplicatedT.some((existing) => Math.abs(existing - t) < 1e-4)) {
      deduplicatedT.push(t);
    }
  }
  deduplicatedT.sort((a, b) => a - b);

  if (deduplicatedT.length === 0) {
    return null;
  }

  // B. 加入起終點 0 與 1，構成區間 [cuts[i], cuts[i+1]]
  const cuts = [0, ...deduplicatedT, 1];
  const numSubsegments = cuts.length - 1;

  // C. 將使用者 clickPoint 投影至線段上取得 tClick
  const rawTClick = ((clickPoint.x - p0.x) * vx + (clickPoint.y - p0.y) * vy) / lenSq;
  const tClick = Math.max(0, Math.min(1, rawTClick));

  // D. 尋找包含 tClick 的子線段區間
  let removeIdx = -1;
  let minMidDist = Infinity;

  for (let i = 0; i < numSubsegments; i++) {
    const tStart = cuts[i];
    const tEnd = cuts[i + 1];
    if (tEnd - tStart < 1e-5) continue;

    if (tClick >= tStart - 1e-5 && tClick <= tEnd + 1e-5) {
      const mid = (tStart + tEnd) / 2;
      const dist = Math.abs(tClick - mid);
      if (dist < minMidDist) {
        minMidDist = dist;
        removeIdx = i;
      }
    }
  }

  // 備用：若不在區間內（浮點公差），以距離子線段最短者判定
  if (removeIdx === -1) {
    let minDist = Infinity;
    for (let i = 0; i < numSubsegments; i++) {
      const tStart = cuts[i];
      const tEnd = cuts[i + 1];
      const pS: Point2D = { x: p0.x + tStart * vx, y: p0.y + tStart * vy };
      const pE: Point2D = { x: p0.x + tEnd * vx, y: p0.y + tEnd * vy };
      const dist = getDistanceToLineSegment(clickPoint, pS, pE);
      if (dist < minDist) {
        minDist = dist;
        removeIdx = i;
      }
    }
  }

  if (removeIdx === -1) return null;

  // E. 建構被刪除段與保留段
  const remStartT = cuts[removeIdx];
  const remEndT = cuts[removeIdx + 1];
  const subsegmentToRemove: LineEntity = {
    ...target,
    id: `trim-preview-${target.id}`,
    type: 'line',
    start: { x: p0.x + remStartT * vx, y: p0.y + remStartT * vy },
    end: { x: p0.x + remEndT * vx, y: p0.y + remEndT * vy },
  };

  const remainingSubsegments: CADEntity2D[] = [];
  for (let i = 0; i < numSubsegments; i++) {
    if (i === removeIdx) continue;
    const tStart = cuts[i];
    const tEnd = cuts[i + 1];
    if (tEnd - tStart < 1e-4) continue;

    remainingSubsegments.push({
      id: crypto.randomUUID(),
      layerId: target.layerId,
      visible: target.visible,
      locked: target.locked,
      color: target.color,
      lineWidth: target.lineWidth,
      isConstruction: target.isConstruction,
      type: 'line',
      start: { x: p0.x + tStart * vx, y: p0.y + tStart * vy },
      end: { x: p0.x + tEnd * vx, y: p0.y + tEnd * vy },
    } as LineEntity);
  }

  return { subsegmentToRemove, remainingSubsegments };
}

/**
 * 完整圓修剪演算
 * 封閉圓至少需要 2 個交點才能進行修剪；修剪後將被點擊的圓弧區段移除，其餘區段轉為 ArcEntity。
 */
function trimCircle(
  target: CircleEntity,
  clickPoint: Point2D,
  intersections: { point: Point2D }[]
): TrimSubsegments | null {
  const center = target.center;
  const radius = target.radius;
  if (radius < 1e-5) return null;

  // A. 計算交點在圓上的極角 theta ∈ [0, 2π)
  const rawAngles: number[] = [];
  for (const item of intersections) {
    const pt = item.point;
    const theta = normalizeAngle(Math.atan2(pt.y - center.y, pt.x - center.x));
    rawAngles.push(theta);
  }

  // 角度去重（圓周循環公差）
  const deduplicatedAngles: number[] = [];
  for (const ang of rawAngles) {
    let isDuplicate = false;
    for (const existing of deduplicatedAngles) {
      let diff = Math.abs(ang - existing);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < 1e-4) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      deduplicatedAngles.push(ang);
    }
  }

  // 特例：若交點小於 2 個，無法剪開封閉圓周
  if (deduplicatedAngles.length < 2) {
    return null;
  }

  // 排序角度
  deduplicatedAngles.sort((a, b) => a - b);
  const n = deduplicatedAngles.length;

  // B. 計算 clickPoint 在圓上的極角
  const thetaClick = normalizeAngle(Math.atan2(clickPoint.y - center.y, clickPoint.x - center.x));

  // C. 判定 clickPoint 落在第幾個圓弧區間 [deduplicatedAngles[i], deduplicatedAngles[(i+1)%n]]
  let removeIdx = -1;
  let minMidDist = Infinity;

  for (let i = 0; i < n; i++) {
    const startA = deduplicatedAngles[i];
    const endA = deduplicatedAngles[(i + 1) % n];
    const sweep = normalizeAngle(endA - startA);
    if (sweep < 1e-4) continue;

    const clickOffset = normalizeAngle(thetaClick - startA);
    if (clickOffset >= -1e-5 && clickOffset <= sweep + 1e-5) {
      const midSweep = sweep / 2;
      const dist = Math.abs(clickOffset - midSweep);
      if (dist < minMidDist) {
        minMidDist = dist;
        removeIdx = i;
      }
    }
  }

  // 備用：距離圓弧區段中點最近者
  if (removeIdx === -1) {
    let minDist = Infinity;
    for (let i = 0; i < n; i++) {
      const startA = deduplicatedAngles[i];
      const endA = deduplicatedAngles[(i + 1) % n];
      const sweep = normalizeAngle(endA - startA);
      const midA = normalizeAngle(startA + sweep / 2);
      let diff = Math.abs(thetaClick - midA);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < minDist) {
        minDist = diff;
        removeIdx = i;
      }
    }
  }

  if (removeIdx === -1) return null;

  // D. 建構待刪除段與保留段
  const remStartA = deduplicatedAngles[removeIdx];
  const remEndA = deduplicatedAngles[(removeIdx + 1) % n];
  const subsegmentToRemove: ArcEntity = {
    id: `trim-preview-${target.id}`,
    layerId: target.layerId,
    visible: target.visible,
    locked: target.locked,
    color: target.color,
    lineWidth: target.lineWidth,
    isConstruction: target.isConstruction,
    type: 'arc',
    center: { ...target.center },
    radius: target.radius,
    startAngle: remStartA,
    endAngle: remEndA,
    clockwise: false,
  };

  const remainingSubsegments: CADEntity2D[] = [];
  for (let i = 0; i < n; i++) {
    if (i === removeIdx) continue;
    const startA = deduplicatedAngles[i];
    const endA = deduplicatedAngles[(i + 1) % n];
    const sweep = normalizeAngle(endA - startA);
    if (sweep < 1e-4) continue;

    remainingSubsegments.push({
      id: crypto.randomUUID(),
      layerId: target.layerId,
      visible: target.visible,
      locked: target.locked,
      color: target.color,
      lineWidth: target.lineWidth,
      isConstruction: target.isConstruction,
      type: 'arc',
      center: { ...target.center },
      radius: target.radius,
      startAngle: startA,
      endAngle: endA,
      clockwise: false,
    } as ArcEntity);
  }

  return { subsegmentToRemove, remainingSubsegments };
}

/**
 * 圓弧修剪演算
 * 支援順時針 (clockwise=true) 與逆時針 (clockwise=false) 圓弧。
 */
function trimArc(
  target: ArcEntity,
  clickPoint: Point2D,
  intersections: { point: Point2D }[]
): TrimSubsegments | null {
  const center = target.center;
  const radius = target.radius;
  const isCW = Boolean(target.clockwise);
  const startAngle = target.startAngle;
  const endAngle = target.endAngle;
  const totalSweep = getArcSweepAngle(startAngle, endAngle, isCW);

  if (totalSweep < 1e-4 || radius < 1e-5) return null;

  // A. 計算交點相對於 startAngle 的掃掠角差
  const rawSweeps: number[] = [];
  for (const item of intersections) {
    const pt = item.point;
    const theta = normalizeAngle(Math.atan2(pt.y - center.y, pt.x - center.x));
    const s = isCW ? normalizeAngle(startAngle - theta) : normalizeAngle(theta - startAngle);
    // 嚴格落在圓弧內部 (排除兩端點)
    if (s > 1e-4 && s < totalSweep - 1e-4) {
      rawSweeps.push(s);
    }
  }

  // 去重
  const deduplicatedSweeps: number[] = [];
  for (const s of rawSweeps) {
    if (!deduplicatedSweeps.some((existing) => Math.abs(existing - s) < 1e-4)) {
      deduplicatedSweeps.push(s);
    }
  }
  deduplicatedSweeps.sort((a, b) => a - b);

  if (deduplicatedSweeps.length === 0) {
    return null;
  }

  // B. 加入 0 與 totalSweep，構成掃掠區間
  const cuts = [0, ...deduplicatedSweeps, totalSweep];
  const numSubsegments = cuts.length - 1;

  // C. 計算 clickPoint 在弧上的掃掠參數 sClick
  const thetaClick = normalizeAngle(Math.atan2(clickPoint.y - center.y, clickPoint.x - center.x));
  const rawSClick = isCW ? normalizeAngle(startAngle - thetaClick) : normalizeAngle(thetaClick - startAngle);
  const sClick = Math.max(0, Math.min(totalSweep, rawSClick));

  // D. 判定包含 sClick 的子圓弧區間
  let removeIdx = -1;
  let minMidDist = Infinity;

  for (let i = 0; i < numSubsegments; i++) {
    const sStart = cuts[i];
    const sEnd = cuts[i + 1];
    if (sEnd - sStart < 1e-4) continue;

    if (sClick >= sStart - 1e-5 && sClick <= sEnd + 1e-5) {
      const mid = (sStart + sEnd) / 2;
      const dist = Math.abs(sClick - mid);
      if (dist < minMidDist) {
        minMidDist = dist;
        removeIdx = i;
      }
    }
  }

  // 備用：尋找中點最接近者
  if (removeIdx === -1) {
    let minDist = Infinity;
    for (let i = 0; i < numSubsegments; i++) {
      const mid = (cuts[i] + cuts[i + 1]) / 2;
      const dist = Math.abs(sClick - mid);
      if (dist < minDist) {
        minDist = dist;
        removeIdx = i;
      }
    }
  }

  if (removeIdx === -1) return null;

  // E. 建構待刪除段與保留段，保持原始 clockwise 屬性
  const remSStart = cuts[removeIdx];
  const remSEnd = cuts[removeIdx + 1];
  const subRemStartAngle = normalizeAngle(isCW ? startAngle - remSStart : startAngle + remSStart);
  const subRemEndAngle = normalizeAngle(isCW ? startAngle - remSEnd : startAngle + remSEnd);

  const subsegmentToRemove: ArcEntity = {
    id: `trim-preview-${target.id}`,
    layerId: target.layerId,
    visible: target.visible,
    locked: target.locked,
    color: target.color,
    lineWidth: target.lineWidth,
    isConstruction: target.isConstruction,
    type: 'arc',
    center: { ...target.center },
    radius: target.radius,
    startAngle: subRemStartAngle,
    endAngle: subRemEndAngle,
    clockwise: isCW,
  };

  const remainingSubsegments: CADEntity2D[] = [];
  for (let i = 0; i < numSubsegments; i++) {
    if (i === removeIdx) continue;
    const sStart = cuts[i];
    const sEnd = cuts[i + 1];
    if (sEnd - sStart < 1e-4) continue;

    const subStartAngle = normalizeAngle(isCW ? startAngle - sStart : startAngle + sStart);
    const subEndAngle = normalizeAngle(isCW ? startAngle - sEnd : startAngle + sEnd);

    remainingSubsegments.push({
      id: crypto.randomUUID(),
      layerId: target.layerId,
      visible: target.visible,
      locked: target.locked,
      color: target.color,
      lineWidth: target.lineWidth,
      isConstruction: target.isConstruction,
      type: 'arc',
      center: { ...target.center },
      radius: target.radius,
      startAngle: subStartAngle,
      endAngle: subEndAngle,
      clockwise: isCW,
    } as ArcEntity);
  }

  return { subsegmentToRemove, remainingSubsegments };
}

/**
 * 執行修剪：返回欲刪除的實體 ID 列表以及需加入的新子實體列表
 */
export function executeTrim(
  targetEntityId: string,
  clickPoint: Point2D,
  allEntities: CADEntity2D[]
): TrimResult | null {
  const target = allEntities.find((e) => e.id === targetEntityId);
  if (!target) return null;

  const result = findTrimSubsegments(target, clickPoint, allEntities);
  if (!result) return null;

  return {
    toRemoveIds: [target.id],
    toAddEntities: result.remainingSubsegments,
  };
}

/**
 * 取得 Trim 游標懸停預覽的虛擬 Entity (紅色虛線呈現即將被裁減的 Sub-segment)
 */
export function getTrimPreviewSegment(
  target: CADEntity2D,
  clickPoint: Point2D,
  allEntities: CADEntity2D[]
): CADEntity2D | null {
  const result = findTrimSubsegments(target, clickPoint, allEntities);
  return result ? result.subsegmentToRemove : null;
}

/**
 * 草圖應用 Trim 變更的便利函式
 */
export function applyTrimToSketch(
  sketch: { entities: CADEntity2D[] },
  targetEntityId: string,
  clickPoint: Point2D
): TrimResult | null {
  return executeTrim(targetEntityId, clickPoint, sketch.entities);
}

/**
 * 計算點到線段的最近距離 (工具函式)
 */
export function getDistanceToLineSegment(p: Point2D, sStart: Point2D, sEnd: Point2D): number {
  const vx = sEnd.x - sStart.x;
  const vy = sEnd.y - sStart.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-10) {
    return Math.hypot(p.x - sStart.x, p.y - sStart.y);
  }
  const dx = p.x - sStart.x;
  const dy = p.y - sStart.y;
  const t = Math.max(0, Math.min(1, (dx * vx + dy * vy) / lenSq));
  const projX = sStart.x + t * vx;
  const projY = sStart.y + t * vy;
  return Math.hypot(p.x - projX, p.y - projY);
}

/**
 * 計算點到圓弧的最近距離 (工具函式)
 */
export function getDistanceToArcSegment(
  p: Point2D,
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number,
  clockwise?: boolean
): number {
  const thetaP = Math.atan2(p.y - center.y, p.x - center.x);
  if (isAngleOnArc(thetaP, startAngle, endAngle, clockwise)) {
    const distToCenter = Math.hypot(p.x - center.x, p.y - center.y);
    return Math.abs(distToCenter - radius);
  } else {
    const pStart = {
      x: center.x + radius * Math.cos(startAngle),
      y: center.y + radius * Math.sin(startAngle),
    };
    const pEnd = {
      x: center.x + radius * Math.cos(endAngle),
      y: center.y + radius * Math.sin(endAngle),
    };
    const dStart = Math.hypot(p.x - pStart.x, p.y - pStart.y);
    const dEnd = Math.hypot(p.x - pEnd.x, p.y - pEnd.y);
    return Math.min(dStart, dEnd);
  }
}
