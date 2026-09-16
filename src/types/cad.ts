/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TopoReference } from '../core/3d/PersistentTopology.types';

export interface Point2D {
  x: number;
  y: number;
}

export type Vector2D = Point2D;

export interface BoundingBox2D {
  min: Point2D;
  max: Point2D;
}

export interface BaseCADEntity2D {
  id: string;
  layerId: string;
  visible: boolean;
  locked: boolean;
  color?: string;
  lineType?: string;
  lineWidth?: number;
  isConstruction?: boolean;
  isProjected?: boolean; // 投影幾何圖元識別 (Projected Geometry)
  state?: EntityState;   // [Runtime Cache] 求解器狀態，未來應移至 SolverRuntimeStore
}

export interface LineEntity extends BaseCADEntity2D {
  type: 'line';
  start: Point2D;
  end: Point2D;
}

export interface CircleEntity extends BaseCADEntity2D {
  type: 'circle';
  center: Point2D;
  radius: number;
}

export interface ArcEntity extends BaseCADEntity2D {
  type: 'arc';
  center: Point2D;
  radius: number;
  startAngle: number;
  endAngle: number;
}

export interface PolylineEntity extends BaseCADEntity2D {
  type: 'polyline';
  points: Point2D[];
  bulges?: number[]; // 對齊 AutoCAD Group Code 42 (凸度值)
  closed: boolean;
}

export interface InsertEntity extends BaseCADEntity2D {
  type: 'insert';
  blockName: string;
  position: Point2D;
  scale: Point2D; // { x: number, y: number }
  rotation: number; // 弧度
}

export interface CADBlockDefinition {
  id: string;
  name: string;
  basePoint: Point2D;
  entities: CADEntity2D[]; // 圖塊內部的原型圖元
}

export type CADEntity2D =
  | LineEntity
  | CircleEntity
  | ArcEntity
  | PolylineEntity
  | InsertEntity;

export type EntityState = 'UnderDefined' | 'FullyDefined' | 'OverDefined';

export type ConstraintType =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'tangent'
  | 'distance'
  | 'distance_x'
  | 'distance_y'
  | 'length'
  | 'fix'
  | 'equal_length'
  | 'equal_radius'
  | 'angle'
  | 'radius'
  | 'diameter';

export interface Constraint {
  id: string;
  type: ConstraintType;
  entityIds: string[];
  pointIndices?: number[];
  value?: number;
  targetVal?: number;
}

export interface Dimension {
  id: string;
  type: 'linear' | 'radial' | 'angular';
  dimType?: 'aligned' | 'horizontal' | 'vertical' | 'angular';
  isReference?: boolean;
  points: Point2D[];
  textPosition: Point2D;
  constraintId?: string;
  isDiameter?: boolean;
  entityIds?: string[]; // 記錄標註所依附的實體 ID 清單
  pointIndices?: number[]; // 記錄標註所依附的實體的點索引
  arcCenter?: Point2D;
  startAngle?: number;
  endAngle?: number;
  arcRadius?: number;
}

export interface TopologyNode {
  id: string;
  point: Point2D;
  edgeIds: string[];
}

export interface TopologyEdge {
  id: string;
  startNodeId: string;
  endNodeId: string;
  entityId: string;
}

export interface ProfileSegment {
  type: 'line' | 'arc';
  start: Point2D;
  end: Point2D;
  center?: Point2D;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  isLargeArc?: boolean;
  sweepFlag?: number;
}

export interface SketchProfile {
  id: string;
  outerLoop: Point2D[];
  segments: ProfileSegment[];
  innerLoops: Point2D[][];
  innerSegments?: ProfileSegment[][]; // 支援內環孔洞具備精確圓弧邊界
  area: number;
  isClockwise: boolean;
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export type Vector3D = Point3D;

export interface CustomPlane {
  id: string;
  name: string;
  origin: Point3D;
  normal: Point3D;
  xAxis: Point3D;
  yAxis: Point3D;
  parentFeatureId?: string;
}

export const DatumFrontPlane: CustomPlane = {
  id: 'datum-front',
  name: 'Front Plane (XY)',
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
};

export const DatumTopPlane: CustomPlane = {
  id: 'datum-top',
  name: 'Top Plane (XZ)',
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 1, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 0, z: 1 },
};

