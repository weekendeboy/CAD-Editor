import { Point2D, LineEntity, ArcEntity, CircleEntity, CADEntity2D, Constraint } from '../../types/cad';

export interface OffsetOptions {
  distance: number;       // 偏移距離（永遠大於 0）
  sidePoint: Point2D;     // 點擊側座標，用來決定法向的正負方向
}

export interface OffsetResult {
  entity: CADEntity2D;
  generatedConstraints: Constraint[];
}

export interface OffsetChainResult {
  entities: CADEntity2D[];
  generatedConstraints: Constraint[];
}

export interface ChainElement {
  entity: LineEntity | ArcEntity;
  isReversed: boolean; // 若為 true，代表在此路徑鏈中該圖元由終點走向起點
}

const uuid = () => Math.random().toString(36).substring(2, 11);

/**
 * 正規化角度至 [0, 2π) 區間。
 */
export function normalizeAngle(angle: number): number {
  let res = angle % (2 * Math.PI);
  if (res < 0) res += 2 * Math.PI;
  return res;
}

/**
 * 取得 Line 或 Arc 的起訖端點世界座標。
 * Line: start / end
 * Arc: startAngle 點 / endAngle 點
 */
export function getEntityEndpoints(entity: LineEntity | ArcEntity): { start: Point2D; end: Point2D } {
  if (entity.type === 'line') {
    return {
      start: { x: entity.start.x, y: entity.start.y },
      end: { x: entity.end.x, y: entity.end.y },
    };
  } else {
    const { center, radius, startAngle, endAngle } = entity;
    return {
      start: {
        x: center.x + radius * Math.cos(startAngle),
        y: center.y + radius * Math.sin(startAngle),
      },
      end: {
        x: center.x + radius * Math.cos(endAngle),
        y: center.y + radius * Math.sin(endAngle),
      },
    };
  }
}

/**
 * 取得 ChainElement 依其前進方向（考慮 isReversed）之起點世界座標。
 */
export function getDirectedStart(elem: ChainElement): Point2D {
  const pts = getEntityEndpoints(elem.entity);
  return elem.isReversed ? pts.end : pts.start;
}

/**
 * 取得 ChainElement 依其前進方向（考慮 isReversed）之終點世界座標。
 */
export function getDirectedEnd(elem: ChainElement): Point2D {
  const pts = getEntityEndpoints(elem.entity);
  return elem.isReversed ? pts.start : pts.end;
}

/**
 * 判斷兩個圖元端點是否相連（結合 coincident 約束或幾何座標相近性）。
 */
export function arePointsConnected(
  idA: string,
  ptIdxA: number,
  ptA: Point2D,
  idB: string,
  ptIdxB: number,
  ptB: Point2D,
  constraints: Constraint[] = [],
  tolerance: number = 1e-2
): boolean {
  for (const c of constraints) {
    if (c.type === 'coincident' && c.entityIds && c.entityIds.length >= 2) {
      const idxA = c.entityIds.indexOf(idA);
      const idxB = c.entityIds.indexOf(idB);
      if (idxA !== -1 && idxB !== -1) {
        if (c.pointIndices && c.pointIndices.length >= 2) {
          if (c.pointIndices[idxA] === ptIdxA && c.pointIndices[idxB] === ptIdxB) {
            return true;
          }
        } else {
          const dist = Math.hypot(ptA.x - ptB.x, ptA.y - ptB.y);
          if (dist <= tolerance * 2) {
            return true;
          }
        }
      }
    }
  }

  const dist = Math.hypot(ptA.x - ptB.x, ptA.y - ptB.y);
  return dist <= tolerance;
}

/**
 * 遍歷並提取與 targetEntity 連接的整串圖元鏈（Path Chain）。
 * 支援向前與向後搜尋，自動處理端點方向（isReversed），並判定是否為封閉路徑（isClosed）。
 */
