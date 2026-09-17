import { describe, it, expect } from 'vitest';
import { VariableSystem } from '../VariableSystem';
import { LineEntity, CircleEntity, CADEntity2D } from '../../../types/cad';

describe('VariableSystem', () => {
  it('should extract correct number of variables', () => {
    const line: LineEntity = {
      id: 'L1', type: 'line', layerId: '0', visible: true, locked: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 10 }
    };
    const circle: CircleEntity = {
      id: 'C1', type: 'circle', layerId: '0', visible: true, locked: false,
      center: { x: 5, y: 5 }, radius: 10
    };

    const sys = new VariableSystem();
    const x = sys.extractVariables([line, circle]);

    // line has 4, circle has 3 => 7 total
    expect(x.length).toBe(7);
    
    // verify mapping
    expect(sys.getVariableIndex('L1', 'start.x')).toBe(0);
    expect(sys.getVariableIndex('L1', 'start.y')).toBe(1);
    expect(sys.getVariableIndex('C1', 'center.x')).toBe(4);
    expect(sys.getVariableIndex('C1', 'radius')).toBe(6);
  });

  it('should apply variables correctly to entities', () => {
    const line: LineEntity = {
      id: 'L1', type: 'line', layerId: '0', visible: true, locked: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 10 }
    };

    const sys = new VariableSystem();
    const x = sys.extractVariables([line]);
    
    // Manual modification
    x[0] = 5; // start.x
    x[3] = 20; // end.y

    const newEntities = sys.applyVariables(x, [line]) as LineEntity[];
    expect(newEntities[0].start.x).toBe(5);
    expect(newEntities[0].start.y).toBe(0);
    expect(newEntities[0].end.x).toBe(10);
    expect(newEntities[0].end.y).toBe(20);
    
    // The original entity shouldn't be modified
    expect(line.start.x).toBe(0);
  });
});
