import { CADDocument, CADEntity2D, Constraint, SketchFeature, LineEntity, ArcEntity, CircleEntity, PolylineEntity, Point2D } from '../types/cad';
import { solveConstraints, analyzeSketchDOF } from '../core/solver/ConstraintSolver';
import { findClosedProfiles } from '../core/2d/TopologyEngine';
import { createFillet } from '../core/2d/FilletManager';
import { createChamfer } from '../core/2d/ChamferManager';
import { calculateExtend } from '../core/2d/ExtendManager';
import { calculateOffsetEntity, calculateOffsetChain } from '../core/2d/OffsetEngine';
import { calculateMirror } from '../core/2d/MirrorEngine';
import { normalizeAngle } from '../core/2d/IntersectionEngine';

export function applyConstraintsToSketch(sketch: SketchFeature): SketchFeature {
  const solverResult = solveConstraints(sketch.entities, sketch.constraints);
  const dofState = analyzeSketchDOF(solverResult.entities, sketch.constraints);
  const profiles = findClosedProfiles(solverResult.entities, sketch.constraints);

  return {
    ...sketch,
    entities: solverResult.entities.map((e) => ({
      ...e,
      state: dofState.entityStates[e.id] || 'UnderDefined',
    })),
    constraints: sketch.constraints,
    profiles: profiles,
    solverState: dofState.state,
  };
}

export function insertEntityIntoSketch(doc: CADDocument, sketchId: string, entity: CADEntity2D): CADDocument {
  return {
    ...doc,
    featureTree: doc.featureTree.map((feature) => {
      if (feature.id === sketchId && feature.type === 'SKETCH') {
        const updatedSketch: SketchFeature = {
          ...feature,
          entities: [...feature.entities, entity],
        };
        return applyConstraintsToSketch(updatedSketch);
      }
      return feature;
    }),
  };
}

export function removeEntityFromSketch(doc: CADDocument, sketchId: string, entityId: string): CADDocument {
  return {
    ...doc,
    featureTree: doc.featureTree.map((feature) => {
      if (feature.id === sketchId && feature.type === 'SKETCH') {
        // Find all constraints that are associated with the target entity
        const constraintsToRemove = new Set(
          feature.constraints
            .filter((c) => c.entityIds.includes(entityId))
            .map((c) => c.id)
        );

        const updatedSketch: SketchFeature = {
          ...feature,
          entities: feature.entities.filter((e) => e.id !== entityId),
          // Remove the associated constraints
          constraints: feature.constraints.filter((c) => !constraintsToRemove.has(c.id)),
          // Remove the dimensions linked to the removed constraints
          dimensions: feature.dimensions.filter(
            (d) => !d.constraintId || !constraintsToRemove.has(d.constraintId)
          ),
        };
        return applyConstraintsToSketch(updatedSketch);
      }
      return feature;
    }),
  };
}

export function updateEntityInSketch(doc: CADDocument, sketchId: string, entity: CADEntity2D): CADDocument {
  return {
    ...doc,
    featureTree: doc.featureTree.map((feature) => {
      if (feature.id === sketchId && feature.type === 'SKETCH') {
        const updatedSketch: SketchFeature = {
          ...feature,
          entities: feature.entities.map((e) => (e.id === entity.id ? entity : e)),
        };
        return applyConstraintsToSketch(updatedSketch);
      }
      return feature;
    }),
  };
}

export function addConstraintToSketch(doc: CADDocument, sketchId: string, constraint: Constraint): CADDocument {
  return {
    ...doc,
    featureTree: doc.featureTree.map((feature) => {
      if (feature.id === sketchId && feature.type === 'SKETCH') {
        const updatedSketch: SketchFeature = {
          ...feature,
          constraints: [...feature.constraints, constraint],
        };
        return applyConstraintsToSketch(updatedSketch);
      }
      return feature;
    }),
  };
}

export function addDimensionToSketch(
  doc: CADDocument,
  sketchId: string,
  dimension: any,
  constraint: Constraint
): CADDocument {
  return {
    ...doc,
    featureTree: doc.featureTree.map((feature) => {
      if (feature.id === sketchId && feature.type === 'SKETCH') {
        const updatedSketch: SketchFeature = {
          ...feature,
          dimensions: [...(feature.dimensions || []), dimension],
          constraints: [...feature.constraints, constraint],
        };
        return applyConstraintsToSketch(updatedSketch);
      }
      return feature;
    }),
  };
}

export function removeConstraintFromSketch(doc: CADDocument, sketchId: string, constraintId: string): CADDocument {
  return {
    ...doc,
    featureTree: doc.featureTree.map((feature) => {
      if (feature.id === sketchId && feature.type === 'SKETCH') {
        const updatedSketch: SketchFeature = {
          ...feature,
          constraints: feature.constraints.filter((c) => c.id !== constraintId),
        };
        return applyConstraintsToSketch(updatedSketch);
      }
      return feature;
    }),
  };
}

