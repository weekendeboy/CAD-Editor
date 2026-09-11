import { CADEntity2D, Point2D, LineEntity, ArcEntity, PolylineEntity, CircleEntity } from '../../types/cad';

export interface StitchOptions {
  tolerance?: number;         // 縫合空間容差（預設 1e-3 mm）
  removeDegenerate?: boolean; // 是否自動過濾小於容差的退化圖元（預設 true）
}

export interface StitchResult {
  entities: CADEntity2D[];
  mergedPointsCount: number; // 成功縫合對齊的端點數量
  removedEntitiesCount: number; // 剔除的退化圖元數量
}

/**
 * 端點參照記錄結構
 */
export interface EndpointRecord {
  id: number;
  entityId: string;
  pointType: 'line_start' | 'line_end' | 'arc_start' | 'arc_end' | 'poly_point';
  pointIndex?: number;
  point: Point2D;
}

/**
 * 並查集（Disjoint Set Union / Union-Find）實作
 */
class DisjointSet {
  private parent: number[];
  private rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = new Array(size).fill(0);
  }

  find(i: number): number {
    if (this.parent[i] === i) {
      return i;
    }
    this.parent[i] = this.find(this.parent[i]);
    return this.parent[i];
  }

  union(i: number, j: number): boolean {
    const rootI = this.find(i);
    const rootJ = this.find(j);
    if (rootI !== rootJ) {
      if (this.rank[rootI] < this.rank[rootJ]) {
        this.parent[rootI] = rootJ;
      } else if (this.rank[rootI] > this.rank[rootJ]) {
        this.parent[rootJ] = rootI;
      } else {
        this.parent[rootJ] = rootI;
        this.rank[rootI]++;
      }
      return true;
    }
    return false;
  }
}

/**
 * 將角度正規化至 [0, 2π) 區間
 */
function normalizeAngle(angle: number): number {
  let a = angle % (2 * Math.PI);
  if (a < 0) {
    a += 2 * Math.PI;
  }
  return a;
}

/**
 * 2D 端點空間容差自動縫合引擎
 * 
 * 以空間雜湊網格（Spatial Hash Grid）快速聚類並吸附相鄰端點，
 * 修復 1e-3 ~ 1e-5 mm 等微小裂隙，使拓撲環閉合。
 * 
 * @param entities 待縫合的圖元清單
 * @param options 縫合選項（容差與退化過濾）
 * @returns 縫合後圖元陣列與統計資訊
 */
