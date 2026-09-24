import test from 'node:test';
import assert from 'node:assert';
import {
  resolveTopoReference,
  resolveBatchTopoReferences,
  computeSignatureSimilarity,
} from '../TopologyMapper';
import type { TopoReference, TopologyMap, GeometrySignature } from '../PersistentTopology.types';

// Mocks
const mockTargetRef = (kind: any, persistentId: string, generation: number, bodyId = 'main-body'): TopoReference => ({
  persistentId,
  featureId: 'feat-1',
  bodyId,
  subShapeType: kind,
  signature: {
    centroid: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    measure: 10,
    surfaceType: 'plane',
    curveType: 'line',
    normal: kind === 'FACE' ? { x: 0, y: 0, z: 1 } : undefined,
    direction: kind === 'EDGE' ? { x: 1, y: 0, z: 0 } : undefined
  },
  generation
});

const mockMap = (bodyId: string, generation: number): TopologyMap => ({
  bodyId,
  generation,
  faces: [
    mockTargetRef('FACE', 'face-1', generation, bodyId),
    mockTargetRef('FACE', 'face-2', generation, bodyId),
  ],
  edges: [
    mockTargetRef('EDGE', 'edge-1', generation, bodyId),
  ],
  vertices: [
    mockTargetRef('VERTEX', 'vertex-1', generation, bodyId),
  ],
  version: Date.now()
});

test('Test A — 正常 Face Resolution', () => {
  const map = mockMap('main-body', 10);
  const ref = mockTargetRef('FACE', 'face-2', 10);
  const result = resolveTopoReference(ref, map);
  assert.strictEqual(result.status, 'resolved');
  assert.strictEqual(result.resolvedIndex, 1);
});

test('Test B — Edge Resolution (Edge ref -> Edge, not Face)', () => {
  const map = mockMap('main-body', 10);
  const ref = mockTargetRef('EDGE', 'edge-1', 10);
  const result = resolveTopoReference(ref, map);
  assert.strictEqual(result.status, 'resolved');
  assert.strictEqual(result.resolvedIndex, 0);

  const invalidRef = mockTargetRef('EDGE', 'face-1', 10); // Edge type but persistentId of a Face
  const invalidResult = resolveTopoReference(invalidRef, map);
  assert.strictEqual(invalidResult.status, 'unresolved');
});

test('Test C — Vertex Resolution', () => {
  const map = mockMap('main-body', 10);
  const ref = mockTargetRef('VERTEX', 'vertex-1', 10);
  const result = resolveTopoReference(ref, map);
  assert.strictEqual(result.status, 'resolved');
});

test('Test D — Wrong Body', () => {
  const map = mockMap('body-A', 10);
  const ref = mockTargetRef('FACE', 'face-1', 10, 'body-B');
  const result = resolveTopoReference(ref, map);
  assert.strictEqual(result.status, 'body_mismatch');
});

test('Test E — Generation Mismatch', () => {
  const map = mockMap('main-body', 11);
  const ref = mockTargetRef('FACE', 'face-1', 10);
  const result = resolveTopoReference(ref, map);
  assert.strictEqual(result.status, 'stale_generation');
});

test('Test F — Wrong Kind', () => {
  const map = mockMap('main-body', 10);
  const ref = mockTargetRef('EDGE', 'face-1', 10); // Trying to find face-1 in edges
  const result = resolveTopoReference(ref, map);
  assert.strictEqual(result.status, 'unresolved');
});

test('Test G — Ambiguous', () => {
  const map = mockMap('main-body', 10);
  // Add another face with same persistentId
  map.faces.push(mockTargetRef('FACE', 'face-1', 10));
  
  const ref = mockTargetRef('FACE', 'face-1', 10);
  const result = resolveTopoReference(ref, map);
  assert.strictEqual(result.status, 'ambiguous');
});

test('Test H — Missing Persistent ID', () => {
  const map = mockMap('main-body', 10);
  const ref = mockTargetRef('FACE', 'face-not-exist', 10);
  ref.featureId = 'feat-nonexistent';
  const result = resolveTopoReference(ref, map);
  assert.strictEqual(result.status, 'unresolved');
});

test('Test I — Signature mismatch', () => {
  const map = mockMap('main-body', 10);
  const ref = mockTargetRef('FACE', 'face-1', 10);
  // Change signature significantly
  ref.signature.measure = 9999;
  
  const result = resolveTopoReference(ref, map);
  assert.strictEqual(result.status, 'signature_mismatch');
});