export function applyFilletToSketch(
  sketch: SketchFeature,
  entityId1: string,
  entityId2: string,
  radius: number
): SketchFeature {
  const ent1 = sketch.entities.find((e) => e.id === entityId1 && (e.type === 'line' || e.type === 'arc')) as LineEntity | ArcEntity | undefined;
  const ent2 = sketch.entities.find((e) => e.id === entityId2 && (e.type === 'line' || e.type === 'arc')) as LineEntity | ArcEntity | undefined;

  if (!ent1 || !ent2) {
    return sketch;
  }

  const result = createFillet(ent1, ent2, radius);
  if (!result) {
    return sketch;
  }

  const { arc, trimmedEntity1, trimmedEntity2, generatedConstraints } = result;

  // Find which endpoints were modified to clear associated invalid constraints
  let ent1PtIdx: number | null = null;
  if (ent1.type === 'line' && trimmedEntity1.type === 'line') {
    const startChanged = ent1.start.x !== trimmedEntity1.start.x || ent1.start.y !== trimmedEntity1.start.y;
    ent1PtIdx = startChanged ? 0 : 1;
  } else if (ent1.type === 'arc' && trimmedEntity1.type === 'arc') {
    const startChanged = ent1.startAngle !== trimmedEntity1.startAngle;
    ent1PtIdx = startChanged ? 0 : 1;
  }

  let ent2PtIdx: number | null = null;
  if (ent2.type === 'line' && trimmedEntity2.type === 'line') {
    const startChanged = ent2.start.x !== trimmedEntity2.start.x || ent2.start.y !== trimmedEntity2.start.y;
    ent2PtIdx = startChanged ? 0 : 1;
  } else if (ent2.type === 'arc' && trimmedEntity2.type === 'arc') {
    const startChanged = ent2.startAngle !== trimmedEntity2.startAngle;
    ent2PtIdx = startChanged ? 0 : 1;
  }

  const invalidConstraintIds = new Set<string>();

  // 1. 篩選與被修剪端點重合的約束，以及直接依賴於這兩條圖元的長度 (length) 與距離 (distance) 約束
  const filteredConstraints = sketch.constraints.filter((c) => {
    if (c.pointIndices && c.pointIndices.length > 0) {
      const idx1 = c.entityIds.indexOf(entityId1);
      if (idx1 !== -1 && ent1PtIdx !== null && c.pointIndices[idx1] === ent1PtIdx) {
        invalidConstraintIds.add(c.id);
        return false;
      }
      const idx2 = c.entityIds.indexOf(entityId2);
      if (idx2 !== -1 && ent2PtIdx !== null && c.pointIndices[idx2] === ent2PtIdx) {
        invalidConstraintIds.add(c.id);
        return false;
      }
    }
    // 長度與距離約束若參考了被倒角的線段/圓弧，其長度必定會改變，若不移除將導致 OverDefined 衝突
    if ((c.type === 'length' || c.type === 'distance' || c.type === 'distance_x' || c.type === 'distance_y') &&
        (c.entityIds.includes(entityId1) || c.entityIds.includes(entityId2))) {
      invalidConstraintIds.add(c.id);
      return false;
    }
    return true;
  });

  // 2. 篩選尺寸標註：一併移除被標註為無效約束之標註，或其 entityIds 直接參考被修剪圖元的標註
  const filteredDimensions = (sketch.dimensions || []).filter((d) => {
    if (d.constraintId && invalidConstraintIds.has(d.constraintId)) {
      return false;
    }
    if (d.entityIds && (d.entityIds.includes(entityId1) || d.entityIds.includes(entityId2))) {
      if (d.constraintId) {
        invalidConstraintIds.add(d.constraintId);
      }
      return false;
    }
    return true;
  });

  // 3. 再次根據最終 invalidConstraintIds 清理 constraints 清單
  const finalConstraints = filteredConstraints.filter((c) => !invalidConstraintIds.has(c.id));

  const updatedEntities = sketch.entities.map((e) => {
    if (e.id === entityId1) return trimmedEntity1;
    if (e.id === entityId2) return trimmedEntity2;
    return e;
  });
  updatedEntities.push(arc);

  const tempSketch: SketchFeature = {
    ...sketch,
    entities: updatedEntities,
    constraints: [...finalConstraints, ...generatedConstraints],
    dimensions: filteredDimensions,
  };

  return applyConstraintsToSketch(tempSketch);
}

