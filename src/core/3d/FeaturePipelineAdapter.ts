import type {
  CADFeature,
  SketchFeature,
  ExtrudeFeature,
  CutExtrudeFeature,
  DatumPlaneFeature,
  CustomPlane,
} from '../../types/cad';
import type { FeatureEvalOp } from './SolidEngine.types';

/**
 * 將特徵樹轉譯給 Worker 的作業清單
 * 
 * @param featureTree 完整的 CAD 歷史特徵樹
 * @param rollbackIndex 當前回退棒索引，僅處理小於此索引的特徵
 * @param planesMap 選填的額外基準面地圖快取，提供預設基準面 (Front, Top, Right)
 * @returns 轉換後的 FeatureEvalOp 作業陣列，用於 SolidEngine 進行三維布林與拉伸計算
 */
export function buildFeatureEvalOps(
  featureTree: CADFeature[],
  rollbackIndex: number,
  planesMap: Record<string, CustomPlane> = {}
): FeatureEvalOp[] {
  if (!featureTree || !Array.isArray(featureTree) || featureTree.length === 0) {
    return [];
  }

  // 限制回退棒索引在合理範圍內
  const clampedIndex =
    typeof rollbackIndex === 'number'
      ? Math.max(0, Math.min(rollbackIndex, featureTree.length))
      : featureTree.length;

  // 取得目前有效的歷史特徵並濾除被抑制的特徵
  const validFeatures = featureTree
    .slice(0, clampedIndex)
    .filter((f): f is CADFeature => Boolean(f && !f.suppressed));

  const sketchMap = new Map<string, SketchFeature>();
  const planeCache = new Map<string, CustomPlane>();

  // 載入預設或已知的基準面
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

  // 第一階段：先建立基準面快取與草圖對照表，解析自訂基準面的具體姿態
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

        // 若草圖綁定於自訂基準面，更新其 plane 為計算後的空間面，確保特徵運算坐標正確
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

      default:
        break;
    }
  }

  const ops: FeatureEvalOp[] = [];

  // 第二階段：將拉伸與除料特徵轉換為對應的 FeatureEvalOp 運算作業
  for (const feature of validFeatures) {
    if (feature.type === 'EXTRUDE') {
      const extrudeFeature = feature as ExtrudeFeature;
      const sketch = sketchMap.get(extrudeFeature.sketchId);

      if (sketch && sketch.profiles && sketch.profiles.length > 0) {
        const profileIds = extrudeFeature.profileIds;
        // 篩選出特徵指定拉伸的 profile，若無指定則拉伸草圖內的所有 profile
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
        // 篩選出特徵指定除料的 profile，若無指定則除料草圖內的所有 profile
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
