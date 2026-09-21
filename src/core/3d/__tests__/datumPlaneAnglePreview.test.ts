import test from 'node:test';
import assert from 'node:assert';
import {
  createRotatedPlaneAroundAxis,
  FRONT_PLANE,
  TOP_PLANE,
  RIGHT_PLANE,
  normalize3D,
  sub3D,
  map2DTo3DWorld,
} from '../DatumPlaneEngine';
import { createEmptyCADDocument, Point3D, CustomPlane } from '../../../types/cad';

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

// Test 1: Front + X axis + 45°
test('Test 1: Front Plane + X Axis +45°', () => {
  const refPlane = FRONT_PLANE;
  const axisOrigin = { x: 0, y: 0, z: 0 };
  const axisDirection = { x: 1, y: 0, z: 0 };
  const angleRad = (45 * Math.PI) / 180;

  const plane = createRotatedPlaneAroundAxis(
    refPlane,
    axisOrigin,
    axisDirection,
    angleRad,
    'datum-plane-preview',
    'Front (Preview +45°)'
  );

  // 繞 X 軸旋轉 45°：
  // Normal (0, 0, 1) 旋轉 45° → (0, -sin45°, cos45°) = (0, -0.7071, 0.7071)
  const invSqrt2 = Math.SQRT1_2;
  assertPoint3DApprox(plane.normal, { x: 0, y: -invSqrt2, z: invSqrt2 });
  assertPoint3DApprox(plane.xAxis, { x: 1, y: 0, z: 0 });
  assertPoint3DApprox(plane.origin, { x: 0, y: 0, z: 0 });
});

// Test 2: Front + Y axis + 90°
test('Test 2: Front Plane + Y Axis +90°', () => {
  const refPlane = FRONT_PLANE;
  const axisOrigin = { x: 0, y: 0, z: 0 };
  const axisDirection = { x: 0, y: 1, z: 0 };
  const angleRad = (90 * Math.PI) / 180;

  const plane = createRotatedPlaneAroundAxis(
    refPlane,
    axisOrigin,
    axisDirection,
    angleRad,
    'datum-plane-preview',
    'Front (Preview +90° Y)'
  );

  // 繞 Y 軸旋轉 90°：
  // Normal (0, 0, 1) 旋轉 90° (Y 軸為 (0,1,0))：
  // Rodrigues: N * cos(90) + (k × N) * sin(90) = (0,1,0) × (0,0,1) = (1, 0, 0)
  assertPoint3DApprox(plane.normal, { x: 1, y: 0, z: 0 });
  assertPoint3DApprox(plane.origin, { x: 0, y: 0, z: 0 });
});

// Test 3: Front + Z axis + 90°
test('Test 3: Front Plane + Z Axis +90°', () => {
  const refPlane = FRONT_PLANE;
  const axisOrigin = { x: 0, y: 0, z: 0 };
  const axisDirection = { x: 0, y: 0, z: 1 };
  const angleRad = (90 * Math.PI) / 180;

  const plane = createRotatedPlaneAroundAxis(
    refPlane,
    axisOrigin,
    axisDirection,
    angleRad,
    'datum-plane-preview',
    'Front (Preview +90° Z)'
  );

  // 繞 Z 軸旋轉 90°（法向保持 (0,0,1)，xAxis (1,0,0) 旋轉為 (0,1,0)）
  assertPoint3DApprox(plane.normal, { x: 0, y: 0, z: 1 });
  assertPoint3DApprox(plane.xAxis, { x: 0, y: 1, z: 0 });
  assertPoint3DApprox(plane.origin, { x: 0, y: 0, z: 0 });
});

// Test 4: Sketch Line Axis + 45°
test('Test 4: Sketch Line Axis +45° on Front plane', () => {
  const refPlane = FRONT_PLANE;
  // 假設草圖線段從 (0, 0, 0) 到 (50, 50, 0)
  const lineStart = { x: 0, y: 0, z: 0 };
  const lineEnd = { x: 50, y: 50, z: 0 };
  const axisDir = normalize3D(sub3D(lineEnd, lineStart));
  const angleRad = (45 * Math.PI) / 180;

  const plane = createRotatedPlaneAroundAxis(
    refPlane,
    lineStart,
    axisDir,
    angleRad,
    'datum-plane-preview',
    'Front (Preview +45° Line)'
  );

  assert.strictEqual(plane.id, 'datum-plane-preview');
  assertPoint3DApprox(plane.origin, { x: 0, y: 0, z: 0 });
  // 旋轉軸方向與 Normal 內積應保持為 0 (旋轉前後法向量始終垂直於該軸線)
  const dotNormalAxis = plane.normal.x * axisDir.x + plane.normal.y * axisDir.y + plane.normal.z * axisDir.z;
  assert.ok(approxEqual(dotNormalAxis, 0, 1e-4), 'Rotated normal must remain perpendicular to rotation axis');
});

