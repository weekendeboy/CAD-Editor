import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canApplyConstraint,
  getAvailableConstraints,
  canApplyHorizontal,
  canApplyVertical,
  canApplyCoincident,
  canApplyParallel,
  canApplyPerpendicular,
  canApplyEqualLength,
  canApplyTangent,
  canApplyEqualRadius,
  canApplyFix,
  canApplyHorizontalVertical,
  isBothLines,
  ConstraintValidator,
} from '../ConstraintValidator';
import type {
  LineEntity,
  CircleEntity,
  ArcEntity,
  PolylineEntity,
} from '../../../types/cad';

function makeLine(id: string): LineEntity {
  return {
    id,
    type: 'line',
    layerId: '0',
    visible: true,
    locked: false,
    start: { x: 0, y: 0 },
    end: { x: 10, y: 10 },
  };
}

function makeCircle(id: string): CircleEntity {
  return {
    id,
    type: 'circle',
    layerId: '0',
    visible: true,
    locked: false,
    center: { x: 5, y: 5 },
    radius: 10,
  };
}

function makeArc(id: string): ArcEntity {
  return {
    id,
    type: 'arc',
    layerId: '0',
    visible: true,
    locked: false,
    center: { x: 0, y: 0 },
    radius: 5,
    startAngle: 0,
    endAngle: Math.PI / 2,
  };
}

function makePolyline(id: string): PolylineEntity {
  return {
    id,
    type: 'polyline',
    layerId: '0',
    visible: true,
    locked: false,
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    closed: false,
  };
}

test('ConstraintValidator - Single Entity Selection', () => {
  const line1 = makeLine('l1');
  const circle1 = makeCircle('c1');
  const arc1 = makeArc('a1');
  const polyline1 = makePolyline('p1');

  // 1 Line -> Horizontal, Vertical, Fix
  assert.equal(canApplyFix([line1]), true);
  assert.equal(canApplyHorizontal([line1]), true);
  assert.equal(canApplyVertical([line1]), true);
  assert.equal(canApplyParallel([line1]), false);
  assert.equal(canApplyCoincident([line1]), false);

  const lineConstraints = getAvailableConstraints([line1], false);
  assert.deepEqual(lineConstraints.sort(), ['fix', 'horizontal', 'vertical'].sort());

  // 1 Circle -> Fix only
  assert.equal(canApplyFix([circle1]), true);
  assert.equal(canApplyHorizontal([circle1]), false);
  assert.equal(canApplyVertical([circle1]), false);
  assert.deepEqual(getAvailableConstraints([circle1], false), ['fix']);

  // 1 Arc -> Fix only
  assert.equal(canApplyFix([arc1]), true);
  assert.equal(canApplyHorizontal([arc1]), false);
  assert.deepEqual(getAvailableConstraints([arc1], false), ['fix']);

  // 1 Polyline -> Fix only
  assert.equal(canApplyFix([polyline1]), true);
  assert.equal(canApplyHorizontal([polyline1]), false);
  assert.deepEqual(getAvailableConstraints([polyline1], false), ['fix']);
});

test('ConstraintValidator - Virtual Origin Selection', () => {
  const line1 = makeLine('l1');
  const circle1 = makeCircle('c1');

  // Origin only (0 real entities + origin selected)
  assert.equal(canApplyFix([], true), false);
  assert.equal(canApplyHorizontal([], true), false);
  assert.deepEqual(getAvailableConstraints([], true), []);

  // 1 Line + Origin -> Horizontal, Vertical, Coincident
  assert.equal(canApplyFix([line1], true), false);
  assert.equal(canApplyHorizontal([line1], true), true);
  assert.equal(canApplyVertical([line1], true), true);
  assert.equal(canApplyCoincident([line1], true), true);
  assert.equal(canApplyParallel([line1], true), false);

  const lineOriginConstraints = getAvailableConstraints([line1], true);
  assert.deepEqual(
    lineOriginConstraints.sort(),
    ['coincident', 'horizontal', 'vertical'].sort()
  );

  // 1 Circle + Origin -> Horizontal, Vertical, Coincident
  assert.equal(canApplyHorizontal([circle1], true), true);
  assert.equal(canApplyVertical([circle1], true), true);
  assert.equal(canApplyCoincident([circle1], true), true);
  assert.equal(canApplyFix([circle1], true), false);
});

