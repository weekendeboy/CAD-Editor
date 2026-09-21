import test from 'node:test';
import assert from 'node:assert';
import type { Point3D } from '../../../types/cad';
import type {
  MeshSubshapeMapping,
  RuntimeBRepEdgeRef,
  RuntimeBRepFaceRef,
  RuntimeBRepVertexRef,
  MeshSelection,
} from '../MeshSubshapeMapping.types';
import {
  resolveMeshEdgeToEdge,
  resolveTriangleToFace,
  createMeshSelection,
} from '../MeshSubshapeResolver';
import { resolveBRepEdgeToAxis } from '../UnifiedReferenceResolver';

function approxEqual(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

function assertPoint3DApprox(
  p: Point3D,
  expected: { x: number; y: number; z: number },
  eps = 1e-4
) {
  assert.ok(
    approxEqual(p.x, expected.x, eps) &&
      approxEqual(p.y, expected.y, eps) &&
      approxEqual(p.z, expected.z, eps),
    `Point (${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}) is not close to expected (${expected.x}, ${expected.y}, ${expected.z})`
  );
}

// 建立標準 100x100x100 立方體 (Box) 測試拓撲映射
function createMockBoxMapping(): MeshSubshapeMapping {
  // 12 條 B-Rep 邊線 (Box has 12 straight edges of length 100)
  const brepEdges: RuntimeBRepEdgeRef[] = [
    // Bottom 4 edges (Z = 0)
    {
      bodyId: 'main-body',
      edgeIndex: 0,
      runtimeId: 'brep_edge_main-body_0',
      curveType: 'line',
      length: 100,
      startPoint: { x: 0, y: 0, z: 0 },
      endPoint: { x: 100, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 0,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        length: 100,
        bodyId: 'main-body',
        generation: 1,
      },
    },
    {
      bodyId: 'main-body',
      edgeIndex: 1,
      runtimeId: 'brep_edge_main-body_1',
      curveType: 'line',
      length: 100,
      startPoint: { x: 100, y: 0, z: 0 },
      endPoint: { x: 100, y: 100, z: 0 },
      direction: { x: 0, y: 1, z: 0 },
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 1,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        length: 100,
        bodyId: 'main-body',
        generation: 1,
      },
    },
    {
      bodyId: 'main-body',
      edgeIndex: 2,
      runtimeId: 'brep_edge_main-body_2',
      curveType: 'line',
      length: 100,
      startPoint: { x: 100, y: 100, z: 0 },
      endPoint: { x: 0, y: 100, z: 0 },
      direction: { x: -1, y: 0, z: 0 },
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 2,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        length: 100,
        bodyId: 'main-body',
        generation: 1,
      },
    },
    {
      bodyId: 'main-body',
      edgeIndex: 3,
      runtimeId: 'brep_edge_main-body_3',
      curveType: 'line',
      length: 100,
      startPoint: { x: 0, y: 100, z: 0 },
      endPoint: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 3,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        length: 100,
        bodyId: 'main-body',
        generation: 1,
      },
    },
    // Top 4 edges (Z = 100)
    {
      bodyId: 'main-body',
      edgeIndex: 4,
      runtimeId: 'brep_edge_main-body_4',
      curveType: 'line',
      length: 100,
      startPoint: { x: 0, y: 0, z: 100 },
      endPoint: { x: 100, y: 0, z: 100 },
      direction: { x: 1, y: 0, z: 0 },
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 4,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        length: 100,
        bodyId: 'main-body',
        generation: 1,
      },
    },
    {
      bodyId: 'main-body',
      edgeIndex: 5,
      runtimeId: 'brep_edge_main-body_5',
      curveType: 'line',
      length: 100,
      startPoint: { x: 100, y: 0, z: 100 },
      endPoint: { x: 100, y: 100, z: 100 },
      direction: { x: 0, y: 1, z: 0 },
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 5,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        length: 100,
        bodyId: 'main-body',
        generation: 1,
      },
    },
    {
      bodyId: 'main-body',
      edgeIndex: 6,
      runtimeId: 'brep_edge_main-body_6',
      curveType: 'line',
      length: 100,
      startPoint: { x: 100, y: 100, z: 100 },
      endPoint: { x: 0, y: 100, z: 100 },
      direction: { x: -1, y: 0, z: 0 },
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 6,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        length: 100,
        bodyId: 'main-body',
        generation: 1,
      },
    },
    {
      bodyId: 'main-body',
      edgeIndex: 7,
      runtimeId: 'brep_edge_main-body_7',
      curveType: 'line',
      length: 100,
      startPoint: { x: 0, y: 100, z: 100 },
      endPoint: { x: 0, y: 0, z: 100 },
      direction: { x: 0, y: -1, z: 0 },
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 7,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        length: 100,
        bodyId: 'main-body',
        generation: 1,
      },
    },
    // Vertical 4 edges (Z: 0 -> 100)
    {
      bodyId: 'main-body',
      edgeIndex: 8,
      runtimeId: 'brep_edge_main-body_8',
      curveType: 'line',
      length: 100,
      startPoint: { x: 0, y: 0, z: 0 },
      endPoint: { x: 0, y: 0, z: 100 },
      direction: { x: 0, y: 0, z: 1 },
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 8,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        length: 100,
        bodyId: 'main-body',
        generation: 1,
      },
    },
    {
      bodyId: 'main-body',
      edgeIndex: 9,
      runtimeId: 'brep_edge_main-body_9',
      curveType: 'line',
      length: 100,
      startPoint: { x: 100, y: 0, z: 0 },
      endPoint: { x: 100, y: 0, z: 100 },
      direction: { x: 0, y: 0, z: 1 },
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 9,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        length: 100,
        bodyId: 'main-body',
        generation: 1,
      },
    },
    {
      bodyId: 'main-body',
      edgeIndex: 10,
      runtimeId: 'brep_edge_main-body_10',
      curveType: 'line',
      length: 100,
      startPoint: { x: 100, y: 100, z: 0 },
      endPoint: { x: 100, y: 100, z: 100 },
      direction: { x: 0, y: 0, z: 1 },
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 10,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        length: 100,
        bodyId: 'main-body',
        generation: 1,
      },
    },
    {
      bodyId: 'main-body',
      edgeIndex: 11,
      runtimeId: 'brep_edge_main-body_11',
      curveType: 'line',
      length: 100,
      startPoint: { x: 0, y: 100, z: 0 },
      endPoint: { x: 0, y: 100, z: 100 },
      direction: { x: 0, y: 0, z: 1 },
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 11,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        length: 100,
        bodyId: 'main-body',
        generation: 1,
      },
    },
  ];

  // 6 個面 (Box 6 faces)
  const brepFaces: RuntimeBRepFaceRef[] = [
    {
      faceIndex: 0,
      surfaceType: 'plane',
      normal: { x: 0, y: 0, z: 1 },
      centroid: { x: 50, y: 50, z: 100 },
      area: 10000,
      topoRef: {
        kind: 'FACE',
        faceIndex: 0,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        surfaceType: 'plane',
        normalAtCentroid: { x: 0, y: 0, z: 1 },
        centroid: { x: 50, y: 50, z: 100 },
        area: 10000,
        bodyId: 'main-body',
        generation: 1,
      },
    },
  ];

  const meshEdgeToBRepEdgeIndex = new Int32Array(12);
  for (let i = 0; i < 12; i++) {
    meshEdgeToBRepEdgeIndex[i] = i;
  }

  return {
    bodyId: 'main-body',
    generation: 1,
    faces: brepFaces,
    edges: brepEdges,
    vertices: [],
    triangleToFaceIndex: new Int32Array([0, 0]),
    meshEdgeToBRepEdgeIndex,
    meshVertexToBRepVertexIndex: new Int32Array([]),
  };
}

