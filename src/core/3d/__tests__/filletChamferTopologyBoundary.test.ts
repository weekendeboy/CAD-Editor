import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTopoReferenceToOCC,
  resolveOCCSubShape,
} from '../TopologyExtractor';
import { resolveTopoReference } from '../TopologyMapper';
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

// Helper to create mock geometry signature
function makeMockSignature(
  kind: 'EDGE' | 'FACE' | 'VERTEX',
  measure = 10,
  centroid = { x: 0, y: 0, z: 0 }
): GeometrySignature {
  return {
    centroid,
    boundingBox: {
      min: { x: centroid.x - 1, y: centroid.y - 1, z: centroid.z - 1 },
      max: { x: centroid.x + 1, y: centroid.y + 1, z: centroid.z + 1 },
    },
    measure,
    curveType: kind === 'EDGE' ? 'line' : undefined,
    surfaceType: kind === 'FACE' ? 'plane' : undefined,
    direction: kind === 'EDGE' ? { x: 1, y: 0, z: 0 } : undefined,
    normal: kind === 'FACE' ? { x: 0, y: 0, z: 1 } : undefined,
  };
}

// Helper to create mock TopoReference
function makeMockRef(
  subShapeType: 'EDGE' | 'FACE' | 'VERTEX',
  persistentId: string,
  generation = 1,
  bodyId = 'main-body',
  featureId = 'feat-base'
): TopoReference {
  return {
    persistentId,
    featureId,
    bodyId,
    subShapeType,
    signature: makeMockSignature(subShapeType),
    generation,
  };
}

// Mock OCC environment for testing
function createMockOCC(edgeConfigs: { id: string; degenerated?: boolean }[] = []) {
  const edges = edgeConfigs.map((cfg, idx) => ({
    _type: 'TopoDS_Edge',
    id: cfg.id,
    index: idx,
    degenerated: !!cfg.degenerated,
    IsNull: () => false,
    HashCode: () => idx + 1,
    HashCode_1: () => idx + 1,
    delete: () => {},
  }));

  return {
    TopAbs_ShapeEnum: {
      TopAbs_SHAPE: 0,
      TopAbs_FACE: 4,
      TopAbs_EDGE: 6,
      TopAbs_VERTEX: 7,
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
        this.items = shape?.edges || edges;
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
    BRepFilletAPI_MakeFillet_1: class {
      public addedEdges: any[] = [];
      public radii: number[] = [];
      public isBuilt = false;
      constructor(solid: any, flags: number) {}
      Add_2(radius: number, edge: any) {
        this.addedEdges.push(edge);
        this.radii.push(radius);
      }
      Build() {
        this.isBuilt = true;
      }
      IsDone() {
        return this.isBuilt && this.addedEdges.length > 0;
      }
      Shape() {
        return {
          _type: 'TopoDS_Shape',
          id: 'filleted-solid',
          IsNull: () => false,
          delete: () => {},
        };
      }
      delete() {}
    },
    BRepFilletAPI_MakeChamfer_1: class {
      public addedEdges: any[] = [];
      public distances: number[] = [];
      public isBuilt = false;
      constructor(solid: any) {}
      Add_2(distance: number, edge: any) {
        this.addedEdges.push(edge);
        this.distances.push(distance);
      }
      Build() {
        this.isBuilt = true;
      }
      IsDone() {
        return this.isBuilt && this.addedEdges.length > 0;
      }
      Shape() {
        return {
          _type: 'TopoDS_Shape',
          id: 'chamfered-solid',
          IsNull: () => false,
          delete: () => {},
        };
      }
      delete() {}
    },
  };
}

/**
 * 模擬 SolidWorker 中的 Fillet 評估邏輯
 */
function evaluateFilletOp(
  op: FeatureEvalOp,
  currentSolid: any,
  occ: any,
  topologyMap: TopologyMap
): { success: boolean; resultSolid: any; diagnostics: KernelDiagnostic[]; fRes: FeatureEvaluationResult } {
  const featureDiag: KernelDiagnostic[] = [];
  let success = false;
  let resultSolid = currentSolid;

  const radius =
    typeof op.fillet3D?.radius === 'number' && !isNaN(op.fillet3D.radius)
      ? op.fillet3D.radius
      : 1.0;

  if (radius <= 0) {
    throw new Error(`Fillet 3D radius must be greater than 0, got ${radius}`);
  }

  const edgeRefs = op.fillet3D?.edgeRefs || [];
  const validOccEdges: any[] = [];
  let unresolvedCount = 0;

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
        message: res.error || `邊線拓撲參照 ${ref.persistentId} 解析失敗 (${res.status})。`,
        featureId: op.featureId,
      });
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
    error: success ? null : featureDiag.find(d => d.level === 'error')?.message || null,
    executionTimeMs: 5,
    toolShape: undefined,
    resultBody: success ? 'main-body' : undefined,
  };

  return { success, resultSolid, diagnostics: featureDiag, fRes };
}

