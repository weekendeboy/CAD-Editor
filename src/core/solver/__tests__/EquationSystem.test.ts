import { describe, it, expect } from 'vitest';
import { EquationSystem } from '../EquationSystem';
import { VariableSystem } from '../VariableSystem';
import { Constraint, LineEntity, CADEntity2D } from '../../../types/cad';

describe('EquationSystem', () => {
  it('should evaluate residuals correctly for constraints', () => {
    // 建立一條完美的水平線與一條傾斜線
    const horizontalLine: LineEntity = {
      id: 'L1', type: 'line', layerId: '0', visible: true, locked: false,
      start: { x: 0, y: 10 }, end: { x: 20, y: 10 }
    };
    
    const angledLine: LineEntity = {
      id: 'L2', type: 'line', layerId: '0', visible: true, locked: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 5 }
    };

    const entities: CADEntity2D[] = [horizontalLine, angledLine];
    const entityMap = new Map(entities.map(e => [e.id, e]));

    const sys = new VariableSystem();
    const x = sys.extractVariables(entities);
    const initialX = [...x];

    // 水平約束: 測量 L1 (預期殘差 0) 與 L2 (預期殘差非 0)
    const constraints: Constraint[] = [
      { id: 'c1', type: 'horizontal', entityIds: ['L1'] },
      { id: 'c2', type: 'horizontal', entityIds: ['L2'] }
    ];

    const residuals = EquationSystem.evaluate(constraints, x, initialX, sys, entityMap);
    
    // c1 殘差: L1_start_y - L1_end_y = 10 - 10 = 0
    expect(residuals[0]).toBe(0);
    
    // c2 殘差: L2_start_y - L2_end_y = 0 - 5 = -5
    expect(residuals[1]).toBe(-5);
  });

  it('should handle point-to-point constraints correctly', () => {
    const l1: LineEntity = {
      id: 'L1', type: 'line', layerId: '0', visible: true, locked: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 }
    };
    
    const l2: LineEntity = {
      id: 'L2', type: 'line', layerId: '0', visible: true, locked: false,
      start: { x: 15, y: 5 }, end: { x: 25, y: 5 }
    };

    const entities: CADEntity2D[] = [l1, l2];
    const entityMap = new Map(entities.map(e => [e.id, e]));

    const sys = new VariableSystem();
    const x = sys.extractVariables(entities);
    const initialX = [...x];

    // coincident: L1_end 和 L2_start 重合
    const constraints: Constraint[] = [
      { id: 'c1', type: 'coincident', entityIds: ['L1', 'L2'], pointIndices: [1, 0] }
    ];

    const residuals = EquationSystem.evaluate(constraints, x, initialX, sys, entityMap);
    
    // x1 = 10, x2 = 15 => dx = -5
    // y1 = 0, y2 = 5 => dy = -5
    expect(residuals.length).toBe(2);
    expect(residuals[0]).toBe(-5);
    expect(residuals[1]).toBe(-5);
  });
});
