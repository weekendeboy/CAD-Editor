import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markDownstreamDirty,
  isBodyModifyingFeature,
  getRegenPlan,
  validateFeatureDependencies,
  getDirectDependencies,
} from '../FeatureRegenEngine';
import { compileFeaturePlan } from '../FeaturePipelineAdapter';
import type {
  CADFeature,
  SketchFeature,
  ExtrudeFeature,
  CutExtrudeFeature,
  Fillet3DFeature,
  Chamfer3DFeature,
  Shell3DFeature,
  DatumPlaneFeature,
} from '../../../types/cad';
import { DatumFrontPlane } from '../../../types/cad';

function makeMockSketch(id: string, name: string, deps: string[] = []): SketchFeature {
  return {
    id,
    name,
    type: 'SKETCH',
    dependencies: deps,
    suppressed: false,
    plane: DatumFrontPlane,
    entities: [],
    constraints: [],
    dimensions: [],
    profiles: [
      {
        id: `profile-${id}`,
        outerLoop: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
        segments: [],
        innerLoops: [],
        area: 100,
        isClockwise: false,
      },
    ],
  };
}

function makeMockExtrude(id: string, name: string, sketchId: string): ExtrudeFeature {
  return {
    id,
    name,
    type: 'EXTRUDE',
    dependencies: [sketchId],
    suppressed: false,
    sketchId,
    profileIds: [`profile-${sketchId}`],
    depth: 20,
    direction: 'normal',
  };
}

function makeMockCut(id: string, name: string, sketchId: string): CutExtrudeFeature {
  return {
    id,
    name,
    type: 'CUT_EXTRUDE',
    dependencies: [sketchId],
    suppressed: false,
    sketchId,
    profileIds: [`profile-${sketchId}`],
    depth: 5,
    direction: 'normal',
  };
}

function makeMockFillet(id: string, name: string): Fillet3DFeature {
  return {
    id,
    name,
    type: 'FILLET_3D',
    dependencies: [],
    suppressed: false,
    radius: 2,
    edgeSelectionMode: 'all',
  };
}

function makeMockChamfer(id: string, name: string): Chamfer3DFeature {
  return {
    id,
    name,
    type: 'CHAMFER_3D',
    dependencies: [],
    suppressed: false,
    distance: 1,
    edgeSelectionMode: 'all',
  };
}

function makeMockShell(id: string, name: string): Shell3DFeature {
  return {
    id,
    name,
    type: 'SHELL_3D',
    dependencies: [],
    suppressed: false,
    thickness: 1,
    direction: 'inside',
  };
}

function makeMockDatumPlane(id: string, name: string, refPlaneId = 'datum-front'): DatumPlaneFeature {
  return {
    id,
    name,
    type: 'DATUM_PLANE',
    dependencies: [refPlaneId],
    suppressed: false,
    planeType: 'offset',
    referencePlaneId: refPlaneId,
    offsetDistance: 10,
    plane: DatumFrontPlane,
  };
}

test('Prompt 03 - Feature Classification: isBodyModifyingFeature', () => {
  assert.equal(isBodyModifyingFeature({ type: 'EXTRUDE' } as any), true);
  assert.equal(isBodyModifyingFeature({ type: 'CUT_EXTRUDE' } as any), true);
  assert.equal(isBodyModifyingFeature({ type: 'REVOLVE' } as any), true);
  assert.equal(isBodyModifyingFeature({ type: 'REVOLVE_CUT' } as any), true);
  assert.equal(isBodyModifyingFeature({ type: 'FILLET_3D' } as any), true);
  assert.equal(isBodyModifyingFeature({ type: 'CHAMFER_3D' } as any), true);
  assert.equal(isBodyModifyingFeature({ type: 'SHELL_3D' } as any), true);
  assert.equal(isBodyModifyingFeature({ type: 'LINEAR_PATTERN' } as any), true);
  assert.equal(isBodyModifyingFeature({ type: 'CIRCULAR_PATTERN' } as any), true);
  assert.equal(isBodyModifyingFeature({ type: 'MIRROR_3D' } as any), true);
  assert.equal(isBodyModifyingFeature({ type: 'SWEEP' } as any), true);
  assert.equal(isBodyModifyingFeature({ type: 'LOFT' } as any), true);

  // Non-body modifying features
  assert.equal(isBodyModifyingFeature({ type: 'SKETCH' } as any), false);
  assert.equal(isBodyModifyingFeature({ type: 'DATUM_PLANE' } as any), false);
  assert.equal(isBodyModifyingFeature(null), false);
  assert.equal(isBodyModifyingFeature(undefined), false);
});

