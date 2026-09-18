import { Constraint, CADEntity2D } from '../../types/cad';
import { VariableSystem } from './VariableSystem';

export class EquationSystem {
  /**
   * 根據約束條件計算當前狀態的殘差 (Residuals) 陣列
   * @param constraints 系統內的所有約束
   * @param x 當前的變數狀態向量
   * @param initialX 初始變數狀態向量 (用於 fix 固定點約束)
   * @param variableSystem 變數映射系統
   * @param entityMap 用於查閱實體的對照表，以辨識圖元類型
   */
  public static evaluate(
    constraints: Constraint[],
    x: number[],
    initialX: number[],
    variableSystem: VariableSystem,
    entityMap: Map<string, CADEntity2D>
  ): number[] {
    const residuals: number[] = [];

    const getPointCoordsWithX = (entityId: string, ptIndex: number | undefined, xArray: number[]): [number, number] => {
      if (entityId === 'origin') {
        return [0, 0];
      }
      const ent = entityMap.get(entityId);
      if (!ent) throw new Error(`Entity not found: ${entityId}`);
      
      let actualPtIdx = ptIndex;
      if (ent.type === 'circle' && actualPtIdx !== 0 && actualPtIdx !== undefined) {
         actualPtIdx = 0;
      }

      if (ent.type === 'arc' && (actualPtIdx === 1 || actualPtIdx === 2)) {
        const cx = xArray[variableSystem.getVariableIndex(ent.id, 'center.x')];
        const cy = xArray[variableSystem.getVariableIndex(ent.id, 'center.y')];
        const r = xArray[variableSystem.getVariableIndex(ent.id, 'radius')];
        if (actualPtIdx === 1) {
          const startAngle = xArray[variableSystem.getVariableIndex(ent.id, 'startAngle')];
          return [cx + r * Math.cos(startAngle), cy + r * Math.sin(startAngle)];
        } else {
          const endAngle = xArray[variableSystem.getVariableIndex(ent.id, 'endAngle')];
          return [cx + r * Math.cos(endAngle), cy + r * Math.sin(endAngle)];
        }
      }

      const indices = variableSystem.getPointVariableIndices(ent, actualPtIdx);
      return [xArray[indices[0]], xArray[indices[1]]];
    };

    const getPointCoords = (entityId: string, ptIndex?: number): [number, number] => {
      return getPointCoordsWithX(entityId, ptIndex, x);
    };

    for (const c of constraints) {
      if (c.type === 'horizontal') {
        const ent1Id = c.entityIds[0];
        const ent2Id = c.entityIds[1] || c.entityIds[0];
        const pt1Idx = c.pointIndices?.[0] !== undefined ? c.pointIndices[0] : 0;
        const pt2Idx = c.pointIndices?.[1] !== undefined ? c.pointIndices[1] : 1;
        
        const [, y1] = getPointCoords(ent1Id, pt1Idx);
        const [, y2] = getPointCoords(ent2Id, pt2Idx);
        residuals.push(y1 - y2);
      } 
      else if (c.type === 'vertical') {
        const ent1Id = c.entityIds[0];
        const ent2Id = c.entityIds[1] || c.entityIds[0];
        const pt1Idx = c.pointIndices?.[0] !== undefined ? c.pointIndices[0] : 0;
        const pt2Idx = c.pointIndices?.[1] !== undefined ? c.pointIndices[1] : 1;
        
        const [x1] = getPointCoords(ent1Id, pt1Idx);
        const [x2] = getPointCoords(ent2Id, pt2Idx);
        residuals.push(x1 - x2);
      } 
      else if (c.type === 'coincident') {
        const ent1Id = c.entityIds[0];
        const ent2Id = c.entityIds[1] || c.entityIds[0];
        const pt1Idx = c.pointIndices?.[0];
        const pt2Idx = c.pointIndices?.[1];

        const [x1, y1] = getPointCoords(ent1Id, pt1Idx);
        const [x2, y2] = getPointCoords(ent2Id, pt2Idx);
        residuals.push(x1 - x2);
        residuals.push(y1 - y2);
      } 
      else if (c.type === 'distance' || c.type === 'length') {
        const ent1Id = c.entityIds[0];
        const ent2Id = c.entityIds[1] || c.entityIds[0];
        const pt1Idx = c.pointIndices?.[0] !== undefined ? c.pointIndices[0] : 0;
        const pt2Idx = c.pointIndices?.[1] !== undefined ? c.pointIndices[1] : 1;

        const [x1, y1] = getPointCoords(ent1Id, pt1Idx);
        const [x2, y2] = getPointCoords(ent2Id, pt2Idx);
        const L = c.targetVal ?? c.value ?? 0;
        const dist = Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
        residuals.push(dist - L);
      } 
      else if (c.type === 'distance_x') {
        const ent1Id = c.entityIds[0];
        const ent2Id = c.entityIds[1] || c.entityIds[0];
        const pt1Idx = c.pointIndices?.[0] !== undefined ? c.pointIndices[0] : 0;
        const pt2Idx = c.pointIndices?.[1] !== undefined ? c.pointIndices[1] : 1;

        const [x1] = getPointCoords(ent1Id, pt1Idx);
        const [x2] = getPointCoords(ent2Id, pt2Idx);
        const target = c.targetVal ?? c.value ?? 0;
        residuals.push(Math.abs(x1 - x2) - target);
      }
      else if (c.type === 'distance_y') {
        const ent1Id = c.entityIds[0];
        const ent2Id = c.entityIds[1] || c.entityIds[0];
        const pt1Idx = c.pointIndices?.[0] !== undefined ? c.pointIndices[0] : 0;
        const pt2Idx = c.pointIndices?.[1] !== undefined ? c.pointIndices[1] : 1;

        const [, y1] = getPointCoords(ent1Id, pt1Idx);
        const [, y2] = getPointCoords(ent2Id, pt2Idx);
        const target = c.targetVal ?? c.value ?? 0;
        residuals.push(Math.abs(y1 - y2) - target);
      }
      else if (c.type === 'diameter' && c.entityIds.length >= 1) {
        const entA = entityMap.get(c.entityIds[0]);
        if (entA && (entA.type === 'circle' || entA.type === 'arc')) {
          const r = x[variableSystem.getVariableIndex(entA.id, 'radius')];
          const targetD = c.targetVal ?? c.value ?? 0;
          residuals.push(2 * r - targetD);
        }
      }
      else if (c.type === 'angle' && c.entityIds.length >= 2) {
        const [x1a, y1a] = getPointCoords(c.entityIds[0], 0);
        const [x1b, y1b] = getPointCoords(c.entityIds[0], 1);
        const [x2a, y2a] = getPointCoords(c.entityIds[1], 0);
        const [x2b, y2b] = getPointCoords(c.entityIds[1], 1);

        const v1x = x1b - x1a;
        const v1y = y1b - y1a;
        const v2x = x2b - x2a;
        const v2y = y2b - y2a;
        const len1 = Math.hypot(v1x, v1y);
        const len2 = Math.hypot(v2x, v2y);
        if (len1 > 1e-6 && len2 > 1e-6) {
          const cosTheta = (v1x * v2x + v1y * v2y) / (len1 * len2);
          const targetAngle = c.targetVal ?? c.value ?? 0;
          const targetCos = Math.cos(targetAngle);
          residuals.push(cosTheta - targetCos);
        }
      } 
      else if (c.type === 'parallel' && c.entityIds.length >= 2) {
        const [x1a, y1a] = getPointCoords(c.entityIds[0], 0);
        const [x1b, y1b] = getPointCoords(c.entityIds[0], 1);
        const [x2a, y2a] = getPointCoords(c.entityIds[1], 0);
        const [x2b, y2b] = getPointCoords(c.entityIds[1], 1);
        
        const dx1 = x1b - x1a;
        const dy1 = y1b - y1a;
        const dx2 = x2b - x2a;
        const dy2 = y2b - y2a;
        
        // cross product = 0
        residuals.push(dx1 * dy2 - dy1 * dx2);
      }
      else if (c.type === 'perpendicular' && c.entityIds.length >= 2) {
        const [x1a, y1a] = getPointCoords(c.entityIds[0], 0);
        const [x1b, y1b] = getPointCoords(c.entityIds[0], 1);
        const [x2a, y2a] = getPointCoords(c.entityIds[1], 0);
        const [x2b, y2b] = getPointCoords(c.entityIds[1], 1);
        
        const dx1 = x1b - x1a;
        const dy1 = y1b - y1a;
        const dx2 = x2b - x2a;
        const dy2 = y2b - y2a;
        
        // dot product = 0
        residuals.push(dx1 * dx2 + dy1 * dy2);
      }
      else if (c.type === 'tangent' && c.entityIds.length >= 2) {
        const entA = entityMap.get(c.entityIds[0]);
        const entB = entityMap.get(c.entityIds[1]);
        if (entA && entB) {
          const line = entA.type === 'line' ? entA : entB.type === 'line' ? entB : null;
          const circle = entA.type === 'circle' ? entA : entB.type === 'circle' ? entB : entA.type === 'arc' ? entA : entB.type === 'arc' ? entB : null;
          
          if (line && circle) {
            const [x1, y1] = getPointCoords(line.id, 0);
            const [x2, y2] = getPointCoords(line.id, 1);
            const cx = x[variableSystem.getVariableIndex(circle.id, 'center.x')];
            const cy = x[variableSystem.getVariableIndex(circle.id, 'center.y')];
            const r = x[variableSystem.getVariableIndex(circle.id, 'radius')];

            const dx = x2 - x1;
            const dy = y2 - y1;
            const len = Math.sqrt(dx * dx + dy * dy);
            
            // distance from center to line = r
            if (len > 1e-6) {
              const dist = Math.abs(dy * cx - dx * cy + x2 * y1 - y2 * x1) / len;
              residuals.push(dist - r);
            } else {
              residuals.push(0);
            }
          }
        }
      }
      else if (c.type === 'radius' && c.entityIds.length >= 1) {
        const entA = entityMap.get(c.entityIds[0]);
        if (entA && (entA.type === 'circle' || entA.type === 'arc')) {
          const r = x[variableSystem.getVariableIndex(entA.id, 'radius')];
          const targetR = c.targetVal ?? c.value ?? 0;
          residuals.push(r - targetR);
        }
      }
      else if (c.type === 'equal_radius' && c.entityIds.length >= 2) {
        const entA = entityMap.get(c.entityIds[0]);
        const entB = entityMap.get(c.entityIds[1]);
        if (entA && entB && (entA.type === 'circle' || entA.type === 'arc') && (entB.type === 'circle' || entB.type === 'arc')) {
          const rA = x[variableSystem.getVariableIndex(entA.id, 'radius')];
          const rB = x[variableSystem.getVariableIndex(entB.id, 'radius')];
          residuals.push(rA - rB);
        }
      }
      else if (c.type === 'equal_length' && c.entityIds.length >= 2) {
        for (let i = 0; i < c.entityIds.length - 1; i++) {
          const [x1a, y1a] = getPointCoords(c.entityIds[i], 0);
          const [x1b, y1b] = getPointCoords(c.entityIds[i], 1);
          const [x2a, y2a] = getPointCoords(c.entityIds[i + 1], 0);
          const [x2b, y2b] = getPointCoords(c.entityIds[i + 1], 1);
          
          const len1 = Math.sqrt((x1b - x1a) ** 2 + (y1b - y1a) ** 2);
          const len2 = Math.sqrt((x2b - x2a) ** 2 + (y2b - y2a) ** 2);
          residuals.push(len1 - len2);
        }
      }
      else if (c.type === 'fix') {
        const entId = c.entityIds[0];
        if (c.pointIndices && c.pointIndices.length > 0) {
          // 只固定特定點
          const ent = entityMap.get(entId);
          if (ent) {
            for (const ptIdx of c.pointIndices) {
              const [currX, currY] = getPointCoordsWithX(entId, ptIdx, x);
              const [initX, initY] = getPointCoordsWithX(entId, ptIdx, initialX);
              residuals.push(currX - initX);
              residuals.push(currY - initY);
            }
          }
        } else {
          // 固定整個圖元的所有變數
          const allIndices = variableSystem.getAllVariableIndices(entId);
          for (const idx of allIndices) {
            residuals.push(x[idx] - initialX[idx]);
          }
        }
      }
      // 其他約束類型保留在此處，等待後續實作擴充
    }

    return residuals;
  }
}