export function findConnectedChain(
  targetEntity: CADEntity2D,
  allEntities: CADEntity2D[],
  constraints: Constraint[] = [],
  tolerance: number = 1e-2
): { chain: ChainElement[]; isClosed: boolean } {
  if (targetEntity.type !== 'line' && targetEntity.type !== 'arc') {
    return { chain: [], isClosed: false };
  }

  const candidateEntities = allEntities.filter(
    (e): e is LineEntity | ArcEntity =>
      (e.type === 'line' || e.type === 'arc') && e.visible !== false && !e.isConstruction
  );

  const chain: ChainElement[] = [{ entity: targetEntity, isReversed: false }];
  const visited = new Set<string>([targetEntity.id]);
  let isClosed = false;

  // 1. 向前搜尋（沿著當前鏈的末端延伸）
  while (true) {
    const lastElem = chain[chain.length - 1];
    const lastEnd = getDirectedEnd(lastElem);
    const lastPtIdx = lastElem.isReversed ? 0 : 1;

    // 檢查末端是否已回接至第一圖元的起點
    if (chain.length >= 2) {
      const firstElem = chain[0];
      const firstStart = getDirectedStart(firstElem);
      const firstPtIdx = firstElem.isReversed ? 1 : 0;
      if (
        arePointsConnected(
          lastElem.entity.id,
          lastPtIdx,
          lastEnd,
          firstElem.entity.id,
          firstPtIdx,
          firstStart,
          constraints,
          tolerance
        )
      ) {
        isClosed = true;
        break;
      }
    }

    let bestMatch: { entity: LineEntity | ArcEntity; isReversed: boolean; dist: number } | null = null;

    for (const cand of candidateEntities) {
      if (visited.has(cand.id)) continue;

      const candPts = getEntityEndpoints(cand);

      // 檢查候選圖元 start 是否連接
      if (
        arePointsConnected(
          lastElem.entity.id,
          lastPtIdx,
          lastEnd,
          cand.id,
          0,
          candPts.start,
          constraints,
          tolerance
        )
      ) {
        const d = Math.hypot(lastEnd.x - candPts.start.x, lastEnd.y - candPts.start.y);
        if (!bestMatch || d < bestMatch.dist) {
          bestMatch = { entity: cand, isReversed: false, dist: d };
        }
      }

      // 檢查候選圖元 end 是否連接
      if (
        arePointsConnected(
          lastElem.entity.id,
          lastPtIdx,
          lastEnd,
          cand.id,
          1,
          candPts.end,
          constraints,
          tolerance
        )
      ) {
        const d = Math.hypot(lastEnd.x - candPts.end.x, lastEnd.y - candPts.end.y);
        if (!bestMatch || d < bestMatch.dist) {
          bestMatch = { entity: cand, isReversed: true, dist: d };
        }
      }
    }

    if (bestMatch) {
      chain.push({ entity: bestMatch.entity, isReversed: bestMatch.isReversed });
      visited.add(bestMatch.entity.id);
    } else {
      break;
    }
  }

  // 2. 向後搜尋（沿著起點向前延伸，若尚未封閉）
  if (!isClosed) {
    while (true) {
      const firstElem = chain[0];
      const firstStart = getDirectedStart(firstElem);
      const firstPtIdx = firstElem.isReversed ? 1 : 0;

      let bestMatch: { entity: LineEntity | ArcEntity; isReversed: boolean; dist: number } | null = null;

      for (const cand of candidateEntities) {
        if (visited.has(cand.id)) continue;

        const candPts = getEntityEndpoints(cand);

        // 檢查候選圖元 end 是否與起點相接（候選為順向）
        if (
          arePointsConnected(
            firstElem.entity.id,
            firstPtIdx,
            firstStart,
            cand.id,
            1,
            candPts.end,
            constraints,
            tolerance
          )
        ) {
          const d = Math.hypot(firstStart.x - candPts.end.x, firstStart.y - candPts.end.y);
          if (!bestMatch || d < bestMatch.dist) {
            bestMatch = { entity: cand, isReversed: false, dist: d };
          }
        }

        // 檢查候選圖元 start 是否與起點相接（候選為反向）
        if (
          arePointsConnected(
            firstElem.entity.id,
            firstPtIdx,
            firstStart,
            cand.id,
            0,
            candPts.start,
            constraints,
            tolerance
          )
        ) {
          const d = Math.hypot(firstStart.x - candPts.start.x, firstStart.y - candPts.start.y);
          if (!bestMatch || d < bestMatch.dist) {
            bestMatch = { entity: cand, isReversed: true, dist: d };
          }
        }
      }

      if (bestMatch) {
        chain.unshift({ entity: bestMatch.entity, isReversed: bestMatch.isReversed });
        visited.add(bestMatch.entity.id);
      } else {
        break;
      }
    }

    // 搜尋完成後再次確認首尾是否閉合
    if (chain.length >= 2) {
      const firstElem = chain[0];
      const firstStart = getDirectedStart(firstElem);
      const firstPtIdx = firstElem.isReversed ? 1 : 0;
      const lastElem = chain[chain.length - 1];
      const lastEnd = getDirectedEnd(lastElem);
      const lastPtIdx = lastElem.isReversed ? 0 : 1;

      if (
        arePointsConnected(
          lastElem.entity.id,
          lastPtIdx,
          lastEnd,
          firstElem.entity.id,
          firstPtIdx,
          firstStart,
          constraints,
          tolerance
        )
      ) {
        isClosed = true;
      }
    }
  }

  return { chain, isClosed };
}

