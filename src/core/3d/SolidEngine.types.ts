import type { SketchProfile, CustomPlane } from '../../types/cad';

export interface FeatureEvalOp {
  featureId: string;
  type: 'EXTRUDE' | 'CUT_EXTRUDE';
  operation: 'JOIN' | 'CUT';
  profiles: SketchProfile[];
  plane: {
    origin: { x: number; y: number; z: number };
    xAxis: { x: number; y: number; z: number };
    yAxis: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
  };
  depth: number;
  direction: 'normal' | 'reversed' | 'mid-plane';
  throughAll?: boolean;
}

export type SolidTaskType =
  | 'INIT'
  | 'EXTRUDE_PROFILES'
  | 'EVALUATE_FEATURE_TREE'
  | 'EXPORT_STEP'
  | 'EXPORT_STL'
  | 'EXTRUDE_PROFILE';

export type WorkerTaskType = SolidTaskType;

export interface InitPayload {
  taskId: string;
  wasmBuffer?: ArrayBuffer;
}

export interface ExtrudeProfilesPayload {
  taskId: string;
  profiles: SketchProfile[];
  depth: number;
}

export interface EvaluateFeatureTreePayload {
  taskId: string;
  operations: FeatureEvalOp[];
}

export interface ExportStepPayload {
  taskId: string;
  unit?: 'mm' | 'inch';
}

export interface ExportStlPayload {
  taskId: string;
}

export type SolidTaskPayload =
  | InitPayload
  | ExtrudeProfilesPayload
  | EvaluateFeatureTreePayload
  | ExportStepPayload
  | ExportStlPayload;

export interface SolidTaskRequest {
  taskId: string;
  type: SolidTaskType;
  payload?: SolidTaskPayload | any;
}

export type WorkerRequest = SolidTaskRequest;

export interface MeshResult {
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array | Uint16Array;
  edgeVertices?: Float32Array;
}

export type ExtrudeProfileResponseData = MeshResult;

export interface SolidTaskResponse {
  taskId: string;
  type: SolidTaskType;
  success: boolean;
  data?: any;
  error?: string;
}

export type WorkerResponse = SolidTaskResponse;
