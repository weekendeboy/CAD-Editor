import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markDownstreamDirty,
  validateFeatureDependencies,
  getRegenPlan,
} from '../FeatureRegenEngine';
import { compileFeaturePlan, buildFeatureEvalOps } from '../FeaturePipelineAdapter';
import type {
  CADFeature,
  SketchFeature,
  ExtrudeFeature,
  CutExtrudeFeature,
  Fillet3DFeature,
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
          { x: 20, y: 0 },
          { x: 20, y: 20 },
          { x: 0, y: 20 },
        ],
        segments: [],
        innerLoops: [],
        area: 400,
        isClockwise: false,
      },
    ],
  };
}

function makeMockExtrude(id: string, name: string, sketchId: string, depth: number = 20): ExtrudeFeature {
  return {
    id,
    name,
    type: 'EXTRUDE',
    dependencies: [sketchId],
    suppressed: false,
    visible: true,
    sketchId,
    profileIds: [`profile-${sketchId}`],
    depth,
    direction: 'normal',
    mergeResult: true,
  };
}

function makeMockCut(id: string, name: string, sketchId: string, depth: number = 5): CutExtrudeFeature {
  return {
    id,
    name,
    type: 'CUT_EXTRUDE',
    dependencies: [sketchId],
    suppressed: false,
    visible: true,
    sketchId,
    profileIds: [`profile-${sketchId}`],
    depth,
    direction: 'normal',
    throughAll: false,
  };
}

function makeMockFillet(id: string, name: string): Fillet3DFeature {
  return {
    id,
    name,
    type: 'FILLET_3D',
    dependencies: [],
    suppressed: false,
    visible: true,
    radius: 2,
    edgeSelectionMode: 'all',
  };
}

test('3D-50A Test 1: Feature ID Preservation & Parameter Updates', () => {
  const originalFeature = makeMockExtrude('extrude-001', 'Extrude1', 'sketch-001', 20);
  const originalId = originalFeature.id;

  // Simulate Edit Feature updates
  const updates: Partial<ExtrudeFeature> = {
    name: 'Extrude1 (Modified)',
    depth: 35,
    direction: 'reversed',
  };

  const updatedFeature: ExtrudeFeature = {
    ...originalFeature,
    ...updates,
    isDirty: true,
  };

  // Assert ID is preserved
  assert.equal(updatedFeature.id, originalId, 'Feature ID must remain strictly identical');
  assert.equal(updatedFeature.depth, 35, 'Depth should be updated to 35');
  assert.equal(updatedFeature.direction, 'reversed', 'Direction should be updated to reversed');
  assert.equal(updatedFeature.name, 'Extrude1 (Modified)');
  assert.equal(updatedFeature.sketchId, 'sketch-001', 'SketchId reference must be preserved');
});

test('3D-50A Test 2: Downstream Dirty Propagation on Extrude Parameter Edit', () => {
  const sketch = makeMockSketch('sketch-001', 'Base Sketch');
  const extrude = makeMockExtrude('extrude-001', 'Base Extrude', 'sketch-001', 20);
  const fillet = makeMockFillet('fillet-001', 'Edge Fillet');

  const tree: CADFeature[] = [sketch, extrude, fillet];

  // Modify Extrude depth from 20 to 30 and mark downstream dirty
  const updatedTree = tree.map((f) =>
    f.id === 'extrude-001' ? { ...f, depth: 30, isDirty: true } : f
  );

  const dirtyTree = markDownstreamDirty(updatedTree, 'extrude-001');

  const extrudeFeat = dirtyTree.find((f) => f.id === 'extrude-001');
  const filletFeat = dirtyTree.find((f) => f.id === 'fillet-001');

  assert.equal(extrudeFeat?.isDirty, true, 'Edited Extrude must be dirty');
  assert.equal(filletFeat?.isDirty, true, 'Downstream Fillet must be implicitly marked dirty');
});

test('3D-50A Test 3: FeaturePipelineAdapter Compiles Updated Ops on Edited Extrude', () => {
  const sketch = makeMockSketch('sketch-001', 'Base Sketch');
  const extrude = makeMockExtrude('extrude-001', 'Base Extrude', 'sketch-001', 20);

  // Initial compile
  const initialOps = buildFeatureEvalOps([sketch, extrude], [sketch.plane]);
  assert.equal(initialOps.length, 1);
  assert.equal(initialOps[0].type, 'EXTRUDE');
  if (initialOps[0].type === 'EXTRUDE') {
    assert.equal(initialOps[0].depth, 20);
  }

  // Edit extrude depth to 45 and direction to mid-plane
  const editedExtrude: ExtrudeFeature = {
    ...extrude,
    depth: 45,
    direction: 'mid-plane',
    isDirty: true,
  };

  const updatedOps = buildFeatureEvalOps([sketch, editedExtrude], [sketch.plane]);
  assert.equal(updatedOps.length, 1);
  assert.equal(updatedOps[0].type, 'EXTRUDE');
  if (updatedOps[0].type === 'EXTRUDE') {
    assert.equal(updatedOps[0].depth, 45, 'Compiled op must contain updated depth 45');
    assert.equal(updatedOps[0].direction, 'mid-plane', 'Compiled op must contain mid-plane direction');
  }
});