/**
 * 依據點選圖元 targetElem 與點擊側座標 sidePoint，計算出全鏈統一的偏移側 ('left' 或 'right')。
 */
function determineOffsetSide(
  targetElem: ChainElement,
  sidePoint: Point2D
): 'left' | 'right' {
  if (targetElem.entity.type === 'line') {
    const start = getDirectedStart(targetElem);
    const end = getDirectedEnd(targetElem);
    const vx = end.x - start.x;
    const vy = end.y - start.y;
    const len = Math.hypot(vx, vy);
    if (len < 1e-9) return 'left';
    // 左向單位法向量
    const nx = -vy / len;
    const ny = vx / len;
    const dot = (sidePoint.x - start.x) * nx + (sidePoint.y - start.y) * ny;
    return dot >= 0 ? 'left' : 'right';
  } else {
    const { center, radius } = targetElem.entity;
    const dist = Math.hypot(sidePoint.x - center.x, sidePoint.y - center.y);
    const wantsOutward = dist >= radius;
    // 逆時針圓弧 (isReversed === false): 左法向朝向圓心(收縮)，右法向背離圓心(擴張)
    // 順時針圓弧 (isReversed === true): 左法向背離圓心(擴張)，右法向朝向圓心(收縮)
    if (!targetElem.isReversed) {
      return wantsOutward ? 'right' : 'left';
    } else {
      return wantsOutward ? 'left' : 'right';
    }
  }
}

/**
 * 求兩條無限延伸直線之交點。若平行或共線則回傳 null。
 */
function intersectLineLineInfinite(p1: Point2D, v1: Point2D, p2: Point2D, v2: Point2D): Point2D | null {
  const det = v1.x * v2.y - v1.y * v2.x;
  if (Math.abs(det) < 1e-9) {
    return null;
  }
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const t = (dx * v2.y - dy * v2.x) / det;
  return {
    x: p1.x + t * v1.x,
    y: p1.y + t * v1.y,
  };
}

/**
 * 求無限直線與圓之交點，若不相交則回傳投影至圓上之最近點。
 */
