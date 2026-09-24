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
  dirtyFromHistoryIndex: number;            // 首個需要重新評估的「歷史索引」CADDocument.featureTree[] (-1 表示無需重算)
  dirtyFromIndex: number;                   // 向下相容別名 (= dirtyFromHistoryIndex)
  isPureRollback: boolean;                  // 是否僅為回退棒移動（前序特徵完全乾淨且有效）
  reusableFeatureIds: string[];             // 可直接複用上一次快取結果的特徵 ID 清單
}

export interface GraphAnalysisResult {
  hasCycle: boolean;
  cycleNodes: string[];
}

/**
 * 解析並修復表面草圖之父特徵 ID (若 parentFeatureId 為 'main-body'、'solid-0' 或懸空，自動回溯到最近上游實體特徵)
 */
export function resolveAttachedParentFeatureId(
  feature: RuntimeCADFeature | { dependencies?: string[] },
  allFeatures?: RuntimeCADFeature[]
): string | undefined {
  const feat = feature as any;
  let attachedParentId = feat.attachedFaceRef?.parentFeatureId || feat.plane?.attachedFaceRef?.parentFeatureId;

  if (!allFeatures || !Array.isArray(allFeatures) || allFeatures.length === 0) {
    if (attachedParentId === 'main-body' || (typeof attachedParentId === 'string' && attachedParentId.startsWith('solid-'))) {
      return undefined;
    }
    return attachedParentId;
  }

  const featureIds = new Set(allFeatures.map((f) => f.id));
  const isValid =
    attachedParentId &&
    featureIds.has(attachedParentId) &&
    attachedParentId !== 'main-body' &&
    !attachedParentId.startsWith('solid-');

  if (!isValid && (feat.attachedFaceRef || feat.plane?.attachedFaceRef)) {
    // 自動修復回退：在當前草圖位置之前尋找最近上游實體特徵
    const currentIdx = allFeatures.findIndex((f) => f.id === (feature as any).id);
    const searchLimit = currentIdx >= 0 ? currentIdx : allFeatures.length;
    for (let i = searchLimit - 1; i >= 0; i--) {
      if (isBodyModifyingFeature(allFeatures[i])) {
        attachedParentId = allFeatures[i].id;
        break;
      }
    }
  }

  return attachedParentId;
}

/**
 * 取得特徵直接相依的父特徵 ID 清單 (包含顯式 dependencies 及各特徵專屬之父級幾何/草圖/表面引用)
 */
