import { describe, it, expect } from 'vitest';
import { NumericalConstraintSolver } from '../NumericalConstraintSolver';
import { LineEntity, Constraint } from '../../../types/cad';

describe('NumericalConstraintSolver', () => {
  it('should solve horizontal constraint and align y-coordinates', () => {
    // 建立一條稍微歪斜的線段，預期 y 座標會被拉平到同一個高度
    const line: LineEntity = {
      id: 'L1', type: 'line', layerId: '0', visible: true, locked: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 2 } 
    };
    
    const constraints: Constraint[] = [
      { id: 'c1', type: 'horizontal', entityIds: ['L1'] }
    ];

    const solved = NumericalConstraintSolver.solveConstraints([line], constraints) as LineEntity[];
    const resultLine = solved[0];

    // 水平線表示 start.y === end.y，允許極小誤差 (TOLERANCE 1e-6)
    expect(Math.abs(resultLine.start.y - resultLine.end.y)).toBeLessThan(1e-5);
  });

  it('should solve coincident constraint correctly', () => {
    const l1: LineEntity = {
      id: 'L1', type: 'line', layerId: '0', visible: true, locked: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 }
    };
    
    const l2: LineEntity = {
      id: 'L2', type: 'line', layerId: '0', visible: true, locked: false,
      start: { x: 15, y: 5 }, end: { x: 25, y: 5 }
    };

    const constraints: Constraint[] = [
      { id: 'c1', type: 'coincident', entityIds: ['L1', 'L2'], pointIndices: [1, 0] }
    ];

    // 固定 L1，讓 L2 的 start (pointIndex 0) 去對齊 L1 的 end (pointIndex 1)
    const solved = NumericalConstraintSolver.solveConstraints([l1, l2], constraints, ['L1']) as LineEntity[];
    const resL1 = solved[0];
    const resL2 = solved[1];

    // L1 should not move
    expect(resL1.end.x).toBeCloseTo(10, 5);
    expect(resL1.end.y).toBeCloseTo(0, 5);

    // L2 start should exactly coincide with L1 end
    expect(resL2.start.x).toBeCloseTo(10, 5);
    expect(resL2.start.y).toBeCloseTo(0, 5);
  });
});
