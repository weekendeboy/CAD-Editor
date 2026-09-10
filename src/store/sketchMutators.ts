import { CADDocument, CADEntity2D, Constraint, SketchFeature, LineEntity } from '../types/cad';
import { solveConstraints, analyzeSketchDOF } from '../core/solver/ConstraintSolver';
import { findClosedProfiles } from '../core/2d/TopologyEngine';
import { createFilletArc } from '../core/2d/FilletManager';

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
  lineId1: string,
  lineId2: string,
  radius: number
): SketchFeature {
  const line1 = sketch.entities.find((e) => e.id === lineId1 && e.type === 'line') as LineEntity | undefined;
  const line2 = sketch.entities.find((e) => e.id === lineId2 && e.type === 'line') as LineEntity | undefined;

  if (!line1 || !line2) {
    return sketch;
  }

  const result = createFilletArc(line1, line2, radius);
  if (!result) {
    return sketch;
  }

  const { arc, trimmedLine1, trimmedLine2, generatedConstraints } = result;

  // Find which endpoints were modified to clear associated invalid constraints
  const line1StartChanged = line1.start.x !== trimmedLine1.start.x || line1.start.y !== trimmedLine1.start.y;
  const line1PtIdx = line1StartChanged ? 0 : 1;

  const line2StartChanged = line2.start.x !== trimmedLine2.start.x || line2.start.y !== trimmedLine2.start.y;
  const line2PtIdx = line2StartChanged ? 0 : 1;

  const invalidConstraintIds = new Set<string>();

  const filteredConstraints = sketch.constraints.filter((c) => {
    if (c.pointIndices && c.pointIndices.length > 0) {
      const idx1 = c.entityIds.indexOf(lineId1);
      if (idx1 !== -1 && c.pointIndices[idx1] === line1PtIdx) {
        invalidConstraintIds.add(c.id);
        return false;
      }
      const idx2 = c.entityIds.indexOf(lineId2);
      if (idx2 !== -1 && c.pointIndices[idx2] === line2PtIdx) {
        invalidConstraintIds.add(c.id);
        return false;
      }
    }
    return true;
  });

  const filteredDimensions = (sketch.dimensions || []).filter(
    (d) => !d.constraintId || !invalidConstraintIds.has(d.constraintId)
  );

  const updatedEntities = sketch.entities.map((e) => {
    if (e.id === lineId1) return trimmedLine1;
    if (e.id === lineId2) return trimmedLine2;
    return e;
  });
  updatedEntities.push(arc);

  const tempSketch: SketchFeature = {
    ...sketch,
    entities: updatedEntities,
    constraints: [...filteredConstraints, ...generatedConstraints],
    dimensions: filteredDimensions,
  };

  return applyConstraintsToSketch(tempSketch);
}

