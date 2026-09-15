import { CADDocument, CADEntity2D, CADLayer, Constraint, Point2D, Point3D, ExtrudeFeature, CADFeature, CustomPlane } from '../types/cad';

export interface ExtrudePreviewState {
  isOpen: boolean;
  mode: 'EXTRUDE' | 'CUT_EXTRUDE';
  sketchId: string;
  depth: number;
  direction: 'normal' | 'reversed' | 'mid-plane';
  throughAll?: boolean;
}

export interface RevolvePreviewState {
  isOpen: boolean;
  mode: 'REVOLVE' | 'REVOLVE_CUT';
  sketchId: string;
  axisEntityId: string;
  angle: number; // in radians
  reversed?: boolean;
}

export type OsnapMode = 
  | 'endpoint' 
  | 'midpoint' 
  | 'center' 
  | 'quadrant' 
  | 'intersection' 
  | 'extension' 
  | 'perpendicular' 
  | 'tangent' 
  | 'parallel';

export type OsnapSettings = Record<OsnapMode, boolean>;

export type CADTool =
  | 'SELECT'
  | 'LINE'
  | 'RECTANGLE'
  | 'CIRCLE'
  | 'CIRCLE_TTR'
  | 'CIRCLE_3T'
  | 'ARC'
  | 'ARC_3P'
  | 'ARC_CENTER'
  | 'POLYLINE'
  | 'PAN'
  | 'DIMENSION'
  | 'TRIM'
  | 'FILLET'
  | 'CHAMFER'
  | 'EXTEND'
  | 'OFFSET'
  | 'MIRROR'
  | 'MOVE'
  | 'COPY'
  | 'SCALE'
  | 'ROTATE'
  | 'CIRCULAR_ARRAY'
  | 'RECT_ARRAY'
  | 'POLYGON';

export interface CADActions {
  // 特徵選取與特徵樹 Actions
  setSelectedFeatureId: (id: string | null) => void;
  addFeature: (feature: CADFeature) => void;
  removeFeature: (id: string) => void;
  updateFeature: (id: string, updates: Partial<CADFeature>) => void;
  toggleFeatureSuppression: (id: string) => void;
  renameFeature: (id: string, newName: string) => void;
  reorderFeature: (sourceIndex: number, targetIndex: number) => void;
  setRollbackIndex: (index: number) => void;
  regenerateFeatureTree: () => void;

  // 基準面 (Datum Plane) & 草圖連動 Actions
  addOffsetDatumPlane: (refPlaneId: string, distance: number, name?: string) => string;
  updateDatumPlaneOffset: (planeFeatureId: string, distance: number) => void;
  toggleFeatureVisibility: (featureId: string) => void;
  createSketchOnPlane: (planeId: string) => string; // 依附於指定基準面建立新草圖，回傳草圖 ID 並設為 activeSketchId
  createSketchOnFacePlane: (plane: CustomPlane) => string; // 依附於實體表面建立新草圖
  setSelectedFaceInfo: (face: { point: Point3D; normal: Point3D } | null) => void;

  // 3D 特徵管理
  addExtrudeFeature: (feature: Omit<ExtrudeFeature, 'id' | 'type'>) => void;
  updateExtrudeFeature: (id: string, updates: Partial<ExtrudeFeature>) => void;

  // 鎖點 (Osnap) 與 OTrack 追蹤控制設定
  clearOtrackAnchors: () => void;
  setOsnapModalOpen: (open: boolean) => void;
  toggleOsnapMode: (mode: OsnapMode) => void;
  setAllOsnapModes: (enabled: boolean) => void;
  toggleOsnap: () => void;

  // 極座標追蹤 (Polar Tracking) 設定
  setPolarModalOpen: (open: boolean) => void;
  togglePolarTracking: () => void;
  setPolarAngleStep: (step: number) => void;
  addCustomPolarAngle: (angle: number) => void;
  removeCustomPolarAngle: (angle: number) => void;

  // 環形與矩形陣列設定
  setArrayItems: (items: number) => void;
  setArrayFillAngle: (angle: number) => void;
  setRectArrayCols: (cols: number) => void;
  setRectArrayRows: (rows: number) => void;
  setRectArrayColSpacing: (spacing: number) => void;
  setRectArrayRowSpacing: (spacing: number) => void;

  // 倒角設定
  setChamferDistance: (distance: number) => void;

  // 正多邊形設定
  setPolygonSides: (sides: number) => void;
  setPolygonMethod: (method: 'inscribed' | 'circumscribed') => void;

  // 圖層管理
  setLayerModalOpen: (open: boolean) => void;
  setActiveLayer: (layerId: string) => void;
  addLayer: (layer: CADLayer) => void;
  updateLayer: (layerId: string, updates: Partial<CADLayer>) => void;
  removeLayer: (layerId: string) => void;
  renameLayer: (layerId: string, newName: string) => void;
  toggleLayerVisibility: (layerId: string) => void;
  toggleLayerLock: (layerId: string) => void;

