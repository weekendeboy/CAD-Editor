import type { CADFeature } from '../../types/cad';

export interface RegenPlan {
  evalSequence: CADFeature[];               // 依照拓撲順序排列的有效特徵序列
  dirtyFeatures: CADFeature[];              // 當前標記為髒的特徵清單
  brokenDependencies: Map<string, string[]>; // 遺失父依賴的特徵映射
  hasCycle: boolean;                        // 是否存在循環引用
  cycleNodes: string[];                     // 參與循環引用的特徵 ID 清單
  dirtyFromIndex: number;                   // 首個需要重新評估的特徵索引（-1 表示無需重算）
  isPureRollback: boolean;                  // 是否僅為回退棒移動（前序特徵完全乾淨且有效）
  reusableFeatureIds: string[];             // 可直接複用上一次快取結果的特徵 ID 清單
}

export interface TopologicalSortResult {
  sorted: CADFeature[];
  hasCycle: boolean;
  cycleNodes: string[];
}

/**
 * 取得特徵直接相依的父特徵 ID 清單
 */
export function getDirectDependencies(feature: CADFeature | { dependencies?: string[] }): string[] {
  if (!feature || !feature.dependencies) return [];
  return [...feature.dependencies];
}

/**
 * 提取指定回退索引內且未被抑制的有效特徵歷史切片
 */
export function getActiveFeatures(features: CADFeature[], rollbackIndex: number): CADFeature[] {
  const boundedIndex = Math.max(0, Math.min(rollbackIndex, features.length));
  return features.slice(0, boundedIndex).filter(f => !f.suppressed);
}

/**
 * 基於依賴圖進行特徵拓撲排序與循環檢檢（Kahn's 演算法改良版）
 */
export function topologicalSortFeatures(features: CADFeature[]): TopologicalSortResult {
  const featureMap = new Map<string, CADFeature>();
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>(); // parentId -> childIds

  for (const f of features) {
    featureMap.set(f.id, f);
    if (!inDegree.has(f.id)) {
      inDegree.set(f.id, 0);
    }
    if (!adjList.has(f.id)) {
      adjList.set(f.id, []);
    }
  }

  // 建立相鄰表與入度計算
  // 註：依賴關係表示 f 依賴于 depId (depId 為 parent，f 為 child)
  for (const f of features) {
    const deps = getDirectDependencies(f);
    let validDepCount = 0;
    for (const depId of deps) {
      if (featureMap.has(depId)) {
        validDepCount++;
        let children = adjList.get(depId);
        if (!children) {
          children = [];
          adjList.set(depId, children);
        }
        children.push(f.id);
      }
    }
    inDegree.set(f.id, validDepCount);
  }

  // 初始入度為 0 的節點佇列
  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  const sortedIds: string[] = [];
  
  while (queue.length > 0) {
    queue.sort((a, b) => {
      const idxA = features.findIndex(f => f.id === a);
      const idxB = features.findIndex(f => f.id === b);
      return idxA - idxB;
    });

    const currId = queue.shift()!;
    sortedIds.push(currId);

    const children = adjList.get(currId) || [];
    for (const childId of children) {
      const currentDeg = inDegree.get(childId) || 1;
      const newDeg = currentDeg - 1;
      inDegree.set(childId, newDeg);
      if (newDeg === 0) {
        queue.push(childId);
      }
    }
  }

  const hasCycle = sortedIds.length < features.length;
  const cycleNodes: string[] = [];

  if (hasCycle) {
    const sortedSet = new Set(sortedIds);
    for (const f of features) {
      if (!sortedSet.has(f.id)) {
        cycleNodes.push(f.id);
      }
    }
  }

  const sorted = sortedIds.map(id => featureMap.get(id)!).filter(Boolean);
  return {
    sorted,
    hasCycle,
    cycleNodes,
  };
}

/**
 * 檢查所有特徵的 dependencies 是否存在於特徵清單中，回傳孤兒依賴映射
 */
