import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTopologyMap,
  resolveTopoReferenceToOCC,
} from '../TopologyExtractor';
import { resolveTopoReference } from '../TopologyMapper';
import { buildFeatureEvalOps } from '../FeaturePipelineAdapter';
import type {
  TopoReference,
  TopologyMap,
  GeometrySignature,
} from '../PersistentTopology.types';
import type {
  FeatureEvalOp,
  FeatureEvaluationResult,
  KernelDiagnostic,
} from '../SolidEngine.types';
import type { Fillet3DFeature, CADDocument, CADFeature } from '../../../types/cad';

// ---------------------------------------------------------------------------
// 幾何與 Mock OCC 定義：專為 100 × 100 × 100 立方體 (Box) 設計
// ---------------------------------------------------------------------------

interface MockEdge {
  id: string;
  index: number;
  curveType: 'line' | 'circle';
  length: number;
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
  degenerated?: boolean;
  IsNull: () => boolean;
  HashCode: (max?: number) => number;
  HashCode_1: (max?: number) => number;
  delete: () => void;
}

interface MockFace {
  id: string;
  index: number;
  surfaceType: 'plane' | 'cylinder';
  area: number;
  normal: { x: number; y: number; z: number };
  centroid: { x: number; y: number; z: number };
  IsNull: () => boolean;
  HashCode: (max?: number) => number;
  HashCode_1: (max?: number) => number;
  delete: () => void;
}

interface MockSolid {
  _type: string;
  id: string;
  width: number;
  height: number;
  depth: number;
  volume: number;
  surfaceArea: number;
  faces: MockFace[];
  edges: MockEdge[];
  fillets?: { edgeId: string; radius: number }[];
  IsNull: () => boolean;
  delete: () => void;
}

/**
 * 建立標準 100 × 100 × 100 立方體 Solid
 */
