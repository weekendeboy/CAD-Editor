import type { CustomPlane, Point3D, SketchProfile } from '../../types/cad';

export interface FeatureEvalOp {
  featureId: string;
  type:
    | 'EXTRUDE'
    | 'CUT_EXTRUDE'
    | 'REVOLVE'
    | 'REVOLVE_CUT'
    | 'LINEAR_PATTERN'
    | 'CIRCULAR_PATTERN'
    | 'MIRROR_3D'
    | 'SWEEP'
    | 'LOFT'
    | 'FILLET_3D'
    | 'CHAMFER_3D'
    | 'SHELL_3D';
  operation: 'JOIN' | 'CUT'; // JOIN: 長料 (Fuse); CUT: 除料 (Cut)
  targetFeatureIds?: string[]; // 要複製或鏡射的目標特徵 ID 清單
  profiles?: SketchProfile[]; // 該特徵引用的 2D 閉環輪廓
  plane?: CustomPlane | {
    origin: Point3D;
    xAxis: Point3D;
    yAxis: Point3D;
    normal: Point3D;
  };
  // 拉伸專用參數 (Extrude / Cut Extrude)
  depth?: number;
  direction?: 'normal' | 'reversed' | 'mid-plane';
  throughAll?: boolean;
  // 旋轉專用參數 (Revolve / Revolve Cut)
  axis?: {
    origin: Point3D;   // 3D 空間軸起點
    direction: Point3D;// 3D 空間軸單位方向向量
  };
  angle?: number; // 旋轉弧度
  // 線性陣列 (Linear Pattern)
  patternLinear?: {
    dir1: Point3D;
    count1: number;
    spacing1: number;
    dir2?: Point3D;
    count2?: number;
    spacing2?: number;
  };
  // 環狀陣列 (Circular Pattern)
  patternCircular?: {
    axis: {
      origin: Point3D;
      direction: Point3D;
    };
    count: number;
    totalAngle: number;
    equalSpacing: boolean;
  };
  // 3D 鏡射 (3D Mirror)
  mirrorPlane?: CustomPlane | {
    origin: Point3D;
    normal: Point3D;
  };
  // 掃出運算規格 (Sweep)
  sweepData?: {
    pathSegments: {
      type: 'line' | 'arc';
      start: Point3D;
      end: Point3D;
      center?: Point3D;
      radius?: number;
    }[];
  };
  // 疊層拉伸運算規格 (Loft)
  loftData?: {
    sections: {
      profiles: SketchProfile[];
      plane: CustomPlane | {
        origin: Point3D;
        xAxis: Point3D;
        yAxis: Point3D;
        normal: Point3D;
      };
    }[];
    isSolid: boolean;
    ruled: boolean;
  };
  // 3D 圓角/倒角/薄殼規格
  fillet3D?: {
    radius: number;
    edgeSelectionMode: 'all' | 'vertical' | 'horizontal';
  };
  chamfer3D?: {
    distance: number;
    edgeSelectionMode: 'all' | 'vertical' | 'horizontal';
  };
  shell3D?: {
    thickness: number;
    direction: 'inside' | 'outside';
  };
}

export type SolidTaskType =
  | 'INIT'
  | 'EXTRUDE_PROFILES'
  | 'EVALUATE_FEATURE_TREE'
  | 'EXPORT_STEP'
  | 'EXPORT_STL'
  | 'EXPORT_MODEL'
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

export interface ExportModelPayload {
  taskId: string;
  format: 'STEP' | 'STL';
  featureTree?: any[];
  operations?: FeatureEvalOp[];
  rollbackIndex?: number;
  planes?: Record<string, any>;
  unit?: 'mm' | 'inch';
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
  edges?: Float32Array;
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
