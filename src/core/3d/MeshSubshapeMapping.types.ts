import type { TopoReference } from './PersistentTopology.types';

/**
 * 執行期 B-Rep 面參考 (Runtime B-Rep Face Reference)
 * 代表當前 B-Rep TopExp_Explorer 遍歷時產生的特定面之暫時性執行期身份，
 * 包含其幾何屬性與選用之持久化拓撲參照 (TopoReference)。
 */
export interface RuntimeBRepFaceRef {
  /** 所屬實體 ID (例如 'main-body') */
  bodyId: string;
  /** 當前 B-Rep 面在拓撲遍歷中的 0-based 執行階段索引 */
  faceIndex: number;
  /** 執行階段唯一識別碼，格式如 `brep_face_${bodyId}_${faceIndex}` */
  runtimeId: string;
  /** 曲面幾何類型 */
  surfaceType?: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'other';
  /** 平面法向向量 (單位向量) */
  normal?: { x: number; y: number; z: number };
  /** 表面積 (mm²) */
  area?: number;
  /** 質心位置 (mm) */
  centroid?: { x: number; y: number; z: number };
  /** 對應之持久化拓撲參照 (若已生成簽章) */
  topoRef?: TopoReference;
}

/**
 * 執行期 B-Rep 邊參考 (Runtime B-Rep Edge Reference)
 * 代表當前 B-Rep 邊在拓撲遍歷中的暫時性執行期身份。
 */
export interface RuntimeBRepEdgeRef {
  /** 所屬實體 ID */
  bodyId: string;
  /** 當前 B-Rep 邊在拓撲遍歷中的 0-based 執行階段索引 */
  edgeIndex: number;
  /** 執行階段唯一識別碼，格式如 `brep_edge_${bodyId}_${edgeIndex}` */
  runtimeId: string;
  /** 曲線幾何類型 */
  curveType?: 'line' | 'circle' | 'ellipse' | 'bspline' | 'bezier' | 'other';
  /** 邊長度 (mm) */
  length?: number;
  /** 切線或軸向單位向量 (直線/圓弧適用) */
  direction?: { x: number; y: number; z: number };
  /** 端點 1 */
  startPoint?: { x: number; y: number; z: number };
  /** 端點 2 */
  endPoint?: { x: number; y: number; z: number };
  /** 對應之持久化拓撲參照 */
  topoRef?: TopoReference;
}

/**
 * 執行期 B-Rep 頂點參考 (Runtime B-Rep Vertex Reference)
 * 代表當前 B-Rep 實體幾何角落頂點的執行期身份。
 */
export interface RuntimeBRepVertexRef {
  /** 所屬實體 ID */
  bodyId: string;
  /** 當前 B-Rep 頂點在拓撲遍歷中的 0-based 執行階段索引 */
  vertexIndex: number;
  /** 執行階段唯一識別碼，格式如 `brep_vertex_${bodyId}_${vertexIndex}` */
  runtimeId: string;
  /** 頂點 3D 空間位置 */
  point: { x: number; y: number; z: number };
  /** 對應之持久化拓撲參照 */
  topoRef?: TopoReference;
}

/**
 * B-Rep Face 在三角化網格中的連續三角形範圍
 */
export interface FaceTriangleRange {
  faceIndex: number;
  startTriangle: number;
  triangleCount: number;
}

/**
 * B-Rep Edge 在邊線段網格中的連續段落範圍
 */
export interface EdgeSegmentRange {
  edgeIndex: number;
  startSegment: number;
  segmentCount: number;
}

/**
 * Render Mesh ↔ OCC B-Rep Topology Mapping (網格-拓撲映射基礎層)
 * 嚴格遵循架構契約：
 * 1. Mesh Index ≠ B-Rep SubShape Identity ≠ Persistent Topology Identity
 * 2. 僅保存純資料結構，嚴禁包含任何 C++ WASM kernel 物件指針。
 * 3. 具備 generation 隔離，阻絕跨版本污染。
 */
export interface MeshSubshapeMapping {
  /** 所屬實體 ID */
  bodyId: string;
  /**
   * 生成版本 / 評估版號 (Generation)
   * 確保 Mapping(gen=N) 不會被誤用到 B-Rep(gen=N+1)
   */
  generation: number;

  /** 當前 B-Rep 面的執行期參考清單 */
  faces: RuntimeBRepFaceRef[];
  /** 當前 B-Rep 邊的執行期參考清單 */
  edges: RuntimeBRepEdgeRef[];
  /** 當前 B-Rep 頂點的執行期參考清單 */
  vertices: RuntimeBRepVertexRef[];

  /**
   * 三角面索引 -> B-Rep 面索引
   * triangleToFaceIndex[triangleIndex] = faceIndex
   * 若無對應面則為 -1
   */
  triangleToFaceIndex: number[] | Int32Array;

  /** 各 B-Rep Face 涵蓋的連續三角形範圍 */
  faceTriangleRanges: FaceTriangleRange[];

  /**
   * 渲染邊段索引 (以每 6 個 float (p1, p2) 為一單位) -> B-Rep 邊索引
   * meshEdgeToBRepEdgeIndex[meshEdgeIndex] = edgeIndex
   */
  meshEdgeToBRepEdgeIndex: number[] | Int32Array;

  /** 各 B-Rep Edge 涵蓋的連續邊線段範圍 */
  edgeSegmentRanges: EdgeSegmentRange[];

  /**
   * 網格頂點索引 (每 3 個 float (x, y, z) 為一單位) -> B-Rep 頂點索引
   * meshVertexToBRepVertexIndex[meshVertexIndex] = vertexIndex
   * 若為面內部節點或非頂點則為 -1 (明確 unresolved)
   */
  meshVertexToBRepVertexIndex: number[] | Int32Array;
}

/**
 * 3D 視圖 Mesh 選取結果實體 (MeshSelection)
 */
export type MeshSelection =
  | {
      kind: 'face';
      triangleIndex: number;
      faceRef: RuntimeBRepFaceRef;
      generation: number;
    }
  | {
      kind: 'edge';
      meshEdgeIndex: number;
      edgeRef: RuntimeBRepEdgeRef;
      generation: number;
    }
  | {
      kind: 'vertex';
      meshVertexIndex: number;
      vertexRef: RuntimeBRepVertexRef;
      generation: number;
    };

export type SubshapeResolutionStatus = 'exact' | 'unresolved' | 'generation_mismatch';

export interface FaceResolutionResult {
  status: SubshapeResolutionStatus;
  triangleIndex: number;
  faceRef: RuntimeBRepFaceRef | null;
  message?: string;
}

export interface EdgeResolutionResult {
  status: SubshapeResolutionStatus;
  meshEdgeIndex: number;
  edgeRef: RuntimeBRepEdgeRef | null;
  message?: string;
}

export interface VertexResolutionResult {
  status: SubshapeResolutionStatus;
  meshVertexIndex: number;
  vertexRef: RuntimeBRepVertexRef | null;
  message?: string;
}
