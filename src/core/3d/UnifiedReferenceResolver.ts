import type { Point3D, CustomPlane } from '../../types/cad';
import type {
  RuntimeBRepFaceRef,
  RuntimeBRepEdgeRef,
  RuntimeBRepVertexRef,
} from './MeshSubshapeMapping.types';
import {
  createPlaneFromFaceNormal,
  normalize3D,
  sub3D,
  length3D,
  validateThreePoints,
} from './DatumPlaneEngine';
import type {
  SelectedFaceReference,
  SelectedEdgeReference,
  SelectedVertexReference,
} from './UnifiedReferencePicker.types';

/**
 * 將 B-Rep 面轉換為基準面參照 (檢查平面性，非平面拋出錯誤或拒絕)
 */
export function resolveBRepFaceToReference(
  faceRef: RuntimeBRepFaceRef,
  hitPoint?: Point3D
): { isValid: boolean; reference?: SelectedFaceReference; error?: string } {
  if (!faceRef) {
    return { isValid: false, error: '未提供有效的 B-Rep 面參考' };
  }

  // 1. 嚴格檢查平面性：若明確標記非 plane 則拒絕
  if (faceRef.surfaceType && faceRef.surfaceType !== 'plane') {
    return {
      isValid: false,
      error: `選取的表面為 ${faceRef.surfaceType}（非平面），無法作為基準面參考`,
    };
  }

  // 2. 取得法向量
  const normal = faceRef.normal || { x: 0, y: 0, z: 1 };
  const normLen = length3D(normal);
  if (normLen < 1e-6) {
    return { isValid: false, error: '該表面的幾何法向量無效' };
  }

  // 3. 取得原點 (優先使用質心 centroid，其次為點擊點 hitPoint)
  const origin: Point3D = faceRef.centroid
    ? { ...faceRef.centroid }
    : hitPoint
    ? { ...hitPoint }
    : { x: 0, y: 0, z: 0 };

  const planeName = `B-Rep Face #${faceRef.faceIndex}`;
  const customPlane = createPlaneFromFaceNormal(origin, normal, planeName);

  return {
    isValid: true,
    reference: {
      kind: 'face',
      source: 'brep_face',
      plane: customPlane,
      faceRef,
      topoRef: faceRef.topoRef,
      point: origin,
      normal: normalize3D(normal),
    },
  };
}

/**
 * 將 B-Rep 邊線轉換為旋轉軸參照 (保證保留空間起點為 axisOrigin，不強設為 (0,0,0))
 */
export function resolveBRepEdgeToAxis(
  edgeRef: RuntimeBRepEdgeRef
): { isValid: boolean; reference?: SelectedEdgeReference; error?: string } {
  if (!edgeRef) {
    return { isValid: false, error: '未提供有效的 B-Rep 邊線參考' };
  }

  const p1 = edgeRef.startPoint;
  const p2 = edgeRef.endPoint;

  if (!p1 || !p2) {
    return { isValid: false, error: '邊線缺少起點或終點空間座標' };
  }

  const delta = sub3D(p2, p1);
  const len = length3D(delta);

  if (len < 1e-6) {
    // 若為圓形/圓弧且起訖點重合，優先使用圓心與圓平面法向量作為旋轉軸
    if (edgeRef.normal && length3D(edgeRef.normal) > 1e-6) {
      return {
        isValid: true,
        reference: {
          kind: 'edge',
          source: 'brep_edge',
          axisOrigin: edgeRef.center ? { ...edgeRef.center } : { ...p1 },
          axisDirection: normalize3D(edgeRef.normal),
          edgeRef,
          topoRef: edgeRef.topoRef,
        },
      };
    }
    // 若端點重合，嘗試使用 edgeRef.direction
    if (edgeRef.direction && length3D(edgeRef.direction) > 1e-6) {
      return {
        isValid: true,
        reference: {
          kind: 'edge',
          source: 'brep_edge',
          axisOrigin: { ...p1 },
          axisDirection: normalize3D(edgeRef.direction),
          edgeRef,
          topoRef: edgeRef.topoRef,
        },
      };
    }
    return { isValid: false, error: '邊線長度退化為零，無法作為旋轉軸' };
  }

  const axisDirection = normalize3D(delta);

  return {
    isValid: true,
    reference: {
      kind: 'edge',
      source: 'brep_edge',
      axisOrigin: { ...p1 },
      axisDirection,
      edgeRef,
      topoRef: edgeRef.topoRef,
    },
  };
}

/**
 * 將 B-Rep 頂點轉換為 3D 空間點
 */
export function resolveBRepVertexToPoint(
  vertexRef: RuntimeBRepVertexRef,
  targetIndex?: 1 | 2 | 3
): SelectedVertexReference {
  return {
    kind: 'vertex',
    source: 'brep_vertex',
    point: { ...vertexRef.point },
    vertexRef,
    topoRef: vertexRef.topoRef,
    targetIndex,
  };
}

/**
 * 驗證三點幾何
 */
export function validateThreePointsSelection(
  p1: Point3D,
  p2: Point3D,
  p3: Point3D
): { isValid: boolean; error?: string } {
  return validateThreePoints(p1, p2, p3);
}