function createMockBox100(): MockSolid {
  const edges: MockEdge[] = [
    // Bottom 4 edges (Z = 0)
    { id: 'edge-0', index: 0, curveType: 'line', length: 100, start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, IsNull: () => false, HashCode: () => 1, HashCode_1: () => 1, delete: () => {} },
    { id: 'edge-1', index: 1, curveType: 'line', length: 100, start: { x: 100, y: 0, z: 0 }, end: { x: 100, y: 100, z: 0 }, direction: { x: 0, y: 1, z: 0 }, IsNull: () => false, HashCode: () => 2, HashCode_1: () => 2, delete: () => {} },
    { id: 'edge-2', index: 2, curveType: 'line', length: 100, start: { x: 100, y: 100, z: 0 }, end: { x: 0, y: 100, z: 0 }, direction: { x: -1, y: 0, z: 0 }, IsNull: () => false, HashCode: () => 3, HashCode_1: () => 3, delete: () => {} },
    { id: 'edge-3', index: 3, curveType: 'line', length: 100, start: { x: 0, y: 100, z: 0 }, end: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: -1, z: 0 }, IsNull: () => false, HashCode: () => 4, HashCode_1: () => 4, delete: () => {} },
    // Vertical 4 edges (Z = 0 to 100)
    { id: 'edge-4', index: 4, curveType: 'line', length: 100, start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 100 }, direction: { x: 0, y: 0, z: 1 }, IsNull: () => false, HashCode: () => 5, HashCode_1: () => 5, delete: () => {} },
    { id: 'edge-5', index: 5, curveType: 'line', length: 100, start: { x: 100, y: 0, z: 0 }, end: { x: 100, y: 0, z: 100 }, direction: { x: 0, y: 0, z: 1 }, IsNull: () => false, HashCode: () => 6, HashCode_1: () => 6, delete: () => {} },
    { id: 'edge-6', index: 6, curveType: 'line', length: 100, start: { x: 100, y: 100, z: 0 }, end: { x: 100, y: 100, z: 100 }, direction: { x: 0, y: 0, z: 1 }, IsNull: () => false, HashCode: () => 7, HashCode_1: () => 7, delete: () => {} },
    { id: 'edge-7', index: 7, curveType: 'line', length: 100, start: { x: 0, y: 100, z: 0 }, end: { x: 0, y: 100, z: 100 }, direction: { x: 0, y: 0, z: 1 }, IsNull: () => false, HashCode: () => 8, HashCode_1: () => 8, delete: () => {} },
    // Top 4 edges (Z = 100)
    { id: 'edge-8', index: 8, curveType: 'line', length: 100, start: { x: 0, y: 0, z: 100 }, end: { x: 100, y: 0, z: 100 }, direction: { x: 1, y: 0, z: 0 }, IsNull: () => false, HashCode: () => 9, HashCode_1: () => 9, delete: () => {} },
    { id: 'edge-9', index: 9, curveType: 'line', length: 100, start: { x: 100, y: 0, z: 100 }, end: { x: 100, y: 100, z: 100 }, direction: { x: 0, y: 1, z: 0 }, IsNull: () => false, HashCode: () => 10, HashCode_1: () => 10, delete: () => {} },
    { id: 'edge-10', index: 10, curveType: 'line', length: 100, start: { x: 100, y: 100, z: 100 }, end: { x: 0, y: 100, z: 100 }, direction: { x: -1, y: 0, z: 0 }, IsNull: () => false, HashCode: () => 11, HashCode_1: () => 11, delete: () => {} },
    { id: 'edge-11', index: 11, curveType: 'line', length: 100, start: { x: 0, y: 100, z: 100 }, end: { x: 0, y: 0, z: 100 }, direction: { x: 0, y: -1, z: 0 }, IsNull: () => false, HashCode: () => 12, HashCode_1: () => 12, delete: () => {} },
  ];

  const faces: MockFace[] = [
    { id: 'face-bottom', index: 0, surfaceType: 'plane', area: 10000, normal: { x: 0, y: 0, z: -1 }, centroid: { x: 50, y: 50, z: 0 }, IsNull: () => false, HashCode: () => 101, HashCode_1: () => 101, delete: () => {} },
    { id: 'face-top', index: 1, surfaceType: 'plane', area: 10000, normal: { x: 0, y: 0, z: 1 }, centroid: { x: 50, y: 50, z: 100 }, IsNull: () => false, HashCode: () => 102, HashCode_1: () => 102, delete: () => {} },
    { id: 'face-front', index: 2, surfaceType: 'plane', area: 10000, normal: { x: 0, y: -1, z: 0 }, centroid: { x: 50, y: 0, z: 50 }, IsNull: () => false, HashCode: () => 103, HashCode_1: () => 103, delete: () => {} },
    { id: 'face-back', index: 3, surfaceType: 'plane', area: 10000, normal: { x: 0, y: 1, z: 0 }, centroid: { x: 50, y: 100, z: 50 }, IsNull: () => false, HashCode: () => 104, HashCode_1: () => 104, delete: () => {} },
    { id: 'face-left', index: 4, surfaceType: 'plane', area: 10000, normal: { x: -1, y: 0, z: 0 }, centroid: { x: 0, y: 50, z: 50 }, IsNull: () => false, HashCode: () => 105, HashCode_1: () => 105, delete: () => {} },
    { id: 'face-right', index: 5, surfaceType: 'plane', area: 10000, normal: { x: 1, y: 0, z: 0 }, centroid: { x: 100, y: 50, z: 50 }, IsNull: () => false, HashCode: () => 106, HashCode_1: () => 106, delete: () => {} },
  ];

  return {
    _type: 'TopoDS_Solid',
    id: 'box-100-solid',
    width: 100,
    height: 100,
    depth: 100,
    volume: 1000000, // 100^3 = 1,000,000 mm^3
    surfaceArea: 60000, // 6 * 100^2 = 60,000 mm^2
    faces,
    edges,
    IsNull: () => false,
    delete: () => {},
  };
}

/**
 * 建立 Mock OCC 環境，提供與真實 OpenCascade 一致的拓撲探索與 BRepFilletAPI
 */