function intersectLineCircleInfinite(pLine: Point2D, vLine: Point2D, center: Point2D, radius: number): Point2D[] {
  const len = Math.hypot(vLine.x, vLine.y);
  if (len < 1e-9) return [];
  const ux = vLine.x / len;
  const uy = vLine.y / len;

  const wx = pLine.x - center.x;
  const wy = pLine.y - center.y;

  const tProj = -(wx * ux + wy * uy);
  const pProj = {
    x: pLine.x + tProj * ux,
    y: pLine.y + tProj * uy,
  };

  const distSq = (pProj.x - center.x) ** 2 + (pProj.y - center.y) ** 2;
  const rSq = radius * radius;

  if (distSq > rSq + 1e-5) {
    const d = Math.sqrt(distSq);
    if (d > 1e-9) {
      return [{
        x: center.x + radius * (pProj.x - center.x) / d,
        y: center.y + radius * (pProj.y - center.y) / d,
      }];
    }
    return [pProj];
  }

  const h = Math.sqrt(Math.max(0, rSq - distSq));
  if (h < 1e-7) {
    return [pProj];
  }

  return [
    { x: pProj.x + h * ux, y: pProj.y + h * uy },
    { x: pProj.x - h * ux, y: pProj.y - h * uy },
  ];
}

/**
 * 求兩圓交點。若無交點或同心則回傳最近點。
 */
function intersectCircleCircleInfinite(c1: Point2D, r1: number, c2: Point2D, r2: number): Point2D[] {
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);

  if (d < 1e-9) {
    return [];
  }

  if (d > r1 + r2 || d < Math.abs(r1 - r2)) {
    return [{
      x: c1.x + r1 * (dx / d),
      y: c1.y + r1 * (dy / d),
    }];
  }

  const x = (d * d + r1 * r1 - r2 * r2) / (2 * d);
  const ySq = Math.max(0, r1 * r1 - x * x);
  const y = Math.sqrt(ySq);

  const ux = dx / d;
  const uy = dy / d;
  const wx = -uy;
  const wy = ux;

  return [
    { x: c1.x + x * ux + y * wx, y: c1.y + x * uy + y * wy },
    { x: c1.x + x * ux - y * wx, y: c1.y + x * uy - y * wy },
  ];
}

/**
 * 求解轉角處空間交點 (Corner Miter Point)，回傳與原轉角座標最近之交點。
 * 完整支援 Line - Line, Line - Arc, Arc - Line, Arc - Arc。
 */
export function solveCornerIntersection(
  curveA: LineEntity | ArcEntity,
  elemA: ChainElement,
  curveB: LineEntity | ArcEntity,
  elemB: ChainElement,
  origCorner: Point2D,
  distance: number
): Point2D {
  if (curveA.type === 'line' && curveB.type === 'line') {
    const vA = { x: curveA.end.x - curveA.start.x, y: curveA.end.y - curveA.start.y };
    const vB = { x: curveB.end.x - curveB.start.x, y: curveB.end.y - curveB.start.y };
    const pt = intersectLineLineInfinite(curveA.start, vA, curveB.start, vB);
    if (pt) {
      const distFromOrig = Math.hypot(pt.x - origCorner.x, pt.y - origCorner.y);
      if (distFromOrig < Math.max(distance * 25, 200)) {
        return pt;
      }
    }
    const endA = !elemA.isReversed ? curveA.end : curveA.start;
    const startB = !elemB.isReversed ? curveB.start : curveB.end;
    return { x: (endA.x + startB.x) * 0.5, y: (endA.y + startB.y) * 0.5 };
  } else if (curveA.type === 'line' && curveB.type === 'arc') {
    const vA = { x: curveA.end.x - curveA.start.x, y: curveA.end.y - curveA.start.y };
    const candidates = intersectLineCircleInfinite(curveA.start, vA, curveB.center, curveB.radius);
    if (candidates.length === 0) {
      return { ...origCorner };
    }
    if (candidates.length === 1) return candidates[0];
    const d0 = Math.hypot(candidates[0].x - origCorner.x, candidates[0].y - origCorner.y);
    const d1 = Math.hypot(candidates[1].x - origCorner.x, candidates[1].y - origCorner.y);
    return d0 <= d1 ? candidates[0] : candidates[1];
  } else if (curveA.type === 'arc' && curveB.type === 'line') {
    const vB = { x: curveB.end.x - curveB.start.x, y: curveB.end.y - curveB.start.y };
    const candidates = intersectLineCircleInfinite(curveB.start, vB, curveA.center, curveA.radius);
    if (candidates.length === 0) {
      return { ...origCorner };
    }
    if (candidates.length === 1) return candidates[0];
    const d0 = Math.hypot(candidates[0].x - origCorner.x, candidates[0].y - origCorner.y);
    const d1 = Math.hypot(candidates[1].x - origCorner.x, candidates[1].y - origCorner.y);
    return d0 <= d1 ? candidates[0] : candidates[1];
  } else {
    // Arc - Arc
    const arcA = curveA as ArcEntity;
    const arcB = curveB as ArcEntity;
    const candidates = intersectCircleCircleInfinite(arcA.center, arcA.radius, arcB.center, arcB.radius);
    if (candidates.length === 0) {
      return { ...origCorner };
    }
    if (candidates.length === 1) return candidates[0];
    const d0 = Math.hypot(candidates[0].x - origCorner.x, candidates[0].y - origCorner.y);
    const d1 = Math.hypot(candidates[1].x - origCorner.x, candidates[1].y - origCorner.y);
    return d0 <= d1 ? candidates[0] : candidates[1];
  }
}