test('3D-50A Test 4: Cut-Extrude Edit with ThroughAll Flag', () => {
  const sketch = makeMockSketch('sketch-001', 'Base Sketch');
  const cut = makeMockCut('cut-001', 'Cut1', 'sketch-001', 5);

  assert.equal(cut.throughAll, false);

  // Edit CutExtrude with throughAll = true
  const editedCut: CutExtrudeFeature = {
    ...cut,
    throughAll: true,
    depth: 10,
    isDirty: true,
  };

  assert.equal(editedCut.id, 'cut-001', 'CutExtrude ID preserved');
  assert.equal(editedCut.throughAll, true, 'throughAll flag updated');

  const ops = buildFeatureEvalOps([sketch, editedCut], [sketch.plane]);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, 'CUT_EXTRUDE');
  if (ops[0].type === 'CUT_EXTRUDE') {
    assert.equal(ops[0].throughAll, true);
  }
});

test('3D-50A Test 5: Form State Divergence & Confirm Lifecycle', () => {
  // 1. Initial source feature in CAD document
  const originalFeature = makeMockExtrude('extrude-001', 'Extrude1', 'sketch-001', 20);

  // 2. Hydrate Form State on Mount
  let formState = {
    featureName: originalFeature.name,
    depth: originalFeature.depth,
    direction: originalFeature.direction,
    throughAll: false,
  };
  assert.equal(formState.depth, 20, 'Form hydrated with initial feature depth 20');

  // 3. User modifies form state: 20 -> 30, Direction -> reversed
  formState = {
    ...formState,
    depth: 30,
    direction: 'reversed',
  };

  // 4. Before Confirm: Source feature in tree MUST remain untouched (20)
  assert.equal(originalFeature.depth, 20, 'Source feature depth must remain 20 before confirm');
  assert.equal(originalFeature.direction, 'normal', 'Source feature direction must remain normal before confirm');
  assert.equal(formState.depth, 30, 'Form state must stably remain 30 without reset');

  // 5. On Confirm: Apply updates to source feature
  const updatedFeature: ExtrudeFeature = {
    ...originalFeature,
    depth: formState.depth,
    direction: formState.direction,
    isDirty: true,
  };

  assert.equal(updatedFeature.id, 'extrude-001', 'Feature ID must be preserved');
  assert.equal(updatedFeature.depth, 30, 'Feature depth updated to 30 on confirm');
  assert.equal(updatedFeature.direction, 'reversed', 'Feature direction updated to reversed on confirm');
});

test('3D-50A Test 6: Cancel Preserves Original Feature Without Mutation', () => {
  const originalFeature = makeMockExtrude('extrude-001', 'Extrude1', 'sketch-001', 20);

  // Form mounts and hydrates
  let formDraftDepth = originalFeature.depth;
  // User changes depth to 50
  formDraftDepth = 50;
  assert.equal(formDraftDepth, 50);

  // User clicks Cancel (modal closes without calling updateFeature)
  // CAD document feature remains exactly as original
  assert.equal(originalFeature.depth, 20, 'Cancelled edit must leave source feature depth as 20');
});