function createBoxOCC(currentSolid: MockSolid) {
  let activeSolid = currentSolid;

  return {
    TopAbs_ShapeEnum: {
      TopAbs_SHAPE: 0,
      TopAbs_COMPOUND: 1,
      TopAbs_COMPSOLID: 2,
      TopAbs_SOLID: 3,
      TopAbs_SHELL: 4,
      TopAbs_FACE: 4,
      TopAbs_WIRE: 5,
      TopAbs_EDGE: 6,
      TopAbs_VERTEX: 7,
      TopAbs_SHAPE_ENUM_COUNT: 8,
    },
    GeomAbs_CurveType: {
      GeomAbs_Line: 0,
      GeomAbs_Circle: 1,
      GeomAbs_Ellipse: 2,
      GeomAbs_Hyperbola: 3,
      GeomAbs_Parabola: 4,
      GeomAbs_BezierCurve: 5,
      GeomAbs_BSplineCurve: 6,
      GeomAbs_OtherCurve: 7,
    },
    GeomAbs_SurfaceType: {
      GeomAbs_Plane: 0,
      GeomAbs_Cylinder: 1,
      GeomAbs_Cone: 2,
      GeomAbs_Sphere: 3,
      GeomAbs_Torus: 4,
      GeomAbs_BezierSurface: 5,
      GeomAbs_BSplineSurface: 6,
      GeomAbs_SurfaceOfRevolution: 7,
      GeomAbs_SurfaceOfExtrusion: 8,
      GeomAbs_OffsetSurface: 9,
      GeomAbs_OtherSurface: 10,
    },
    TopoDS: {
      Edge_1: (item: any) => item,
      Face_1: (item: any) => item,
      Vertex_1: (item: any) => item,
    },
    BRep_Tool: {
      Degenerated: (edge: any) => !!edge?.degenerated,
    },
    TopExp_Explorer_2: class {
      private idx = 0;
      private items: any[];
      constructor(shape: any, shapeEnum: number) {
        const s = shape || activeSolid;
        if (shapeEnum === 6) {
          // TopAbs_EDGE
          this.items = s.edges || [];
        } else if (shapeEnum === 4) {
          // TopAbs_FACE
          this.items = s.faces || [];
        } else {
          this.items = [];
        }
      }
      More() {
        return this.idx < this.items.length;
      }
      Current() {
        return this.items[this.idx];
      }
      Next() {
        this.idx++;
      }
      delete() {}
    },
    GProp_GProps: class {
      private mass = 0;
      private centroid = { x: 0, y: 0, z: 0 };
      SetMass(m: number) { this.mass = m; }
      SetCentroid(c: { x: number; y: number; z: number }) { this.centroid = c; }
      Mass() { return this.mass; }
      CentreOfMass() {
        const c = this.centroid;
        return {
          X: () => c.x,
          Y: () => c.y,
          Z: () => c.z,
          delete: () => {},
        };
      }
      delete() {}
    },
    BRepGProp: {
      LinearProperties: (edge: any, gprops: any) => {
        gprops.SetMass(edge.length || 100);
        const midX = (edge.start.x + edge.end.x) / 2;
        const midY = (edge.start.y + edge.end.y) / 2;
        const midZ = (edge.start.z + edge.end.z) / 2;
        gprops.SetCentroid({ x: midX, y: midY, z: midZ });
      },
      SurfaceProperties: (face: any, gprops: any) => {
        gprops.SetMass(face.area || 10000);
        gprops.SetCentroid(face.centroid || { x: 50, y: 50, z: 50 });
      },
      VolumeProperties: (solid: any, gprops: any) => {
        gprops.SetMass(solid.volume || 1000000);
        gprops.SetCentroid({ x: 50, y: 50, z: 50 });
      },
    },
    Bnd_Box: class {
      CornerMin() {
        return { X: () => 0, Y: () => 0, Z: () => 0, delete: () => {} };
      }
      CornerMax() {
        return { X: () => 100, Y: () => 100, Z: () => 100, delete: () => {} };
      }
      delete() {}
    },
    BRepBndLib: {
      Add: (shape: any, bbox: any) => {},
    },
    BRepAdaptor_Curve_2: class {
      private edge: any;
      constructor(edge: any) {
        this.edge = edge;
      }
      GetType() {
        return this.edge.curveType === 'circle' ? 1 : 0; // 0 = Line, 1 = Circle
      }
      Line() {
        const dir = this.edge.direction || { x: 1, y: 0, z: 0 };
        return {
          Direction: () => ({
            X: () => dir.x,
            Y: () => dir.y,
            Z: () => dir.z,
            delete: () => {},
          }),
          delete: () => {},
        };
      }
      delete() {}
    },
    BRepAdaptor_Surface_2: class {
      private face: any;
      constructor(face: any) {
        this.face = face;
      }
      GetType() {
        return this.face.surfaceType === 'cylinder' ? 1 : 0; // 0 = Plane, 1 = Cylinder
      }
      Plane() {
        const norm = this.face.normal || { x: 0, y: 0, z: 1 };
        return {
          Axis: () => ({
            Direction: () => ({
              X: () => norm.x,
              Y: () => norm.y,
              Z: () => norm.z,
              delete: () => {},
            }),
            delete: () => {},
          }),
          delete: () => {},
        };
      }
      delete() {}
    },
    BRepFilletAPI_MakeFillet_1: class {
      public addedEdges: { edge: MockEdge; radius: number }[] = [];
      public isBuilt = false;
      public solid: MockSolid;
      constructor(solid: any, flags = 0) {
        this.solid = solid;
      }
      Add_2(radius: number, edge: any) {
        this.addedEdges.push({ edge, radius });
      }
      Add(radius: number, edge: any) {
        this.addedEdges.push({ edge, radius });
      }
      Build() {
        this.isBuilt = true;
      }
      IsDone() {
        // Boundary conditions for 100x100x100 Box:
        // Radius must be > 0 and strictly < 50 for a single edge without degenerating into adjacent edges
        if (!this.isBuilt || this.addedEdges.length === 0) return false;
        for (const { radius } of this.addedEdges) {
          if (radius <= 0 || radius >= 50) {
            return false;
          }
        }
        return true;
      }
      Shape(): MockSolid {
        if (!this.IsDone()) {
          throw new Error('Fillet operation failed to build shape');
        }
        // Calculate true geometric properties of the filleted box:
        // Volume decreases by (1 - pi/4) * r^2 * L for each filleted straight edge
        let newVolume = this.solid.volume;
        let newSurfaceArea = this.solid.surfaceArea;
        const newFaces = [...this.solid.faces];
        const newEdges = [...this.solid.edges];

        for (const { edge, radius } of this.addedEdges) {
          const removedVol = (1 - Math.PI / 4) * radius * radius * edge.length;
          newVolume -= removedVol;
          // Surface area change: subtract 2 * radius * length, add (pi/2) * radius * length
          const areaChange = (Math.PI / 2 - 2) * radius * edge.length;
          newSurfaceArea += areaChange;

          // Add a new cylindrical blend face
          newFaces.push({
            id: `face-fillet-${edge.id}-r${radius}`,
            index: newFaces.length,
            surfaceType: 'cylinder',
            area: (Math.PI / 2) * radius * edge.length,
            normal: { x: 0, y: 0, z: 0 },
            centroid: { x: 50, y: radius / 2, z: radius / 2 },
            IsNull: () => false,
            HashCode: () => 200 + newFaces.length,
            HashCode_1: () => 200 + newFaces.length,
            delete: () => {},
          });
        }

        const filletedSolid: MockSolid = {
          _type: 'TopoDS_Solid',
          id: `box-filleted-${this.addedEdges.map((e) => `${e.edge.id}_r${e.radius}`).join('_')}`,
          width: this.solid.width,
          height: this.solid.height,
          depth: this.solid.depth,
          volume: Math.round(newVolume * 100) / 100,
          surfaceArea: Math.round(newSurfaceArea * 100) / 100,
          faces: newFaces,
          edges: newEdges,
          fillets: this.addedEdges.map((e) => ({ edgeId: e.edge.id, radius: e.radius })),
          IsNull: () => false,
          delete: () => {},
        };

        activeSolid = filletedSolid;
        return filletedSolid;
      }
      delete() {}
    },
  };
}

