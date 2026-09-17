/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LineSegment2D,
  ArcSegment2D,
  convertEntityToCurves,
  convertEntitiesToCurves,
  ICurve2D,
} from '../index';
import type {
  LineEntity,
  CircleEntity,
  ArcEntity,
  PolylineEntity,
} from '../../../../types/cad';

const EPSILON = 1e-6;

function assertClose(actual: number, expected: number, msg?: string) {
  assert.ok(
    Math.abs(actual - expected) < EPSILON,
    `${msg ?? 'Values not close'}: expected ${expected}, got ${actual}`
  );
}

function assertPointClose(actual: { x: number; y: number }, expected: { x: number; y: number }, msg?: string) {
  assertClose(actual.x, expected.x, `${msg ?? 'Point mismatch'} (x)`);
  assertClose(actual.y, expected.y, `${msg ?? 'Point mismatch'} (y)`);
}

function assertVectorClose(actual: { x: number; y: number }, expected: { x: number; y: number }, msg?: string) {
  assertClose(actual.x, expected.x, `${msg ?? 'Vector mismatch'} (x)`);
  assertClose(actual.y, expected.y, `${msg ?? 'Vector mismatch'} (y)`);
}

test('LineSegment2D - Basic Evaluation, Midpoint & Tangent', () => {
  const p1 = { x: 0, y: 0 };
  const p2 = { x: 10, y: 0 };
  const line = new LineSegment2D(p1, p2);

  assert.equal(line.type, 'line');
  assertClose(line.length(), 10, 'Line length should be 10');

  // Start / End
  assertPointClose(line.getStartPoint(), { x: 0, y: 0 });
  assertPointClose(line.getEndPoint(), { x: 10, y: 0 });
  assertPointClose(line.pointAt(0), { x: 0, y: 0 });
  assertPointClose(line.pointAt(1), { x: 10, y: 0 });

  // Midpoint at t = 0.5
  assertPointClose(line.pointAt(0.5), { x: 5, y: 0 }, 'Midpoint t=0.5 should be (5, 0)');

  // Tangent at any t should point in positive X direction (1, 0)
  assertVectorClose(line.tangentAt(0), { x: 1, y: 0 });
  assertVectorClose(line.tangentAt(0.5), { x: 1, y: 0 }, 'Tangent at t=0.5 should be (1, 0)');
  assertVectorClose(line.tangentAt(1), { x: 1, y: 0 });

  // Slanted line (3, 4, 5 triangle)
  const slanted = new LineSegment2D({ x: 1, y: 2 }, { x: 4, y: 6 });
  assertClose(slanted.length(), 5);
  assertPointClose(slanted.pointAt(0.5), { x: 2.5, y: 4 });
  assertVectorClose(slanted.tangentAt(0.5), { x: 3 / 5, y: 4 / 5 });
});

test('ArcSegment2D - Counter-Clockwise (CCW) Arc', () => {
  // 90-degree CCW arc from (10, 0) to (0, 10), center at (0, 0), radius = 10
  const center = { x: 0, y: 0 };
  const radius = 10;
  const startAngle = 0;
  const sweepAngle = Math.PI / 2; // +90 deg CCW
  const arc = new ArcSegment2D(center, radius, startAngle, sweepAngle, 'arc');

  assert.equal(arc.type, 'arc');
  assert.equal(arc.isClockwise, false);
  assertClose(arc.length(), 10 * (Math.PI / 2));

  // Start (t=0) -> (10, 0), Tangent -> (0, 1) pointing +Y
  assertPointClose(arc.getStartPoint(), { x: 10, y: 0 });
  assertVectorClose(arc.tangentAt(0), { x: 0, y: 1 });

  // End (t=1) -> (0, 10), Tangent -> (-1, 0) pointing -X
  assertPointClose(arc.getEndPoint(), { x: 0, y: 10 });
  assertVectorClose(arc.tangentAt(1), { x: -1, y: 0 });

  // Midpoint (t=0.5) -> angle π/4 (45 deg) -> (10 * √2/2, 10 * √2/2)
  const expectedMidX = 10 * Math.cos(Math.PI / 4);
  const expectedMidY = 10 * Math.sin(Math.PI / 4);
  assertPointClose(arc.pointAt(0.5), { x: expectedMidX, y: expectedMidY });

  // Tangent at t=0.5 -> (-sin(45°), cos(45°)) = (-√2/2, √2/2)
  assertVectorClose(arc.tangentAt(0.5), {
    x: -Math.SQRT1_2,
    y: Math.SQRT1_2,
  });
});

