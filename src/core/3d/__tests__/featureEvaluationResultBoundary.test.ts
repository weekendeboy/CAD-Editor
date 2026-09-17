import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FeatureEvaluationCache,
  type FeatureCacheEntry,
  type HistoryReplaySnapshot,
} from '../FeatureEvaluationCache';
import type { FeatureEvaluationResult } from '../SolidEngine.types';

/**
 * 模擬 TopoDS_Shape 類型的 B-Rep 實體物件
 */
interface MockTopoShape {
  id: string;
  type: string;
  IsNull: () => boolean;
}

function makeMockShape(id: string, type: string): MockTopoShape {
  return {
    id,
    type,
    IsNull: () => false,
  };
}

test('Prompt 04 - Case A: Feature Result 與 Current Solid 語意分離', () => {
  // 建立快取
  const featureEvaluationCache = new FeatureEvaluationCache<MockTopoShape>();

  // 1. 執行 Extrude1
  const toolShapeExtrude1 = makeMockShape('shape-extrude-1', 'EXTRUDE_TOOL');
  let currentSolid: MockTopoShape = makeMockShape('solid-after-extrude-1', 'CUMULATIVE_SOLID');

  const extrude1Result: FeatureEvaluationResult = {
    featureId: 'extrude-1',
    success: true,
    createdBodyIds: ['main-body'],
    modifiedBodyIds: [],
    diagnostics: [],
    error: null,
    executionTimeMs: 12,
    toolShape: 'EXTRUDE',
    resultBody: 'main-body',
  };

  featureEvaluationCache.set('extrude-1', {
    featureId: 'extrude-1',
    toolShape: toolShapeExtrude1,
    result: extrude1Result,
  });

  // 2. 執行 Cut1: 產生獨立的 cut tool shape，並將 currentSolid 更新為 Solid2 (布林相減後)
  const toolShapeCut1 = makeMockShape('shape-cut-1', 'CUT_TOOL');
  currentSolid = makeMockShape('solid-after-cut-1', 'CUMULATIVE_SOLID');

  const cut1Result: FeatureEvaluationResult = {
    featureId: 'cut-1',
    success: true,
    createdBodyIds: [],
    modifiedBodyIds: ['main-body'],
    diagnostics: [],
    error: null,
    executionTimeMs: 18,
    toolShape: 'CUT_EXTRUDE',
    resultBody: 'main-body',
  };

  featureEvaluationCache.set('cut-1', {
    featureId: 'cut-1',
    toolShape: toolShapeCut1,
    result: cut1Result,
  });

  // 3. 執行 Fillet1: 修飾型特徵，無獨立 toolShape，currentSolid 變成 Solid3
  currentSolid = makeMockShape('solid-after-fillet-1', 'CUMULATIVE_SOLID');
  const fillet1Result: FeatureEvaluationResult = {
    featureId: 'fillet-1',
    success: true,
    createdBodyIds: [],
    modifiedBodyIds: ['main-body'],
    diagnostics: [],
    error: null,
    executionTimeMs: 8,
    toolShape: undefined,
    resultBody: 'main-body',
  };

  featureEvaluationCache.set('fillet-1', {
    featureId: 'fillet-1',
    toolShape: undefined,
    result: fillet1Result,
  });

  // 【斷言 1】Extrude1 的 toolShape 不等於 Solid2 或 Solid3 (不等於任何時期的 currentSolid)
  const cachedExtrude1 = featureEvaluationCache.get('extrude-1');
  assert.ok(cachedExtrude1 !== undefined);
  assert.equal(cachedExtrude1.toolShape?.id, 'shape-extrude-1');
  assert.notEqual(cachedExtrude1.toolShape, currentSolid);
  assert.equal(cachedExtrude1.result.featureId, 'extrude-1');
  assert.equal(cachedExtrude1.result.toolShape, 'EXTRUDE');

  // 【斷言 2】Cut1 的 toolShape 不等於 currentSolid
  const cachedCut1 = featureEvaluationCache.get('cut-1');
  assert.ok(cachedCut1 !== undefined);
  assert.equal(cachedCut1.toolShape?.id, 'shape-cut-1');
  assert.notEqual(cachedCut1.toolShape, currentSolid);
  assert.equal(cachedCut1.result.featureId, 'cut-1');

  // 【斷言 3】Fillet1 為修飾特徵，其 toolShape 為 undefined，不可將 currentSolid 當成 toolShape
  const cachedFillet1 = featureEvaluationCache.get('fillet-1');
  assert.ok(cachedFillet1 !== undefined);
  assert.equal(cachedFillet1.toolShape, undefined);
  assert.notEqual(cachedFillet1.toolShape, currentSolid);
  assert.equal(featureEvaluationCache.hasToolShape('fillet-1'), false);

  // 【斷言 4】currentSolid 是當前整個累計零件實體 (Solid3)，絕不代表任何單一 feature
  assert.equal(currentSolid.id, 'solid-after-fillet-1');
});