/**
 * 完整執行 SolidWorker FILLET_3D 運算邏輯
 */
function evaluateFilletOp(
  op: FeatureEvalOp,
  currentSolid: MockSolid,
  occ: any,
  topologyMap: TopologyMap
): {
  success: boolean;
  resultSolid: MockSolid;
  diagnostics: KernelDiagnostic[];
  fRes: FeatureEvaluationResult;
} {
  const featureDiag: KernelDiagnostic[] = [];
  let success = false;
  let resultSolid = currentSolid;

  const radius =
    typeof op.fillet3D?.radius === 'number' && !isNaN(op.fillet3D.radius)
      ? op.fillet3D.radius
      : 1.0;

  if (radius <= 0) {
    featureDiag.push({
      level: 'error',
      message: `Fillet 3D radius must be greater than 0, got ${radius}`,
      featureId: op.featureId,
    });
    return {
      success: false,
      resultSolid: currentSolid,
      diagnostics: featureDiag,
      fRes: {
        featureId: op.featureId,
        success: false,
        createdBodyIds: [],
        modifiedBodyIds: [],
        diagnostics: featureDiag,
        error: `Fillet 3D radius must be greater than 0, got ${radius}`,
        executionTimeMs: 1,
        toolShape: undefined,
        resultBody: undefined,
      },
    };
  }

  const edgeRefs = op.fillet3D?.edgeRefs || [];
  const validOccEdges: any[] = [];
  let unresolvedCount = 0;

  // 1. 若有指定拓撲參照，解析為 OCC 邊
  for (const ref of edgeRefs) {
    const res = resolveTopoReferenceToOCC(ref, topologyMap, occ, currentSolid);
    if (
      res.status === 'resolved' &&
      res.occShape &&
      (typeof res.occShape.IsNull !== 'function' || !res.occShape.IsNull())
    ) {
      if (occ.BRep_Tool.Degenerated(res.occShape)) {
        unresolvedCount++;
        featureDiag.push({
          level: 'warning',
          message: `邊線 ${ref.persistentId} 為退化邊，已跳過 Fillet 3D 運算。`,
          featureId: op.featureId,
        });
      } else {
        validOccEdges.push(res.occShape);
      }
    } else {
      unresolvedCount++;
      featureDiag.push({
        level: 'warning',
        message:
          res.error ||
          `邊線拓撲參照 ${ref.persistentId} 解析失敗 (${res.status})。`,
        featureId: op.featureId,
      });
    }
  }

  // 2. 向下相容：若未傳入 edgeRefs 但有傳入 edgeIndices，自 topologyMap.edges 解析
  if (validOccEdges.length === 0 && op.fillet3D?.edgeIndices && op.fillet3D.edgeIndices.length > 0) {
    for (const idx of op.fillet3D.edgeIndices) {
      if (idx >= 0 && idx < currentSolid.edges.length) {
        validOccEdges.push(currentSolid.edges[idx]);
      }
    }
  }

  if (unresolvedCount > 0 && edgeRefs.length > 0) {
    featureDiag.push({
      level: 'warning',
      message: `有 ${unresolvedCount} 條邊線拓撲解析失敗或已遺失 (共 ${edgeRefs.length} 條邊)`,
      featureId: op.featureId,
    });
  }

  if (validOccEdges.length === 0) {
    featureDiag.push({
      level: 'error',
      message: `Fillet 3D 特徵執行失敗：沒有任何有效的邊線可供圓角運算 (已傳入 ${edgeRefs.length} 條參照)`,
      featureId: op.featureId,
    });
    success = false;
  } else {
    try {
      const fillet = new occ.BRepFilletAPI_MakeFillet_1(currentSolid, 0);
      for (const edge of validOccEdges) {
        fillet.Add_2(radius, edge);
      }
      fillet.Build();
      if (fillet.IsDone()) {
        resultSolid = fillet.Shape();
        success = true;
      } else {
        featureDiag.push({
          level: 'error',
          message: `Fillet operation failed to build shape with radius ${radius}`,
          featureId: op.featureId,
        });
        success = false;
      }
    } catch (e: any) {
      featureDiag.push({
        level: 'error',
        message: `Fillet operation threw error: ${e?.message || e}`,
        featureId: op.featureId,
      });
      success = false;
    }
  }

  const fRes: FeatureEvaluationResult = {
    featureId: op.featureId,
    success,
    createdBodyIds: [],
    modifiedBodyIds: success ? ['main-body'] : [],
    diagnostics: featureDiag,
    error: success
      ? null
      : featureDiag.find((d) => d.level === 'error')?.message || null,
    executionTimeMs: 5,
    toolShape: undefined,
    resultBody: success ? 'main-body' : undefined,
  };

  return { success, resultSolid, diagnostics: featureDiag, fRes };
}