export function validateFeatureDependencies(features: CADFeature[]): Map<string, string[]> {
  const featureIds = new Set(features.map(f => f.id));
  const brokenMap = new Map<string, string[]>();

  for (const f of features) {
    const missing: string[] = [];
    const deps = getDirectDependencies(f);
    for (const depId of deps) {
      if (!featureIds.has(depId)) {
        missing.push(depId);
      }
    }
    if (missing.length > 0) {
      brokenMap.set(f.id, missing);
    }
  }

  return brokenMap;
}

/**
 * 從指定修改特徵開始，遞迴標記所有下游子特徵為髒 (isDirty = true)
 */
export function markDownstreamDirty(features: CADFeature[], modifiedFeatureId: string): CADFeature[] {
  const childrenMap = new Map<string, string[]>();
  for (const f of features) {
    const deps = getDirectDependencies(f);
    for (const depId of deps) {
      let list = childrenMap.get(depId);
      if (!list) {
        list = [];
        childrenMap.set(depId, list);
      }
      list.push(f.id);
    }
  }

  const affectedIds = new Set<string>();
  const queue: string[] = [modifiedFeatureId];
  affectedIds.add(modifiedFeatureId);

  while (queue.length > 0) {
    const currId = queue.shift()!;
    const children = childrenMap.get(currId) || [];
    for (const childId of children) {
      if (!affectedIds.has(childId)) {
        affectedIds.add(childId);
        queue.push(childId);
      }
    }
  }

  return features.map(f => {
    if (affectedIds.has(f.id)) {
      return {
        ...f,
        isDirty: true,
      };
    }
    return f;
  });
}

/**
 * 升級重生成計畫器：分析特徵 DAG、回退狀態、髒標記與快取有效性
 */
export function getRegenPlan(
  features: CADFeature[],
  rollbackIndex: number,
  cachedFeatureIds: string[] = []
): RegenPlan {
  const active = getActiveFeatures(features, rollbackIndex);

  const topoResult = topologicalSortFeatures(active);
  const brokenDependencies = validateFeatureDependencies(active);

  const evalSequence = topoResult.sorted;
  const hasCycle = topoResult.hasCycle;
  const cycleNodes = topoResult.cycleNodes;

  let firstDirtyIdx = -1;
  for (let i = 0; i < evalSequence.length; i++) {
    const feat = evalSequence[i];
    const isCached = cachedFeatureIds.includes(feat.id);
    const isBroken = brokenDependencies.has(feat.id);
    if (feat.isDirty || !isCached || isBroken) {
      firstDirtyIdx = i;
      break;
    }
  }

  let dirtyFromIndex = -1;
  let isPureRollback = false;
  let reusableFeatureIds: string[] = [];
  let dirtyFeatures: CADFeature[] = [];

  if (firstDirtyIdx === -1) {
    dirtyFromIndex = -1;
    isPureRollback = true;
    reusableFeatureIds = evalSequence.map(f => f.id);
    dirtyFeatures = [];
  } else {
    dirtyFromIndex = firstDirtyIdx;
    isPureRollback = false;
    reusableFeatureIds = evalSequence.slice(0, firstDirtyIdx).map(f => f.id);
    dirtyFeatures = evalSequence.slice(firstDirtyIdx).filter(
      f => f.isDirty || !cachedFeatureIds.includes(f.id) || brokenDependencies.has(f.id)
    );
  }

  return {
    evalSequence,
    dirtyFeatures,
    brokenDependencies,
    hasCycle,
    cycleNodes,
    dirtyFromIndex,
    isPureRollback,
    reusableFeatureIds,
  };
}

/**
 * 套用重算結果：成功者解除髒標記，失敗者保留髒標記並寫入錯誤訊息
 */
export function applyRegenResults(
  features: CADFeature[],
  results: { featureId: string; success: boolean; error?: string }[]
): CADFeature[] {
  const resultMap = new Map<string, { success: boolean; error?: string }>();
  for (const r of results) {
    resultMap.set(r.featureId, r);
  }

  return features.map(f => {
    const res = resultMap.get(f.id);
    if (!res) {
      return f;
    }

    if (res.success) {
      return {
        ...f,
        isDirty: false,
        error: null,
      };
    } else {
      return {
        ...f,
        isDirty: true,
        error: res.error || 'Feature regeneration failed',
      };
    }
  });
}
