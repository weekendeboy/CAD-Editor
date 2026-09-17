/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { CADState } from './cadStore.types';
import {
  CADDocument,
  CADEntity2D,
  CADLayer,
  createEmptyCADDocument,
  DatumFrontPlane,
  DatumTopPlane,
  DatumRightPlane,
  SketchFeature,
  CADFeature,
  ExtrudeFeature,
  DatumPlaneFeature,
  CustomPlane,
  Constraint,
  ConstraintType,
} from '../types/cad';
import { createOffsetPlane } from '../core/3d/DatumPlaneEngine';
import {
  insertEntityIntoSketch,
  removeEntityFromSketch,
  updateEntityInSketch,
  addConstraintToSketch,
  addDimensionToSketch,
  removeConstraintFromSketch,
  removeDimensionFromSketch,
  applyConstraintsToSketch,
  applyFilletToSketch,
  applyChamferToSketch,
  applyExtendToSketch,
  applyOffsetToSketch,
  applyMirrorToSketch,
  applyMoveToSketch,
  applyCopyToSketch,
  applyScaleToSketch,
  applyRotateToSketch,
  applyCircularArrayToSketch,
  applyRectArrayToSketch,
} from './sketchMutators';
import { getDirectDependencies, markDownstreamDirty, validateFeatureDependencies, getRegenPlan, applyRegenResults } from '../core/3d/FeatureRegenEngine';
import { buildFeatureEvalOps } from '../core/3d/FeaturePipelineAdapter';
import { executeTrim } from '../core/2d/TrimManager';
import { solveConstraints, analyzeSketchDOF } from '../core/solver/ConstraintSolver';
import { solidEngine } from '../core/3d/SolidEngine';

// [NOTE] 保留原有的輔助函式 findCustomPlane, createInitialDocument, checkDAGOrderValid, markSketchDirtyInDoc
// ... (保留這部分程式碼, 為了節省空間，這裡不顯示)

/**
 * 依據 ID 尋找對應的 CustomPlane (包含特徵樹上的 DatumPlaneFeature/SketchFeature、doc.planes 以及預設 3 大基準面)
 */
function findCustomPlane(doc: CADDocument, planeId: string): CustomPlane | null {
  if (!doc) return null;

  // 1. 於特徵樹搜尋 DatumPlaneFeature 或 SketchFeature
  const feature = doc.featureTree.find((f) => f.id === planeId);
  if (feature) {
    if (feature.type === 'DATUM_PLANE') {
      return (feature as DatumPlaneFeature).plane;
    }
    if (feature.type === 'SKETCH') {
      return (feature as SketchFeature).plane;
    }
  }

  // 2. 於 doc.planes 快照表搜尋
  if (doc.planes && doc.planes[planeId]) {
    return doc.planes[planeId];
  }

  // 3. 標準預設三大基準面降級保護
  if (planeId === 'datum-front') return DatumFrontPlane;
  if (planeId === 'datum-top') return DatumTopPlane;
  if (planeId === 'datum-right') return DatumRightPlane;

  return null;
}

/**
 * 初始化建立標準 CAD Document，確保特徵樹頂部包含常駐的 3 個標準基準面 (Front, Top, Right) 與預設草圖 Sketch1
 * [重構 P1] 移除對 doc.activeSketchId 的賦值，確立純淨資料模型。
 */
function createInitialDocument(): CADDocument {
  const doc = createEmptyCADDocument();

  const frontPlaneFeature: DatumPlaneFeature = {
    id: 'datum-front',
    name: 'Front Plane (XY)',
    type: 'DATUM_PLANE',
    planeType: 'offset',
    referencePlaneId: '',
    referenceFeatureId: '',
    offsetDistance: 0,
    plane: DatumFrontPlane,
    dependencies: [],
    suppressed: false,
    visible: true,
  };

  const topPlaneFeature: DatumPlaneFeature = {
    id: 'datum-top',
    name: 'Top Plane (XZ)',
    type: 'DATUM_PLANE',
    planeType: 'offset',
    referencePlaneId: '',
    referenceFeatureId: '',
    offsetDistance: 0,
    plane: DatumTopPlane,
    dependencies: [],
    suppressed: false,
    visible: true,
  };

  const rightPlaneFeature: DatumPlaneFeature = {
    id: 'datum-right',
    name: 'Right Plane (YZ)',
    type: 'DATUM_PLANE',
    planeType: 'offset',
    referencePlaneId: '',
    referenceFeatureId: '',
    offsetDistance: 0,
    plane: DatumRightPlane,
    dependencies: [],
    suppressed: false,
    visible: true,
  };

  const initialSketch: SketchFeature = {
    id: 'sketch-1',
    name: 'Sketch1',
    type: 'SKETCH',
    planeFeatureId: 'datum-front',
    dependencies: ['datum-front'],
    suppressed: false,
    plane: DatumFrontPlane,
    entities: [],
    constraints: [],
    dimensions: [],
    profiles: [],
    solverState: 'UnderDefined',
    visible: true,
  };

  doc.featureTree = [frontPlaneFeature, topPlaneFeature, rightPlaneFeature, initialSketch];
  doc.rollbackIndex = doc.featureTree.length;
  
  return doc;
}

function pushUndoState(state: CADState): Partial<CADState> {
  const clonedDoc: CADDocument = JSON.parse(JSON.stringify(state.document));
  const newUndoStack = [...state.undoStack, clonedDoc];
  if (newUndoStack.length > 20) {
    newUndoStack.shift();
  }
  return {
    undoStack: newUndoStack,
    redoStack: [],
  };
}

/**
 * Helper to check if a feature tree ordering satisfies DAG dependencies.
 * In a feature tree, upstream features MUST precede downstream dependent features.
 */