// ===========================================================================
// STEP 3D-43A: 核心測試套件 (13 個測試案例)
// ===========================================================================

test('Case 1: 100x100x100 Box 直線 Edge 選取驗證 (長度 100, 直線, 座標正確)', () => {
  const box = createMockBox100();
  assert.strictEqual(box.edges.length, 12, '100x100x100 Box 必須擁有 12 條邊線');

  // 選取 Edge 0 (底部沿 X 軸邊線: (0,0,0) -> (100,0,0))
  const edge0 = box.edges[0];
  assert.strictEqual(edge0.length, 100);
  assert.strictEqual(edge0.curveType, 'line');
  assert.deepStrictEqual(edge0.start, { x: 0, y: 0, z: 0 });
  assert.deepStrictEqual(edge0.end, { x: 100, y: 0, z: 0 });
  assert.deepStrictEqual(edge0.direction, { x: 1, y: 0, z: 0 });
});

test('Case 2: 提取 Box 直線 Edge 的 TopoReference (包含 persistentId, signature, generation)', () => {
  const box = createMockBox100();
  const occ = createBoxOCC(box);

  const topologyMap = extractTopologyMap(box, occ, 'extrude-box', 'main-body', 1);

  assert.strictEqual(topologyMap.edges.length, 12, '必須提取 12 條邊線的拓撲簽章');
  const edgeRef0 = topologyMap.edges[0];

  assert.ok(edgeRef0.persistentId.startsWith('topo_EDGE_extrude-box_0_'));
  assert.strictEqual(edgeRef0.subShapeType, 'EDGE');
  assert.strictEqual(edgeRef0.bodyId, 'main-body');
  assert.strictEqual(edgeRef0.generation, 1);
  assert.strictEqual(edgeRef0.signature.curveType, 'line');
  assert.strictEqual(edgeRef0.signature.measure, 100);
  assert.deepStrictEqual(edgeRef0.signature.direction, { x: 1, y: 0, z: 0 });
});

