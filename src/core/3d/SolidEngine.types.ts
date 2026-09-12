export type SolidTaskType = 'INIT' | 'EXTRUDE_PROFILE' | 'EXPORT_STEP' | 'EXPORT_STL';

export interface SolidTaskRequest {
  taskId: string;
  type: SolidTaskType;
  payload?: any;
}

export interface ExtrudeProfilePayload {
  profile: any; // SketchProfile
  depth: number;
}

export interface SolidTaskResponse {
  taskId: string;
  type: SolidTaskType;
  success: boolean;
  data?: any;
  error?: string;
}

export interface ExtrudeProfileResponseData {
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array | Uint16Array;
}
