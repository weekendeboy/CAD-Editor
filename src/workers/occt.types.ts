import type { FeatureEvalOp } from '../core/3d/SolidEngine.types';

export type ExportFormat = 'STEP' | 'STL';

export interface MainToWorkerMessage {
  type: 'EXPORT_MODEL' | 'EVALUATE_FEATURE_TREE' | 'INIT';
  taskId: string;
  format?: ExportFormat;
  featureTree?: any[];
  operations?: FeatureEvalOp[];
  rollbackIndex?: number;
  planes?: Record<string, any>;
  unit?: 'mm' | 'inch';
  wasmBuffer?: ArrayBuffer;
}

export interface WorkerStatusMessage {
  type: 'EXPORT_SUCCESS' | 'EXPORT_ERROR' | 'SUCCESS' | 'ERROR';
  taskId: string;
  success: boolean;
  data?: ArrayBuffer | Uint8Array | string;
  error?: string;
}
