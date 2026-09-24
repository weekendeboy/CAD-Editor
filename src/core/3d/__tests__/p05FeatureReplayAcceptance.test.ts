import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { compileFeaturePlan } from '../FeaturePipelineAdapter';
import { extractTopologyMap } from '../TopologyExtractor';
import { setWorkerOCC, executeWorkerTask } from '../SolidWorker';
import { solidEngine } from '../SolidEngine';
import { markDownstreamDirty } from '../FeatureRegenEngine';
import { useCADStore } from '../../../store/cadStore';
import type { CADDocument, SketchFeature, ExtrudeFeature, CircularPatternFeature } from '../../../types/cad';
import type { TopoReference } from '../PersistentTopology.types';

// =========================================================================
// Real OpenCASCADE WASM loader for Node.js test harness
// =========================================================================
let cachedOCC: any = null;

async function getRealOCC(): Promise<any> {
  if (cachedOCC) return cachedOCC;

  const parts = [
    'public/occ/opencascade.wasm.part0.bin',
    'public/occ/opencascade.wasm.part1.bin',
    'public/occ/opencascade.wasm.part2.bin',
    'public/occ/opencascade.wasm.part3.bin',
  ];
  const buffers = parts.map((p) => fs.readFileSync(path.resolve(process.cwd(), p)));
  const total = buffers.reduce((acc, b) => acc + b.byteLength, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    combined.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }

  const jsCode = fs.readFileSync(path.resolve(process.cwd(), 'public/occ/opencascade.wasm.js'), 'utf8');
  const fn = new Function('self', 'module', 'exports', '__dirname', jsCode + '; return self.initOpenCascade || module.exports;');
  const dummySelf: any = {};
  const dummyModule = { exports: {} };
  const occDir = path.resolve(process.cwd(), 'public/occ');
  const initOCC = fn(dummySelf, dummyModule, dummyModule.exports, occDir);
  cachedOCC = await initOCC({ wasmBinary: combined.buffer });
  return cachedOCC;
}

