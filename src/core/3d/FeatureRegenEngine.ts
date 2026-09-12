import type { CADFeature, CADDocument } from '../../types/cad';

/**
 * Global standard datum plane IDs that are always valid references.
 */
const DEFAULT_DATUM_PLANE_IDS = new Set<string>([
  'datum-front',
  'datum-top',
  'datum-right',
]);

/**
 * Helper: Extracts all parent feature IDs that a feature depends on.
 * Combines explicit `dependencies` array with specific type fields (sketchId, targetFeatureId, etc.)
 */
export function getDirectDependencies(feature: CADFeature): string[] {
  const deps = new Set<string>(feature.dependencies || []);

  switch (feature.type) {
    case 'EXTRUDE':
    case 'CUT_EXTRUDE':
    case 'REVOLVE':
      if (feature.sketchId) {
        deps.add(feature.sketchId);
      }
      break;
    case 'DATUM_PLANE':
      if (feature.referenceFeatureId) {
        deps.add(feature.referenceFeatureId);
      }
      break;
    case 'FILLET_3D':
    case 'CHAMFER_3D':
      if (feature.targetFeatureId) {
        deps.add(feature.targetFeatureId);
      }
      break;
    case 'SKETCH':
      if (feature.plane?.parentFeatureId) {
        deps.add(feature.plane.parentFeatureId);
      }
      break;
  }

  return Array.from(deps);
}

/**
 * Topological Sort & Cycle Detection for CAD Features.
 * Uses Kahn's algorithm to resolve feature dependency ordering and detect cyclic references.
 *
 * @param features List of CAD features to sort.
 * @returns Object containing sorted features, cycle flag, and cycle node IDs if any.
 */
export function topologicalSortFeatures(features: CADFeature[]): {
  sorted: CADFeature[];
  hasCycle: boolean;
  cycleNodes: string[];
} {
  if (!features || features.length === 0) {
    return { sorted: [], hasCycle: false, cycleNodes: [] };
  }

  const featureMap = new Map<string, CADFeature>();
  const featureIds = new Set<string>();

  for (const f of features) {
    featureMap.set(f.id, f);
    featureIds.add(f.id);
  }

  // Calculate in-degrees and build child adjacency list
  const inDegree = new Map<string, number>();
  const childrenMap = new Map<string, string[]>();

  for (const f of features) {
    inDegree.set(f.id, 0);
    childrenMap.set(f.id, []);
  }

  for (const f of features) {
    const parentIds = getDirectDependencies(f);
    let validParentsCount = 0;

    for (const parentId of parentIds) {
      if (featureIds.has(parentId)) {
        validParentsCount++;
        const children = childrenMap.get(parentId);
        if (children) {
          children.push(f.id);
        }
      }
    }

    inDegree.set(f.id, validParentsCount);
  }

  // Kahn's Algorithm
  const queue: string[] = [];
  for (const f of features) {
    if ((inDegree.get(f.id) ?? 0) === 0) {
      queue.push(f.id);
    }
  }

  const sorted: CADFeature[] = [];
  const processedSet = new Set<string>();

  while (queue.length > 0) {
    const currId = queue.shift()!;
    const currFeature = featureMap.get(currId);
    if (currFeature) {
      sorted.push(currFeature);
      processedSet.add(currId);
    }

    const children = childrenMap.get(currId) || [];
    for (const childId of children) {
      const currentInDegree = (inDegree.get(childId) ?? 0) - 1;
      inDegree.set(childId, currentInDegree);
      if (currentInDegree === 0 && !processedSet.has(childId)) {
        queue.push(childId);
      }
    }
  }

  const hasCycle = sorted.length < features.length;
  const cycleNodes: string[] = [];

  if (hasCycle) {
    for (const f of features) {
      if (!processedSet.has(f.id)) {
        cycleNodes.push(f.id);
      }
    }
  }

  return { sorted, hasCycle, cycleNodes };
}

/**
 * Gets active features based on rollback index and suppressed state.
 * Returns features with index < rollbackIndex and suppressed === false.
 *
 * @param features List of CAD features.
 * @param rollbackIndex Index position of the rollback bar (0 to features.length).
 * @returns Filtered array of active features.
 */
export function getActiveFeatures(
  features: CADFeature[],
  rollbackIndex: number
): CADFeature[] {
  if (!features || features.length === 0) {
    return [];
  }

  const clampedIndex = Math.max(0, Math.min(rollbackIndex, features.length));
  return features
    .slice(0, clampedIndex)
    .filter((feature) => !feature.suppressed);
}

/**
 * Marks a modified feature and all its direct and indirect downstream dependent features as dirty (isDirty = true).
 *
 * @param features List of CAD features.
 * @param modifiedFeatureId The ID of the modified feature.
 * @returns A new list of features with updated `isDirty` flags.
 */