test('Prompt 03 - Case A: Explicit Dependency (Sketch -> Extrude)', () => {
  const tree = [
    makeMockSketch('sk-1', 'Sketch 1'),
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'),
  ];

  const dirtyTree = markDownstreamDirty(tree, 'sk-1');
  const dirtyIds = dirtyTree.filter((f) => f.isDirty).map((f) => f.id);

  assert.deepEqual(dirtyIds, ['sk-1', 'ext-1']);
});

test('Prompt 03 - Case B: Implicit Body Dependency (Cut -> Fillet without explicit dependency)', () => {
  const tree = [
    makeMockSketch('sk-1', 'Sketch 1'),       // H0
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'), // H1
    makeMockSketch('sk-2', 'Sketch 2'),       // H2
    makeMockCut('cut-1', 'Cut 1', 'sk-2'),    // H3
    makeMockFillet('fillet-1', 'Fillet 1'),   // H4 (dependencies: [])
  ];

  // 修改 Cut 1
  const dirtyTree = markDownstreamDirty(tree, 'cut-1');
  const dirtyIds = dirtyTree.filter((f) => f.isDirty).map((f) => f.id);

  // Fillet 即使 dependencies 沒有直接列出 Cut 1，因屬於同一個 Single-Body 歷史，仍必須變髒
  assert.equal(dirtyTree.find((f) => f.id === 'cut-1')?.isDirty, true);
  assert.equal(dirtyTree.find((f) => f.id === 'fillet-1')?.isDirty, true);

  // 前序特徵與未受波及的 Sketch 必須維持乾淨
  assert.equal(dirtyTree.find((f) => f.id === 'sk-1')?.isDirty, undefined);
  assert.equal(dirtyTree.find((f) => f.id === 'ext-1')?.isDirty, undefined);
  assert.equal(dirtyTree.find((f) => f.id === 'sk-2')?.isDirty, undefined);
  assert.deepEqual(dirtyIds, ['cut-1', 'fillet-1']);
});

test('Prompt 03 - Case C: 多個後續實體特徵 (Cut -> Fillet, Chamfer, Shell)', () => {
  const tree = [
    makeMockSketch('sk-1', 'Sketch 1'),       // H0
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'), // H1
    makeMockSketch('sk-2', 'Sketch 2'),       // H2
    makeMockCut('cut-1', 'Cut 1', 'sk-2'),    // H3
    makeMockFillet('fillet-1', 'Fillet 1'),   // H4
    makeMockChamfer('chamfer-1', 'Chamfer 1'), // H5
    makeMockShell('shell-1', 'Shell 1'),      // H6
  ];

  // 修改 Cut 1
  const dirtyTree = markDownstreamDirty(tree, 'cut-1');
  const dirtyIds = dirtyTree.filter((f) => f.isDirty).map((f) => f.id);

  // Cut 及後續作用於同一 Body 的 Fillet, Chamfer, Shell 都必須變髒
  assert.deepEqual(dirtyIds, ['cut-1', 'fillet-1', 'chamfer-1', 'shell-1']);
  assert.equal(dirtyTree.find((f) => f.id === 'ext-1')?.isDirty, undefined);
  assert.equal(dirtyTree.find((f) => f.id === 'sk-2')?.isDirty, undefined);
});