export function getDirectDependencies(
  feature: RuntimeCADFeature | { dependencies?: string[] },
  allFeatures?: RuntimeCADFeature[]
): string[] {
  if (!feature) return [];
  const deps = new Set<string>();

  const feat = feature as any;
  const attachedParentId = resolveAttachedParentFeatureId(feature, allFeatures);

  if (feature.dependencies && Array.isArray(feature.dependencies)) {
    for (const d of feature.dependencies) {
      if (d) {
        if (d === 'main-body' || d.startsWith('solid-')) {
          if (attachedParentId) deps.add(attachedParentId);
        } else {
          deps.add(d);
        }
      }
    }
  }

  // 表面草圖關聯父特徵
  if (attachedParentId) {
    deps.add(attachedParentId);
  }
  // 基準面參照特徵
  if (feat.planeFeatureId) {
    deps.add(feat.planeFeatureId);
  }
  if (feat.referencePlaneId) {
    deps.add(feat.referencePlaneId);
  }
  if (feat.referenceFeatureId) {
    deps.add(feat.referenceFeatureId);
  }
  // 實體長料 / 除料所依賴之草圖
  if (feat.sketchId) {
    deps.add(feat.sketchId);
  }
  if (Array.isArray(feat.sketchIds)) {
    for (const sid of feat.sketchIds) {
      if (sid) deps.add(sid);
    }
  }
  if (feat.profileSketchId) {
    deps.add(feat.profileSketchId);
  }
  if (feat.pathSketchId) {
    deps.add(feat.pathSketchId);
  }
  // 鏡射 / 陣列相依
  if (feat.mirrorPlaneFeatureId) {
    deps.add(feat.mirrorPlaneFeatureId);
  }
  if (Array.isArray(feat.targetFeatureIds)) {
    for (const tid of feat.targetFeatureIds) {
      if (tid) deps.add(tid);
    }
  }

  return Array.from(deps);
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
    const deps = getDirectDependencies(f, features);
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
 * 檢查所有特徵的 dependencies 是否存在於當前的特徵清單中，回傳孤兒依賴映射。
 * 【純函式規範】嚴禁在驗證函式中原地修改傳入的特徵物件 (保持不可變性，防止 Zustand 被凍結物件拋出唯讀錯誤)。
 */
export function validateFeatureDependencies(features: RuntimeCADFeature[]): Map<string, string[]> {
  const featureIds = new Set(features.map((f) => f.id));
  const brokenMap = new Map<string, string[]>();

  for (const f of features) {
    const missing: string[] = [];
    // 自動推導表面草圖父特徵 ID (若是 'main-body' 或懸空，自動回退到最近上游實體特徵)
    const attachedParentId = resolveAttachedParentFeatureId(f, features);

    // 局部計算有效依賴清單（effectiveDeps），嚴禁原地修改 f.dependencies
    const effectiveDeps = (f.dependencies || []).map((dep) => {
      if (dep === 'main-body' || (typeof dep === 'string' && dep.startsWith('solid-'))) {
        // 自動推導合法父特徵 ID，僅供本地驗證，不直接寫回唯讀的 f 物件
        return attachedParentId || resolveAttachedParentFeatureId(f, features) || dep;
      }
      return dep;
    });

    const directDeps = getDirectDependencies(f, features);
    const combinedDeps = new Set<string>([...effectiveDeps, ...directDeps]);

    for (const depId of combinedDeps) {
      if (depId === 'main-body' || (typeof depId === 'string' && depId.startsWith('solid-'))) {
        continue;
      }
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
 * 判斷特徵是否為讀取/修改 3D Solid Body (B-Rep 母體) 的實體特徵。
 * 基準面 (DATUM_PLANE) 與 2D 草圖 (SKETCH) 屬於幾何/參考圖元，不是 Body-modifying Feature。
 */
export function isBodyModifyingFeature(
  feature: RuntimeCADFeature | CADFeature | { type: string } | null | undefined
): boolean {
  if (!feature || !feature.type) return false;
  switch (feature.type) {
    case 'EXTRUDE':
    case 'CUT_EXTRUDE':
    case 'REVOLVE':
    case 'REVOLVE_CUT':
    case 'FILLET_3D':
    case 'CHAMFER_3D':
    case 'SHELL_3D':
    case 'LINEAR_PATTERN':
    case 'CIRCULAR_PATTERN':
    case 'MIRROR_3D':
    case 'SWEEP':
    case 'LOFT':
      return true;
    case 'SKETCH':
    case 'DATUM_PLANE':
    default:
      return false;
  }
}

/**
 * 【P3 架構升級】Dual-Track Dirty Propagation (顯式 DAG 相依 + 隱式 3D Body 實體歷程相依)
 * 
 * 1. Explicit Dependency Track:
 *    透過 feature.dependencies[] 沿著 DAG 向下游子特徵遞迴傳播 isDirty。
 * 2. Implicit Body History Track:
 *    在 Parametric CAD (Single-Body 歷程) 中，任何 3D Body-modifying Feature (如 Cut, Extrude)
 *    一旦變更，將使該歷史索引之後所有讀取/修改該實體的後續 3D 特徵 (如 Fillet, Chamfer, Shell) 的實體狀態失效。
 *    因此後續所有 Body-modifying Features 亦必須自動被標記為 isDirty。
 * 3. 混合交互傳播：
 *    受隱式實體歷程影響變髒的 3D 特徵，其下游顯式相依特徵 (例如依賴於倒角後面的後續草圖/參考) 亦會同步被標記為髒。
 */
export function markDownstreamDirty(
  features: RuntimeCADFeature[],
  modifiedFeatureId: string
): RuntimeCADFeature[] {
  if (!features || !Array.isArray(features) || features.length === 0) {
    return [];
  }

  // 1. 建立快速查找表與 Explicit 相鄰表 (Parent -> Children)
  const idToIndex = new Map<string, number>();
  const idToFeature = new Map<string, RuntimeCADFeature>();
  const childrenMap = new Map<string, string[]>();

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    idToIndex.set(f.id, i);
    idToFeature.set(f.id, f);
  }

  for (const f of features) {
    const deps = getDirectDependencies(f, features);
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
  const queue: string[] = [];

  const markDirty = (id: string) => {
    if (!affectedIds.has(id)) {
      affectedIds.add(id);
      queue.push(id);
    }
  };

  // 種子節點 1: modifiedFeatureId (若傳入且存在於特徵清單中)
  if (modifiedFeatureId && idToFeature.has(modifiedFeatureId)) {
    markDirty(modifiedFeatureId);
  }

  // 種子節點 2: features 中原本已被標記為 isDirty 的特徵 (例如 updateFeature 或 broken dependency)
  for (const f of features) {
    if (f.isDirty) {
      markDirty(f.id);
    }
  }

  // 2. 雙軌傳播演算法 (O(N + E))
  let earliestBodyIndex = Infinity;
  let scannedFromIndex = Infinity;

  while (queue.length > 0) {
    const currId = queue.shift()!;
    const currFeat = idToFeature.get(currId);
    const currIdx = idToIndex.get(currId);

    // 軌道 A: 顯式相依傳播 (Parent -> Children)
    const children = childrenMap.get(currId) || [];
    for (const childId of children) {
      markDirty(childId);
    }

    // 若此髒特徵會修改/產出實體，記錄其在歷史順序中的最早位置
    if (currFeat && isBodyModifyingFeature(currFeat) && currIdx !== undefined) {
      if (currIdx < earliestBodyIndex) {
        earliestBodyIndex = currIdx;
      }
    }

    // 軌道 B: 隱式實體歷程傳播 (Single-Body Cumulative Solid Invalidation)
    // 若發現了更早的受波及實體特徵，將其歷史後續所有實體修改特徵以及附著於實體表面的草圖全部標記為髒
    if (earliestBodyIndex < scannedFromIndex) {
      const scanStart = earliestBodyIndex + 1;
      const scanEnd = Math.min(scannedFromIndex, features.length);
      scannedFromIndex = earliestBodyIndex;
      for (let i = scanStart; i < scanEnd; i++) {
        const nextFeat = features[i];
        if (isBodyModifyingFeature(nextFeat)) {
          markDirty(nextFeat.id);
        } else if (
          nextFeat.type === 'SKETCH' &&
          Boolean((nextFeat as any).attachedFaceRef || (nextFeat as any).plane?.attachedFaceRef)
        ) {
          markDirty(nextFeat.id);
        }
      }
    }
  }

  // 3. 回傳新狀態陣列，保證純函數與不可變性
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
    // 草圖本身不直接產生獨立 Kernel 3D Solid 快取，若無 dirty 或 broken 視為乾淨以避免非預期整樹失效
    const isCached = feat.type === 'SKETCH' ? true : cachedFeatureIds.includes(feat.id);
    const isBroken = brokenDependencies.has(feat.id);
    
    if (feat.isDirty || !isCached || isBroken) {
      firstDirtyIdx = i;
      break;
    }
  }

  let dirtyFromHistoryIndex = -1;
  let isPureRollback = false;
  let reusableFeatureIds: string[] = [];
  let dirtyFeatures: RuntimeCADFeature[] = [];

  if (firstDirtyIdx === -1) {
    // 全數乾淨：純粹是把回退棒往上拉
    dirtyFromHistoryIndex = -1;
    isPureRollback = true;
    reusableFeatureIds = evalSequence.map((f) => f.id);
    dirtyFeatures = [];
  } else {
    // 增量重算：從第一顆髒掉的特徵開始，後續「全部」都要重新 Evaluate
    const firstDirtyFeat = evalSequence[firstDirtyIdx];
    // Architecture Contract: History Index 代表 CADDocument.featureTree[] 中的絕對索引
    dirtyFromHistoryIndex = features.findIndex((f) => f.id === firstDirtyFeat.id);
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
    dirtyFromHistoryIndex,
    dirtyFromIndex: dirtyFromHistoryIndex,
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