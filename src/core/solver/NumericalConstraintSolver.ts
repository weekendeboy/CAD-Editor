import { CADEntity2D, Constraint, ORIGIN_ENTITY_ID, EntityState } from '../../types/cad';
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
        A[i][i] += lambda * Math.max(A[i][i], 1e-5) + anchorWeight; 
      }

      const b = JTF.map((val) => -val);

      // 3. 求解線性方程組 A * delta = b
      let delta: number[];
      try {
        delta = MatrixMath.solve(A, b);
      } catch (e) {
        lambda *= v;
        v *= 2;
        continue;
      }

      // 4. 更新變數，評估新的誤差
      const xNew = x.map((val, i) => val + delta[i]);
      const newResiduals = EquationSystem.evaluate(solveConstraints, xNew, initialX, varSys, entityMap);
      const newErrorNorm = this.norm(newResiduals);

      // 5. 根據誤差變化動態調整 LM 阻尼係數
      if (newErrorNorm < errorNorm) {
        x = xNew;
        residuals = newResiduals;
        errorNorm = newErrorNorm;
        lambda = Math.max(1e-7, lambda / 10);
        v = 2;

        if (errorNorm < this.TOLERANCE) {
          break; // 收斂
        }
      } else {
        lambda *= v;
        v *= 2;
      }
    }

    const resultEntities = varSys.applyVariables(x, entities);
    
    // 計算硬約束殘差進行最終收斂判定
    let hardErrorNorm = 0;
    let rIdx = 0;
    for (const c of solveConstraints) {
      let count = 0;
      if (c.type === 'coincident') count = 2;
      else if (c.type === 'horizontal' || c.type === 'vertical' || c.type === 'distance' || c.type === 'length' || c.type === 'parallel' || c.type === 'perpendicular' || c.type === 'tangent' || c.type === 'radius' || c.type === 'equal_length' || c.type === 'equal_radius' || c.type === 'distance_x' || c.type === 'distance_y' || c.type === 'angle' || c.type === 'diameter') count = 1;
      else if (c.type === 'fix') {
        if (c.pointIndices && c.pointIndices.length > 0) count = c.pointIndices.length * 2;
        else {
          const allIndices = varSys.getAllVariableIndices(c.entityIds[0]);
          count = allIndices.length;
        }
      }

      if (!c.isSoft && (c.weight === undefined || c.weight >= 0.5)) {
        for (let i = 0; i < count; i++) {
          if (rIdx + i < residuals.length) {
            const res = residuals[rIdx + i];
            const w = c.weight !== undefined ? c.weight : 1.0;
            const unscaled = w > 0 ? res / w : res;
            hardErrorNorm += unscaled * unscaled;
          }
        }
      }
      rIdx += count;
    }
    hardErrorNorm = Math.sqrt(hardErrorNorm);

    let converged = hardErrorNorm < this.TOLERANCE;
    const conflictEntityIds = new Set<string>();

    if (!converged) {
      // Find which hard constraints are failing to converge
      rIdx = 0;
      for (const c of solveConstraints) {
        let count = 0;
        if (c.type === 'coincident') count = 2;
        else if (c.type === 'horizontal' || c.type === 'vertical' || c.type === 'distance' || c.type === 'length' || c.type === 'parallel' || c.type === 'perpendicular' || c.type === 'tangent' || c.type === 'radius' || c.type === 'equal_length' || c.type === 'equal_radius' || c.type === 'distance_x' || c.type === 'distance_y' || c.type === 'angle' || c.type === 'diameter') count = 1;
        else if (c.type === 'fix') {
          if (c.pointIndices && c.pointIndices.length > 0) count = c.pointIndices.length * 2;
          else {
            const allIndices = varSys.getAllVariableIndices(c.entityIds[0]);
            count = allIndices.length;
          }
        }

        if (c.isSoft || (c.weight !== undefined && c.weight < 0.5)) {
          rIdx += count;
          continue;
        }

        let cErr = 0;
        for (let i = 0; i < count; i++) {
          if (rIdx + i < residuals.length) {
            const res = residuals[rIdx + i];
            const w = c.weight !== undefined ? c.weight : 1.0;
            const unscaled = w > 0 ? res / w : res;
            cErr += unscaled * unscaled;
          }
        }
        if (cErr > this.TOLERANCE * this.TOLERANCE) {
          c.entityIds.filter(id => id !== 'origin' && id !== 'ORIGIN' && id !== ORIGIN_ENTITY_ID).forEach(id => conflictEntityIds.add(id));
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

    // 計算連通分量與圖元級別 DOF 狀態
    const dofState = analyzeSketchDOF(resultEntities, constraints);

    if (!converged) {
      if (conflictEntityIds.size > 0) {
        conflictEntityIds.forEach((id) => {
          dofState.entityStates[id] = 'OverDefined';
        });
      } else {
        resultEntities.forEach((e) => {
          dofState.entityStates[e.id] = 'OverDefined';
        });
      }
    }

    const finalEntities = resultEntities.map((e) => ({
      ...e,
      state: dofState.entityStates[e.id] || 'UnderDefined',
    }));

    return {
      entities: finalEntities,
      converged,
      errorNorm: hardErrorNorm,
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
  const entityStates: Record<string, EntityState> = {};

  if (activeEntities.length === 0) {
    return { totalDof: 0, state: 'UnderDefined', entityStates: {} };
  }

  // 1. 初始化每個圖元的 DOF
  const entityDofMap: Record<string, number> = {};
  for (const ent of activeEntities) {
    if (ent.type === 'line') entityDofMap[ent.id] = 4;
    else if (ent.type === 'circle') entityDofMap[ent.id] = 3;
    else if (ent.type === 'arc') entityDofMap[ent.id] = 5;
    else if (ent.type === 'polyline') entityDofMap[ent.id] = ent.points.length * 2;
    else entityDofMap[ent.id] = 2;
    entityStates[ent.id] = 'UnderDefined';
  }

  // 2. 構建圖元連通分量 (Union-Find)
  const parent: Record<string, string> = {};
  for (const ent of activeEntities) {
    parent[ent.id] = ent.id;
  }
  function find(id: string): string {
    if (!parent[id]) return id;
    if (parent[id] !== id) {
      parent[id] = find(parent[id]);
    }
    return parent[id];
  }
  function union(id1: string, id2: string) {
    const root1 = find(id1);
    const root2 = find(id2);
    if (root1 !== root2) {
      parent[root1] = root2;
    }
  }

  for (const c of constraints) {
    if (c.isSoft || (c.weight !== undefined && c.weight < 0.5)) continue;
    const validIds = c.entityIds.filter((id) => entityDofMap[id] !== undefined);
    if (validIds.length >= 2) {
      for (let i = 0; i < validIds.length - 1; i++) {
        union(validIds[i], validIds[i + 1]);
      }
    }
  }

  // 3. 計算各連通分量的 DOF 與 consumed DOF
  const compTotalDof: Record<string, number> = {};
  const compConsumedDof: Record<string, number> = {};

  for (const ent of activeEntities) {
    const root = find(ent.id);
    compTotalDof[root] = (compTotalDof[root] || 0) + entityDofMap[ent.id];
    compConsumedDof[root] = compConsumedDof[root] || 0;
  }

  for (const c of constraints) {
    if (c.isSoft || (c.weight !== undefined && c.weight < 0.5)) continue;
    let consumed = 0;
    switch (c.type) {
      case 'fix':
      case 'coincident':
        consumed = 2;
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
      case 'radius':
      case 'diameter':
        consumed = 1;
        break;
    }

    const validIds = c.entityIds.filter((id) => entityDofMap[id] !== undefined);
    if (validIds.length > 0) {
      const root = find(validIds[0]);
      compConsumedDof[root] = (compConsumedDof[root] || 0) + consumed;
    } else if (c.entityIds.includes('ORIGIN') || c.entityIds.includes('origin') || c.entityIds.includes(ORIGIN_ENTITY_ID)) {
      const otherId = c.entityIds.find((id) => id !== 'ORIGIN' && id !== 'origin' && id !== ORIGIN_ENTITY_ID && entityDofMap[id] !== undefined);
      if (otherId) {
        const root = find(otherId);
        compConsumedDof[root] = (compConsumedDof[root] || 0) + consumed;
      }
    }
  }

  // 計算圖元級別局部固定狀態 (Per-entity / Per-vertex Local Fixedness)
  const localFixedMap = computeLocalEntityStates(activeEntities, constraints);

  // 4. 根據連通分量的淨 DOF 與局部固定狀態判定每個圖元的狀態
  let totalRemainingDof = 0;
  let hasUnderDefined = false;
  let hasOverDefined = false;

  const compRoots = Object.keys(compTotalDof);
  for (const root of compRoots) {
    const remDof = compTotalDof[root] - compConsumedDof[root];
    totalRemainingDof += Math.max(0, remDof);

    let compState: EntityState = 'UnderDefined';
    if (remDof < 0) {
      compState = 'OverDefined';
      hasOverDefined = true;
    } else if (remDof === 0) {
      compState = 'FullyDefined';
    } else {
      hasUnderDefined = true;
    }

    activeEntities.forEach((ent) => {
      if (find(ent.id) === root) {
        if (compState === 'OverDefined') {
          entityStates[ent.id] = 'OverDefined';
        } else if (compState === 'FullyDefined' || localFixedMap[ent.id]) {
          entityStates[ent.id] = 'FullyDefined';
        } else {
          entityStates[ent.id] = 'UnderDefined';
        }
      }
    });
  }

  let overallState: EntityState = 'UnderDefined';
  if (hasOverDefined) {
    overallState = 'OverDefined';
  } else if (!hasUnderDefined && activeEntities.length > 0) {
    overallState = 'FullyDefined';
  }

  return {
    totalDof: Math.max(0, totalRemainingDof),
    state: overallState,
    entityStates,
  };
}

/**
 * 計算單一圖元級別的局部固定狀態 (Per-Entity Local Fixedness)
 * 當圖元滿足幾何定錨條件（例如：起點與原點重合 + 水平 + 尺寸標註）時，
 * 即使全域草圖仍有其他未標註邊（總 DOF > 0），該定錨邊依然為 FullyDefined。
 */
function computeLocalEntityStates(
  activeEntities: CADEntity2D[],
  constraints: Constraint[]
): Record<string, boolean> {
  const isLocallyFixed: Record<string, boolean> = {};

  // 1. 端點 Disjoint-Set (Union-Find)
  const pParent: Record<string, string> = {};
  const fixedPointRoots = new Set<string>();

  function findPoint(pKey: string): string {
    if (!pParent[pKey]) pParent[pKey] = pKey;
    if (pParent[pKey] !== pKey) {
      pParent[pKey] = findPoint(pParent[pKey]);
    }
    return pParent[pKey];
  }

  function unionPoints(p1: string, p2: string) {
    const root1 = findPoint(p1);
    const root2 = findPoint(p2);
    if (root1 !== root2) {
      if (fixedPointRoots.has(root1) || fixedPointRoots.has(root2)) {
        fixedPointRoots.add(root1);
        fixedPointRoots.add(root2);
      }
      pParent[root1] = root2;
    }
  }

  // 原點 (0,0) 天生固定
  const originRoot = findPoint('ORIGIN');
  fixedPointRoots.add(originRoot);

  function getPointKey(entityId: string, pointIndex?: number): string {
    if (entityId === 'ORIGIN' || entityId === 'origin' || entityId === ORIGIN_ENTITY_ID) {
      return 'ORIGIN';
    }
    if (pointIndex === 0) return `${entityId}:start`;
    if (pointIndex === 1) return `${entityId}:end`;
    return `${entityId}:pt_${pointIndex ?? 0}`;
  }

  // 2. 收集方向鎖定 (fixedOrientations) 與長度/半徑鎖定 (fixedLengths)
  const fixedOrientations = new Set<string>();
  const fixedLengths = new Set<string>();

  for (const c of constraints) {
    if (c.isSoft || (c.weight !== undefined && c.weight < 0.5)) continue;

    // 定錨固定約束 (fix)
    if (c.type === 'fix') {
      for (const entId of c.entityIds) {
        if (c.pointIndices && c.pointIndices.length > 0) {
          c.pointIndices.forEach((idx) => {
            const pk = findPoint(getPointKey(entId, idx));
            fixedPointRoots.add(pk);
          });
        } else {
          fixedPointRoots.add(findPoint(`${entId}:start`));
          fixedPointRoots.add(findPoint(`${entId}:end`));
          fixedPointRoots.add(findPoint(`${entId}:center`));
        }
      }
    }

    // 重合約束 (coincident)
    if (c.type === 'coincident') {
      const e1 = c.entityIds[0];
      const e2 = c.entityIds[1];
      const pk1 = getPointKey(e1, c.pointIndices ? c.pointIndices[0] : 0);
      const pk2 = getPointKey(e2, c.pointIndices ? c.pointIndices[1] : 0);
      unionPoints(pk1, pk2);
    }

    // 水平 / 垂直鎖定方向
    if (c.type === 'horizontal' || c.type === 'vertical') {
      if (c.entityIds[0]) fixedOrientations.add(c.entityIds[0]);
    }

    // 尺寸 / 長度標註鎖定大小
    if (c.type === 'length' || c.type === 'distance' || c.type === 'distance_x' || c.type === 'distance_y') {
      if (c.entityIds.length === 1) {
        fixedLengths.add(c.entityIds[0]);
      } else if (c.entityIds.length === 2 && c.entityIds[0] === c.entityIds[1]) {
        fixedLengths.add(c.entityIds[0]);
      }
    }

    if (c.type === 'radius' || c.type === 'diameter') {
      if (c.entityIds[0]) fixedLengths.add(c.entityIds[0]);
    }
  }

  // 3. 多輪傳播 (Propagation Loop)
  let changed = true;
  let iter = 0;
  while (changed && iter < 15) {
    changed = false;
    iter++;

    for (const ent of activeEntities) {
      if (isLocallyFixed[ent.id]) continue;

      if (ent.type === 'line') {
        const pk1 = findPoint(`${ent.id}:start`);
        const pk2 = findPoint(`${ent.id}:end`);
        const p1Fixed = fixedPointRoots.has(pk1);
        const p2Fixed = fixedPointRoots.has(pk2);

        if (p1Fixed && p2Fixed) {
          fixedOrientations.add(ent.id);
          fixedLengths.add(ent.id);
          isLocallyFixed[ent.id] = true;
          changed = true;
          continue;
        }

        const oriFixed = fixedOrientations.has(ent.id);
        const lenFixed = fixedLengths.has(ent.id);

        if ((p1Fixed && oriFixed && lenFixed) || (p2Fixed && oriFixed && lenFixed)) {
          isLocallyFixed[ent.id] = true;
          fixedPointRoots.add(pk1);
          fixedPointRoots.add(pk2);
          changed = true;
        }
      } else if (ent.type === 'circle') {
        const pkC = findPoint(`${ent.id}:center`);
        const cFixed = fixedPointRoots.has(pkC);
        const rFixed = fixedLengths.has(ent.id);
        if (cFixed && rFixed) {
          isLocallyFixed[ent.id] = true;
          changed = true;
        }
      } else if (ent.type === 'arc') {
        const pkC = findPoint(`${ent.id}:center`);
        const pkS = findPoint(`${ent.id}:start`);
        const pkE = findPoint(`${ent.id}:end`);
        const cFixed = fixedPointRoots.has(pkC);
        const sFixed = fixedPointRoots.has(pkS);
        const eFixed = fixedPointRoots.has(pkE);
        const rFixed = fixedLengths.has(ent.id);

        if (cFixed && rFixed && (sFixed || eFixed)) {
          isLocallyFixed[ent.id] = true;
          fixedPointRoots.add(pkS);
          fixedPointRoots.add(pkE);
          changed = true;
        }
      }
    }
  }

  return isLocallyFixed;
}
