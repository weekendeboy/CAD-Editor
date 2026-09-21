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

