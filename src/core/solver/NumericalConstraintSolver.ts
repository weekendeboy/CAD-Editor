import { CADEntity2D, Constraint } from '../../types/cad';
import { VariableSystem } from './VariableSystem';
import { EquationSystem } from './EquationSystem';
import { MatrixMath } from './MatrixMath';

export class NumericalConstraintSolver {
  private static DELTA_H = 1e-7;
  private static MAX_ITER = 50;
  private static TOLERANCE = 1e-6;

  public static solveConstraints(
    entities: CADEntity2D[],
    constraints: Constraint[],
    fixedEntityIds: string[] = []
  ): { entities: CADEntity2D[]; converged: boolean; errorNorm: number; iterations: number; conflictEntityIds: string[] } {
    const varSys = new VariableSystem();
    let x = varSys.extractVariables(entities);
    const initialX = [...x];
    const n = x.length;

    if (n === 0) return { entities, converged: true, errorNorm: 0, iterations: 0, conflictEntityIds: [] };

    const entityMap = new Map(entities.map(e => [e.id, e]));

    // 注入固定圖元的隱式約束
    const solveConstraints = [...constraints];
    for (const id of fixedEntityIds) {
      solveConstraints.push({ id: `fix_${id}`, type: 'fix', entityIds: [id] });
    }

    let residuals = EquationSystem.evaluate(solveConstraints, x, initialX, varSys, entityMap);
    const m = residuals.length;
    
    if (m === 0) return { entities, converged: true, errorNorm: 0, iterations: 0, conflictEntityIds: [] };

    let errorNorm = this.norm(residuals);

    if (errorNorm < this.TOLERANCE) {
      return { entities, converged: true, errorNorm, iterations: 0, conflictEntityIds: [] };
    }

    let lambda = 1e-3;
    let v = 2;
    let iter = 0;

    for (; iter < this.MAX_ITER; iter++) {
      // 1. 數值差分計算 Jacobian 矩陣 (m * n)
      const J = this.computeJacobian(solveConstraints, x, initialX, varSys, entityMap, m, n);
      const JT = MatrixMath.transpose(J); // n * m
      const JTJ = MatrixMath.multiply(JT, J); // n * n
      const JTF = MatrixMath.multiplyVector(JT, residuals); // n * 1

      // 2. Levenberg-Marquardt 阻尼與初值錨定 (Anchor Damping)
      const A = MatrixMath.copy(JTJ);
      const anchorWeight = 1e-4; // 錨定權重，防止圖元在無衝突時亂飄

      for (let i = 0; i < n; i++) {
        // 利用對角線元素做自適應，或直接加上 lambda
        A[i][i] += lambda * Math.max(A[i][i], 1e-5) + anchorWeight; 
      }

      const b = JTF.map((val, i) => -(val + anchorWeight * (x[i] - initialX[i])));

      // 3. 求解線性方程組 A * delta = b
      let delta: number[];
      try {
        delta = MatrixMath.solve(A, b);
      } catch (e) {
        // 發生奇異矩陣等錯誤，增加阻尼退回重試
        lambda *= v;
        v *= 2;
        continue;
      }

      // 4. 更新變數，評估新的誤差
      const xNew = x.map((val, i) => val + delta[i]);
      const newResiduals = EquationSystem.evaluate(solveConstraints, xNew, initialX, varSys, entityMap);
      const newErrorNorm = this.norm(newResiduals);

      // 5. 根據誤差變化動態調整 LM 阻尼係數 (Damping Parameter lambda)
      if (newErrorNorm < errorNorm) {
        // 誤差減小，接受步進，減小 lambda 往高斯-牛頓法靠攏
        x = xNew;
        residuals = newResiduals;
        errorNorm = newErrorNorm;
        lambda = Math.max(1e-7, lambda / 10);
        v = 2;

        if (errorNorm < this.TOLERANCE) {
          break; // 收斂
        }
      } else {
        // 誤差增大，拒絕步進，增大 lambda 往梯度下降法靠攏
        lambda *= v;
        v *= 2;
      }
    }

    const resultEntities = varSys.applyVariables(x, entities);
    let converged = errorNorm < this.TOLERANCE;
    const conflictEntityIds = new Set<string>();

    if (!converged) {
      // Find which constraints are failing to converge
      let rIdx = 0;
      for (const c of solveConstraints) {
        let count = 0;
        if (c.type === 'coincident') count = 2;
        else if (c.type === 'horizontal' || c.type === 'vertical' || c.type === 'distance' || c.type === 'length' || c.type === 'parallel' || c.type === 'perpendicular' || c.type === 'tangent' || c.type === 'radius' || c.type === 'equal_length' || c.type === 'equal_radius') count = 1;
        else if (c.type === 'fix') {
          if (c.pointIndices && c.pointIndices.length > 0) count = c.pointIndices.length * 2;
          else {
            const allIndices = varSys.getAllVariableIndices(c.entityIds[0]);
            count = allIndices.length;
          }
        }
        
        let cErr = 0;
        for (let i = 0; i < count; i++) {
          cErr += residuals[rIdx + i] * residuals[rIdx + i];
        }
        if (cErr > this.TOLERANCE * this.TOLERANCE) {
          c.entityIds.forEach(id => conflictEntityIds.add(id));
        }
        rIdx += count;
      }
    }

    // Check for degenerate geometry
    for (const ent of resultEntities) {
      if (ent.type === 'line') {
        const dx = ent.end.x - ent.start.x;
        const dy = ent.end.y - ent.start.y;
        if (dx * dx + dy * dy < 1e-12) {
          converged = false;
          conflictEntityIds.add(ent.id);
        }
      } else if (ent.type === 'circle' || ent.type === 'arc') {
        if (ent.radius < 1e-6) {
          converged = false;
          conflictEntityIds.add(ent.id);
        }
      }
    }

    return {
      entities: resultEntities,
      converged,
      errorNorm,
      iterations: iter,
      conflictEntityIds: Array.from(conflictEntityIds)
    };
  }