test('Prompt 03 - Case D: 後面只有 Sketch (修改 Extrude 不得錯誤將後續無關 Sketch 標記為髒)', () => {
  const tree = [
    makeMockSketch('sk-1', 'Sketch 1'),
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'),
    makeMockSketch('sk-2', 'Sketch 2'), // 無關的後續草圖
  ];

  // 修改 Extrude 1
  const dirtyTree = markDownstreamDirty(tree, 'ext-1');
  const dirtyIds = dirtyTree.filter((f) => f.isDirty).map((f) => f.id);

  assert.equal(dirtyTree.find((f) => f.id === 'ext-1')?.isDirty, true);
  // sk-2 是草圖而非實體修改特徵，且不依賴 ext-1，不得為髒
  assert.equal(dirtyTree.find((f) => f.id === 'sk-2')?.isDirty, undefined);
  assert.deepEqual(dirtyIds, ['ext-1']);
});

test('Prompt 03 - Case E: Datum Plane 與混合相依', () => {
  const tree = [
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-0'),        // H0
    makeMockDatumPlane('plane-1', 'Datum Plane 1'),        // H1
    makeMockSketch('sk-2', 'Sketch 2', ['plane-1']),       // H2 (依賴 plane-1)
    makeMockCut('cut-1', 'Cut 1', 'sk-2'),                 // H3 (依賴 sk-2，且修改 body)
  ];

  // 情境 E1: 修改 Extrude 1 (H0)
  // ext-1 (H0) 變更會使本體改變，後續修改該本體的 cut-1 (H3) 必須變髒；
  // 但 plane-1 (H1) 與 sk-2 (H2) 並非實體特徵，且未依賴 ext-1，必須保持乾淨！
  const dirtyTreeExt = markDownstreamDirty(tree, 'ext-1');
  assert.equal(dirtyTreeExt.find((f) => f.id === 'ext-1')?.isDirty, true);
  assert.equal(dirtyTreeExt.find((f) => f.id === 'plane-1')?.isDirty, undefined);
  assert.equal(dirtyTreeExt.find((f) => f.id === 'sk-2')?.isDirty, undefined);
  assert.equal(dirtyTreeExt.find((f) => f.id === 'cut-1')?.isDirty, true);

  // 情境 E2: 修改 Datum Plane 1 (H1)
  // plane-1 變更 -> 顯式相依 sk-2 變髒 -> 顯式相依 cut-1 變髒；ext-1 不受影響
  const dirtyTreePlane = markDownstreamDirty(tree, 'plane-1');
  assert.equal(dirtyTreePlane.find((f) => f.id === 'ext-1')?.isDirty, undefined);
  assert.equal(dirtyTreePlane.find((f) => f.id === 'plane-1')?.isDirty, true);
  assert.equal(dirtyTreePlane.find((f) => f.id === 'sk-2')?.isDirty, true);
  assert.equal(dirtyTreePlane.find((f) => f.id === 'cut-1')?.isDirty, true);
});

test('Prompt 03 - Case F: 被抑制 (Suppressed) 的特徵即使在 Dirty 樹中也不產生 Operation', () => {
  const cut = makeMockCut('cut-1', 'Cut 1', 'sk-2');
  cut.suppressed = true;

  const tree = [
    makeMockSketch('sk-1', 'Sketch 1'),
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'),
    makeMockSketch('sk-2', 'Sketch 2'),
    cut,
    makeMockFillet('fillet-1', 'Fillet 1'),
  ];

  // 修改 Extrude 1
  const dirtyTree = markDownstreamDirty(tree, 'ext-1');

  // 編譯管線
  const plan = compileFeaturePlan(dirtyTree, dirtyTree.length);

  // cut-1 被抑制，不得產生 Operation
  const opFeatureIds = plan.operations.map((op) => op.featureId);
  assert.deepEqual(opFeatureIds, ['ext-1', 'fillet-1']);
  assert.equal(plan.operations.some((op) => op.featureId === 'cut-1'), false);
});