  // 視圖與工具控制
  setViewMode: (mode: '2D' | '3D') => void;
  setTool: (tool: CADTool) => void;
  setActiveSketch: (sketchId: string | null) => void;
  selectEntity: (id: string) => void;
  clearSelection: () => void;

  // 2D 圖元編輯 Actions
  addEntity: (entity: CADEntity2D) => void;
  importEntities: (entities: CADEntity2D[]) => void;
  importDxfData: (entities: CADEntity2D[], layers: Record<string, CADLayer>) => void;
  removeEntity: (id: string) => void;
  updateEntity: (id: string, updates: Partial<CADEntity2D>) => void;
  updateEntities: (entities: CADEntity2D[]) => void;
  toggleConstruction: (entityId: string) => void;

  // 約束與尺寸標註 Actions
  addConstraint: (constraint: Constraint) => void;
  addDimension: (dimension: any, constraint: Constraint) => void;
  updateDimensionPosition: (dimensionId: string, newPosition: Point2D) => void;
  updateDimensionPositionLive: (dimensionId: string, newPosition: Point2D) => void;
  removeConstraint: (constraintId: string) => void;
  removeDimension: (dimensionId: string) => void;
  updateConstraintValue: (constraintId: string, value: number) => void;
  updateDimensionValue: (dimensionId: string, newValue: number) => void;

  // 控制點拖曳 Actions
  dragVertexStart: () => void;
  dragVertexLive: (entityId: string, pointIndex: number, newPos: Point2D) => void;
  dragVertexCommit: () => void;

  // 2D 幾何修剪、延伸與幾何變換 Actions
  trimEntity: (entityId: string, clickPoint: Point2D) => void;
  extendEntity: (entityId: string, clickPoint: Point2D) => void;
  applyFillet: (entityId1: string, entityId2: string, radius: number) => void;
  applyChamfer: (entityId1: string, entityId2: string, distance: number) => void;
  offsetEntity: (entityId: string, distance: number, sidePoint: Point2D) => void;
  mirrorEntities: (sourceEntityIds: string[], p1: Point2D, p2: Point2D) => void;
  moveEntities: (entityIds: string[], basePoint: Point2D, targetPoint: Point2D) => void;
  copyEntities: (entityIds: string[], basePoint: Point2D, targetPoint: Point2D) => void;
  scaleEntities: (entityIds: string[], basePoint: Point2D, factor: number) => void;
  rotateEntities: (entityIds: string[], basePoint: Point2D, angleRad: number) => void;
  circularArrayEntities: (entityIds: string[], centerPoint: Point2D, items: number, fillAngleDeg: number) => void;
  rectArrayEntities: (entityIds: string[], cols: number, rows: number, colSpacing: number, rowSpacing: number) => void;

  // 輔助模式與 Undo/Redo
  toggleOrtho: () => void;
  toggleShowProfiles: () => void;
  resetDocument: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // 上一次使用半徑 (AutoCAD 風格)
  setLastRadius: (r: number) => void;

  // 3D 邊線顯示與即時拉伸/旋轉預覽
  toggleShow3DEdges: () => void;
  setExtrudePreview: (preview: ExtrudePreviewState | null) => void;
  setRevolvePreview: (preview: RevolvePreviewState | null) => void;
  setIsPickingRevolveAxis: (isPicking: boolean) => void;
  setRevolveAxisEntityId: (axisId: string) => void;
}

export interface CADState extends CADActions {
  document: CADDocument;
  
  viewMode: '2D' | '3D';
  currentTool: CADTool;
  activeSketchId: string | null;
  selectedEntityIds: string[];
  selectedFeatureId: string | null;
  selectedFaceInfo: { point: Point3D; normal: Point3D } | null;
  osnapEnabled: boolean;
  orthoEnabled: boolean;
  showProfiles: boolean;
  show3DEdges: boolean;
  extrudePreview: ExtrudePreviewState | null;
  revolvePreview: RevolvePreviewState | null;
  isPickingRevolveAxis: boolean;

  // 鎖點開關與各模式勾選狀態（預設全開啟）
  osnapSettings: OsnapSettings;
  isOsnapModalOpen: boolean;

  // 極座標追蹤角度設定（預設 45 度，候選角度包含 15, 30, 45, 90 等）
  polarTrackingEnabled: boolean;
  polarAngleStep: number;
  customPolarAngles: number[];
  isPolarModalOpen: boolean;

  // 環形陣列 (Circular Array) 參數設定
  arrayItems: number;
  arrayFillAngle: number;

  // 矩形陣列 (Rectangular Array) 參數設定
  rectArrayCols: number;
  rectArrayRows: number;
  rectArrayColSpacing: number;
  rectArrayRowSpacing: number;

  // 倒角 (Chamfer) 距離設定（預設為 10）
  chamferDistance: number;

  // 正多邊形 (Polygon) 設定
  polygonSides: number;
  polygonMethod: 'inscribed' | 'circumscribed';

  // 記憶上一次使用半徑 (AutoCAD 風格)
  lastRadius: number;

  // 圖層狀態與管理
  activeLayerId: string;
  isLayerModalOpen: boolean;

  undoStack: CADDocument[];
  redoStack: CADDocument[];
}

export type CADStore = CADState;

