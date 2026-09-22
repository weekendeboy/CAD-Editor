import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTopoReferenceToOCC,
} from '../TopologyExtractor';
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
import { FeatureEvaluationCache } from '../FeatureEvaluationCache';

// Helper to create mock geometry signature
function makeMockFaceSignature(
  normal = { x: 0, y: 0, z: 1 },
  centroid = { x: 0, y: 0, z: 10 },
  measure = 100
): GeometrySignature {
  return {
    centroid,
    boundingBox: {
      min: { x: centroid.x - 5, y: centroid.y - 5, z: centroid.z - 1 },
      max: { x: centroid.x + 5, y: centroid.y + 5, z: centroid.z + 1 },
    },
    measure,
    surfaceType: 'plane',
    normal,
  };
}

// Helper to create mock TopoReference for Face
function makeMockFaceRef(
  persistentId: string,
  generation = 1,
  bodyId = 'main-body',
  featureId = 'feat-extrude-1',
  normal = { x: 0, y: 0, z: 1 },
  centroid = { x: 0, y: 0, z: 10 }
): TopoReference {
  return {
    persistentId,
    featureId,
    bodyId,
    subShapeType: 'FACE',
    signature: makeMockFaceSignature(normal, centroid),
    generation,
  };
}

// Mock OCC environment for Shell & Pattern tests
function createMockOCC() {
  const mockFaces = [
    {
      _type: 'TopoDS_Face',
      id: 'face-top',
      index: 0,
      IsNull: () => false,
      HashCode: () => 101,
      HashCode_1: () => 101,
      delete: () => {},
    },
    {
      _type: 'TopoDS_Face',
      id: 'face-side-1',
      index: 1,
      IsNull: () => false,
      HashCode: () => 102,
      HashCode_1: () => 102,
      delete: () => {},
    },
  ];

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
      Degenerated: () => false,
    },
    TopExp_Explorer_2: class {
      private idx = 0;
      private items: any[];
      constructor(shape: any) {
        this.items = shape?.faces || mockFaces;
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
    TopTools_ListOfShape_1: class {
      public items: any[] = [];
      Append_1(shape: any) {
        this.items.push(shape);
      }
      Append(shape: any) {
        this.items.push(shape);
      }
      delete() {}
    },
    BRepOffsetAPI_MakeThickSolid_ByJoin: class {
      public closingFaces: any;
      public offset: number;
      public isBuilt = false;
      constructor(solid: any, closingFaces: any, offset: number) {
        this.closingFaces = closingFaces;
        this.offset = offset;
      }
      Build() {
        this.isBuilt = true;
      }
      IsDone() {
        return this.isBuilt && this.closingFaces.items.length > 0;
      }
      Shape() {
        return {
          _type: 'TopoDS_Shape',
          id: 'shelled-solid',
          IsNull: () => false,
          delete: () => {},
        };
      }
      delete() {}
    },
    gp_Vec_4: class {
      constructor(public x: number, public y: number, public z: number) {}
      delete() {}
    },
    gp_Pnt_3: class {
      constructor(public x: number, public y: number, public z: number) {}
      delete() {}
    },
    gp_Dir_4: class {
      constructor(public x: number, public y: number, public z: number) {}
      delete() {}
    },
    gp_Ax1_2: class {
      constructor(public pnt: any, public dir: any) {}
      delete() {}
    },
    gp_Ax2_3: class {
      constructor(public pnt: any, public dir: any) {}
      delete() {}
    },
    gp_Trsf_1: class {
      public translation = { x: 0, y: 0, z: 0 };
      public rotation = { axis: null as any, angle: 0 };
      public mirrored = false;
      SetTranslation_1(vec: any) {
        this.translation = { x: vec.x, y: vec.y, z: vec.z };
      }
      SetRotation_1(ax: any, angle: number) {
        this.rotation = { axis: ax, angle };
      }
      SetMirror_3(ax2: any) {
        this.mirrored = true;
      }
      delete() {}
    },
    BRepBuilderAPI_Transform_2: class {
      public isBuilt = true;
      constructor(public shape: any, public trsf: any, public copy: boolean) {}
      Shape() {
        return {
          _type: 'TopoDS_Shape',
          id: `transformed-${this.shape?.id || 'shape'}`,
          IsNull: () => false,
          delete: () => {},
        };
      }
      delete() {}
    },
    BRepAlgoAPI_Fuse_3: class {
      public isBuilt = false;
      constructor(public solid1: any, public solid2: any) {}
      Build() {
        this.isBuilt = true;
      }
      IsDone() {
        return this.isBuilt;
      }
      Shape() {
        return {
          _type: 'TopoDS_Shape',
          id: `fused-${this.solid1?.id}-${this.solid2?.id}`,
          IsNull: () => false,
          delete: () => {},
        };
      }
      delete() {}
    },
    BRepAlgoAPI_Cut_3: class {
      public isBuilt = false;
      constructor(public solid1: any, public tool: any) {}
      Build() {
        this.isBuilt = true;
      }
      IsDone() {
        return this.isBuilt;
      }
      Shape() {
        return {
          _type: 'TopoDS_Shape',
          id: `cut-${this.solid1?.id}-by-${this.tool?.id}`,
          IsNull: () => false,
          delete: () => {},
        };
      }
      delete() {}
    },
  };
}