function checkDAGOrderValid(features: CADFeature[]): boolean {
  const posMap = new Map<string, number>();
  features.forEach((f, idx) => posMap.set(f.id, idx));

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const parentIds = getDirectDependencies(feature);
    for (const pId of parentIds) {
      if (posMap.has(pId)) {
        const parentIndex = posMap.get(pId)!;
        if (parentIndex >= i) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * 輔助函式：當草圖內部圖元或約束變更時，標記該草圖特徵及其所有下游特徵為 isDirty = true
 */
function markSketchDirtyInDoc(doc: CADDocument, sketchId: string): CADDocument {
  if (!sketchId || !doc || !doc.featureTree) return doc;
  const updatedTree = doc.featureTree.map((f) =>
    f.id === sketchId ? ({ ...f, isDirty: true } as CADFeature) : f
  );
  const dirtyTree = markDownstreamDirty(updatedTree, sketchId);
  return {
    ...doc,
    featureTree: dirtyTree,
  };
}

export const useCADStore = create<CADState>()(
  immer((set, get) => ({
    // ==========================================
    // 1. DocumentState (持久化文件狀態)
    // ==========================================
    document: createInitialDocument(),
  undoStack: [],
  redoStack: [],

  // ==========================================
  // 2. ViewState (視圖與介面顯示狀態)
  // ==========================================
  viewMode: '2D',
  showProfiles: true,
  show3DEdges: true,
  isLayerModalOpen: false,
  isOsnapModalOpen: false,
  isPolarModalOpen: false,
  extrudePreview: null,
  revolvePreview: null,

  // ==========================================
  // 3. InteractionState (互動與編輯器狀態)
  // ==========================================
  currentTool: 'SELECT',
  activeSketchId: 'sketch-1',
  selectedEntityIds: [],
  selectedFeatureId: null,
  selectedFaceInfo: null,
  activeLayerId: '0',
  isPickingRevolveAxis: false,

  osnapEnabled: true,
  osnapSettings: {
    endpoint: true,
    midpoint: true,
    center: true,
    quadrant: true,
    intersection: true,
    extension: true,
    perpendicular: true,
    tangent: true,
    parallel: true,
  },
  orthoEnabled: false,
  polarTrackingEnabled: true,
  polarAngleStep: 45,
  customPolarAngles: [],

  arrayItems: 4,
  arrayFillAngle: 360,
  rectArrayCols: 4,
  rectArrayRows: 3,
  rectArrayColSpacing: 30,
  rectArrayRowSpacing: 30,
  chamferDistance: 10,
  polygonSides: 5,
  polygonMethod: 'inscribed',
  lastRadius: 10,

  projectedEntities: [],

  // ==========================================
  // 4. RuntimeState (運行時狀態)
  // ==========================================
  cumulativePartMesh: null,
  featureResults: {},
  bodies: [],
  kernelDiagnostics: [],

  // ==========================================
  // 5. Actions 實作
  // ==========================================

  getFeatureResult: (featureId: string) => {
    return get().featureResults[featureId];
  },

  toggleShow3DEdges: () => set((state) => { state.show3DEdges = !state.show3DEdges; }),
  setProjectedEntities: (entities) => set((state) => { state.projectedEntities = entities; }),
  setExtrudePreview: (preview) => set((state) => { state.extrudePreview = preview; }),
  setRevolvePreview: (preview) => set((state) => { state.revolvePreview = preview; }),
  setIsPickingRevolveAxis: (isPicking) => set((state) => { state.isPickingRevolveAxis = isPicking; }),
  
  setRevolveAxisEntityId: (axisId) => set((state) => {
    if (state.revolvePreview) state.revolvePreview.axisEntityId = axisId;
  }),
  setLayerModalOpen: (open) => set((state) => { state.isLayerModalOpen = open; }),
  setOsnapModalOpen: (open) => set((state) => { state.isOsnapModalOpen = open; }),
  
  setArrayItems: (items) => set((state) => { state.arrayItems = Math.max(2, Math.round(items)); }),
  setArrayFillAngle: (angle) => set((state) => { state.arrayFillAngle = angle; }),

  setRectArrayCols: (cols) => set((state) => { state.rectArrayCols = Math.max(1, Math.min(100, Math.round(cols))); }),
  setRectArrayRows: (rows) => set((state) => { state.rectArrayRows = Math.max(1, Math.min(100, Math.round(rows))); }),
  setRectArrayColSpacing: (spacing) => set((state) => { state.rectArrayColSpacing = spacing; }),
  setRectArrayRowSpacing: (spacing) => set((state) => { state.rectArrayRowSpacing = spacing; }),

  setChamferDistance: (distance) => set((state) => { state.chamferDistance = Math.max(0.1, distance); }),

  setPolygonSides: (sides) => set((state) => { state.polygonSides = Math.max(3, Math.min(1024, Math.round(sides))); }),
  setPolygonMethod: (method) => set((state) => { state.polygonMethod = method; }),

  setLastRadius: (r) => set((state) => { state.lastRadius = Math.max(0.1, r); }),

  // ------------------------------------------
  // 特徵與歷史邏輯 (Feature & History Actions)
  // ------------------------------------------

  setSelectedFeatureId: (id) => set((state) => {
    state.selectedFeatureId = id || null;
    if (id) {
      const feature = state.document.featureTree.find((f) => f.id === id);
      if (feature && feature.type === 'SKETCH') {
        state.activeSketchId = id;
      }
    }
  }),
  addFeature: (feature) => set((state) => {
      const currentRollback = Math.max(0, Math.min(state.document.rollbackIndex, state.document.featureTree.length));
      
      // 處理 Undo
      const clonedDoc = JSON.parse(JSON.stringify(state.document));
      state.undoStack.push(clonedDoc);
      if (state.undoStack.length > 20) state.undoStack.shift();
      state.redoStack = [];

      const newFeatureWithDirty: CADFeature = { ...feature, isDirty: true };
      state.document.featureTree.splice(currentRollback, 0, newFeatureWithDirty);
      
      state.document.featureTree = markDownstreamDirty(state.document.featureTree, feature.id);
      state.document.rollbackIndex = currentRollback + 1;
      
      if (feature.type === 'SKETCH') {
        state.activeSketchId = feature.id;
      }
      state.selectedFeatureId = feature.id;
  }),

  removeFeature: (id) => set((state) => {
    const featureIndex = state.document.featureTree.findIndex((f) => f.id === id);
    if (featureIndex === -1) return;

    const filteredTree = state.document.featureTree.filter((f) => f.id !== id);
    const validationMap = validateFeatureDependencies(filteredTree);

    const updatedTree = filteredTree.map((f) => {
      const errs = validationMap.get(f.id);
      if (errs && errs.length > 0) {
        return {
          ...f,
          error: errs.join('; '),
          isDirty: true,
        };
      } else {
        return {
          ...f,
          error: f.error && f.error.includes('Missing reference') ? null : f.error,
        };
      }
    });

    let newRollbackIndex = state.document.rollbackIndex;
    if (featureIndex < state.document.rollbackIndex) {
      newRollbackIndex = Math.max(0, state.document.rollbackIndex - 1);
    } else {
      newRollbackIndex = Math.min(newRollbackIndex, updatedTree.length);
    }

    const nextActiveSketchId = state.activeSketchId === id
      ? (updatedTree.find((f) => f.type === 'SKETCH')?.id || null)
      : state.activeSketchId;

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {document: {
        ...state.document,
        featureTree: updatedTree,
        rollbackIndex: newRollbackIndex,
      },
      selectedFeatureId: state.selectedFeatureId === id ? null : state.selectedFeatureId,
      activeSketchId: nextActiveSketchId,});


    }),
  updateFeature: (id, updates) => set((state) => {
    const exists = state.document.featureTree.some((f) => f.id === id);
    if (!exists) return;

    const updatedTree = state.document.featureTree.map((f) =>
      f.id === id ? ({ ...f, ...updates, isDirty: true } as CADFeature) : f
    );

    const dirtyTree = markDownstreamDirty(updatedTree, id);
    const validationMap = validateFeatureDependencies(dirtyTree);

    const finalTree = dirtyTree.map((f) => {
      const errs = validationMap.get(f.id);
      return {
        ...f,
        error: errs && errs.length > 0 ? errs.join('; ') : f.error,
      };
    });

    const targetFeature = finalTree.find((f) => f.id === id);
    const nextActiveSketchId = (targetFeature && targetFeature.type === 'SKETCH') ? id : state.activeSketchId;

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {activeSketchId: nextActiveSketchId,
      document: {
        ...state.document,
        featureTree: finalTree,
      },});


    }),
  toggleFeatureSuppression: (id) => set((state) => {
    const feature = state.document.featureTree.find((f) => f.id === id);
    if (!feature) return;

    const newSuppressed = !feature.suppressed;
    const updatedTree = state.document.featureTree.map((f) =>
      f.id === id ? { ...f, suppressed: newSuppressed, isDirty: true } : f
    );

    const dirtyTree = markDownstreamDirty(updatedTree, id);

    const nextActiveSketchId = (feature.type === 'SKETCH' && newSuppressed && state.activeSketchId === id)
      ? (dirtyTree.find((f) => f.type === 'SKETCH' && !f.suppressed)?.id || null)
      : (feature.type === 'SKETCH' && !newSuppressed ? id : state.activeSketchId);

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {activeSketchId: nextActiveSketchId,
      document: {
        ...state.document,
        featureTree: dirtyTree,
      },});


    }),
  renameFeature: (id, newName) => set((state) => {
    const trimmed = newName.trim();
    if (!trimmed) return state;
    const feature = state.document.featureTree.find((f) => f.id === id);
    if (!feature || feature.name === trimmed) return state;

    const updatedTree = state.document.featureTree.map((f) =>
      f.id === id ? { ...f, name: trimmed } : f
    );

    const undoState = pushUndoState(state);
      state.undoStack = undoState.undoStack;
      state.redoStack = undoState.redoStack;
      if (Object.keys({document: {
        ...state.document,
        featureTree: updatedTree,
      },}).length > 0) {
        Object.assign(state, {document: {
        ...state.document,
        featureTree: updatedTree,
      },});
      }
  }),
  reorderFeature: (sourceIndex, targetIndex) => set((state) => {
    const tree = [...state.document.featureTree];
    if (
      sourceIndex < 0 ||
      sourceIndex >= tree.length ||
      targetIndex < 0 ||
      targetIndex >= tree.length ||
      sourceIndex === targetIndex
    ) {
      return;
    }

    const [moved] = tree.splice(sourceIndex, 1);
    tree.splice(targetIndex, 0, moved);

    if (!checkDAGOrderValid(tree)) {
      console.warn('Reordering cancelled: Breaks feature dependency DAG hierarchy.');
      return;
    }

    const movedId = moved.id;
    const dirtyTree = markDownstreamDirty(tree, movedId);

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {document: {
        ...state.document,
        featureTree: dirtyTree,
      },});


    }),
  setRollbackIndex: (index) => set((state) => {
    const clamped = Math.max(0, Math.min(index, state.document.featureTree.length));
    if (state.document.rollbackIndex === clamped) return;

    const activeFeatures = state.document.featureTree.slice(0, clamped);
    let nextActiveSketchId = state.activeSketchId;
    if (nextActiveSketchId) {
      const activeSketchInRollback = activeFeatures.find((f) => f.id === nextActiveSketchId && f.type === 'SKETCH');
      if (!activeSketchInRollback) {
        const lastSketch = [...activeFeatures].reverse().find((f) => f.type === 'SKETCH');
        nextActiveSketchId = lastSketch ? lastSketch.id : null;
      }
    }

    set({
      activeSketchId: nextActiveSketchId,
      document: {
        ...state.document,
        rollbackIndex: clamped,
      },
    });

    }),
  regenerateFeatureTree: async () => {
    const state = get();
    const { featureTree, rollbackIndex, planes } = state.document;
    const cachedFeatureIds = Object.keys(state.featureResults);

    const regenPlan = getRegenPlan(featureTree, rollbackIndex, cachedFeatureIds);
    const { dirtyFeatures, brokenDependencies, hasCycle, cycleNodes, dirtyFromIndex, isPureRollback } = regenPlan;

    if (hasCycle) {
      const cycleSet = new Set(cycleNodes);
      const updatedTreeWithCycleErr = featureTree.map((f) => {
        if (cycleSet.has(f.id)) {
          return {
            ...f,
            error: '循環依賴 (Circular Dependency)',
            isDirty: true,
          };
        }
        return f;
      });

      set((s) => ({
        document: {
          ...s.document,
          featureTree: updatedTreeWithCycleErr,
        },
      }));
      return;
    }

    const treeWithErrors = featureTree.map((f) => {
      const errs = brokenDependencies.get(f.id);
      if (errs && errs.length > 0) {
        return {
          ...f,
          error: `遺失父特徵依賴: ${errs.join(', ')}`,
          isDirty: true,
        };
      }
      return f;
    });

    const ops = buildFeatureEvalOps(treeWithErrors, rollbackIndex, planes || {});

    if (!ops || ops.length === 0) {
      const clearedTree = treeWithErrors.map((f) => {
        if (brokenDependencies.has(f.id)) {
          return f;
        }
        return {
          ...f,
          isDirty: false,
          error: f.error?.includes('遺失父特徵依賴') ? f.error : null,
        };
      });

      set((s) => ({
        document: {
          ...s.document,
          featureTree: clearedTree,
        },
        cumulativePartMesh: null,
        featureResults: {},
        bodies: [],
        kernelDiagnostics: [],
      }));
      return;
    }

    try {
      const result = await solidEngine.evaluateFeatureTree(ops, dirtyFromIndex, isPureRollback);

      const diagnostics = result.diagnostics || [];
      const featureErrorMap = new Map<string, string>();

      for (const diag of diagnostics) {
        if (diag.level === 'error' && diag.featureId) {
          featureErrorMap.set(diag.featureId, diag.message);
        }
      }

      const isSuccess = result.success !== false && featureErrorMap.size === 0;

      if (isSuccess) {
        const opsResults = ops.map((op) => ({
          featureId: op.featureId,
          success: true,
        }));

        const activeDirtyIds = dirtyFeatures.map((f) => f.id);
        for (const dId of activeDirtyIds) {
          if (!opsResults.some((r) => r.featureId === dId) && !brokenDependencies.has(dId)) {
            opsResults.push({ featureId: dId, success: true });
          }
        }

        const regeneratedTree = applyRegenResults(treeWithErrors, opsResults);

        set((s) => ({
          document: {
            ...s.document,
            featureTree: regeneratedTree,
          },
          cumulativePartMesh: result.finalMesh || null,
          featureResults: result.featureResults || {},
          bodies: result.bodies || [],
          kernelDiagnostics: result.diagnostics || [],
        }));
      } else {
        const opFeatureIds = new Set(ops.map((op) => op.featureId));
        const failedTree = treeWithErrors.map((f) => {
          const diagErr = featureErrorMap.get(f.id);
          if (diagErr) {
            return {
              ...f,
              isDirty: true,
              error: diagErr,
            };
          }
          if (result.success === false && opFeatureIds.has(f.id)) {
            return {
              ...f,
              isDirty: true,
              error: f.error || 'SolidEngine 幾何運算失敗',
            };
          }
          return f;
        });

        set((s) => ({
          document: {
            ...s.document,
            featureTree: failedTree,
          },
          cumulativePartMesh: result.finalMesh || null,
          featureResults: result.featureResults || {},
          bodies: result.bodies || [],
          kernelDiagnostics: result.diagnostics || [],
        }));
      }
    } catch (err: any) {
      if (err?.message === 'RegenJobCancelled' || err?.name === 'AbortError') {
        // P3: Ignore aborted job, another one is running
        return;
      }
      console.error('regenerateFeatureTree failed:', err);
      const opFeatureIds = new Set(ops.map((op) => op.featureId));
      const errorTree = treeWithErrors.map((f) => {
        if (opFeatureIds.has(f.id)) {
          return {
            ...f,
            isDirty: true,
            error: err?.message || 'SolidEngine Worker 執行例外',
          };
        }
        return f;
      });

      set((s) => ({
        document: {
          ...s.document,
          featureTree: errorTree,
        },
      }));
    }
  },

  // ------------------------------------------
  // 基準面與特徵草圖連結 (Datum Plane & Face Sketch)
  // ------------------------------------------

  addOffsetDatumPlane: (refPlaneId, distance, name) => { let retId = ""; set((state) => {
    const refPlane = findCustomPlane(state.document, refPlaneId) || DatumFrontPlane;

    const newFeatureId = `datum-plane-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const planeName = name || `${refPlane.name || 'Plane'} Offset (${distance >= 0 ? '+' : ''}${distance}mm)`;

    const computedPlane = createOffsetPlane(refPlane, distance, planeName, newFeatureId);

    const newFeature: DatumPlaneFeature = {
      id: newFeatureId,
      name: planeName,
      type: 'DATUM_PLANE',
      planeType: 'offset',
      referencePlaneId: refPlaneId,
      referenceFeatureId: refPlaneId,
      offsetDistance: distance,
      plane: computedPlane,
      dependencies: [refPlaneId],
      suppressed: false,
      visible: true,
    };

    const rollback = Math.max(0, Math.min(state.document.rollbackIndex, state.document.featureTree.length));
    const newTree = [
      ...state.document.featureTree.slice(0, rollback),
      { ...newFeature, isDirty: true } as CADFeature,
      ...state.document.featureTree.slice(rollback),
    ];

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: newTree,
      rollbackIndex: rollback + 1,
      planes: {
        ...state.document.planes,
        [newFeatureId]: computedPlane,
      },
    };

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {selectedFeatureId: newFeatureId,
      document: updatedDocument,});


    retId = newFeatureId; }); return retId; },
  updateDatumPlaneOffset: (planeFeatureId, distance) => set((state) => {
    const tree = state.document.featureTree;
    const featureIndex = tree.findIndex((f) => f.id === planeFeatureId && f.type === 'DATUM_PLANE');
    if (featureIndex === -1) return;

    const datumFeature = tree[featureIndex] as DatumPlaneFeature;
    const refPlaneId = datumFeature.referencePlaneId || datumFeature.referenceFeatureId || 'datum-front';
    const refPlane = findCustomPlane(state.document, refPlaneId) || DatumFrontPlane;

    const recalculatedPlane = createOffsetPlane(refPlane, distance, datumFeature.name, planeFeatureId);

    const updatedTree = tree.map((f) => {
      if (f.id === planeFeatureId && f.type === 'DATUM_PLANE') {
        return {
          ...f,
          offsetDistance: distance,
          plane: recalculatedPlane,
          isDirty: true,
        } as DatumPlaneFeature;
      }

      if (f.type === 'SKETCH') {
        const sketch = f as SketchFeature;
        if (
          sketch.planeFeatureId === planeFeatureId ||
          sketch.plane?.id === planeFeatureId ||
          sketch.plane?.parentFeatureId === planeFeatureId
        ) {
          return {
            ...sketch,
            planeFeatureId: planeFeatureId,
            plane: recalculatedPlane,
            isDirty: true,
          } as SketchFeature;
        }
      }

      return f;
    });

    const dirtyTree = markDownstreamDirty(updatedTree, planeFeatureId);
    const validationMap = validateFeatureDependencies(dirtyTree);

    const finalTree = dirtyTree.map((f) => {
      const errs = validationMap.get(f.id);
      return {
        ...f,
        error: errs && errs.length > 0 ? errs.join('; ') : f.error,
      };
    });

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: finalTree,
      planes: {
        ...state.document.planes,
        [planeFeatureId]: recalculatedPlane,
      },
    };

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {document: updatedDocument,});


    }),
  toggleFeatureVisibility: (featureId) => set((state) => {
    const feature = state.document.featureTree.find((f) => f.id === featureId);
    if (!feature) return state;

    const newVisible = feature.visible === false ? true : false;
    const updatedTree = state.document.featureTree.map((f) =>
      f.id === featureId ? { ...f, visible: newVisible } : f
    );

    const undoState = pushUndoState(state);
      state.undoStack = undoState.undoStack;
      state.redoStack = undoState.redoStack;
      if (Object.keys({document: {
        ...state.document,
        featureTree: updatedTree,
      },}).length > 0) {
        Object.assign(state, {document: {
        ...state.document,
        featureTree: updatedTree,
      },});
      }
  }),
  createSketchOnPlane: (planeId) => { let retId = ""; set((state) => {
    const targetPlane = findCustomPlane(state.document, planeId) || DatumFrontPlane;

    const newSketchId = crypto.randomUUID();
    const sketchCount = state.document.featureTree.filter((f) => f.type === 'SKETCH').length + 1;
    const sketchName = `Sketch${sketchCount}`;

    const newSketch: SketchFeature = {
      id: newSketchId,
      name: sketchName,
      type: 'SKETCH',
      planeFeatureId: planeId,
      plane: targetPlane,
      dependencies: [planeId],
      entities: [],
      constraints: [],
      dimensions: [],
      profiles: [],
      solverState: 'UnderDefined',
      suppressed: false,
      visible: true,
    };

    const rollback = Math.max(0, Math.min(state.document.rollbackIndex, state.document.featureTree.length));
    const newTree = [
      ...state.document.featureTree.slice(0, rollback),
      newSketch,
      ...state.document.featureTree.slice(rollback),
    ];

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: newTree,
      rollbackIndex: rollback + 1,
    };

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {activeSketchId: newSketchId,
      selectedFeatureId: newSketchId,
      selectedEntityIds: [],
      document: updatedDocument,
      viewMode: '2D',});


    retId = newSketchId; }); return retId; },
  setSelectedFaceInfo: (face) => set((state) => { state.selectedFaceInfo = face; }),

  createSketchOnFacePlane: (plane: CustomPlane) => { let retId = ""; set((state) => {
    
    const newSketchId = crypto.randomUUID();
    const sketchCount = state.document.featureTree.filter((f) => f.type === 'SKETCH').length;
    const sketchName = `Sketch${sketchCount + 1}`;

    const newSketch: SketchFeature = {
      id: newSketchId,
      name: sketchName,
      type: 'SKETCH',
      planeFeatureId: plane.id,
      plane: plane,
      dependencies: [],
      entities: [],
      constraints: [],
      dimensions: [],
      profiles: [],
      solverState: 'UnderDefined',
      suppressed: false,
      visible: true,
    };

    const rollback = Math.max(0, Math.min(state.document.rollbackIndex, state.document.featureTree.length));
    const newTree = [
      ...state.document.featureTree.slice(0, rollback),
      newSketch,
      ...state.document.featureTree.slice(rollback),
    ];

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: newTree,
      rollbackIndex: rollback + 1,
      planes: {
        ...state.document.planes,
        [plane.id]: plane,
      },
    };

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {activeSketchId: newSketch.id,
      selectedFeatureId: newSketch.id,
      selectedEntityIds: [],
      selectedFaceInfo: null,
      document: updatedDocument,
      viewMode: '2D',
      currentTool: 'SELECT',});


    if (typeof window !== 'undefined') {
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('cad-zoom-to-bbox', {
            detail: {
              bbox: {
                min: { x: -60, y: -60 },
                max: { x: 60, y: 60 },
              },
              padding: 80,
            },
          })
        );
      }, 50);
    }

    retId = newSketchId; }); return retId; },
  addExtrudeFeature: (feature) => set((state) => {
    const newFeatureId = 'extrude-' + Date.now().toString();
    const newFeature: ExtrudeFeature = {
      ...feature,
      id: newFeatureId,
      type: 'EXTRUDE' as const,
      dependencies: feature.sketchId ? [feature.sketchId] : [],
      suppressed: false,
    };
    
    const currentRollback = Math.max(0, Math.min(state.document.rollbackIndex, state.document.featureTree.length));
    const tree = state.document.featureTree;
    const newFeatureTree = [
      ...tree.slice(0, currentRollback),
      { ...newFeature, isDirty: true } as CADFeature,
      ...tree.slice(currentRollback),
    ];
    const dirtyTree = markDownstreamDirty(newFeatureTree, newFeatureId);

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {selectedFeatureId: newFeature.id,
      document: {
        ...state.document,
        featureTree: dirtyTree,
        rollbackIndex: currentRollback + 1,
      },});


    }),
  updateExtrudeFeature: (id, updates) => get().updateFeature(id, updates),

  // ------------------------------------------
  // UI 狀態切換與基本工具 (UI & Tools)
  // ------------------------------------------

  setViewMode: (mode) => set({ viewMode: mode }),
  setTool: (tool) => set({ currentTool: tool }),
  setActiveSketch: (sketchId) => set({ activeSketchId: sketchId }),
  
  selectEntity: (id) => set((state) => {
    if (state.selectedEntityIds.includes(id)) {
      return state;
    }
    return { selectedEntityIds: [...state.selectedEntityIds, id] };
  }),
  setSelectedEntityIds: (ids) => set({ selectedEntityIds: ids }),
  clearSelection: () => set({ selectedEntityIds: [], selectedFeatureId: null }),
  setActiveLayer: (layerId: string) => set({ activeLayerId: layerId }),

  // ------------------------------------------
  // 圖層操作 (Layers)
  // ------------------------------------------

  addLayer: (layer: CADLayer) => set((state) => {
    if (state.document.layers[layer.id]) {
      return state;
    }
    const updatedDocument: CADDocument = {
      ...state.document,
      layers: {
        ...state.document.layers,
        [layer.id]: layer,
      },
    };
    const undoState = pushUndoState(state);
      state.undoStack = undoState.undoStack;
      state.redoStack = undoState.redoStack;
      if (Object.keys({document: updatedDocument,}).length > 0) {
        Object.assign(state, {document: updatedDocument,});
      }
  }),
  removeLayer: (layerId: string) => set((state) => {
    if (layerId === '0' || layerId.toUpperCase() === 'DEFPOINTS') {
      return state;
    }
    if (!state.document.layers[layerId]) {
      return state;
    }

    const { [layerId]: _removed, ...remainingLayers } = state.document.layers;
    const newActiveLayerId = state.activeLayerId === layerId ? '0' : state.activeLayerId;

    const updatedFeatureTree = state.document.featureTree.map((feature) => {
      if (feature.type === 'SKETCH') {
        const sketch = feature as SketchFeature;
        const hasEntitiesInLayer = sketch.entities.some((e) => e.layerId === layerId);
        if (hasEntitiesInLayer) {
          const updatedEntities = sketch.entities.map((e) =>
            e.layerId === layerId ? { ...e, layerId: '0' } : e
          );
          const updatedSketch: SketchFeature = {
            ...sketch,
            entities: updatedEntities,
          };
          applyConstraintsToSketch(updatedSketch);
          return updatedSketch;
        }
      }
      return feature;
    });

    const updatedDocument: CADDocument = {
      ...state.document,
      layers: remainingLayers,
      featureTree: updatedFeatureTree,
    };

    const undoState = pushUndoState(state);
      state.undoStack = undoState.undoStack;
      state.redoStack = undoState.redoStack;
      if (Object.keys({document: updatedDocument,
      activeLayerId: newActiveLayerId,}).length > 0) {
        Object.assign(state, {document: updatedDocument,
      activeLayerId: newActiveLayerId,});
      }
  }),
  renameLayer: (layerId: string, newName: string) => set((state) => {
    const trimmed = newName.trim();
    if (!trimmed) return state;
    if (layerId === '0' || layerId.toUpperCase() === 'DEFPOINTS') return state;
    const existingLayer = state.document.layers[layerId];
    if (!existingLayer) return state;
    if (existingLayer.name === trimmed) return state;

    const nameExists = Object.values(state.document.layers).some(
      (l) => l.id !== layerId && l.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (nameExists) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      layers: {
        ...state.document.layers,
        [layerId]: {
          ...existingLayer,
          name: trimmed,
        },
      },
    };

    const undoState = pushUndoState(state);
      state.undoStack = undoState.undoStack;
      state.redoStack = undoState.redoStack;
      if (Object.keys({document: updatedDocument,}).length > 0) {
        Object.assign(state, {document: updatedDocument,});
      }
  }),
  updateLayer: (layerId: string, updates: Partial<CADLayer>) => set((state) => {
    const existingLayer = state.document.layers[layerId];
    if (!existingLayer) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      layers: {
        ...state.document.layers,
        [layerId]: {
          ...existingLayer,
          ...updates,
          id: layerId,
        },
      },
    };

    const undoState = pushUndoState(state);
      state.undoStack = undoState.undoStack;
      state.redoStack = undoState.redoStack;
      if (Object.keys({document: updatedDocument,}).length > 0) {
        Object.assign(state, {document: updatedDocument,});
      }
  }),
  toggleLayerVisibility: (layerId: string) => set((state) => {
    const existingLayer = state.document.layers[layerId];
    if (!existingLayer) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      layers: {
        ...state.document.layers,
        [layerId]: {
          ...existingLayer,
          visible: !existingLayer.visible,
        },
      },
    };

    const undoState = pushUndoState(state);
      state.undoStack = undoState.undoStack;
      state.redoStack = undoState.redoStack;
      if (Object.keys({document: updatedDocument,}).length > 0) {
        Object.assign(state, {document: updatedDocument,});
      }
  }),
  toggleLayerLock: (layerId: string) => set((state) => {
    const existingLayer = state.document.layers[layerId];
    if (!existingLayer) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      layers: {
        ...state.document.layers,
        [layerId]: {
          ...existingLayer,
          locked: !existingLayer.locked,
        },
      },
    };

    const undoState = pushUndoState(state);
      state.undoStack = undoState.undoStack;
      state.redoStack = undoState.redoStack;
      if (Object.keys({document: updatedDocument,}).length > 0) {
        Object.assign(state, {document: updatedDocument,});
      }
  }),
  // ------------------------------------------
  // 2D 編輯與繪圖邏輯 (2D Operations)
  // ------------------------------------------
  
  addEntity: (sketchIdOrEntity: any, entity?: any) => set((state) => {
    const targetSketchId = typeof sketchIdOrEntity === 'string' ? sketchIdOrEntity : state.activeSketchId;
    const actualEntity = typeof sketchIdOrEntity === 'string' ? entity : sketchIdOrEntity;
    if (!targetSketchId || !actualEntity) return;

    const activeLayer = state.activeLayerId || '0';
    const targetLayerId = (!actualEntity.layerId || actualEntity.layerId === '0' || actualEntity.layerId === 'layer-0')
      ? activeLayer
      : actualEntity.layerId;

    const newEntity: CADEntity2D = {
      ...actualEntity,
      layerId: targetLayerId,
      isConstruction: actualEntity.isConstruction ?? (targetLayerId === 'CONSTRUCTION'),
    };

    insertEntityIntoSketch(state.document, targetSketchId, newEntity);
    const docDirty = markSketchDirtyInDoc(state.document, targetSketchId);

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {document: docDirty,});


    }),
  importDxfData: (entities, layers) => set((state) => {
    if (!entities || entities.length === 0 || !state.activeSketchId) {
      return;
    }

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    const preparedEntities: CADEntity2D[] = entities.map((e) => ({
      ...e,
      state: 'UnderDefined',
    }));

    const updatedSketch: SketchFeature = {
      ...sketch,
      entities: [...sketch.entities, ...preparedEntities],
    };
    applyConstraintsToSketch(updatedSketch);

    const mergedLayers = { ...state.document.layers };
    if (layers) {
      for (const [key, layer] of Object.entries(layers)) {
        if (!mergedLayers[key]) {
          mergedLayers[key] = layer;
        }
      }
    }

    const updatedDocument: CADDocument = {
      ...state.document,
      layers: mergedLayers,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    const docDirty = markSketchDirtyInDoc(updatedDocument, state.activeSketchId);

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {document: docDirty,
      selectedEntityIds: [],});


    }),
  importEntities: (entities) => get().importDxfData(entities, {}),

  removeEntity: (id) => { set((state) => {
    if (!state.activeSketchId) return;

    removeEntityFromSketch(state.document, state.activeSketchId, id);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    state.selectedEntityIds = state.selectedEntityIds.filter((entityId) => entityId !== id);

    });
    get().regenerateFeatureTree();
  },

  updateEntity: (id, updates) => { set((state) => {
    if (!state.activeSketchId) return;
    
    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;
    
    if (!sketch) return;

    const existingEntity = sketch.entities.find((e) => e.id === id);
    if (!existingEntity) return;

    const updatedEntity = { ...existingEntity, ...updates } as CADEntity2D;

    updateEntityInSketch(state.document, state.activeSketchId, updatedEntity);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;

    });
    get().regenerateFeatureTree();
  },

  updateEntities: (newEntities) => { set((state) => {
    if (!state.activeSketchId || !newEntities || newEntities.length === 0) {
      return;
    }

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    const entityMap = new Map(newEntities.map((e) => [e.id, e]));
    sketch.entities = sketch.entities.map((e) => entityMap.get(e.id) || e);
    applyConstraintsToSketch(sketch);

    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;

    });
    get().regenerateFeatureTree();
  },

  toggleConstruction: (entityId: string) => { set((state) => {
    if (!state.activeSketchId) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    const existingEntity = sketch.entities.find((e) => e.id === entityId);
    if (!existingEntity) return;

    const updatedEntity = {
      ...existingEntity,
      isConstruction: !existingEntity.isConstruction,
    } as CADEntity2D;

    updateEntityInSketch(state.document, state.activeSketchId, updatedEntity);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;

    });
    get().regenerateFeatureTree();
  },

  addConstraint: (constraint) => { set((state) => {
    if (!state.activeSketchId) return;

    addConstraintToSketch(state.document, state.activeSketchId, constraint);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;

    });
    get().regenerateFeatureTree();
  },

  addDimension: (dimension, constraint) => set((state) => {
    if (!state.activeSketchId) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    let actualConstraint = { ...constraint };
    if (dimension.type === 'linear') {
      const p1 = dimension.points[0];
      const p2 = dimension.points[1];
      if (p1 && p2) {
        if (dimension.dimType === 'horizontal') {
          actualConstraint.type = 'distance_x';
          actualConstraint.value = Math.abs(p2.x - p1.x);
        } else if (dimension.dimType === 'vertical') {
          actualConstraint.type = 'distance_y';
          actualConstraint.value = Math.abs(p2.y - p1.y);
        } else if (dimension.dimType === 'aligned') {
          if (actualConstraint.type !== 'length' && actualConstraint.type !== 'distance') {
            actualConstraint.type = actualConstraint.entityIds.length === 1 ? 'length' : 'distance';
          }
          actualConstraint.value = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        }
      }
    }

    const referencedProjEntities = (actualConstraint.entityIds || [])
      .map((id) => state.projectedEntities.find((p) => p.id === id))
      .filter(Boolean) as CADEntity2D[];

    let initialEntities = [...sketch.entities];
    for (const pEnt of referencedProjEntities) {
      if (!initialEntities.some((e) => e.id === pEnt.id)) {
        initialEntities.push({
          ...pEnt,
          isProjected: true,
          isConstruction: true,
          state: 'FullyDefined',
          color: '#f59e0b',
        });
      }
    }

    let currentDoc = state.document;
    if (initialEntities.length > sketch.entities.length) {
      currentDoc = {
        ...state.document,
        featureTree: state.document.featureTree.map((f) => {
          if (f.id === state.activeSketchId && f.type === 'SKETCH') {
            return {
              ...f,
              entities: initialEntities,
            };
          }
          return f;
        }),
      };
    }

    const testConstraints = [...sketch.constraints, actualConstraint];
    const solverResult = solveConstraints(initialEntities, testConstraints);
    const dofState = analyzeSketchDOF(solverResult.entities, testConstraints);

    let finalDimension = dimension;
    let newDocument = currentDoc;

    if (dofState.state === 'OverDefined') {
      finalDimension = { 
        ...dimension, 
        isReference: true,
        constraintId: undefined,
        entityIds: actualConstraint.entityIds,
        pointIndices: actualConstraint.pointIndices
      };
      
      newDocument = {
        ...currentDoc,
        featureTree: currentDoc.featureTree.map((f) => {
          if (f.id === state.activeSketchId && f.type === 'SKETCH') {
            return {
              ...f,
              dimensions: [...((f as SketchFeature).dimensions || []), finalDimension],
            };
          }
          return f;
        }),
      };
    } else {
      finalDimension = {
        ...dimension,
        entityIds: actualConstraint.entityIds,
        pointIndices: actualConstraint.pointIndices
      };
      addDimensionToSketch(currentDoc, state.activeSketchId, finalDimension, actualConstraint);
      newDocument = currentDoc;
    }

    const docDirty = markSketchDirtyInDoc(newDocument, state.activeSketchId);

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {document: docDirty,});


    
  }),
  updateDimensionPosition: (dimensionId, newPosition) => set((state) => {
    if (!state.activeSketchId) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) => {
        if (f.id === state.activeSketchId && f.type === 'SKETCH') {
          const sketch = f as SketchFeature;
          const updatedDimensions = (sketch.dimensions || []).map((dim) => {
            if (dim.id === dimensionId) {
              return {
                ...dim,
                textPosition: newPosition,
              };
            }
            return dim;
          });
          return {
            ...sketch,
            dimensions: updatedDimensions,
          };
        }
        return f;
      }),
    };

    const undoState = pushUndoState(state);
      state.undoStack = undoState.undoStack;
      state.redoStack = undoState.redoStack;
      if (Object.keys({document: updatedDocument,}).length > 0) {
        Object.assign(state, {document: updatedDocument,});
      }
  }),
  updateDimensionPositionLive: (dimensionId, newPosition) => set((state) => {
    if (!state.activeSketchId) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) => {
        if (f.id === state.activeSketchId && f.type === 'SKETCH') {
          const sketch = f as SketchFeature;
          const updatedDimensions = (sketch.dimensions || []).map((dim) => {
            if (dim.id === dimensionId) {
              return {
                ...dim,
                textPosition: newPosition,
              };
            }
            return dim;
          });
          return {
            ...sketch,
            dimensions: updatedDimensions,
          };
        }
        return f;
      }),
    };

    return {
      document: updatedDocument,
    };
  }),
  removeConstraint: (constraintId) => { set((state) => {
    if (!state.activeSketchId) return;

    removeConstraintFromSketch(state.document, state.activeSketchId, constraintId);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;

    });
    get().regenerateFeatureTree();
  },

  removeDimension: (dimensionId) => { set((state) => {
    if (!state.activeSketchId) return;

    removeDimensionFromSketch(state.document, state.activeSketchId, dimensionId);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    state.selectedEntityIds = state.selectedEntityIds.filter((id) => id !== dimensionId);

    });
    get().regenerateFeatureTree();
  },

  updateConstraintValue: (constraintId, value) => set((state) => {
    if (!state.activeSketchId) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    const linkedDim = sketch.dimensions?.find((d) => d.constraintId === constraintId);
    const isDiameter = linkedDim ? !!linkedDim.isDiameter : false;

    const finalConstraintValue = (linkedDim && linkedDim.type === 'radial')
      ? (isDiameter ? value / 2 : value)
      : value;

    const updatedConstraints = sketch.constraints.map((c) => {
      if (c.id === constraintId) {
        return { ...c, value: finalConstraintValue, targetVal: Math.abs(finalConstraintValue) };
      }
      return c;
    });

    const updatedSketch: SketchFeature = {
      ...sketch,
      constraints: updatedConstraints,
    };
    applyConstraintsToSketch(updatedSketch);

    if (updatedSketch.dimensions) {
      updatedSketch.dimensions = updatedSketch.dimensions.map((dim) => {
        if (dim.constraintId === constraintId) {
          const constraint = updatedConstraints.find((c) => c.id === constraintId);
          if (constraint) {
            if (dim.type === 'radial') {
              if (constraint.entityIds.length === 1) {
                const entity = updatedSketch.entities.find((e) => e.id === constraint.entityIds[0]);
                if (entity && (entity.type === 'circle' || entity.type === 'arc')) {
                  const center = { ...entity.center };
                  const origP0 = dim.points[0];
                  const origP1 = dim.points[1] || { x: origP0.x + 10, y: origP0.y };
                  const dx = origP1.x - origP0.x;
                  const dy = origP1.y - origP0.y;
                  const len = Math.hypot(dx, dy);
                  const dir = len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
                  const newEdge = {
                    x: center.x + dir.x * entity.radius,
                    y: center.y + dir.y * entity.radius,
                  };
                  return {
                    ...dim,
                    points: [center, newEdge],
                  };
                }
              }
            } else if (dim.type === 'linear') {
              if (constraint.entityIds.length === 1) {
                const entity = updatedSketch.entities.find((e) => e.id === constraint.entityIds[0]);
                if (entity && entity.type === 'line') {
                  return {
                    ...dim,
                    points: [{ ...entity.start }, { ...entity.end }],
                  };
                }
              } else if (constraint.entityIds.length >= 2) {
                const id1 = constraint.entityIds[0];
                const id2 = constraint.entityIds[1];
                const idx1 = constraint.pointIndices?.[0] ?? 0;
                const idx2 = constraint.pointIndices?.[1] ?? 0;
                const e1 = updatedSketch.entities.find((e) => e.id === id1);
                const e2 = updatedSketch.entities.find((e) => e.id === id2);
                if (e1 && e2) {
                  const getPoint = (entity: CADEntity2D, index: number) => {
                    if (entity.type === 'line') {
                      return index === 1 ? entity.end : entity.start;
                    } else if (entity.type === 'circle' || entity.type === 'arc') {
                      return entity.center;
                    } else if (entity.type === 'polyline') {
                      return entity.points[index] || entity.points[0];
                    }
                    return null;
                  };
                  const pt1 = getPoint(e1, idx1);
                  const pt2 = getPoint(e2, idx2);
                  if (pt1 && pt2) {
                    return {
                      ...dim,
                      points: [{ ...pt1 }, { ...pt2 }],
                    };
                  }
                }
              }
            } else if (dim.type === 'angular') {
              if (constraint.entityIds.length >= 2) {
                const id1 = constraint.entityIds[0];
                const id2 = constraint.entityIds[1];
                const e1 = updatedSketch.entities.find((e) => e.id === id1);
                const e2 = updatedSketch.entities.find((e) => e.id === id2);
                if (e1 && e2 && e1.type === 'line' && e2.type === 'line') {
                  return {
                    ...dim,
                    points: [{ ...e1.start }, { ...e1.end }, { ...e2.start }, { ...e2.end }],
                  };
                }
              }
            }
          }
        }
        return dim;
      });
    }

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    const docDirty = markSketchDirtyInDoc(updatedDocument, state.activeSketchId);

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {document: docDirty,});


    
  }),
  updateDimensionValue: (dimensionId, newValue) => set((state) => {
    if (!state.activeSketchId) return;
    const safeValue = Math.abs(newValue);
    if (isNaN(safeValue) || safeValue <= 0) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    const targetDim = sketch.dimensions?.find((d) => d.id === dimensionId);
    if (!targetDim) return;

    let targetConstraintId = targetDim.constraintId;
    let targetConstraint = targetConstraintId
      ? sketch.constraints.find((c) => c.id === targetConstraintId)
      : undefined;

    if (!targetConstraint && targetDim.entityIds && targetDim.entityIds.length > 0) {
      targetConstraint = sketch.constraints.find((c) => {
        if (targetDim.entityIds?.length === 1 && c.entityIds.length === 1) {
          return c.entityIds[0] === targetDim.entityIds[0];
        }
        if (targetDim.entityIds?.length === 2 && c.entityIds.length === 2) {
          return (
            (c.entityIds[0] === targetDim.entityIds[0] && c.entityIds[1] === targetDim.entityIds[1]) ||
            (c.entityIds[0] === targetDim.entityIds[1] && c.entityIds[1] === targetDim.entityIds[0])
          );
        }
        return false;
      });
      if (targetConstraint) {
        targetConstraintId = targetConstraint.id;
      }
    }

    const isDiameter = !!targetDim.isDiameter;
    const finalConstraintVal = (targetDim.type === 'radial' && isDiameter)
      ? safeValue / 2
      : safeValue;

    let updatedConstraints: Constraint[];

    if (targetConstraint) {
      updatedConstraints = sketch.constraints.map((c) => {
        if (c.id === targetConstraint!.id) {
          return {
            ...c,
            value: finalConstraintVal,
            targetVal: finalConstraintVal,
          };
        }
        return c;
      });
    } else {
      let cType: ConstraintType = 'distance';
      if (targetDim.type === 'radial') {
        cType = 'radius';
      } else if (targetDim.type === 'angular') {
        cType = 'angle';
      } else if (targetDim.type === 'linear') {
        if (targetDim.dimType === 'horizontal') cType = 'distance_x';
        else if (targetDim.dimType === 'vertical') cType = 'distance_y';
        else cType = (targetDim.entityIds && targetDim.entityIds.length === 1) ? 'length' : 'distance';
      }

      const newCId = `c-dim-${Date.now()}`;
      targetConstraintId = newCId;
      const newConstraint: Constraint = {
        id: newCId,
        type: cType,
        entityIds: targetDim.entityIds || [],
        pointIndices: targetDim.pointIndices,
        value: finalConstraintVal,
        targetVal: finalConstraintVal,
      };
      updatedConstraints = [...sketch.constraints, newConstraint];
    }

    const allConstraintEntityIds = [
      ...(targetDim.entityIds || []),
      ...(targetConstraint?.entityIds || []),
      ...updatedConstraints.flatMap((c) => c.entityIds || []),
    ];
    const referencedProjEntities = allConstraintEntityIds
      .map((id) => state.projectedEntities.find((p) => p.id === id))
      .filter(Boolean) as CADEntity2D[];

    let workingSketchEntities = [...sketch.entities];
    for (const pEnt of referencedProjEntities) {
      if (!workingSketchEntities.some((e) => e.id === pEnt.id)) {
        workingSketchEntities.push({
          ...pEnt,
          isProjected: true,
          isConstruction: true,
          state: 'FullyDefined',
          color: '#f59e0b',
        });
      }
    }

    const updatedSketchTemp: SketchFeature = {
      ...sketch,
      entities: workingSketchEntities,
      constraints: updatedConstraints,
    };
    applyConstraintsToSketch(updatedSketchTemp);
    
    const updatedEntities = updatedSketchTemp.entities;

    const getEntityPoint = (entity: CADEntity2D | { id: string; type: string }, index: number) => {
      if (entity.id === 'origin') return { x: 0, y: 0 };
      const e = entity as CADEntity2D;
      if (e.type === 'line') {
        return index === 1 ? e.end : e.start;
      } else if (e.type === 'circle' || e.type === 'arc') {
        return e.center;
      } else if (e.type === 'polyline') {
        return e.points[index] || e.points[0];
      }
      return null;
    };

    const updatedDimensions = (sketch.dimensions || []).map((dim) => {
      const isTarget = dim.id === dimensionId;
      const currentCId = dim.constraintId || (isTarget ? targetConstraintId : undefined);
      const linkedConstraint = updatedConstraints.find((c) => c.id === currentCId);
      const eIds = linkedConstraint?.entityIds || dim.entityIds;
      const pIndices = linkedConstraint?.pointIndices || dim.pointIndices;

      if (dim.type === 'radial') {
        if (eIds && eIds.length === 1) {
          const entity = updatedEntities.find((e) => e.id === eIds[0]) || state.projectedEntities.find((p) => p.id === eIds[0]);
          if (entity && (entity.type === 'circle' || entity.type === 'arc')) {
            const center = { ...entity.center };
            const origP0 = dim.points[0] || center;
            const origP1 = dim.points[1] || { x: origP0.x + 10, y: origP0.y };
            const dx = origP1.x - origP0.x;
            const dy = origP1.y - origP0.y;
            const len = Math.hypot(dx, dy);
            const dir = len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
            const newEdge = {
              x: center.x + dir.x * entity.radius,
              y: center.y + dir.y * entity.radius,
            };
            return {
              ...dim,
              constraintId: currentCId,
              points: [center, newEdge],
            };
          }
        }
      } else if (dim.type === 'linear') {
        if (eIds) {
          if (eIds.length === 1) {
            const entity = updatedEntities.find((e) => e.id === eIds[0]) || state.projectedEntities.find((p) => p.id === eIds[0]);
            if (entity && entity.type === 'line') {
              return {
                ...dim,
                constraintId: currentCId,
                points: [{ ...entity.start }, { ...entity.end }],
              };
            }
          } else if (eIds.length >= 2) {
            const id1 = eIds[0];
            const id2 = eIds[1];
            const idx1 = pIndices?.[0] ?? 0;
            const idx2 = pIndices?.[1] ?? 0;
            const e1 = id1 === 'origin' ? { id: 'origin', type: 'point' } : (updatedEntities.find((e) => e.id === id1) || state.projectedEntities.find((p) => p.id === id1));
            const e2 = id2 === 'origin' ? { id: 'origin', type: 'point' } : (updatedEntities.find((e) => e.id === id2) || state.projectedEntities.find((p) => p.id === id2));
            if (e1 && e2) {
              const pt1 = getEntityPoint(e1, idx1);
              const pt2 = getEntityPoint(e2, idx2);
              if (pt1 && pt2) {
                return {
                  ...dim,
                  constraintId: currentCId,
                  points: [{ ...pt1 }, { ...pt2 }],
                };
              }
            }
          }
        }
      } else if (dim.type === 'angular') {
        if (eIds && eIds.length >= 2) {
          const id1 = eIds[0];
          const id2 = eIds[1];
          const e1 = updatedEntities.find((e) => e.id === id1) || state.projectedEntities.find((p) => p.id === id1);
          const e2 = updatedEntities.find((e) => e.id === id2) || state.projectedEntities.find((p) => p.id === id2);
          if (e1 && e2 && e1.type === 'line' && e2.type === 'line') {
            return {
              ...dim,
              constraintId: currentCId,
              points: [{ ...e1.start }, { ...e1.end }, { ...e2.start }, { ...e2.end }],
            };
          }
        }
      }

      return {
        ...dim,
        constraintId: currentCId,
      };
    });

    const updatedSketch: SketchFeature = {
      ...updatedSketchTemp,
      dimensions: updatedDimensions,
    };

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    const docDirty = markSketchDirtyInDoc(updatedDocument, state.activeSketchId);

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {document: docDirty,});


    
  }),
  dragVertexStart: () => set((state) => {
    const undoState = pushUndoState(state);
      state.undoStack = undoState.undoStack;
      state.redoStack = undoState.redoStack;
      if (Object.keys({}).length > 0) {
        Object.assign(state, {});
      }
  }),
  dragVertexLive: (entityId, pointIndex, newPos) => set((state) => {
    if (!state.activeSketchId) return state;
    
    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;
    
    if (!sketch) return state;

    const existingEntity = sketch.entities.find((e) => e.id === entityId);
    if (!existingEntity) return state;

    const updatedEntity = JSON.parse(JSON.stringify(existingEntity)) as CADEntity2D;
    
    if (updatedEntity.type === 'line') {
      if (pointIndex === 0) updatedEntity.start = newPos;
      else if (pointIndex === 1) updatedEntity.end = newPos;
    } else if (updatedEntity.type === 'circle') {
       if (pointIndex === 0) {
           updatedEntity.center = newPos;
       } else if (pointIndex === 1) {
           updatedEntity.radius = Math.hypot(newPos.x - updatedEntity.center.x, newPos.y - updatedEntity.center.y);
       }
    } else if (updatedEntity.type === 'arc') {
       if (pointIndex === 0) {
           const dx = newPos.x - updatedEntity.center.x;
           const dy = newPos.y - updatedEntity.center.y;
           updatedEntity.startAngle = Math.atan2(dy, dx);
           updatedEntity.radius = Math.hypot(dx, dy);
       } else if (pointIndex === 1) {
           const dx = newPos.x - updatedEntity.center.x;
           const dy = newPos.y - updatedEntity.center.y;
           updatedEntity.endAngle = Math.atan2(dy, dx);
           updatedEntity.radius = Math.hypot(dx, dy);
       } else if (pointIndex === 2) {
           updatedEntity.center = newPos;
       }
    } else if (updatedEntity.type === 'polyline') {
       if (updatedEntity.points[pointIndex]) {
           updatedEntity.points[pointIndex] = newPos;
       }
    }

    const newEntities = sketch.entities.map(e => e.id === entityId ? updatedEntity : e);

    const tempFixConstraint = {
       id: 'temp-drag-fix',
       type: 'fix' as const,
       entityIds: [entityId],
       pointIndices: [pointIndex]
    };

    const tempSketch: SketchFeature = {
       ...sketch,
       entities: newEntities,
       constraints: [...sketch.constraints, tempFixConstraint],
    };
    
    const solvedTempSketch: SketchFeature = {
       ...sketch,
       entities: newEntities,
       constraints: [...sketch.constraints, tempFixConstraint],
    };
    applyConstraintsToSketch(solvedTempSketch);
    solvedTempSketch.constraints = sketch.constraints;

    const updatedDocument: CADDocument = {
       ...state.document,
       featureTree: state.document.featureTree.map(f => 
          f.id === state.activeSketchId ? solvedTempSketch : f
       )
    };

    return { document: updatedDocument };
  }),
  dragVertexCommit: () => set((state) => {
    if (!state.activeSketchId) return;
    
    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;
    
    if (!sketch) return;

    const finalSketch: SketchFeature = { ...sketch };
    applyConstraintsToSketch(finalSketch);

    const updatedDocument: CADDocument = {
       ...state.document,
       featureTree: state.document.featureTree.map(f => 
          f.id === state.activeSketchId ? finalSketch : f
       )
    };

    const docDirty = markSketchDirtyInDoc(updatedDocument, state.activeSketchId);

    set({
       document: docDirty,
    });

    }),
  trimEntity: (entityId, clickPoint) => set((state) => {
    if (!state.activeSketchId) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    const trimResult = executeTrim(entityId, clickPoint, sketch.entities);
    if (!trimResult) return;

    const { toRemoveIds, toAddEntities } = trimResult;
    const toRemoveSet = new Set(toRemoveIds);

    const remainingConstraints = sketch.constraints.filter(
      (c) => !c.entityIds.some((id) => toRemoveSet.has(id))
    );
    const removedConstraintIds = new Set(
      sketch.constraints
        .filter((c) => c.entityIds.some((id) => toRemoveSet.has(id)))
        .map((c) => c.id)
    );
    const remainingDimensions = sketch.dimensions.filter(
      (d) => !d.constraintId || !removedConstraintIds.has(d.constraintId)
    );

    const updatedEntities = [
      ...sketch.entities.filter((e) => !toRemoveSet.has(e.id)),
      ...toAddEntities,
    ];

    const tempSketch: SketchFeature = {
      ...sketch,
      entities: updatedEntities,
      constraints: remainingConstraints,
      dimensions: remainingDimensions,
    };

    const updatedSketch: SketchFeature = {
      ...sketch,
      entities: updatedEntities,
      constraints: remainingConstraints,
      dimensions: remainingDimensions,
    };
    applyConstraintsToSketch(updatedSketch);

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    const docDirty = markSketchDirtyInDoc(updatedDocument, state.activeSketchId);

    
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {document: docDirty,
      selectedEntityIds: state.selectedEntityIds.filter((id) => !toRemoveSet.has(id)),});


    }),
  extendEntity: (entityId, clickPoint) => { set((state) => {
    if (!state.activeSketchId) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    applyExtendToSketch(sketch, entityId, clickPoint);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;

    });
    get().regenerateFeatureTree();
  },

  applyFillet: (entityId1, entityId2, radius) => { set((state) => {
    if (!state.activeSketchId) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    applyFilletToSketch(sketch, entityId1, entityId2, radius);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    state.selectedEntityIds = state.selectedEntityIds.filter((id) => id !== entityId1 && id !== entityId2);

    });
    get().regenerateFeatureTree();
  },

  applyChamfer: (entityId1, entityId2, distance) => { set((state) => {
    if (!state.activeSketchId) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    applyChamferToSketch(sketch, entityId1, entityId2, distance);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    state.selectedEntityIds = state.selectedEntityIds.filter((id) => id !== entityId1 && id !== entityId2);

    });
    get().regenerateFeatureTree();
  },

  offsetEntity: (entityId, distance, sidePoint) => { set((state) => {
    if (!state.activeSketchId) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    applyOffsetToSketch(sketch, entityId, distance, sidePoint);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;

    });
    get().regenerateFeatureTree();
  },

  mirrorEntities: (sourceEntityIds, p1, p2) => { set((state) => {
    if (!state.activeSketchId) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    applyMirrorToSketch(sketch, sourceEntityIds, p1, p2);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;

    });
    get().regenerateFeatureTree();
  },

  moveEntities: (entityIds, basePoint, targetPoint) => { set((state) => {
    if (!state.activeSketchId || !entityIds || entityIds.length === 0) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    applyMoveToSketch(sketch, entityIds, basePoint, targetPoint);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    state.selectedEntityIds = entityIds;

    });
    get().regenerateFeatureTree();
  },

  copyEntities: (entityIds, basePoint, targetPoint) => { set((state) => {
    if (!state.activeSketchId || !entityIds || entityIds.length === 0) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    const prevEntityCount = sketch.entities.length;
    applyCopyToSketch(sketch, entityIds, basePoint, targetPoint);
    const newEntities = sketch.entities.slice(prevEntityCount);
    const newEntityIds = newEntities.map((e) => e.id);

    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    state.selectedEntityIds = newEntityIds.length > 0 ? newEntityIds : state.selectedEntityIds;

    });
    get().regenerateFeatureTree();
  },

  scaleEntities: (entityIds, basePoint, factor) => { set((state) => {
    if (!state.activeSketchId || !entityIds || entityIds.length === 0 || factor <= 0) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    applyScaleToSketch(sketch, entityIds, basePoint, factor);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    state.selectedEntityIds = entityIds;

    });
    get().regenerateFeatureTree();
  },

  rotateEntities: (entityIds, basePoint, angleRad) => { set((state) => {
    if (!state.activeSketchId || !entityIds || entityIds.length === 0) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    applyRotateToSketch(sketch, entityIds, basePoint, angleRad);
    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    state.selectedEntityIds = entityIds;

    });
    get().regenerateFeatureTree();
  },

  circularArrayEntities: (entityIds, centerPoint, items, fillAngleDeg) => { set((state) => {
    if (!state.activeSketchId || !entityIds || entityIds.length === 0 || items <= 1) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    const prevCount = sketch.entities.length;
    applyCircularArrayToSketch(sketch, entityIds, centerPoint, items, fillAngleDeg);
    const newEntities = sketch.entities.slice(prevCount);
    const newEntityIds = newEntities.map((e) => e.id);

    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    state.selectedEntityIds = newEntityIds;

    });
    get().regenerateFeatureTree();
  },

  rectArrayEntities: (entityIds, cols, rows, colSpacing, rowSpacing) => { set((state) => {
    if (!state.activeSketchId || !entityIds || entityIds.length === 0 || cols < 1 || rows < 1 || (cols === 1 && rows === 1)) return;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return;

    const prevCount = sketch.entities.length;
    applyRectArrayToSketch(sketch, entityIds, cols, rows, colSpacing, rowSpacing);
    const newEntities = sketch.entities.slice(prevCount);
    const newEntityIds = newEntities.map((e) => e.id);

    markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    state.selectedEntityIds = newEntityIds;

    });
    get().regenerateFeatureTree();
  },

  toggleOsnap: () => set((state) => ({ osnapEnabled: !state.osnapEnabled })),
  toggleOrtho: () => set((state) => ({ orthoEnabled: !state.orthoEnabled })),
  toggleShowProfiles: () => set((state) => ({ showProfiles: !state.showProfiles })),

  toggleOsnapMode: (mode) => set((state) => ({
    osnapSettings: {
      ...state.osnapSettings,
      [mode]: !state.osnapSettings[mode]
    }
  })),

  setAllOsnapModes: (enabled) => set((state) => ({
    osnapSettings: {
      endpoint: enabled,
      midpoint: enabled,
      center: enabled,
      quadrant: enabled,
      intersection: enabled,
      extension: enabled,
      perpendicular: enabled,
      tangent: enabled,
      parallel: enabled,
    }
  })),

  clearOtrackAnchors: () => {
    // 全域提供 OTrack 追蹤點清空介面
  },

  setPolarModalOpen: (open) => set({ isPolarModalOpen: open }),
  togglePolarTracking: () => set((state) => ({ polarTrackingEnabled: !state.polarTrackingEnabled })),
  setPolarAngleStep: (step) => set({ polarAngleStep: step }),
  
  addCustomPolarAngle: (angle) => set((state) => {
    if (state.customPolarAngles.includes(angle)) {
      return state;
    }
    return { customPolarAngles: [...state.customPolarAngles, angle].sort((a, b) => a - b) };
  }),
  removeCustomPolarAngle: (angle) => set((state) => ({
    customPolarAngles: state.customPolarAngles.filter((a) => a !== angle)
  })),
  
  // ------------------------------------------
  // Undo / Redo (包含防呆機制)
  // ------------------------------------------

  undo: () => set((state) => {
    if (state.undoStack.length === 0) return state;
    const previousDoc = state.undoStack[state.undoStack.length - 1];
    const newUndoStack = state.undoStack.slice(0, -1);
    
    // 【防呆機制】檢查上一步的 activeSketchId 是否還存在於舊的特徵樹中
    const sketchExists = previousDoc.featureTree.some(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    );
    const safeActiveSketchId = sketchExists ? state.activeSketchId : null;
    
    return {
      undoStack: newUndoStack,
      redoStack: [...state.redoStack, JSON.parse(JSON.stringify(state.document))],
      document: previousDoc,
      activeSketchId: safeActiveSketchId,
      selectedEntityIds: [],
      selectedFeatureId: null,
    };
  }),
  redo: () => set((state) => {
    if (state.redoStack.length === 0) return state;
    const nextDoc = state.redoStack[state.redoStack.length - 1];
    const newRedoStack = state.redoStack.slice(0, -1);
    
    // 【防呆機制】檢查下一步的 activeSketchId 是否還存在
    const sketchExists = nextDoc.featureTree.some(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    );
    const safeActiveSketchId = sketchExists ? state.activeSketchId : null;

    return {
      undoStack: [...state.undoStack, JSON.parse(JSON.stringify(state.document))],
      redoStack: newRedoStack,
      document: nextDoc,
      activeSketchId: safeActiveSketchId,
      selectedEntityIds: [],
      selectedFeatureId: null,
    };
  }),
  canUndo: () => get().undoStack.length > 0,
  
  canRedo: () => get().redoStack.length > 0,

  resetDocument: () => {
    const doc = createInitialDocument();
    set({
      document: doc,
      activeLayerId: '0',
      viewMode: '2D',
      currentTool: 'SELECT',
      activeSketchId: 'sketch-1',
      selectedEntityIds: [],
      selectedFeatureId: null,
      selectedFaceInfo: null,
      extrudePreview: null,
      revolvePreview: null,
      isPickingRevolveAxis: false,
      undoStack: [],
      redoStack: [],
      cumulativePartMesh: null,
      featureResults: {},
      bodies: [],
      kernelDiagnostics: [],
    });
  },
})));

// 常用的 state Selectors
export const useCADDocument = () => useCADStore((state) => state.document);
export const useViewMode = () => useCADStore((state) => state.viewMode);
export const useCurrentTool = () => useCADStore((state) => state.currentTool);
export const useActiveSketch = () => useCADStore((state) => {
  if (!state.activeSketchId) return null;
  const feature = state.document.featureTree.find(
    (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
  );
  return (feature as SketchFeature) || null;
});
export const useActiveLayerId = () => useCADStore((state) => state.activeLayerId);
export const useCADLayers = () => useCADStore((state) => state.document.layers);
export const useShowProfiles = () => useCADStore((state) => state.showProfiles);