export function applyChamferToSketch(
  sketch: SketchFeature,
  entityId1: string,
  entityId2: string,
  distance: number
): SketchFeature {
  const ent1 = sketch.entities.find((e) => e.id === entityId1) as LineEntity | undefined;
  const ent2 = sketch.entities.find((e) => e.id === entityId2) as LineEntity | undefined;

  if (!ent1 || !ent2 || ent1.type !== 'line' || ent2.type !== 'line') {
    return sketch;
  }

  const result = createChamfer(ent1, ent2, distance);
  if (!result) {
    return sketch;
  }

  const { chamferLine, trimmedEntity1, trimmedEntity2, generatedConstraints } = result;

  // 尋找哪一個端點被修改，以清除關聯的無效約束
  const startChanged1 = ent1.start.x !== trimmedEntity1.start.x || ent1.start.y !== trimmedEntity1.start.y;
  const ent1PtIdx = startChanged1 ? 0 : 1;

  const startChanged2 = ent2.start.x !== trimmedEntity2.start.x || ent2.start.y !== trimmedEntity2.start.y;
  const ent2PtIdx = startChanged2 ? 0 : 1;

  const invalidConstraintIds = new Set<string>();

  // 1. 篩選與被修剪端點重合的約束，以及直接依賴於這兩條線段的長度 (length) 與距離 (distance) 約束
  const filteredConstraints = sketch.constraints.filter((c) => {
    if (c.pointIndices && c.pointIndices.length > 0) {
      const idx1 = c.entityIds.indexOf(entityId1);
      if (idx1 !== -1 && c.pointIndices[idx1] === ent1PtIdx) {
        invalidConstraintIds.add(c.id);
        return false;
      }
      const idx2 = c.entityIds.indexOf(entityId2);
      if (idx2 !== -1 && c.pointIndices[idx2] === ent2PtIdx) {
        invalidConstraintIds.add(c.id);
        return false;
      }
    }
    // 長度與距離約束若參考了被倒角的線段，其長度必定改變，若不移除將導致 OverDefined 衝突
    if ((c.type === 'length' || c.type === 'distance' || c.type === 'distance_x' || c.type === 'distance_y') &&
        (c.entityIds.includes(entityId1) || c.entityIds.includes(entityId2))) {
      invalidConstraintIds.add(c.id);
      return false;
    }
    return true;
  });

  // 2. 篩選尺寸標註：一併移除被標註為無效約束之標註，或其 entityIds 直接參考被修剪圖元的標註
  const filteredDimensions = (sketch.dimensions || []).filter((d) => {
    if (d.constraintId && invalidConstraintIds.has(d.constraintId)) {
      return false;
    }
    if (d.entityIds && (d.entityIds.includes(entityId1) || d.entityIds.includes(entityId2))) {
      if (d.constraintId) {
        invalidConstraintIds.add(d.constraintId);
      }
      return false;
    }
    return true;
  });

  // 3. 再次根據最終 invalidConstraintIds 清理 constraints 清單
  const finalConstraints = filteredConstraints.filter((c) => !invalidConstraintIds.has(c.id));

  const updatedEntities = sketch.entities.map((e) => {
    if (e.id === entityId1) return trimmedEntity1;
    if (e.id === entityId2) return trimmedEntity2;
    return e;
  });
  updatedEntities.push(chamferLine);

  const tempSketch: SketchFeature = {
    ...sketch,
    entities: updatedEntities,
    constraints: [...finalConstraints, ...generatedConstraints],
    dimensions: filteredDimensions,
  };

  return applyConstraintsToSketch(tempSketch);
}

export function applyExtendToSketch(
  sketch: SketchFeature,
  entityId: string,
  clickPoint: Point2D
): SketchFeature {
  const extendResult = calculateExtend(entityId, clickPoint, sketch.entities);
  if (!extendResult) {
    return sketch;
  }

  const { originalEntityId, extendedEntity, generatedConstraint } = extendResult;

  // 用延伸後的 extendedEntity 替換原有圖元
  const updatedEntities = sketch.entities.map((e) =>
    e.id === originalEntityId ? extendedEntity : e
  );

  // 1. 篩選出需要移除的舊長度或距離約束，避免延伸後與 coincident 產生 OverDefined 衝突
  const invalidConstraintIds = new Set<string>();
  const filteredConstraints = sketch.constraints.filter((c) => {
    if ((c.type === 'length' || c.type === 'distance' || c.type === 'distance_x' || c.type === 'distance_y') && c.entityIds.includes(entityId)) {
      invalidConstraintIds.add(c.id);
      return false;
    }
    return true;
  });

  // 2. 同步更新關聯尺寸標註 dim.points 的位置，並在關聯約束被移除時清除其 constraintId 參照（轉為參考尺寸）
  const updatedDimensions = (sketch.dimensions || []).map((dim) => {
    let updatedDim = { ...dim };
    
    if (dim.constraintId && invalidConstraintIds.has(dim.constraintId)) {
      updatedDim.constraintId = undefined;
    }

    if (dim.entityIds && dim.entityIds.includes(entityId)) {
      if (dim.type === 'linear' && extendedEntity.type === 'line') {
        updatedDim.points = [{ ...extendedEntity.start }, { ...extendedEntity.end }];
      } else if (dim.type === 'radial' && extendedEntity.type === 'arc') {
        const center = { ...extendedEntity.center };
        const origP0 = dim.points[0];
        const origP1 = dim.points[1] || { x: origP0.x + 10, y: origP0.y };
        const dx = origP1.x - origP0.x;
        const dy = origP1.y - origP0.y;
        const len = Math.hypot(dx, dy);
        const dir = len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
        const newEdge = {
          x: center.x + dir.x * extendedEntity.radius,
          y: center.y + dir.y * extendedEntity.radius,
        };
        updatedDim.points = [center, newEdge];
      }
    }
    return updatedDim;
  });

  const finalConstraints = generatedConstraint
    ? [...filteredConstraints, generatedConstraint]
    : filteredConstraints;

  const tempSketch: SketchFeature = {
    ...sketch,
    entities: updatedEntities,
    constraints: finalConstraints,
    dimensions: updatedDimensions,
  };

  // 3. 呼叫 applyConstraintsToSketch 重新求解幾何、DOF 與提取封閉面 profiles
  return applyConstraintsToSketch(tempSketch);
}

