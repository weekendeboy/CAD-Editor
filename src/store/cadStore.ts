/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { original } from "immer";
import { CADState, SketchDraftSnapshot } from "./cadStore.types";
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
  Point2D,
} from "../types/cad";
import { createOffsetPlane } from "../core/3d/DatumPlaneEngine";
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
  pushSketchUndoState,
} from "./sketchMutators";
import {
  getDirectDependencies,
  markDownstreamDirty,
  validateFeatureDependencies,
  getRegenPlan,
  applyRegenResults,
  isBodyModifyingFeature,
} from "../core/3d/FeatureRegenEngine";
import {
  buildFeatureEvalOps,
  compileFeaturePlan,
} from "../core/3d/FeaturePipelineAdapter";
import { executeTrim } from "../core/2d/TrimManager";
import {
  solveConstraints,
  analyzeSketchDOF,
} from "../core/solver/NumericalConstraintSolver";
import { solidEngine } from "../core/3d/SolidEngine";

// [NOTE] 保留原有的輔助函式 findCustomPlane, createInitialDocument, checkDAGOrderValid, markSketchDirtyInDoc
// ... (保留這部分程式碼, 為了節省空間，這裡不顯示)

/**
 * 依據 ID 尋找對應的 CustomPlane (包含特徵樹上的 DatumPlaneFeature/SketchFeature、doc.planes 以及預設 3 大基準面)
 */
function findCustomPlane(
  doc: CADDocument,
  planeId: string,
): CustomPlane | null {
  if (!doc) return null;

  // 1. 於特徵樹搜尋 DatumPlaneFeature 或 SketchFeature
  const feature = doc.featureTree.find((f) => f.id === planeId);
  if (feature) {
    if (feature.type === "DATUM_PLANE") {
      return (feature as DatumPlaneFeature).plane;
    }
    if (feature.type === "SKETCH") {
      return (feature as SketchFeature).plane;
    }
  }

  // 2. 於 doc.planes 快照表搜尋
  if (doc.planes && doc.planes[planeId]) {
    return doc.planes[planeId];
  }

  // 3. 標準預設三大基準面降級保護
  if (planeId === "datum-front") return DatumFrontPlane;
  if (planeId === "datum-top") return DatumTopPlane;
  if (planeId === "datum-right") return DatumRightPlane;

  return null;
}

/**
 * 初始化建立標準 CAD Document，確保特徵樹頂部包含常駐的 3 個標準基準面 (Front, Top, Right) 與預設草圖 Sketch1
 * [重構 P1] 移除對 doc.activeSketchId 的賦值，確立純淨資料模型。
 */