/**
 * 模擬 SolidWorker 中的 Shell 3D 評估邏輯
 */
function evaluateShellOp(
  op: FeatureEvalOp,
  currentSolid: any,
  occ: any,
  topologyMap: TopologyMap
): { success: boolean; resultSolid: any; diagnostics: KernelDiagnostic[]; fRes: FeatureEvaluationResult } {
  const featureDiag: KernelDiagnostic[] = [];
  let success = false;
  let resultSolid = currentSolid;
  let errorMessage: string | undefined;

  const rawThickness =
    typeof op.shell3D?.thickness === 'number' && !isNaN(op.shell3D.thickness)
      ? op.shell3D.thickness
      : 1.5;

  if (rawThickness <= 0) {
    throw new Error(`Shell 3D thickness must be greater than 0, got ${rawThickness}`);
  }

  const isInside = op.shell3D?.direction !== 'outside';
  const offset = isInside ? -Math.abs(rawThickness) : Math.abs(rawThickness);

  const removedFaceRefs = op.shell3D?.removedFaceRefs || [];
  const validOccFaces: any[] = [];
  let unresolvedCount = 0;

  for (const ref of removedFaceRefs) {
    const res = resolveTopoReferenceToOCC(ref, topologyMap, occ, currentSolid);
    if (
      res.status === 'resolved' &&
      res.occShape &&
      (typeof res.occShape.IsNull !== 'function' || !res.occShape.IsNull())
    ) {
      validOccFaces.push(res.occShape);
    } else {
      unresolvedCount++;
      featureDiag.push({
        level: 'warning',
        message: res.error || `表面拓撲參照 ${ref.persistentId} 解析失敗 (${res.status})。`,
        featureId: op.featureId,
      });
    }
  }

  if (unresolvedCount > 0 && removedFaceRefs.length > 0) {
    featureDiag.push({
      level: 'warning',
      message: `有 ${unresolvedCount} 個表面拓撲解析失敗或已遺失 (共 ${removedFaceRefs.length} 個表面)`,
      featureId: op.featureId,
    });
  }

  if (removedFaceRefs.length > 0 && validOccFaces.length === 0) {
    errorMessage = `Shell 3D 特徵執行失敗：指定移除之表面拓撲解析失敗，無有效表面可供薄殼運算 (已傳入 ${removedFaceRefs.length} 個參照)`;
    featureDiag.push({
      level: 'error',
      message: errorMessage,
      featureId: op.featureId,
    });
    success = false;
  } else {
    const closingFaces = new occ.TopTools_ListOfShape_1();
    for (const face of validOccFaces) {
      closingFaces.Append_1(face);
    }

    let hollow: any = null;
    try {
      hollow = new occ.BRepOffsetAPI_MakeThickSolid_ByJoin(currentSolid, closingFaces, offset);
      hollow.Build();
      if (hollow.IsDone()) {
        resultSolid = hollow.Shape();
        success = true;
      } else {
        errorMessage = `Shell operation failed to build thick solid with thickness ${rawThickness}`;
        featureDiag.push({
          level: 'error',
          message: errorMessage,
          featureId: op.featureId,
        });
        success = false;
      }
    } catch (shellErr: any) {
      errorMessage = `Shell operation threw error: ${shellErr?.message || shellErr}`;
      featureDiag.push({
        level: 'error',
        message: errorMessage,
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
    error: errorMessage,
    executionTimeMs: 1.0,
    toolShape: undefined, // Shell has no toolShape
    resultBody: success ? 'main-body' : undefined,
  };

  return { success, resultSolid, diagnostics: featureDiag, fRes };
}

/**
 * 模擬 SolidWorker 中的 Pattern / Mirror 評估邏輯
 */
function evaluatePatternOrMirrorOp(
  op: FeatureEvalOp,
  currentSolid: any,
  occ: any,
  featureEvaluationCache: FeatureEvaluationCache,
  allOps: FeatureEvalOp[]
): { success: boolean; resultSolid: any; diagnostics: KernelDiagnostic[]; fRes: FeatureEvaluationResult } {
  const featureDiag: KernelDiagnostic[] = [];
  let success = false;
  let resultSolid = currentSolid;
  let errorMessage: string | undefined;

  if (!op.targetFeatureIds || op.targetFeatureIds.length === 0) {
    errorMessage = `Pattern/Mirror 特徵 '${op.featureId || op.type}' 執行失敗：未指定目標特徵 (targetFeatureIds 為空)。`;
    featureDiag.push({
      level: 'error',
      message: errorMessage,
      featureId: op.featureId,
    });
    success = false;
  } else {
    interface TargetToolItem {
      id: string;
      toolShape: any;
      isCut: boolean;
    }
    const targetTools: TargetToolItem[] = [];

    for (const tid of op.targetFeatureIds) {
      const toolShape = featureEvaluationCache.getToolShape(tid);
      if (toolShape && !toolShape.IsNull()) {
        const targetOp = allOps.find((o) => o.featureId === tid);
        const isCut = targetOp
          ? targetOp.operation === 'CUT' ||
            targetOp.type === 'CUT_EXTRUDE' ||
            targetOp.type === 'REVOLVE_CUT'
          : op.operation === 'CUT';
        targetTools.push({
          id: tid,
          toolShape,
          isCut,
        });
      } else {
        featureDiag.push({
          level: 'warning',
          message: `目標特徵 '${tid}' 無法在快取中找到有效的獨立 toolShape (可能為修飾特徵或尚未生成)。`,
          featureId: op.featureId,
        });
      }
    }

    if (targetTools.length === 0) {
      errorMessage = `Pattern/Mirror 特徵 '${op.featureId || op.type}' 執行失敗：所有目標特徵皆無可用的 toolShape。`;
      featureDiag.push({
        level: 'error',
        message: errorMessage,
        featureId: op.featureId,
      });
      success = false;
    } else {
      if (op.type === 'LINEAR_PATTERN') {
        const pat = op.patternLinear!;
        const dir1 = pat.dir1 || { x: 1, y: 0, z: 0 };
        const count1 = typeof pat.count1 === 'number' && pat.count1 > 0 ? pat.count1 : 1;
        const spacing1 = typeof pat.spacing1 === 'number' ? pat.spacing1 : 0;

        for (let pIdx = 1; pIdx < count1; pIdx++) {
          const dx = pIdx * spacing1 * dir1.x;
          const dy = pIdx * spacing1 * dir1.y;
          const dz = pIdx * spacing1 * dir1.z;

          const vec = new occ.gp_Vec_4(dx, dy, dz);
          const trsf = new occ.gp_Trsf_1();
          trsf.SetTranslation_1(vec);

          for (const tool of targetTools) {
            const xform = new occ.BRepBuilderAPI_Transform_2(tool.toolShape, trsf, true);
            const transformedCopy = xform.Shape();

            if (tool.isCut) {
              const cut = new occ.BRepAlgoAPI_Cut_3(resultSolid, transformedCopy);
              cut.Build();
              if (cut.IsDone()) {
                resultSolid = cut.Shape();
              }
            } else {
              const fuse = new occ.BRepAlgoAPI_Fuse_3(resultSolid, transformedCopy);
              fuse.Build();
              if (fuse.IsDone()) {
                resultSolid = fuse.Shape();
              }
            }
          }
        }
        success = true;
      } else if (op.type === 'CIRCULAR_PATTERN') {
        const pat = op.patternCircular!;
        const count = typeof pat.count === 'number' && pat.count > 0 ? pat.count : 1;
        const totalAngle = pat.totalAngle || 2 * Math.PI;
        const deltaTheta = totalAngle / count;

        const axPnt = new occ.gp_Pnt_3(0, 0, 0);
        const axDir = new occ.gp_Dir_4(0, 0, 1);
        const rotAxis = new occ.gp_Ax1_2(axPnt, axDir);

        for (let k = 1; k < count; k++) {
          const angle = k * deltaTheta;
          const trsf = new occ.gp_Trsf_1();
          trsf.SetRotation_1(rotAxis, angle);

          for (const tool of targetTools) {
            const xform = new occ.BRepBuilderAPI_Transform_2(tool.toolShape, trsf, true);
            const transformedCopy = xform.Shape();

            if (tool.isCut) {
              const cut = new occ.BRepAlgoAPI_Cut_3(resultSolid, transformedCopy);
              cut.Build();
              if (cut.IsDone()) {
                resultSolid = cut.Shape();
              }
            } else {
              const fuse = new occ.BRepAlgoAPI_Fuse_3(resultSolid, transformedCopy);
              fuse.Build();
              if (fuse.IsDone()) {
                resultSolid = fuse.Shape();
              }
            }
          }
        }
        success = true;
      } else if (op.type === 'MIRROR_3D') {
        const pnt = new occ.gp_Pnt_3(0, 0, 0);
        const dir = new occ.gp_Dir_4(1, 0, 0);
        const ax2 = new occ.gp_Ax2_3(pnt, dir);

        const trsf = new occ.gp_Trsf_1();
        trsf.SetMirror_3(ax2);

        for (const tool of targetTools) {
          const xform = new occ.BRepBuilderAPI_Transform_2(tool.toolShape, trsf, true);
          const mirroredCopy = xform.Shape();

          if (tool.isCut) {
            const cut = new occ.BRepAlgoAPI_Cut_3(resultSolid, mirroredCopy);
            cut.Build();
            if (cut.IsDone()) {
              resultSolid = cut.Shape();
            }
          } else {
            const fuse = new occ.BRepAlgoAPI_Fuse_3(resultSolid, mirroredCopy);
            fuse.Build();
            if (fuse.IsDone()) {
              resultSolid = fuse.Shape();
            }
          }
        }
        success = true;
      }
    }
  }

  const fRes: FeatureEvaluationResult = {
    featureId: op.featureId,
    success,
    createdBodyIds: [],
    modifiedBodyIds: success ? ['main-body'] : [],
    diagnostics: featureDiag,
    error: errorMessage,
    executionTimeMs: 1.0,
    toolShape: undefined, // Pattern / Mirror modifier does not export a separate toolShape
    resultBody: success ? 'main-body' : undefined,
  };

  return { success, resultSolid, diagnostics: featureDiag, fRes };
}

// ----------------------------------------------------------------------------
// TEST SUITE: Shell 拓撲對接與 Pattern / Mirror 語意邊界測試
// ----------------------------------------------------------------------------

test('SHELL_3D: 成功解析 TopoReference 面並執行薄殼運算', () => {
  const occ = createMockOCC();
  const baseSolid = {
    _type: 'TopoDS_Shape',
    id: 'base-box',
    IsNull: () => false,
    delete: () => {},
    faces: [
      { id: 'face-top', IsNull: () => false, HashCode: () => 101, HashCode_1: () => 101, delete: () => {} },
      { id: 'face-side', IsNull: () => false, HashCode: () => 102, HashCode_1: () => 102, delete: () => {} },
    ],
  };

  const topFaceRef = makeMockFaceRef('f-top', 1, 'main-body', 'extrude-1', { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 10 });

  const topoMap: TopologyMap = {
    bodyId: 'main-body',
    generation: 1,
    faces: [
      topFaceRef,
    ],
    edges: [],
    vertices: [],
    version: 1,
  };

  const shellOp: FeatureEvalOp = {
    featureId: 'shell-1',
    type: 'SHELL_3D',
    operation: 'JOIN',
    shell3D: {
      thickness: 2.0,
      direction: 'inside',
      removedFaceRefs: [topFaceRef],
    },
  };

  const result = evaluateShellOp(shellOp, baseSolid, occ, topoMap);
  assert.equal(result.success, true);
  assert.equal(result.resultSolid.id, 'shelled-solid');
  assert.equal(result.fRes.toolShape, undefined);
  assert.equal(result.fRes.resultBody, 'main-body');
  assert.equal(result.diagnostics.length, 0);
});

test('SHELL_3D: 當指定移除的面參照全部解析失敗時，應標記 success: false 並拋出 error 診斷', () => {
  const occ = createMockOCC();
  const baseSolid = {
    _type: 'TopoDS_Shape',
    id: 'base-box',
    IsNull: () => false,
    delete: () => {},
    faces: [],
  };

  const invalidFaceRef = makeMockFaceRef('f-nonexistent', 1, 'main-body', 'extrude-1', { x: 0, y: 0, z: 1 }, { x: 999, y: 999, z: 999 });

  const emptyTopoMap: TopologyMap = {
    bodyId: 'main-body',
    generation: 1,
    faces: [],
    edges: [],
    vertices: [],
    version: 1,
  };

  const shellOp: FeatureEvalOp = {
    featureId: 'shell-failed',
    type: 'SHELL_3D',
    operation: 'JOIN',
    shell3D: {
      thickness: 1.5,
      direction: 'inside',
      removedFaceRefs: [invalidFaceRef],
    },
  };

  const result = evaluateShellOp(shellOp, baseSolid, occ, emptyTopoMap);
  assert.equal(result.success, false);
  assert.equal(result.fRes.resultBody, undefined);
  assert.ok(result.diagnostics.some((d) => d.level === 'error'));
  assert.ok(result.diagnostics.some((d) => d.level === 'warning'));
});

test('PATTERN / MIRROR: LINEAR_PATTERN 針對 JOIN 特徵 toolShape 進行幾何平移與布林 Fuse', () => {
  const occ = createMockOCC();
  const cache = new FeatureEvaluationCache();

  const baseSolid = { _type: 'TopoDS_Shape', id: 'base-plate', IsNull: () => false, delete: () => {} };
  const bossToolShape = { _type: 'TopoDS_Shape', id: 'boss-pin', IsNull: () => false, delete: () => {} };

  // Register boss tool shape in cache
  cache.set('feat-boss', {
    featureId: 'feat-boss',
    result: {
      featureId: 'feat-boss',
      success: true,
      createdBodyIds: ['main-body'],
      modifiedBodyIds: [],
      diagnostics: [],
      error: undefined,
      executionTimeMs: 1,
      toolShape: 'EXTRUDE',
    },
    toolShape: bossToolShape,
  });

  const ops: FeatureEvalOp[] = [
    {
      featureId: 'feat-base',
      type: 'EXTRUDE',
      operation: 'JOIN',
    },
    {
      featureId: 'feat-boss',
      type: 'EXTRUDE',
      operation: 'JOIN',
    },
    {
      featureId: 'pattern-1',
      type: 'LINEAR_PATTERN',
      operation: 'JOIN',
      targetFeatureIds: ['feat-boss'],
      patternLinear: {
        dir1: { x: 1, y: 0, z: 0 },
        count1: 3,
        spacing1: 20,
      },
    },
  ];

  const result = evaluatePatternOrMirrorOp(ops[2], baseSolid, occ, cache, ops);
  assert.equal(result.success, true);
  assert.ok(result.resultSolid.id.includes('fused'));
  assert.ok(result.resultSolid.id.includes('transformed-boss-pin'));
  assert.equal(result.fRes.toolShape, undefined);
  assert.equal(result.fRes.resultBody, 'main-body');
});

test('PATTERN / MIRROR: LINEAR_PATTERN 針對 CUT 特徵 toolShape 進行幾何平移與布林 Cut', () => {
  const occ = createMockOCC();
  const cache = new FeatureEvaluationCache();

  const baseSolid = { _type: 'TopoDS_Shape', id: 'base-plate', IsNull: () => false, delete: () => {} };
  const holeToolShape = { _type: 'TopoDS_Shape', id: 'hole-cylinder', IsNull: () => false, delete: () => {} };

  // Register hole tool shape in cache
  cache.set('feat-hole', {
    featureId: 'feat-hole',
    result: {
      featureId: 'feat-hole',
      success: true,
      createdBodyIds: [],
      modifiedBodyIds: ['main-body'],
      diagnostics: [],
      error: undefined,
      executionTimeMs: 1,
      toolShape: 'EXTRUDE',
    },
    toolShape: holeToolShape,
  });

  const ops: FeatureEvalOp[] = [
    {
      featureId: 'feat-base',
      type: 'EXTRUDE',
      operation: 'JOIN',
    },
    {
      featureId: 'feat-hole',
      type: 'EXTRUDE',
      operation: 'CUT',
    },
    {
      featureId: 'pattern-hole',
      type: 'LINEAR_PATTERN',
      operation: 'JOIN',
      targetFeatureIds: ['feat-hole'],
      patternLinear: {
        dir1: { x: 1, y: 0, z: 0 },
        count1: 2,
        spacing1: 15,
      },
    },
  ];

  const result = evaluatePatternOrMirrorOp(ops[2], baseSolid, occ, cache, ops);
  assert.equal(result.success, true);
  // Verify that it cuts by the transformed tool shape, not the whole solid
  assert.ok(result.resultSolid.id.startsWith('cut-'));
  assert.ok(result.resultSolid.id.includes('transformed-hole-cylinder'));
});

test('PATTERN / MIRROR: CIRCULAR_PATTERN 旋轉複製目標 toolShape', () => {
  const occ = createMockOCC();
  const cache = new FeatureEvaluationCache();

  const baseSolid = { _type: 'TopoDS_Shape', id: 'base-hub', IsNull: () => false, delete: () => {} };
  const spokeToolShape = { _type: 'TopoDS_Shape', id: 'spoke-arm', IsNull: () => false, delete: () => {} };

  cache.set('feat-spoke', {
    featureId: 'feat-spoke',
    result: {
      featureId: 'feat-spoke',
      success: true,
      createdBodyIds: ['main-body'],
      modifiedBodyIds: [],
      diagnostics: [],
      error: undefined,
      executionTimeMs: 1,
      toolShape: 'EXTRUDE',
    },
    toolShape: spokeToolShape,
  });

  const ops: FeatureEvalOp[] = [
    {
      featureId: 'feat-hub',
      type: 'EXTRUDE',
      operation: 'JOIN',
    },
    {
      featureId: 'feat-spoke',
      type: 'EXTRUDE',
      operation: 'JOIN',
    },
    {
      featureId: 'circ-pattern',
      type: 'CIRCULAR_PATTERN',
      operation: 'JOIN',
      targetFeatureIds: ['feat-spoke'],
      patternCircular: {
        axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } },
        count: 4,
        totalAngle: 2 * Math.PI,
        equalSpacing: true,
      },
    },
  ];

  const result = evaluatePatternOrMirrorOp(ops[2], baseSolid, occ, cache, ops);
  assert.equal(result.success, true);
  assert.ok(result.resultSolid.id.includes('fused'));
  assert.ok(result.resultSolid.id.includes('transformed-spoke-arm'));
});

test('PATTERN / MIRROR: CIRCULAR_PATTERN 支援負角度 (CW 順時針反向旋轉)', () => {
  const occ = createMockOCC();
  const cache = new FeatureEvaluationCache();

  const baseSolid = { _type: 'TopoDS_Shape', id: 'base-hub', IsNull: () => false, delete: () => {} };
  const spokeToolShape = { _type: 'TopoDS_Shape', id: 'spoke-arm', IsNull: () => false, delete: () => {} };

  cache.set('feat-spoke', {
    featureId: 'feat-spoke',
    result: {
      featureId: 'feat-spoke',
      success: true,
      createdBodyIds: ['main-body'],
      modifiedBodyIds: [],
      diagnostics: [],
      error: undefined,
      executionTimeMs: 1,
      toolShape: 'EXTRUDE',
    },
    toolShape: spokeToolShape,
  });

  const ops: FeatureEvalOp[] = [
    {
      featureId: 'feat-hub',
      type: 'EXTRUDE',
      operation: 'JOIN',
    },
    {
      featureId: 'feat-spoke',
      type: 'EXTRUDE',
      operation: 'JOIN',
    },
    {
      featureId: 'circ-pattern-cw',
      type: 'CIRCULAR_PATTERN',
      operation: 'JOIN',
      targetFeatureIds: ['feat-spoke'],
      patternCircular: {
        axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } },
        count: 3,
        totalAngle: -Math.PI,
        equalSpacing: true,
      },
    },
  ];

  const result = evaluatePatternOrMirrorOp(ops[2], baseSolid, occ, cache, ops);
  assert.equal(result.success, true);
  assert.ok(result.resultSolid.id.includes('fused'));
  assert.ok(result.resultSolid.id.includes('transformed-spoke-arm'));
});

