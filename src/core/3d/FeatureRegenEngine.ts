/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CADFeature } from '../../types/cad';

// 【架構規範】將 Store 動態注入的 Runtime 狀態與純淨的存檔 Data Model 分離
export type RuntimeCADFeature = CADFeature & {
  isDirty?: boolean;
  error?: string | null;
};

export interface RegenPlan {
  evalSequence: RuntimeCADFeature[];        // 嚴格依照「歷史順序 (History Order)」排列的有效特徵
  dirtyFeatures: RuntimeCADFeature[];       // 當前標記為髒的特徵清單
  brokenDependencies: Map<string, string[]>; // 遺失父依賴的特徵映射
  hasCycle: boolean;                        // 是否存在循環引用
  cycleNodes: string[];                     // 參與循環引用的特徵 ID 清單
  dirtyFromIndex: number;                   // 首個需要重新評估的「歷史索引」（-1 表示無需重算）
  isPureRollback: boolean;                  // 是否僅為回退棒移動（前序特徵完全乾淨且有效）
  reusableFeatureIds: string[];             // 可直接複用上一次快取結果的特徵 ID 清單
}

export interface GraphAnalysisResult {
  hasCycle: boolean;
  cycleNodes: string[];
}

/**
 * 取得特徵直接相依的父特徵 ID 清單
 */
export function getDirectDependencies(feature: RuntimeCADFeature | { dependencies?: string[] }): string[] {
  if (!feature || !feature.dependencies) return [];
  return [...feature.dependencies];
}

/**
 * 提取指定回退索引內且未被抑制的有效特徵歷史切片 (嚴格保持歷史順序)
 */
export function getActiveFeatures(features: RuntimeCADFeature[], rollbackIndex: number): RuntimeCADFeature[] {
  const boundedIndex = Math.max(0, Math.min(rollbackIndex, features.length));
  return features.slice(0, boundedIndex).filter((f) => !f.suppressed);
}

/**
 * 【P2 架構修復】分析特徵 DAG 依賴圖
 * 僅用於「循環檢測 (Cycle Detection)」與「依賴追蹤」，絕對不回傳排序後的陣列以防破壞 History Order！
 */
export function analyzeFeatureGraph(features: RuntimeCADFeature[]): GraphAnalysisResult {
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>(); // parentId -> childIds

  for (const f of features) {
    if (!inDegree.has(f.id)) inDegree.set(f.id, 0);
    if (!adjList.has(f.id)) adjList.set(f.id, []);
  }

  // 建立相鄰表與入度計算 (f 依賴于 depId => depId 為 parent)
  const featureIds = new Set(features.map(f => f.id));
  for (const f of features) {
    const deps = getDirectDependencies(f);
    let validDepCount = 0;
    for (const depId of deps) {
      if (featureIds.has(depId)) {
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

  // 使用 Kahn's 演算法檢測循環
  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  let processedCount = 0;
  while (queue.length > 0) {
    const currId = queue.shift()!;
    processedCount++;

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

  const hasCycle = processedCount < features.length;
  const cycleNodes: string[] = [];

  if (hasCycle) {
    // 剩餘入度 > 0 的節點即為參與循環的節點
    for (const [id, deg] of inDegree.entries()) {
      if (deg > 0) {
        cycleNodes.push(id);
      }
    }
  }

  return { hasCycle, cycleNodes };
}

/**
 * 檢查所有特徵的 dependencies 是否存在於當前的特徵清單中，回傳孤兒依賴映射
 */
export function validateFeatureDependencies(features: RuntimeCADFeature[]): Map<string, string[]> {
  const featureIds = new Set(features.map((f) => f.id));
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
 * 從指定修改的特徵開始，利用 DAG 遞迴標記所有下游子特徵為髒 (isDirty = true)
 */
export function markDownstreamDirty(features: RuntimeCADFeature[], modifiedFeatureId: string): RuntimeCADFeature[] {
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

  // BFS 遍歷所有受影響的子特徵
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

  return features.map((f) => {
    if (affectedIds.has(f.id)) {
      return {
        ...f,
        isDirty: true,
      } as RuntimeCADFeature;
    }
    return f;
  });
}

/**
 * 【P2 架構修復】升級重生成計畫器
 * 嚴格保證 evalSequence 遵循 History Order，以正確推導 dirtyFromIndex！
 */
export function getRegenPlan(
  features: RuntimeCADFeature[],
  rollbackIndex: number,
  cachedFeatureIds: string[] = []
): RegenPlan {
  // 1. 取得歷史順序切片
  const active = getActiveFeatures(features, rollbackIndex);

  // 2. DAG 分析：僅用於檢測循環與斷鏈，不改變原始特徵順序！
  const { hasCycle, cycleNodes } = analyzeFeatureGraph(active);
  const brokenDependencies = validateFeatureDependencies(active);

  // 3. 執行序列 = 歷史序列 (SolidWorks 核心法則)
  const evalSequence = active;

  // 4. 在歷史序列中，尋找第一顆「髒掉」、「未快取」或「依賴斷裂」的特徵
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
  let dirtyFeatures: RuntimeCADFeature[] = [];

  if (firstDirtyIdx === -1) {
    // 全數乾淨：純粹是把回退棒往上拉
    dirtyFromIndex = -1;
    isPureRollback = true;
    reusableFeatureIds = evalSequence.map((f) => f.id);
    dirtyFeatures = [];
  } else {
    // 增量重算：從第一顆髒掉的特徵開始，後續「全部」都要重新 Evaluate
    dirtyFromIndex = firstDirtyIdx;
    isPureRollback = false;
    reusableFeatureIds = evalSequence.slice(0, firstDirtyIdx).map((f) => f.id);
    dirtyFeatures = evalSequence.slice(firstDirtyIdx); 
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
  features: RuntimeCADFeature[],
  results: { featureId: string; success: boolean; error?: string }[]
): RuntimeCADFeature[] {
  const resultMap = new Map<string, { success: boolean; error?: string }>();
  for (const r of results) {
    resultMap.set(r.featureId, r);
  }

  return features.map((f) => {
    const res = resultMap.get(f.id);
    if (!res) {
      return f;
    }

    if (res.success) {
      return {
        ...f,
        isDirty: false,
        error: null,
      } as RuntimeCADFeature;
    } else {
      return {
        ...f,
        isDirty: true,
        error: res.error || 'Feature regeneration failed',
      } as RuntimeCADFeature;
    }
  });
}