/**
 * 計算整條連續多段線/連鎖幾何一次性整體偏移 (Bulk Chained Offset)
 * 包含：
 * 1. 連鎖圖元尋找 (findConnectedChain)
 * 2. 統一向內/向外法向平行偏移
 * 3. 轉角處求交修剪 (Corner Miter / Trim)
 * 4. 產生全新圖元與相鄰端點的 coincident 約束
 */
export function calculateOffsetChain(
  targetEntity: CADEntity2D,
  options: OffsetOptions,
  allEntities: CADEntity2D[],
  constraints: Constraint[] = []
): OffsetChainResult | null {
  const { distance, sidePoint } = options;

  if (distance <= 0) {
    return null;
  }

  // 圓形為獨立封閉圖元，直接透過單一圓形偏移計算
  if (targetEntity.type === 'circle') {
    const singleResult = calculateOffsetEntity(targetEntity, options);
    if (!singleResult) return null;
    return {
      entities: [singleResult.entity],
      generatedConstraints: singleResult.generatedConstraints,
    };
  }

  // 僅線段與圓弧可參與連鎖偏移
  if (targetEntity.type !== 'line' && targetEntity.type !== 'arc') {
    return null;
  }

  // 尋找相鄰連接的整串圖元鏈
  const { chain, isClosed } = findConnectedChain(targetEntity, allEntities, constraints);
  if (chain.length === 0) {
    const singleResult = calculateOffsetEntity(targetEntity, options);
    if (!singleResult) return null;
    return {
      entities: [singleResult.entity],
      generatedConstraints: singleResult.generatedConstraints,
    };
  }

  // 找到 targetEntity 在鏈中的元素以判定統一的偏移側 ('left' 或 'right')
  const targetElem = chain.find((elem) => elem.entity.id === targetEntity.id) || chain[0];
  const offsetSide = determineOffsetSide(targetElem, sidePoint);

  const offsetEntities: (LineEntity | ArcEntity)[] = [];
  const generatedConstraints: Constraint[] = [];

  // 1. 初步平行/同心偏移各個圖元
  for (let i = 0; i < chain.length; i++) {
    const elem = chain[i];
    if (elem.entity.type === 'line') {
      const start = getDirectedStart(elem);
      const end = getDirectedEnd(elem);
      const vx = end.x - start.x;
      const vy = end.y - start.y;
      const len = Math.hypot(vx, vy);
      if (len < 1e-10) return null;

      const factor = offsetSide === 'left' ? 1 : -1;
      const nx = (-vy / len) * factor;
      const ny = (vx / len) * factor;
      const dx = distance * nx;
      const dy = distance * ny;

      const newLineId = crypto.randomUUID();
      const newLine: LineEntity = {
        ...elem.entity,
        id: newLineId,
        start: { x: elem.entity.start.x + dx, y: elem.entity.start.y + dy },
        end: { x: elem.entity.end.x + dx, y: elem.entity.end.y + dy },
      };

      offsetEntities.push(newLine);

      // 自動產生平行約束
      generatedConstraints.push({
        id: `c-parallel-${elem.entity.id}-${newLineId}-${uuid()}`,
        type: 'parallel',
        entityIds: [elem.entity.id, newLineId],
      });
    } else {
      const { center, radius } = elem.entity;
      let radiusDelta = 0;
      if (!elem.isReversed) {
        radiusDelta = offsetSide === 'left' ? -distance : distance;
      } else {
        radiusDelta = offsetSide === 'left' ? distance : -distance;
      }

      const newRadius = radius + radiusDelta;
      const finalRadius = newRadius > 1e-4 ? newRadius : 1e-4;

      const newArcId = crypto.randomUUID();
      const newArc: ArcEntity = {
        ...elem.entity,
        id: newArcId,
        radius: finalRadius,
      };

      offsetEntities.push(newArc);

      // 自動產生圓心同心重合與半徑約束
      generatedConstraints.push({
        id: `c-coincident-${elem.entity.id}-${newArcId}-${uuid()}`,
        type: 'coincident',
        entityIds: [elem.entity.id, newArcId],
        pointIndices: [2, 2],
      });
      generatedConstraints.push({
        id: `c-radius-${newArcId}-${uuid()}`,
        type: 'distance',
        entityIds: [newArcId],
        value: finalRadius,
      });
    }
  }

  // 2. 轉角處求交修剪 (Corner Miter / Trim)
  const cornerCount = isClosed ? chain.length : chain.length - 1;

  for (let i = 0; i < cornerCount; i++) {
    const nextIdx = (i + 1) % chain.length;
    const curveA = offsetEntities[i];
    const curveB = offsetEntities[nextIdx];
    const elemA = chain[i];
    const elemB = chain[nextIdx];

    const origCorner = getDirectedEnd(elemA);
    const cornerPt = solveCornerIntersection(curveA, elemA, curveB, elemB, origCorner, distance);

    // 更新 curveA 在轉角處的端點座標或終端角度
    if (curveA.type === 'line') {
      if (!elemA.isReversed) {
        curveA.end = { ...cornerPt };
      } else {
        curveA.start = { ...cornerPt };
      }
    } else {
      const thetaA = normalizeAngle(Math.atan2(cornerPt.y - curveA.center.y, cornerPt.x - curveA.center.x));
      if (!elemA.isReversed) {
        curveA.endAngle = thetaA;
      } else {
        curveA.startAngle = thetaA;
      }
    }

    // 更新 curveB 在轉角處的端點座標或起端角度
    if (curveB.type === 'line') {
      if (!elemB.isReversed) {
        curveB.start = { ...cornerPt };
      } else {
        curveB.end = { ...cornerPt };
      }
    } else {
      const thetaB = normalizeAngle(Math.atan2(cornerPt.y - curveB.center.y, cornerPt.x - curveB.center.x));
      if (!elemB.isReversed) {
        curveB.startAngle = thetaB;
      } else {
        curveB.endAngle = thetaB;
      }
    }

    // 建立轉角重合 (coincident) 約束
    const ptIdxA = !elemA.isReversed ? 1 : 0;
    const ptIdxB = !elemB.isReversed ? 0 : 1;

    generatedConstraints.push({
      id: `c-coincident-${curveA.id}-${curveB.id}-${uuid()}`,
      type: 'coincident',
      entityIds: [curveA.id, curveB.id],
      pointIndices: [ptIdxA, ptIdxB],
    });
  }

  return {
    entities: offsetEntities,
    generatedConstraints,
  };
}