test('Prompt 04 - Case B: Cache 不應因後續 Feature 執行而錯誤改變語意', () => {
  const cache = new FeatureEvaluationCache<MockTopoShape>();

  // Feature 1
  const toolShape1 = makeMockShape('tool-1', 'TOOL');
  cache.set('feat-1', {
    featureId: 'feat-1',
    toolShape: toolShape1,
    result: {
      featureId: 'feat-1',
      success: true,
      createdBodyIds: ['main-body'],
      modifiedBodyIds: [],
      diagnostics: [],
      error: null,
      executionTimeMs: 10,
    },
  });

  // 後續執行 Feature 2, 3, 4 ... N
  for (let i = 2; i <= 10; i++) {
    const fid = `feat-${i}`;
    const cumulativeCurrentSolid = makeMockShape(`current-solid-step-${i}`, 'CUMULATIVE');
    cache.set(fid, {
      featureId: fid,
      toolShape: makeMockShape(`tool-${i}`, 'TOOL'),
      result: {
        featureId: fid,
        success: true,
        createdBodyIds: [],
        modifiedBodyIds: ['main-body'],
        diagnostics: [],
        error: null,
        executionTimeMs: 5,
      },
    });
  }

  // 驗證第 1 個 feature 的 cache entry 仍完全代表 feat-1 自身，未受後續 feature 污染
  const entry1 = cache.get('feat-1');
  assert.ok(entry1);
  assert.equal(entry1.featureId, 'feat-1');
  assert.equal(entry1.toolShape?.id, 'tool-1');
  assert.notEqual(entry1.toolShape?.id, 'current-solid-step-10');
  assert.equal(entry1.result.executionTimeMs, 10);
});

test('Prompt 04 - Case C: Feature ID identity (索引鍵必須為 Feature ID)', () => {
  const cache = new FeatureEvaluationCache<MockTopoShape>();

  const featureId = 'stable-uuid-extrude-123';
  const historyIndex = 2; // CADDocument.featureTree 中的位置
  const opIndex = 1;      // FeatureEvalOp[] 中的位置

  cache.set(featureId, {
    featureId,
    toolShape: makeMockShape('shape-1', 'EXTRUDE'),
    result: {
      featureId,
      success: true,
      createdBodyIds: ['main-body'],
      modifiedBodyIds: [],
      diagnostics: [],
      error: null,
      executionTimeMs: 15,
    },
  });

  // 必須透過 Feature ID 命中
  assert.equal(cache.has(featureId), true);
  assert.equal(cache.get(featureId)?.featureId, featureId);

  // 嚴禁以 historyIndex 或 opIndex 作為快取 key
  // @ts-expect-error 測試非字串/非 featureId 索引
  assert.equal(cache.has(historyIndex), false);
  // @ts-expect-error 測試非字串/非 featureId 索引
  assert.equal(cache.has(opIndex), false);
  assert.equal(cache.has('2'), false);
  assert.equal(cache.has('1'), false);
});

test('Prompt 04 - Case D: Cache miss 與失敗處理', () => {
  const cache = new FeatureEvaluationCache<MockTopoShape>();

  // 查詢不存在的 Feature ID
  assert.equal(cache.has('non-existent-id'), false);
  assert.equal(cache.get('non-existent-id'), undefined);
  assert.equal(cache.getToolShape('non-existent-id'), undefined);
  assert.equal(cache.hasToolShape('non-existent-id'), false);
  assert.equal(cache.getEvaluationResult('non-existent-id'), undefined);

  // 評估失敗的 Feature
  const failedId = 'failing-extrude-999';
  const failedResult: FeatureEvaluationResult = {
    featureId: failedId,
    success: false,
    createdBodyIds: [],
    modifiedBodyIds: [],
    diagnostics: [{ level: 'error', message: 'Profile self-intersecting', featureId: failedId }],
    error: 'Profile self-intersecting',
    executionTimeMs: 4,
  };

  cache.set(failedId, {
    featureId: failedId,
    toolShape: undefined, // 失敗不產生 toolShape
    result: failedResult,
  });

  assert.equal(cache.has(failedId), true);
  const entry = cache.get(failedId);
  assert.ok(entry);
  assert.equal(entry.result.success, false);
  assert.equal(entry.result.error, 'Profile self-intersecting');
  assert.equal(entry.toolShape, undefined);
  assert.equal(cache.hasToolShape(failedId), false);
});