export const DatumRightPlane: CustomPlane = {
  id: 'datum-right',
  name: 'Right Plane (YZ)',
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 1, y: 0, z: 0 },
  xAxis: { x: 0, y: 1, z: 0 },
  yAxis: { x: 0, y: 0, z: 1 },
};

export type FeatureType = 
  | 'SKETCH' 
  | 'EXTRUDE' 
  | 'CUT_EXTRUDE' 
  | 'REVOLVE' 
  | 'REVOLVE_CUT' 
  | 'DATUM_PLANE' 
  | 'FILLET_3D' 
  | 'CHAMFER_3D'
  | 'SHELL_3D'
  | 'LINEAR_PATTERN'
  | 'CIRCULAR_PATTERN'
  | 'MIRROR_3D'
  | 'SWEEP'
  | 'LOFT';

/**
 * 【架構規範】 BaseCADFeature
 * 必須是 100% JSON 可序列化的「定義資料 (Parametric Definition)」。
 * 註：雖然規範不建議放入 isDirty、error，但在實務上 Store 仍將其附加作為 Runtime 標記。
 */
export interface BaseCADFeature {
  id: string;
  name: string;
  type: FeatureType | string;
  dependencies: string[]; // 所依賴的父特徵 ID 清單
  suppressed: boolean;    // 是否被抑制（跳過運算）
  visible?: boolean;      // 視圖可見度（可選布林）
  createdAt?: number;
  isDirty?: boolean;      // [Runtime] 標記需要重算
  error?: string | null;  // [Runtime] 特徵錯誤訊息
}

export type BaseFeatureNode = BaseCADFeature;

export interface SketchFeature extends BaseCADFeature {
  type: 'SKETCH';
  planeFeatureId?: string; // 所屬基準面特徵 ID
  plane: CustomPlane;      // 快取空間矩陣 / 平面資訊，確保渲染層無損相容
  entities: CADEntity2D[];
  constraints: Constraint[];
  dimensions: Dimension[];
  profiles: SketchProfile[];
  solverState?: EntityState; // [Runtime Cache] 未來應移出存檔模型
}

export interface ExtrudeFeature extends BaseCADFeature {
  type: 'EXTRUDE';
  sketchId: string;
  profileIds: string[];
  depth: number;
  direction: 'normal' | 'reversed' | 'mid-plane';
  draftAngle?: number;
  mergeResult?: boolean;
}

export interface CutExtrudeFeature extends BaseCADFeature {
  type: 'CUT_EXTRUDE';
  sketchId: string;
  profileIds: string[];
  depth: number;
  direction: 'normal' | 'reversed' | 'mid-plane';
  throughAll?: boolean;
}

export interface RevolveFeature extends BaseCADFeature {
  type: 'REVOLVE';
  sketchId: string;
  profileIds: string[];
  axisEntityId: string; // 草圖內作為旋轉軸的直線圖元 ID
  angle: number;        // 旋轉弧度 (預設為 2 * Math.PI, 即 360°)
}

export interface RevolveCutFeature extends BaseCADFeature {
  type: 'REVOLVE_CUT';
  sketchId: string;
  profileIds: string[];
  axisEntityId: string;
  angle: number;
}

export type DatumPlaneType = 'offset' | 'angle' | 'three-point' | 'face_reference';