export function markDownstreamDirty(
  features: CADFeature[],
  modifiedFeatureId: string
): CADFeature[] {
  if (!features || features.length === 0) {
    return [];
  }

  // Build parent -> children graph
  const childrenMap = new Map<string, string[]>();
  for (const f of features) {
    childrenMap.set(f.id, []);
  }

  for (const f of features) {
    const parentIds = getDirectDependencies(f);
    for (const parentId of parentIds) {
      if (childrenMap.has(parentId)) {
        childrenMap.get(parentId)!.push(f.id);
      }
    }
  }

  // BFS to collect modifiedFeatureId and all downstream descendants
  const dirtySet = new Set<string>();
  const queue: string[] = [modifiedFeatureId];

  while (queue.length > 0) {
    const currId = queue.shift()!;
    if (dirtySet.has(currId)) {
      continue;
    }
    dirtySet.add(currId);

    const children = childrenMap.get(currId) || [];
    for (const childId of children) {
      if (!dirtySet.has(childId)) {
        queue.push(childId);
      }
    }
  }

  return features.map((f) => ({
    ...f,
    isDirty: dirtySet.has(f.id) ? true : Boolean(f.isDirty),
  }));
}

/**
 * Validates dependencies across all features in the tree to detect orphan or missing references.
 *
 * @param features List of CAD features to validate.
 * @returns Map where key is feature ID and value is array of missing dependency error messages.
 */
export function validateFeatureDependencies(
  features: CADFeature[]
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!features || features.length === 0) {
    return result;
  }

  const existingIds = new Set<string>(features.map((f) => f.id));

  for (const f of features) {
    const errors: string[] = [];
    const directDeps = getDirectDependencies(f);

    for (const parentId of directDeps) {
      if (!parentId) continue;

      if (parentId === f.id) {
        errors.push(`Self-referencing dependency detected: "${f.id}"`);
        continue;
      }

      if (!existingIds.has(parentId) && !DEFAULT_DATUM_PLANE_IDS.has(parentId)) {
        errors.push(`Missing reference dependency: "${parentId}"`);
      }
    }

    if (errors.length > 0) {
      result.set(f.id, errors);
    }
  }

  return result;
}

/**
 * Helper: Gets all upstream features (ancestors) that the specified feature depends on.
 */
export function getUpstreamFeatures(
  features: CADFeature[],
  targetFeatureId: string
): CADFeature[] {
  const featureMap = new Map<string, CADFeature>(features.map((f) => [f.id, f]));
  const upstreamSet = new Set<string>();
  const queue: string[] = [targetFeatureId];

  while (queue.length > 0) {
    const currId = queue.shift()!;
    const currFeature = featureMap.get(currId);
    if (!currFeature) continue;

    const parentIds = getDirectDependencies(currFeature);
    for (const pId of parentIds) {
      if (!upstreamSet.has(pId) && featureMap.has(pId)) {
        upstreamSet.add(pId);
        queue.push(pId);
      }
    }
  }

  return Array.from(upstreamSet)
    .map((id) => featureMap.get(id)!)
    .filter(Boolean);
}

/**
 * Helper: Gets all downstream features (descendants) that depend on the specified feature.
 */
export function getDownstreamFeatures(
  features: CADFeature[],
  targetFeatureId: string
): CADFeature[] {
  const childrenMap = new Map<string, string[]>();
  const featureMap = new Map<string, CADFeature>(features.map((f) => [f.id, f]));

  for (const f of features) {
    childrenMap.set(f.id, []);
  }

  for (const f of features) {
    const parentIds = getDirectDependencies(f);
    for (const pId of parentIds) {
      if (childrenMap.has(pId)) {
        childrenMap.get(pId)!.push(f.id);
      }
    }
  }

  const downstreamSet = new Set<string>();
  const queue: string[] = [targetFeatureId];

  while (queue.length > 0) {
    const currId = queue.shift()!;
    const children = childrenMap.get(currId) || [];
    for (const childId of children) {
      if (!downstreamSet.has(childId)) {
        downstreamSet.add(childId);
        queue.push(childId);
      }
    }
  }

  return Array.from(downstreamSet)
    .map((id) => featureMap.get(id)!)
    .filter(Boolean);
}

/**
 * High-level orchestration for feature tree regeneration.
 * Slices active features up to rollback index, validates dependencies, sorts topologically,
 * and identifies features that require recalculation.
 *
 * @param doc CAD Document instance.
 */
export function getRegenSequence(doc: CADDocument): {
  activeFeatures: CADFeature[];
  sortedFeatures: CADFeature[];
  dirtyFeatures: CADFeature[];
  hasCycle: boolean;
  cycleNodes: string[];
  validationErrors: Map<string, string[]>;
} {
  const activeFeatures = getActiveFeatures(doc.featureTree, doc.rollbackIndex);
  const validationErrors = validateFeatureDependencies(activeFeatures);
  const { sorted: sortedFeatures, hasCycle, cycleNodes } = topologicalSortFeatures(activeFeatures);
  const dirtyFeatures = sortedFeatures.filter((f) => f.isDirty);

  return {
    activeFeatures,
    sortedFeatures,
    dirtyFeatures,
    hasCycle,
    cycleNodes,
    validationErrors,
  };
}
