import { CADDocument, CADEntity2D, CADLayer, Constraint, Point2D } from '../types/cad';

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

export interface CADState {
  document: CADDocument;
  
  viewMode: '2D' | '3D';
  currentTool: CADTool;
  activeSketchId: string | null;
  selectedEntityIds: string[];
  selectedFeatureId: string | null;
  osnapEnabled: boolean;
  orthoEnabled: boolean;

  // 鎖點開關與各模式勾選狀態（預設全開啟）
  osnapSettings: OsnapSettings;
  isOsnapModalOpen: boolean;
  setOsnapModalOpen: (open: boolean) => void;
  toggleOsnapMode: (mode: OsnapMode) => void;
  setAllOsnapModes: (enabled: boolean) => void;

  // 極座標追蹤角度設定（預設 45 度，候選角度包含 15, 30, 45, 90 等）
  polarTrackingEnabled: boolean;
  polarAngleStep: number; // 角度步進，例如 45
  customPolarAngles: number[]; // 自訂額外捕捉角度，例如 [22.5, 67.5]
  isPolarModalOpen: boolean;
  setPolarModalOpen: (open: boolean) => void;
  togglePolarTracking: () => void;
  setPolarAngleStep: (step: number) => void;
  addCustomPolarAngle: (angle: number) => void;
  removeCustomPolarAngle: (angle: number) => void;

  // 環形陣列 (Circular Array) 參數設定
  arrayItems: number; // 項目總數，預設為 4
  arrayFillAngle: number; // 填滿角度 (度)，預設為 360
  setArrayItems: (items: number) => void;
  setArrayFillAngle: (angle: number) => void;

  // 矩形陣列 (Rectangular Array) 參數設定
  rectArrayCols: number; // 行數 (X軸)，預設為 4
  rectArrayRows: number; // 列數 (Y軸)，預設為 3
  rectArrayColSpacing: number; // X軸間距，預設為 30
  rectArrayRowSpacing: number; // Y軸間距，預設為 30
  setRectArrayCols: (cols: number) => void;
  setRectArrayRows: (rows: number) => void;
  setRectArrayColSpacing: (spacing: number) => void;
  setRectArrayRowSpacing: (spacing: number) => void;

  // 倒角 (Chamfer) 距離設定（預設為 10）
  chamferDistance: number;
  setChamferDistance: (distance: number) => void;

  // 正多邊形 (Polygon) 設定
  polygonSides: number; // 邊數 (預設 5，範圍 3 ~ 1024)
  polygonMethod: 'inscribed' | 'circumscribed'; // 內接於圓 / 外切於圓
  setPolygonSides: (sides: number) => void;
  setPolygonMethod: (method: 'inscribed' | 'circumscribed') => void;

  undoStack: CADDocument[];
  redoStack: CADDocument[];

  setViewMode: (mode: '2D' | '3D') => void;
  setTool: (tool: CADTool) => void;
  setActiveSketch: (sketchId: string | null) => void;
  selectEntity: (id: string) => void;
  clearSelection: () => void;
  addEntity: (entity: CADEntity2D) => void;
  importEntities: (entities: CADEntity2D[]) => void;
  importDxfData: (entities: CADEntity2D[], layers: Record<string, CADLayer>) => void;
  removeEntity: (id: string) => void;
  updateEntity: (id: string, updates: Partial<CADEntity2D>) => void;
  updateEntities: (entities: CADEntity2D[]) => void;
  toggleConstruction: (entityId: string) => void;
  addConstraint: (constraint: Constraint) => void;
  addDimension: (dimension: any, constraint: Constraint) => void;
  updateDimensionPosition: (dimensionId: string, newPosition: Point2D) => void;
  updateDimensionPositionLive: (dimensionId: string, newPosition: Point2D) => void;
  removeConstraint: (constraintId: string) => void;
  updateConstraintValue: (constraintId: string, value: number) => void;
  dragVertexStart: () => void;
  dragVertexLive: (entityId: string, pointIndex: number, newPos: Point2D) => void;
  dragVertexCommit: () => void;
  trimEntity: (entityId: string, clickPoint: Point2D) => void;
  extendEntity: (entityId: string, clickPoint: Point2D) => void;
  applyFillet: (entityId1: string, entityId2: string, radius: number) => void;
  applyChamfer: (entityId1: string, entityId2: string, distance: number) => void;
  offsetEntity: (entityId: string, distance: number, sidePoint: Point2D) => void;
  mirrorEntities: (sourceEntityIds: string[], axisLineId: string) => void;
  moveEntities: (entityIds: string[], basePoint: Point2D, targetPoint: Point2D) => void;
  copyEntities: (entityIds: string[], basePoint: Point2D, targetPoint: Point2D) => void;
  scaleEntities: (entityIds: string[], basePoint: Point2D, factor: number) => void;
  rotateEntities: (entityIds: string[], basePoint: Point2D, angleRad: number) => void;
  circularArrayEntities: (entityIds: string[], centerPoint: Point2D, items: number, fillAngleDeg: number) => void;
  rectArrayEntities: (entityIds: string[], cols: number, rows: number, colSpacing: number, rowSpacing: number) => void;
  toggleOsnap: () => void;
  toggleOrtho: () => void;
  resetDocument: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}
