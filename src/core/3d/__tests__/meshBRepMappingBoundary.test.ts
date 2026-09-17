import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTriangleToFace,
  resolveMeshEdgeToEdge,
  resolveMeshVertexToVertex,
} from '../MeshSubshapeResolver';
import type {
  MeshSubshapeMapping,
  RuntimeBRepFaceRef,
  RuntimeBRepEdgeRef,
  RuntimeBRepVertexRef,
} from '../SolidEngine.types';

function createMockBoxMapping(generation = 1): MeshSubshapeMapping {
  // A box with 6 faces, 12 triangles (2 per face), 3 edges (6 segments), 2 corner vertices (4 mesh vertices)
  const faces: RuntimeBRepFaceRef[] = [
    { bodyId: 'main-body', faceIndex: 0, runtimeId: 'brep_face_main-body_0', surfaceType: 'plane', area: 400 },
    { bodyId: 'main-body', faceIndex: 1, runtimeId: 'brep_face_main-body_1', surfaceType: 'plane', area: 400 },
    { bodyId: 'main-body', faceIndex: 2, runtimeId: 'brep_face_main-body_2', surfaceType: 'plane', area: 400 },
    { bodyId: 'main-body', faceIndex: 3, runtimeId: 'brep_face_main-body_3', surfaceType: 'plane', area: 400 },
    { bodyId: 'main-body', faceIndex: 4, runtimeId: 'brep_face_main-body_4', surfaceType: 'plane', area: 400 },
    { bodyId: 'main-body', faceIndex: 5, runtimeId: 'brep_face_main-body_5', surfaceType: 'plane', area: 400 },
  ];

  // 12 triangles: 0,1 -> Face 0; 2,3 -> Face 1; 4,5 -> Face 2; 6,7 -> Face 3; 8,9 -> Face 4; 10,11 -> Face 5
  const triangleToFaceIndex = new Int32Array([
    0, 0,
    1, 1,
    2, 2,
    3, 3,
    4, 4,
    5, 5,
  ]);

  const faceTriangleRanges = [
    { faceIndex: 0, startTriangle: 0, triangleCount: 2 },
    { faceIndex: 1, startTriangle: 2, triangleCount: 2 },
    { faceIndex: 2, startTriangle: 4, triangleCount: 2 },
    { faceIndex: 3, startTriangle: 6, triangleCount: 2 },
    { faceIndex: 4, startTriangle: 8, triangleCount: 2 },
    { faceIndex: 5, startTriangle: 10, triangleCount: 2 },
  ];

  const edges: RuntimeBRepEdgeRef[] = [
    { bodyId: 'main-body', edgeIndex: 0, runtimeId: 'brep_edge_main-body_0', curveType: 'line', length: 20 },
    { bodyId: 'main-body', edgeIndex: 1, runtimeId: 'brep_edge_main-body_1', curveType: 'line', length: 20 },
    { bodyId: 'main-body', edgeIndex: 2, runtimeId: 'brep_edge_main-body_2', curveType: 'line', length: 20 },
  ];

  // 6 line segments: 0,1 -> Edge 0; 2,3 -> Edge 1; 4,5 -> Edge 2
  const meshEdgeToBRepEdgeIndex = new Int32Array([0, 0, 1, 1, 2, 2]);

  const edgeSegmentRanges = [
    { edgeIndex: 0, startSegment: 0, segmentCount: 2 },
    { edgeIndex: 1, startSegment: 2, segmentCount: 2 },
    { edgeIndex: 2, startSegment: 4, segmentCount: 2 },
  ];

  const vertices: RuntimeBRepVertexRef[] = [
    { bodyId: 'main-body', vertexIndex: 0, runtimeId: 'brep_vert_main-body_0', point: { x: 0, y: 0, z: 0 } },
    { bodyId: 'main-body', vertexIndex: 1, runtimeId: 'brep_vert_main-body_1', point: { x: 20, y: 0, z: 0 } },
  ];

  // 4 mesh vertices: vertex 0 -> corner 0; vertex 1 -> corner 1; vertex 2, 3 -> not corner (-1)
  const meshVertexToBRepVertexIndex = new Int32Array([0, 1, -1, -1]);

  return {
    bodyId: 'main-body',
    generation,
    faces,
    triangleToFaceIndex,
    faceTriangleRanges,
    edges,
    meshEdgeToBRepEdgeIndex,
    edgeSegmentRanges,
    vertices,
    meshVertexToBRepVertexIndex,
  };
}