test('PATTERN / MIRROR: MIRROR_3D 鏡射複製目標 toolShape', () => {
  const occ = createMockOCC();
  const cache = new FeatureEvaluationCache();

  const baseSolid = { _type: 'TopoDS_Shape', id: 'base-body', IsNull: () => false, delete: () => {} };
  const earToolShape = { _type: 'TopoDS_Shape', id: 'ear-lug', IsNull: () => false, delete: () => {} };

  cache.set('feat-ear', {
    featureId: 'feat-ear',
    result: {
      featureId: 'feat-ear',
      success: true,
      createdBodyIds: ['main-body'],
      modifiedBodyIds: [],
      diagnostics: [],
      error: undefined,
      executionTimeMs: 1,
      toolShape: 'EXTRUDE',
    },
    toolShape: earToolShape,
  });

  const ops: FeatureEvalOp[] = [
    {
      featureId: 'feat-body',
      type: 'EXTRUDE',
      operation: 'JOIN',
    },
    {
      featureId: 'feat-ear',
      type: 'EXTRUDE',
      operation: 'JOIN',
    },
    {
      featureId: 'mirror-ear',
      type: 'MIRROR_3D',
      operation: 'JOIN',
      targetFeatureIds: ['feat-ear'],
      mirrorPlane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } },
    },
  ];

  const result = evaluatePatternOrMirrorOp(ops[2], baseSolid, occ, cache, ops);
  assert.equal(result.success, true);
  assert.ok(result.resultSolid.id.includes('fused'));
  assert.ok(result.resultSolid.id.includes('transformed-ear-lug'));
});

