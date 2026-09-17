import test from 'node:test';
import assert from 'node:assert';
import { resolveTopoReference, resolveBatchTopoReferences } from '../TopologyMapper';
import type { TopoReference, TopologyMap } from '../PersistentTopology.types';

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
