import type {
  TopoReference,
  TopoSubShapeType,
  GeometrySignature,
  TopologyMap,
  Vector3D,
  BoundingBox3D,
  TopoResolutionResult,
  ResolutionStatus,
} from './PersistentTopology.types';
import { resolveTopoReference } from './TopologyMapper';

export interface OCCSubShapeResolution {
  status: ResolutionStatus;
  resolution: TopoResolutionResult;
  occShape?: any; // TopoDS_Shape / TopoDS_Edge (Worker-internal only!)
  error?: string;
}

/**
 * 結合拓撲映射解析與 OCC 子形狀提取 (Worker 內部專用)
 */
export function resolveTopoReferenceToOCC(
  ref: TopoReference,
  topologyMap: TopologyMap,
  occ: any,
  solid: any
): OCCSubShapeResolution {
  const resolution = resolveTopoReference(ref, topologyMap);
  if (resolution.status !== 'resolved') {
    return {
      status: resolution.status,
      resolution,
      error: resolution.message || `Failed to resolve topology reference ${ref.persistentId} (status: ${resolution.status})`,
    };
  }

  const occShape = resolveOCCSubShape(solid, occ, resolution);
  const isNull =
    !occShape ||
    (typeof occShape.IsNull === 'function' && occShape.IsNull());
  if (isNull) {
    return {
      status: 'unresolved',
      resolution: {
        ...resolution,
        status: 'unresolved',
        message: `Resolved index ${resolution.resolvedIndex} but failed to extract OCC subshape from solid.`,
      },
      error: `Failed to extract OCC subshape for ${ref.persistentId}`,
    };
  }

  return {
    status: 'resolved',
    resolution,
    occShape,
  };
}

/**
 * 將解析成功的 TopoResolutionResult 轉換為實際的 OCC TopoDS_Shape
 * 警告：回傳的 OCC 物件只能在 Worker 中使用，且應注意記憶體管理
 */
export function resolveOCCSubShape(
  shape: any,
  occ: any,
  resolution: TopoResolutionResult
): any {
  if (resolution.status !== 'resolved' || resolution.resolvedIndex === undefined) {
    return null;
  }

  let shapeEnum: any;
  if (resolution.kind === 'FACE') {
    shapeEnum = occ.TopAbs_ShapeEnum.TopAbs_FACE;
  } else if (resolution.kind === 'EDGE') {
    shapeEnum = occ.TopAbs_ShapeEnum.TopAbs_EDGE;
  } else if (resolution.kind === 'VERTEX') {
    shapeEnum = occ.TopAbs_ShapeEnum.TopAbs_VERTEX;
  } else {
    return null;
  }

  let explorer: any = null;
  const hashSet = new Set<number>();
  let targetShape: any = null;

  try {
    explorer = new occ.TopExp_Explorer_2(
      shape,
      shapeEnum,
      occ.TopAbs_ShapeEnum.TopAbs_SHAPE
    );

    let index = 0;
    while (explorer.More()) {
      let currentSubShape: any = null;
      let shouldSkip = false;
      let hashCode = index;

      if (resolution.kind === 'FACE') {
        currentSubShape = occ.TopoDS.Face_1(explorer.Current());
        // Face 萃取目前沒有 skip / hash check
      } else if (resolution.kind === 'EDGE') {
        currentSubShape = occ.TopoDS.Edge_1(explorer.Current());
        if (occ.BRep_Tool.Degenerated(currentSubShape)) {
          shouldSkip = true;
        } else {
          hashCode = typeof currentSubShape.HashCode === 'function'
            ? currentSubShape.HashCode(0x7fffffff)
            : typeof currentSubShape.HashCode_1 === 'function'
            ? currentSubShape.HashCode_1(0x7fffffff)
            : index;
          if (hashSet.has(hashCode)) {
            shouldSkip = true;
          }
        }
      } else if (resolution.kind === 'VERTEX') {
        currentSubShape = occ.TopoDS.Vertex_1(explorer.Current());
        hashCode = typeof currentSubShape.HashCode === 'function'
          ? currentSubShape.HashCode(0x7fffffff)
          : typeof currentSubShape.HashCode_1 === 'function'
          ? currentSubShape.HashCode_1(0x7fffffff)
          : index;
        if (hashSet.has(hashCode)) {
          shouldSkip = true;
        }
      }

      if (shouldSkip) {
        safeDelete(currentSubShape);
        explorer.Next();
        continue;
      }

      hashSet.add(hashCode);

      if (index === resolution.resolvedIndex) {
        // We found the target. We need to create a copy of the wrapper or just return it.
        // Wait, currentSubShape is the wrapper. We shouldn't delete it since we're returning it.
        targetShape = currentSubShape;
        break;
      } else {
        safeDelete(currentSubShape);
      }

      index++;
      explorer.Next();
    }
  } finally {
    safeDelete(explorer);
  }

  return targetShape;
}

