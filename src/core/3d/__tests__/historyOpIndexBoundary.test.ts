import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFeaturePlan, buildFeatureEvalOps } from '../FeaturePipelineAdapter';
import { getRegenPlan } from '../FeatureRegenEngine';
import type {
  CADFeature,
  SketchFeature,
  ExtrudeFeature,
  CutExtrudeFeature,
  Fillet3DFeature,
  DatumPlaneFeature,
} from '../../../types/cad';
import { DatumFrontPlane } from '../../../types/cad';

function makeMockSketch(id: string, name: string): SketchFeature {
  return {
    id,
    name,
    type: 'SKETCH',
    dependencies: [],
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

function makeMockDatumPlane(id: string, name: string): DatumPlaneFeature {
  return {
    id,
    name,
    type: 'DATUM_PLANE',
    dependencies: [],
    suppressed: false,
    planeType: 'offset',
    referencePlaneId: 'datum-front',
    offsetDistance: 10,
    plane: DatumFrontPlane,
  };
}

test('Case A: Sketch 在前面 -> Extrude -> Cut', () => {
  const tree: CADFeature[] = [
    makeMockSketch('sk-1', 'Sketch 1'),
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'),
    makeMockCut('cut-1', 'Cut 1', 'sk-1'),
  ];

  const plan = compileFeaturePlan(tree, tree.length);

  assert.equal(plan.operations.length, 2);
  assert.equal(plan.operations[0].featureId, 'ext-1');
  assert.equal(plan.operations[1].featureId, 'cut-1');

  // Mapping 驗證
  assert.deepEqual(plan.historyToOpIndex, [null, 0, 1]);
  assert.deepEqual(plan.featureIdToOpIndex, {
    'ext-1': 0,
    'cut-1': 1,
  });
});

test('Case B: 多個 Sketch 交錯 (Sketch1, Extrude1, Sketch2, Cut1, Sketch3, Fillet1)', () => {
  const tree: CADFeature[] = [
    makeMockSketch('sk-1', 'Sketch 1'),     // H0
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'), // H1 -> O0
    makeMockSketch('sk-2', 'Sketch 2'),     // H2
    makeMockCut('cut-1', 'Cut 1', 'sk-2'),  // H3 -> O1
    makeMockSketch('sk-3', 'Sketch 3'),     // H4
    makeMockFillet('fillet-1', 'Fillet 1'), // H5 -> O2
  ];

  const plan = compileFeaturePlan(tree, tree.length);

  assert.equal(plan.operations.length, 3);
  assert.deepEqual(plan.historyToOpIndex, [null, 0, null, 1, null, 2]);
  assert.deepEqual(plan.featureIdToOpIndex, {
    'ext-1': 0,
    'cut-1': 1,
    'fillet-1': 2,
  });
});

test('Case C: Dirty Sketch (H2 = Sketch 2 變更時，dirtyOpIndex 應精確推導為 O1，而非 2 或 null)', () => {
  const tree: CADFeature[] = [
    makeMockSketch('sk-1', 'Sketch 1'),     // H0
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'), // H1 -> O0
    makeMockSketch('sk-2', 'Sketch 2'),     // H2 (Dirty)
    makeMockCut('cut-1', 'Cut 1', 'sk-2'),  // H3 -> O1
    makeMockSketch('sk-3', 'Sketch 3'),     // H4
    makeMockFillet('fillet-1', 'Fillet 1'), // H5 -> O2
  ];

  // 傳入 dirtyFromHistoryIndex = 2 (Sketch 2)
  const plan = compileFeaturePlan(tree, tree.length, {}, 2);

  // Sketch 2 本身沒有 Operation，往後搜尋第一個有 Operation 的特徵是 Cut 1 (O1)
  assert.equal(plan.dirtyOpIndex, 1);
});

test('Case D: Dirty Operation (H3 = Cut 1 變更時，dirtyOpIndex 應為 O1 = 1)', () => {
  const tree: CADFeature[] = [
    makeMockSketch('sk-1', 'Sketch 1'),     // H0
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'), // H1 -> O0
    makeMockSketch('sk-2', 'Sketch 2'),     // H2
    makeMockCut('cut-1', 'Cut 1', 'sk-2'),  // H3 (Dirty) -> O1
    makeMockSketch('sk-3', 'Sketch 3'),     // H4
    makeMockFillet('fillet-1', 'Fillet 1'), // H5 -> O2
  ];

  // 傳入 dirtyFromHistoryIndex = 3 (Cut 1)
  const plan = compileFeaturePlan(tree, tree.length, {}, 3);

  assert.equal(plan.dirtyOpIndex, 1);
});

test('Case E: 末端只有 Sketch (H2 = Sketch 2 變更，後續無任何 3D Operation)', () => {
  const tree: CADFeature[] = [
    makeMockSketch('sk-1', 'Sketch 1'),     // H0
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'), // H1 -> O0
    makeMockSketch('sk-2', 'Sketch 2'),     // H2 (Dirty)
  ];

  // 傳入 dirtyFromHistoryIndex = 2
  const plan = compileFeaturePlan(tree, tree.length, {}, 2);

  // 後續沒有任何 3D Operation，因此 dirtyOpIndex 必須為 null，絕不可為 2！
  assert.equal(plan.dirtyOpIndex, null);
  assert.equal(plan.operations.length, 1);
});

test('Case F: Rollback 行為 (rollbackIndex 是 History Index，不能混淆為 Operation Index)', () => {
  const tree: CADFeature[] = [
    makeMockSketch('sk-1', 'Sketch 1'),     // H0
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'), // H1 -> O0
    makeMockSketch('sk-2', 'Sketch 2'),     // H2
    makeMockCut('cut-1', 'Cut 1', 'sk-2'),  // H3 -> O1
    makeMockFillet('fillet-1', 'Fillet 1'), // H4 -> O2
  ];

  // 回退棒停在 H2 (只有 H0, H1 被執行)
  const rollbackIndex = 2; // History Index
  const plan = compileFeaturePlan(tree, rollbackIndex);

  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].featureId, 'ext-1');
  assert.deepEqual(plan.historyToOpIndex, [null, 0, null, null, null]);
});