export function applyOffsetToSketch(
  sketch: SketchFeature,
  entityId: string,
  distance: number,
  sidePoint: Point2D
): SketchFeature {
  const target = sketch.entities.find((e) => e.id === entityId);
  if (!target) {
    return sketch;
  }

  // 支援整條連續多段線/連鎖幾何一次性整體偏移
  const offsetResult = calculateOffsetChain(
    target,
    { distance, sidePoint },
    sketch.entities,
    sketch.constraints
  );
  if (!offsetResult || offsetResult.entities.length === 0) {
    return sketch;
  }

  const updatedSketch: SketchFeature = {
    ...sketch,
    entities: [...sketch.entities, ...offsetResult.entities],
    constraints: [...sketch.constraints, ...offsetResult.generatedConstraints],
  };

  return applyConstraintsToSketch(updatedSketch);
}

export function applyMirrorToSketch(
  sketch: SketchFeature,
  sourceEntityIds: string[],
  axisLineId: string
): SketchFeature {
  const sourceEntities = sketch.entities.filter((e) => sourceEntityIds.includes(e.id));
  const axisLine = sketch.entities.find(
    (e) => e.id === axisLineId && e.type === 'line'
  ) as LineEntity | undefined;

  if (!axisLine || sourceEntities.length === 0) {
    return sketch;
  }

  const result = calculateMirror(sourceEntities, axisLine);
  if (!result) {
    return sketch;
  }

  const updatedSketch: SketchFeature = {
    ...sketch,
    entities: [...sketch.entities, ...result.mirroredEntities],
    constraints: [...sketch.constraints, ...result.generatedConstraints],
  };

  return applyConstraintsToSketch(updatedSketch);
}

export function applyMoveToSketch(
  sketch: SketchFeature,
  entityIds: string[],
  basePoint: Point2D,
  targetPoint: Point2D
): SketchFeature {
  if (!entityIds || entityIds.length === 0) return sketch;
  const dx = targetPoint.x - basePoint.x;
  const dy = targetPoint.y - basePoint.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return sketch;

  const targetIdSet = new Set(entityIds);

  // 1. 平移目標圖元的所有座標與圓心
  const updatedEntities = sketch.entities.map((e) => {
    if (!targetIdSet.has(e.id)) return e;

    if (e.type === 'line') {
      return {
        ...e,
        start: { x: e.start.x + dx, y: e.start.y + dy },
        end: { x: e.end.x + dx, y: e.end.y + dy },
      } as LineEntity;
    } else if (e.type === 'circle') {
      return {
        ...e,
        center: { x: e.center.x + dx, y: e.center.y + dy },
      } as CircleEntity;
    } else if (e.type === 'arc') {
      return {
        ...e,
        center: { x: e.center.x + dx, y: e.center.y + dy },
      } as ArcEntity;
    } else if (e.type === 'polyline') {
      return {
        ...e,
        points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      } as PolylineEntity;
    }
    return e;
  });

  // 2. 約束過濾：若約束為固定 (fix) 且關聯至被移動圖元，或約束連接了被移動圖元與未被移動圖元（跨越邊界），
  // 移除該約束以防止 OverDefined 或拉回原位
  const filteredConstraints = (sketch.constraints || []).filter((c) => {
    const hasMoved = c.entityIds.some((id) => targetIdSet.has(id));
    const hasUnmoved = c.entityIds.some((id) => !targetIdSet.has(id));

    if (hasMoved && c.type === 'fix') {
      return false;
    }
    if (hasMoved && hasUnmoved) {
      return false;
    }
    return true;
  });

  // 3. 尺寸標註更新：若尺寸標註關聯的圖元全在被移動圖元中，平移其 points 與 textPosition；若跨越邊界則清除
  const updatedDimensions = (sketch.dimensions || [])
    .filter((d) => {
      const entitiesInDim = d.entityIds || [];
      const hasMoved = entitiesInDim.some((id) => targetIdSet.has(id));
      const hasUnmoved = entitiesInDim.some((id) => !targetIdSet.has(id));
      if (hasMoved && hasUnmoved) {
        return false;
      }
      return true;
    })
    .map((d) => {
      const entitiesInDim = d.entityIds || [];
      const allMoved = entitiesInDim.length > 0 && entitiesInDim.every((id) => targetIdSet.has(id));
      if (allMoved) {
        return {
          ...d,
          points: (d.points || []).map((pt) => ({ x: pt.x + dx, y: pt.y + dy })),
          textPosition: { x: d.textPosition.x + dx, y: d.textPosition.y + dy },
        };
      }
      return d;
    });

  const tempSketch: SketchFeature = {
    ...sketch,
    entities: updatedEntities,
    constraints: filteredConstraints,
    dimensions: updatedDimensions,
  };

  return applyConstraintsToSketch(tempSketch);
}