// -------------------------------------------------------------
// Test 1: 3D-42 Edge Resolution Pipeline (Mesh Edge -> B-Rep Edge)
// -------------------------------------------------------------
test('3D-42 Edge Pipeline: resolveMeshEdgeToEdge maps every Box edge (0..11) to exact RuntimeBRepEdgeRef', () => {
  const mapping = createMockBoxMapping();

  for (let i = 0; i < 12; i++) {
    const result = resolveMeshEdgeToEdge(mapping, i);
    assert.strictEqual(result.status, 'exact');
    assert.ok(result.edgeRef);
    assert.strictEqual(result.edgeRef.edgeIndex, i);
    assert.strictEqual(result.edgeRef.length, 100);
    assert.strictEqual(result.edgeRef.curveType, 'line');
    assert.strictEqual(result.edgeRef.topoRef?.kind, 'EDGE');
    assert.strictEqual(result.edgeRef.topoRef?.edgeIndex, i);
    assert.strictEqual(result.edgeRef.runtimeId, `brep_edge_main-body_${i}`);
  }
});

// -------------------------------------------------------------
// Test 2: Edge Selection Isolation (Must NOT resolve to Face or Body)
// -------------------------------------------------------------
test('3D-42 Edge Pipeline: Edge selection strictly resolves as kind: "edge" and never converts into Face', () => {
  const mapping = createMockBoxMapping();

  const edgeResult = resolveMeshEdgeToEdge(mapping, 3);
  assert.strictEqual(edgeResult.status, 'exact');
  assert.ok(edgeResult.edgeRef);

  // Use the mesh selection creator
  const resolved = createMeshSelection(mapping, {
    kind: 'edge',
    meshEdgeIndex: 3,
  });

  assert.ok(resolved);
  assert.strictEqual(resolved.kind, 'edge');
  assert.strictEqual(resolved.meshEdgeIndex, 3);
  assert.ok(resolved.edgeRef);
  assert.strictEqual(resolved.edgeRef.edgeIndex, 3);
  assert.strictEqual((resolved as any).faceRef, undefined);
  assert.strictEqual((resolved as any).vertexRef, undefined);
});

