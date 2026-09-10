import { CADEntity2D } from '../../types/cad';

export interface SolverResult {
  entities: CADEntity2D[];
  iterations: number;
  maxDisp: number;
  converged: boolean;
  conflictEntityIds: string[];
}

export interface SketchDofState {
  totalDof: number;
  state: 'UnderDefined' | 'FullyDefined' | 'OverDefined';
  entityStates: Record<string, 'UnderDefined' | 'FullyDefined' | 'OverDefined'>;
}

export const SOLVER_MAX_ITERATIONS = 80;
export const SOLVER_TOLERANCE = 1e-4;