test('MeshSubshapeResolver: resolveTriangleToFace maps triangles to exact B-Rep Face', () => {
  const mapping = createMockBoxMapping(1);

  // Triangles 0 and 1 should map to Face 0
  const res0 = resolveTriangleToFace(mapping, 0);
  assert.equal(res0.status, 'exact');
  assert.equal(res0.faceRef?.faceIndex, 0);
  assert.equal(res0.faceRef?.runtimeId, 'brep_face_main-body_0');
  assert.equal(res0.faceRef?.surfaceType, 'plane');

  const res1 = resolveTriangleToFace(mapping, 1);
  assert.equal(res1.status, 'exact');
  assert.equal(res1.faceRef?.faceIndex, 0);

  // Triangles 4 and 5 should map to Face 2
  const res4 = resolveTriangleToFace(mapping, 4);
  assert.equal(res4.status, 'exact');
  assert.equal(res4.faceRef?.faceIndex, 2);
  assert.equal(res4.faceRef?.runtimeId, 'brep_face_main-body_2');
});

test('MeshSubshapeResolver: resolveTriangleToFace handles out of bounds index', () => {
  const mapping = createMockBoxMapping(1);

  const negRes = resolveTriangleToFace(mapping, -1);
  assert.equal(negRes.status, 'unresolved');
  assert.equal(negRes.faceRef, null);

  const highRes = resolveTriangleToFace(mapping, 999);
  assert.equal(highRes.status, 'unresolved');
  assert.equal(highRes.faceRef, null);
});

test('MeshSubshapeResolver: enforces generation isolation between evaluation steps', () => {
  const gen1Mapping = createMockBoxMapping(1);

  // Calling with expectedGeneration = 1 matches
  const matchRes = resolveTriangleToFace(gen1Mapping, 0, 1);
  assert.equal(matchRes.status, 'exact');

  // Calling with expectedGeneration = 2 (e.g. user clicked while next regen finished)
  const staleRes = resolveTriangleToFace(gen1Mapping, 0, 2);
  assert.equal(staleRes.status, 'generation_mismatch');
  assert.equal(staleRes.faceRef, null);
});

test('MeshSubshapeResolver: resolveMeshEdgeToEdge maps segments correctly', () => {
  const mapping = createMockBoxMapping(1);

  const edge0 = resolveMeshEdgeToEdge(mapping, 0);
  assert.equal(edge0.status, 'exact');
  assert.equal(edge0.edgeRef?.edgeIndex, 0);
  assert.equal(edge0.edgeRef?.runtimeId, 'brep_edge_main-body_0');

  const edge1 = resolveMeshEdgeToEdge(mapping, 3);
  assert.equal(edge1.status, 'exact');
  assert.equal(edge1.edgeRef?.edgeIndex, 1);

  const oobEdge = resolveMeshEdgeToEdge(mapping, 50);
  assert.equal(oobEdge.status, 'unresolved');
  assert.equal(edge0.edgeRef?.length, 20);
});

test('MeshSubshapeResolver: resolveMeshVertexToVertex identifies corner vs internal vertices', () => {
  const mapping = createMockBoxMapping(1);

  // Mesh vertex 0 is corner 0
  const vert0 = resolveMeshVertexToVertex(mapping, 0);
  assert.equal(vert0.status, 'exact');
  assert.equal(vert0.vertexRef?.vertexIndex, 0);
  assert.equal(vert0.vertexRef?.runtimeId, 'brep_vert_main-body_0');

  // Mesh vertex 2 is tessellation interior vertex (not B-Rep vertex, mapped to -1)
  const vert2 = resolveMeshVertexToVertex(mapping, 2);
  assert.equal(vert2.status, 'unresolved');
  assert.equal(vert2.vertexRef, null);

  const oobVert = resolveMeshVertexToVertex(mapping, 999);
  assert.equal(oobVert.status, 'unresolved');
  assert.equal(oobVert.vertexRef, null);
});

test('Architecture Contract v1: Mesh Index ≠ B-Rep Identity separation', () => {
  const mapping = createMockBoxMapping(1);

  // Distinct triangles have distinct mesh indices (0 and 1) but identical B-Rep face identity
  const t0 = resolveTriangleToFace(mapping, 0);
  const t1 = resolveTriangleToFace(mapping, 1);

  assert.equal(t0.faceRef?.faceIndex, t1.faceRef?.faceIndex);
  assert.equal(t0.faceRef?.runtimeId, t1.faceRef?.runtimeId);

  // Confirm TypedArray structure prevents prototype pollution and ensures worker zero-copy compatibility
  assert.ok(mapping.triangleToFaceIndex instanceof Int32Array);
  assert.ok(mapping.meshEdgeToBRepEdgeIndex instanceof Int32Array);
  assert.ok(mapping.meshVertexToBRepVertexIndex instanceof Int32Array);
});