export interface DatumPlaneFeature extends BaseCADFeature {
  type: 'DATUM_PLANE';
  planeType: DatumPlaneType;
  referencePlaneId: string;       // 參照的基準面 ID（預設面或自訂面）
  referenceFeatureId?: string;    // 參照特徵/基準面 ID（向下相容）
  offsetDistance: number;          // 平面法向偏移距離 (mm)
  rotationAngle?: number;          // 旋轉弧度 (rad)
  rotationAngleDeg?: number;       // 旋轉度數 (deg，便於 UI 雙向綁定)
  axisOrigin?: Point3D;            // 旋轉軸起點
  axisDirection?: Point3D;         // 旋轉軸單位方向向量
  referenceEdgeEntityId?: string;  // 參照的空間邊或草圖直線圖元 ID (選填)
  plane: CustomPlane;              // 由 DatumPlaneEngine 求解出的空間姿態
}

export interface Fillet3DFeature extends BaseCADFeature {
  type: 'FILLET_3D';
  radius: number;                       // 圓角半徑 (mm, 預設 2.0)
  edgeSelectionMode?: 'all' | 'vertical' | 'horizontal'; // 邊界篩選模式 (預設 'all')
  targetFeatureId?: string;             // 作用目標特徵 ID (選填，若無則作用於全域累進母體)
  edgeIndices?: number[];               // 作用邊緣索引（向下相容）
  edgeRefs?: TopoReference[];           // 作用邊緣持久化拓撲參照
}

export interface Chamfer3DFeature extends BaseCADFeature {
  type: 'CHAMFER_3D';
  distance: number;                     // 倒角距離 (mm, 預設 2.0)
  edgeSelectionMode?: 'all' | 'vertical' | 'horizontal'; // 邊界篩選模式 (預設 'all')
  targetFeatureId?: string;             // 作用目標特徵 ID (選填)
  angle?: number;                       // 倒角角度（向下相容）
  edgeIndices?: number[];               // 作用邊緣索引（向下相容）
  edgeRefs?: TopoReference[];           // 作用邊緣持久化拓撲參照
}

export interface Shell3DFeature extends BaseCADFeature {
  type: 'SHELL_3D';
  thickness: number;                    // 殼厚度 (mm, 預設 1.5)
  direction: 'inside' | 'outside';      // 向內或向外薄殼
  targetFeatureId?: string;             // 作用目標特徵 ID (選填)
  removedFaceRefs?: TopoReference[];    // 移除的面拓撲參照
  faceIndices?: number[];               // 移除的面索引（向下相容）
}

export interface LinearPatternFeature extends BaseCADFeature {
  type: 'LINEAR_PATTERN';
  targetFeatureIds: string[]; // 要複製的特徵 ID 清單
  dir1: Point3D;              // 方向 1 向量 (3D 空間方向)
  count1: number;             // 方向 1 實例總數 (包含原件，>= 2)
  spacing1: number;           // 方向 1 間距 (mm)
  dir2?: Point3D;             // 方向 2 向量 (選填)
  count2?: number;            // 方向 2 實例總數 (選填，>= 1)
  spacing2?: number;          // 方向 2 間距 (選填)
}

export interface CircularPatternFeature extends BaseCADFeature {
  type: 'CIRCULAR_PATTERN';
  targetFeatureIds: string[]; // 要複製的特徵 ID 清單
  axisOrigin: Point3D;        // 旋轉中心軸起點
  axisDirection: Point3D;     // 旋轉中心軸單位方向向量
  count: number;              // 實例總數 (>= 2)
  totalAngle: number;         // 填滿總角度 (弧度，例如 2 * Math.PI)
  equalSpacing: boolean;      // 是否等間距排列
}

export interface Mirror3DFeature extends BaseCADFeature {
  type: 'MIRROR_3D';
  targetFeatureIds: string[];     // 要鏡射的特徵 ID 清單
  mirrorPlaneFeatureId: string;   // 參照的 DatumPlane 特徵 ID
}

export interface SweepFeature extends BaseCADFeature {
  type: 'SWEEP';
  profileSketchId: string; // 截面草圖 ID
  pathSketchId: string;    // 導引路徑草圖 ID
}