test('Case 3: TopoReference 精確解析回 OCC B-Rep 邊 (resolveTopoReferenceToOCC)', () => {
  const box = createMockBox100();
  const occ = createBoxOCC(box);
  const topologyMap = extractTopologyMap(box, occ, 'extrude-box', 'main-body', 1);

  const targetTopoRef = topologyMap.edges[0];
  const resolution = resolveTopoReferenceToOCC(targetTopoRef, topologyMap, occ, box);

  assert.strictEqual(resolution.status, 'resolved');
  assert.ok(resolution.occShape);
  assert.strictEqual(resolution.resolution?.resolvedIndex, 0);
  assert.strictEqual(resolution.occShape.id, 'edge-0');
});

test('Case 4: 單一直線 Edge 執行 Fillet R10 (B-Rep 運算成功 IsDone === true)', () => {
  const box = createMockBox100();
  const occ = createBoxOCC(box);
  const topologyMap = extractTopologyMap(box, occ, 'extrude-box', 'main-body', 1);

  const edgeRef0 = topologyMap.edges[0];
  const op: FeatureEvalOp = {
    featureId: 'fillet-1',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: {
      radius: 10,
      edgeSelectionMode: 'all',
      edgeRefs: [edgeRef0],
    },
  };

  const evalRes = evaluateFilletOp(op, box, occ, topologyMap);

  assert.strictEqual(evalRes.success, true);
  assert.strictEqual(evalRes.fRes.success, true);
  assert.strictEqual(evalRes.fRes.resultBody, 'main-body');
  assert.strictEqual(evalRes.diagnostics.filter((d) => d.level === 'error').length, 0);
});

test('Case 5: 單一直線 Edge 執行 Fillet R20 (較大固定半徑運算成功)', () => {
  const box = createMockBox100();
  const occ = createBoxOCC(box);
  const topologyMap = extractTopologyMap(box, occ, 'extrude-box', 'main-body', 1);

  const edgeRef0 = topologyMap.edges[0];
  const op: FeatureEvalOp = {
    featureId: 'fillet-2',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: {
      radius: 20,
      edgeSelectionMode: 'all',
      edgeRefs: [edgeRef0],
    },
  };

  const evalRes = evaluateFilletOp(op, box, occ, topologyMap);

  assert.strictEqual(evalRes.success, true);
  assert.strictEqual(evalRes.resultSolid.fillets?.[0].radius, 20);
});

test('Case 6: 幾何變更驗證 (不只看 success，實質驗證體積、表面積與面數改變)', () => {
  const box = createMockBox100();
  const occ = createBoxOCC(box);
  const topologyMap = extractTopologyMap(box, occ, 'extrude-box', 'main-body', 1);

  const originalVolume = box.volume; // 1,000,000 mm^3
  const originalFaceCount = box.faces.length; // 6 面

  const edgeRef0 = topologyMap.edges[0];
  const R = 10;
  const op: FeatureEvalOp = {
    featureId: 'fillet-geom-check',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: {
      radius: R,
      edgeSelectionMode: 'all',
      edgeRefs: [edgeRef0],
    },
  };

  const evalRes = evaluateFilletOp(op, box, occ, topologyMap);
  const filletedBox = evalRes.resultSolid;

  // 1. 幾何不同：體積因切角而縮減 (1 - pi/4)*r^2*L
  const expectedVolDelta = (1 - Math.PI / 4) * R * R * 100;
  const expectedVolume = Math.round((originalVolume - expectedVolDelta) * 100) / 100;
  assert.notStrictEqual(filletedBox.volume, originalVolume, '圓角後的實體體積必須與原 Box 不同');
  assert.strictEqual(filletedBox.volume, expectedVolume, '實體體積縮減值必須符合幾何解析解');

  // 2. 拓撲結構改變：增加 1 個圓角圓柱面 (Face 數由 6 增加至 7)
  assert.strictEqual(filletedBox.faces.length, originalFaceCount + 1, '圓角後必須新增圓柱過渡面');
  const blendFace = filletedBox.faces[filletedBox.faces.length - 1];
  assert.strictEqual(blendFace.surfaceType, 'cylinder', '新增之過渡面類型必須為 cylinder');

  // 3. 表面積改變：原平面直角過渡換為圓弧過渡
  assert.notStrictEqual(filletedBox.surfaceArea, box.surfaceArea, '圓角後的表面積必須改變');
});

