import { describe, it, expect } from 'vitest';
import { solveConstraints, analyzeSketchDOF } from '../NumericalConstraintSolver';
import { LineEntity, Constraint } from '../../../types/cad';
import { applyConstraintsToSketch } from '../../../store/sketchMutators';

describe('DimensionConstraintRegression Tests', () => {
  // Case 1: Line (0,0) -> (100,0), length = 150
  it('Case 1: should accurately solve length dimension on single line and converge', () => {
    const l1: LineEntity = {
      id: 'L1',
      type: 'line',
      layerId: '0',
      visible: true,
      locked: false,
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
    };
    const c1: Constraint = {
      id: 'c1',
      type: 'length',
      entityIds: ['L1'],
      value: 150,
      targetVal: 150,
    };

    const result = solveConstraints([l1], [c1]);
    expect(result.converged).toBe(true);
    expect(result.conflictEntityIds).not.toContain('L1');

    const resLine = result.entities[0] as LineEntity;
    const actualLength = Math.hypot(resLine.end.x - resLine.start.x, resLine.end.y - resLine.start.y);
    expect(Math.abs(actualLength - 150)).toBeLessThan(1e-6);
  });

  // Case 2: Line (0,0) -> (100,0), Fixed start point, length = 150
  it('Case 2: should solve length constraint with fixed start point without moving start', () => {
    const l2: LineEntity = {
      id: 'L1',
      type: 'line',
      layerId: '0',
      visible: true,
      locked: false,
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
    };
    const c2_fix: Constraint = {
      id: 'c_fix',
      type: 'fix',
      entityIds: ['L1'],
      pointIndices: [0],
    };
    const c2_len: Constraint = {
      id: 'c_len',
      type: 'length',
      entityIds: ['L1'],
      value: 150,
      targetVal: 150,
    };

    const result = solveConstraints([l2], [c2_fix, c2_len]);
    expect(result.converged).toBe(true);

    const resLine = result.entities[0] as LineEntity;
    expect(resLine.start.x).toBeCloseTo(0, 5);
    expect(resLine.start.y).toBeCloseTo(0, 5);

    const actualLength = Math.hypot(resLine.end.x - resLine.start.x, resLine.end.y - resLine.start.y);
    expect(Math.abs(actualLength - 150)).toBeLessThan(1e-6);
  });

  // Case 3: Line (20,30) -> (120,30), length = 200
  it('Case 3: should solve length constraint on offset line preserving direction and y', () => {
    const l3: LineEntity = {
      id: 'L1',
      type: 'line',
      layerId: '0',
      visible: true,
      locked: false,
      start: { x: 20, y: 30 },
      end: { x: 120, y: 30 },
    };
    const c3: Constraint = {
      id: 'c3',
      type: 'length',
      entityIds: ['L1'],
      value: 200,
      targetVal: 200,
    };

    const result = solveConstraints([l3], [c3]);
    expect(result.converged).toBe(true);

    const resLine = result.entities[0] as LineEntity;
    expect(resLine.start.y).toBeCloseTo(30, 5);
    expect(resLine.end.y).toBeCloseTo(30, 5);

    const actualLength = Math.hypot(resLine.end.x - resLine.start.x, resLine.end.y - resLine.start.y);
    expect(Math.abs(actualLength - 200)).toBeLessThan(1e-6);
  });

  // Case 4: Line (0,0) -> (100,0), distance_x = 150
  it('Case 4: should solve distance_x constraint correctly', () => {
    const l4: LineEntity = {
      id: 'L1',
      type: 'line',
      layerId: '0',
      visible: true,
      locked: false,
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
    };
    const c4: Constraint = {
      id: 'c4',
      type: 'distance_x',
      entityIds: ['origin', 'L1'],
      pointIndices: [0, 1],
      value: 150,
      targetVal: 150,
    };

    const result = solveConstraints([l4], [c4]);
    expect(result.converged).toBe(true);

    const resLine = result.entities[0] as LineEntity;
    expect(Math.abs(resLine.end.x - 150)).toBeLessThan(1e-6);
  });

  // Case 5: Already satisfied Line (0,0) -> (150,0), length = 150
  it('Case 5: should converge with 0 or minimal iterations when already satisfied', () => {
    const l5: LineEntity = {
      id: 'L1',
      type: 'line',
      layerId: '0',
      visible: true,
      locked: false,
      start: { x: 0, y: 0 },
      end: { x: 150, y: 0 },
    };
    const c5: Constraint = {
      id: 'c5',
      type: 'length',
      entityIds: ['L1'],
      value: 150,
      targetVal: 150,
    };

    const result = solveConstraints([l5], [c5]);
    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(0);

    const resLine = result.entities[0] as LineEntity;
    expect(resLine.start.x).toBe(0);
    expect(resLine.start.y).toBe(0);
    expect(resLine.end.x).toBe(150);
    expect(resLine.end.y).toBe(0);
  });

  // Integration: applyConstraintsToSketch
  it('Integration: should keep sketch and entity state not OverDefined after length constraint applied', () => {
    const sketch: any = {
      id: 'sk1',
      name: 'Sketch1',
      type: 'SKETCH',
      entities: [
        {
          id: 'L1',
          type: 'line',
          layerId: '0',
          visible: true,
          locked: false,
          start: { x: 0, y: 0 },
          end: { x: 100, y: 0 },
          state: 'UnderDefined',
        },
      ],
      constraints: [
        {
          id: 'c1',
          type: 'length',
          entityIds: ['L1'],
          value: 150,
          targetVal: 150,
        },
      ],
      dimensions: [],
      profiles: [],
      solverState: 'UnderDefined',
    };

    applyConstraintsToSketch(sketch);

    expect(sketch.solverState).not.toBe('OverDefined');
    expect(sketch.entities[0].state).not.toBe('OverDefined');
    expect(sketch.entities[0].state).toBe('UnderDefined');

    const ent = sketch.entities[0];
    const actualLength = Math.hypot(ent.end.x - ent.start.x, ent.end.y - ent.start.y);
    expect(Math.abs(actualLength - 150)).toBeLessThan(1e-6);
  });
});