// -------------------------------------------------------------
// Test 3: Edge Resolution to Axis (Geometric Properties)
// -------------------------------------------------------------
test('3D-42 Edge Pipeline: resolveBRepEdgeToAxis produces valid 3D axis origin and direction', () => {
  const mapping = createMockBoxMapping();

  // Edge 0: (0,0,0) -> (100,0,0), direction +X
  const edge0 = mapping.edges[0];
  const axis0 = resolveBRepEdgeToAxis(edge0);
  assert.strictEqual(axis0.isValid, true);
  assert.ok(axis0.reference);
  assertPoint3DApprox(axis0.reference.axisOrigin, { x: 0, y: 0, z: 0 });
  assertPoint3DApprox(axis0.reference.axisDirection, { x: 1, y: 0, z: 0 });
  assert.strictEqual(axis0.reference.topoRef?.kind, 'EDGE');

  // Edge 8: (0,0,0) -> (0,0,100), direction +Z
  const edge8 = mapping.edges[8];
  const axis8 = resolveBRepEdgeToAxis(edge8);
  assert.strictEqual(axis8.isValid, true);
  assert.ok(axis8.reference);
  assertPoint3DApprox(axis8.reference.axisOrigin, { x: 0, y: 0, z: 0 });
  assertPoint3DApprox(axis8.reference.axisDirection, { x: 0, y: 0, z: 1 });
});

