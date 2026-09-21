import type { Point3D, CustomPlane } from '../../types/cad';
import type {
  RuntimeBRepFaceRef,
  RuntimeBRepEdgeRef,
  RuntimeBRepVertexRef,
} from './MeshSubshapeMapping.types';
import type { TopoReference } from './PersistentTopology.types';

/**
 * 3D 參照選取幾何種類
 */
export type ReferenceSelectionKind = 'face' | 'edge' | 'vertex';

/**
 * 基準面 PropertyManager 當前作用中的 3D 拾取目標
 */
export type DatumPickerTarget =
  | 'reference_plane'
  | 'rotation_axis'
  | 'point1'
  | 'point2'
  | 'point3';

/**
 * 3D 面參照選取結果
 */
export interface SelectedFaceReference {
  kind: 'face';
  source: 'brep_face' | 'datum_plane';
  plane: CustomPlane;
  planeId?: string;
  faceRef?: RuntimeBRepFaceRef;
  topoRef?: TopoReference;
  point?: Point3D;
  normal?: Point3D;
}

/**
 * 3D 邊線 / 旋轉軸參照選取結果
 */
export interface SelectedEdgeReference {
  kind: 'edge';
  source: 'brep_edge' | 'sketch_line';
  axisOrigin: Point3D;
  axisDirection: Point3D;
  edgeRef?: RuntimeBRepEdgeRef;
  topoRef?: TopoReference;
  lineId?: string;
}

/**
 * 3D 頂點參照選取結果
 */
export interface SelectedVertexReference {
  kind: 'vertex';
  source: 'brep_vertex' | 'sketch_vertex';
  point: Point3D;
  vertexRef?: RuntimeBRepVertexRef;
  topoRef?: TopoReference;
  id?: string;
  targetIndex?: 1 | 2 | 3;
}