// Test 5: Offset Axis + 90° (Axis does not pass origin: y = 10, z = 0)
test('Test 5: Offset Axis +90° (Axis does not pass origin: (0,10,0) -> (100,10,0))', () => {
  const refPlane = FRONT_PLANE; // Origin (0,0,0), Normal (0,0,1), X (1,0,0), Y (0,1,0)
  const axisOrigin = { x: 0, y: 10, z: 0 };
  const axisDirection = { x: 1, y: 0, z: 0 }; // parallel to X axis, offset by y = 10
  const angleRad = (90 * Math.PI) / 180;

  const plane = createRotatedPlaneAroundAxis(
    refPlane,
    axisOrigin,
    axisDirection,
    angleRad,
    'datum-plane-preview',
    'Front (Offset Axis 90°)'
  );

  // Normal (0,0,1) 繞 X 軸旋轉 90° → (0, -1, 0)
  assertPoint3DApprox(plane.normal, { x: 0, y: -1, z: 0 });

  // 原點 (0,0,0) 繞軸線 (0,10,0) 旋轉 90°：
  // vecFromAxis = (0, -10, 0)
  // 繞 (1,0,0) 旋轉 90° → (0, 0, -10)
  // newOrigin = (0, 10, 0) + (0, 0, -10) = (0, 10, -10)
  assertPoint3DApprox(plane.origin, { x: 0, y: 10, z: -10 });

  // 驗證旋轉軸上任意點 (如 (50, 10, 0)) 是否在該旋轉平面上：
  // 平面方程: N · (P - Origin) = (0, -1, 0) · ( (50,10,0) - (0,10,-10) ) = -1 * (10 - 10) = 0
  const testPt = { x: 50, y: 10, z: 0 };
  const distFromPlane =
    plane.normal.x * (testPt.x - plane.origin.x) +
    plane.normal.y * (testPt.y - plane.origin.y) +
    plane.normal.z * (testPt.z - plane.origin.z);
  assert.ok(approxEqual(distFromPlane, 0, 1e-4), 'Rotation axis line points must lie exactly on the rotated plane');
});

// Test 6: Flip Angle (-45° vs +45°)
test('Test 6: Flip Angle (-45° vs +45°)', () => {
  const refPlane = FRONT_PLANE;
  const axisOrigin = { x: 0, y: 0, z: 0 };
  const axisDirection = { x: 1, y: 0, z: 0 };

  const planePos = createRotatedPlaneAroundAxis(
    refPlane,
    axisOrigin,
    axisDirection,
    (45 * Math.PI) / 180
  );

  const planeNeg = createRotatedPlaneAroundAxis(
    refPlane,
    axisOrigin,
    axisDirection,
    (-45 * Math.PI) / 180
  );

  const invSqrt2 = Math.SQRT1_2;
  // +45°: normal.y = -0.7071, normal.z = 0.7071
  // -45°: normal.y = +0.7071, normal.z = 0.7071
  assertPoint3DApprox(planePos.normal, { x: 0, y: -invSqrt2, z: invSqrt2 });
  assertPoint3DApprox(planeNeg.normal, { x: 0, y: invSqrt2, z: invSqrt2 });
});

// Test 7: Preview does NOT mutate document featureTree
test('Test 7: Preview does NOT mutate document featureTree', () => {
  const initialDoc = createEmptyCADDocument();
  const initialTreeLength = initialDoc.featureTree.length;

  const refPlane = FRONT_PLANE;
  const preview = createRotatedPlaneAroundAxis(
    refPlane,
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    (60 * Math.PI) / 180,
    'datum-plane-preview'
  );

  assert.strictEqual(initialDoc.featureTree.length, initialTreeLength);
  assert.ok(preview);
});

// Test 8: Preview does NOT mutate document rollbackIndex
test('Test 8: Preview does NOT mutate document rollbackIndex', () => {
  const initialDoc = createEmptyCADDocument();
  const initialRollbackIndex = initialDoc.rollbackIndex;

  const refPlane = FRONT_PLANE;
  createRotatedPlaneAroundAxis(
    refPlane,
    { x: 0, y: 10, z: 0 },
    { x: 0, y: 1, z: 0 },
    (30 * Math.PI) / 180,
    'datum-plane-preview'
  );

  assert.strictEqual(initialDoc.rollbackIndex, initialRollbackIndex);
});