/**
 * 通用與舊介面相容之 calculateChainOffset 函式
 */
export function calculateChainOffset(
  targetEntityOrId: CADEntity2D | string,
  optionsOrDistance: OffsetOptions | number,
  sidePointOrEntities?: Point2D | CADEntity2D[],
  allEntitiesOrConstraints?: CADEntity2D[] | Constraint[],
  constraintsParam?: Constraint[]
): OffsetChainResult | null {
  let targetEntity: CADEntity2D | undefined;
  let options: OffsetOptions;
  let allEntities: CADEntity2D[] = [];
  let constraints: Constraint[] = [];

  if (typeof targetEntityOrId === 'string') {
    const entityList = Array.isArray(allEntitiesOrConstraints)
      ? (allEntitiesOrConstraints as CADEntity2D[])
      : Array.isArray(sidePointOrEntities)
      ? (sidePointOrEntities as CADEntity2D[])
      : [];
    targetEntity = entityList.find((e) => e.id === targetEntityOrId);
    if (!targetEntity) return null;

    if (typeof optionsOrDistance === 'number') {
      if (!sidePointOrEntities || Array.isArray(sidePointOrEntities)) return null;
      options = { distance: optionsOrDistance, sidePoint: sidePointOrEntities as Point2D };
      allEntities = entityList;
      constraints = constraintsParam || [];
    } else {
      options = optionsOrDistance;
      allEntities = entityList;
      constraints = (Array.isArray(allEntitiesOrConstraints) ? constraintsParam : (allEntitiesOrConstraints as Constraint[])) || [];
    }
  } else {
    targetEntity = targetEntityOrId;
    if (typeof optionsOrDistance === 'number') {
      if (!sidePointOrEntities || Array.isArray(sidePointOrEntities)) return null;
      options = { distance: optionsOrDistance, sidePoint: sidePointOrEntities as Point2D };
      allEntities = (Array.isArray(allEntitiesOrConstraints) ? allEntitiesOrConstraints : []) as CADEntity2D[];
      constraints = constraintsParam || [];
    } else {
      options = optionsOrDistance;
      allEntities = (Array.isArray(sidePointOrEntities) ? sidePointOrEntities : []) as CADEntity2D[];
      constraints = (Array.isArray(allEntitiesOrConstraints) ? allEntitiesOrConstraints : []) as Constraint[];
    }
  }

  return calculateOffsetChain(targetEntity, options, allEntities, constraints);
}

