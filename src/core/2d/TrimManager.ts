import { Point2D, CADEntity2D, LineEntity, ArcEntity, CircleEntity } from '../../types/cad';
import { findAllIntersections, isAngleOnArc, normalizeAngle } from './IntersectionEngine';

/**
 * 實作修剪演算法：
 * 找到點擊最近的子圖元並剔除，其餘子圖元轉成全新圖元並保留。
 *
 * @param targetEntityId 被修剪的目標圖元 ID
 * @param clickPoint 點擊的位置，用以判斷要剔除哪一段子圖元
 * @param allEntities 畫布中所有的圖元
 */
export function executeTrim(
  targetEntityId: string,
  clickPoint: Point2D,
  allEntities: CADEntity2D[]
): { toRemoveIds: string[]; toAddEntities: CADEntity2D[] } | null {
  // 從 allEntities 找到目標圖元 target。若不存在或非 line/arc/circle 則回傳 null。
  const target = allEntities.find((e) => e.id === targetEntityId);
  if (!target || (target.type !== 'line' && target.type !== 'arc' && target.type !== 'circle')) {
    return null;
  }

  // 呼叫 findAllIntersections(allEntities) 取得所有交點
  const allIntersections = findAllIntersections(allEntities);

  // 過濾出涉及 targetEntityId 的交點列表與參數
  const params: number[] = [];
  for (const res of allIntersections) {
    if (res.entityAId === targetEntityId) {
      params.push(res.paramA);
    } else if (res.entityBId === targetEntityId) {
      params.push(res.paramB);
    }
  }

  // 若該圖元無任何交點，回傳 null（無法修剪）。
  if (params.length === 0) {
    return null;
  }

  // 二維/角度去重輔助函式，避免精度誤差產生重複參數
  const deduplicate = (arr: number[], tolerance: number = 1e-5): number[] => {
    const res: number[] = [];
    for (const val of arr) {
      if (!res.some((existing) => Math.abs(existing - val) < tolerance)) {
        res.push(val);
      }
    }
    return res;
  };

  const toAddEntities: CADEntity2D[] = [];

  if (target.type === 'line') {
    // 將交點依在線段上的投影參數 t（0 到 1 之間）由小到大排序，加入起點 (t=0) 與終點 (t=1)。
    const tValues = deduplicate([...params, 0, 1].map((t) => Math.max(0, Math.min(1, t))));
    tValues.sort((a, b) => a - b);

    // 相鄰兩參數切分為多個子線段區間 [t_i, t_{i+1}]
    const subsegments: { start: Point2D; end: Point2D; dist: number }[] = [];
    for (let i = 0; i < tValues.length - 1; i++) {
      const tStart = tValues[i];
      const tEnd = tValues[i + 1];
      if (tEnd - tStart < 1e-5) {
        continue;
      }

      const pStart = {
        x: target.start.x + tStart * (target.end.x - target.start.x),
        y: target.start.y + tStart * (target.end.y - target.start.y),
      };
      const pEnd = {
        x: target.start.x + tEnd * (target.end.x - target.start.x),
        y: target.start.y + tEnd * (target.end.y - target.start.y),
      };

      // 計算與 clickPoint 的距離
      const dist = getDistanceToLineSegment(clickPoint, pStart, pEnd);
      subsegments.push({ start: pStart, end: pEnd, dist });
    }

    if (subsegments.length === 0) {
      return null;
    }

    // 計算 clickPoint 距離哪一個子線段最近，將該區間剔除
    let minIdx = 0;
    let minDist = subsegments[0].dist;
    for (let i = 1; i < subsegments.length; i++) {
      if (subsegments[i].dist < minDist) {
        minDist = subsegments[i].dist;
        minIdx = i;
      }
    }

    // 其餘子區間轉換為全新的 LineEntity
    for (let i = 0; i < subsegments.length; i++) {
      if (i === minIdx) {
        continue;
      }
      const sub = subsegments[i];
      toAddEntities.push({
        id: crypto.randomUUID(),
        layerId: target.layerId,
        visible: target.visible,
        locked: target.locked,
        color: target.color,
        lineWidth: target.lineWidth,
        isConstruction: target.isConstruction,
        type: 'line',
        start: sub.start,
        end: sub.end,
      } as LineEntity);
    }
  } else if (target.type === 'arc') {
    // 取得該圓弧上的所有有效交點。
    const startAngle = target.startAngle;
    const endAngle = target.endAngle;
    const totalSweep = normalizeAngle(endAngle - startAngle);

    // 將各交點的角度相對於 startAngle 轉換為逆時針掃掠角差：
    // deltaTheta_i = (theta_i - startAngle) mod 2pi
    const relativeSweeps: number[] = [];
    for (const p of params) {
      const sweep = normalizeAngle(p - startAngle);
      // 容差範圍內才納入
      if (sweep <= totalSweep + 1e-5) {
        relativeSweeps.push(Math.min(totalSweep, Math.max(0, sweep)));
      }
    }

    // 將這些交點依 deltaTheta_i 由小到大排序，形成子圓弧區間序列
    const sValues = deduplicate([...relativeSweeps, 0, totalSweep]);
    sValues.sort((a, b) => a - b);

    // 切分成多段子圓弧
    const subarcs: { startAngle: number; endAngle: number; dist: number }[] = [];
    for (let i = 0; i < sValues.length - 1; i++) {
      const sStart = sValues[i];
      const sEnd = sValues[i + 1];
      if (sEnd - sStart < 1e-5) {
        continue;
      }

      const subStartAngle = normalizeAngle(startAngle + sStart);
      const subEndAngle = normalizeAngle(startAngle + sEnd);

      // 計算子圓弧弧上中點（Midpoint on Arc）
      const subSweep = normalizeAngle(subEndAngle - subStartAngle);
      const midAngle = normalizeAngle(subStartAngle + subSweep / 2);
      const midPoint = {
        x: target.center.x + target.radius * Math.cos(midAngle),
        y: target.center.y + target.radius * Math.sin(midAngle),
      };

      // 計算該中點與 clickPoint 的空間距離
      const dist = Math.hypot(clickPoint.x - midPoint.x, clickPoint.y - midPoint.y);

      subarcs.push({ startAngle: subStartAngle, endAngle: subEndAngle, dist });
    }

    if (subarcs.length === 0) {
      return null;
    }

    // 找出距離 clickPoint 最近的子圓弧將其剔除
    let minIdx = 0;
    let minDist = subarcs[0].dist;
    for (let i = 1; i < subarcs.length; i++) {
      if (subarcs[i].dist < minDist) {
        minDist = subarcs[i].dist;
        minIdx = i;
      }
    }

    // 其餘子區段保留為全新的 ArcEntity（維持相同的 center, radius 與 layerId）
    for (let i = 0; i < subarcs.length; i++) {
      if (i === minIdx) {
        continue;
      }
      const sub = subarcs[i];
      toAddEntities.push({
        id: crypto.randomUUID(),
        layerId: target.layerId,
        visible: target.visible,
        locked: target.locked,
        color: target.color,
        lineWidth: target.lineWidth,
        isConstruction: target.isConstruction,
        type: 'arc',
        center: target.center,
        radius: target.radius,
        startAngle: sub.startAngle,
        endAngle: sub.endAngle,
      } as ArcEntity);
    }
  } else if (target.type === 'circle') {
    // 1. 找出所有與此圓相交的有效交點（割線會有 2 個交點）。
    const sortedAngles = deduplicate(params);
    sortedAngles.sort((a, b) => a - b);

    // 2. 若交點數量 < 2：回傳 null
    if (sortedAngles.length < 2) {
      return null;
    }

    // 計算各交點相對於圓心的極角 theta_i，正規化至 [0, 2pi) 並遞增排序：theta_0, theta_1
    const theta0 = sortedAngles[0];
    const theta1 = sortedAngles[1];

    // 3. 將圓周劃分為兩個圓弧候選區間：
    // - 區間 A: startAngle = theta0, endAngle = theta1
    // - 區間 B: startAngle = theta1, endAngle = theta0（跨過 0 度邊界）

    // 計算區間 A 的中點
    let diffA = theta1 - theta0;
    while (diffA < 0) diffA += 2 * Math.PI;
    const midA = normalizeAngle(theta0 + diffA / 2);
    const midPointA = {
      x: target.center.x + target.radius * Math.cos(midA),
      y: target.center.y + target.radius * Math.sin(midA),
    };
    const distA = Math.hypot(clickPoint.x - midPointA.x, clickPoint.y - midPointA.y);

    // 計算區間 B 的中點
    let diffB = (theta0 + 2 * Math.PI) - theta1;
    while (diffB < 0) diffB += 2 * Math.PI;
    const midB = normalizeAngle(theta1 + diffB / 2);
    const midPointB = {
      x: target.center.x + target.radius * Math.cos(midB),
      y: target.center.y + target.radius * Math.sin(midB),
    };
    const distB = Math.hypot(clickPoint.x - midPointB.x, clickPoint.y - midPointB.y);

    // 4. 計算 clickPoint 落在區間 A 還是區間 B，剔除被點擊的那一段圓弧。
    // 保留另一段圓弧，並建立為全新的 ArcEntity
    let remainingArc: ArcEntity;
    if (distA < distB) {
      // 點擊落在區間 A，保留區間 B
      remainingArc = {
        id: crypto.randomUUID(),
        layerId: target.layerId,
        visible: target.visible,
        locked: target.locked,
        color: target.color,
        lineWidth: target.lineWidth,
        isConstruction: target.isConstruction,
        type: 'arc',
        center: target.center,
        radius: target.radius,
        startAngle: theta1,
        endAngle: theta0,
      };
    } else {
      // 點擊落在區間 B，保留區間 A
      remainingArc = {
        id: crypto.randomUUID(),
        layerId: target.layerId,
        visible: target.visible,
        locked: target.locked,
        color: target.color,
        lineWidth: target.lineWidth,
        isConstruction: target.isConstruction,
        type: 'arc',
        center: target.center,
        radius: target.radius,
        startAngle: theta0,
        endAngle: theta1,
      };
    }

    return {
      toRemoveIds: [targetEntityId],
      toAddEntities: [remainingArc],
    };
  }

  // 回傳 toRemoveIds（包含被修剪的原圓弧 ID）與 toAddEntities
  return {
    toRemoveIds: [targetEntityId],
    toAddEntities,
  };
}

/**
 * 計算點到線段的最近距離
 */
function getDistanceToLineSegment(p: Point2D, sStart: Point2D, sEnd: Point2D): number {
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
 * 計算點到圓弧的最近距離
 */
function getDistanceToArcSegment(
  p: Point2D,
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number
): number {
  const thetaP = Math.atan2(p.y - center.y, p.x - center.x);
  if (isAngleOnArc(thetaP, startAngle, endAngle)) {
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
