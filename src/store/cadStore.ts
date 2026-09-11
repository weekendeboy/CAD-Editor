import { create } from 'zustand';
import { CADState } from './cadStore.types';
import { CADDocument, CADEntity2D, createEmptyCADDocument, DatumFrontPlane, SketchFeature } from '../types/cad';
import {
  insertEntityIntoSketch,
  removeEntityFromSketch,
  updateEntityInSketch,
  addConstraintToSketch,
  addDimensionToSketch,
  removeConstraintFromSketch,
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

function createInitialDocument() {
  const doc = createEmptyCADDocument();
  const initialSketch: SketchFeature = {
    id: 'sketch-1',
    name: 'Sketch1',
    type: 'SKETCH',
    dependencies: [],
    suppressed: false,
    plane: DatumFrontPlane,
    entities: [],
    constraints: [],
    dimensions: [],
    profiles: [],
    solverState: 'UnderDefined',
  };
  
  // We cannot mutate doc.featureTree directly if we want strict immutability, 
  // but since it's freshly created here, it's fine.
  doc.featureTree.push(initialSketch);
  doc.activeSketchId = 'sketch-1';
  return doc;
}

function pushUndoState(state: CADState): Partial<CADState> {
  // Deep copy the document as requested
  const clonedDoc = JSON.parse(JSON.stringify(state.document));
  const newUndoStack = [...state.undoStack, clonedDoc];
  if (newUndoStack.length > 20) {
    newUndoStack.shift();
  }
  return {
    undoStack: newUndoStack,
    redoStack: [],
  };
}

export const useCADStore = create<CADState>((set, get) => ({
  document: createInitialDocument(),
  viewMode: '2D',
  currentTool: 'SELECT',
  activeSketchId: 'sketch-1',
  selectedEntityIds: [],
  selectedFeatureId: null,
  osnapEnabled: true,
  orthoEnabled: false,

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

  undoStack: [],
  redoStack: [],

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
  
  addEntity: (entity) => set((state) => {
    if (!state.activeSketchId) return state;
    return {
      ...pushUndoState(state),
      document: insertEntityIntoSketch(state.document, state.activeSketchId, entity)
    };
  }),

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

    // Dynamically adjust constraint type and value based on dimension.dimType
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

    // Test solver with new constraint
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
      
      // Add dimension only, without constraint, marked as reference
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

  updateConstraintValue: (constraintId, value) => set((state) => {
    if (!state.activeSketchId) return state;

    const updatedDocument: CADDocument = {
      ...state.document,
      featureTree: state.document.featureTree.map((f) => {
        if (f.id === state.activeSketchId && f.type === 'SKETCH') {
          const sketch = f as SketchFeature;

          // 找出對應的 dimension，判定是否為直徑標註
          const linkedDim = sketch.dimensions?.find((d) => d.constraintId === constraintId);
          const isDiameter = linkedDim ? !!linkedDim.isDiameter : false;

          // 圓形或圓弧的 radius = isDiameter ? value / 2 : value
          const finalConstraintValue = (linkedDim && linkedDim.type === 'radial')
            ? (isDiameter ? value / 2 : value)
            : value;

          const updatedConstraints = sketch.constraints.map((c) => {
            if (c.id === constraintId) {
              return { ...c, value: finalConstraintValue };
            }
            return c;
          });

          // Apply constraints to solve the sketch, driving the line shrinking/stretching, and update profiles
          const updatedSketch = applyConstraintsToSketch({
            ...sketch,
            constraints: updatedConstraints,
          });

          // 同步尺寸標註的點位隨幾何變形而更新
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
                // 對於其他非當前編輯的標註，幾何縮放時同步其點位
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

    // 1. 過濾失效的約束與對應的尺寸標註
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

    // 2. 更新實體列表，移除 targetEntityId，加入新生成的子圖元
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

    // 3. 重新計算約束、自由度與閉合封閉面
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

  mirrorEntities: (sourceEntityIds, axisLineId) => set((state) => {
    if (!state.activeSketchId) return state;

    const sketch = state.document.featureTree.find(
      (f) => f.id === state.activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;

    if (!sketch) return state;

    const updatedSketch = applyMirrorToSketch(sketch, sourceEntityIds, axisLineId);
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

    // 複製後的新圖元位於陣列後方
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

    // 選取包含所有新陣列圖元，便於視覺回饋與接續操作
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

    // 選取包含所有新陣列圖元，便於視覺回饋與接續操作
    const newEntityIds = updatedSketch.entities.map((e) => e.id);

    return {
      ...pushUndoState(state),
      document: updatedDocument,
      selectedEntityIds: newEntityIds,
    };
  }),

  toggleOsnap: () => set((state) => ({ osnapEnabled: !state.osnapEnabled })),
  toggleOrtho: () => set((state) => ({ orthoEnabled: !state.orthoEnabled })),

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
    set({
      document: createInitialDocument(),
      activeSketchId: 'sketch-1',
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
    });
  }
}));

// Selector Hooks
export const useCADDocument = () => useCADStore((state) => state.document);
export const useViewMode = () => useCADStore((state) => state.viewMode);
export const useCurrentTool = () => useCADStore((state) => state.currentTool);
export const useActiveSketch = () => useCADStore((state) => state.activeSketchId);