  private static computeJacobian(
    constraints: Constraint[],
    x: number[],
    initialX: number[],
    varSys: VariableSystem,
    entityMap: Map<string, CADEntity2D>,
    m: number,
    n: number
  ): number[][] {
    const J: number[][] = Array(m).fill(0).map(() => Array(n).fill(0));

    // 使用中心差分 (Central Difference) 計算偏微分
    for (let j = 0; j < n; j++) {
      const xPlus = [...x];
      xPlus[j] += this.DELTA_H;
      const resPlus = EquationSystem.evaluate(constraints, xPlus, initialX, varSys, entityMap);
      
      const xMinus = [...x];
      xMinus[j] -= this.DELTA_H;
      const resMinus = EquationSystem.evaluate(constraints, xMinus, initialX, varSys, entityMap);

      for (let i = 0; i < m; i++) {
        J[i][j] = (resPlus[i] - resMinus[i]) / (2 * this.DELTA_H);
      }
    }

    return J;
  }

  private static norm(v: number[]): number {
    return Math.sqrt(v.reduce((sum, val) => sum + val * val, 0));
  }
}

export function solveConstraints(
  entities: CADEntity2D[],
  constraints: Constraint[],
  fixedEntityIds: string[] = []
): { entities: CADEntity2D[]; iterations: number; maxDisp: number; converged: boolean; conflictEntityIds: string[] } {
  const result = NumericalConstraintSolver.solveConstraints(entities, constraints, fixedEntityIds);
  return {
    entities: result.entities,
    iterations: result.iterations,
    maxDisp: result.errorNorm,
    converged: result.converged,
    conflictEntityIds: result.conflictEntityIds
  };
}

export function analyzeSketchDOF(
  entities: CADEntity2D[],
  constraints: Constraint[]
): import('./solverTypes').SketchDofState {
  const activeEntities = entities.filter(
    (e) =>
      !e.isConstruction &&
      e.visible !== false &&
      !e.isProjected &&
      !e.id.startsWith('virtual_') &&
      !e.id.startsWith('proj_') &&
      !e.id.includes('_proj_')
  );
  const entityStates: Record<string, import('../../types/cad').EntityState> = {};

  let totalDof = 0;
  for (const ent of activeEntities) {
    if (ent.type === 'line') totalDof += 4;
    else if (ent.type === 'circle') totalDof += 3;
    else if (ent.type === 'arc') totalDof += 5;
    else if (ent.type === 'polyline') totalDof += ent.points.length * 2;
    entityStates[ent.id] = 'UnderDefined';
  }

  let consumedDof = 0;
  for (const c of constraints) {
    switch (c.type) {
      case 'fix':
      case 'coincident':
        consumedDof += 2;
        break;
      case 'horizontal':
      case 'vertical':
      case 'length':
      case 'distance':
      case 'distance_x':
      case 'distance_y':
      case 'parallel':
      case 'perpendicular':
      case 'tangent':
      case 'equal_length':
      case 'equal_radius':
      case 'angle':
        consumedDof += 1;
        break;
    }
  }

  const remainingDof = totalDof - consumedDof;
  let overallState: import('../../types/cad').EntityState = 'UnderDefined';

  if (remainingDof < 0) {
    overallState = 'OverDefined';
    activeEntities.forEach((e) => {
      entityStates[e.id] = 'OverDefined';
    });
  } else if (remainingDof === 0 && activeEntities.length > 0) {
    overallState = 'FullyDefined';
    activeEntities.forEach((e) => {
      entityStates[e.id] = 'FullyDefined';
    });
  }

  return {
    totalDof: Math.max(0, remainingDof),
    state: overallState,
    entityStates,
  };
}

