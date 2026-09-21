import test from 'node:test';
import assert from 'node:assert';
import type { Point3D, CustomPlane } from '../../../types/cad';
import type {
  MeshSubshapeMapping,
  RuntimeBRepFaceRef,
  RuntimeBRepEdgeRef,
  RuntimeBRepVertexRef,
} from '../MeshSubshapeMapping.types';
import {
  resolveTriangleToFace,
  resolveMeshEdgeToEdge,
  resolveMeshVertexToVertex,
} from '../MeshSubshapeResolver';
import {
  resolveBRepFaceToReference,
  resolveBRepEdgeToAxis,
  resolveBRepVertexToPoint,
  validateThreePointsSelection,
} from '../UnifiedReferenceResolver';
import {
  createOffsetPlane,
  createRotatedPlaneAroundAxis,
  createThreePointPlane,
  dot3D,
  length3D,
} from '../DatumPlaneEngine';

function approxEqual(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

function assertPoint3DApprox(p: Point3D, expected: { x: number; y: number; z: number }, eps = 1e-4) {
  assert.ok(
    approxEqual(p.x, expected.x, eps) &&
      approxEqual(p.y, expected.y, eps) &&
      approxEqual(p.z, expected.z, eps),
    `Point (${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}) is not close to expected (${expected.x}, ${expected.y}, ${expected.z})`
  );
}

// 建立模擬的 Subshape Mapping (以 100x100x50 長方體為範本)
function createMockSubshapeMapping(): MeshSubshapeMapping {
  const faces: RuntimeBRepFaceRef[] = [
    // Face 0: Top face (Z = 50, normal = +Z)
    {
      faceIndex: 0,
      surfaceType: 'plane',
      normal: { x: 0, y: 0, z: 1 },
      centroid: { x: 50, y: 50, z: 50 },
      area: 10000,
      topoRef: {
        kind: 'FACE',
        faceIndex: 0,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        surfaceType: 'plane',
        normalAtCentroid: { x: 0, y: 0, z: 1 },
        centroid: { x: 50, y: 50, z: 50 },
        area: 10000,
      },
    },
    // Face 1: Cylindrical face
    {
      faceIndex: 1,
      surfaceType: 'cylinder',
      normal: { x: 1, y: 0, z: 0 },
      centroid: { x: 0, y: 50, z: 25 },
      area: 5000,
      topoRef: {
        kind: 'FACE',
        faceIndex: 1,
        featureId: 'revolve-1',
        historyOpIndex: 1,
        surfaceType: 'cylinder',
      },
    },
  ];

  const edges: RuntimeBRepEdgeRef[] = [
    // Edge 0: Along X axis from (0,0,50) to (100,0,50)
    {
      edgeIndex: 0,
      curveType: 'line',
      startPoint: { x: 0, y: 0, z: 50 },
      endPoint: { x: 100, y: 0, z: 50 },
      direction: { x: 1, y: 0, z: 0 },
      length: 100,
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 0,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        startPoint: { x: 0, y: 0, z: 50 },
        endPoint: { x: 100, y: 0, z: 50 },
        length: 100,
      },
    },
    // Edge 1: Degenerate edge
    {
      edgeIndex: 1,
      curveType: 'line',
      startPoint: { x: 10, y: 10, z: 10 },
      endPoint: { x: 10, y: 10, z: 10 },
      direction: { x: 0, y: 1, z: 0 },
      length: 0,
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 1,
        featureId: 'extrude-1',
        historyOpIndex: 0,
      },
    },
  ];

  const vertices: RuntimeBRepVertexRef[] = [
    // Vertex 0: (0, 0, 50)
    {
      vertexIndex: 0,
      point: { x: 0, y: 0, z: 50 },
      topoRef: {
        kind: 'VERTEX',
        vertexIndex: 0,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        point: { x: 0, y: 0, z: 50 },
      },
    },
    // Vertex 1: (100, 0, 50)
    {
      vertexIndex: 1,
      point: { x: 100, y: 0, z: 50 },
      topoRef: {
        kind: 'VERTEX',
        vertexIndex: 1,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        point: { x: 100, y: 0, z: 50 },
      },
    },
    // Vertex 2: (0, 100, 50)
    {
      vertexIndex: 2,
      point: { x: 0, y: 100, z: 50 },
      topoRef: {
        kind: 'VERTEX',
        vertexIndex: 2,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        point: { x: 0, y: 100, z: 50 },
      },
    },
    // Vertex 3: (50, 0, 50) - collinear with Vertex 0 and 1
    {
      vertexIndex: 3,
      point: { x: 50, y: 0, z: 50 },
      topoRef: {
        kind: 'VERTEX',
        vertexIndex: 3,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        point: { x: 50, y: 0, z: 50 },
      },
    },
  ];

  return {
    bodyId: 'body-1',
    generation: 1,
    faces,
    edges,
    vertices,
    triangleToFaceIndex: new Int32Array([0, 0, 0, 0, 1, 1]),
    faceTriangleRanges: [],
    meshEdgeToBRepEdgeIndex: new Int32Array([0, 0, 1]),
    edgeSegmentRanges: [],
    meshVertexToBRepVertexIndex: new Int32Array([0, 1, 2, 3]),
  };
}