test('Test J — Batch Resolution', () => {
  const map = mockMap('main-body', 10);
  const ref1 = mockTargetRef('FACE', 'face-1', 10);
  const ref2 = mockTargetRef('FACE', 'face-not-exist', 10);
  ref2.featureId = 'feat-nonexistent';
  const ref3 = mockTargetRef('FACE', 'face-2', 10);
  
  const results = resolveBatchTopoReferences([ref1, ref2, ref3], map);
  assert.strictEqual(results.length, 3);
  assert.strictEqual(results[0].status, 'resolved');
  assert.strictEqual(results[1].status, 'unresolved');
  assert.strictEqual(results[2].status, 'resolved');
});

test('Test L — No OCC Object Leakage', () => {
  const map = mockMap('main-body', 10);
  const ref = mockTargetRef('FACE', 'face-1', 10);
  const result = resolveTopoReference(ref, map);
  
  // Verify it is serializable and contains no complex objects or functions
  try {
    JSON.stringify(result);
    assert.ok(true);
  } catch (e) {
    assert.fail('Result must be JSON serializable');
  }
});

test('Test Arc Semantics A — Line identical signature similarity is 1.0', () => {
  const lineSig: GeometrySignature = {
    centroid: { x: 50, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 0, z: 0 } },
    measure: 100,
    direction: { x: 1, y: 0, z: 0 },
    curveType: 'line',
  };
  const similarity = computeSignatureSimilarity(lineSig, lineSig, 'EDGE');
  assert.strictEqual(similarity, 1.0, 'Identical line signatures must produce similarity 1.0');
});

test('Test Arc Semantics B — Arc identical signature (direction=undefined) similarity is 1.0', () => {
  const arcSig: GeometrySignature = {
    centroid: { x: 35.35, y: 35.35, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 50, z: 0 } },
    measure: 78.54,
    direction: undefined, // Arc does not have a single fixed direction
    curveType: 'circle',
  };
  const similarity = computeSignatureSimilarity(arcSig, arcSig, 'EDGE');
  assert.strictEqual(similarity, 1.0, 'Identical arc signatures with direction undefined must produce similarity 1.0 instead of 0.875');
});

test('Test Arc Semantics C — Arc Resolve returns status = resolved', () => {
  const arcSig: GeometrySignature = {
    centroid: { x: 35.35, y: 35.35, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 50, z: 0 } },
    measure: 78.54,
    direction: undefined,
    curveType: 'circle',
  };
  const arcRef: TopoReference = {
    persistentId: 'topo_EDGE_feat-1_1_hash_circle',
    featureId: 'feat-1',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: arcSig,
    generation: 1,
  };
  const map: TopologyMap = {
    bodyId: 'main-body',
    generation: 1,
    faces: [],
    edges: [arcRef],
    vertices: [],
    version: 1,
  };

  const result = resolveTopoReference(arcRef, map);
  assert.strictEqual(result.status, 'resolved', 'Arc reference must be resolved successfully instead of signature_mismatch');
  assert.strictEqual(result.resolvedIndex, 0);
});

test('Test Arc Semantics D — Mixed direction mismatch (one has direction, other does not)', () => {
  const lineSig: GeometrySignature = {
    centroid: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 0, z: 0 } },
    measure: 10,
    direction: { x: 1, y: 0, z: 0 },
    curveType: 'line',
  };
  const noDirSig: GeometrySignature = {
    centroid: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 0, z: 0 } },
    measure: 10,
    direction: undefined,
    curveType: 'line',
  };
  const similarity = computeSignatureSimilarity(lineSig, noDirSig, 'EDGE');
  assert.ok(similarity < 0.95, `Mixed direction signature similarity must be < 0.95 (got ${similarity})`);
});

test('Test Arc Semantics E — Curve type safety (Line vs Circle)', () => {
  const lineSig: GeometrySignature = {
    centroid: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
    measure: 10,
    direction: { x: 1, y: 0, z: 0 },
    curveType: 'line',
  };
  const circleSig: GeometrySignature = {
    centroid: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
    measure: 10,
    direction: undefined,
    curveType: 'circle',
  };
  const similarity = computeSignatureSimilarity(lineSig, circleSig, 'EDGE');
  assert.ok(similarity < 0.8, `Line vs Circle similarity must be low (got ${similarity})`);
});

// =========================================================================
// P-05 STEP 03.6: Generation Contract Restoration & Scoped Evolution Tests
// =========================================================================

test('Test 1 — Existing Strict Generation Contract (STRICT mode blocks generation mismatch)', () => {
  const map = mockMap('main-body', 2);
  const ref = mockTargetRef('FACE', 'face-1', 1);
  const result = resolveTopoReference(ref, map, { resolutionMode: 'STRICT' });
  assert.strictEqual(result.status, 'stale_generation');
});

