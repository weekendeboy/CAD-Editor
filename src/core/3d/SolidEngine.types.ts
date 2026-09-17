import type { CustomPlane, Point3D, SketchProfile } from '../../types/cad';
import type { TopoReference } from './PersistentTopology.types';
import type {
  MeshSubshapeMapping,
  RuntimeBRepFaceRef,
  RuntimeBRepEdgeRef,
  RuntimeBRepVertexRef,
  FaceTriangleRange,
  EdgeSegmentRange,
  MeshSelection,
  SubshapeResolutionStatus,
  FaceResolutionResult,
  EdgeResolutionResult,
  VertexResolutionResult,
} from './MeshSubshapeMapping.types';

export type {
  MeshSubshapeMapping,
  RuntimeBRepFaceRef,
  RuntimeBRepEdgeRef,
  RuntimeBRepVertexRef,
  FaceTriangleRange,
  EdgeSegmentRange,
  MeshSelection,
  SubshapeResolutionStatus,
  FaceResolutionResult,
  EdgeResolutionResult,
  VertexResolutionResult,
};

export interface KernelDiagnostic {
  level: 'info' | 'warning' | 'error';
  message: string;
  featureId?: string; // 發生錯誤的特徵 ID
  entityId?: string;  // 發生錯誤的具體圖元 ID (如某條 Arc)
}

export interface KernelShapeHandle {
  featureId: string;
  shapePtr: number; // WASM 記憶體指標的唯一識別碼，防範 Double-delete
  version: number;
  owner: 'feature-result' | 'temporary' | 'final';
}

export interface BodyResult {
  bodyId: string;
  name: string;
  isSolid: boolean;
  boundingBox?: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
}

export interface FeatureEvaluationResult {
  featureId: string;
  success: boolean;
  createdBodyIds: string[];    // 此特徵新產生的實體 ID（例如長料生成新 Body）
  modifiedBodyIds: string[];   // 此特徵修改或布林運算的實體 ID（例如除料、圓角修飾）
  diagnostics: KernelDiagnostic[];
  error: string | null;
  executionTimeMs: number;

  /**
   * 語意契約欄位 (Architecture Contract v1):
   * Feature Evaluation Result 代表該特徵經 Kernel 運算後的產物與影響，
   * 絕非也不等於當下整個零件的 Current Solid。
   */
  toolShape?: unknown;
  resultBody?: unknown;
  inputBody?: unknown;
  featureDelta?: unknown;
  topologyMap?: unknown;
}

/** 向下相容別名，確保既有介面與型別定義一致無痛運作 */
export type FeatureResult = FeatureEvaluationResult;

export interface KernelResult {
  taskId: string;
  success: boolean;
  finalMesh: MeshResult | null;
  featureResults: Record<string, FeatureEvaluationResult>; // 各特徵執行結果映射 (featureId -> FeatureEvaluationResult)
  bodies: BodyResult[];                                   // 當前活躍的實體清單
  diagnostics: KernelDiagnostic[];
  mapping?: MeshSubshapeMapping;                          // Render Mesh <-> B-Rep Topology Mapping
}

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
    edgeRefs?: TopoReference[];
    edgeIndices?: number[];
  };
  chamfer3D?: {
    distance: number;
    edgeSelectionMode: 'all' | 'vertical' | 'horizontal';
    edgeRefs?: TopoReference[];
    edgeIndices?: number[];
  };
  shell3D?: {
    thickness: number;
    direction: 'inside' | 'outside';
    removedFaceRefs?: TopoReference[];
    faceIndices?: number[];
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
  /**
   * 增量重算優化：FeatureEvalOp[] 中首個需要重新執行的 Operation Index。
   * null 表示沒有需要重新執行的 Operation（例如純回退棒移動或僅末端草圖被編輯）。
   */
  dirtyOpIndex?: number | null;
  /** @deprecated 請改用 dirtyOpIndex。保留以向下相容舊版呼叫端 */
  dirtyFromIndex?: number | null;
  isPureRollback?: boolean;
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
  success: boolean;
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array | Uint16Array;
  edgeVertices?: Float32Array;
  edges?: Float32Array; // 保留以維持向下相容
  mapping?: MeshSubshapeMapping; // Render Mesh <-> B-Rep Topology Mapping
  diagnostics?: KernelDiagnostic[]; // 接收 Worker 傳回的幾何建立失敗原因
}

export type ExtrudeProfileResponseData = MeshResult;

export interface SolidTaskResponse {
  taskId: string;
  type: SolidTaskType;
  success: boolean;
  data?: KernelResult | MeshResult | any;
  error?: string;
}

export type WorkerResponse = SolidTaskResponse;