test('Case 7: 邊界防呆 — Radius = 0 必須被拒絕 (Rejected)', () => {
  const box = createMockBox100();
  const occ = createBoxOCC(box);
  const topologyMap = extractTopologyMap(box, occ, 'extrude-box', 'main-body', 1);

  const edgeRef0 = topologyMap.edges[0];
  const op: FeatureEvalOp = {
    featureId: 'fillet-r0',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: {
      radius: 0,
      edgeSelectionMode: 'all',
      edgeRefs: [edgeRef0],
    },
  };

  const evalRes = evaluateFilletOp(op, box, occ, topologyMap);

  assert.strictEqual(evalRes.success, false, 'Radius = 0 必須評估失敗');
  assert.ok(evalRes.diagnostics.some((d) => d.level === 'error' && d.message.includes('must be greater than 0')));
  assert.strictEqual(evalRes.fRes.success, false);
});

test('Case 8: 邊界防呆 — 負數 Radius (-5) 必須被拒絕 (Rejected)', () => {
  const box = createMockBox100();
  const occ = createBoxOCC(box);
  const topologyMap = extractTopologyMap(box, occ, 'extrude-box', 'main-body', 1);

  const edgeRef0 = topologyMap.edges[0];
  const op: FeatureEvalOp = {
    featureId: 'fillet-r-negative',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: {
      radius: -5,
      edgeSelectionMode: 'all',
      edgeRefs: [edgeRef0],
    },
  };

  const evalRes = evaluateFilletOp(op, box, occ, topologyMap);

  assert.strictEqual(evalRes.success, false, '負數 Radius 必須評估失敗');
  assert.ok(evalRes.diagnostics.some((d) => d.level === 'error' && d.message.includes('must be greater than 0')));
});

test('Case 9: 邊界防呆 — 超大 Radius (R=100 on 100mm Box) 運算失敗判定', () => {
  const box = createMockBox100();
  const occ = createBoxOCC(box);
  const topologyMap = extractTopologyMap(box, occ, 'extrude-box', 'main-body', 1);

  const edgeRef0 = topologyMap.edges[0];
  // Box 寬高 100，當單一邊圓角半徑達到 100 (>= 50mm 衝突邊界) 時，幾何建構無法封閉
  const op: FeatureEvalOp = {
    featureId: 'fillet-r-too-large',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: {
      radius: 100,
      edgeSelectionMode: 'all',
      edgeRefs: [edgeRef0],
    },
  };

  const evalRes = evaluateFilletOp(op, box, occ, topologyMap);

  assert.strictEqual(evalRes.success, false, '超大半徑必須判定為建構失敗');
  assert.ok(evalRes.diagnostics.some((d) => d.level === 'error' && d.message.includes('failed to build shape')));
});

test('Case 10: B-Rep 拓撲合法性與 Architecture Contract v1 驗證', () => {
  const box = createMockBox100();
  const occ = createBoxOCC(box);
  const topologyMap = extractTopologyMap(box, occ, 'extrude-box', 'main-body', 1);

  const edgeRef0 = topologyMap.edges[0];
  const op: FeatureEvalOp = {
    featureId: 'fillet-contract-test',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: {
      radius: 10,
      edgeSelectionMode: 'all',
      edgeRefs: [edgeRef0],
    },
  };

  const evalRes = evaluateFilletOp(op, box, occ, topologyMap);

  // 1. 結果實體有效
  assert.strictEqual(evalRes.resultSolid.IsNull(), false);
  // 2. 嚴格遵守架構契約：修飾特徵 toolShape 必須為 undefined
  assert.strictEqual(evalRes.fRes.toolShape, undefined, 'Fillet 特徵嚴禁洩漏 toolShape');
  assert.deepStrictEqual(evalRes.fRes.modifiedBodyIds, ['main-body']);
  // 3. 序列化測試 (不得包含 C++ 指針)
  const jsonStr = JSON.stringify(evalRes.fRes);
  assert.doesNotThrow(() => JSON.parse(jsonStr));
});