export function applyCopyToSketch(
  sketch: SketchFeature,
  entityIds: string[],
  basePoint: Point2D,
  targetPoint: Point2D
): SketchFeature {
  if (!entityIds || entityIds.length === 0) return sketch;
  const dx = targetPoint.x - basePoint.x;
  const dy = targetPoint.y - basePoint.y;

  const targetIdSet = new Set(entityIds);
  const sourceEntities = sketch.entities.filter((e) => targetIdSet.has(e.id));
  if (sourceEntities.length === 0) return sketch;

  // 進行深拷貝 (Deep Clone)，產生全新的 UUID，並套用向量平移。
  // 注意：複製時暫時過濾掉選定圖元綁定的 Constraint 與 Dimension，以避免產生 OverDefined 錯誤。
  const copiedEntities: CADEntity2D[] = sourceEntities.map((e) => {
    const newId = crypto.randomUUID();
    if (e.type === 'line') {
      return {
        ...e,
        id: newId,
        start: { x: e.start.x + dx, y: e.start.y + dy },
        end: { x: e.end.x + dx, y: e.end.y + dy },
        state: 'UnderDefined',
      } as LineEntity;
    } else if (e.type === 'circle') {
      return {
        ...e,
        id: newId,
        center: { x: e.center.x + dx, y: e.center.y + dy },
        state: 'UnderDefined',
      } as CircleEntity;
    } else if (e.type === 'arc') {
      return {
        ...e,
        id: newId,
        center: { x: e.center.x + dx, y: e.center.y + dy },
        state: 'UnderDefined',
      } as ArcEntity;
    } else if (e.type === 'polyline') {
      return {
        ...e,
        id: newId,
        points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
        state: 'UnderDefined',
      } as PolylineEntity;
    }
    return {
      ...(e as any),
      id: newId,
      state: 'UnderDefined',
    } as CADEntity2D;
  });

  const updatedSketch: SketchFeature = {
    ...sketch,
    entities: [...sketch.entities, ...copiedEntities],
  };

  return applyConstraintsToSketch(updatedSketch);
}