/**
 * 數值四捨五入以消除浮點微震
 */
export function roundVal(v: number, precision: number = 4): number {
  const factor = Math.pow(10, precision);
  return Math.round(v * factor) / factor;
}

/**
 * 產生幾何簽章的確定性短雜湊（Fingerprint）
 */
export function hashSignature(sig: GeometrySignature): string {
  const c = sig.centroid;
  const cx = roundVal(c.x, 2);
  const cy = roundVal(c.y, 2);
  const cz = roundVal(c.z, 2);
  const m = roundVal(sig.measure, 2);
  const sType = sig.surfaceType || sig.curveType || 'gen';
  return `c_${cx}_${cy}_${cz}_m_${m}_${sType}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * 安全釋放 OCC WASM 物件記憶體
 */
function safeDelete(obj: any): void {
  if (!obj) return;
  try {
    if (typeof obj.delete === 'function') {
      obj.delete();
    }
  } catch (_) {
    // 忽略記憶體釋放例外
  }
}

/**
 * 萃取 B-Rep 中所有面（Face）的幾何簽章與持久化參考
 */
export function extractFaceSignatures(
  shape: any,
  occ: any,
  featureId: string,
  bodyId: string = 'main-body',
  generation: number = 1
): TopoReference[] {
  const faces: TopoReference[] = [];
  if (!shape || shape.IsNull()) return faces;

  let explorer: any = null;
  try {
    explorer = new occ.TopExp_Explorer_2(
      shape,
      occ.TopAbs_ShapeEnum.TopAbs_FACE,
      occ.TopAbs_ShapeEnum.TopAbs_SHAPE
    );

    let index = 0;
    while (explorer.More()) {
      const face = occ.TopoDS.Face_1(explorer.Current());
      let gprops: any = null;
      let bbox: any = null;
      let adaptor: any = null;

      try {
        const GPropCtor = occ.GProp_GProps_1 || occ.GProp_GProps;
        gprops = new GPropCtor();
        if (typeof occ.BRepGProp.SurfaceProperties_1 === 'function') {
          try {
            occ.BRepGProp.SurfaceProperties_1(face, gprops, false, false);
          } catch (_) {
            occ.BRepGProp.SurfaceProperties_1(face, gprops);
          }
        } else if (typeof occ.BRepGProp.SurfaceProperties === 'function') {
          try {
            occ.BRepGProp.SurfaceProperties(face, gprops, false, false);
          } catch (_) {
            occ.BRepGProp.SurfaceProperties(face, gprops);
          }
        }

        const area = gprops.Mass();
        const cMass = gprops.CentreOfMass();
        const centroid: Vector3D = {
          x: roundVal(cMass.X()),
          y: roundVal(cMass.Y()),
          z: roundVal(cMass.Z()),
        };
        safeDelete(cMass);

        const BoxCtor = occ.Bnd_Box_1 || occ.Bnd_Box;
        bbox = new BoxCtor();
        if (typeof occ.BRepBndLib?.Add === 'function') {
          try {
            occ.BRepBndLib.Add(face, bbox, false);
          } catch (_) {
            try {
              occ.BRepBndLib.Add(face, bbox);
            } catch (_) {}
          }
        } else if (typeof occ.BRepBndLib?.Add_1 === 'function') {
          try {
            occ.BRepBndLib.Add_1(face, bbox, false);
          } catch (_) {}
        }
        const pMin = bbox.CornerMin();
        const pMax = bbox.CornerMax();
        const boundingBox: BoundingBox3D = {
          min: { x: roundVal(pMin.X()), y: roundVal(pMin.Y()), z: roundVal(pMin.Z()) },
          max: { x: roundVal(pMax.X()), y: roundVal(pMax.Y()), z: roundVal(pMax.Z()) },
        };
        safeDelete(pMin);
        safeDelete(pMax);

        let surfaceType: GeometrySignature['surfaceType'] = 'other';
        let normal: Vector3D | undefined = undefined;

        try {
          adaptor = new occ.BRepAdaptor_Surface_2(face, true);
          const sType = adaptor.GetType();

          if (sType === occ.GeomAbs_SurfaceType.GeomAbs_Plane) {
            surfaceType = 'plane';
            const planeObj = adaptor.Plane();
            const ax3 = planeObj.Axis();
            const dir = ax3.Direction();
            normal = {
              x: roundVal(dir.X()),
              y: roundVal(dir.Y()),
              z: roundVal(dir.Z()),
            };
            safeDelete(dir);
            safeDelete(ax3);
            safeDelete(planeObj);
          } else if (sType === occ.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
            surfaceType = 'cylinder';
          } else if (sType === occ.GeomAbs_SurfaceType.GeomAbs_Cone) {
            surfaceType = 'cone';
          } else if (sType === occ.GeomAbs_SurfaceType.GeomAbs_Sphere) {
            surfaceType = 'sphere';
          } else if (sType === occ.GeomAbs_SurfaceType.GeomAbs_Torus) {
            surfaceType = 'torus';
          } else if (
            sType === occ.GeomAbs_SurfaceType.GeomAbs_BSplineSurface ||
            sType === occ.GeomAbs_SurfaceType.GeomAbs_BezierSurface
          ) {
            surfaceType = 'bspline';
          }
        } catch (_) {
          surfaceType = 'other';
        } finally {
          safeDelete(adaptor);
        }

        const signature: GeometrySignature = {
          centroid,
          boundingBox,
          measure: roundVal(area),
          normal,
          surfaceType,
        };

        const hash = hashSignature(signature);
        const persistentId = `topo_FACE_${featureId}_${index}_${hash}`;

        faces.push({
          persistentId,
          featureId,
          bodyId,
          subShapeType: 'FACE',
          signature,
          generation,
        });

        index++;
      } finally {
        safeDelete(gprops);
        safeDelete(bbox);
        safeDelete(face);
      }

      explorer.Next();
    }
  } finally {
    safeDelete(explorer);
  }

  return faces;
}

/**
 * 萃取 B-Rep 中所有邊（Edge）的幾何簽章與持久化參考
 */
export function extractEdgeSignatures(
  shape: any,
  occ: any,
  featureId: string,
  bodyId: string = 'main-body',
  generation: number = 1
): TopoReference[] {
  const edges: TopoReference[] = [];
  if (!shape || shape.IsNull()) return edges;

  let explorer: any = null;
  const edgeSet = new Set<number>();

  try {
    explorer = new occ.TopExp_Explorer_2(
      shape,
      occ.TopAbs_ShapeEnum.TopAbs_EDGE,
      occ.TopAbs_ShapeEnum.TopAbs_SHAPE
    );

    let index = 0;
    while (explorer.More()) {
      const edge = occ.TopoDS.Edge_1(explorer.Current());

      // 排除退化邊
      if (occ.BRep_Tool.Degenerated(edge)) {
        safeDelete(edge);
        explorer.Next();
        continue;
      }

      const hashCode =
        typeof edge.HashCode === 'function'
          ? edge.HashCode(0x7fffffff)
          : typeof edge.HashCode_1 === 'function'
          ? edge.HashCode_1(0x7fffffff)
          : index;

      if (edgeSet.has(hashCode)) {
        safeDelete(edge);
        explorer.Next();
        continue;
      }
      edgeSet.add(hashCode);

      let gprops: any = null;
      let bbox: any = null;
      let curveAdaptor: any = null;

      try {
        const GPropCtor = occ.GProp_GProps_1 || occ.GProp_GProps;
        gprops = new GPropCtor();
        if (typeof occ.BRepGProp.LinearProperties === 'function') {
          try {
            occ.BRepGProp.LinearProperties(edge, gprops, false, false);
          } catch (_) {
            occ.BRepGProp.LinearProperties(edge, gprops);
          }
        }

        const length = gprops.Mass();
        const cMass = gprops.CentreOfMass();
        const centroid: Vector3D = {
          x: roundVal(cMass.X()),
          y: roundVal(cMass.Y()),
          z: roundVal(cMass.Z()),
        };
        safeDelete(cMass);

        const BoxCtor = occ.Bnd_Box_1 || occ.Bnd_Box;
        bbox = new BoxCtor();
        if (typeof occ.BRepBndLib?.Add === 'function') {
          try {
            occ.BRepBndLib.Add(edge, bbox, false);
          } catch (_) {
            try {
              occ.BRepBndLib.Add(edge, bbox);
            } catch (_) {}
          }
        } else if (typeof occ.BRepBndLib?.Add_1 === 'function') {
          try {
            occ.BRepBndLib.Add_1(edge, bbox, false);
          } catch (_) {}
        }
        const pMin = bbox.CornerMin();
        const pMax = bbox.CornerMax();
        const boundingBox: BoundingBox3D = {
          min: { x: roundVal(pMin.X()), y: roundVal(pMin.Y()), z: roundVal(pMin.Z()) },
          max: { x: roundVal(pMax.X()), y: roundVal(pMax.Y()), z: roundVal(pMax.Z()) },
        };
        safeDelete(pMin);
        safeDelete(pMax);

        let curveType: GeometrySignature['curveType'] = 'other';
        let direction: Vector3D | undefined = undefined;

        try {
          curveAdaptor = new occ.BRepAdaptor_Curve_2(edge);
          const cType = curveAdaptor.GetType();

          if (cType === occ.GeomAbs_CurveType.GeomAbs_Line) {
            curveType = 'line';
            const lineObj = curveAdaptor.Line();
            const dir = lineObj.Direction();
            direction = {
              x: roundVal(dir.X()),
              y: roundVal(dir.Y()),
              z: roundVal(dir.Z()),
            };
            safeDelete(dir);
            safeDelete(lineObj);
          } else if (cType === occ.GeomAbs_CurveType.GeomAbs_Circle) {
            curveType = 'circle';
          } else if (cType === occ.GeomAbs_CurveType.GeomAbs_Ellipse) {
            curveType = 'ellipse';
          } else if (
            cType === occ.GeomAbs_CurveType.GeomAbs_BSplineCurve ||
            cType === occ.GeomAbs_CurveType.GeomAbs_BezierCurve
          ) {
            curveType = 'bspline';
          }
        } catch (_) {
          curveType = 'other';
        } finally {
          safeDelete(curveAdaptor);
        }

        const signature: GeometrySignature = {
          centroid,
          boundingBox,
          measure: roundVal(length),
          direction,
          curveType,
        };

        const hash = hashSignature(signature);
        const persistentId = `topo_EDGE_${featureId}_${index}_${hash}`;

        edges.push({
          persistentId,
          featureId,
          bodyId,
          subShapeType: 'EDGE',
          signature,
          generation,
        });

        index++;
      } finally {
        safeDelete(gprops);
        safeDelete(bbox);
        safeDelete(edge);
      }

      explorer.Next();
    }
  } finally {
    safeDelete(explorer);
  }

  return edges;
}

/**
 * 萃取 B-Rep 中所有頂點（Vertex）的幾何簽章與持久化參考
 */
export function extractVertexSignatures(
  shape: any,
  occ: any,
  featureId: string,
  bodyId: string = 'main-body',
  generation: number = 1
): TopoReference[] {
  const vertices: TopoReference[] = [];
  if (!shape || shape.IsNull()) return vertices;

  let explorer: any = null;
  const vertexSet = new Set<number>();

  try {
    explorer = new occ.TopExp_Explorer_2(
      shape,
      occ.TopAbs_ShapeEnum.TopAbs_VERTEX,
      occ.TopAbs_ShapeEnum.TopAbs_SHAPE
    );

    let index = 0;
    while (explorer.More()) {
      const vertex = occ.TopoDS.Vertex_1(explorer.Current());

      const hashCode =
        typeof vertex.HashCode === 'function'
          ? vertex.HashCode(0x7fffffff)
          : typeof vertex.HashCode_1 === 'function'
          ? vertex.HashCode_1(0x7fffffff)
          : index;

      if (vertexSet.has(hashCode)) {
        safeDelete(vertex);
        explorer.Next();
        continue;
      }
      vertexSet.add(hashCode);

      let pnt: any = null;
      try {
        pnt = occ.BRep_Tool.Pnt(vertex);
        const centroid: Vector3D = {
          x: roundVal(pnt.X()),
          y: roundVal(pnt.Y()),
          z: roundVal(pnt.Z()),
        };

        const boundingBox: BoundingBox3D = {
          min: centroid,
          max: centroid,
        };

        const signature: GeometrySignature = {
          centroid,
          boundingBox,
          measure: 0,
        };

        const hash = hashSignature(signature);
        const persistentId = `topo_VERTEX_${featureId}_${index}_${hash}`;

        vertices.push({
          persistentId,
          featureId,
          bodyId,
          subShapeType: 'VERTEX',
          signature,
          generation,
        });

        index++;
      } finally {
        safeDelete(pnt);
        safeDelete(vertex);
      }

      explorer.Next();
    }
  } finally {
    safeDelete(explorer);
  }

  return vertices;
}

/**
 * 針對單一 B-Rep 零件建立完整的拓撲地圖（TopologyMap）
 */
export function extractTopologyMap(
  shape: any,
  occ: any,
  featureId: string,
  bodyId: string = 'main-body',
  generation: number = 1
): TopologyMap {
  const faces = extractFaceSignatures(shape, occ, featureId, bodyId, generation);
  const edges = extractEdgeSignatures(shape, occ, featureId, bodyId, generation);
  const vertices = extractVertexSignatures(shape, occ, featureId, bodyId, generation);

  return {
    bodyId,
    generation,
    faces,
    edges,
    vertices,
    version: Date.now(),
  };
}