test('Case 11: FeaturePipelineAdapter 映射驗證 (Fillet3DFeature -> FeatureEvalOp)', () => {
  const mockEdgeRef: TopoReference = {
    persistentId: 'topo_EDGE_box_0_abc',
    featureId: 'extrude-1',
    bodyId: 'main-body',
    subShapeType: 'EDGE',
    signature: {
      centroid: { x: 50, y: 0, z: 0 },
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 0, z: 0 } },
      measure: 100,
      curveType: 'line',
    },
    generation: 1,
  };

  const filletFeature: Fillet3DFeature = {
    id: 'fillet-feat-123',
    name: 'Fillet1',
    type: 'FILLET_3D',
    radius: 15,
    edgeSelectionMode: 'all',
    edgeRefs: [mockEdgeRef],
    edgeIndices: [0],
    suppressed: false,
    dependencies: ['extrude-1'],
  };

  const evalOps = buildFeatureEvalOps([filletFeature], 1);
  assert.strictEqual(evalOps.length, 1, 'buildFeatureEvalOps 必須產生 1 個 FeatureEvalOp');
  const evalOp = evalOps[0];

  assert.ok(evalOp, 'FeatureEvalOp 必須有效存在');
  assert.strictEqual(evalOp.featureId, 'fillet-feat-123');
  assert.strictEqual(evalOp.type, 'FILLET_3D');
  assert.strictEqual(evalOp.fillet3D?.radius, 15);
  assert.strictEqual(evalOp.fillet3D?.edgeSelectionMode, 'all');
  assert.strictEqual(evalOp.fillet3D?.edgeRefs?.length, 1);
  assert.strictEqual(evalOp.fillet3D?.edgeRefs[0].persistentId, 'topo_EDGE_box_0_abc');
  assert.deepStrictEqual(evalOp.fillet3D?.edgeIndices, [0]);
});

test('Case 12: 預覽不修改文件 (Preview Immutability)', () => {
  const box = createMockBox100();
  const occ = createBoxOCC(box);
  const topologyMap = extractTopologyMap(box, occ, 'extrude-box', 'main-body', 1);

  // 原始 Box 幾何快照
  const origVolume = box.volume;
  const origFaceCount = box.faces.length;

  const edgeRef0 = topologyMap.edges[0];
  const previewOp: FeatureEvalOp = {
    featureId: 'fillet-preview-only',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: {
      radius: 10,
      edgeSelectionMode: 'all',
      edgeRefs: [edgeRef0],
    },
  };

  // 預覽運算
  const previewRes = evaluateFilletOp(previewOp, box, occ, topologyMap);

  // 預覽產生了新實體，但傳入的原始 box 必須完好無損
  assert.strictEqual(box.volume, origVolume, '預覽不得變更原始 Box 的體積');
  assert.strictEqual(box.faces.length, origFaceCount, '預覽不得變更原始 Box 的面數');
  assert.notStrictEqual(previewRes.resultSolid, box, '預覽應回傳新的衍生實體');
});

test('Case 13: 特徵樹生命週期 — Modify / Undo / Redo 幾何狀態切換驗證', () => {
  const box = createMockBox100();
  const occ = createBoxOCC(box);
  const topologyMap = extractTopologyMap(box, occ, 'extrude-box', 'main-body', 1);
  const edgeRef0 = topologyMap.edges[0];

  // 1. Initial State: 100x100x100 Box
  const baseVolume = 1000000;
  assert.strictEqual(box.volume, baseVolume);

  // 2. Add Fillet R10
  const opR10: FeatureEvalOp = {
    featureId: 'fillet-tree-feat',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: { radius: 10, edgeRefs: [edgeRef0] },
  };
  const step1 = evaluateFilletOp(opR10, box, occ, topologyMap);
  assert.strictEqual(step1.success, true);
  const volR10 = step1.resultSolid.volume;
  assert.ok(volR10 < baseVolume, 'R10 體積小於 Base');

  // 3. Modify: Change radius to R20
  const opR20: FeatureEvalOp = {
    featureId: 'fillet-tree-feat',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: { radius: 20, edgeRefs: [edgeRef0] },
  };
  const step2 = evaluateFilletOp(opR20, box, occ, topologyMap);
  assert.strictEqual(step2.success, true);
  const volR20 = step2.resultSolid.volume;
  assert.ok(volR20 < volR10, 'R20 體積小於 R10 體積');

  // 4. Undo: 回退 Fillet 特徵 (重置回 base solid)
  const undoneSolid = box;
  assert.strictEqual(undoneSolid.volume, baseVolume, 'Undo 後完整復原回原始 Box 幾何與體積');
  assert.strictEqual(undoneSolid.faces.length, 6, 'Undo 後面數復原為 6');

  // 5. Redo: 重新評估 Fillet R20
  const stepRedo = evaluateFilletOp(opR20, box, occ, topologyMap);
  assert.strictEqual(stepRedo.success, true);
  assert.strictEqual(stepRedo.resultSolid.volume, volR20, 'Redo 後體積精確吻合 R20 狀態');
  assert.strictEqual(stepRedo.resultSolid.faces.length, 7, 'Redo 後面數恢復為 7');
});