/**
 * 模擬 SolidWorker 中的 Chamfer 評估邏輯
 */
function evaluateChamferOp(
  op: FeatureEvalOp,
  currentSolid: any,
  occ: any,
  topologyMap: TopologyMap
): { success: boolean; resultSolid: any; diagnostics: KernelDiagnostic[]; fRes: FeatureEvaluationResult } {
  const featureDiag: KernelDiagnostic[] = [];
  let success = false;
  let resultSolid = currentSolid;

  const distance =
    typeof op.chamfer3D?.distance === 'number' && !isNaN(op.chamfer3D.distance)
      ? op.chamfer3D.distance
      : 1.0;

  if (distance <= 0) {
    throw new Error(`Chamfer 3D distance must be greater than 0, got ${distance}`);
  }

  const edgeRefs = op.chamfer3D?.edgeRefs || [];
  const validOccEdges: any[] = [];
  let unresolvedCount = 0;

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
          message: `邊線 ${ref.persistentId} 為退化邊，已跳過 Chamfer 3D 運算。`,
          featureId: op.featureId,
        });
      } else {
        validOccEdges.push(res.occShape);
      }
    } else {
      unresolvedCount++;
      featureDiag.push({
        level: 'warning',
        message: res.error || `邊線拓撲參照 ${ref.persistentId} 解析失敗 (${res.status})。`,
        featureId: op.featureId,
      });
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
      message: `Chamfer 3D 特徵執行失敗：沒有任何有效的邊線可供倒角運算 (已傳入 ${edgeRefs.length} 條參照)`,
      featureId: op.featureId,
    });
    success = false;
  } else {
    try {
      const chamfer = new occ.BRepFilletAPI_MakeChamfer_1(currentSolid);
      for (const edge of validOccEdges) {
        chamfer.Add_2(distance, edge);
      }
      chamfer.Build();
      if (chamfer.IsDone()) {
        resultSolid = chamfer.Shape();
        success = true;
      } else {
        featureDiag.push({
          level: 'error',
          message: `Chamfer operation failed to build shape with distance ${distance}`,
          featureId: op.featureId,
        });
        success = false;
      }
    } catch (e: any) {
      featureDiag.push({
        level: 'error',
        message: `Chamfer operation threw error: ${e?.message || e}`,
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
    error: success ? null : featureDiag.find(d => d.level === 'error')?.message || null,
    executionTimeMs: 5,
    toolShape: undefined,
    resultBody: success ? 'main-body' : undefined,
  };

  return { success, resultSolid, diagnostics: featureDiag, fRes };
}

// ---------------------- 測試案例 ----------------------

test('Test A — 正常 Fillet 執行 (Valid TopoReference)', () => {
  const edge1 = makeMockRef('EDGE', 'edge-box-top-1', 1);
  const edge2 = makeMockRef('EDGE', 'edge-box-top-2', 1);

  const topologyMap: TopologyMap = {
    bodyId: 'main-body',
    generation: 1,
    faces: [],
    edges: [edge1, edge2],
    vertices: [],
    version: Date.now(),
  };

  const occ = createMockOCC([{ id: 'edge-0' }, { id: 'edge-1' }]);
  const solid = { edges: [{ id: 'edge-0' }, { id: 'edge-1' }] };

  const op: FeatureEvalOp = {
    featureId: 'feat-fillet-1',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: {
      radius: 2.0,
      edgeSelectionMode: 'all',
      edgeRefs: [edge1],
    },
  };

  const evalRes = evaluateFilletOp(op, solid, occ, topologyMap);

  assert.strictEqual(evalRes.success, true);
  assert.strictEqual(evalRes.fRes.success, true);
  assert.strictEqual(evalRes.fRes.resultBody, 'main-body');
  assert.strictEqual(evalRes.fRes.toolShape, undefined, 'Architecture Contract: Fillet toolShape must be undefined');
  assert.deepStrictEqual(evalRes.fRes.modifiedBodyIds, ['main-body']);
  assert.strictEqual(evalRes.diagnostics.filter(d => d.level === 'error').length, 0);
});

test('Test B — 解析失敗的 Graceful Handling (Unresolved persistentId)', () => {
  const edge1 = makeMockRef('EDGE', 'edge-box-top-1', 1);

  const topologyMap: TopologyMap = {
    bodyId: 'main-body',
    generation: 1,
    faces: [],
    edges: [edge1],
    vertices: [],
    version: Date.now(),
  };

  const occ = createMockOCC([{ id: 'edge-0' }]);
  const solid = { edges: [{ id: 'edge-0' }] };

  // Pass non-existent persistentId
  const nonExistentRef = makeMockRef('EDGE', 'non-existent-edge-999', 1);

  const op: FeatureEvalOp = {
    featureId: 'feat-fillet-fail',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: {
      radius: 2.0,
      edgeSelectionMode: 'all',
      edgeRefs: [nonExistentRef],
    },
  };

  const evalRes = evaluateFilletOp(op, solid, occ, topologyMap);

  assert.strictEqual(evalRes.success, false);
  assert.strictEqual(evalRes.fRes.success, false);
  assert.ok(evalRes.diagnostics.some(d => d.level === 'error'));
  assert.ok(evalRes.diagnostics.some(d => d.message.includes('沒有任何有效的邊線')));
});

test('Test C — 混合解析 (Partial Match)', () => {
  const edgeValid = makeMockRef('EDGE', 'edge-box-valid', 1);
  const edgeOther = makeMockRef('EDGE', 'edge-box-other', 1);

  const topologyMap: TopologyMap = {
    bodyId: 'main-body',
    generation: 1,
    faces: [],
    edges: [edgeValid, edgeOther],
    vertices: [],
    version: Date.now(),
  };

  const occ = createMockOCC([{ id: 'edge-0' }, { id: 'edge-1' }]);
  const solid = { edges: [{ id: 'edge-0' }, { id: 'edge-1' }] };

  // 1 valid edge, 1 missing/unresolved edge
  const edgeMissing = makeMockRef('EDGE', 'edge-box-missing-404', 1);

  const op: FeatureEvalOp = {
    featureId: 'feat-fillet-partial',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: {
      radius: 1.5,
      edgeSelectionMode: 'all',
      edgeRefs: [edgeValid, edgeMissing],
    },
  };

  const evalRes = evaluateFilletOp(op, solid, occ, topologyMap);

  // Partial success: The valid edge was filleted
  assert.strictEqual(evalRes.success, true);
  assert.strictEqual(evalRes.fRes.success, true);
  assert.strictEqual(evalRes.fRes.resultBody, 'main-body');
  // Diagnostics must contain a warning about the unresolved edge
  const warnings = evalRes.diagnostics.filter(d => d.level === 'warning');
  assert.ok(warnings.length > 0);
  assert.ok(warnings.some(w => w.message.includes('1 條邊線拓撲解析失敗或已遺失')));
});

test('Test D — 退化邊防呆 (Degenerated Edge Filtering)', () => {
  const edgeDegenerated = makeMockRef('EDGE', 'edge-degenerated-1', 1);
  const edgeValid = makeMockRef('EDGE', 'edge-valid-2', 1);

  const topologyMap: TopologyMap = {
    bodyId: 'main-body',
    generation: 1,
    faces: [],
    edges: [edgeDegenerated, edgeValid],
    vertices: [],
    version: Date.now(),
  };

  const edge0 = { id: 'edge-0', degenerated: true, IsNull: () => false, HashCode: () => 1, HashCode_1: () => 1, delete: () => {} };
  const edge1 = { id: 'edge-1', degenerated: false, IsNull: () => false, HashCode: () => 2, HashCode_1: () => 2, delete: () => {} };

  const occ = {
    ...createMockOCC(),
    BRep_Tool: {
      Degenerated: (edge: any) => !!edge?.degenerated,
    },
    TopExp_Explorer_2: class {
      private idx = 0;
      private items = [edge0, edge1];
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
  };
  const solid = { edges: [edge0, edge1] };

  const op: FeatureEvalOp = {
    featureId: 'feat-fillet-degen',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: {
      radius: 1.0,
      edgeSelectionMode: 'all',
      edgeRefs: [edgeDegenerated, edgeValid],
    },
  };

  const evalRes = evaluateFilletOp(op, solid, occ, topologyMap);

  assert.strictEqual(evalRes.success, true);
  assert.ok(evalRes.diagnostics.some(d => d.message.includes('退化邊') || d.message.includes('解析失敗')));
});

test('Test E — 正常 Chamfer 執行 (Valid TopoReference for Chamfer)', () => {
  const edge1 = makeMockRef('EDGE', 'edge-box-top-1', 1);

  const topologyMap: TopologyMap = {
    bodyId: 'main-body',
    generation: 1,
    faces: [],
    edges: [edge1],
    vertices: [],
    version: Date.now(),
  };

  const occ = createMockOCC([{ id: 'edge-0' }]);
  const solid = { edges: [{ id: 'edge-0' }] };

  const op: FeatureEvalOp = {
    featureId: 'feat-chamfer-1',
    type: 'CHAMFER_3D',
    operation: 'JOIN',
    chamfer3D: {
      distance: 1.5,
      edgeSelectionMode: 'all',
      edgeRefs: [edge1],
    },
  };

  const evalRes = evaluateChamferOp(op, solid, occ, topologyMap);

  assert.strictEqual(evalRes.success, true);
  assert.strictEqual(evalRes.fRes.success, true);
  assert.strictEqual(evalRes.fRes.resultBody, 'main-body');
  assert.strictEqual(evalRes.fRes.toolShape, undefined, 'Architecture Contract: Chamfer toolShape must be undefined');
  assert.deepStrictEqual(evalRes.fRes.modifiedBodyIds, ['main-body']);
});

test('Test F — 世代不符 (Stale Generation Resolution Check)', () => {
  const edgeStale = makeMockRef('EDGE', 'edge-box-top-1', 1); // Generation 1

  // Map is generation 2
  const topologyMap: TopologyMap = {
    bodyId: 'main-body',
    generation: 2,
    faces: [],
    edges: [makeMockRef('EDGE', 'edge-box-top-1', 2)],
    vertices: [],
    version: Date.now(),
  };

  const occ = createMockOCC([{ id: 'edge-0' }]);
  const solid = { edges: [{ id: 'edge-0' }] };

  const res = resolveTopoReferenceToOCC(edgeStale, topologyMap, occ, solid);

  assert.strictEqual(res.status, 'stale_generation');
  assert.strictEqual(res.occShape, undefined);
  assert.ok(res.error?.includes('Generation mismatch'));
});

test('Test G — Architecture Contract: No TopoDS_Shape Leakage across Worker Boundary', () => {
  const edge1 = makeMockRef('EDGE', 'edge-box-top-1', 1);

  const topologyMap: TopologyMap = {
    bodyId: 'main-body',
    generation: 1,
    faces: [],
    edges: [edge1],
    vertices: [],
    version: Date.now(),
  };

  const occ = createMockOCC([{ id: 'edge-0' }]);
  const solid = { edges: [{ id: 'edge-0' }] };

  const op: FeatureEvalOp = {
    featureId: 'feat-fillet-contract',
    type: 'FILLET_3D',
    operation: 'JOIN',
    fillet3D: {
      radius: 1.0,
      edgeSelectionMode: 'all',
      edgeRefs: [edge1],
    },
  };

  const evalRes = evaluateFilletOp(op, solid, occ, topologyMap);

  // Assert serialization: FeatureEvaluationResult must be JSON stringifiable with no circular/native references
  const serialized = JSON.stringify(evalRes.fRes);
  const parsed = JSON.parse(serialized);

  assert.strictEqual(parsed.featureId, 'feat-fillet-contract');
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.toolShape, undefined);
});
