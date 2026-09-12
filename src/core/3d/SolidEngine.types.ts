import type { SketchProfile } from '../../types/cad';

export type SolidTaskType = 'INIT' | 'EXTRUDE_PROFILES' | 'EXPORT_STEP' | 'EXPORT_STL' | 'EXTRUDE_PROFILE';

export interface ExtrudeProfilesPayload {
  taskId: string;
  profiles: SketchProfile[];
  depth: number;
}

export interface ExportStepPayload {
  taskId: string;
  unit?: 'mm' | 'inch';
}

export interface ExportStlPayload {
  taskId: string;
}

export interface InitPayload {
  taskId: string;
  wasmBuffer?: ArrayBuffer;
}

export interface SolidTaskRequest {
  taskId: string;
  type: SolidTaskType;
  payload?: any;
}

export interface MeshResult {
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array | Uint16Array;
}

export type ExtrudeProfileResponseData = MeshResult;

export interface SolidTaskResponse {
  taskId: string;
  type: SolidTaskType;
  success: boolean;
  data?: any;
  error?: string;
}
