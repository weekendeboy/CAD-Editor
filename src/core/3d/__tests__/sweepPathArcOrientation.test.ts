import test from 'node:test';
import assert from 'node:assert';
import { getArcMidPoint } from '../../2d/GeometryMath';
import { buildFeatureEvalOps } from '../FeaturePipelineAdapter';
import type {
  ArcEntity,
  SketchFeature,
  SweepFeature,
  CircleEntity,
} from '../../../types/cad';
import {
  DatumFrontPlane,
  DatumTopPlane,
} from '../../../types/cad';

function approxEqual(a: number, b: number, eps = 1e-3): boolean {
  return Math.abs(a - b) < eps;
}

test('Sweep Path Arc Orientation: S-Curve tangent arcs compute exact minor arc midpoints', () => {
  // Arc 1: CCW Arc (0,0) -> (50,50), Center (0,50), Radius 50
  // startAngle = -PI/2 (or 3PI/2), endAngle = 0, clockwise = false
  const arc1: ArcEntity = {
    id: 'arc-1',
    type: 'arc',
    center: { x: 0, y: 50 },
    radius: 50,
    startAngle: -Math.PI / 2,
    endAngle: 0,
    clockwise: false,
    color: '#000',
    selected: false,
  };

  const mid1 = getArcMidPoint(arc1);
  // Mid point 1 should be at angle -PI/4: (0 + 50*cos(-PI/4), 50 + 50*sin(-PI/4)) = (35.355, 14.645)
  assert.ok(
    approxEqual(mid1.x, 35.355),
    `Arc 1 midX should be ~35.355, got ${mid1.x}`
  );
  assert.ok(
    approxEqual(mid1.y, 14.645),
    `Arc 1 midY should be ~14.645, got ${mid1.y}`
  );

  // Arc 2: CW Arc (50,50) -> (100,100), Center (100,50), Radius 50
  // startAngle = PI, endAngle = PI/2, clockwise = true
  const arc2: ArcEntity = {
    id: 'arc-2',
    type: 'arc',
    center: { x: 100, y: 50 },
    radius: 50,
    startAngle: Math.PI,
    endAngle: Math.PI / 2,
    clockwise: true,
    color: '#000',
    selected: false,
  };

  const mid2 = getArcMidPoint(arc2);
  // For CW arc from PI to PI/2, sweep is -PI/2.
  // Mid angle = PI - PI/4 = 3PI/4.
  // Mid point 2 should be at (100 + 50*cos(3PI/4), 50 + 50*sin(3PI/4)) = (64.645, 85.355)
  assert.ok(
    approxEqual(mid2.x, 64.645),
    `Arc 2 CW midX should be ~64.645 on minor arc, got ${mid2.x}`
  );
  assert.ok(
    approxEqual(mid2.y, 85.355),
    `Arc 2 CW midY should be ~85.355 on minor arc, got ${mid2.y}`
  );

  // Verify it is NOT the 300-degree major arc midpoint (which would be at angle -PI/8 or -PI/4 -> ~135.355, 14.645)
  assert.ok(
    mid2.x < 100,
    `CW Arc midpoint must lie in x < 100 region on minor arc, got ${mid2.x}`
  );
  assert.ok(
    mid2.y > 50,
    `CW Arc midpoint must lie in y > 50 region on minor arc, got ${mid2.y}`
  );
});

test('Sweep Feature Pipeline Adapter compiles 3D path segments with exact midpoints and clockwise flags', () => {
  // Profile sketch on Top Plane (circle)
  const profileCircle: CircleEntity = {
    id: 'circle-profile',
    type: 'circle',
    center: { x: 0, y: 0 },
    radius: 5,
    color: '#000',
    selected: false,
  };

  const profileSketch: SketchFeature = {
    id: 'sk-profile',
    name: 'Profile Sketch',
    type: 'SKETCH',
    plane: DatumTopPlane,
    entities: [profileCircle],
    constraints: [],
    profiles: [
      {
        id: 'prof-1',
        entityIds: ['circle-profile'],
        boundaryLoops: [],
      },
    ],
  };

  // Path sketch on Front Plane with S-curve (Arc 1 CCW + Arc 2 CW)
  const arc1: ArcEntity = {
    id: 'arc-1',
    type: 'arc',
    center: { x: 0, y: 50 },
    radius: 50,
    startAngle: -Math.PI / 2,
    endAngle: 0,
    clockwise: false,
    color: '#000',
    selected: false,
  };

  const arc2: ArcEntity = {
    id: 'arc-2',
    type: 'arc',
    center: { x: 100, y: 50 },
    radius: 50,
    startAngle: Math.PI,
    endAngle: Math.PI / 2,
    clockwise: true,
    color: '#000',
    selected: false,
  };

  const pathSketch: SketchFeature = {
    id: 'sk-path',
    name: 'Path Sketch',
    type: 'SKETCH',
    plane: DatumFrontPlane,
    entities: [arc1, arc2],
    constraints: [],
    profiles: [],
  };

  const sweepFeature: SweepFeature = {
    id: 'sweep-1',
    name: 'Sweep 1',
    type: 'SWEEP',
    profileSketchId: 'sk-profile',
    pathSketchId: 'sk-path',
  };

  const features = [profileSketch, pathSketch, sweepFeature];
  const ops = buildFeatureEvalOps(features, features.length);

  assert.strictEqual(ops.length, 1, 'Should compile exactly 1 SWEEP op');
  const sweepOp = ops[0];
  assert.strictEqual(sweepOp.type, 'SWEEP');
  assert.ok(sweepOp.sweepData, 'sweepData must be present');
  assert.strictEqual(sweepOp.sweepData.pathSegments.length, 2, 'Should have 2 path segments');

  const seg1 = sweepOp.sweepData.pathSegments[0];
  const seg2 = sweepOp.sweepData.pathSegments[1];

  assert.strictEqual(seg1.type, 'arc');
  assert.strictEqual(seg1.clockwise, false);
  assert.ok(seg1.mid, 'Segment 1 must have mid point');
  assert.ok(approxEqual(seg1.mid.x, 35.355));
  assert.ok(approxEqual(seg1.mid.y, 14.645));

  assert.strictEqual(seg2.type, 'arc');
  assert.strictEqual(seg2.clockwise, true);
  assert.strictEqual(seg2.sweepFlag, 1);
  assert.ok(seg2.mid, 'Segment 2 must have mid point');
  assert.ok(approxEqual(seg2.mid.x, 64.645));
  assert.ok(approxEqual(seg2.mid.y, 85.355));
});