// -------------------------------------------------------------------------
// 17 Scenarios
// -------------------------------------------------------------------------

// Scenario 1: Planar B-Rep Face resolves to valid Offset CustomPlane
test('Scenario 1: Planar B-Rep Face resolves to valid CustomPlane with orthonormal axes', () => {
  const mapping = createMockSubshapeMapping();
  const faceRef = mapping.faces[0];
  const res = resolveBRepFaceToReference(faceRef);

  assert.strictEqual(res.isValid, true);
  assert.ok(res.reference);
  assert.strictEqual(res.reference.kind, 'face');
  assert.strictEqual(res.reference.source, 'brep_face');

  const plane = res.reference.plane;
  assertPoint3DApprox(plane.origin, { x: 50, y: 50, z: 50 });
  assertPoint3DApprox(plane.normal, { x: 0, y: 0, z: 1 });

  // Normal should be orthogonal to xAxis and yAxis
  assert.ok(Math.abs(dot3D(plane.normal, plane.xAxis)) < 1e-6);
  assert.ok(Math.abs(dot3D(plane.normal, plane.yAxis)) < 1e-6);
  assert.ok(Math.abs(dot3D(plane.xAxis, plane.yAxis)) < 1e-6);
});

// Scenario 2: Non-planar B-Rep Face (cylinder/sphere) is rejected
test('Scenario 2: Non-planar B-Rep Face is rejected with descriptive error message', () => {
  const mapping = createMockSubshapeMapping();
  const cylFace = mapping.faces[1];
  const res = resolveBRepFaceToReference(cylFace);

  assert.strictEqual(res.isValid, false);
  assert.ok(res.error?.includes('非平面'));
});

// Scenario 3: Planar B-Rep Face centroid vs hitPoint fallback
test('Scenario 3: Planar B-Rep Face uses centroid first; falls back to hitPoint if centroid absent', () => {
  const faceWithoutCentroid: RuntimeBRepFaceRef = {
    faceIndex: 5,
    surfaceType: 'plane',
    normal: { x: 0, y: 1, z: 0 },
    area: 200,
    topoRef: { kind: 'FACE', faceIndex: 5, featureId: 'f1', historyOpIndex: 0 },
  };

  const hitPoint = { x: 12, y: 34, z: 56 };
  const res = resolveBRepFaceToReference(faceWithoutCentroid, hitPoint);

  assert.strictEqual(res.isValid, true);
  assertPoint3DApprox(res.reference!.plane.origin, hitPoint);
});

// Scenario 4: Degenerate zero-length face normal is rejected
test('Scenario 4: Degenerate zero-length face normal is rejected', () => {
  const degenFace: RuntimeBRepFaceRef = {
    faceIndex: 6,
    surfaceType: 'plane',
    normal: { x: 0, y: 0, z: 0 },
    topoRef: { kind: 'FACE', faceIndex: 6, featureId: 'f1', historyOpIndex: 0 },
  };

  const res = resolveBRepFaceToReference(degenFace);
  assert.strictEqual(res.isValid, false);
  assert.ok(res.error?.includes('幾何法向量無效'));
});