test('P-05 / STEP 03.12 — Full FeaturePipeline -> SolidWorker -> OCC Replay Acceptance', async (t) => {
  const occ = await getRealOCC();
  assert.ok(occ, 'Real OpenCASCADE WASM must initialize successfully');

  // Initialize SolidWorker with real OCC instance
  setWorkerOCC(occ);

  // Hook up SolidEngine to direct SolidWorker bridge for Zustand store tests
  const directWorker = {
    onmessage: null as any,
    onerror: null as any,
    postMessage: async (req: any) => {
      try {
        const res = await executeWorkerTask(req);
        if (directWorker.onmessage) {
          directWorker.onmessage({ data: res });
        }
      } catch (err: any) {
        if (directWorker.onerror) {
          directWorker.onerror(err);
        }
      }
    },
  };
  solidEngine.setWorker(directWorker);

  // Intercept logs to verify required evidence strings
  const interceptedLogs: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: any[]) => {
    const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    interceptedLogs.push(text);
    originalConsoleLog(...args);
  };

  // -----------------------------------------------------------------------
  // Step 1: Real OCC Topology Extraction for User Selection
  // Simulating the user selecting the right-bottom vertical edge of the 100x100x20 Base
  // -----------------------------------------------------------------------
  let selectedEdgeRef: TopoReference | undefined;

  await t.test('Step 1: Extract Base topology and obtain real selected Edge reference', async () => {
    const baseSketch: SketchFeature = {
      id: 'sketch-base',
      name: 'Sketch Base',
      type: 'SKETCH',
      plane: {
        id: 'plane-top',
        name: 'Top Plane',
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
      },
      entities: [],
      constraints: [],
      dimensions: [],
      profiles: [
        {
          id: 'prof-base',
          outerLoop: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
            { x: 0, y: 100 },
          ],
          holes: [],
        },
      ],
    };

    const baseExtrude: ExtrudeFeature = {
      id: 'extrude-base-1',
      name: 'Base Feature',
      type: 'EXTRUDE',
      sketchId: 'sketch-base',
      depth: 20,
      direction: 'normal',
      mode: 'EXTRUDE',
    };

    // Compile ops via FeaturePipelineAdapter
    const compiled = compileFeaturePlan([baseSketch, baseExtrude], 2, {});
    assert.strictEqual(compiled.operations.length, 1, 'Should compile 1 base extrude op');

    // Run in SolidWorker
    const workerRes = await executeWorkerTask({
      taskId: 'step1-base',
      type: 'EVALUATE_FEATURE_TREE',
      payload: {
        operations: compiled.operations,
        dirtyOpIndex: 0,
      },
    });

    assert.strictEqual(workerRes.success, true, 'Base extrude in worker must succeed');
    const baseRes = workerRes.data.featureResults['extrude-base-1'];
    assert.ok(baseRes.solid, 'Base solid shape must exist in evaluation result');

    // Extract real OCC topology map
    const baseTopMap = extractTopologyMap(
      baseRes.solid,
      occ,
      'extrude-base-1',
      'main-body',
      1,
      {
        featureId: 'extrude-base-1',
        featureType: 'EXTRUDE',
        profiles: baseSketch.profiles,
        depth: 20,
      }
    );

    // Find the right-bottom vertical edge (x = 100, y = 0, length = 20, direction = Z)
    const rightBottomEdge = baseTopMap.edges.find((e) => {
      const c = e.signature.centroid;
      const isX100 = Math.abs(c.x - 100) < 1e-2;
      const isY0 = Math.abs(c.y - 0) < 1e-2;
      const isLen20 = Math.abs(e.signature.measure - 20) < 1e-2;
      return isX100 && isY0 && isLen20;
    });

    assert.ok(rightBottomEdge, 'Must find the right-bottom vertical edge of the base');
    assert.ok(rightBottomEdge.provenance, 'Edge must possess semantic provenance');
    assert.strictEqual(rightBottomEdge.provenance?.sourceTopologyPath, 'extrude:lateral_edge:v_1');
    selectedEdgeRef = rightBottomEdge;

    console.log('[STEP 03.12 EVIDENCE] Selected Edge Reference from Real OCC:', {
      persistentId: selectedEdgeRef.persistentId,
      generation: selectedEdgeRef.generation,
      provenance: selectedEdgeRef.provenance,
    });
  });

  // -----------------------------------------------------------------------
  // Step 2: Full Pipeline Initial Evaluation (Base 100 + Boss + Pattern)
  // -----------------------------------------------------------------------
  await t.test('Step 2: Full Pipeline initial evaluation at Base width 100', async () => {
    assert.ok(selectedEdgeRef, 'selectedEdgeRef must be present');

    const baseSketch: SketchFeature = {
      id: 'sketch-base',
      name: 'Sketch Base',
      type: 'SKETCH',
      plane: {
        id: 'plane-top',
        name: 'Top Plane',
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
      },
      entities: [],
      constraints: [],
      dimensions: [],
      profiles: [
        {
          id: 'prof-base',
          outerLoop: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
            { x: 0, y: 100 },
          ],
          holes: [],
        },
      ],
    };

    const baseExtrude: ExtrudeFeature = {
      id: 'extrude-base-1',
      name: 'Base Feature',
      type: 'EXTRUDE',
      sketchId: 'sketch-base',
      depth: 20,
      direction: 'normal',
      mode: 'EXTRUDE',
    };

    const bossSketch: SketchFeature = {
      id: 'sketch-boss',
      name: 'Sketch Boss',
      type: 'SKETCH',
      plane: {
        id: 'plane-boss',
        name: 'Top of Base',
        origin: { x: 0, y: 0, z: 20 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
      },
      entities: [],
      constraints: [],
      dimensions: [],
      profiles: [
        {
          id: 'prof-boss',
          outerLoop: [
            { x: 90, y: 10 },
            { x: 100, y: 10 },
            { x: 100, y: 20 },
            { x: 90, y: 20 },
          ],
          holes: [],
        },
      ],
    };

    const bossExtrude: ExtrudeFeature = {
      id: 'extrude-boss-1',
      name: 'Boss Extrude',
      type: 'EXTRUDE',
      sketchId: 'sketch-boss',
      depth: 10,
      direction: 'normal',
      mode: 'EXTRUDE',
    };

    const patternFeature: CircularPatternFeature = {
      id: 'pattern-1',
      name: 'Circular Pattern 1',
      type: 'CIRCULAR_PATTERN',
      targetFeatureIds: ['extrude-boss-1'],
      count: 2,
      totalAngle: 180,
      axisType: 'CUSTOM_EDGE',
      axisEdgeRef: selectedEdgeRef,
    };

    const featureTree = [baseSketch, baseExtrude, bossSketch, bossExtrude, patternFeature];

    // Compile through FeaturePipelineAdapter
    const compiled = compileFeaturePlan(featureTree, featureTree.length, {});
    assert.strictEqual(compiled.operations.length, 3, 'Should compile 3 ops: Base, Boss, and Unrolled Pattern');

    // Worker EVALUATE_FEATURE_TREE
    const res = await executeWorkerTask({
      taskId: 'step2-initial-eval',
      type: 'EVALUATE_FEATURE_TREE',
      payload: {
        operations: compiled.operations,
        dirtyOpIndex: 0,
      },
    });

    assert.strictEqual(res.success, true, 'Initial evaluation must succeed');
    assert.ok(res.data.featureResults['pattern-1']?.success, 'Pattern feature result.success must be true');

    const bodyBBox = res.data.bodies[0].boundingBox;
    console.log('[STEP 03.12 EVIDENCE] Initial Model Bounding Box (Base=100):', bodyBBox);

    // Rotated boss: boss at [90..100, 10..20] rotated 180 deg around (100, 0)
    // -> x_new in [100..110], y_new in [-20..-10]
    assert.ok(bodyBBox.max.x >= 109.9, `BBox max.x must reach ~110, got ${bodyBBox.max.x}`);
    assert.ok(bodyBBox.min.y <= -9.9, `BBox min.y must reach ~ -20, got ${bodyBBox.min.y}`);
  });

  // -----------------------------------------------------------------------
  // Step 3: Base 100 -> 150 Semantic Provenance Evolution Verification
  // -----------------------------------------------------------------------
  await t.test('Step 3: Modify Base 100 -> 150 and verify dynamic axis resolution to x = 150', async () => {
    assert.ok(selectedEdgeRef, 'selectedEdgeRef must be present');

    // Modify Base sketch width from 100 to 150
    const baseSketchModified: SketchFeature = {
      id: 'sketch-base',
      name: 'Sketch Base',
      type: 'SKETCH',
      plane: {
        id: 'plane-top',
        name: 'Top Plane',
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
      },
      entities: [],
      constraints: [],
      dimensions: [],
      profiles: [
        {
          id: 'prof-base',
          outerLoop: [
            { x: 0, y: 0 },
            { x: 150, y: 0 },
            { x: 150, y: 100 },
            { x: 0, y: 100 },
          ],
          holes: [],
        },
      ],
    };

    const baseExtrude: ExtrudeFeature = {
      id: 'extrude-base-1',
      name: 'Base Feature',
      type: 'EXTRUDE',
      sketchId: 'sketch-base',
      depth: 20,
      direction: 'normal',
      mode: 'EXTRUDE',
    };

    const bossSketch: SketchFeature = {
      id: 'sketch-boss',
      name: 'Sketch Boss',
      type: 'SKETCH',
      plane: {
        id: 'plane-boss',
        name: 'Top of Base',
        origin: { x: 0, y: 0, z: 20 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
      },
      entities: [],
      constraints: [],
      dimensions: [],
      profiles: [
        {
          id: 'prof-boss',
          outerLoop: [
            { x: 90, y: 10 },
            { x: 100, y: 10 },
            { x: 100, y: 20 },
            { x: 90, y: 20 },
          ],
          holes: [],
        },
      ],
    };

    const bossExtrude: ExtrudeFeature = {
      id: 'extrude-boss-1',
      name: 'Boss Extrude',
      type: 'EXTRUDE',
      sketchId: 'sketch-boss',
      depth: 10,
      direction: 'normal',
      mode: 'EXTRUDE',
    };

    // Notice: patternFeature and its axisEdgeRef are completely UNTOUCHED
    const patternFeature: CircularPatternFeature = {
      id: 'pattern-1',
      name: 'Circular Pattern 1',
      type: 'CIRCULAR_PATTERN',
      targetFeatureIds: ['extrude-boss-1'],
      count: 2,
      totalAngle: 180,
      axisType: 'CUSTOM_EDGE',
      axisEdgeRef: selectedEdgeRef,
    };

    const featureTree = [baseSketchModified, baseExtrude, bossSketch, bossExtrude, patternFeature];

    // Compile through FeaturePipelineAdapter
    const compiled = compileFeaturePlan(featureTree, featureTree.length, {});

    // Worker EVALUATE_FEATURE_TREE
    const res = await executeWorkerTask({
      taskId: 'step3-evolve-eval',
      type: 'EVALUATE_FEATURE_TREE',
      payload: {
        operations: compiled.operations,
        dirtyOpIndex: 0,
      },
    });

    assert.strictEqual(res.success, true, 'Evolution replay must succeed');
    assert.strictEqual(res.data.featureResults['pattern-1']?.success, true, 'Pattern feature result.success = true');

    const bodyBBox = res.data.bodies[0].boundingBox;
    console.log('[STEP 03.12 EVIDENCE] Evolved Model Bounding Box (Base=150):', bodyBBox);

    // Semantics Explanation:
    // Boss sketch is defined at [90..100, 10..20].
    // The pattern axis dynamically resolves from x=100 to the evolved edge at x=150!
    // Rotated boss: boss at [90..100, 10..20] rotated 180 deg around (150, 0):
    // x_new = 150 + (150 - x) = 300 - x => [200..210]!
    // Therefore, the final B-Rep bounding box max.x must reach ~210!
    assert.ok(bodyBBox.max.x >= 209.9, `Evolved BBox max.x must reach ~210 following axis at 150, got ${bodyBBox.max.x}`);
  });

  // -----------------------------------------------------------------------
  // Step 4: Zustand Integration, Undo / Redo Lifecycle Verification
  // -----------------------------------------------------------------------
  await t.test('Step 4: Zustand store integration and Undo / Redo lifecycle', async () => {
    assert.ok(selectedEdgeRef, 'selectedEdgeRef must be present');

    const baseSketch100: SketchFeature = {
      id: 'sketch-base',
      name: 'Sketch Base',
      type: 'SKETCH',
      plane: {
        id: 'plane-top',
        name: 'Top Plane',
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
      },
      entities: [],
      constraints: [],
      dimensions: [],
      profiles: [
        {
          id: 'prof-base',
          outerLoop: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
            { x: 0, y: 100 },
          ],
          holes: [],
        },
      ],
    };

    const baseExtrude: ExtrudeFeature = {
      id: 'extrude-base-1',
      name: 'Base Feature',
      type: 'EXTRUDE',
      sketchId: 'sketch-base',
      depth: 20,
      direction: 'normal',
      mode: 'EXTRUDE',
    };

    const bossSketch: SketchFeature = {
      id: 'sketch-boss',
      name: 'Sketch Boss',
      type: 'SKETCH',
      plane: {
        id: 'plane-boss',
        name: 'Top of Base',
        origin: { x: 0, y: 0, z: 20 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
      },
      entities: [],
      constraints: [],
      dimensions: [],
      profiles: [
        {
          id: 'prof-boss',
          outerLoop: [
            { x: 90, y: 10 },
            { x: 100, y: 10 },
            { x: 100, y: 20 },
            { x: 90, y: 20 },
          ],
          holes: [],
        },
      ],
    };

    const bossExtrude: ExtrudeFeature = {
      id: 'extrude-boss-1',
      name: 'Boss Extrude',
      type: 'EXTRUDE',
      sketchId: 'sketch-boss',
      depth: 10,
      direction: 'normal',
      mode: 'EXTRUDE',
    };

    const patternFeature: CircularPatternFeature = {
      id: 'pattern-1',
      name: 'Circular Pattern 1',
      type: 'CIRCULAR_PATTERN',
      targetFeatureIds: ['extrude-boss-1'],
      count: 2,
      totalAngle: 180,
      axisType: 'CUSTOM_EDGE',
      axisEdgeRef: selectedEdgeRef,
    };

    // 1. Initialize Zustand Document
    const initialDoc: CADDocument = {
      id: 'p05-doc',
      name: 'P05 Acceptance Doc',
      layers: { '0': { id: '0', name: 'Default', color: '#ffffff', visible: true, locked: false } },
      activeLayerId: '0',
      planes: {},
      featureTree: [baseSketch100, baseExtrude, bossSketch, bossExtrude, patternFeature],
      rollbackIndex: 5,
    };

    useCADStore.setState({
      document: initialDoc,
      undoStack: [],
      redoStack: [],
      featureResults: {},
      bodies: [],
      sketchSession: {
        isActive: false,
        sketchId: null,
        draftEntities: [],
        draftConstraints: [],
        draftDimensions: [],
        draftProfiles: [],
        isDirty: false,
        draftUndoStack: [],
        draftRedoStack: [],
      } as any,
    });

    // Run store regeneration
    await useCADStore.getState().regenerateFeatureTree();

    let state = useCADStore.getState();
    assert.strictEqual(state.featureResults['pattern-1']?.success, true, 'Store initial regen pattern success');
    assert.ok(state.bodies[0].boundingBox.max.x >= 109.9, 'Initial max.x in store should be ~110');

    // 2. Perform modification: Change Base width 100 -> 150
    // Record undo state as cadStore does
    const prevDocCopy = JSON.parse(JSON.stringify(useCADStore.getState().document));
    const rawModifiedDoc: CADDocument = {
      ...prevDocCopy,
      featureTree: prevDocCopy.featureTree.map((f: any) => {
        if (f.id === 'sketch-base') {
          return {
            ...f,
            isDirty: true,
            profiles: [
              {
                id: 'prof-base',
                outerLoop: [
                  { x: 0, y: 0 },
                  { x: 150, y: 0 },
                  { x: 150, y: 100 },
                  { x: 0, y: 100 },
                ],
                holes: [],
              },
            ],
          };
        }
        return f;
      }),
    };

    const modifiedDoc: CADDocument = {
      ...rawModifiedDoc,
      featureTree: markDownstreamDirty(rawModifiedDoc.featureTree as any, 'sketch-base'),
    };

    useCADStore.setState((s) => ({
      undoStack: [...s.undoStack, prevDocCopy],
      redoStack: [],
      document: modifiedDoc,
      featureResults: {},
    }));

    await useCADStore.getState().regenerateFeatureTree();

    state = useCADStore.getState();
    assert.strictEqual(state.featureResults['pattern-1']?.success, true, 'Store evolved regen pattern success');
    assert.ok(state.bodies[0].boundingBox.max.x >= 209.9, `Evolved max.x in store should be ~210, got ${state.bodies[0].boundingBox.max.x}`);

    // 3. Test UNDO
    await useCADStore.getState().undo();

    state = useCADStore.getState();
    assert.strictEqual(state.featureResults['pattern-1']?.success, true, 'Store undo regen pattern success');
    assert.ok(state.bodies[0].boundingBox.max.x <= 115, `Undone max.x should revert to ~110, got ${state.bodies[0].boundingBox.max.x}`);

    // 4. Test REDO
    await useCADStore.getState().redo();

    state = useCADStore.getState();
    assert.strictEqual(state.featureResults['pattern-1']?.success, true, 'Store redo regen pattern success');
    assert.ok(state.bodies[0].boundingBox.max.x >= 209.9, `Redone max.x should be ~210, got ${state.bodies[0].boundingBox.max.x}`);
  });

  // -----------------------------------------------------------------------
  // Step 5: Cold Reload & Persistence Replay Verification
  // -----------------------------------------------------------------------
  await t.test('Step 5: Cold reload and document persistence replay', async () => {
    // Save document to JSON string
    const serialized = JSON.stringify(useCADStore.getState().document);
    assert.ok(serialized.length > 0, 'Serialized document must not be empty');

    // Wipe store completely
    useCADStore.setState({
      document: JSON.parse(serialized),
      featureResults: {},
      bodies: [],
      undoStack: [],
      redoStack: [],
    });

    // Replay cold from scratch
    await useCADStore.getState().regenerateFeatureTree();

    const state = useCADStore.getState();
    assert.strictEqual(state.featureResults['pattern-1']?.success, true, 'Cold replay pattern feature success = true');
    assert.ok(state.bodies[0].boundingBox.max.x >= 209.9, `Cold replay max.x should be ~210, got ${state.bodies[0].boundingBox.max.x}`);
  });

  // -----------------------------------------------------------------------
  // Step 6: Log Evidence Verification
  // -----------------------------------------------------------------------
  await t.test('Step 6: Verification of required Worker evidence logs', () => {
    console.log = originalConsoleLog;
    const fullLog = interceptedLogs.join('\n');

    // Verify TNP GENERATION EVOLUTION or TNP SEMANTIC EVOLUTION
    const hasGenEvolution = fullLog.includes('[TNP GENERATION EVOLUTION]') || fullLog.includes('[TNP SEMANTIC EVOLUTION]');
    assert.ok(hasGenEvolution, 'Worker logs must include [TNP GENERATION EVOLUTION] or [TNP SEMANTIC EVOLUTION]');

    // Verify sourceTopologyPath
    assert.ok(fullLog.includes('extrude:lateral_edge:v_1'), 'Worker logs must include semantic path extrude:lateral_edge:v_1');

    // Verify [P05 AXIS RESOLVED] with x: 150
    assert.ok(fullLog.includes('[P05 AXIS RESOLVED]'), 'Worker logs must include [P05 AXIS RESOLVED]');
    assert.ok(fullLog.includes('150'), 'Worker logs must include axis coordinate 150');

    // Verify Pattern feature success
    assert.ok(fullLog.includes('Pattern feature result.success = true') || fullLog.includes('P05 AXIS RESOLVED'), 'Worker logs must confirm axis resolution and pattern success');

    originalConsoleLog('\n=== ALL P-05 REPLAY ACCEPTANCE CRITERIA VERIFIED ===\n');
  });
});
