import { create } from 'zustand';
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
import { executeTrim } from '../core/2d/TrimManager';
import { solveConstraints, analyzeSketchDOF } from '../core/solver/ConstraintSolver';
import {
  getRegenSequence,
  markDownstreamDirty,
  validateFeatureDependencies,
  getDirectDependencies,
} from '../core/3d/FeatureRegenEngine';

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
  doc.activeSketchId = 'sketch-1';
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

export const useCADStore = create<CADState>((set, get) => ({
  document: createInitialDocument(),
  activeLayerId: '0',
  viewMode: '2D',
  currentTool: 'SELECT',
  activeSketchId: 'sketch-1',
  selectedEntityIds: [],
  selectedFeatureId: null,
  osnapEnabled: true,
  orthoEnabled: false,
  showProfiles: true,

  // 鎖點開關與各模式勾選狀態（預設全開啟）
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
  isOsnapModalOpen: false,

  // 極座標追蹤角度設定（預設 45 度，候選角度包含 15, 30, 45, 90 等）
  polarTrackingEnabled: true,
  polarAngleStep: 45,
  customPolarAngles: [],
  isPolarModalOpen: false,
  isLayerModalOpen: false,
  setLayerModalOpen: (open) => set({ isLayerModalOpen: open }),

  // 環形陣列 (Circular Array) 參數設定（預設 4 個項目，360 度填滿）
  arrayItems: 4,
  arrayFillAngle: 360,
  setArrayItems: (items) => set({ arrayItems: Math.max(2, Math.round(items)) }),
  setArrayFillAngle: (angle) => set({ arrayFillAngle: angle }),

  // 矩形陣列 (Rectangular Array) 參數設定（預設 4 行 3 列，間距各 30）
  rectArrayCols: 4,
  rectArrayRows: 3,
  rectArrayColSpacing: 30,
  rectArrayRowSpacing: 30,
  setRectArrayCols: (cols) => set({ rectArrayCols: Math.max(1, Math.min(100, Math.round(cols))) }),
  setRectArrayRows: (rows) => set({ rectArrayRows: Math.max(1, Math.min(100, Math.round(rows))) }),
  setRectArrayColSpacing: (spacing) => set({ rectArrayColSpacing: spacing }),
  setRectArrayRowSpacing: (spacing) => set({ rectArrayRowSpacing: spacing }),

  // 倒角 (Chamfer) 距離設定（預設為 10）
  chamferDistance: 10,
  setChamferDistance: (distance) => set({ chamferDistance: Math.max(0.1, distance) }),

  // 正多邊形 (Polygon) 設定（預設 5 邊，內接於圓）
  polygonSides: 5,
  polygonMethod: 'inscribed',
  setPolygonSides: (sides) => set({ polygonSides: Math.max(3, Math.min(1024, Math.round(sides))) }),
  setPolygonMethod: (method) => set({ polygonMethod: method }),

  undoStack: [],
  redoStack: [],

  // 特徵樹 Actions 實作
  setSelectedFeatureId: (id) => set((state) => {
    if (!id) {
      return { selectedFeatureId: null };
    }
    const feature = state.document.featureTree.find((f) => f.id === id);
    if (feature && feature.type === 'SKETCH') {
      return {
        selectedFeatureId: id,
        activeSketchId: id,
      };
    }
    return { selectedFeatureId: id };
  }),

  addFeature: (feature) => set((state) => {
    const currentRollback = Math.max(0, Math.min(state.document.rollbackIndex, state.document.featureTree.length));
    const tree = state.document.featureTree;
    const newFeatureTree = [
      ...tree.slice(0, currentRollback),
      feature,
      ...tree.slice(currentRollback),
    ];
    const newRollbackIndex = currentRollback + 1;
    const nextActiveSketchId = feature.type === 'SKETCH' ? feature.id : state.activeSketchId;

    return {
      ...pushUndoState(state),
      activeSketchId: nextActiveSketchId,
      selectedFeatureId: feature.id,
      document: {
        ...state.document,
        featureTree: newFeatureTree,
        rollbackIndex: newRollbackIndex,
      },
    };
  }),

  removeFeature: (id) => set((state) => {
    const featureIndex = state.document.featureTree.findIndex((f) => f.id === id);
    if (featureIndex === -1) return state;

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

    return {
      ...pushUndoState(state),
      document: {
        ...state.document,
        featureTree: updatedTree,
        rollbackIndex: newRollbackIndex,
      },
      selectedFeatureId: state.selectedFeatureId === id ? null : state.selectedFeatureId,
      activeSketchId: nextActiveSketchId,
    };
  }),

  updateFeature: (id, updates) => set((state) => {
    const exists = state.document.featureTree.some((f) => f.id === id);
    if (!exists) return state;

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

    return {
      ...pushUndoState(state),
      activeSketchId: nextActiveSketchId,
      document: {
        ...state.document,
        featureTree: finalTree,
      },
    };
  }),

  toggleFeatureSuppression: (id) => set((state) => {
    const feature = state.document.featureTree.find((f) => f.id === id);
    if (!feature) return state;

    const newSuppressed = !feature.suppressed;
    const updatedTree = state.document.featureTree.map((f) =>
      f.id === id ? { ...f, suppressed: newSuppressed, isDirty: true } : f
    );

    const dirtyTree = markDownstreamDirty(updatedTree, id);

    const nextActiveSketchId = (feature.type === 'SKETCH' && newSuppressed && state.activeSketchId === id)
      ? (dirtyTree.find((f) => f.type === 'SKETCH' && !f.suppressed)?.id || null)
      : (feature.type === 'SKETCH' && !newSuppressed ? id : state.activeSketchId);

    return {
      ...pushUndoState(state),
      activeSketchId: nextActiveSketchId,
      document: {
        ...state.document,
        featureTree: dirtyTree,
      },
    };
  }),

  renameFeature: (id, newName) => set((state) => {
    const trimmed = newName.trim();
    if (!trimmed) return state;
    const feature = state.document.featureTree.find((f) => f.id === id);
    if (!feature || feature.name === trimmed) return state;

    const updatedTree = state.document.featureTree.map((f) =>
      f.id === id ? { ...f, name: trimmed } : f
    );

    return {
      ...pushUndoState(state),
      document: {
        ...state.document,
        featureTree: updatedTree,
      },
    };
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
      return state;
    }

    const [moved] = tree.splice(sourceIndex, 1);
    tree.splice(targetIndex, 0, moved);

    if (!checkDAGOrderValid(tree)) {
      console.warn('Reordering cancelled: Breaks feature dependency DAG hierarchy.');
      return state;
    }

    return {
      ...pushUndoState(state),
      document: {
        ...state.document,
        featureTree: tree,
      },
    };
  }),

  setRollbackIndex: (index) => set((state) => {
    const clamped = Math.max(0, Math.min(index, state.document.featureTree.length));
    if (state.document.rollbackIndex === clamped) return state;

    const activeFeatures = state.document.featureTree.slice(0, clamped);
    let nextActiveSketchId = state.activeSketchId;
    if (nextActiveSketchId) {
      const activeSketchInRollback = activeFeatures.find((f) => f.id === nextActiveSketchId && f.type === 'SKETCH');
      if (!activeSketchInRollback) {
        const lastSketch = [...activeFeatures].reverse().find((f) => f.type === 'SKETCH');
        nextActiveSketchId = lastSketch ? lastSketch.id : null;
      }
    }

    return {
      activeSketchId: nextActiveSketchId,
      document: {
        ...state.document,
        rollbackIndex: clamped,
      },
    };
  }),

  regenerateFeatureTree: () => set((state) => {
    const regenResult = getRegenSequence(state.document);
    const { validationErrors, hasCycle, cycleNodes } = regenResult;

    const regeneratedTree = state.document.featureTree.map((f) => {
      const errors = validationErrors.get(f.id);
      if (errors && errors.length > 0) {
        return {
          ...f,
          error: errors.join('; '),
          isDirty: true,
        };
      }
      if (hasCycle && cycleNodes.includes(f.id)) {
        return {
          ...f,
          error: 'Cyclic dependency detected in feature tree',
          isDirty: true,
        };
      }
      return {
        ...f,
        error: null,
        isDirty: false,
      };
    });

    return {
      ...pushUndoState(state),
      document: {
        ...state.document,
        featureTree: regeneratedTree,
      },
    };
  }),

  // ============================================================================
  // 基準面 (Datum Plane) 特徵、參數化連動與草圖建立 Actions 實作
  // ============================================================================

  addOffsetDatumPlane: (refPlaneId, distance, name) => {
    const state = get();
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
      newFeature,
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

    set({
      ...pushUndoState(state),
      selectedFeatureId: newFeatureId,
      document: updatedDocument,
    });

    return newFeatureId;
  },

  updateDatumPlaneOffset: (planeFeatureId, distance) => set((state) => {
    const tree = state.document.featureTree;
    const featureIndex = tree.findIndex((f) => f.id === planeFeatureId && f.type === 'DATUM_PLANE');
    if (featureIndex === -1) return state;

    const datumFeature = tree[featureIndex] as DatumPlaneFeature;
    const refPlaneId = datumFeature.referencePlaneId || datumFeature.referenceFeatureId || 'datum-front';
    const refPlane = findCustomPlane(state.document, refPlaneId) || DatumFrontPlane;

    // 重算偏移姿態
    const recalculatedPlane = createOffsetPlane(refPlane, distance, datumFeature.name, planeFeatureId);

    // 【參數化連動核心】：更新 DatumPlaneFeature 姿態，並連動所有依附該基準面的子草圖 (SketchFeature)
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

    return {
      ...pushUndoState(state),
      document: updatedDocument,
    };
  }),

  toggleFeatureVisibility: (featureId) => set((state) => {
    const feature = state.document.featureTree.find((f) => f.id === featureId);
    if (!feature) return state;

    const newVisible = feature.visible === false ? true : false;
    const updatedTree = state.document.featureTree.map((f) =>
      f.id === featureId ? { ...f, visible: newVisible } : f
    );

    return {
      ...pushUndoState(state),
      document: {
        ...state.document,
        featureTree: updatedTree,
      },
    };
  }),

  createSketchOnPlane: (planeId) => {
    const state = get();
    const targetPlane = findCustomPlane(state.document, planeId) || DatumFrontPlane;

    const newSketchId = `sketch-${Date.now()}`;
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
      activeSketchId: newSketchId,
    };

    set({
      ...pushUndoState(state),
      activeSketchId: newSketchId,
      selectedFeatureId: newSketchId,
      selectedEntityIds: [],
      document: updatedDocument,
    });

    return newSketchId;
  },

  // 3D 特徵管理 Actions 實作
  addExtrudeFeature: (feature) => set((state) => {
    const newFeature: ExtrudeFeature = {
      ...feature,
      id: 'extrude-' + Date.now().toString(),
      type: 'EXTRUDE' as const,
      dependencies: feature.sketchId ? [feature.sketchId] : [],
      suppressed: false,
    };
    
    const currentRollback = Math.max(0, Math.min(state.document.rollbackIndex, state.document.featureTree.length));
    const tree = state.document.featureTree;
    const newFeatureTree = [
      ...tree.slice(0, currentRollback),
      newFeature,
      ...tree.slice(currentRollback),
    ];

    return {
      ...pushUndoState(state),
      selectedFeatureId: newFeature.id,
      document: {
        ...state.document,
        featureTree: newFeatureTree,
        rollbackIndex: currentRollback + 1,
      },
    };
  }),

  updateExtrudeFeature: (id, updates) => get().updateFeature(id, updates),

  setViewMode: (mode) => set({ viewMode: mode }),
  
  setTool: (tool) => set({ currentTool: tool }),
  
  setActiveSketch: (sketchId) => set({ activeSketchId: sketchId }),
  
  selectEntity: (id) => set((state) => {
    if (state.selectedEntityIds.includes(id)) {
      return state;
    }
    return { selectedEntityIds: [...state.selectedEntityIds, id] };
  }),
  
  clearSelection: () => set({ selectedEntityIds: [], selectedFeatureId: null }),

  setActiveLayer: (layerId: string) => set({ activeLayerId: layerId }),

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
    return {
      ...pushUndoState(state),
      document: updatedDocument,
    };
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
          return applyConstraintsToSketch({
            ...sketch,
            entities: updatedEntities,
          });
        }
      }
      return feature;
    });

    const updatedDocument: CADDocument = {
      ...state.document,
      layers: remainingLayers,
      featureTree: updatedFeatureTree,
    };

    return {
      ...pushUndoState(state),
      document: updatedDocument,
      activeLayerId: newActiveLayerId,
    };
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

    return {
      ...pushUndoState(state),
      document: updatedDocument,
    };
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

    return {
      ...pushUndoState(state),
      document: updatedDocument,
    };
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

    return {
      ...pushUndoState(state),
      document: updatedDocument,
    };
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

    return {
      ...pushUndoState(state),
      document: updatedDocument,
    };
  }),
  
  addEntity: (entity) => set((state) => {
    if (!state.activeSketchId) return state;
    const activeLayer = state.activeLayerId || '0';
    const targetLayerId = (!entity.layerId || entity.layerId === '0' || entity.layerId === 'layer-0')
      ? activeLayer
      : entity.layerId;

    const newEntity: CADEntity2D = {
      ...entity,
      layerId: targetLayerId,
      isConstruction: entity.isConstruction ?? (targetLayerId === 'CONSTRUCTION'),
    };

    return {
      ...pushUndoState(state),
      document: insertEntityIntoSketch(state.document, state.activeSketchId, newEntity)
    };
  }),

  importDxfData: (entities, layers) => set((state) => {
    if (!entities || entities.length === 0 || !state.activeSketchId) {
      return state;
    }

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const preparedEntities: CADEntity2D[] = entities.map((e) => ({
      ...e,
      state: 'UnderDefined',
    }));

    const mergedSketch: SketchFeature = {
      ...sketch,
      entities: [...sketch.entities, ...preparedEntities],
    };

    const updatedSketch = applyConstraintsToSketch(mergedSketch);

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

    return {
      ...pushUndoState(state),
      document: updatedDocument,
      selectedEntityIds: [],
    };
  }),

  importEntities: (entities) => get().importDxfData(entities, {}),

  removeEntity: (id) => set((state) => {
    if (!state.activeSketchId) return state;
    return {
      ...pushUndoState(state),
      document: removeEntityFromSketch(state.document, state.activeSketchId, id),
      selectedEntityIds: state.selectedEntityIds.filter((entityId) => entityId !== id)
    };
  }),

  updateEntity: (id, updates) => set((state) => {
    if (!state.activeSketchId) return state;
    
    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;
    
    if (!sketch) return state;

    const existingEntity = sketch.entities.find((e) => e.id === id);
    if (!existingEntity) return state;

    const updatedEntity = { ...existingEntity, ...updates } as CADEntity2D;

    return {
      ...pushUndoState(state),
      document: updateEntityInSketch(state.document, state.activeSketchId, updatedEntity)
    };
  }),

  updateEntities: (newEntities) => set((state) => {
    if (!state.activeSketchId || !newEntities || newEntities.length === 0) {
      return state;
    }

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const entityMap = new Map(newEntities.map((e) => [e.id, e]));
    const updatedEntities = sketch.entities.map((e) => entityMap.get(e.id) || e);

    const updatedSketch = applyConstraintsToSketch({
      ...sketch,
      entities: updatedEntities,
    });

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    return {
      ...pushUndoState(state),
      document: updatedDocument,
    };
  }),

  toggleConstruction: (entityId: string) => set((state) => {
    if (!state.activeSketchId) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const existingEntity = sketch.entities.find((e) => e.id === entityId);
    if (!existingEntity) return state;

    const updatedEntity = {
      ...existingEntity,
      isConstruction: !existingEntity.isConstruction,
    } as CADEntity2D;

    return {
      ...pushUndoState(state),
      document: updateEntityInSketch(state.document, state.activeSketchId, updatedEntity),
    };
  }),

  addConstraint: (constraint) => set((state) => {
    if (!state.activeSketchId) return state;
    return {
      ...pushUndoState(state),
      document: addConstraintToSketch(state.document, state.activeSketchId, constraint),
    };
  }),

  addDimension: (dimension, constraint) => set((state) => {
    if (!state.activeSketchId) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

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

    const testConstraints = [...sketch.constraints, actualConstraint];
    const solverResult = solveConstraints(sketch.entities, testConstraints);
    const dofState = analyzeSketchDOF(solverResult.entities, testConstraints);

    let finalDimension = dimension;
    let newDocument = state.document;

    if (dofState.state === 'OverDefined') {
      finalDimension = { 
        ...dimension, 
        isReference: true,
        constraintId: undefined,
        entityIds: actualConstraint.entityIds,
        pointIndices: actualConstraint.pointIndices
      };
      
      newDocument = {
        ...state.document,
        featureTree: state.document.featureTree.map((f) => {
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
      newDocument = addDimensionToSketch(state.document, state.activeSketchId, finalDimension, actualConstraint);
    }

    return {
      ...pushUndoState(state),
      document: newDocument,
    };
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

    return {
      ...pushUndoState(state),
      document: updatedDocument,
    };
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

  removeConstraint: (constraintId) => set((state) => {
    if (!state.activeSketchId) return state;
    return {
      ...pushUndoState(state),
      document: removeConstraintFromSketch(state.document, state.activeSketchId, constraintId),
    };
  }),

  removeDimension: (dimensionId) => set((state) => {
    if (!state.activeSketchId) return state;
    return {
      ...pushUndoState(state),
      document: removeDimensionFromSketch(state.document, state.activeSketchId, dimensionId),
      selectedEntityIds: state.selectedEntityIds.filter((id) => id !== dimensionId),
    };
  }),

  updateConstraintValue: (constraintId, value) => set((state) => {
    if (!state.activeSketchId) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) => {
        if (f.id === state.activeSketchId && f.type === 'SKETCH') {
          const sketch = f as SketchFeature;

          const linkedDim = sketch.dimensions?.find((d) => d.constraintId === constraintId);
          const isDiameter = linkedDim ? !!linkedDim.isDiameter : false;

          const finalConstraintValue = (linkedDim && linkedDim.type === 'radial')
            ? (isDiameter ? value / 2 : value)
            : value;

          const updatedConstraints = sketch.constraints.map((c) => {
            if (c.id === constraintId) {
              return { ...c, value: finalConstraintValue };
            }
            return c;
          });

          const updatedSketch = applyConstraintsToSketch({
            ...sketch,
            constraints: updatedConstraints,
          });

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
              } else {
                const linkedConstraint = updatedConstraints.find((c) => c.id === dim.constraintId);
                const eIds = linkedConstraint?.entityIds || dim.entityIds;
                const pIndices = linkedConstraint?.pointIndices || dim.pointIndices;

                if (dim.type === 'radial') {
                  if (eIds && eIds.length === 1) {
                    const entity = updatedSketch.entities.find((e) => e.id === eIds[0]);
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
                  if (eIds) {
                    if (eIds.length === 1) {
                      const entity = updatedSketch.entities.find((e) => e.id === eIds[0]);
                      if (entity && entity.type === 'line') {
                        return {
                          ...dim,
                          points: [{ ...entity.start }, { ...entity.end }],
                        };
                      }
                    } else if (eIds.length >= 2) {
                      const id1 = eIds[0];
                      const id2 = eIds[1];
                      const idx1 = pIndices?.[0] ?? 0;
                      const idx2 = pIndices?.[1] ?? 0;
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
                  }
                } else if (dim.type === 'angular') {
                  if (eIds && eIds.length >= 2) {
                    const id1 = eIds[0];
                    const id2 = eIds[1];
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
              return dim;
            });
          }

          return updatedSketch;
        }
        return f;
      }),
    };

    return {
      ...pushUndoState(state),
      document: updatedDocument,
    };
  }),

  dragVertexStart: () => set((state) => {
    return {
      ...pushUndoState(state)
    };
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
    
    const solvedTempSketch = applyConstraintsToSketch(tempSketch);
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
    if (!state.activeSketchId) return state;
    
    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;
    
    if (!sketch) return state;

    const finalSketch = applyConstraintsToSketch(sketch);

    const updatedDocument: CADDocument = {
       ...state.document,
       featureTree: state.document.featureTree.map(f => 
          f.id === state.activeSketchId ? finalSketch : f
       )
    };

    return {
       document: updatedDocument,
    };
  }),

  trimEntity: (entityId, clickPoint) => set((state) => {
    if (!state.activeSketchId) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const trimResult = executeTrim(entityId, clickPoint, sketch.entities);
    if (!trimResult) return state;

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

    const updatedSketch = applyConstraintsToSketch(tempSketch);

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    return {
      ...pushUndoState(state),
      document: updatedDocument,
      selectedEntityIds: state.selectedEntityIds.filter((id) => !toRemoveSet.has(id)),
    };
  }),

  extendEntity: (entityId, clickPoint) => set((state) => {
    if (!state.activeSketchId) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const updatedSketch = applyExtendToSketch(sketch, entityId, clickPoint);
    if (updatedSketch === sketch) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    return {
      ...pushUndoState(state),
      document: updatedDocument,
    };
  }),

  applyFillet: (entityId1, entityId2, radius) => set((state) => {
    if (!state.activeSketchId) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const updatedSketch = applyFilletToSketch(sketch, entityId1, entityId2, radius);
    if (updatedSketch === sketch) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    return {
      ...pushUndoState(state),
      document: updatedDocument,
      selectedEntityIds: state.selectedEntityIds.filter((id) => id !== entityId1 && id !== entityId2),
    };
  }),

  applyChamfer: (entityId1, entityId2, distance) => set((state) => {
    if (!state.activeSketchId) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const updatedSketch = applyChamferToSketch(sketch, entityId1, entityId2, distance);
    if (updatedSketch === sketch) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    return {
      ...pushUndoState(state),
      document: updatedDocument,
      selectedEntityIds: state.selectedEntityIds.filter((id) => id !== entityId1 && id !== entityId2),
    };
  }),

  offsetEntity: (entityId, distance, sidePoint) => set((state) => {
    if (!state.activeSketchId) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const updatedSketch = applyOffsetToSketch(sketch, entityId, distance, sidePoint);
    if (updatedSketch === sketch) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    return {
      ...pushUndoState(state),
      document: updatedDocument,
    };
  }),

  mirrorEntities: (sourceEntityIds, p1, p2) => set((state) => {
    if (!state.activeSketchId) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const updatedSketch = applyMirrorToSketch(sketch, sourceEntityIds, p1, p2);
    if (updatedSketch === sketch) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    return {
      ...pushUndoState(state),
      document: updatedDocument,
    };
  }),

  moveEntities: (entityIds, basePoint, targetPoint) => set((state) => {
    if (!state.activeSketchId || !entityIds || entityIds.length === 0) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const updatedSketch = applyMoveToSketch(sketch, entityIds, basePoint, targetPoint);
    if (updatedSketch === sketch) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    return {
      ...pushUndoState(state),
      document: updatedDocument,
      selectedEntityIds: entityIds,
    };
  }),

  copyEntities: (entityIds, basePoint, targetPoint) => set((state) => {
    if (!state.activeSketchId || !entityIds || entityIds.length === 0) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const prevEntityCount = sketch.entities.length;
    const updatedSketch = applyCopyToSketch(sketch, entityIds, basePoint, targetPoint);
    if (updatedSketch === sketch) return state;

    const newEntities = updatedSketch.entities.slice(prevEntityCount);
    const newEntityIds = newEntities.map((e) => e.id);

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    return {
      ...pushUndoState(state),
      document: updatedDocument,
      selectedEntityIds: newEntityIds.length > 0 ? newEntityIds : state.selectedEntityIds,
    };
  }),

  scaleEntities: (entityIds, basePoint, factor) => set((state) => {
    if (!state.activeSketchId || !entityIds || entityIds.length === 0 || factor <= 0) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const updatedSketch = applyScaleToSketch(sketch, entityIds, basePoint, factor);
    if (updatedSketch === sketch) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    return {
      ...pushUndoState(state),
      document: updatedDocument,
      selectedEntityIds: entityIds,
    };
  }),

  rotateEntities: (entityIds, basePoint, angleRad) => set((state) => {
    if (!state.activeSketchId || !entityIds || entityIds.length === 0) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const updatedSketch = applyRotateToSketch(sketch, entityIds, basePoint, angleRad);
    if (updatedSketch === sketch) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    return {
      ...pushUndoState(state),
      document: updatedDocument,
      selectedEntityIds: entityIds,
    };
  }),

  circularArrayEntities: (entityIds, centerPoint, items, fillAngleDeg) => set((state) => {
    if (!state.activeSketchId || !entityIds || entityIds.length === 0 || items <= 1) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const updatedSketch = applyCircularArrayToSketch(sketch, entityIds, centerPoint, items, fillAngleDeg);
    if (updatedSketch === sketch) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    const newEntityIds = updatedSketch.entities.map((e) => e.id);

    return {
      ...pushUndoState(state),
      document: updatedDocument,
      selectedEntityIds: newEntityIds,
    };
  }),

  rectArrayEntities: (entityIds, cols, rows, colSpacing, rowSpacing) => set((state) => {
    if (!state.activeSketchId || !entityIds || entityIds.length === 0 || cols < 1 || rows < 1 || (cols === 1 && rows === 1)) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const updatedSketch = applyRectArrayToSketch(sketch, entityIds, cols, rows, colSpacing, rowSpacing);
    if (updatedSketch === sketch) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) =>
        f.id === state.activeSketchId ? updatedSketch : f
      ),
    };

    const newEntityIds = updatedSketch.entities.map((e) => e.id);

    return {
      ...pushUndoState(state),
      document: updatedDocument,
      selectedEntityIds: newEntityIds,
    };
  }),

  toggleOsnap: () => set((state) => ({ osnapEnabled: !state.osnapEnabled })),
  toggleOrtho: () => set((state) => ({ orthoEnabled: !state.orthoEnabled })),
  toggleShowProfiles: () => set((state) => ({ showProfiles: !state.showProfiles })),

  setOsnapModalOpen: (open) => set({ isOsnapModalOpen: open }),
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
    // 全域提供 OTrack 追蹤點清空介面，可在需要時供組件或繪圖狀態機呼叫
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
  
  undo: () => set((state) => {
    if (state.undoStack.length === 0) return state;
    const previousDoc = state.undoStack[state.undoStack.length - 1];
    const newUndoStack = state.undoStack.slice(0, -1);
    
    return {
      undoStack: newUndoStack,
      redoStack: [...state.redoStack, JSON.parse(JSON.stringify(state.document))],
      document: previousDoc,
      selectedEntityIds: [],
      selectedFeatureId: null,
    };
  }),

  redo: () => set((state) => {
    if (state.redoStack.length === 0) return state;
    const nextDoc = state.redoStack[state.redoStack.length - 1];
    const newRedoStack = state.redoStack.slice(0, -1);
    
    return {
      undoStack: [...state.undoStack, JSON.parse(JSON.stringify(state.document))],
      redoStack: newRedoStack,
      document: nextDoc,
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
      activeSketchId: doc.activeSketchId,
      selectedEntityIds: [],
      selectedFeatureId: null,
      currentTool: 'SELECT',
      viewMode: '2D',
      undoStack: [],
      redoStack: [],
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
      polarTrackingEnabled: true,
      polarAngleStep: 45,
      customPolarAngles: [],
      arrayItems: 4,
      arrayFillAngle: 360,
      isOsnapModalOpen: false,
      isPolarModalOpen: false,
      isLayerModalOpen: false,
      showProfiles: true,
    });
  }
}));

// Selector Hooks
export const useCADDocument = () => useCADStore((state) => state.document);
export const useViewMode = () => useCADStore((state) => state.viewMode);
export const useCurrentTool = () => useCADStore((state) => state.currentTool);
export const useActiveSketch = () => useCADStore((state) => state.activeSketchId);
export const useActiveLayerId = () => useCADStore((state) => state.activeLayerId);
export const useCADLayers = () => useCADStore((state) => state.document.layers);
export const useShowProfiles = () => useCADStore((state) => state.showProfiles);