// Scenario 5: TopoReference of Face is preserved for persistent parametric reference
test('Scenario 5: Face TopoReference is preserved accurately', () => {
  const mapping = createMockSubshapeMapping();
  const faceRef = mapping.faces[0];
  const res = resolveBRepFaceToReference(faceRef);

  assert.strictEqual(res.reference?.topoRef?.kind, 'FACE');
  assert.strictEqual(res.reference?.topoRef?.faceIndex, 0);
  assert.strictEqual(res.reference?.topoRef?.featureId, 'extrude-1');
});

// Scenario 6: Triangle index resolves to B-Rep Face via resolveTriangleToFace
test('Scenario 6: Triangle index resolves to B-Rep Face via mapping LUT', () => {
  const mapping = createMockSubshapeMapping();
  const result = resolveTriangleToFace(mapping, 2);

  assert.strictEqual(result.status, 'exact');
  assert.ok(result.faceRef);
  assert.strictEqual(result.faceRef.faceIndex, 0);
});

// Scenario 7: Out-of-bounds triangle index returns unresolved
test('Scenario 7: Out-of-bounds triangle index returns unresolved status', () => {
  const mapping = createMockSubshapeMapping();
  const resNeg = resolveTriangleToFace(mapping, -1);
  assert.strictEqual(resNeg.status, 'unresolved');

  const resOver = resolveTriangleToFace(mapping, 999);
  assert.strictEqual(resOver.status, 'unresolved');
});

// Scenario 8: Generation mismatch returns generation_mismatch status
test('Scenario 8: Generation mismatch returns generation_mismatch status', () => {
  const mapping = createMockSubshapeMapping();
  const result = resolveTriangleToFace(mapping, 0, 99);

  assert.strictEqual(result.status, 'generation_mismatch');
  assert.strictEqual(result.faceRef, null);
});

// Scenario 9: B-Rep Edge resolves to valid Rotation Axis
test('Scenario 9: B-Rep Edge resolves to valid Rotation Axis with origin = startPoint', () => {
  const mapping = createMockSubshapeMapping();
  const edgeRef = mapping.edges[0];
  const res = resolveBRepEdgeToAxis(edgeRef);

  assert.strictEqual(res.isValid, true);
  assert.ok(res.reference);
  assert.strictEqual(res.reference.kind, 'edge');

  // Axis origin must strictly match start point
  assertPoint3DApprox(res.reference.axisOrigin, { x: 0, y: 0, z: 50 });
  assertPoint3DApprox(res.reference.axisDirection, { x: 1, y: 0, z: 0 });
});

// Scenario 10: Degenerate B-Rep Edge with valid fallback direction
test('Scenario 10: Degenerate B-Rep Edge uses fallback direction if valid', () => {
  const mapping = createMockSubshapeMapping();
  const degenEdge = mapping.edges[1]; // start == end, but direction is (0,1,0)
  const res = resolveBRepEdgeToAxis(degenEdge);

  assert.strictEqual(res.isValid, true);
  assertPoint3DApprox(res.reference!.axisDirection, { x: 0, y: 1, z: 0 });
});

// Scenario 11: TopoReference of Edge is preserved
test('Scenario 11: Edge TopoReference is preserved accurately', () => {
  const mapping = createMockSubshapeMapping();
  const edgeRef = mapping.edges[0];
  const res = resolveBRepEdgeToAxis(edgeRef);

  assert.strictEqual(res.reference?.topoRef?.kind, 'EDGE');
  assert.strictEqual(res.reference?.topoRef?.edgeIndex, 0);
  assert.strictEqual(res.reference?.topoRef?.featureId, 'extrude-1');
});

// Scenario 12: Mesh edge segment resolves via resolveMeshEdgeToEdge
test('Scenario 12: Mesh edge segment resolves accurately to B-Rep Edge', () => {
  const mapping = createMockSubshapeMapping();
  const res = resolveMeshEdgeToEdge(mapping, 0);

  assert.strictEqual(res.status, 'exact');
  assert.ok(res.edgeRef);
  assert.strictEqual(res.edgeRef.edgeIndex, 0);
});

// Scenario 13: B-Rep Vertex resolves to exact 3D Point with targetIndex
test('Scenario 13: B-Rep Vertex resolves to 3D Point preserving targetIndex', () => {
  const mapping = createMockSubshapeMapping();
  const vRef = mapping.vertices[0];
  const res = resolveBRepVertexToPoint(vRef, 1);

  assert.strictEqual(res.kind, 'vertex');
  assert.strictEqual(res.targetIndex, 1);
  assertPoint3DApprox(res.point, { x: 0, y: 0, z: 50 });
  assert.strictEqual(res.topoRef?.vertexIndex, 0);
});