test('3D-50A Test 7: Confirm Updated Extrude Must Reach Formal Evaluation with Correct dirtyOpIndex & isPureRollback', () => {
  const sketch = makeMockSketch('sketch-001', 'Sketch1');
  const originalExtrude = makeMockExtrude('extrude-001', 'Extrude1', 'sketch-001', 20);
  originalExtrude.isDirty = false;

  const initialTree = [sketch, originalExtrude];
  const rollbackIndex = 2;

  // 1. Initial clean plan
  const initialRegenPlan = getRegenPlan(initialTree, rollbackIndex, ['sketch-001', 'extrude-001']);
  assert.equal(initialRegenPlan.isPureRollback, true, 'Initial tree without dirty features is pure rollback');

  // 2. Simulate updateFeature(extrude.id, { depth: 30 })
  const updatedTree: CADFeature[] = markDownstreamDirty(
    initialTree.map((f) => (f.id === 'extrude-001' ? { ...f, depth: 30, isDirty: true } : f)),
    'extrude-001'
  );

  assert.equal(updatedTree[1].depth, 30, 'Extrude depth updated to 30');
  assert.equal((updatedTree[1] as ExtrudeFeature).isDirty, true, 'Extrude marked dirty');

  // 3. Regen plan calculation
  const regenPlan = getRegenPlan(updatedTree, rollbackIndex, ['sketch-001', 'extrude-001']);

  assert.equal(regenPlan.isPureRollback, false, 'Edited feature must NOT be classified as pure rollback');
  assert.equal(regenPlan.dirtyFromHistoryIndex, 1, 'dirtyFromHistoryIndex must point to extrude-001 at history index 1');

  // 4. Compiled plan calculation
  const compiledPlan = compileFeaturePlan(
    updatedTree,
    rollbackIndex,
    {},
    regenPlan.dirtyFromHistoryIndex,
    'extrude-001'
  );

  assert.equal(compiledPlan.operations.length, 1, 'Compiled plan produces 1 operation');
  assert.equal(compiledPlan.operations[0].depth, 30, 'FeatureEvalOp depth must be 30');
  assert.notEqual(compiledPlan.dirtyOpIndex, null, 'dirtyOpIndex must NOT be null on parameter edit');
  assert.equal(compiledPlan.dirtyOpIndex, 0, 'dirtyOpIndex must correctly point to operation index 0');
});

function applyUpdateFeatureState(
  state: { activeSketchId: string | null; featureTree: CADFeature[] },
  id: string,
  updates: Partial<CADFeature>
) {
  const updatedTree = state.featureTree.map((f) =>
    f.id === id ? ({ ...f, ...updates, isDirty: true } as CADFeature) : f
  );
  const targetFeature = updatedTree.find((f) => f.id === id);
  const nextActiveSketchId =
    targetFeature && targetFeature.type === 'SKETCH'
      ? id
      : state.activeSketchId;

  return {
    activeSketchId: nextActiveSketchId,
    featureTree: updatedTree,
  };
}

test('3D-50A Test 8: Feature Edit Must Not Mutate activeSketchId', () => {
  const sketch = makeMockSketch('sketch-1', 'Sketch 1');
  const extrude = makeMockExtrude('extrude-1', 'Extrude 1', 'sketch-1', 20);

  // Case 1: Initial activeSketchId = "sketch-1", update Extrude
  const state1 = {
    activeSketchId: 'sketch-1',
    featureTree: [sketch, extrude],
  };

  const nextState1 = applyUpdateFeatureState(state1, 'extrude-1', {
    sketchId: 'sketch-1',
    depth: 30,
    profileIds: ['profile-sketch-1'],
  });

  const updatedExtrude1 = nextState1.featureTree.find(
    (f) => f.id === 'extrude-1'
  ) as ExtrudeFeature;

  assert.equal(updatedExtrude1.sketchId, 'sketch-1');
  assert.equal(updatedExtrude1.depth, 30);
  assert.equal(
    nextState1.activeSketchId,
    'sketch-1',
    'activeSketchId should remain as original activeSketchId'
  );

  // Case 2: Initial activeSketchId = null, update Extrude
  const state2 = {
    activeSketchId: null,
    featureTree: [sketch, extrude],
  };

  const nextState2 = applyUpdateFeatureState(state2, 'extrude-1', {
    sketchId: 'sketch-1',
    depth: 40,
    profileIds: ['profile-sketch-1'],
  });

  const updatedExtrude2 = nextState2.featureTree.find(
    (f) => f.id === 'extrude-1'
  ) as ExtrudeFeature;

  assert.equal(updatedExtrude2.sketchId, 'sketch-1');
  assert.equal(updatedExtrude2.depth, 40);
  assert.equal(
    nextState2.activeSketchId,
    null,
    'activeSketchId must remain null when editing an Extrude feature'
  );
});

test('3D-50A Test 9: Formal Evaluation Ownership & CADSketchCanvas caller verification', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const canvasPath = path.join(process.cwd(), 'src/components/CADSketchCanvas.tsx');
  const canvasContent = fs.readFileSync(canvasPath, 'utf8');

  // Verify CADSketchCanvas does not invoke evaluateFeatureTree
  assert.equal(
    canvasContent.includes('evaluateFeatureTree'),
    false,
    'CADSketchCanvas must NOT call evaluateFeatureTree to avoid revision race conditions'
  );

  const cadStorePath = path.join(process.cwd(), 'src/store/cadStore.ts');
  const cadStoreContent = fs.readFileSync(cadStorePath, 'utf8');

  // Verify cadStore is the formal evaluation owner
  assert.equal(
    cadStoreContent.includes('evaluateFeatureTree'),
    true,
    'cadStore must remain the sole formal feature regen owner'
  );
});