export function autoStitchEntities(
  entities: CADEntity2D[],
  options?: StitchOptions
): StitchResult {
  const tolerance = (options?.tolerance !== undefined && options.tolerance > 0) 
    ? options.tolerance 
    : 1e-3;
  const removeDegenerate = options?.removeDegenerate ?? true;

  if (!entities || entities.length === 0) {
    return {
      entities: [],
      mergedPointsCount: 0,
      removedEntitiesCount: 0,
    };
  }

  // 1. 端點收集（Endpoint Extraction）
  const endpoints: EndpointRecord[] = [];
  let endpointIdCounter = 0;

  for (const entity of entities) {
    if (entity.type === 'line') {
      endpoints.push({
        id: endpointIdCounter++,
        entityId: entity.id,
        pointType: 'line_start',
        point: { x: entity.start.x, y: entity.start.y },
      });
      endpoints.push({
        id: endpointIdCounter++,
        entityId: entity.id,
        pointType: 'line_end',
        point: { x: entity.end.x, y: entity.end.y },
      });
    } else if (entity.type === 'arc') {
      const startPt: Point2D = {
        x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
        y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
      };
      const endPt: Point2D = {
        x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
        y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
      };
      endpoints.push({
        id: endpointIdCounter++,
        entityId: entity.id,
        pointType: 'arc_start',
        point: startPt,
      });
      endpoints.push({
        id: endpointIdCounter++,
        entityId: entity.id,
        pointType: 'arc_end',
        point: endPt,
      });
    } else if (entity.type === 'polyline') {
      for (let i = 0; i < entity.points.length; i++) {
        endpoints.push({
          id: endpointIdCounter++,
          entityId: entity.id,
          pointType: 'poly_point',
          pointIndex: i,
          point: { x: entity.points[i].x, y: entity.points[i].y },
        });
      }
    } else if (entity.type === 'circle') {
      // 圓形為封閉幾何，無自由端點，跳過不納入吸附
      continue;
    }
  }

  const numEndpoints = endpoints.length;
  if (numEndpoints === 0) {
    // 若無可縫合端點，直接複製輸出
    return {
      entities: entities.map((e) => ({ ...e })),
      mergedPointsCount: 0,
      removedEntitiesCount: 0,
    };
  }

  // 2. 空間雜湊網格聚類（Spatial Hash Grid & Clustering）
  const grid = new Map<string, number[]>();

  for (let i = 0; i < numEndpoints; i++) {
    const pt = endpoints[i].point;
    const cellX = Math.floor(pt.x / tolerance);
    const cellY = Math.floor(pt.y / tolerance);
    const key = `${cellX},${cellY}`;

    const cellList = grid.get(key);
    if (cellList) {
      cellList.push(i);
    } else {
      grid.set(key, [i]);
    }
  }

  const dsu = new DisjointSet(numEndpoints);

  // 針對 3x3 相鄰九宮格進行兩兩距離比對
  for (const [cellKey, indices] of grid.entries()) {
    const [cxStr, cyStr] = cellKey.split(',');
    const cx = parseInt(cxStr, 10);
    const cy = parseInt(cyStr, 10);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const neighborKey = `${cx + dx},${cy + dy}`;
        const neighborIndices = grid.get(neighborKey);
        if (!neighborIndices) continue;

        for (const i of indices) {
          for (const j of neighborIndices) {
            if (i < j) {
              const p1 = endpoints[i].point;
              const p2 = endpoints[j].point;
              const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
              if (dist <= tolerance) {
                dsu.union(i, j);
              }
            }
          }
        }
      }
    }
  }

  // 3. 質心融合（Centroid Snapping）
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < numEndpoints; i++) {
    const root = dsu.find(i);
    const cluster = clusters.get(root);
    if (cluster) {
      cluster.push(i);
    } else {
      clusters.set(root, [i]);
    }
  }

  const snappedPoints: Point2D[] = new Array(numEndpoints);
  let mergedPointsCount = 0;

  for (const clusterIndices of clusters.values()) {
    if (clusterIndices.length >= 2) {
      let sumX = 0;
      let sumY = 0;
      for (const idx of clusterIndices) {
        sumX += endpoints[idx].point.x;
        sumY += endpoints[idx].point.y;
      }
      const centroid: Point2D = {
        x: sumX / clusterIndices.length,
        y: sumY / clusterIndices.length,
      };

      for (const idx of clusterIndices) {
        snappedPoints[idx] = centroid;
        mergedPointsCount++;
      }
    } else {
      const idx = clusterIndices[0];
      snappedPoints[idx] = endpoints[idx].point;
    }
  }

  // 建立 endpointId -> snappedPoint 映射
  const endpointMap = new Map<number, Point2D>();
  for (let i = 0; i < numEndpoints; i++) {
    endpointMap.set(endpoints[i].id, snappedPoints[i]);
  }

  // 建立 (entityId + pointType + pointIndex) -> snappedPoint 快速檢索
  const entityPointMap = new Map<string, Point2D>();
  for (let i = 0; i < numEndpoints; i++) {
    const ep = endpoints[i];
    const key = `${ep.entityId}:${ep.pointType}:${ep.pointIndex ?? 0}`;
    entityPointMap.set(key, snappedPoints[i]);
  }

  // 4. 圖元幾何重建與更新
  const resultEntities: CADEntity2D[] = [];
  let removedEntitiesCount = 0;

  for (const entity of entities) {
    if (entity.type === 'line') {
      const newStart = entityPointMap.get(`${entity.id}:line_start:0`) ?? { ...entity.start };
      const newEnd = entityPointMap.get(`${entity.id}:line_end:0`) ?? { ...entity.end };

      const length = Math.hypot(newEnd.x - newStart.x, newEnd.y - newStart.y);
      if (removeDegenerate && length < tolerance) {
        removedEntitiesCount++;
      } else {
        const updatedLine: LineEntity = {
          ...entity,
          start: newStart,
          end: newEnd,
        };
        resultEntities.push(updatedLine);
      }
    } else if (entity.type === 'arc') {
      const newStartPt = entityPointMap.get(`${entity.id}:arc_start:0`) ?? {
        x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
        y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
      };
      const newEndPt = entityPointMap.get(`${entity.id}:arc_end:0`) ?? {
        x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
        y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
      };

      const rawStartAngle = Math.atan2(newStartPt.y - entity.center.y, newStartPt.x - entity.center.x);
      const rawEndAngle = Math.atan2(newEndPt.y - entity.center.y, newEndPt.x - entity.center.x);

      const newStartAngle = normalizeAngle(rawStartAngle);
      const newEndAngle = normalizeAngle(rawEndAngle);

      const rStart = Math.hypot(newStartPt.x - entity.center.x, newStartPt.y - entity.center.y);
      const rEnd = Math.hypot(newEndPt.x - entity.center.x, newEndPt.y - entity.center.y);
      const newRadius = (rStart + rEnd) / 2;

      let angleSpan = newEndAngle - newStartAngle;
      if (angleSpan <= 0) {
        angleSpan += 2 * Math.PI;
      }
      if (Math.abs(newStartAngle - newEndAngle) < 1e-12) {
        angleSpan = 0;
      }

      const arcLength = angleSpan * newRadius;

      if (removeDegenerate && (newRadius < tolerance || arcLength < tolerance)) {
        removedEntitiesCount++;
      } else {
        const updatedArc: ArcEntity = {
          ...entity,
          radius: newRadius,
          startAngle: newStartAngle,
          endAngle: newEndAngle,
        };
        resultEntities.push(updatedArc);
      }
    } else if (entity.type === 'polyline') {
      const newPoints: Point2D[] = [];
      for (let i = 0; i < entity.points.length; i++) {
        const pt = entityPointMap.get(`${entity.id}:poly_point:${i}`) ?? { ...entity.points[i] };
        newPoints.push(pt);
      }

      if (removeDegenerate) {
        // 過濾連續退化重複點
        const filteredPoints: Point2D[] = [];
        const filteredBulges: number[] | undefined = entity.bulges ? [] : undefined;

        for (let i = 0; i < newPoints.length; i++) {
          const pt = newPoints[i];
          if (filteredPoints.length === 0) {
            filteredPoints.push(pt);
            if (filteredBulges && entity.bulges && entity.bulges[i] !== undefined) {
              filteredBulges.push(entity.bulges[i]);
            }
          } else {
            const prevPt = filteredPoints[filteredPoints.length - 1];
            const dist = Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y);
            if (dist >= tolerance) {
              filteredPoints.push(pt);
              if (filteredBulges && entity.bulges && entity.bulges[i] !== undefined) {
                filteredBulges.push(entity.bulges[i]);
              }
            }
          }
        }

        let polylineLength = 0;
        for (let i = 0; i < filteredPoints.length - 1; i++) {
          polylineLength += Math.hypot(
            filteredPoints[i + 1].x - filteredPoints[i].x,
            filteredPoints[i + 1].y - filteredPoints[i].y
          );
        }

        if (filteredPoints.length < 2 || polylineLength < tolerance) {
          removedEntitiesCount++;
        } else {
          const updatedPolyline: PolylineEntity = {
            ...entity,
            points: filteredPoints,
            ...(filteredBulges ? { bulges: filteredBulges } : {}),
          };
          resultEntities.push(updatedPolyline);
        }
      } else {
        const updatedPolyline: PolylineEntity = {
          ...entity,
          points: newPoints,
        };
        resultEntities.push(updatedPolyline);
      }
    } else {
      // 複製 CircleEntity 或其它未知圖元
      const fallbackEntity = entity as CADEntity2D;
      resultEntities.push({ ...fallbackEntity });
    }
  }

  return {
    entities: resultEntities,
    mergedPointsCount,
    removedEntitiesCount,
  };
}
