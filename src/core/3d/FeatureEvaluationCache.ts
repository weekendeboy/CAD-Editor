import type {
  FeatureEvaluationResult,
  KernelDiagnostic,
  MeshResult,
} from './SolidEngine.types';

/**
 * ============================================================================
 * Architecture Contract v1: Feature Evaluation & Replay Semantics
 * ============================================================================
 * 
 * 系統明確區分三層語意 (Three Semantic Layers):
 * 
 * 1. Layer A — Feature Definition (特徵定義)
 *    例如 CADFeature (ExtrudeFeature, Fillet3DFeature...)
 *    描述：使用者建立了什麼特徵、其參數、草圖與相依幾何。
 * 
 * 2. Layer B — Feature Evaluation Result (特徵評估結果)
 *    例如 FeatureEvaluationResult
 *    描述：該特徵經 Kernel 運算後的獨立產物與評估診斷。
 *    - 唯一穩定索引鍵為 Feature ID (featureId)。
 *    - 若為生成型特徵 (Extrude, Revolve, Sweep, Loft)，可持有其自身生成的獨立 toolShape。
 *    - 若為修飾型特徵 (Fillet, Chamfer, Shell)，toolShape 保持 undefined。
 *    - 嚴禁將整顆零件的累計實體 (Current Solid) 視為特徵自身的 toolShape！
 * 
 * 3. Layer C — Current Solid (當前累積實體狀態)
 *    描述：按照歷史回放順序執行至當前步驟後，整顆零件當下的累計 B-Rep 實體 (累積狀態)。
 *    - Current Solid 屬於歷史重放過程中的狀態，不代表任何單一特徵的 identity。
 *    - Replay 完成後，currentSolid 是整顆零件的最終幾何，不能推論為某單一特徵的結果。
 * ============================================================================
 */

/**
 * 歷史回放實體快照 (History Replay Snapshot)
 * 專門用於增量重算與回退 (Rollback / Incremental Replay) 的性能優化。
 * 保存的是「執行至該特徵為止，整顆零件累計的 B-Rep 實體 (cumulativeBody) 與網格 (cumulativeMesh)」。
 * 與單一特徵評估結果 (FeatureEvaluationResult) 在語意與型別上完全分離。
 */
export interface HistoryReplaySnapshot<TShape = any> {
  featureId: string;
  stepIndex: number;
  /** 該步驟完成後，整顆零件當下的累計 B-Rep 實體 (Current Solid 快照) */
  cumulativeBody: TShape;
  /** 累計實體的離散化網格 */
  cumulativeMesh: MeshResult;
  /** 該特徵的評估結果 */
  featureResult: FeatureEvaluationResult;
}

/**
 * 特徵快取項目 (Feature Cache Entry)
 * 代表特徵自身的評估產物，非整顆零件的累計實體。
 */
export interface FeatureCacheEntry<TShape = any> {
  featureId: string;
  /**
   * 該特徵自身獨立產生的幾何工具體 (例如 Extrude/Revolve 的 standalone tool shape)。
   * 修飾型特徵 (Fillet/Chamfer/Shell) 無獨立 toolShape，保持 undefined。
   */
  toolShape?: TShape;
  /** 特徵評估結果中繼資訊 */
  result: FeatureEvaluationResult;
  /** 評估時間戳記 */
  evaluatedAt?: number;
}

/**
 * 特徵評估結果快取管理器 (Feature Evaluation Cache Manager)
 * 儲存各特徵獨立的評估產物（例如 Extrude 生成的 Tool Shape）。
 * 嚴禁將累計的 currentSolid 當作特徵的 toolShape 存入！
 */
export class FeatureEvaluationCache<TShape = any> {
  private entriesMap = new Map<string, FeatureCacheEntry<TShape>>();

  /**
   * 檢查是否存在該特徵的評估快取
   */
  public has(featureId: string): boolean {
    if (!featureId) return false;
    return this.entriesMap.has(featureId);
  }

  /**
   * 取得指定特徵的評估快取項目
   */
  public get(featureId: string): FeatureCacheEntry<TShape> | undefined {
    if (!featureId) return undefined;
    return this.entriesMap.get(featureId);
  }

  /**
   * 取得特徵自身產出的 Tool Shape (若有)
   */
  public getToolShape(featureId: string): TShape | undefined {
    if (!featureId) return undefined;
    return this.entriesMap.get(featureId)?.toolShape;
  }

  /**
   * 檢查特徵是否具有獨立的 Tool Shape
   */
  public hasToolShape(featureId: string): boolean {
    if (!featureId) return false;
    const entry = this.entriesMap.get(featureId);
    return Boolean(entry && entry.toolShape !== undefined && entry.toolShape !== null);
  }

  /**
   * 取得特徵的評估結果資訊 (FeatureEvaluationResult)
   */
  public getEvaluationResult(featureId: string): FeatureEvaluationResult | undefined {
    if (!featureId) return undefined;
    return this.entriesMap.get(featureId)?.result;
  }

  /**
   * 設定特徵評估快取項目
   */
  public set(featureId: string, entry: FeatureCacheEntry<TShape>): void {
    if (!featureId) {
      throw new Error('FeatureEvaluationCache: Cannot set cache entry without valid featureId');
    }
    this.entriesMap.set(featureId, {
      ...entry,
      featureId,
      evaluatedAt: entry.evaluatedAt ?? Date.now(),
    });
  }

  /**
   * 刪除指定特徵的快取項目，並支援清理記憶體 callback
   */
  public delete(featureId: string, cleanupShape?: (shape: TShape) => void): boolean {
    if (!featureId) return false;
    const entry = this.entriesMap.get(featureId);
    if (entry && entry.toolShape && cleanupShape) {
      cleanupShape(entry.toolShape);
    }
    return this.entriesMap.delete(featureId);
  }

  /**
   * 清空所有特徵快取
   */
  public clear(cleanupShape?: (shape: TShape) => void): void {
    if (cleanupShape) {
      for (const entry of this.entriesMap.values()) {
        if (entry.toolShape) {
          cleanupShape(entry.toolShape);
        }
      }
    }
    this.entriesMap.clear();
  }

  public entries(): IterableIterator<[string, FeatureCacheEntry<TShape>]> {
    return this.entriesMap.entries();
  }

  public keys(): IterableIterator<string> {
    return this.entriesMap.keys();
  }

  public values(): IterableIterator<FeatureCacheEntry<TShape>> {
    return this.entriesMap.values();
  }

  public get size(): number {
    return this.entriesMap.size;
  }
}