// Scenario 14: Three consecutive vertex picks generate valid 3-Point Datum Plane
test('Scenario 14: Three non-collinear vertex picks generate orthonormal 3-Point Plane', () => {
  const mapping = createMockSubshapeMapping();
  const p1 = resolveBRepVertexToPoint(mapping.vertices[0], 1).point; // (0,0,50)
  const p2 = resolveBRepVertexToPoint(mapping.vertices[1], 2).point; // (100,0,50)
  const p3 = resolveBRepVertexToPoint(mapping.vertices[2], 3).point; // (0,100,50)

  const val = validateThreePointsSelection(p1, p2, p3);
  assert.strictEqual(val.isValid, true);

  const plane = createThreePointPlane(p1, p2, p3, 'Vertex Datum Plane');
  assertPoint3DApprox(plane.origin, { x: 0, y: 0, z: 50 });
  assertPoint3DApprox(plane.xAxis, { x: 1, y: 0, z: 0 });
  assertPoint3DApprox(plane.yAxis, { x: 0, y: 1, z: 0 });
  assertPoint3DApprox(plane.normal, { x: 0, y: 0, z: 1 });
});

// Scenario 15: Collinear vertex picks are rejected
test('Scenario 15: Collinear vertex picks fail validation gracefully', () => {
  const mapping = createMockSubshapeMapping();
  const p1 = mapping.vertices[0].point; // (0,0,50)
  const p2 = mapping.vertices[3].point; // (50,0,50)
  const p3 = mapping.vertices[1].point; // (100,0,50)

  const val = validateThreePointsSelection(p1, p2, p3);
  assert.strictEqual(val.isValid, false);
  assert.ok(val.error?.includes('共線'));
});

// Scenario 16: Coincident vertex picks are rejected
test('Scenario 16: Coincident vertex picks fail validation', () => {
  const mapping = createMockSubshapeMapping();
  const p1 = mapping.vertices[0].point;
  const p2 = mapping.vertices[0].point; // duplicate
  const p3 = mapping.vertices[2].point;

  const val = validateThreePointsSelection(p1, p2, p3);
  assert.strictEqual(val.isValid, false);
});

// Scenario 17: Full pipeline integration of Offset, Angle, and Three-Point
test('Scenario 17: Full pipeline integration produces consistent planes across all 3 modes', () => {
  const mapping = createMockSubshapeMapping();

  // Mode 1: Offset Plane from 3D Face Reference
  const faceRes = resolveBRepFaceToReference(mapping.faces[0]);
  assert.strictEqual(faceRes.isValid, true);
  const offsetPlane = createOffsetPlane(faceRes.reference!.plane, 25, 'offset-dp-1', 'Offset +25');
  assertPoint3DApprox(offsetPlane.origin, { x: 50, y: 50, z: 75 });
  assertPoint3DApprox(offsetPlane.normal, { x: 0, y: 0, z: 1 });

  // Mode 2: Angle Plane rotated 90 deg around 3D B-Rep Edge Reference
  const edgeRes = resolveBRepEdgeToAxis(mapping.edges[0]);
  assert.strictEqual(edgeRes.isValid, true);
  const anglePlane = createRotatedPlaneAroundAxis(
    faceRes.reference!.plane,
    edgeRes.reference!.axisOrigin,
    edgeRes.reference!.axisDirection,
    Math.PI / 2,
    'angle-dp-1',
    'Rotated 90'
  );
  // Rotated 90 deg around X-axis: normal (0,0,1) -> (0,-1,0)
  assertPoint3DApprox(anglePlane.normal, { x: 0, y: -1, z: 0 });

  // Mode 3: Three-Point Plane from 3 resolved vertices
  const v1 = resolveBRepVertexToPoint(mapping.vertices[0]).point;
  const v2 = resolveBRepVertexToPoint(mapping.vertices[1]).point;
  const v3 = resolveBRepVertexToPoint(mapping.vertices[2]).point;
  const threePtPlane = createThreePointPlane(v1, v2, v3, 'Three-Point 3D');
  assertPoint3DApprox(threePtPlane.normal, { x: 0, y: 0, z: 1 });
});