export function applyScaleToSketch(
  sketch: SketchFeature,
  entityIds: string[],
  basePoint: Point2D,
  factor: number
): SketchFeature {
  if (!entityIds || entityIds.length === 0 || factor <= 0 || Math.abs(factor - 1) < 1e-9) {
    return sketch;
  }

  const targetIdSet = new Set(entityIds);

  // 1. 以 Base Point 為原點，套用純量乘法更新圖元幾何
  const updatedEntities = sketch.entities.map((e) => {
    if (!targetIdSet.has(e.id)) return e;

    if (e.type === 'line') {
      return {
        ...e,
        start: {
          x: basePoint.x + (e.start.x - basePoint.x) * factor,
          y: basePoint.y + (e.start.y - basePoint.y) * factor,
        },
        end: {
          x: basePoint.x + (e.end.x - basePoint.x) * factor,
          y: basePoint.y + (e.end.y - basePoint.y) * factor,
        },
      } as LineEntity;
    } else if (e.type === 'circle') {
      return {
        ...e,
        center: {
          x: basePoint.x + (e.center.x - basePoint.x) * factor,
          y: basePoint.y + (e.center.y - basePoint.y) * factor,
        },
        radius: Math.max(0.001, e.radius * factor),
      } as CircleEntity;
    } else if (e.type === 'arc') {
      return {
        ...e,
        center: {
          x: basePoint.x + (e.center.x - basePoint.x) * factor,
          y: basePoint.y + (e.center.y - basePoint.y) * factor,
        },
        radius: Math.max(0.001, e.radius * factor),
      } as ArcEntity;
    } else if (e.type === 'polyline') {
      return {
        ...e,
        points: e.points.map((p) => ({
          x: basePoint.x + (p.x - basePoint.x) * factor,
          y: basePoint.y + (p.y - basePoint.y) * factor,
        })),
      } as PolylineEntity;
    }
    return e;
  });

  // 2. 約束更新與維護：
  // - 移除被縮放實體的 fix 固定約束（避免與縮放衝突）
  // - 移除跨越縮放實體與未縮放實體的邊界約束
  // - 若為 length 或 distance 約束且關聯實體皆在縮放清單內，按比例更新其數值 (value * factor)
  const updatedConstraints: Constraint[] = [];
  for (const c of sketch.constraints || []) {
    const hasScaled = c.entityIds.some((id) => targetIdSet.has(id));
    const hasUnscaled = c.entityIds.some((id) => !targetIdSet.has(id));

    if (hasScaled && c.type === 'fix') {
      continue;
    }
    if (hasScaled && hasUnscaled) {
      continue;
    }

    if (hasScaled && !hasUnscaled) {
      if (c.type === 'length' || c.type === 'distance' || c.type === 'distance_x' || c.type === 'distance_y') {
        const currentVal = c.value !== undefined ? c.value : 0;
        updatedConstraints.push({
          ...c,
          value: currentVal * factor,
        });
        continue;
      }
    }

    updatedConstraints.push(c);
  }

  // 3. 尺寸標註更新：
  // - 若跨越邊界則過濾移除
  // - 若全部關聯實體皆在縮放清單中，同比例縮放點位、標註文字位置與半徑數值
  // - 若對應的約束已解除，則清除 constraintId 轉為參考標註
  const validConstraintIds = new Set(updatedConstraints.map((c) => c.id));
  const updatedDimensions = (sketch.dimensions || [])
    .filter((d) => {
      const entitiesInDim = d.entityIds || [];
      const hasScaled = entitiesInDim.some((id) => targetIdSet.has(id));
      const hasUnscaled = entitiesInDim.some((id) => !targetIdSet.has(id));
      if (hasScaled && hasUnscaled) {
        return false;
      }
      return true;
    })
    .map((d) => {
      const entitiesInDim = d.entityIds || [];
      const allScaled = entitiesInDim.length > 0 && entitiesInDim.every((id) => targetIdSet.has(id));
      if (allScaled) {
        const scaledPoints = (d.points || []).map((pt) => ({
          x: basePoint.x + (pt.x - basePoint.x) * factor,
          y: basePoint.y + (pt.y - basePoint.y) * factor,
        }));
        const scaledTextPos = {
          x: basePoint.x + (d.textPosition.x - basePoint.x) * factor,
          y: basePoint.y + (d.textPosition.y - basePoint.y) * factor,
        };
        let updatedDim = {
          ...d,
          points: scaledPoints,
          textPosition: scaledTextPos,
          constraintId: d.constraintId && validConstraintIds.has(d.constraintId) ? d.constraintId : undefined,
        };
        if (d.arcRadius !== undefined) {
          updatedDim.arcRadius = d.arcRadius * factor;
        }
        if (d.arcCenter) {
          updatedDim.arcCenter = {
            x: basePoint.x + (d.arcCenter.x - basePoint.x) * factor,
            y: basePoint.y + (d.arcCenter.y - basePoint.y) * factor,
          };
        }
        return updatedDim;
      }
      return d;
    });

  const tempSketch: SketchFeature = {
    ...sketch,
    entities: updatedEntities,
    constraints: updatedConstraints,
    dimensions: updatedDimensions,
  };

  return applyConstraintsToSketch(tempSketch);
}

/**
 * 2D 旋轉變換輔助函式：
 * x' = (x - cx) * cos(theta) - (y - cy) * sin(theta) + cx
 * y' = (x - cx) * sin(theta) + (y - cy) * cos(theta) + cy
 */
export function rotatePoint2D(p: Point2D, center: Point2D, cosT: number, sinT: number): Point2D {
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return {
    x: dx * cosT - dy * sinT + center.x,
    y: dx * sinT + dy * cosT + center.y,
  };
}