test('ArcSegment2D - Clockwise (CW) Arc', () => {
  // 90-degree CW arc from (0, 10) to (10, 0), center at (0, 0), radius = 10
  const center = { x: 0, y: 0 };
  const radius = 10;
  const startAngle = Math.PI / 2;
  const sweepAngle = -Math.PI / 2; // -90 deg CW
  const arc = new ArcSegment2D(center, radius, startAngle, sweepAngle, 'arc');

  assert.equal(arc.isClockwise, true);
  assertClose(arc.length(), 10 * (Math.PI / 2));

  // Start (t=0) -> (0, 10), Tangent -> (1, 0) pointing +X
  assertPointClose(arc.getStartPoint(), { x: 0, y: 10 });
  assertVectorClose(arc.tangentAt(0), { x: 1, y: 0 });

  // End (t=1) -> (10, 0), Tangent -> (0, -1) pointing -Y
  assertPointClose(arc.getEndPoint(), { x: 10, y: 0 });
  assertVectorClose(arc.tangentAt(1), { x: 0, y: -1 });

  // Midpoint (t=0.5) -> angle π/4 (45 deg) -> (10 * √2/2, 10 * √2/2)
  const expectedMidX = 10 * Math.cos(Math.PI / 4);
  const expectedMidY = 10 * Math.sin(Math.PI / 4);
  assertPointClose(arc.pointAt(0.5), { x: expectedMidX, y: expectedMidY });

  // Tangent at t=0.5 in CW direction -> (+sin(45°), -cos(45°)) = (√2/2, -√2/2)
  assertVectorClose(arc.tangentAt(0.5), {
    x: Math.SQRT1_2,
    y: -Math.SQRT1_2,
  });
});

test('ArcSegment2D - Full Circle', () => {
  const circleArc = new ArcSegment2D({ x: 5, y: 5 }, 4, 0, 2 * Math.PI, 'circle');
  assert.equal(circleArc.type, 'circle');
  assertClose(circleArc.length(), 2 * Math.PI * 4);
  assertPointClose(circleArc.getStartPoint(), { x: 9, y: 5 });
  assertPointClose(circleArc.getEndPoint(), { x: 9, y: 5 });
  assertPointClose(circleArc.pointAt(0.5), { x: 1, y: 5 }); // 180 deg
});

test('CurveConverter - LineEntity to LineSegment2D', () => {
  const lineEntity: LineEntity = {
    id: 'line-1',
    type: 'line',
    layerId: 'layer-0',
    visible: true,
    locked: false,
    start: { x: 2, y: 3 },
    end: { x: 8, y: 11 },
  };

  const curves = convertEntityToCurves(lineEntity);
  assert.equal(curves.length, 1);
  assert.equal(curves[0].type, 'line');
  assertPointClose(curves[0].getStartPoint(), { x: 2, y: 3 });
  assertPointClose(curves[0].getEndPoint(), { x: 8, y: 11 });
});

test('CurveConverter - ArcEntity and CircleEntity', () => {
  const arcEntity: ArcEntity = {
    id: 'arc-1',
    type: 'arc',
    layerId: 'layer-0',
    visible: true,
    locked: false,
    center: { x: 0, y: 0 },
    radius: 5,
    startAngle: 0,
    endAngle: Math.PI,
  };

  const arcCurves = convertEntityToCurves(arcEntity);
  assert.equal(arcCurves.length, 1);
  assert.equal(arcCurves[0].type, 'arc');
  assertPointClose(arcCurves[0].getStartPoint(), { x: 5, y: 0 });
  assertPointClose(arcCurves[0].getEndPoint(), { x: -5, y: 0 });
  assertClose(arcCurves[0].length(), 5 * Math.PI);

  const circleEntity: CircleEntity = {
    id: 'circle-1',
    type: 'circle',
    layerId: 'layer-0',
    visible: true,
    locked: false,
    center: { x: 10, y: 20 },
    radius: 3,
  };

  const circleCurves = convertEntityToCurves(circleEntity);
  assert.equal(circleCurves.length, 1);
  assert.equal(circleCurves[0].type, 'circle');
  assertClose(circleCurves[0].length(), 6 * Math.PI);
});

