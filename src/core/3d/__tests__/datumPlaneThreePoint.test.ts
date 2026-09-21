import test from 'node:test';
import assert from 'node:assert';
import {
  createThreePointPlane,
  validateThreePoints,
  orthogonalizePlane,
  map2DTo3DWorld,
  project3DTo2DPlane,
  sub3D,
  dot3D,
  length3D,
} from '../DatumPlaneEngine';
import { Point3D, CustomPlane } from '../../../types/cad';

function approxEqual(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

function assertPoint3DApprox(p: Point3D, expected: { x: number; y: number; z: number }, eps = 1e-5) {
  assert.ok(
    approxEqual(p.x, expected.x, eps) &&
      approxEqual(p.y, expected.y, eps) &&
      approxEqual(p.z, expected.z, eps),
    `Point (${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}) is not close to expected (${expected.x}, ${expected.y}, ${expected.z})`
  );
}

// Test 1: Standard XY Plane from 3 orthogonal points
test('Test 1: Standard XY Plane from (0,0,0), (100,0,0), (0,100,0)', () => {
  const p1 = { x: 0, y: 0, z: 0 };
  const p2 = { x: 100, y: 0, z: 0 };
  const p3 = { x: 0, y: 100, z: 0 };

  const plane = createThreePointPlane(p1, p2, p3, 'XY Plane');

  assertPoint3DApprox(plane.origin, { x: 0, y: 0, z: 0 });
  assertPoint3DApprox(plane.xAxis, { x: 1, y: 0, z: 0 });
  assertPoint3DApprox(plane.yAxis, { x: 0, y: 1, z: 0 });
  assertPoint3DApprox(plane.normal, { x: 0, y: 0, z: 1 });
});

// Test 2: Tilted Plane (45 degrees about X axis)
test('Test 2: Tilted Plane from (0,0,0), (100,0,0), (0,100,100)', () => {
  const p1 = { x: 0, y: 0, z: 0 };
  const p2 = { x: 100, y: 0, z: 0 };
  const p3 = { x: 0, y: 100, z: 100 };

  const plane = createThreePointPlane(p1, p2, p3, 'Tilted Plane 45deg');

  const invSqrt2 = Math.SQRT1_2;
  assertPoint3DApprox(plane.origin, { x: 0, y: 0, z: 0 });
  assertPoint3DApprox(plane.xAxis, { x: 1, y: 0, z: 0 });
  // Normal is perpendicular to (1,0,0) and (0,1,1) -> (0, -1, 1)/sqrt(2)
  assertPoint3DApprox(plane.normal, { x: 0, y: -invSqrt2, z: invSqrt2 });
  // yAxis = normal x xAxis = (0, -1/sqrt(2), 1/sqrt(2)) x (1, 0, 0) = (0, 1/sqrt(2), 1/sqrt(2))
  assertPoint3DApprox(plane.yAxis, { x: 0, y: invSqrt2, z: invSqrt2 });
});

// Test 3: Offset Origin 3 Points
test('Test 3: Offset Origin 3 Points at (10, 20, 30)', () => {
  const p1 = { x: 10, y: 20, z: 30 };
  const p2 = { x: 110, y: 20, z: 30 };
  const p3 = { x: 10, y: 120, z: 30 };

  const plane = createThreePointPlane(p1, p2, p3, 'Offset Origin Plane');

  assertPoint3DApprox(plane.origin, { x: 10, y: 20, z: 30 });
  assertPoint3DApprox(plane.xAxis, { x: 1, y: 0, z: 0 });
  assertPoint3DApprox(plane.yAxis, { x: 0, y: 1, z: 0 });
  assertPoint3DApprox(plane.normal, { x: 0, y: 0, z: 1 });
});

// Test 4: Validation rejects collinear points
test('Test 4: Validation rejects collinear points', () => {
  const p1 = { x: 0, y: 0, z: 0 };
  const p2 = { x: 10, y: 0, z: 0 };
  const p3 = { x: 50, y: 0, z: 0 };

  const validation = validateThreePoints(p1, p2, p3);
  assert.strictEqual(validation.isValid, false);
  assert.ok(validation.error?.includes('共線'));

  assert.throws(() => {
    createThreePointPlane(p1, p2, p3);
  }, /共線|Invalid/);
});

// Test 5: Validation rejects coincident / duplicate points
test('Test 5: Validation rejects coincident points', () => {
  const p1 = { x: 10, y: 20, z: 30 };
  const p2 = { x: 10, y: 20, z: 30 };
  const p3 = { x: 50, y: 80, z: 90 };

  const validation = validateThreePoints(p1, p2, p3);
  assert.strictEqual(validation.isValid, false);
  assert.ok(validation.error?.includes('重合'));

  assert.throws(() => {
    createThreePointPlane(p1, p2, p3);
  }, /重合|Invalid/);
});

// Test 6: Orthonormality check (Gram-Schmidt verification)
test('Test 6: Orthonormality of arbitrary 3-point plane', () => {
  const p1 = { x: 12.3, y: -45.6, z: 78.9 };
  const p2 = { x: 98.7, y: 65.4, z: -32.1 };
  const p3 = { x: -11.1, y: 22.2, z: 33.3 };

  const plane = createThreePointPlane(p1, p2, p3, 'Arbitrary 3D Plane');

  // Length of unit vectors must be 1.0
  assert.ok(approxEqual(length3D(plane.xAxis), 1.0));
  assert.ok(approxEqual(length3D(plane.yAxis), 1.0));
  assert.ok(approxEqual(length3D(plane.normal), 1.0));

  // Dot products between distinct axes must be 0
  assert.ok(approxEqual(dot3D(plane.xAxis, plane.yAxis), 0.0));
  assert.ok(approxEqual(dot3D(plane.xAxis, plane.normal), 0.0));
  assert.ok(approxEqual(dot3D(plane.yAxis, plane.normal), 0.0));
});

// Test 7: All three points lie exactly on the plane (distance = 0)
test('Test 7: All 3 defining points lie exactly on the generated plane', () => {
  const p1 = { x: 15, y: -25, z: 40 };
  const p2 = { x: 80, y: 50, z: -10 };
  const p3 = { x: -30, y: 60, z: 95 };

  const plane = createThreePointPlane(p1, p2, p3);

  const dist1 = Math.abs(dot3D(plane.normal, sub3D(p1, plane.origin)));
  const dist2 = Math.abs(dot3D(plane.normal, sub3D(p2, plane.origin)));
  const dist3 = Math.abs(dot3D(plane.normal, sub3D(p3, plane.origin)));

  assert.ok(approxEqual(dist1, 0, 1e-6));
  assert.ok(approxEqual(dist2, 0, 1e-6));
  assert.ok(approxEqual(dist3, 0, 1e-6));
});

// Test 8: 2D LCS coordinate projection for defining points
test('Test 8: 2D LCS projection of defining points', () => {
  const p1 = { x: 0, y: 0, z: 0 };
  const p2 = { x: 50, y: 0, z: 0 };
  const p3 = { x: 0, y: 30, z: 0 };

  const plane = createThreePointPlane(p1, p2, p3);

  const lcs1 = project3DTo2DPlane(p1, plane);
  const lcs2 = project3DTo2DPlane(p2, plane);
  const lcs3 = project3DTo2DPlane(p3, plane);

  // P1 is origin -> (0, 0)
  assert.ok(approxEqual(lcs1.x, 0) && approxEqual(lcs1.y, 0));
  // P2 is on xAxis -> (50, 0)
  assert.ok(approxEqual(lcs2.x, 50) && approxEqual(lcs2.y, 0));
  // P3 is on yAxis -> (0, 30)
  assert.ok(approxEqual(lcs3.x, 0) && approxEqual(lcs3.y, 30));
});

// Test 9: Swap P2 and P3 flips normal orientation
test('Test 9: Swap P2 and P3 flips normal direction', () => {
  const p1 = { x: 0, y: 0, z: 0 };
  const pA = { x: 100, y: 0, z: 0 };
  const pB = { x: 0, y: 100, z: 0 };

  const planeForward = createThreePointPlane(p1, pA, pB);
  const planeReversed = createThreePointPlane(p1, pB, pA);

  assertPoint3DApprox(planeForward.normal, { x: 0, y: 0, z: 1 });
  assertPoint3DApprox(planeReversed.normal, { x: 0, y: 0, z: -1 });
});

// Test 10: 3D Diagonal Cube Plane
test('Test 10: 3D Diagonal Cube Plane from (100,0,0), (0,100,0), (0,0,100)', () => {
  const p1 = { x: 100, y: 0, z: 0 };
  const p2 = { x: 0, y: 100, z: 0 };
  const p3 = { x: 0, y: 0, z: 100 };

  const plane = createThreePointPlane(p1, p2, p3, 'Diagonal Cut Plane');

  // Normal to x+y+z = 100 is (1, 1, 1)/sqrt(3)
  const invSqrt3 = 1 / Math.sqrt(3);
  assertPoint3DApprox(plane.normal, { x: invSqrt3, y: invSqrt3, z: invSqrt3 });
  assertPoint3DApprox(plane.origin, { x: 100, y: 0, z: 0 });
});