export interface LoftFeature extends BaseCADFeature {
  type: 'LOFT';
  sketchIds: string[];     // 依序排列的 2 個以上斷面草圖 ID 清單
  isSolid: boolean;        // 是否封閉為實體 (預設 true)
  ruled: boolean;          // 是否為直紋面 (ruled: true 直線過渡; false: B-Spline 平滑過渡)
}

export type CADFeature = 
  | SketchFeature 
  | ExtrudeFeature 
  | CutExtrudeFeature 
  | RevolveFeature 
  | RevolveCutFeature 
  | DatumPlaneFeature 
  | Fillet3DFeature 
  | Chamfer3DFeature
  | Shell3DFeature
  | LinearPatternFeature
  | CircularPatternFeature
  | Mirror3DFeature
  | SweepFeature
  | LoftFeature;

export type FeatureNode = CADFeature;

export interface CADLayer {
  id: string;
  name: string;
  color: string;
  aciColor: number;
  lineType: 'CONTINUOUS' | 'DASHED' | 'CENTER' | 'HIDDEN';
  lineWidth: number;
  visible: boolean;
  locked: boolean;
  isPlot: boolean;
}

/**
 * 【架構規範】 CADDocument
 * 代表真正寫入檔案的「持久化資料模型」。
 * 絕對禁止將 UI 狀態 (如 activeSketchId) 放入此結構。
 */
export interface CADDocument {
  id: string;
  title: string;
  units: 'mm' | 'inch';
  layers: Record<string, CADLayer>;
  planes: Record<string, CustomPlane>;
  featureTree: CADFeature[];
  rollbackIndex: number; // 歷史回退棒位置 (保留，因為 SolidWorks 存檔會包含回退狀態)
  blocks: Record<string, CADBlockDefinition>;
}

export const DEFAULT_CAD_LAYERS: Record<string, CADLayer> = {
  '0': {
    id: '0',
    name: '0',
    color: '#FFFFFF',
    aciColor: 7,
    lineType: 'CONTINUOUS',
    lineWidth: 0.25,
    visible: true,
    locked: false,
    isPlot: true,
  },
  'CONSTRUCTION': {
    id: 'CONSTRUCTION',
    name: 'CONSTRUCTION',
    color: '#FF00FF',
    aciColor: 6,
    lineType: 'DASHED',
    lineWidth: 0.25,
    visible: true,
    locked: false,
    isPlot: false,
  },
  'DEFPOINTS': {
    id: 'DEFPOINTS',
    name: 'DEFPOINTS',
    color: '#808080',
    aciColor: 8,
    lineType: 'CONTINUOUS',
    lineWidth: 0.25,
    visible: true,
    locked: false,
    isPlot: false,
  },
};

export function createEmptyCADDocument(): CADDocument {
  const featureTree: CADFeature[] = [];
  return {
    id: 'doc-' + Date.now().toString(),
    title: 'Untitled Document',
    units: 'mm',
    layers: {
      '0': {
        id: '0',
        name: '0',
        color: '#FFFFFF',
        aciColor: 7,
        lineType: 'CONTINUOUS',
        lineWidth: 0.25,
        visible: true,
        locked: false,
        isPlot: true,
      },
      'CONSTRUCTION': {
        id: 'CONSTRUCTION',
        name: 'CONSTRUCTION',
        color: '#FF00FF',
        aciColor: 6,
        lineType: 'DASHED',
        lineWidth: 0.25,
        visible: true,
        locked: false,
        isPlot: false,
      },
      'DEFPOINTS': {
        id: 'DEFPOINTS',
        name: 'DEFPOINTS',
        color: '#808080',
        aciColor: 8,
        lineType: 'CONTINUOUS',
        lineWidth: 0.25,
        visible: true,
        locked: false,
        isPlot: false,
      },
    },
    planes: {
      'datum-front': DatumFrontPlane,
      'datum-top': DatumTopPlane,
      'datum-right': DatumRightPlane,
    },
    featureTree,
    rollbackIndex: featureTree.length,
    blocks: {},
  };
}