import type {
  CADFeature,
  SketchFeature,
  ExtrudeFeature,
  CutExtrudeFeature,
  DatumPlaneFeature,
  CustomPlane,
} from '../../types/cad';
import type { FeatureEvalOp } from './SolidEngine.types';

export function buildFeatureEvalOps(
  featureTree: CADFeature[],
  rollbackIndex: number,
  planesMap: Record<string, CustomPlane> = {}
): FeatureEvalOp[] {
  if (!featureTree || !Array.isArray(featureTree) || featureTree.length === 0) {
    return [];
  }

  const clampedIndex =
    typeof rollbackIndex === 'number'
      ? Math.max(0, Math.min(rollbackIndex, featureTree.length))
      : featureTree.length;

  const validFeatures = featureTree
    .slice(0, clampedIndex)
    .filter((f): f is CADFeature => Boolean(f && !f.suppressed));

  const sketchMap = new Map<string, SketchFeature>();
  const planeCache = new Map<string, CustomPlane>();

  if (planesMap) {
    for (const [key, plane] of Object.entries(planesMap)) {
      if (plane) {
        planeCache.set(key, plane);
        if (plane.id) {
          planeCache.set(plane.id, plane);
        }
      }
    }
  }

  for (const feature of validFeatures) {
    switch (feature.type) {
      case 'DATUM_PLANE': {
        const datumFeature = feature as DatumPlaneFeature;
        if (datumFeature.plane) {
          planeCache.set(datumFeature.id, datumFeature.plane);
        }
        break;
      }

      case 'SKETCH': {
        const sketchFeature = feature as SketchFeature;
        let activeSketch = sketchFeature;

        if (sketchFeature.planeFeatureId && planeCache.has(sketchFeature.planeFeatureId)) {
          const boundPlane = planeCache.get(sketchFeature.planeFeatureId)!;
          activeSketch = {
            ...sketchFeature,
            plane: boundPlane,
          };
        }

        sketchMap.set(activeSketch.id, activeSketch);
        break;
      }

      case 'EXTRUDE':
      case 'CUT_EXTRUDE':
      default:
        break;
    }
  }

  const ops: FeatureEvalOp[] = [];

  for (const feature of validFeatures) {
    if (feature.type === 'EXTRUDE') {
      const extrudeFeature = feature as ExtrudeFeature;
      const sketch = sketchMap.get(extrudeFeature.sketchId);

      if (sketch && sketch.profiles && sketch.profiles.length > 0) {
        const profileIds = extrudeFeature.profileIds;
        const profiles =
          profileIds && profileIds.length > 0
            ? sketch.profiles.filter((p) => profileIds.includes(p.id))
            : sketch.profiles;

        if (profiles.length > 0) {
          ops.push({
            featureId: extrudeFeature.id,
            type: 'EXTRUDE',
            operation: 'JOIN',
            profiles,
            plane: sketch.plane,
            depth: extrudeFeature.depth,
            direction: extrudeFeature.direction,
          });
        }
      }
    } else if (feature.type === 'CUT_EXTRUDE') {
      const cutFeature = feature as CutExtrudeFeature;
      const sketch = sketchMap.get(cutFeature.sketchId);

      if (sketch && sketch.profiles && sketch.profiles.length > 0) {
        const profileIds = cutFeature.profileIds;
        const profiles =
          profileIds && profileIds.length > 0
            ? sketch.profiles.filter((p) => profileIds.includes(p.id))
            : sketch.profiles;

        if (profiles.length > 0) {
          ops.push({
            featureId: cutFeature.id,
            type: 'CUT_EXTRUDE',
            operation: 'CUT',
            profiles,
            plane: sketch.plane,
            depth: cutFeature.depth,
            direction: cutFeature.direction,
            throughAll: cutFeature.throughAll,
          });
        }
      }
    }
  }

  return ops;
}