/**
 * 計算單一圖元等距法向偏置 (Normal Offset)
 * 支援 Line, Arc, Circle。
 */
export function calculateOffsetEntity(entity: CADEntity2D, options: OffsetOptions): OffsetResult | null {
  const { distance, sidePoint } = options;

  if (distance <= 0) {
    return null;
  }

  switch (entity.type) {
    case 'line': {
      const { start, end } = entity;
      const vx = end.x - start.x;
      const vy = end.y - start.y;
      const L = Math.hypot(vx, vy);

      if (L < 1e-10) {
        return null;
      }

      const nx = -vy / L;
      const ny = vx / L;
      const dot = (sidePoint.x - start.x) * nx + (sidePoint.y - start.y) * ny;
      const factor = dot >= 0 ? 1 : -1;
      const dx = factor * distance * nx;
      const dy = factor * distance * ny;

      const newLineId = crypto.randomUUID();
      const newLine: LineEntity = {
        ...entity,
        id: newLineId,
        start: { x: start.x + dx, y: start.y + dy },
        end: { x: end.x + dx, y: end.y + dy },
      };

      const parallelConstraint: Constraint = {
        id: `c-parallel-${entity.id}-${newLineId}-${uuid()}`,
        type: 'parallel',
        entityIds: [entity.id, newLineId],
      };

      return {
        entity: newLine,
        generatedConstraints: [parallelConstraint],
      };
    }

    case 'circle': {
      const { center, radius } = entity;
      const dist = Math.hypot(sidePoint.x - center.x, sidePoint.y - center.y);
      const R_new = dist >= radius ? radius + distance : radius - distance;

      if (R_new <= 1e-4) {
        return null;
      }

      const newCircleId = crypto.randomUUID();
      const newCircle: CircleEntity = {
        ...entity,
        id: newCircleId,
        radius: R_new,
      };

      const coincidentConstraint: Constraint = {
        id: `c-coincident-${entity.id}-${newCircleId}-${uuid()}`,
        type: 'coincident',
        entityIds: [entity.id, newCircleId],
        pointIndices: [0, 0],
      };

      const radiusConstraint: Constraint = {
        id: `c-radius-${newCircleId}-${uuid()}`,
        type: 'distance',
        entityIds: [newCircleId],
        value: R_new,
      };

      return {
        entity: newCircle,
        generatedConstraints: [coincidentConstraint, radiusConstraint],
      };
    }

    case 'arc': {
      const { center, radius } = entity;
      const dist = Math.hypot(sidePoint.x - center.x, sidePoint.y - center.y);
      const R_new = dist >= radius ? radius + distance : radius - distance;

      if (R_new <= 1e-4) {
        return null;
      }

      const newArcId = crypto.randomUUID();
      const newArc: ArcEntity = {
        ...entity,
        id: newArcId,
        radius: R_new,
      };

      const coincidentConstraint: Constraint = {
        id: `c-coincident-${entity.id}-${newArcId}-${uuid()}`,
        type: 'coincident',
        entityIds: [entity.id, newArcId],
        pointIndices: [2, 2],
      };

      const radiusConstraint: Constraint = {
        id: `c-radius-${newArcId}-${uuid()}`,
        type: 'distance',
        entityIds: [newArcId],
        value: R_new,
      };

      return {
        entity: newArc,
        generatedConstraints: [coincidentConstraint, radiusConstraint],
      };
    }

    case 'polyline':
    default:
      return null;
  }
}