export function applyRotateToSketch(
  sketch: SketchFeature,
  entityIds: string[],
  basePoint: Point2D,
  angleRad: number
): SketchFeature {
  if (!entityIds || entityIds.length === 0 || Math.abs(angleRad) < 1e-9) {
    return sketch;
  }

  const targetIdSet = new Set(entityIds);
  const cosT = Math.cos(angleRad);
  const sinT = Math.sin(angleRad);

  // 1. 套用 2D 旋轉矩陣變換所有端點、圓心與圓弧起訖角度 (startAngle/endAngle)
  const updatedEntities = sketch.entities.map((e) => {
    if (!targetIdSet.has(e.id)) return e;

    if (e.type === 'line') {
      return {
        ...e,
        start: rotatePoint2D(e.start, basePoint, cosT, sinT),
        end: rotatePoint2D(e.end, basePoint, cosT, sinT),
      } as LineEntity;
    } else if (e.type === 'circle') {
      return {
        ...e,
        center: rotatePoint2D(e.center, basePoint, cosT, sinT),
      } as CircleEntity;
    } else if (e.type === 'arc') {
      return {
        ...e,
        center: rotatePoint2D(e.center, basePoint, cosT, sinT),
        startAngle: normalizeAngle(e.startAngle + angleRad),
        endAngle: normalizeAngle(e.endAngle + angleRad),
      } as ArcEntity;
    } else if (e.type === 'polyline') {
      return {
        ...e,
        points: e.points.map((p) => rotatePoint2D(p, basePoint, cosT, sinT)),
      } as PolylineEntity;
    }
    return e;
  });

  // 2. 約束防護處理：
  // 【關鍵防護】：旋轉操作會破壞原有的正交約束，自動移除與被選取圖元綁定的 horizontal 與 vertical 約束，
  // 避免 ConstraintSolver 產生 OverDefined 或無法收斂的錯誤。
  // 同時移除固定 (fix) 約束與跨越邊界 (boundary) 約束。
  const updatedConstraints: Constraint[] = [];
  for (const c of sketch.constraints || []) {
    const hasRotated = c.entityIds.some((id) => targetIdSet.has(id));
    const hasUnrotated = c.entityIds.some((id) => !targetIdSet.has(id));

    // 關鍵防護：自動移除被選取圖元的所有 horizontal 與 vertical 約束
    if (hasRotated && (c.type === 'horizontal' || c.type === 'vertical')) {
      continue;
    }

    // 移除被旋轉圖元的 fix 約束
    if (hasRotated && c.type === 'fix') {
      continue;
    }

    // 移除跨越旋轉與未旋轉實體間的邊界約束
    if (hasRotated && hasUnrotated) {
      continue;
    }

    updatedConstraints.push(c);
  }

  // 3. 尺寸標註更新：
  // - 若跨越邊界則過濾移除
  // - 若全部關聯實體皆在旋轉清單中，同角度旋轉點位、標註文字位置、弧中心及角度
  // - 若對應約束已解除，清除 constraintId 轉為參考標註
  const validConstraintIds = new Set(updatedConstraints.map((c) => c.id));
  const updatedDimensions = (sketch.dimensions || [])
    .filter((d) => {
      const entitiesInDim = d.entityIds || [];
      const hasRotated = entitiesInDim.some((id) => targetIdSet.has(id));
      const hasUnrotated = entitiesInDim.some((id) => !targetIdSet.has(id));
      if (hasRotated && hasUnrotated) {
        return false;
      }
      return true;
    })
    .map((d) => {
      const entitiesInDim = d.entityIds || [];
      const allRotated = entitiesInDim.length > 0 && entitiesInDim.every((id) => targetIdSet.has(id));
      if (allRotated) {
        const rotatedPoints = (d.points || []).map((pt) => rotatePoint2D(pt, basePoint, cosT, sinT));
        const rotatedTextPos = rotatePoint2D(d.textPosition, basePoint, cosT, sinT);
        let updatedDim = {
          ...d,
          points: rotatedPoints,
          textPosition: rotatedTextPos,
          constraintId: d.constraintId && validConstraintIds.has(d.constraintId) ? d.constraintId : undefined,
        };
        if (d.arcCenter) {
          updatedDim.arcCenter = rotatePoint2D(d.arcCenter, basePoint, cosT, sinT);
        }
        if (d.startAngle !== undefined) {
          updatedDim.startAngle = normalizeAngle(d.startAngle + angleRad);
        }
        if (d.endAngle !== undefined) {
          updatedDim.endAngle = normalizeAngle(d.endAngle + angleRad);
        }
        return updatedDim;
      }
      return d;
    });

  const tempSketch: SketchFeature = {
    ...sketch,
    entities: updatedEntities,
    constraints: updatedConstraints,
    dimensions: updatedDimensions,
  };

  return applyConstraintsToSketch(tempSketch);
}

/**
 * 環形陣列 (Circular Array) 幾何變異操作：
 * 1. 計算每次遞增的旋轉角度 Δθ = Fill Angle / (Items - 1) （若為 360 度填滿則除以 Items）
 * 2. 執行迴圈深拷貝 (Deep Clone) 來源圖元，針對每個分身套用繞 Center Point 的旋轉矩陣
 * 3. 為新產生的圖元配置全新的 UUID
 * 【關鍵防護】：複製過程中絕對不要複製來源圖元的 Constraints 與 Dimensions，以防止拓撲樹與求解器過載。
 */
