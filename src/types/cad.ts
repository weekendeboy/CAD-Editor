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
  lineWidth?: number;
  isConstruction?: boolean;
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
  closed: boolean;
}

export type CADEntity2D =
  | LineEntity
  | CircleEntity
  | ArcEntity
  | PolylineEntity;

export type EntityState = 'UnderDefined' | 'FullyDefined' | 'OverDefined';

export type ConstraintType =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'tangent'
  | 'distance'
  | 'length'
  | 'fix'
  | 'equal_length'
  | 'equal_radius';

export interface Constraint {
  id: string;
  type: ConstraintType;
  entityIds: string[];
  pointIndices?: number[];
  value?: number;
}

export interface Dimension {
  id: string;
  type: 'linear' | 'radial';
  points: Point2D[];
  textPosition: Point2D;
  constraintId?: string;
  isDiameter?: boolean;
  entityIds?: string[]; // 記錄標註所依附的實體 ID 清單
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
  normal: Vector3D;
  xAxis: Vector3D;
  yAxis: Vector3D;
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

export type FeatureType = 'SKETCH' | 'EXTRUDE' | 'CUT' | 'PLANE';

export interface BaseFeatureNode {
  id: string;
  name: string;
  type: FeatureType;
  dependencies: string[];
  suppressed: boolean;
}

export interface SketchFeature extends BaseFeatureNode {
  type: 'SKETCH';
  plane: CustomPlane;
  entities: CADEntity2D[];
  constraints: Constraint[];
  dimensions: Dimension[];
  profiles: SketchProfile[];
  solverState: EntityState;
}

export interface ExtrudeFeature extends BaseFeatureNode {
  type: 'EXTRUDE';
  sketchId: string;
  depth: number;
  operation: 'ADD' | 'CUT';
}

export type FeatureNode = SketchFeature | ExtrudeFeature;

export interface CADLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  color: string;
}

export interface CADDocument {
  id: string;
  title: string;
  units: 'mm' | 'inch';
  layers: Record<string, CADLayer>;
  planes: Record<string, CustomPlane>;
  featureTree: FeatureNode[];
  activeSketchId: string | null;
}

export function createEmptyCADDocument(): CADDocument {
  return {
    id: 'doc-' + Date.now().toString(),
    title: 'Untitled Document',
    units: 'mm',
    layers: {
      'layer-0': {
        id: 'layer-0',
        name: 'Default',
        visible: true,
        locked: false,
        color: '#000000',
      },
    },
    planes: {
      'datum-front': DatumFrontPlane,
      'datum-top': DatumTopPlane,
      'datum-right': DatumRightPlane,
    },
    featureTree: [],
    activeSketchId: null,
  };
}