/**
 * 通用 calculateOffset 函式，多重引數支援
 */
export function calculateOffset(
  entityOrId: CADEntity2D | string,
  distanceOrOptions: number | OffsetOptions,
  sidePointOrEntities?: Point2D | CADEntity2D[],
  entitiesParam?: CADEntity2D[]
): OffsetResult | null {
  let targetEntity: CADEntity2D | undefined;
  let distance: number;
  let sidePoint: Point2D;

  if (typeof entityOrId === 'string') {
    const allEntities = Array.isArray(sidePointOrEntities) ? sidePointOrEntities : (entitiesParam || []);
    targetEntity = allEntities.find((e) => e.id === entityOrId);
    if (!targetEntity) return null;

    if (typeof distanceOrOptions === 'number') {
      distance = distanceOrOptions;
      if (!sidePointOrEntities || Array.isArray(sidePointOrEntities)) return null;
      sidePoint = sidePointOrEntities as Point2D;
    } else {
      distance = distanceOrOptions.distance;
      sidePoint = distanceOrOptions.sidePoint;
    }
  } else {
    targetEntity = entityOrId;
    if (typeof distanceOrOptions === 'number') {
      distance = distanceOrOptions;
      if (!sidePointOrEntities || Array.isArray(sidePointOrEntities)) return null;
      sidePoint = sidePointOrEntities as Point2D;
    } else {
      distance = distanceOrOptions.distance;
      sidePoint = distanceOrOptions.sidePoint;
    }
  }

  return calculateOffsetEntity(targetEntity, { distance, sidePoint });
}