test('Prompt 03 - Case G: 中間特徵修改完整管線驗證 (Cut 變更推導出精準 dirtyOpIndex)', () => {
  const tree = [
    makeMockSketch('sk-1', 'Sketch 1'),       // H0 -> op: null
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'), // H1 -> O0
    makeMockSketch('sk-2', 'Sketch 2'),       // H2 -> op: null
    makeMockCut('cut-1', 'Cut 1', 'sk-2'),    // H3 -> O1
    makeMockFillet('fillet-1', 'Fillet 1'),   // H4 -> O2
    makeMockChamfer('chamfer-1', 'Chamfer 1'), // H5 -> O3
  ];

  // 1. 修改 Cut 1
  const dirtyTree = markDownstreamDirty(tree, 'cut-1');
  assert.equal(dirtyTree.find((f) => f.id === 'cut-1')?.isDirty, true);
  assert.equal(dirtyTree.find((f) => f.id === 'fillet-1')?.isDirty, true);
  assert.equal(dirtyTree.find((f) => f.id === 'chamfer-1')?.isDirty, true);

  // 2. FeatureRegenEngine 計算重生成計畫
  const cachedIds = ['sk-1', 'ext-1', 'sk-2'];
  const regenPlan = getRegenPlan(dirtyTree, dirtyTree.length, cachedIds);

  // 首個 dirty 特徵是 cut-1，在 featureTree 的 History Index 是 3
  assert.equal(regenPlan.dirtyFromHistoryIndex, 3);

  // 3. FeaturePipelineAdapter 編譯計畫
  const compiled = compileFeaturePlan(
    dirtyTree,
    dirtyTree.length,
    {},
    regenPlan.dirtyFromHistoryIndex
  );

  // H3 (cut-1) 對應的 OCC Operation Index 是 1
  // Worker 必須收到 dirtyOpIndex = 1，重用 O0 (ext-1)，重算 O1 (cut-1), O2 (fillet-1), O3 (chamfer-1)
  assert.equal(compiled.dirtyOpIndex, 1);
  assert.equal(compiled.operations.length, 4);
  assert.equal(compiled.operations[0].featureId, 'ext-1');
  assert.equal(compiled.operations[1].featureId, 'cut-1');
  assert.equal(compiled.operations[2].featureId, 'fillet-1');
  assert.equal(compiled.operations[3].featureId, 'chamfer-1');
  assert.deepEqual(compiled.historyToOpIndex, [null, 0, null, 1, 2, 3]);
});

test('Prompt 03 - Feature Deletion: 刪除實體特徵應使後續實體特徵標記為髒', () => {
  const tree = [
    makeMockSketch('sk-1', 'Sketch 1'),       // 0
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'), // 1
    makeMockSketch('sk-2', 'Sketch 2'),       // 2
    makeMockCut('cut-1', 'Cut 1', 'sk-2'),    // 3
    makeMockFillet('fillet-1', 'Fillet 1'),   // 4
  ];

  // 模擬刪除 cut-1 (index 3)
  const removedFeature = tree[3];
  const filtered = tree.filter((f) => f.id !== 'cut-1');
  
  let candidateTree = filtered;
  if (isBodyModifyingFeature(removedFeature)) {
    candidateTree = candidateTree.map((f, idx) => {
      if (idx >= 3 && isBodyModifyingFeature(f)) {
        return { ...f, isDirty: true };
      }
      return f;
    });
  }
  const dirtyTree = markDownstreamDirty(candidateTree, '');

  assert.equal(dirtyTree.find((f) => f.id === 'fillet-1')?.isDirty, true);
  assert.equal(dirtyTree.find((f) => f.id === 'ext-1')?.isDirty, undefined);
  assert.equal(dirtyTree.find((f) => f.id === 'sk-2')?.isDirty, undefined);
});