// -------------------------------------------------------------
// Test 4: Selection State Isolation Logic
// -------------------------------------------------------------
test('3D-42 Edge Pipeline: Selection state maintains mutual exclusivity between Face and Edge', () => {
  const mapping = createMockBoxMapping();
  const edge4 = mapping.edges[4];

  // Simulating store state mutations
  let selectedEdgeInfo: any = null;
  let selectedFaceInfo: any = null;
  let selectedMeshSelection: MeshSelection | null = null;

  const setSelectedEdgeInfo = (edge: any) => {
    selectedEdgeInfo = edge;
    if (edge) {
      selectedFaceInfo = null;
      selectedMeshSelection = {
        kind: 'edge',
        meshEdgeIndex: edge.meshEdgeIndex ?? edge.edgeRef.edgeIndex,
        edgeRef: edge.edgeRef,
        generation: edge.edgeRef.topoRef?.generation ?? 0,
      };
    } else if (selectedMeshSelection?.kind === 'edge') {
      selectedMeshSelection = null;
    }
  };

  const setSelectedFaceInfo = (face: any) => {
    selectedFaceInfo = face;
    if (face) {
      selectedEdgeInfo = null;
      if (face.faceRef) {
        selectedMeshSelection = {
          kind: 'face',
          triangleIndex: face.triangleIndex ?? 0,
          faceRef: face.faceRef,
          generation: face.faceRef.topoRef?.generation ?? 0,
        };
      }
    } else if (selectedMeshSelection?.kind === 'face') {
      selectedMeshSelection = null;
    }
  };

  // Step 1: Select Edge 4
  setSelectedEdgeInfo({
    edgeRef: edge4,
    startPoint: edge4.startPoint!,
    endPoint: edge4.endPoint!,
    meshEdgeIndex: 4,
  });

  assert.ok(selectedEdgeInfo);
  assert.strictEqual(selectedEdgeInfo.edgeRef.edgeIndex, 4);
  assert.strictEqual(selectedFaceInfo, null);
  assert.strictEqual(selectedMeshSelection?.kind, 'edge');

  // Step 2: Select Face 0 -> edge selection is cleared
  setSelectedFaceInfo({
    point: { x: 50, y: 50, z: 100 },
    normal: { x: 0, y: 0, z: 1 },
    triangleIndex: 0,
    faceRef: mapping.faces[0],
  });

  assert.strictEqual(selectedEdgeInfo, null);
  assert.ok(selectedFaceInfo);
  assert.strictEqual(selectedMeshSelection?.kind, 'face');

  // Step 3: Select Edge 8 -> face selection is cleared
  const edge8 = mapping.edges[8];
  setSelectedEdgeInfo({
    edgeRef: edge8,
    startPoint: edge8.startPoint!,
    endPoint: edge8.endPoint!,
    meshEdgeIndex: 8,
  });

  assert.strictEqual(selectedFaceInfo, null);
  assert.ok(selectedEdgeInfo);
  assert.strictEqual(selectedEdgeInfo.edgeRef.edgeIndex, 8);
  assert.strictEqual(selectedMeshSelection?.kind, 'edge');
});

// -------------------------------------------------------------
// Test 5: Out of bounds & Generation Mismatch Safety
// -------------------------------------------------------------
test('3D-42 Edge Pipeline: Out of bounds and generation mismatches are handled gracefully', () => {
  const mapping = createMockBoxMapping();

  // Negative index
  const oobNegative = resolveMeshEdgeToEdge(mapping, -1);
  assert.strictEqual(oobNegative.status, 'unresolved');
  assert.strictEqual(oobNegative.edgeRef, null);

  // Large index
  const oobLarge = resolveMeshEdgeToEdge(mapping, 999);
  assert.strictEqual(oobLarge.status, 'unresolved');
  assert.strictEqual(oobLarge.edgeRef, null);

  // Generation mismatch
  const genMismatch = resolveMeshEdgeToEdge(mapping, 0, 99);
  assert.strictEqual(genMismatch.status, 'generation_mismatch');
  assert.strictEqual(genMismatch.edgeRef, null);
});