test('Prompt 04 - Case E: Pattern / Mirror regression 與語意邊界', () => {
  const cache = new FeatureEvaluationCache<MockTopoShape>();

  // 建立基礎幾何
  const baseToolShape = makeMockShape('base-extrude-tool', 'EXTRUDE');
  cache.set('base-extrude-id', {
    featureId: 'base-extrude-id',
    toolShape: baseToolShape,
    result: {
      featureId: 'base-extrude-id',
      success: true,
      createdBodyIds: ['main-body'],
      modifiedBodyIds: [],
      diagnostics: [],
      error: null,
      executionTimeMs: 10,
    },
  });

  // 建立打孔特徵 (Cut)
  const holeToolShape = makeMockShape('hole-cut-tool', 'CUT');
  cache.set('hole-feature-id', {
    featureId: 'hole-feature-id',
    toolShape: holeToolShape,
    result: {
      featureId: 'hole-feature-id',
      success: true,
      createdBodyIds: [],
      modifiedBodyIds: ['main-body'],
      diagnostics: [],
      error: null,
      executionTimeMs: 15,
    },
  });

  const wholeCurrentSolid = makeMockShape('whole-body-after-cut', 'CUMULATIVE_SOLID');

  // 情境 1: Pattern 明確指定 targetFeatureIds = ['hole-feature-id']
  // 核心語意：必須取到該特徵自身產出的 toolShape，而非整顆零件的 wholeCurrentSolid
  const targetFeatureIds = ['hole-feature-id'];
  let patternSourceSolid: MockTopoShape | null = null;

  if (targetFeatureIds.length > 0) {
    const tid = targetFeatureIds[0];
    const tool = cache.getToolShape(tid);
    if (tool) {
      patternSourceSolid = tool;
    }
  }

  assert.ok(patternSourceSolid !== null);
  assert.equal(patternSourceSolid.id, 'hole-cut-tool');
  assert.notEqual(patternSourceSolid, wholeCurrentSolid);

  // 情境 2: Pattern 未指定 targetFeatureIds (或指向無獨立 toolShape 的修飾特徵)
  // 核心語意：安全 fallback 到 currentSolid (整顆零件鏡射/陣列)，並保持架構邊界清晰
  const fallbackTargetIds: string[] = [];
  let fallbackSourceSolid: MockTopoShape | null = null;

  for (const tid of fallbackTargetIds) {
    const tool = cache.getToolShape(tid);
    if (tool) fallbackSourceSolid = tool;
  }
  if (!fallbackSourceSolid) {
    fallbackSourceSolid = wholeCurrentSolid;
  }

  assert.equal(fallbackSourceSolid, wholeCurrentSolid);
  assert.equal(fallbackSourceSolid.id, 'whole-body-after-cut');
});

test('Prompt 04 - History Replay Snapshot 語意隔離驗證', () => {
  // 驗證 HistoryReplaySnapshot 與 FeatureEvaluationResult 各司其職
  const replaySnapshots = new Map<string, HistoryReplaySnapshot<MockTopoShape>>();
  const featureCache = new FeatureEvaluationCache<MockTopoShape>();

  const fid = 'feat-extrude-1';
  const cumulativeBody = makeMockShape('cum-solid-1', 'CUMULATIVE_BODY');
  const standaloneTool = makeMockShape('tool-shape-1', 'TOOL_BODY');

  const fRes: FeatureEvaluationResult = {
    featureId: fid,
    success: true,
    createdBodyIds: ['main-body'],
    modifiedBodyIds: [],
    diagnostics: [],
    error: null,
    executionTimeMs: 20,
    toolShape: 'EXTRUDE',
    resultBody: 'main-body',
  };

  // 快取特徵評估產物
  featureCache.set(fid, {
    featureId: fid,
    toolShape: standaloneTool,
    result: fRes,
  });

  // 快照歷史重放累積狀態
  replaySnapshots.set(fid, {
    featureId: fid,
    stepIndex: 0,
    cumulativeBody,
    cumulativeMesh: {
      success: true,
      vertices: new Float32Array([0, 0, 0]),
      normals: new Float32Array([0, 1, 0]),
      indices: new Uint32Array([0]),
    },
    featureResult: fRes,
  });

  // 斷言語意完全隔離
  const cachedFeature = featureCache.get(fid)!;
  const snapshot = replaySnapshots.get(fid)!;

  assert.equal(cachedFeature.toolShape?.id, 'tool-shape-1');
  assert.equal(snapshot.cumulativeBody.id, 'cum-solid-1');
  assert.notEqual(cachedFeature.toolShape, snapshot.cumulativeBody);
  assert.equal(snapshot.stepIndex, 0);
  assert.equal(snapshot.featureResult.featureId, fid);
});