test('Prompt 03 - Suppression Toggle: 切換抑制實體特徵應使後續實體特徵標記為髒', () => {
  const tree = [
    makeMockSketch('sk-1', 'Sketch 1'),
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'),
    makeMockCut('cut-1', 'Cut 1', 'sk-1'),
    makeMockFillet('fillet-1', 'Fillet 1'),
  ];

  // 模擬 toggle cut-1 的 suppressed 狀態 (從 false -> true)
  const toggledTree = tree.map((f) =>
    f.id === 'cut-1' ? { ...f, suppressed: true, isDirty: true } : f
  );
  const dirtyTree = markDownstreamDirty(toggledTree, 'cut-1');

  assert.equal(dirtyTree.find((f) => f.id === 'cut-1')?.isDirty, true);
  assert.equal(dirtyTree.find((f) => f.id === 'fillet-1')?.isDirty, true);
  assert.equal(dirtyTree.find((f) => f.id === 'ext-1')?.isDirty, undefined);
});

test('Prompt 03 - Surface Sketch: 懸空 main-body 自動修復為最近上游實體特徵並啟動 DAG 傳播', () => {
  const tree = [
    makeMockSketch('sk-1', 'Base Sketch'),
    makeMockExtrude('ext-1', 'Base Box', 'sk-1'),
    {
      id: 'sk-2',
      name: 'Top Surface Sketch',
      type: 'SKETCH',
      dependencies: ['main-body'],
      attachedFaceRef: { parentFeatureId: 'main-body', faceIndex: 5 },
      suppressed: false,
    } as any,
    makeMockExtrude('ext-2', 'Top Cylinder', 'sk-2'),
  ];

  // 1. 驗證 validateFeatureDependencies 自動補正且無 orphan 錯誤，且保持純函式不就地修改唯讀物件
  const brokenMap = validateFeatureDependencies(tree);
  assert.equal(brokenMap.size, 0);

  // 2. 驗證 getDirectDependencies 返回正確的實體特徵 ID
  const deps = getDirectDependencies(tree[2], tree);
  assert.deepEqual(deps, ['ext-1']);

  // 3. 驗證修改 Base Box (ext-1) 後，草圖 (sk-2) 與頂面圓柱 (ext-2) 皆被標記為髒
  const dirtyTree = markDownstreamDirty(tree, 'ext-1');
  const dirtyIds = dirtyTree.filter((f) => f.isDirty).map((f) => f.id);
  assert.deepEqual(dirtyIds, ['ext-1', 'sk-2', 'ext-2']);
});

test('Prompt 03 - Immutability: 凍結唯讀特徵物件 (Frozen Object) 執行 validateFeatureDependencies 與 getRegenPlan 不得拋錯', () => {
  const frozenSketch: any = Object.freeze({
    id: 'sk-frozen',
    name: 'Frozen Surface Sketch',
    type: 'SKETCH',
    dependencies: Object.freeze(['main-body']),
    attachedFaceRef: Object.freeze({ parentFeatureId: 'main-body', faceIndex: 0 }),
    suppressed: false,
    plane: DatumFrontPlane,
  });

  const frozenTree: any = [
    Object.freeze(makeMockSketch('sk-1', 'Base Sketch')),
    Object.freeze(makeMockExtrude('ext-1', 'Base Box', 'sk-1')),
    frozenSketch,
  ];

  // 必須保證純函式運行，絕對不能拋出 TypeError: Cannot assign to read only property
  assert.doesNotThrow(() => {
    const broken = validateFeatureDependencies(frozenTree);
    assert.equal(broken.size, 0);
  });

  assert.doesNotThrow(() => {
    const plan = getRegenPlan(frozenTree, frozenTree.length, ['ext-1']);
    assert.equal(plan.brokenDependencies.size, 0);
    assert.equal(plan.hasCycle, false);
  });
});