function createInitialDocument(): CADDocument {
  const doc = createEmptyCADDocument();

  const frontPlaneFeature: DatumPlaneFeature = {
    id: "datum-front",
    name: "Front Plane (XY)",
    type: "DATUM_PLANE",
    planeType: "offset",
    referencePlaneId: "",
    referenceFeatureId: "",
    offsetDistance: 0,
    plane: DatumFrontPlane,
    dependencies: [],
    suppressed: false,
    visible: true,
  };

  const topPlaneFeature: DatumPlaneFeature = {
    id: "datum-top",
    name: "Top Plane (XZ)",
    type: "DATUM_PLANE",
    planeType: "offset",
    referencePlaneId: "",
    referenceFeatureId: "",
    offsetDistance: 0,
    plane: DatumTopPlane,
    dependencies: [],
    suppressed: false,
    visible: true,
  };

  const rightPlaneFeature: DatumPlaneFeature = {
    id: "datum-right",
    name: "Right Plane (YZ)",
    type: "DATUM_PLANE",
    planeType: "offset",
    referencePlaneId: "",
    referenceFeatureId: "",
    offsetDistance: 0,
    plane: DatumRightPlane,
    dependencies: [],
    suppressed: false,
    visible: true,
  };

  const initialSketch: SketchFeature = {
    id: "sketch-1",
    name: "Sketch1",
    type: "SKETCH",
    planeFeatureId: "datum-front",
    dependencies: ["datum-front"],
    suppressed: false,
    plane: DatumFrontPlane,
    entities: [],
    constraints: [],
    dimensions: [],
    profiles: [],
    solverState: "UnderDefined",
    visible: true,
  };

  doc.featureTree = [
    frontPlaneFeature,
    topPlaneFeature,
    rightPlaneFeature,
    initialSketch,
  ];
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
    f.id === sketchId ? ({ ...f, isDirty: true } as CADFeature) : f,
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
    viewMode: "2D",
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
    currentTool: "SELECT",
    activeSketchId: "sketch-1",
    selectedEntityIds: [],
    selectedPointIndices: {},
    selectedFeatureId: null,
    selectedFaceInfo: null,
    selectedMeshSelection: null,
    activeLayerId: "0",
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
    polygonMethod: "inscribed",
    lastRadius: 10,

    projectedEntities: [],

    // 草圖編輯 Session 狀態 (解耦 2D 與 3D 運算管線)
    sketchSession: {
      isActive: true,
      sketchId: "sketch-1",
      initialEntities: [],
      initialConstraints: [],
      initialDimensions: [],
      draftEntities: [],
      draftConstraints: [],
      draftDimensions: [],
      initialProfiles: [],
      draftProfiles: [],
      isDirty: false,
      draftUndoStack: [],
      draftRedoStack: [],
    },

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

    toggleShow3DEdges: () =>
      set((state) => {
        state.show3DEdges = !state.show3DEdges;
      }),
    setProjectedEntities: (entities) =>
      set((state) => {
        state.projectedEntities = entities;
      }),
    setExtrudePreview: (preview) =>
      set((state) => {
        state.extrudePreview = preview;
      }),
    setRevolvePreview: (preview) =>
      set((state) => {
        state.revolvePreview = preview;
      }),
    setIsPickingRevolveAxis: (isPicking) =>
      set((state) => {
        state.isPickingRevolveAxis = isPicking;
      }),

    setRevolveAxisEntityId: (axisId) =>
      set((state) => {
        if (state.revolvePreview) state.revolvePreview.axisEntityId = axisId;
      }),
    setLayerModalOpen: (open) =>
      set((state) => {
        state.isLayerModalOpen = open;
      }),
    setOsnapModalOpen: (open) =>
      set((state) => {
        state.isOsnapModalOpen = open;
      }),

    setArrayItems: (items) =>
      set((state) => {
        state.arrayItems = Math.max(2, Math.round(items));
      }),
    setArrayFillAngle: (angle) =>
      set((state) => {
        state.arrayFillAngle = angle;
      }),

    setRectArrayCols: (cols) =>
      set((state) => {
        state.rectArrayCols = Math.max(1, Math.min(100, Math.round(cols)));
      }),
    setRectArrayRows: (rows) =>
      set((state) => {
        state.rectArrayRows = Math.max(1, Math.min(100, Math.round(rows)));
      }),
    setRectArrayColSpacing: (spacing) =>
      set((state) => {
        state.rectArrayColSpacing = spacing;
      }),
    setRectArrayRowSpacing: (spacing) =>
      set((state) => {
        state.rectArrayRowSpacing = spacing;
      }),

    setChamferDistance: (distance) =>
      set((state) => {
        state.chamferDistance = Math.max(0.1, distance);
      }),

    setPolygonSides: (sides) =>
      set((state) => {
        state.polygonSides = Math.max(3, Math.min(1024, Math.round(sides)));
      }),
    setPolygonMethod: (method) =>
      set((state) => {
        state.polygonMethod = method;
      }),

    setLastRadius: (r) =>
      set((state) => {
        state.lastRadius = Math.max(0.1, r);
      }),

    // ------------------------------------------
    // 特徵與歷史邏輯 (Feature & History Actions)
    // ------------------------------------------

    setSelectedFeatureId: (id) =>
      set((state) => {
        state.selectedFeatureId = id || null;
        if (id) {
          const feature = state.document.featureTree.find((f) => f.id === id);
          if (feature && feature.type === "SKETCH") {
            state.activeSketchId = id;
          }
        }
      }),
    addFeature: (feature) =>
      set((state) => {
        const currentRollback = Math.max(
          0,
          Math.min(
            state.document.rollbackIndex,
            state.document.featureTree.length,
          ),
        );

        // 處理 Undo
        const clonedDoc = JSON.parse(JSON.stringify(state.document));
        state.undoStack.push(clonedDoc);
        if (state.undoStack.length > 20) state.undoStack.shift();
        state.redoStack = [];

        const newFeatureWithDirty: CADFeature = { ...feature, isDirty: true };
        state.document.featureTree.splice(
          currentRollback,
          0,
          newFeatureWithDirty,
        );

        state.document.featureTree = markDownstreamDirty(
          state.document.featureTree,
          feature.id,
        );
        state.document.rollbackIndex = currentRollback + 1;

        if (feature.type === "SKETCH") {
          state.activeSketchId = feature.id;
        }
        state.selectedFeatureId = feature.id;
      }),

    removeFeature: (id) =>
      set((state) => {
        const featureIndex = state.document.featureTree.findIndex(
          (f) => f.id === id,
        );
        if (featureIndex === -1) return;

        const removedFeature = state.document.featureTree[featureIndex];
        const filteredTree = state.document.featureTree.filter(
          (f) => f.id !== id,
        );
        const validationMap = validateFeatureDependencies(filteredTree);

        const updatedTree = filteredTree.map((f) => {
          const errs = validationMap.get(f.id);
          if (errs && errs.length > 0) {
            return {
              ...f,
              error: errs.join("; "),
              isDirty: true,
            };
          } else {
            return {
              ...f,
              error:
                f.error && f.error.includes("Missing reference")
                  ? null
                  : f.error,
            };
          }
        });

        let candidateTree = updatedTree;
        if (removedFeature && isBodyModifyingFeature(removedFeature)) {
          candidateTree = candidateTree.map((f, idx) => {
            if (idx >= featureIndex && isBodyModifyingFeature(f)) {
              return { ...f, isDirty: true };
            }
            return f;
          });
        }
        const dirtyTree = markDownstreamDirty(candidateTree, "");

        let newRollbackIndex = state.document.rollbackIndex;
        if (featureIndex < state.document.rollbackIndex) {
          newRollbackIndex = Math.max(0, state.document.rollbackIndex - 1);
        } else {
          newRollbackIndex = Math.min(newRollbackIndex, dirtyTree.length);
        }

        const nextActiveSketchId =
          state.activeSketchId === id
            ? dirtyTree.find((f) => f.type === "SKETCH")?.id || null
            : state.activeSketchId;

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, {
          document: {
            ...state.document,
            featureTree: dirtyTree,
            rollbackIndex: newRollbackIndex,
          },
          selectedFeatureId:
            state.selectedFeatureId === id ? null : state.selectedFeatureId,
          activeSketchId: nextActiveSketchId,
        });
      }),
    updateFeature: (id, updates) =>
      set((state) => {
        const exists = state.document.featureTree.some((f) => f.id === id);
        if (!exists) return;

        const updatedTree = state.document.featureTree.map((f) =>
          f.id === id ? ({ ...f, ...updates, isDirty: true } as CADFeature) : f,
        );

        const dirtyTree = markDownstreamDirty(updatedTree, id);
        const validationMap = validateFeatureDependencies(dirtyTree);

        const finalTree = dirtyTree.map((f) => {
          const errs = validationMap.get(f.id);
          return {
            ...f,
            error: errs && errs.length > 0 ? errs.join("; ") : f.error,
          };
        });

        const targetFeature = finalTree.find((f) => f.id === id);
        const nextActiveSketchId =
          targetFeature && targetFeature.type === "SKETCH"
            ? id
            : state.activeSketchId;

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, {
          activeSketchId: nextActiveSketchId,
          document: {
            ...state.document,
            featureTree: finalTree,
          },
        });
      }),
    toggleFeatureSuppression: (id) =>
      set((state) => {
        const feature = state.document.featureTree.find((f) => f.id === id);
        if (!feature) return;

        const newSuppressed = !feature.suppressed;
        const updatedTree = state.document.featureTree.map((f) =>
          f.id === id ? { ...f, suppressed: newSuppressed, isDirty: true } : f,
        );

        const dirtyTree = markDownstreamDirty(updatedTree, id);

        const nextActiveSketchId =
          feature.type === "SKETCH" &&
          newSuppressed &&
          state.activeSketchId === id
            ? dirtyTree.find((f) => f.type === "SKETCH" && !f.suppressed)?.id ||
              null
            : feature.type === "SKETCH" && !newSuppressed
              ? id
              : state.activeSketchId;

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, {
          activeSketchId: nextActiveSketchId,
          document: {
            ...state.document,
            featureTree: dirtyTree,
          },
        });
      }),
    renameFeature: (id, newName) =>
      set((state) => {
        const trimmed = newName.trim();
        if (!trimmed) return state;
        const feature = state.document.featureTree.find((f) => f.id === id);
        if (!feature || feature.name === trimmed) return state;

        const updatedTree = state.document.featureTree.map((f) =>
          f.id === id ? { ...f, name: trimmed } : f,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        if (
          Object.keys({
            document: {
              ...state.document,
              featureTree: updatedTree,
            },
          }).length > 0
        ) {
          Object.assign(state, {
            document: {
              ...state.document,
              featureTree: updatedTree,
            },
          });
        }
      }),
    reorderFeature: (sourceIndex, targetIndex) =>
      set((state) => {
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
          console.warn(
            "Reordering cancelled: Breaks feature dependency DAG hierarchy.",
          );
          return;
        }

        const movedId = moved.id;
        const dirtyTree = markDownstreamDirty(tree, movedId);

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, {
          document: {
            ...state.document,
            featureTree: dirtyTree,
          },
        });
      }),
    setRollbackIndex: (index) =>
      set((state) => {
        const clamped = Math.max(
          0,
          Math.min(index, state.document.featureTree.length),
        );
        if (state.document.rollbackIndex === clamped) return;

        const activeFeatures = state.document.featureTree.slice(0, clamped);
        let nextActiveSketchId = state.activeSketchId;
        if (nextActiveSketchId) {
          const activeSketchInRollback = activeFeatures.find(
            (f) => f.id === nextActiveSketchId && f.type === "SKETCH",
          );
          if (!activeSketchInRollback) {
            const lastSketch = [...activeFeatures]
              .reverse()
              .find((f) => f.type === "SKETCH");
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

      const regenPlan = getRegenPlan(
        featureTree,
        rollbackIndex,
        cachedFeatureIds,
      );
      const {
        dirtyFeatures,
        brokenDependencies,
        hasCycle,
        cycleNodes,
        dirtyFromHistoryIndex,
        dirtyFromIndex,
        isPureRollback,
      } = regenPlan;

      if (hasCycle) {
        const cycleSet = new Set(cycleNodes);
        const updatedTreeWithCycleErr = featureTree.map((f) => {
          if (cycleSet.has(f.id)) {
            return {
              ...f,
              error: "循環依賴 (Circular Dependency)",
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
            error: `遺失父特徵依賴: ${errs.join(", ")}`,
            isDirty: true,
          };
        }
        return f;
      });

      // Architecture Contract v1:
      // Feature Compiler 將 History Index (dirtyFromHistoryIndex) 編譯為 Operation Index (dirtyOpIndex)
      const historyIndexToUse =
        typeof dirtyFromHistoryIndex === "number"
          ? dirtyFromHistoryIndex
          : dirtyFromIndex;

      const compiledPlan = compileFeaturePlan(
        treeWithErrors,
        rollbackIndex,
        planes || {},
        historyIndexToUse,
        dirtyFeatures[0]?.id,
      );
      const ops = compiledPlan.operations;
      const dirtyOpIndex = compiledPlan.dirtyOpIndex;

      if (!ops || ops.length === 0) {
        const clearedTree = treeWithErrors.map((f) => {
          if (brokenDependencies.has(f.id)) {
            return f;
          }
          return {
            ...f,
            isDirty: false,
            error: f.error?.includes("遺失父特徵依賴") ? f.error : null,
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
        const result = await solidEngine.evaluateFeatureTree(
          ops,
          dirtyOpIndex,
          isPureRollback,
        );

        const diagnostics = result.diagnostics || [];
        const featureErrorMap = new Map<string, string>();

        for (const diag of diagnostics) {
          if (diag.level === "error" && diag.featureId) {
            featureErrorMap.set(diag.featureId, diag.message);
          }
        }

        const isSuccess =
          result.success !== false && featureErrorMap.size === 0;

        if (isSuccess) {
          const opsResults = ops.map((op) => ({
            featureId: op.featureId,
            success: true,
          }));

          const activeDirtyIds = dirtyFeatures.map((f) => f.id);
          for (const dId of activeDirtyIds) {
            if (
              !opsResults.some((r) => r.featureId === dId) &&
              !brokenDependencies.has(dId)
            ) {
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
                error: f.error || "SolidEngine 幾何運算失敗",
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
        if (
          err?.message === "RegenJobCancelled" ||
          err?.name === "AbortError"
        ) {
          // P3: Ignore aborted job, another one is running
          return;
        }
        console.error("regenerateFeatureTree failed:", err);
        const opFeatureIds = new Set(ops.map((op) => op.featureId));
        const errorTree = treeWithErrors.map((f) => {
          if (opFeatureIds.has(f.id)) {
            return {
              ...f,
              isDirty: true,
              error: err?.message || "SolidEngine Worker 執行例外",
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

    addOffsetDatumPlane: (refPlaneId, distance, name) => {
      let retId = "";
      set((state) => {
        const refPlane =
          findCustomPlane(state.document, refPlaneId) || DatumFrontPlane;

        const newFeatureId = `datum-plane-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const planeName =
          name ||
          `${refPlane.name || "Plane"} Offset (${distance >= 0 ? "+" : ""}${distance}mm)`;

        const computedPlane = createOffsetPlane(
          refPlane,
          distance,
          planeName,
          newFeatureId,
        );

        const newFeature: DatumPlaneFeature = {
          id: newFeatureId,
          name: planeName,
          type: "DATUM_PLANE",
          planeType: "offset",
          referencePlaneId: refPlaneId,
          referenceFeatureId: refPlaneId,
          offsetDistance: distance,
          plane: computedPlane,
          dependencies: [refPlaneId],
          suppressed: false,
          visible: true,
        };

        const rollback = Math.max(
          0,
          Math.min(
            state.document.rollbackIndex,
            state.document.featureTree.length,
          ),
        );
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

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, {
          selectedFeatureId: newFeatureId,
          document: updatedDocument,
        });

        retId = newFeatureId;
      });
      return retId;
    },
    updateDatumPlaneOffset: (planeFeatureId, distance) =>
      set((state) => {
        const tree = state.document.featureTree;
        const featureIndex = tree.findIndex(
          (f) => f.id === planeFeatureId && f.type === "DATUM_PLANE",
        );
        if (featureIndex === -1) return;

        const datumFeature = tree[featureIndex] as DatumPlaneFeature;
        const refPlaneId =
          datumFeature.referencePlaneId ||
          datumFeature.referenceFeatureId ||
          "datum-front";
        const refPlane =
          findCustomPlane(state.document, refPlaneId) || DatumFrontPlane;

        const recalculatedPlane = createOffsetPlane(
          refPlane,
          distance,
          datumFeature.name,
          planeFeatureId,
        );

        const updatedTree = tree.map((f) => {
          if (f.id === planeFeatureId && f.type === "DATUM_PLANE") {
            return {
              ...f,
              offsetDistance: distance,
              plane: recalculatedPlane,
              isDirty: true,
            } as DatumPlaneFeature;
          }

          if (f.type === "SKETCH") {
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
            error: errs && errs.length > 0 ? errs.join("; ") : f.error,
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

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, { document: updatedDocument });
      }),
    toggleFeatureVisibility: (featureId) =>
      set((state) => {
        const feature = state.document.featureTree.find(
          (f) => f.id === featureId,
        );
        if (!feature) return state;

        const newVisible = feature.visible === false ? true : false;
        const updatedTree = state.document.featureTree.map((f) =>
          f.id === featureId ? { ...f, visible: newVisible } : f,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        if (
          Object.keys({
            document: {
              ...state.document,
              featureTree: updatedTree,
            },
          }).length > 0
        ) {
          Object.assign(state, {
            document: {
              ...state.document,
              featureTree: updatedTree,
            },
          });
        }
      }),
    createSketchOnPlane: (planeId) => {
      let retId = "";
      set((state) => {
        const targetPlane =
          findCustomPlane(state.document, planeId) || DatumFrontPlane;

        const newSketchId = crypto.randomUUID();
        const sketchCount =
          state.document.featureTree.filter((f) => f.type === "SKETCH").length +
          1;
        const sketchName = `Sketch${sketchCount}`;

        const newSketch: SketchFeature = {
          id: newSketchId,
          name: sketchName,
          type: "SKETCH",
          planeFeatureId: planeId,
          plane: targetPlane,
          dependencies: [planeId],
          entities: [],
          constraints: [],
          dimensions: [],
          profiles: [],
          solverState: "UnderDefined",
          suppressed: false,
          visible: true,
        };

        const rollback = Math.max(
          0,
          Math.min(
            state.document.rollbackIndex,
            state.document.featureTree.length,
          ),
        );
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

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, {
          activeSketchId: newSketchId,
          selectedFeatureId: newSketchId,
          selectedEntityIds: [],
          document: updatedDocument,
          viewMode: "2D",
        });

        retId = newSketchId;
      });
      return retId;
    },
    setSelectedFaceInfo: (face) =>
      set((state) => {
        state.selectedFaceInfo = face;
      }),
    setSelectedMeshSelection: (selection) =>
      set((state) => {
        state.selectedMeshSelection = selection;
      }),

    createSketchOnFacePlane: (plane: CustomPlane) => {
      let retId = "";
      set((state) => {
        const newSketchId = crypto.randomUUID();
        const sketchCount = state.document.featureTree.filter(
          (f) => f.type === "SKETCH",
        ).length;
        const sketchName = `Sketch${sketchCount + 1}`;

        const newSketch: SketchFeature = {
          id: newSketchId,
          name: sketchName,
          type: "SKETCH",
          planeFeatureId: plane.id,
          plane: plane,
          dependencies: [],
          entities: [],
          constraints: [],
          dimensions: [],
          profiles: [],
          solverState: "UnderDefined",
          suppressed: false,
          visible: true,
        };

        const rollback = Math.max(
          0,
          Math.min(
            state.document.rollbackIndex,
            state.document.featureTree.length,
          ),
        );
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

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, {
          activeSketchId: newSketch.id,
          selectedFeatureId: newSketch.id,
          selectedEntityIds: [],
          selectedFaceInfo: null,
          document: updatedDocument,
          viewMode: "2D",
          currentTool: "SELECT",
        });

        if (typeof window !== "undefined") {
          setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent("cad-zoom-to-bbox", {
                detail: {
                  bbox: {
                    min: { x: -60, y: -60 },
                    max: { x: 60, y: 60 },
                  },
                  padding: 80,
                },
              }),
            );
          }, 50);
        }

        retId = newSketchId;
      });
      return retId;
    },
    addExtrudeFeature: (feature) =>
      set((state) => {
        const newFeatureId = "extrude-" + Date.now().toString();
        const newFeature: ExtrudeFeature = {
          ...feature,
          id: newFeatureId,
          type: "EXTRUDE" as const,
          dependencies: feature.sketchId ? [feature.sketchId] : [],
          suppressed: false,
        };

        const currentRollback = Math.max(
          0,
          Math.min(
            state.document.rollbackIndex,
            state.document.featureTree.length,
          ),
        );
        const tree = state.document.featureTree;
        const newFeatureTree = [
          ...tree.slice(0, currentRollback),
          { ...newFeature, isDirty: true } as CADFeature,
          ...tree.slice(currentRollback),
        ];
        const dirtyTree = markDownstreamDirty(newFeatureTree, newFeatureId);

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, {
          selectedFeatureId: newFeature.id,
          document: {
            ...state.document,
            featureTree: dirtyTree,
            rollbackIndex: currentRollback + 1,
          },
        });
      }),
    updateExtrudeFeature: (id, updates) => get().updateFeature(id, updates),

    // ------------------------------------------
    // UI 狀態切換與基本工具 (UI & Tools)
    // ------------------------------------------

    setViewMode: (mode) => set({ viewMode: mode }),
    setTool: (tool) => set({ currentTool: tool }),
    setActiveSketch: (sketchId) => {
      if (sketchId) {
        get().enterSketchSession(sketchId);
      } else {
        get().cancelSketchSession();
        set({ activeSketchId: null });
      }
    },

    enterSketchSession: (sketchId: string) => {
      set((state) => {
        const sketch = state.document.featureTree.find(
          (f) => f.id === sketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        const entitiesClone = JSON.parse(JSON.stringify(sketch.entities || []));
        const constraintsClone = JSON.parse(
          JSON.stringify(sketch.constraints || []),
        );
        const dimensionsClone = JSON.parse(
          JSON.stringify(sketch.dimensions || []),
        );
        const profilesClone = JSON.parse(
          JSON.stringify(sketch.profiles || []),
        );

        state.sketchSession = {
          isActive: true,
          sketchId: sketchId,
          initialEntities: entitiesClone,
          initialConstraints: constraintsClone,
          initialDimensions: dimensionsClone,
          initialProfiles: JSON.parse(JSON.stringify(profilesClone)),
          draftEntities: JSON.parse(JSON.stringify(entitiesClone)),
          draftConstraints: JSON.parse(JSON.stringify(constraintsClone)),
          draftDimensions: JSON.parse(JSON.stringify(dimensionsClone)),
          draftProfiles: JSON.parse(JSON.stringify(profilesClone)),
          isDirty: false,
          draftUndoStack: [],
          draftRedoStack: [],
        };
        state.activeSketchId = sketchId;
        state.viewMode = "2D";
      });
    },

    startSketchSession: (sketchId: string) => {
      get().enterSketchSession(sketchId);
    },

    commitSketchSession: async () => {
      const session = get().sketchSession;
      if (!session.isActive || !session.sketchId) return;

      const targetSketchId = session.sketchId;
      const isDirty = session.isDirty;

      if (isDirty) {
        set((state) => {
          const sketch = state.document.featureTree.find(
            (f) => f.id === targetSketchId && f.type === "SKETCH",
          ) as SketchFeature | undefined;

          if (sketch) {
            sketch.entities = session.draftEntities;
            sketch.constraints = session.draftConstraints;
            sketch.dimensions = session.draftDimensions;
            sketch.profiles = session.draftProfiles;
            applyConstraintsToSketch(sketch);

            const docDirty = markSketchDirtyInDoc(
              state.document,
              targetSketchId,
            );
            const undoState = pushUndoState(get());
            state.undoStack = undoState.undoStack;
            state.redoStack = undoState.redoStack;
            state.document = docDirty;
          }

          state.sketchSession = {
            isActive: false,
            sketchId: null,
            initialEntities: [],
            initialConstraints: [],
            initialDimensions: [],
            draftEntities: [],
            draftConstraints: [],
            draftDimensions: [],
            initialProfiles: [],
            draftProfiles: [],
            isDirty: false,
            draftUndoStack: [],
            draftRedoStack: [],
          };
        });

        await get().regenerateFeatureTree();
      } else {
        set((state) => {
          state.sketchSession = {
            isActive: false,
            sketchId: null,
            initialEntities: [],
            initialConstraints: [],
            initialDimensions: [],
            draftEntities: [],
            draftConstraints: [],
            draftDimensions: [],
            initialProfiles: [],
            draftProfiles: [],
            isDirty: false,
            draftUndoStack: [],
            draftRedoStack: [],
          };
        });
      }
    },

    cancelSketchSession: () => {
      set((state) => {
        state.sketchSession = {
          isActive: false,
          sketchId: null,
          initialEntities: [],
          initialConstraints: [],
          initialDimensions: [],
          draftEntities: [],
          draftConstraints: [],
          draftDimensions: [],
          initialProfiles: [],
          draftProfiles: [],
          isDirty: false,
          draftUndoStack: [],
          draftRedoStack: [],
        };
      });
    },

    setSelectedPointIndex: (id, index) =>
      set((state) => {
        if (index === undefined) {
          const next = { ...state.selectedPointIndices };
          delete next[id];
          return { selectedPointIndices: next };
        }
        return {
          selectedPointIndices: {
            ...state.selectedPointIndices,
            [id]: index,
          },
        };
      }),
    selectEntity: (id, pointIndex) =>
      set((state) => {
        const nextIds = state.selectedEntityIds.includes(id)
          ? state.selectedEntityIds
          : [...state.selectedEntityIds, id];
        const nextIndices = { ...state.selectedPointIndices };
        if (pointIndex !== undefined) {
          nextIndices[id] = pointIndex;
        }
        return { selectedEntityIds: nextIds, selectedPointIndices: nextIndices };
      }),
    setSelectedEntityIds: (ids) => set({ selectedEntityIds: ids }),
    clearSelection: () =>
      set({ selectedEntityIds: [], selectedPointIndices: {}, selectedFeatureId: null }),
    setActiveLayer: (layerId: string) => set({ activeLayerId: layerId }),

    // ------------------------------------------
    // 圖層操作 (Layers)
    // ------------------------------------------

    addLayer: (layer: CADLayer) =>
      set((state) => {
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
        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        if (Object.keys({ document: updatedDocument }).length > 0) {
          Object.assign(state, { document: updatedDocument });
        }
      }),
    removeLayer: (layerId: string) =>
      set((state) => {
        if (layerId === "0" || layerId.toUpperCase() === "DEFPOINTS") {
          return state;
        }
        if (!state.document.layers[layerId]) {
          return state;
        }

        const { [layerId]: _removed, ...remainingLayers } =
          state.document.layers;
        const newActiveLayerId =
          state.activeLayerId === layerId ? "0" : state.activeLayerId;

        const updatedFeatureTree = state.document.featureTree.map((feature) => {
          if (feature.type === "SKETCH") {
            const sketch = feature as SketchFeature;
            const hasEntitiesInLayer = sketch.entities.some(
              (e) => e.layerId === layerId,
            );
            if (hasEntitiesInLayer) {
              const updatedEntities = sketch.entities.map((e) =>
                e.layerId === layerId ? { ...e, layerId: "0" } : e,
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

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        if (
          Object.keys({
            document: updatedDocument,
            activeLayerId: newActiveLayerId,
          }).length > 0
        ) {
          Object.assign(state, {
            document: updatedDocument,
            activeLayerId: newActiveLayerId,
          });
        }
      }),
    renameLayer: (layerId: string, newName: string) =>
      set((state) => {
        const trimmed = newName.trim();
        if (!trimmed) return state;
        if (layerId === "0" || layerId.toUpperCase() === "DEFPOINTS")
          return state;
        const existingLayer = state.document.layers[layerId];
        if (!existingLayer) return state;
        if (existingLayer.name === trimmed) return state;

        const nameExists = Object.values(state.document.layers).some(
          (l) =>
            l.id !== layerId && l.name.toLowerCase() === trimmed.toLowerCase(),
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

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        if (Object.keys({ document: updatedDocument }).length > 0) {
          Object.assign(state, { document: updatedDocument });
        }
      }),
    updateLayer: (layerId: string, updates: Partial<CADLayer>) =>
      set((state) => {
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

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        if (Object.keys({ document: updatedDocument }).length > 0) {
          Object.assign(state, { document: updatedDocument });
        }
      }),
    toggleLayerVisibility: (layerId: string) =>
      set((state) => {
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

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        if (Object.keys({ document: updatedDocument }).length > 0) {
          Object.assign(state, { document: updatedDocument });
        }
      }),
    toggleLayerLock: (layerId: string) =>
      set((state) => {
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

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        if (Object.keys({ document: updatedDocument }).length > 0) {
          Object.assign(state, { document: updatedDocument });
        }
      }),
    // ------------------------------------------
    // 2D 編輯與繪圖邏輯 (2D Operations)
    // ------------------------------------------

    addEntity: (sketchIdOrEntity: any, entity?: any) => {
      let isSessionEdit = false;
      set((state) => {
        const targetSketchId =
          typeof sketchIdOrEntity === "string"
            ? sketchIdOrEntity
            : state.activeSketchId;
        const actualEntity =
          typeof sketchIdOrEntity === "string" ? entity : sketchIdOrEntity;
        if (!targetSketchId || !actualEntity) return;

        const activeLayer = state.activeLayerId || "0";
        const targetLayerId =
          !actualEntity.layerId ||
          actualEntity.layerId === "0" ||
          actualEntity.layerId === "layer-0"
            ? activeLayer
            : actualEntity.layerId;

        const newEntity: CADEntity2D = {
          ...actualEntity,
          layerId: targetLayerId,
          isConstruction:
            actualEntity.isConstruction ?? targetLayerId === "CONSTRUCTION",
        };

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === targetSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const dummySketch: SketchFeature = {
            id: targetSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities, newEntity],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyConstraintsToSketch(dummySketch);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          return;
        }

        insertEntityIntoSketch(state.document, targetSketchId, newEntity);
        const docDirty = markSketchDirtyInDoc(state.document, targetSketchId);

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, { document: docDirty });
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },
    importDxfData: (entities, layers) => {
      let isSessionEdit = false;
      set((state) => {
        if (!entities || entities.length === 0 || !state.activeSketchId) {
          return;
        }

        const preparedEntities: CADEntity2D[] = entities.map((e) => ({
          ...e,
          state: "UnderDefined",
        }));

        if (layers) {
          const mergedLayers = { ...state.document.layers };
          for (const [key, layer] of Object.entries(layers)) {
            if (!mergedLayers[key]) {
              mergedLayers[key] = layer;
            }
          }
          state.document.layers = mergedLayers;
        }

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [
              ...state.sketchSession.draftEntities,
              ...preparedEntities,
            ],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyConstraintsToSketch(dummySketch);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          state.selectedEntityIds = [];
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        const updatedSketch: SketchFeature = {
          ...sketch,
          entities: [...sketch.entities, ...preparedEntities],
        };
        applyConstraintsToSketch(updatedSketch);

        const updatedDocument: CADDocument = {
          ...state.document,
          featureTree: state.document.featureTree.map((f) =>
            f.id === state.activeSketchId ? updatedSketch : f,
          ),
        };

        const docDirty = markSketchDirtyInDoc(
          updatedDocument,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, { document: docDirty, selectedEntityIds: [] });
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },
    importEntities: (entities) => get().importDxfData(entities, {}),

    removeEntity: (id) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: state.sketchSession.draftEntities.filter(
              (e) => e.id !== id,
            ),
            constraints: state.sketchSession.draftConstraints.filter(
              (c) => !c.entityIds.includes(id),
            ),
            dimensions: state.sketchSession.draftDimensions.filter(
              (d) => !(d.entityIds && d.entityIds.includes(id)),
            ),
            profiles: [],
            solverState: "UnderDefined",
          };
          applyConstraintsToSketch(dummySketch);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          state.selectedEntityIds = state.selectedEntityIds.filter(
            (entityId) => entityId !== id,
          );
          return;
        }

        removeEntityFromSketch(state.document, state.activeSketchId, id);
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
        state.selectedEntityIds = state.selectedEntityIds.filter(
          (entityId) => entityId !== id,
        );
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    updateEntity: (id, updates, recordUndo = true) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          if (recordUndo) {
            pushSketchUndoState(state);
          }
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: state.sketchSession.draftEntities.map((e) =>
              e.id === id ? ({ ...e, ...updates } as CADEntity2D) : e,
            ),
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyConstraintsToSketch(dummySketch);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        const existingEntity = sketch.entities.find((e) => e.id === id);
        if (!existingEntity) return;

        const updatedEntity = { ...existingEntity, ...updates } as CADEntity2D;

        updateEntityInSketch(
          state.document,
          state.activeSketchId,
          updatedEntity,
        );
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        if (recordUndo) {
          const undoState = pushUndoState(get());
          state.undoStack = undoState.undoStack;
          state.redoStack = undoState.redoStack;
        }
        state.document = docDirty;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    updateEntities: (newEntities, recordUndo = true) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId || !newEntities || newEntities.length === 0) {
          return;
        }

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          if (recordUndo) {
            pushSketchUndoState(state);
          }
          const entityMap = new Map(newEntities.map((e) => [e.id, e]));
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: state.sketchSession.draftEntities.map(
              (e) => entityMap.get(e.id) || e,
            ),
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyConstraintsToSketch(dummySketch);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        const entityMap = new Map(newEntities.map((e) => [e.id, e]));
        sketch.entities = sketch.entities.map((e) => entityMap.get(e.id) || e);
        applyConstraintsToSketch(sketch);

        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        if (recordUndo) {
          const undoState = pushUndoState(get());
          state.undoStack = undoState.undoStack;
          state.redoStack = undoState.redoStack;
        }
        state.document = docDirty;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    toggleConstruction: (entityId: string) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const existing = state.sketchSession.draftEntities.find(
            (e) => e.id === entityId,
          );
          if (existing) {
            existing.isConstruction = !existing.isConstruction;
            state.sketchSession.isDirty = true;
          }
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        const existingEntity = sketch.entities.find((e) => e.id === entityId);
        if (!existingEntity) return;

        const updatedEntity = {
          ...existingEntity,
          isConstruction: !existingEntity.isConstruction,
        } as CADEntity2D;

        updateEntityInSketch(
          state.document,
          state.activeSketchId,
          updatedEntity,
        );
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    addConstraint: (constraint) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: [...state.sketchSession.draftConstraints, constraint],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyConstraintsToSketch(dummySketch);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          return;
        }

        addConstraintToSketch(state.document, state.activeSketchId, constraint);
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    addDimension: (dimension, constraint) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        let actualConstraint = { ...constraint };
        if (dimension.type === "linear") {
          const p1 = dimension.points[0];
          const p2 = dimension.points[1];
          if (p1 && p2) {
            if (dimension.dimType === "horizontal") {
              actualConstraint.type = "distance_x";
              actualConstraint.value = Math.abs(p2.x - p1.x);
            } else if (dimension.dimType === "vertical") {
              actualConstraint.type = "distance_y";
              actualConstraint.value = Math.abs(p2.y - p1.y);
            } else if (dimension.dimType === "aligned") {
              if (
                actualConstraint.type !== "length" &&
                actualConstraint.type !== "distance"
              ) {
                actualConstraint.type =
                  actualConstraint.entityIds.length === 1
                    ? "length"
                    : "distance";
              }
              actualConstraint.value = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            }
          }
        }

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const referencedProjEntities = (actualConstraint.entityIds || [])
            .map((id) => state.projectedEntities.find((p) => p.id === id))
            .filter(Boolean) as CADEntity2D[];

          let initialEntities = [...state.sketchSession.draftEntities];
          for (const pEnt of referencedProjEntities) {
            if (!initialEntities.some((e) => e.id === pEnt.id)) {
              initialEntities.push({
                ...pEnt,
                isProjected: true,
                isConstruction: true,
                state: "FullyDefined",
                color: "#f59e0b",
              });
            }
          }

          const testConstraints = [
            ...state.sketchSession.draftConstraints,
            actualConstraint,
          ];
          const solverResult = solveConstraints(
            initialEntities,
            testConstraints,
          );
          const dofState = analyzeSketchDOF(
            solverResult.entities,
            testConstraints,
          );

          let finalDimension = dimension;
          if (dofState.state === "OverDefined") {
            finalDimension = {
              ...dimension,
              isReference: true,
              constraintId: undefined,
              entityIds: actualConstraint.entityIds,
              pointIndices: actualConstraint.pointIndices,
            };
            state.sketchSession.draftDimensions.push(finalDimension);
          } else {
            finalDimension = {
              ...dimension,
              entityIds: actualConstraint.entityIds,
              pointIndices: actualConstraint.pointIndices,
            };
            state.sketchSession.draftDimensions.push(finalDimension);
            state.sketchSession.draftConstraints.push(actualConstraint);
          }

          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: initialEntities,
            constraints: state.sketchSession.draftConstraints,
            dimensions: state.sketchSession.draftDimensions,
            profiles: [],
            solverState: "UnderDefined",
          };
          applyConstraintsToSketch(dummySketch);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

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
              state: "FullyDefined",
              color: "#f59e0b",
            });
          }
        }

        let currentDoc = state.document;
        if (initialEntities.length > sketch.entities.length) {
          currentDoc = {
            ...state.document,
            featureTree: state.document.featureTree.map((f) => {
              if (f.id === state.activeSketchId && f.type === "SKETCH") {
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
        const dofState = analyzeSketchDOF(
          solverResult.entities,
          testConstraints,
        );

        let finalDimension = dimension;
        let newDocument = currentDoc;

        if (dofState.state === "OverDefined") {
          finalDimension = {
            ...dimension,
            isReference: true,
            constraintId: undefined,
            entityIds: actualConstraint.entityIds,
            pointIndices: actualConstraint.pointIndices,
          };

          newDocument = {
            ...currentDoc,
            featureTree: currentDoc.featureTree.map((f) => {
              if (f.id === state.activeSketchId && f.type === "SKETCH") {
                return {
                  ...f,
                  dimensions: [
                    ...((f as SketchFeature).dimensions || []),
                    finalDimension,
                  ],
                };
              }
              return f;
            }),
          };
        } else {
          finalDimension = {
            ...dimension,
            entityIds: actualConstraint.entityIds,
            pointIndices: actualConstraint.pointIndices,
          };
          addDimensionToSketch(
            currentDoc,
            state.activeSketchId,
            finalDimension,
            actualConstraint,
          );
          newDocument = currentDoc;
        }

        const docDirty = markSketchDirtyInDoc(
          newDocument,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, { document: docDirty });
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },
    updateDimensionPosition: (dimensionId, newPosition) =>
      set((state) => {
        if (!state.activeSketchId) return state;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          state.sketchSession.draftDimensions =
            state.sketchSession.draftDimensions.map((dim) =>
              dim.id === dimensionId
                ? { ...dim, textPosition: newPosition }
                : dim,
            );
          state.sketchSession.isDirty = true;
          return;
        }

        const updatedDocument: CADDocument = {
          ...state.document,
          featureTree: state.document.featureTree.map((f) => {
            if (f.id === state.activeSketchId && f.type === "SKETCH") {
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

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        if (Object.keys({ document: updatedDocument }).length > 0) {
          Object.assign(state, { document: updatedDocument });
        }
      }),
    updateDimensionPositionLive: (dimensionId, newPosition) =>
      set((state) => {
        if (!state.activeSketchId) return state;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          state.sketchSession.draftDimensions =
            state.sketchSession.draftDimensions.map((dim) =>
              dim.id === dimensionId
                ? { ...dim, textPosition: newPosition }
                : dim,
            );
          return;
        }

        const updatedDocument: CADDocument = {
          ...state.document,
          featureTree: state.document.featureTree.map((f) => {
            if (f.id === state.activeSketchId && f.type === "SKETCH") {
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
    removeConstraint: (constraintId) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: state.sketchSession.draftConstraints.filter(
              (c) => c.id !== constraintId,
            ),
            dimensions: state.sketchSession.draftDimensions.map((d) =>
              d.constraintId === constraintId
                ? { ...d, constraintId: undefined }
                : d,
            ),
            profiles: [],
            solverState: "UnderDefined",
          };
          applyConstraintsToSketch(dummySketch);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          return;
        }

        removeConstraintFromSketch(
          state.document,
          state.activeSketchId,
          constraintId,
        );
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    removeDimension: (dimensionId) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const targetDim = state.sketchSession.draftDimensions.find(
            (d) => d.id === dimensionId,
          );
          const linkedConstraintId = targetDim?.constraintId;
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: linkedConstraintId
              ? state.sketchSession.draftConstraints.filter(
                  (c) => c.id !== linkedConstraintId,
                )
              : state.sketchSession.draftConstraints,
            dimensions: state.sketchSession.draftDimensions.filter(
              (d) => d.id !== dimensionId,
            ),
            profiles: [],
            solverState: "UnderDefined",
          };
          applyConstraintsToSketch(dummySketch);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          state.selectedEntityIds = state.selectedEntityIds.filter(
            (id) => id !== dimensionId,
          );
          return;
        }

        removeDimensionFromSketch(
          state.document,
          state.activeSketchId,
          dimensionId,
        );
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
        state.selectedEntityIds = state.selectedEntityIds.filter(
          (id) => id !== dimensionId,
        );
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    updateConstraintValue: (constraintId, value) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const linkedDim = state.sketchSession.draftDimensions.find(
            (d) => d.constraintId === constraintId,
          );
          const isDiameter = linkedDim ? !!linkedDim.isDiameter : false;
          const finalConstraintValue =
            linkedDim && linkedDim.type === "radial"
              ? isDiameter
                ? value / 2
                : value
              : value;

          const updatedConstraints = state.sketchSession.draftConstraints.map(
            (c) => {
              if (c.id === constraintId) {
                return {
                  ...c,
                  value: finalConstraintValue,
                  targetVal: Math.abs(finalConstraintValue),
                };
              }
              return c;
            },
          );

          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: updatedConstraints,
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyConstraintsToSketch(dummySketch);

          if (dummySketch.dimensions) {
            dummySketch.dimensions = dummySketch.dimensions.map((dim) => {
              if (dim.constraintId === constraintId) {
                const constraint = updatedConstraints.find(
                  (c) => c.id === constraintId,
                );
                if (constraint) {
                  if (dim.type === "radial") {
                    if (constraint.entityIds.length === 1) {
                      const entity = dummySketch.entities.find(
                        (e) => e.id === constraint.entityIds[0],
                      );
                      if (
                        entity &&
                        (entity.type === "circle" || entity.type === "arc")
                      ) {
                        const center = { ...entity.center };
                        const origP0 = dim.points[0];
                        const origP1 = dim.points[1] || {
                          x: origP0.x + 10,
                          y: origP0.y,
                        };
                        const dx = origP1.x - origP0.x;
                        const dy = origP1.y - origP0.y;
                        const len = Math.hypot(dx, dy);
                        const dir =
                          len > 1e-6
                            ? { x: dx / len, y: dy / len }
                            : { x: 1, y: 0 };
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
                  } else if (dim.type === "linear") {
                    if (constraint.entityIds.length === 1) {
                      const entity = dummySketch.entities.find(
                        (e) => e.id === constraint.entityIds[0],
                      );
                      if (entity && entity.type === "line") {
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
                      const getPointById = (
                        id: string,
                        index: number,
                      ): Point2D | null => {
                        if (id === 'origin' || id === 'ORIGIN' || id === '__ORIGIN__') {
                          return { x: 0, y: 0 };
                        }
                        const entity = dummySketch.entities.find((e) => e.id === id);
                        if (!entity) return null;
                        if (entity.type === "line") {
                          return index === 1 ? entity.end : entity.start;
                        } else if (
                          entity.type === "circle" ||
                          entity.type === "arc"
                        ) {
                          return entity.center;
                        } else if (entity.type === "polyline") {
                          return entity.points[index] || entity.points[0];
                        }
                        return null;
                      };
                      const pt1 = getPointById(id1, idx1);
                      const pt2 = getPointById(id2, idx2);
                      if (pt1 && pt2) {
                        return {
                          ...dim,
                          points: [{ ...pt1 }, { ...pt2 }],
                        };
                      }
                    }
                  }
                }
              }
              return dim;
            });
          }

          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        const linkedDim = sketch.dimensions?.find(
          (d) => d.constraintId === constraintId,
        );
        const isDiameter = linkedDim ? !!linkedDim.isDiameter : false;

        const finalConstraintValue =
          linkedDim && linkedDim.type === "radial"
            ? isDiameter
              ? value / 2
              : value
            : value;

        const updatedConstraints = sketch.constraints.map((c) => {
          if (c.id === constraintId) {
            return {
              ...c,
              value: finalConstraintValue,
              targetVal: Math.abs(finalConstraintValue),
            };
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
              const constraint = updatedConstraints.find(
                (c) => c.id === constraintId,
              );
              if (constraint) {
                if (dim.type === "radial") {
                  if (constraint.entityIds.length === 1) {
                    const entity = updatedSketch.entities.find(
                      (e) => e.id === constraint.entityIds[0],
                    );
                    if (
                      entity &&
                      (entity.type === "circle" || entity.type === "arc")
                    ) {
                      const center = { ...entity.center };
                      const origP0 = dim.points[0];
                      const origP1 = dim.points[1] || {
                        x: origP0.x + 10,
                        y: origP0.y,
                      };
                      const dx = origP1.x - origP0.x;
                      const dy = origP1.y - origP0.y;
                      const len = Math.hypot(dx, dy);
                      const dir =
                        len > 1e-6
                          ? { x: dx / len, y: dy / len }
                          : { x: 1, y: 0 };
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
                } else if (dim.type === "linear") {
                  if (constraint.entityIds.length === 1) {
                    const entity = updatedSketch.entities.find(
                      (e) => e.id === constraint.entityIds[0],
                    );
                    if (entity && entity.type === "line") {
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
                    const getPointById = (
                      id: string,
                      index: number,
                    ): Point2D | null => {
                      if (id === 'origin' || id === 'ORIGIN' || id === '__ORIGIN__') {
                        return { x: 0, y: 0 };
                      }
                      const entity = updatedSketch.entities.find((e) => e.id === id);
                      if (!entity) return null;
                      if (entity.type === "line") {
                        return index === 1 ? entity.end : entity.start;
                      } else if (
                        entity.type === "circle" ||
                        entity.type === "arc"
                      ) {
                        return entity.center;
                      } else if (entity.type === "polyline") {
                        return entity.points[index] || entity.points[0];
                      }
                      return null;
                    };
                    const pt1 = getPointById(id1, idx1);
                    const pt2 = getPointById(id2, idx2);
                    if (pt1 && pt2) {
                      return {
                        ...dim,
                        points: [{ ...pt1 }, { ...pt2 }],
                      };
                    }
                  }
                } else if (dim.type === "angular") {
                  if (constraint.entityIds.length >= 2) {
                    const id1 = constraint.entityIds[0];
                    const id2 = constraint.entityIds[1];
                    const e1 = updatedSketch.entities.find((e) => e.id === id1);
                    const e2 = updatedSketch.entities.find((e) => e.id === id2);
                    if (e1 && e2 && e1.type === "line" && e2.type === "line") {
                      return {
                        ...dim,
                        points: [
                          { ...e1.start },
                          { ...e1.end },
                          { ...e2.start },
                          { ...e2.end },
                        ],
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
            f.id === state.activeSketchId ? updatedSketch : f,
          ),
        };

        const docDirty = markSketchDirtyInDoc(
          updatedDocument,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, { document: docDirty });
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },
    updateDimensionValue: (dimensionId, newValue) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;
        const safeValue = Math.abs(newValue);
        if (isNaN(safeValue) || safeValue <= 0) return;

        const isSession =
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId;
        isSessionEdit = isSession;
        if (isSession) {
          pushSketchUndoState(state);
        }

        const currentEntities = isSession
          ? state.sketchSession.draftEntities
          : (
              state.document.featureTree.find(
                (f) => f.id === state.activeSketchId && f.type === "SKETCH",
              ) as SketchFeature | undefined
            )?.entities;

        const currentConstraints = isSession
          ? state.sketchSession.draftConstraints
          : (
              state.document.featureTree.find(
                (f) => f.id === state.activeSketchId && f.type === "SKETCH",
              ) as SketchFeature | undefined
            )?.constraints;

        const currentDimensions = isSession
          ? state.sketchSession.draftDimensions
          : (
              state.document.featureTree.find(
                (f) => f.id === state.activeSketchId && f.type === "SKETCH",
              ) as SketchFeature | undefined
            )?.dimensions;

        if (!currentEntities || !currentConstraints) return;

        const targetDim = currentDimensions?.find((d) => d.id === dimensionId);
        if (!targetDim) return;

        let targetConstraintId = targetDim.constraintId;
        let targetConstraint = targetConstraintId
          ? currentConstraints.find((c) => c.id === targetConstraintId)
          : undefined;

        if (
          !targetConstraint &&
          targetDim.entityIds &&
          targetDim.entityIds.length > 0
        ) {
          targetConstraint = currentConstraints.find((c) => {
            if (targetDim.entityIds?.length === 1 && c.entityIds.length === 1) {
              return c.entityIds[0] === targetDim.entityIds[0];
            }
            if (targetDim.entityIds?.length === 2 && c.entityIds.length === 2) {
              return (
                (c.entityIds[0] === targetDim.entityIds[0] &&
                  c.entityIds[1] === targetDim.entityIds[1]) ||
                (c.entityIds[0] === targetDim.entityIds[1] &&
                  c.entityIds[1] === targetDim.entityIds[0])
              );
            }
            return false;
          });
          if (targetConstraint) {
            targetConstraintId = targetConstraint.id;
          }
        }

        const isDiameter = !!targetDim.isDiameter;
        const finalConstraintVal =
          targetDim.type === "radial" && isDiameter ? safeValue / 2 : safeValue;

        let updatedConstraints: Constraint[];

        if (targetConstraint) {
          updatedConstraints = currentConstraints.map((c) => {
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
          let cType: ConstraintType = "distance";
          if (targetDim.type === "radial") {
            cType = "radius";
          } else if (targetDim.type === "angular") {
            cType = "angle";
          } else if (targetDim.type === "linear") {
            if (targetDim.dimType === "horizontal") cType = "distance_x";
            else if (targetDim.dimType === "vertical") cType = "distance_y";
            else
              cType =
                targetDim.entityIds && targetDim.entityIds.length === 1
                  ? "length"
                  : "distance";
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
          updatedConstraints = [...currentConstraints, newConstraint];
        }

        const allConstraintEntityIds = [
          ...(targetDim.entityIds || []),
          ...(targetConstraint?.entityIds || []),
          ...updatedConstraints.flatMap((c) => c.entityIds || []),
        ];
        const referencedProjEntities = allConstraintEntityIds
          .map((id) => state.projectedEntities.find((p) => p.id === id))
          .filter(Boolean) as CADEntity2D[];

        let workingSketchEntities = [...currentEntities];
        for (const pEnt of referencedProjEntities) {
          if (!workingSketchEntities.some((e) => e.id === pEnt.id)) {
            workingSketchEntities.push({
              ...pEnt,
              isProjected: true,
              isConstruction: true,
              state: "FullyDefined",
              color: "#f59e0b",
            });
          }
        }

        const updatedSketchTemp: SketchFeature = {
          id: state.activeSketchId,
          name: "Sketch",
          type: "SKETCH",
          plane: DatumFrontPlane,
          dependencies: [],
          suppressed: false,
          entities: workingSketchEntities,
          constraints: updatedConstraints,
          dimensions: currentDimensions || [],
          profiles: [],
          solverState: "UnderDefined",
        };
        applyConstraintsToSketch(updatedSketchTemp);

        const updatedEntities = updatedSketchTemp.entities;

        const getEntityPoint = (
          entity: CADEntity2D | { id: string; type: string },
          index: number,
        ) => {
          if (entity.id === "origin") return { x: 0, y: 0 };
          const e = entity as CADEntity2D;
          if (e.type === "line") {
            return index === 1 ? e.end : e.start;
          } else if (e.type === "circle" || e.type === "arc") {
            return e.center;
          } else if (e.type === "polyline") {
            return e.points[index] || e.points[0];
          }
          return null;
        };

        const updatedDimensions = (currentDimensions || []).map((dim) => {
          const isTarget = dim.id === dimensionId;
          const currentCId =
            dim.constraintId || (isTarget ? targetConstraintId : undefined);
          const linkedConstraint = updatedConstraints.find(
            (c) => c.id === currentCId,
          );
          const eIds = linkedConstraint?.entityIds || dim.entityIds;
          const pIndices = linkedConstraint?.pointIndices || dim.pointIndices;

          if (dim.type === "radial") {
            if (eIds && eIds.length === 1) {
              const entity =
                updatedEntities.find((e) => e.id === eIds[0]) ||
                state.projectedEntities.find((p) => p.id === eIds[0]);
              if (
                entity &&
                (entity.type === "circle" || entity.type === "arc")
              ) {
                const center = { ...entity.center };
                const origP0 = dim.points[0] || center;
                const origP1 = dim.points[1] || {
                  x: origP0.x + 10,
                  y: origP0.y,
                };
                const dx = origP1.x - origP0.x;
                const dy = origP1.y - origP0.y;
                const len = Math.hypot(dx, dy);
                const dir =
                  len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
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
          } else if (dim.type === "linear") {
            if (eIds) {
              if (eIds.length === 1) {
                const entity =
                  updatedEntities.find((e) => e.id === eIds[0]) ||
                  state.projectedEntities.find((p) => p.id === eIds[0]);
                if (entity && entity.type === "line") {
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
                const e1 =
                  id1 === "origin"
                    ? { id: "origin", type: "point" }
                    : updatedEntities.find((e) => e.id === id1) ||
                      state.projectedEntities.find((p) => p.id === id1);
                const e2 =
                  id2 === "origin"
                    ? { id: "origin", type: "point" }
                    : updatedEntities.find((e) => e.id === id2) ||
                      state.projectedEntities.find((p) => p.id === id2);
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
          } else if (dim.type === "angular") {
            if (eIds && eIds.length >= 2) {
              const id1 = eIds[0];
              const id2 = eIds[1];
              const e1 =
                updatedEntities.find((e) => e.id === id1) ||
                state.projectedEntities.find((p) => p.id === id1);
              const e2 =
                updatedEntities.find((e) => e.id === id2) ||
                state.projectedEntities.find((p) => p.id === id2);
              if (e1 && e2 && e1.type === "line" && e2.type === "line") {
                return {
                  ...dim,
                  constraintId: currentCId,
                  points: [
                    { ...e1.start },
                    { ...e1.end },
                    { ...e2.start },
                    { ...e2.end },
                  ],
                };
              }
            }
          }

          return {
            ...dim,
            constraintId: currentCId,
          };
        });

        if (isSession) {
          state.sketchSession.draftEntities = updatedEntities;
          state.sketchSession.draftConstraints = updatedConstraints;
          state.sketchSession.draftDimensions = updatedDimensions;
          state.sketchSession.isDirty = true;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        const updatedSketch: SketchFeature = {
          ...sketch,
          entities: updatedEntities,
          constraints: updatedConstraints,
          dimensions: updatedDimensions,
        };

        const updatedDocument: CADDocument = {
          ...state.document,
          featureTree: state.document.featureTree.map((f) =>
            f.id === state.activeSketchId ? updatedSketch : f,
          ),
        };

        const docDirty = markSketchDirtyInDoc(
          updatedDocument,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, { document: docDirty });
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },
    dragVertexStart: () =>
      set((state) => {
        if (state.sketchSession.isActive) {
          pushSketchUndoState(state);
          return;
        }
        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
      }),
    dragVertexLive: (entityId, pointIndex, newPos) =>
      set((state) => {
        if (!state.activeSketchId) return state;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          const existingEntity = state.sketchSession.draftEntities.find(
            (e) => e.id === entityId,
          );
          if (!existingEntity) return state;

          const updatedEntity = JSON.parse(
            JSON.stringify(existingEntity),
          ) as CADEntity2D;

          if (updatedEntity.type === "line") {
            if (pointIndex === 0) updatedEntity.start = newPos;
            else if (pointIndex === 1) updatedEntity.end = newPos;
          } else if (updatedEntity.type === "circle") {
            if (pointIndex === 0) {
              updatedEntity.center = newPos;
            } else if (pointIndex === 1) {
              updatedEntity.radius = Math.hypot(
                newPos.x - updatedEntity.center.x,
                newPos.y - updatedEntity.center.y,
              );
            }
          } else if (updatedEntity.type === "arc") {
            if (pointIndex === 0) {
              updatedEntity.center = newPos;
            } else if (pointIndex === 1) {
              const dx = newPos.x - updatedEntity.center.x;
              const dy = newPos.y - updatedEntity.center.y;
              updatedEntity.startAngle = Math.atan2(dy, dx);
              updatedEntity.radius = Math.hypot(dx, dy);
            } else if (pointIndex === 2) {
              const dx = newPos.x - updatedEntity.center.x;
              const dy = newPos.y - updatedEntity.center.y;
              updatedEntity.endAngle = Math.atan2(dy, dx);
              updatedEntity.radius = Math.hypot(dx, dy);
            }
          } else if (updatedEntity.type === "polyline") {
            if (updatedEntity.points[pointIndex]) {
              updatedEntity.points[pointIndex] = newPos;
            }
          }

          const newEntities = state.sketchSession.draftEntities.map((e) =>
            e.id === entityId ? updatedEntity : e,
          );

          const tempFixConstraint = {
            id: "temp-drag-fix",
            type: "fix" as const,
            entityIds: [entityId],
            pointIndices: [pointIndex],
          };

          const solvedTempSketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: newEntities,
            constraints: [
              ...state.sketchSession.draftConstraints,
              tempFixConstraint,
            ],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyConstraintsToSketch(solvedTempSketch);
          state.sketchSession.draftEntities = solvedTempSketch.entities;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return state;

        const existingEntity = sketch.entities.find((e) => e.id === entityId);
        if (!existingEntity) return state;

        const updatedEntity = JSON.parse(
          JSON.stringify(existingEntity),
        ) as CADEntity2D;

        if (updatedEntity.type === "line") {
          if (pointIndex === 0) updatedEntity.start = newPos;
          else if (pointIndex === 1) updatedEntity.end = newPos;
        } else if (updatedEntity.type === "circle") {
          if (pointIndex === 0) {
            updatedEntity.center = newPos;
          } else if (pointIndex === 1) {
            updatedEntity.radius = Math.hypot(
              newPos.x - updatedEntity.center.x,
              newPos.y - updatedEntity.center.y,
            );
          }
        } else if (updatedEntity.type === "arc") {
          if (pointIndex === 0) {
            updatedEntity.center = newPos;
          } else if (pointIndex === 1) {
            const dx = newPos.x - updatedEntity.center.x;
            const dy = newPos.y - updatedEntity.center.y;
            updatedEntity.startAngle = Math.atan2(dy, dx);
            updatedEntity.radius = Math.hypot(dx, dy);
          } else if (pointIndex === 2) {
            const dx = newPos.x - updatedEntity.center.x;
            const dy = newPos.y - updatedEntity.center.y;
            updatedEntity.endAngle = Math.atan2(dy, dx);
            updatedEntity.radius = Math.hypot(dx, dy);
          }
        } else if (updatedEntity.type === "polyline") {
          if (updatedEntity.points[pointIndex]) {
            updatedEntity.points[pointIndex] = newPos;
          }
        }

        const newEntities = sketch.entities.map((e) =>
          e.id === entityId ? updatedEntity : e,
        );

        const tempFixConstraint = {
          id: "temp-drag-fix",
          type: "fix" as const,
          entityIds: [entityId],
          pointIndices: [pointIndex],
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
          featureTree: state.document.featureTree.map((f) =>
            f.id === state.activeSketchId ? solvedTempSketch : f,
          ),
        };

        return { document: updatedDocument };
      }),
    dragVertexCommit: () =>
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyConstraintsToSketch(dummySketch);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.isDirty = true;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        const finalSketch: SketchFeature = { ...sketch };
        applyConstraintsToSketch(finalSketch);

        const updatedDocument: CADDocument = {
          ...state.document,
          featureTree: state.document.featureTree.map((f) =>
            f.id === state.activeSketchId ? finalSketch : f,
          ),
        };

        const docDirty = markSketchDirtyInDoc(
          updatedDocument,
          state.activeSketchId,
        );

        set({
          document: docDirty,
        });
      }),
    trimEntity: (entityId, clickPoint) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          const trimResult = executeTrim(
            entityId,
            clickPoint,
            state.sketchSession.draftEntities,
          );
          if (!trimResult) return;

          pushSketchUndoState(state);

          const { toRemoveIds, toAddEntities } = trimResult;
          const toRemoveSet = new Set(toRemoveIds);

          const remainingConstraints =
            state.sketchSession.draftConstraints.filter(
              (c) => !c.entityIds.some((id) => toRemoveSet.has(id)),
            );
          const removedConstraintIds = new Set(
            state.sketchSession.draftConstraints
              .filter((c) => c.entityIds.some((id) => toRemoveSet.has(id)))
              .map((c) => c.id),
          );
          const remainingDimensions =
            state.sketchSession.draftDimensions.filter(
              (d) =>
                !d.constraintId || !removedConstraintIds.has(d.constraintId),
            );

          const updatedEntities = [
            ...state.sketchSession.draftEntities.filter(
              (e) => !toRemoveSet.has(e.id),
            ),
            ...toAddEntities,
          ];

          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: updatedEntities,
            constraints: remainingConstraints,
            dimensions: remainingDimensions,
            profiles: [],
            solverState: "UnderDefined",
          };
          applyConstraintsToSketch(dummySketch);

          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          state.selectedEntityIds = state.selectedEntityIds.filter(
            (id) => !toRemoveSet.has(id),
          );
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        const trimResult = executeTrim(entityId, clickPoint, sketch.entities);
        if (!trimResult) return;

        const { toRemoveIds, toAddEntities } = trimResult;
        const toRemoveSet = new Set(toRemoveIds);

        const remainingConstraints = sketch.constraints.filter(
          (c) => !c.entityIds.some((id) => toRemoveSet.has(id)),
        );
        const removedConstraintIds = new Set(
          sketch.constraints
            .filter((c) => c.entityIds.some((id) => toRemoveSet.has(id)))
            .map((c) => c.id),
        );
        const remainingDimensions = sketch.dimensions.filter(
          (d) => !d.constraintId || !removedConstraintIds.has(d.constraintId),
        );

        const updatedEntities = [
          ...sketch.entities.filter((e) => !toRemoveSet.has(e.id)),
          ...toAddEntities,
        ];

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
            f.id === state.activeSketchId ? updatedSketch : f,
          ),
        };

        const docDirty = markSketchDirtyInDoc(
          updatedDocument,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        Object.assign(state, {
          document: docDirty,
          selectedEntityIds: state.selectedEntityIds.filter(
            (id) => !toRemoveSet.has(id),
          ),
        });
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },
    extendEntity: (entityId, clickPoint) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyExtendToSketch(dummySketch, entityId, clickPoint);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        applyExtendToSketch(sketch, entityId, clickPoint);
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    applyFillet: (entityId1, entityId2, arg3, arg4, arg5) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyFilletToSketch(dummySketch, entityId1, entityId2, arg3, arg4, arg5);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          state.selectedEntityIds = state.selectedEntityIds.filter(
            (id) => id !== entityId1 && id !== entityId2,
          );
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        applyFilletToSketch(sketch, entityId1, entityId2, arg3, arg4, arg5);
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
        state.selectedEntityIds = state.selectedEntityIds.filter(
          (id) => id !== entityId1 && id !== entityId2,
        );
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    applyChamfer: (entityId1, entityId2, arg3, arg4, arg5) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyChamferToSketch(dummySketch, entityId1, entityId2, arg3, arg4, arg5);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          state.selectedEntityIds = state.selectedEntityIds.filter(
            (id) => id !== entityId1 && id !== entityId2,
          );
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        applyChamferToSketch(sketch, entityId1, entityId2, arg3, arg4, arg5);
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
        state.selectedEntityIds = state.selectedEntityIds.filter(
          (id) => id !== entityId1 && id !== entityId2,
        );
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    offsetEntity: (entityId, distance, sidePoint) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyOffsetToSketch(dummySketch, entityId, distance, sidePoint);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        applyOffsetToSketch(sketch, entityId, distance, sidePoint);
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    mirrorEntities: (sourceEntityIds, p1, p2) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId) return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyMirrorToSketch(dummySketch, sourceEntityIds, p1, p2);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        applyMirrorToSketch(sketch, sourceEntityIds, p1, p2);
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    moveEntities: (entityIds, basePoint, targetPoint) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId || !entityIds || entityIds.length === 0)
          return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyMoveToSketch(dummySketch, entityIds, basePoint, targetPoint);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          state.selectedEntityIds = entityIds;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        applyMoveToSketch(sketch, entityIds, basePoint, targetPoint);
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
        state.selectedEntityIds = entityIds;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    copyEntities: (entityIds, basePoint, targetPoint) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId || !entityIds || entityIds.length === 0)
          return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const prevEntityCount = state.sketchSession.draftEntities.length;
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyCopyToSketch(dummySketch, entityIds, basePoint, targetPoint);
          const newEntities = dummySketch.entities.slice(prevEntityCount);
          const newEntityIds = newEntities.map((e) => e.id);

          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          state.selectedEntityIds =
            newEntityIds.length > 0 ? newEntityIds : state.selectedEntityIds;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        const prevEntityCount = sketch.entities.length;
        applyCopyToSketch(sketch, entityIds, basePoint, targetPoint);
        const newEntities = sketch.entities.slice(prevEntityCount);
        const newEntityIds = newEntities.map((e) => e.id);

        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
        state.selectedEntityIds =
          newEntityIds.length > 0 ? newEntityIds : state.selectedEntityIds;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    scaleEntities: (entityIds, basePoint, factor) => {
      let isSessionEdit = false;
      set((state) => {
        if (
          !state.activeSketchId ||
          !entityIds ||
          entityIds.length === 0 ||
          factor <= 0
        )
          return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyScaleToSketch(dummySketch, entityIds, basePoint, factor);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          state.selectedEntityIds = entityIds;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        applyScaleToSketch(sketch, entityIds, basePoint, factor);
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
        state.selectedEntityIds = entityIds;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    rotateEntities: (entityIds, basePoint, angleRad) => {
      let isSessionEdit = false;
      set((state) => {
        if (!state.activeSketchId || !entityIds || entityIds.length === 0)
          return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyRotateToSketch(dummySketch, entityIds, basePoint, angleRad);
          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          state.selectedEntityIds = entityIds;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        applyRotateToSketch(sketch, entityIds, basePoint, angleRad);
        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
        state.selectedEntityIds = entityIds;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    circularArrayEntities: (entityIds, centerPoint, items, fillAngleDeg) => {
      let isSessionEdit = false;
      set((state) => {
        if (
          !state.activeSketchId ||
          !entityIds ||
          entityIds.length === 0 ||
          items <= 1
        )
          return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const prevCount = state.sketchSession.draftEntities.length;
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyCircularArrayToSketch(
            dummySketch,
            entityIds,
            centerPoint,
            items,
            fillAngleDeg,
          );
          const newEntities = dummySketch.entities.slice(prevCount);
          const newEntityIds = newEntities.map((e) => e.id);

          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          state.selectedEntityIds = newEntityIds;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        const prevCount = sketch.entities.length;
        applyCircularArrayToSketch(
          sketch,
          entityIds,
          centerPoint,
          items,
          fillAngleDeg,
        );
        const newEntities = sketch.entities.slice(prevCount);
        const newEntityIds = newEntities.map((e) => e.id);

        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
        state.selectedEntityIds = newEntityIds;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    rectArrayEntities: (entityIds, cols, rows, colSpacing, rowSpacing) => {
      let isSessionEdit = false;
      set((state) => {
        if (
          !state.activeSketchId ||
          !entityIds ||
          entityIds.length === 0 ||
          cols < 1 ||
          rows < 1 ||
          (cols === 1 && rows === 1)
        )
          return;

        if (
          state.sketchSession.isActive &&
          state.sketchSession.sketchId === state.activeSketchId
        ) {
          isSessionEdit = true;
          pushSketchUndoState(state);
          const prevCount = state.sketchSession.draftEntities.length;
          const dummySketch: SketchFeature = {
            id: state.activeSketchId,
            name: "Draft",
            type: "SKETCH",
            plane: DatumFrontPlane,
            dependencies: [],
            suppressed: false,
            entities: [...state.sketchSession.draftEntities],
            constraints: [...state.sketchSession.draftConstraints],
            dimensions: [...state.sketchSession.draftDimensions],
            profiles: [],
            solverState: "UnderDefined",
          };
          applyRectArrayToSketch(
            dummySketch,
            entityIds,
            cols,
            rows,
            colSpacing,
            rowSpacing,
          );
          const newEntities = dummySketch.entities.slice(prevCount);
          const newEntityIds = newEntities.map((e) => e.id);

          state.sketchSession.draftEntities = dummySketch.entities;
          state.sketchSession.draftProfiles = dummySketch.profiles || [];
          state.sketchSession.draftConstraints = dummySketch.constraints;
          state.sketchSession.draftDimensions = dummySketch.dimensions || [];
          state.sketchSession.isDirty = true;
          state.selectedEntityIds = newEntityIds;
          return;
        }

        const sketch = state.document.featureTree.find(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        ) as SketchFeature | undefined;

        if (!sketch) return;

        const prevCount = sketch.entities.length;
        applyRectArrayToSketch(
          sketch,
          entityIds,
          cols,
          rows,
          colSpacing,
          rowSpacing,
        );
        const newEntities = sketch.entities.slice(prevCount);
        const newEntityIds = newEntities.map((e) => e.id);

        const docDirty = markSketchDirtyInDoc(
          state.document,
          state.activeSketchId,
        );

        const undoState = pushUndoState(get());
        state.undoStack = undoState.undoStack;
        state.redoStack = undoState.redoStack;
        state.document = docDirty;
        state.selectedEntityIds = newEntityIds;
      });
      if (!isSessionEdit) {
        get().regenerateFeatureTree();
      }
    },

    toggleOsnap: () => set((state) => ({ osnapEnabled: !state.osnapEnabled })),
    toggleOrtho: () => set((state) => ({ orthoEnabled: !state.orthoEnabled })),
    toggleShowProfiles: () =>
      set((state) => ({ showProfiles: !state.showProfiles })),

    toggleOsnapMode: (mode) =>
      set((state) => ({
        osnapSettings: {
          ...state.osnapSettings,
          [mode]: !state.osnapSettings[mode],
        },
      })),

    setAllOsnapModes: (enabled) =>
      set((state) => ({
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
        },
      })),

    clearOtrackAnchors: () => {
      // 全域提供 OTrack 追蹤點清空介面
    },

    setPolarModalOpen: (open) => set({ isPolarModalOpen: open }),
    togglePolarTracking: () =>
      set((state) => ({ polarTrackingEnabled: !state.polarTrackingEnabled })),
    setPolarAngleStep: (step) => set({ polarAngleStep: step }),

    addCustomPolarAngle: (angle) =>
      set((state) => {
        if (state.customPolarAngles.includes(angle)) {
          return state;
        }
        return {
          customPolarAngles: [...state.customPolarAngles, angle].sort(
            (a, b) => a - b,
          ),
        };
      }),
    removeCustomPolarAngle: (angle) =>
      set((state) => ({
        customPolarAngles: state.customPolarAngles.filter((a) => a !== angle),
      })),

    // ------------------------------------------
    // Undo / Redo (包含防呆機制)
    // ------------------------------------------

    undo: () =>
      set((state) => {
        if (state.sketchSession.isActive) {
          const undoStack = state.sketchSession.draftUndoStack || [];
          if (undoStack.length === 0) return;

          const previousSnapshot = undoStack[undoStack.length - 1];
          const newUndoStack = undoStack.slice(0, -1);

          const currentSnapshot: SketchDraftSnapshot = {
            draftEntities: JSON.parse(
              JSON.stringify(state.sketchSession.draftEntities),
            ),
            draftConstraints: JSON.parse(
              JSON.stringify(state.sketchSession.draftConstraints),
            ),
            draftDimensions: JSON.parse(
              JSON.stringify(state.sketchSession.draftDimensions),
            ),
            draftProfiles: JSON.parse(
              JSON.stringify(state.sketchSession.draftProfiles),
            ),
          };

          state.sketchSession.draftUndoStack = newUndoStack;
          state.sketchSession.draftRedoStack = [
            ...(state.sketchSession.draftRedoStack || []),
            currentSnapshot,
          ];
          state.sketchSession.draftEntities = previousSnapshot.draftEntities;
          state.sketchSession.draftConstraints =
            previousSnapshot.draftConstraints;
          state.sketchSession.draftDimensions =
            previousSnapshot.draftDimensions;
          state.sketchSession.draftProfiles = previousSnapshot.draftProfiles;
          state.sketchSession.isDirty = true;
          state.selectedEntityIds = [];
          return;
        }

        if (state.undoStack.length === 0) return;
        const previousDoc = state.undoStack[state.undoStack.length - 1];
        const newUndoStack = state.undoStack.slice(0, -1);

        // 【防呆機制】檢查上一步的 activeSketchId 是否還存在於舊的特徵樹中
        const sketchExists = previousDoc.featureTree.some(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        );
        const safeActiveSketchId = sketchExists ? state.activeSketchId : null;

        state.undoStack = newUndoStack;
        state.redoStack = [
          ...state.redoStack,
          JSON.parse(JSON.stringify(state.document)),
        ];
        state.document = previousDoc;
        state.activeSketchId = safeActiveSketchId;
        state.selectedEntityIds = [];
        state.selectedFeatureId = null;
      }),
    redo: () =>
      set((state) => {
        if (state.sketchSession.isActive) {
          const redoStack = state.sketchSession.draftRedoStack || [];
          if (redoStack.length === 0) return;

          const nextSnapshot = redoStack[redoStack.length - 1];
          const newRedoStack = redoStack.slice(0, -1);

          const currentSnapshot: SketchDraftSnapshot = {
            draftEntities: JSON.parse(
              JSON.stringify(state.sketchSession.draftEntities),
            ),
            draftConstraints: JSON.parse(
              JSON.stringify(state.sketchSession.draftConstraints),
            ),
            draftDimensions: JSON.parse(
              JSON.stringify(state.sketchSession.draftDimensions),
            ),
            draftProfiles: JSON.parse(
              JSON.stringify(state.sketchSession.draftProfiles),
            ),
          };

          state.sketchSession.draftRedoStack = newRedoStack;
          state.sketchSession.draftUndoStack = [
            ...(state.sketchSession.draftUndoStack || []),
            currentSnapshot,
          ];
          state.sketchSession.draftEntities = nextSnapshot.draftEntities;
          state.sketchSession.draftConstraints = nextSnapshot.draftConstraints;
          state.sketchSession.draftDimensions = nextSnapshot.draftDimensions;
          state.sketchSession.draftProfiles = nextSnapshot.draftProfiles;
          state.sketchSession.isDirty = true;
          state.selectedEntityIds = [];
          return;
        }

        if (state.redoStack.length === 0) return;
        const nextDoc = state.redoStack[state.redoStack.length - 1];
        const newRedoStack = state.redoStack.slice(0, -1);

        // 【防呆機制】檢查下一步的 activeSketchId 是否還存在
        const sketchExists = nextDoc.featureTree.some(
          (f) => f.id === state.activeSketchId && f.type === "SKETCH",
        );
        const safeActiveSketchId = sketchExists ? state.activeSketchId : null;

        state.undoStack = [
          ...state.undoStack,
          JSON.parse(JSON.stringify(state.document)),
        ];
        state.redoStack = newRedoStack;
        state.document = nextDoc;
        state.activeSketchId = safeActiveSketchId;
        state.selectedEntityIds = [];
        state.selectedFeatureId = null;
      }),
    canUndo: () => {
      const state = get();
      if (state.sketchSession.isActive) {
        return (state.sketchSession.draftUndoStack?.length || 0) > 0;
      }
      return state.undoStack.length > 0;
    },

    canRedo: () => {
      const state = get();
      if (state.sketchSession.isActive) {
        return (state.sketchSession.draftRedoStack?.length || 0) > 0;
      }
      return state.redoStack.length > 0;
    },

    resetDocument: () => {
      const doc = createInitialDocument();
      set({
        document: doc,
        activeLayerId: "0",
        viewMode: "2D",
        currentTool: "SELECT",
        activeSketchId: "sketch-1",
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
  })),
);

// 常用的 state Selectors
export const useCADDocument = () => useCADStore((state) => state.document);
export const useViewMode = () => useCADStore((state) => state.viewMode);
export const useCurrentTool = () => useCADStore((state) => state.currentTool);
export const useActiveSketch = () =>
  useCADStore((state) => {
    if (!state.activeSketchId) return null;
    const feature = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === "SKETCH",
    );
    return (feature as SketchFeature) || null;
  });
export const useActiveLayerId = () =>
  useCADStore((state) => state.activeLayerId);
export const useCADLayers = () => useCADStore((state) => state.document.layers);
export const useShowProfiles = () => useCADStore((state) => state.showProfiles);