test('CurveConverter - Polyline with bulge: 1 (Semicircle) & Line Segments Continuity', () => {
  // Polyline:
  // p0: (0, 0)
  // p1: (10, 0), bulge: 1 (semicircle CCW from (10, 0) to (10, 10), radius = 5, center = (10, 5))
  // p2: (10, 10)
  // p3: (0, 10)
  const polyline: PolylineEntity = {
    id: 'poly-1',
    type: 'polyline',
    layerId: 'layer-0',
    visible: true,
    locked: false,
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    bulges: [0, 1, 0], // Segment 0: Line, Segment 1: Arc (bulge=1), Segment 2: Line
    closed: false,
  };

  const curves = convertEntityToCurves(polyline);
  assert.equal(curves.length, 3, 'Should produce 3 curve segments');

  // Curve 0: Line from (0, 0) to (10, 0)
  assert.equal(curves[0].type, 'line');
  assertPointClose(curves[0].getStartPoint(), { x: 0, y: 0 });
  assertPointClose(curves[0].getEndPoint(), { x: 10, y: 0 });

  // Curve 1: Arc from (10, 0) to (10, 10) with bulge 1
  assert.equal(curves[1].type, 'arc');
  assertPointClose(curves[1].getStartPoint(), { x: 10, y: 0 });
  assertPointClose(curves[1].getEndPoint(), { x: 10, y: 10 });
  assertClose(curves[1].length(), 5 * Math.PI); // Radius is 5, half circle length is 5π

  // Curve 2: Line from (10, 10) to (0, 10)
  assert.equal(curves[2].type, 'line');
  assertPointClose(curves[2].getStartPoint(), { x: 10, y: 10 });
  assertPointClose(curves[2].getEndPoint(), { x: 0, y: 10 });

  // Verification of full $C^0$ endpoint continuity along the chain
  for (let i = 0; i < curves.length - 1; i++) {
    const endPoint = curves[i].getEndPoint();
    const nextStartPoint = curves[i + 1].getStartPoint();
    assertPointClose(
      endPoint,
      nextStartPoint,
      `Curve[${i}] end must match Curve[${i + 1}] start`
    );
  }
});

test('CurveConverter - Closed Polyline with Mixed Bulges (CW & CCW)', () => {
  // Closed triangle with 1 straight edge, 1 CCW arc, 1 CW arc
  const closedPoly: PolylineEntity = {
    id: 'poly-2',
    type: 'polyline',
    layerId: 'layer-0',
    visible: true,
    locked: false,
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ],
    bulges: [1, -0.5, 0], // Seg 0->1 CCW arc, Seg 1->2 CW arc, Seg 2->0 Line
    closed: true,
  };

  const curves = convertEntityToCurves(closedPoly);
  assert.equal(curves.length, 3, 'Should produce 3 curve segments for 3-vertex closed polyline');

  // Verify full ring continuity
  assertPointClose(curves[0].getStartPoint(), { x: 0, y: 0 });
  assertPointClose(curves[0].getEndPoint(), curves[1].getStartPoint());
  assertPointClose(curves[1].getEndPoint(), curves[2].getStartPoint());
  assertPointClose(curves[2].getEndPoint(), curves[0].getStartPoint(), 'Closed loop must close at origin');
});

test('CurveConverter - Batch Conversion (convertEntitiesToCurves)', () => {
  const line: LineEntity = {
    id: 'l1',
    type: 'line',
    layerId: '0',
    visible: true,
    locked: false,
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  };
  const circle: CircleEntity = {
    id: 'c1',
    type: 'circle',
    layerId: '0',
    visible: true,
    locked: false,
    center: { x: 0, y: 0 },
    radius: 2,
  };

  const allCurves = convertEntitiesToCurves([line, circle]);
  assert.equal(allCurves.length, 2);
  assert.equal(allCurves[0].type, 'line');
  assert.equal(allCurves[1].type, 'circle');
});