export function applyCircularArrayToSketch(
  sketch: SketchFeature,
  entityIds: string[],
  centerPoint: Point2D,
  items: number,
  fillAngleDeg: number
): SketchFeature {
  if (!entityIds || entityIds.length === 0 || items <= 1) {
    return sketch;
  }

  const targetIdSet = new Set(entityIds);
  const sourceEntities = sketch.entities.filter((e) => targetIdSet.has(e.id));
  if (sourceEntities.length === 0) {
    return sketch;
  }

  // 1. 計算每次遞增的旋轉角度
  // 若為 360 度填滿（或 -360 度）則除以 Items，避免最後一個實體與第一個實體重疊
  const isFullCircle = Math.abs(Math.abs(fillAngleDeg) - 360) < 1e-4;
  const angleStepDeg = isFullCircle ? fillAngleDeg / items : fillAngleDeg / (items - 1);
  const angleStepRad = (angleStepDeg * Math.PI) / 180;

  const clonedEntities: CADEntity2D[] = [];

  // 2. 執行迴圈深拷貝 (Deep Clone) 來源圖元
  // 針對分身 i (從 1 到 items - 1) 套用繞 Center Point 的旋轉矩陣
  for (let i = 1; i < items; i++) {
    const currentAngleRad = i * angleStepRad;
    const cosT = Math.cos(currentAngleRad);
    const sinT = Math.sin(currentAngleRad);

    for (const source of sourceEntities) {
      const newId = crypto.randomUUID();

      if (source.type === 'line') {
        const cloned: LineEntity = {
          ...source,
          id: newId,
          start: rotatePoint2D(source.start, centerPoint, cosT, sinT),
          end: rotatePoint2D(source.end, centerPoint, cosT, sinT),
        };
        clonedEntities.push(cloned);
      } else if (source.type === 'circle') {
        const cloned: CircleEntity = {
          ...source,
          id: newId,
          center: rotatePoint2D(source.center, centerPoint, cosT, sinT),
        };
        clonedEntities.push(cloned);
      } else if (source.type === 'arc') {
        const cloned: ArcEntity = {
          ...source,
          id: newId,
          center: rotatePoint2D(source.center, centerPoint, cosT, sinT),
          startAngle: normalizeAngle(source.startAngle + currentAngleRad),
          endAngle: normalizeAngle(source.endAngle + currentAngleRad),
        };
        clonedEntities.push(cloned);
      } else if (source.type === 'polyline') {
        const cloned: PolylineEntity = {
          ...source,
          id: newId,
          points: source.points.map((pt) => rotatePoint2D(pt, centerPoint, cosT, sinT)),
        };
        clonedEntities.push(cloned);
      }
    }
  }

  // 3. 【關鍵防護】：複製過程中絕對不要複製來源圖元的 Constraints 與 Dimensions，以防止拓撲樹與求解器過載。
  // 原始圖元的 constraints 與 dimensions 保持不變，新圖元作為獨立幾何加入
  const updatedSketch: SketchFeature = {
    ...sketch,
    entities: [...sketch.entities, ...clonedEntities],
    constraints: sketch.constraints,
    dimensions: sketch.dimensions,
  };

  return applyConstraintsToSketch(updatedSketch);
}

/**
 * 矩形陣列 (Rectangular Array) 幾何變異操作：
 * 1. 透過雙層迴圈 (i 從 0 到 Columns-1，j 從 0 到 Rows-1，跳過 i=0 且 j=0 的原圖元)。
 * 2. 每次疊加平移向量：ΔX = i * Col Spacing，ΔY = j * Row Spacing。
 * 3. 執行深拷貝 (Deep Clone) 來源圖元，並套用上述平移向量。
 * 4. 為新產生的圖元配置全新的 UUID。
 * 【關鍵防護】：複製過程中絕對禁止複製來源圖元的 Constraints 與 Dimensions，以免造成求解器 (ConstraintSolver) 過載或 OverDefined 錯誤。
 */
export function applyRectArrayToSketch(
  sketch: SketchFeature,
  entityIds: string[],
  cols: number,
  rows: number,
  colSpacing: number,
  rowSpacing: number
): SketchFeature {
  if (!entityIds || entityIds.length === 0 || cols < 1 || rows < 1 || (cols === 1 && rows === 1)) {
    return sketch;
  }

  const targetIdSet = new Set(entityIds);
  const sourceEntities = sketch.entities.filter((e) => targetIdSet.has(e.id));
  if (sourceEntities.length === 0) {
    return sketch;
  }

  const clonedEntities: CADEntity2D[] = [];

  // 雙層迴圈 (i 從 0 到 Columns-1，j 從 0 到 Rows-1，跳過 i=0 且 j=0 的原圖元)
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (i === 0 && j === 0) continue;

      const dx = i * colSpacing;
      const dy = j * rowSpacing;

      for (const source of sourceEntities) {
        const newId = crypto.randomUUID();

        if (source.type === 'line') {
          const cloned: LineEntity = {
            ...source,
            id: newId,
            start: { x: source.start.x + dx, y: source.start.y + dy },
            end: { x: source.end.x + dx, y: source.end.y + dy },
          };
          clonedEntities.push(cloned);
        } else if (source.type === 'circle') {
          const cloned: CircleEntity = {
            ...source,
            id: newId,
            center: { x: source.center.x + dx, y: source.center.y + dy },
          };
          clonedEntities.push(cloned);
        } else if (source.type === 'arc') {
          const cloned: ArcEntity = {
            ...source,
            id: newId,
            center: { x: source.center.x + dx, y: source.center.y + dy },
          };
          clonedEntities.push(cloned);
        } else if (source.type === 'polyline') {
          const cloned: PolylineEntity = {
            ...source,
            id: newId,
            points: source.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })),
          };
          clonedEntities.push(cloned);
        }
      }
    }
  }

  // 【關鍵防護】：複製過程中絕對禁止複製來源圖元的 Constraints 與 Dimensions，以免造成求解器 (ConstraintSolver) 過載或 OverDefined 錯誤。
  const updatedSketch: SketchFeature = {
    ...sketch,
    entities: [...sketch.entities, ...clonedEntities],
    constraints: sketch.constraints,
    dimensions: sketch.dimensions,
  };

  return applyConstraintsToSketch(updatedSketch);
}