test('Test 2 — STRICT Mode Unresolved persistentId (No signature fallback guessing in STRICT)', () => {
  const targetRef: TopoReference = {
    persistentId: 'topo_EDGE_feat-1_0_c_0_0_25_m_50_line',
    featureId: 'feat-1',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 0, y: 0, z: 25 },
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 1,
  };

  const candidateRef: TopoReference = {
    persistentId: 'topo_EDGE_feat-1_0_c_10_0_25_m_50_line',
    featureId: 'feat-1',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 10, y: 0, z: 25 },
      boundingBox: { min: { x: 10, y: 0, z: 0 }, max: { x: 10, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 1,
  };

  const map: TopologyMap = {
    bodyId: 'main-body',
    generation: 1,
    faces: [],
    edges: [candidateRef],
    vertices: [],
    version: 1,
  };

  // STRICT mode (default): persistentId 不符不得進入 Signature Fallback 誤猜
  const result = resolveTopoReference(targetRef, map);
  assert.strictEqual(result.status, 'unresolved');
});

test('Test 3 — EVOLVE Mode (Allowed cross-generation evolution when provenance matches)', () => {
  const targetRef: TopoReference = {
    persistentId: 'topo_EDGE_extrude-base-101_0_c_100_0_25_m_50_line',
    featureId: 'extrude-base-101',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 100, y: 0, z: 25 },
      boundingBox: { min: { x: 100, y: 0, z: 0 }, max: { x: 100, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 1,
  };

  const candidateRef: TopoReference = {
    persistentId: 'topo_EDGE_extrude-base-101_0_c_150_0_25_m_50_line',
    featureId: 'extrude-base-101',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 150, y: 0, z: 25 },
      boundingBox: { min: { x: 150, y: 0, z: 0 }, max: { x: 150, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 2,
  };

  const map: TopologyMap = {
    bodyId: 'main-body',
    generation: 2,
    faces: [],
    edges: [candidateRef],
    vertices: [],
    version: 2,
  };

  const result = resolveTopoReference(targetRef, map, { resolutionMode: 'EVOLVE' });
  assert.strictEqual(result.status, 'resolved');
  assert.strictEqual(result.resolvedPersistentId, candidateRef.persistentId);
});

test('Test 4 — EVOLVE Wrong Provenance (Different featureId must not resolve despite score = 1)', () => {
  const targetRef: TopoReference = {
    persistentId: 'topo_EDGE_extrude-base-101_0_c_100_0_25_m_50_line',
    featureId: 'extrude-base-101',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 100, y: 0, z: 25 },
      boundingBox: { min: { x: 100, y: 0, z: 0 }, max: { x: 100, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 1,
  };

  const candidateRef: TopoReference = {
    persistentId: 'topo_EDGE_boss-200_0_c_100_0_25_m_50_line',
    featureId: 'boss-200',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 100, y: 0, z: 25 },
      boundingBox: { min: { x: 100, y: 0, z: 0 }, max: { x: 100, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 2,
  };

  const map: TopologyMap = {
    bodyId: 'main-body',
    generation: 2,
    faces: [],
    edges: [candidateRef],
    vertices: [],
    version: 2,
  };

  const result = resolveTopoReference(targetRef, map, { resolutionMode: 'EVOLVE' });
  assert.strictEqual(result.status, 'unresolved', '來源 Feature Identity 不符者禁止解析');
});

test('Test 5 — EVOLVE Future Generation (targetGeneration > currentGeneration -> stale_generation)', () => {
  const targetRef: TopoReference = {
    persistentId: 'topo_EDGE_extrude-base-101_0_c_100_0_25_m_50_line',
    featureId: 'extrude-base-101',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 100, y: 0, z: 25 },
      boundingBox: { min: { x: 100, y: 0, z: 0 }, max: { x: 100, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 3,
  };

  const candidateRef: TopoReference = {
    persistentId: 'topo_EDGE_extrude-base-101_0_c_100_0_25_m_50_line',
    featureId: 'extrude-base-101',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 100, y: 0, z: 25 },
      boundingBox: { min: { x: 100, y: 0, z: 0 }, max: { x: 100, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 2,
  };

  const map: TopologyMap = {
    bodyId: 'main-body',
    generation: 2,
    faces: [],
    edges: [candidateRef],
    vertices: [],
    version: 2,
  };

  const result = resolveTopoReference(targetRef, map, { resolutionMode: 'EVOLVE' });
  assert.strictEqual(result.status, 'stale_generation', '不能解析未來 Reference');
});

test('Test 6 — P-05 Base 100 -> 150 (mode = EVOLVE)', () => {
  const targetRef: TopoReference = {
    persistentId: 'topo_EDGE_extrude-base-101_0_c_100_0_25_m_50_line',
    featureId: 'extrude-base-101',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 100, y: 0, z: 25 },
      boundingBox: { min: { x: 100, y: 0, z: 0 }, max: { x: 100, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 1,
  };

  const candidateRef: TopoReference = {
    persistentId: 'topo_EDGE_extrude-base-101_0_c_150_0_25_m_50_line',
    featureId: 'extrude-base-101',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 150, y: 0, z: 25 },
      boundingBox: { min: { x: 150, y: 0, z: 0 }, max: { x: 150, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 2,
  };

  const map: TopologyMap = {
    bodyId: 'main-body',
    generation: 2,
    faces: [],
    edges: [candidateRef],
    vertices: [],
    version: 2,
  };

  const result = resolveTopoReference(targetRef, map, { resolutionMode: 'EVOLVE' });
  assert.strictEqual(result.status, 'resolved');
  assert.strictEqual(result.resolvedPersistentId, candidateRef.persistentId);
  assert.strictEqual(map.edges[result.resolvedIndex!].signature.centroid.x, 150);
});

test('P-05 STEP 03.6 — Additional: 真正不同 Edge 在 EVOLVE 模式下幾何特徵不符仍應 unresolved', () => {
  const targetRef: TopoReference = {
    persistentId: 'topo_EDGE_feat-1_0_c_100_0_25_m_50_line',
    featureId: 'feat-1',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 100, y: 0, z: 25 },
      boundingBox: { min: { x: 100, y: 0, z: 0 }, max: { x: 100, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 1,
  };

  // candidate A: 位置相近，但 curveType 為 circle
  const candidateA: TopoReference = {
    persistentId: 'topo_EDGE_feat-1_1_c_102_0_25_m_50_circle',
    featureId: 'feat-1',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 102, y: 0, z: 25 },
      boundingBox: { min: { x: 100, y: 0, z: 0 }, max: { x: 104, y: 0, z: 50 } },
      measure: 50,
      curveType: 'circle',
      direction: undefined,
    },
    generation: 2,
  };

  // candidate B: 位置相近，但方向正交 (y 軸)，長度為 200
  const candidateB: TopoReference = {
    persistentId: 'topo_EDGE_feat-1_2_c_102_0_25_m_200_line',
    featureId: 'feat-1',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 102, y: 0, z: 25 },
      boundingBox: { min: { x: 102, y: -100, z: 25 }, max: { x: 102, y: 100, z: 25 } },
      measure: 200,
      curveType: 'line',
      direction: { x: 0, y: 1, z: 0 },
    },
    generation: 2,
  };

  const map: TopologyMap = {
    bodyId: 'main-body',
    generation: 2,
    faces: [],
    edges: [candidateA, candidateB],
    vertices: [],
    version: 2,
  };

  const result = resolveTopoReference(targetRef, map, { resolutionMode: 'EVOLVE' });
  assert.strictEqual(result.status, 'unresolved', '幾何特徵不符之邊不得誤解析');
});

test('P-05 STEP 03.6 — Additional: Ambiguous (兩候選高度相似在 EVOLVE 模式下回傳 ambiguous)', () => {
  const targetRef: TopoReference = {
    persistentId: 'topo_EDGE_feat-1_0_c_100_0_25_m_50_line',
    featureId: 'feat-1',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 100, y: 0, z: 25 },
      boundingBox: { min: { x: 100, y: 0, z: 0 }, max: { x: 100, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 1,
  };

  // 兩個合法候選，幾何特徵與距離完全相同，得分相同
  const candidateA: TopoReference = {
    persistentId: 'topo_EDGE_feat-1_1_c_150_0_25_m_50_line',
    featureId: 'feat-1',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 150, y: 0, z: 25 },
      boundingBox: { min: { x: 150, y: 0, z: 0 }, max: { x: 150, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 2,
  };

  const candidateB: TopoReference = {
    persistentId: 'topo_EDGE_feat-1_2_c_150_0_25_m_50_line',
    featureId: 'feat-1',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 150, y: 0, z: 25 },
      boundingBox: { min: { x: 150, y: 0, z: 0 }, max: { x: 150, y: 0, z: 50 } },
      measure: 50,
      curveType: 'line',
      direction: { x: 0, y: 0, z: 1 },
    },
    generation: 2,
  };

  const map: TopologyMap = {
    bodyId: 'main-body',
    generation: 2,
    faces: [],
    edges: [candidateA, candidateB],
    vertices: [],
    version: 2,
  };

  const result = resolveTopoReference(targetRef, map, { resolutionMode: 'EVOLVE' });
  assert.strictEqual(result.status, 'ambiguous', '高度相似候選必須回傳 ambiguous');
});

