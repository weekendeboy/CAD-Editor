export type TopoSubShapeType = 'VERTEX' | 'EDGE' | 'FACE' | 'SOLID';

export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export interface BoundingBox3D {
  min: Vector3D;
  max: Vector3D;
}

export interface GeometrySignature {
  // 質心 / 重心位置
  centroid: Vector3D;
  // 空間邊界盒
  boundingBox: BoundingBox3D;
  // 幾何度量：邊為長度（length），面為面積（area）
  measure: number;
  // 法向向量（平面 Face 適用）
  normal?: Vector3D;
  // 切線向量或軸向向量（直線/圓弧 Edge 適用）
  direction?: Vector3D;
  // 曲線曲面類型
  curveType?: 'line' | 'circle' | 'ellipse' | 'bspline' | 'bezier' | 'other';
  surfaceType?: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'other';
}

export interface TopoReference {
  // 穩定唯一 ID（格式如：topo_EDGE_featId_hash）
  persistentId: string;
  // 產生或最後修改該拓撲子物件的特徵 ID
  featureId: string;
  // 實體 ID
  bodyId: string;
  // 拓撲類型
  subShapeType: TopoSubShapeType;
  // 幾何快照簽章（用於重算失配時的容差匹配）
  signature: GeometrySignature;
  // 該特徵歷史版本號
  generation: number;
}

export interface TopologyMap {
  bodyId: string;
  generation: number;
  faces: TopoReference[];
  edges: TopoReference[];
  vertices: TopoReference[];
  // 建立時間戳記或版本
  version: number;
}

export type ResolutionStatus = 
  | 'resolved'
  | 'ambiguous'
  | 'unresolved'
  | 'stale_generation'
  | 'body_mismatch'
  | 'kind_mismatch'
  | 'signature_mismatch';

export interface TopoResolutionResult {
  status: ResolutionStatus;
  targetRef: TopoReference;
  candidates: TopoReference[];
  resolvedPersistentId?: string;
  resolvedIndex?: number; // 在當前 OCC B-Rep 中的 subshape 索引
  kind: TopoSubShapeType;
  generation: number;
  message?: string;
}