test('PATTERN / MIRROR: 當目標特徵在快取中不存在任何 toolShape 時，應產生 error 診斷並失敗', () => {
  const occ = createMockOCC();
  const cache = new FeatureEvaluationCache();

  const baseSolid = { _type: 'TopoDS_Shape', id: 'base-body', IsNull: () => false, delete: () => {} };

  const ops: FeatureEvalOp[] = [
    {
      featureId: 'pattern-empty',
      type: 'LINEAR_PATTERN',
      operation: 'JOIN',
      targetFeatureIds: ['missing-feature'],
      patternLinear: {
        dir1: { x: 1, y: 0, z: 0 },
        count1: 2,
        spacing1: 10,
      },
    },
  ];

  const result = evaluatePatternOrMirrorOp(ops[0], baseSolid, occ, cache, ops);
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.level === 'error'));
  assert.ok(result.diagnostics.some((d) => d.level === 'warning'));
});

test('PATTERN / MIRROR: 未指定 targetFeatureIds 時，應產生 error 診斷並標記 success: false', () => {
  const occ = createMockOCC();
  const cache = new FeatureEvaluationCache();

  const baseSolid = { _type: 'TopoDS_Shape', id: 'base-body', IsNull: () => false, delete: () => {} };

  const ops: FeatureEvalOp[] = [
    {
      featureId: 'pattern-no-target',
      type: 'LINEAR_PATTERN',
      operation: 'JOIN',
      targetFeatureIds: [],
      patternLinear: {
        dir1: { x: 1, y: 0, z: 0 },
        count1: 2,
        spacing1: 10,
      },
    },
  ];

  const result = evaluatePatternOrMirrorOp(ops[0], baseSolid, occ, cache, ops);
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.level === 'error'));
});