test('Case G: 基準面 Datum Plane (不會產生 OCC Operation，其 historyToOpIndex 為 null)', () => {
  const tree: CADFeature[] = [
    makeMockDatumPlane('datum-1', 'Datum 1'), // H0 -> null
    makeMockSketch('sk-1', 'Sketch 1'),       // H1 -> null
    makeMockExtrude('ext-1', 'Extrude 1', 'sk-1'), // H2 -> O0
  ];

  const plan = compileFeaturePlan(tree, tree.length);

  assert.equal(plan.operations.length, 1);
  assert.deepEqual(plan.historyToOpIndex, [null, null, 0]);
  assert.deepEqual(plan.featureIdToOpIndex, { 'ext-1': 0 });
});

test('Case H: 被抑制 (Suppressed) 的特徵不應產生 Operation', () => {
  const ext = makeMockExtrude('ext-1', 'Extrude 1', 'sk-1');
  ext.suppressed = true;

  const tree: CADFeature[] = [
    makeMockSketch('sk-1', 'Sketch 1'),
    ext,
    makeMockCut('cut-1', 'Cut 1', 'sk-1'),
  ];

  const plan = compileFeaturePlan(tree, tree.length);

  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].featureId, 'cut-1');
  assert.deepEqual(plan.historyToOpIndex, [null, null, 0]);
});

test('FeatureRegenEngine: getRegenPlan 產生的 dirtyFromHistoryIndex 是正確的 History Index', () => {
  const sk1 = makeMockSketch('sk-1', 'Sketch 1');
  const ext1 = makeMockExtrude('ext-1', 'Extrude 1', 'sk-1');
  const sk2 = makeMockSketch('sk-2', 'Sketch 2');
  sk2.isDirty = true;
  const cut1 = makeMockCut('cut-1', 'Cut 1', 'sk-2');

  const tree = [sk1, ext1, sk2, cut1];
  const regenPlan = getRegenPlan(tree, tree.length, ['sk-1', 'ext-1']);

  // 首個 dirty 的特徵是 sk-2，它在 tree 的 History Index 是 2
  assert.equal(regenPlan.dirtyFromHistoryIndex, 2);
  assert.equal(regenPlan.dirtyFromIndex, 2);

  // 編譯時將此 History Index 傳入 compileFeaturePlan
  const compiled = compileFeaturePlan(tree, tree.length, {}, regenPlan.dirtyFromHistoryIndex);
  // sk-2 後第一個 Operation 是 cut-1，其 Operation Index 是 1
  assert.equal(compiled.dirtyOpIndex, 1);
});