test('ConstraintValidator - Two Lines Selection', () => {
  const line1 = makeLine('l1');
  const line2 = makeLine('l2');

  assert.equal(isBothLines([line1, line2]), true);
  assert.equal(canApplyParallel([line1, line2]), true);
  assert.equal(canApplyPerpendicular([line1, line2]), true);
  assert.equal(canApplyEqualLength([line1, line2]), true);
  assert.equal(canApplyCoincident([line1, line2]), true);
  assert.equal(canApplyTangent([line1, line2]), false);
  assert.equal(canApplyEqualRadius([line1, line2]), false);
  assert.equal(canApplyFix([line1, line2]), false);

  const constraints = getAvailableConstraints([line1, line2], false);
  assert.deepEqual(
    constraints.sort(),
    ['coincident', 'equal_length', 'parallel', 'perpendicular'].sort()
  );
});

test('ConstraintValidator - Two Circles Selection', () => {
  const circle1 = makeCircle('c1');
  const circle2 = makeCircle('c2');

  assert.equal(canApplyHorizontal([circle1, circle2]), true);
  assert.equal(canApplyVertical([circle1, circle2]), true);
  assert.equal(canApplyCoincident([circle1, circle2]), true);
  assert.equal(canApplyTangent([circle1, circle2]), true);
  assert.equal(canApplyEqualRadius([circle1, circle2]), true);
  assert.equal(canApplyParallel([circle1, circle2]), false);
  assert.equal(canApplyEqualLength([circle1, circle2]), false);

  const constraints = getAvailableConstraints([circle1, circle2], false);
  assert.deepEqual(
    constraints.sort(),
    ['coincident', 'equal_radius', 'horizontal', 'tangent', 'vertical'].sort()
  );
});

test('ConstraintValidator - Circle and Arc Selection', () => {
  const circle1 = makeCircle('c1');
  const arc1 = makeArc('a1');

  assert.equal(canApplyHorizontal([circle1, arc1]), true);
  assert.equal(canApplyVertical([circle1, arc1]), true);
  assert.equal(canApplyCoincident([circle1, arc1]), true);
  assert.equal(canApplyTangent([circle1, arc1]), true);
  assert.equal(canApplyEqualRadius([circle1, arc1]), true);
});

test('ConstraintValidator - Line and Circle / Arc Selection', () => {
  const line1 = makeLine('l1');
  const circle1 = makeCircle('c1');
  const arc1 = makeArc('a1');

  // Line + Circle
  assert.equal(canApplyTangent([line1, circle1]), true);
  assert.equal(canApplyTangent([circle1, line1]), true);
  assert.equal(canApplyHorizontal([line1, circle1]), true);
  assert.equal(canApplyVertical([line1, circle1]), true);
  assert.equal(canApplyCoincident([line1, circle1]), true);
  assert.equal(canApplyEqualRadius([line1, circle1]), false);
  assert.equal(canApplyParallel([line1, circle1]), false);

  const lineCircleConstraints = getAvailableConstraints([line1, circle1], false);
  assert.deepEqual(
    lineCircleConstraints.sort(),
    ['coincident', 'horizontal', 'tangent', 'vertical'].sort()
  );

  // Line + Arc
  assert.equal(canApplyTangent([line1, arc1]), true);
  assert.equal(canApplyHorizontal([line1, arc1]), true);
});

test('ConstraintValidator - Three or More Entities (Over-selection boundary)', () => {
  const line1 = makeLine('l1');
  const line2 = makeLine('l2');
  const line3 = makeLine('l3');

  assert.equal(canApplyHorizontal([line1, line2, line3]), false);
  assert.equal(canApplyVertical([line1, line2, line3]), false);
  assert.equal(canApplyCoincident([line1, line2, line3]), false);
  assert.equal(canApplyParallel([line1, line2, line3]), false);
  assert.equal(canApplyTangent([line1, line2, line3]), false);
  assert.equal(canApplyFix([line1, line2, line3]), false);

  assert.deepEqual(getAvailableConstraints([line1, line2, line3], false), []);
});

test('ConstraintValidator - Class Static Methods Dispatch & canApplyConstraint', () => {
  const line1 = makeLine('l1');
  const line2 = makeLine('l2');

  assert.equal(ConstraintValidator.canApply('parallel', [line1, line2]), true);
  assert.equal(ConstraintValidator.canApply('perpendicular', [line1, line2]), true);
  assert.equal(ConstraintValidator.canApply('equal_length', [line1, line2]), true);
  assert.equal(ConstraintValidator.canApply('fix', [line1, line2]), false);

  assert.equal(canApplyConstraint('distance', [line1, line2]), false);
  assert.equal(canApplyConstraint('angle', [line1, line2]), false);

  const classAvailable = ConstraintValidator.getAvailable([line1, line2]);
  const fnAvailable = getAvailableConstraints([line1, line2]);
  assert.deepEqual(classAvailable, fnAvailable);
});
