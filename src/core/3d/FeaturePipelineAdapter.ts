import type {
  CADFeature,
  SketchFeature,
  ExtrudeFeature,
  CutExtrudeFeature,
  RevolveFeature,
  RevolveCutFeature,
  LinearPatternFeature,
  CircularPatternFeature,
  Mirror3DFeature,
  SweepFeature,
  LoftFeature,
  Fillet3DFeature,
  Chamfer3DFeature,
  Shell3DFeature,
  DatumPlaneFeature,
  CustomPlane,
  Point3D,
  LineEntity,
  ArcEntity,
} from '../../types/cad';
import {
  DatumFrontPlane,
  DatumTopPlane,
  DatumRightPlane,
} from '../../types/cad';
import type { FeatureEvalOp } from './SolidEngine.types';

/**
 * 向量正規化輔助函式
 *
 * @param v 待正規化之三維向量 { x, y, z }
 * @returns 正規化後的單位向量 { x, y, z }
 */
export function normalizeVec3(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-6) return { x: 1, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * 2D 局部點映射至 3D 世界點的純函數
 * 
 * @param pt 2D 草圖平面上的局部點 (x, y)
 * @param plane 草圖所屬之 3D 空間基準面
 * @returns 轉換後的 3D 世界座標點 (x, y, z)
 */
export function mapPoint2DTo3D(
  pt: { x: number; y: number },
  plane: CustomPlane
): { x: number; y: number; z: number } {
  return {
    x: plane.origin.x + pt.x * plane.xAxis.x + pt.y * plane.yAxis.x,
    y: plane.origin.y + pt.x * plane.xAxis.y + pt.y * plane.yAxis.y,
    z: plane.origin.z + pt.x * plane.xAxis.z + pt.y * plane.yAxis.z,
  };
}

/**
 * 將特徵樹轉譯給 Worker 的作業清單
 * 
 * @param featureTree 完整的 CAD 歷史特徵樹
 * @param rollbackIndex 當前的歷史回退棒索引，僅處理小於此索引的特徵
 * @param planesMap 選填的額外基準面快取，提供預設基準面 (Front, Top, Right)
 * @returns 轉換後的 FeatureEvalOp 作業陣列，用於 SolidEngine 進行三維布林、長料與除料計算
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

  // 截取未抑制的歷史特徵切片
  const validFeatures = featureTree
    .slice(0, clampedIndex)
    .filter((f): f is CADFeature => Boolean(f && !f.suppressed));

  const sketchMap = new Map<string, SketchFeature>();
  const planeCache = new Map<string, CustomPlane>();

  // 預設填入三大標準基準面至 planeCache
  planeCache.set('datum-front', DatumFrontPlane);
  planeCache.set('datum-top', DatumTopPlane);
  planeCache.set('datum-right', DatumRightPlane);

  // 載入額外或已知的基準面快取
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

  // 第一階段：建立基準面快取與草圖對照表，解析自訂基準面的具體姿態
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

  // 第二階段：走訪特徵切片，轉譯為 FeatureEvalOp 作業陣列
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
    } else if (feature.type === 'REVOLVE' || feature.type === 'REVOLVE_CUT') {
      const revFeature = feature as RevolveFeature | RevolveCutFeature;
      const sk = sketchMap.get(revFeature.sketchId);

      if (sk && sk.profiles && sk.profiles.length > 0) {
        // 尋找作為旋轉軸的直線圖元
        let axisLine: LineEntity | undefined;

        if (sk.entities && sk.entities.length > 0) {
          if (revFeature.axisEntityId) {
            const found = sk.entities.find(
              (e) => e.id === revFeature.axisEntityId && e.type === 'line'
            );
            if (found) {
              axisLine = found as LineEntity;
            }
          }

          // 若未指定或找不到指定直線，預設尋找草圖中第一條建構線（isConstruction: true）或第一條直線作為回退備援
          if (!axisLine) {
            const constrLine = sk.entities.find(
              (e) => e.type === 'line' && Boolean(e.isConstruction)
            );
            if (constrLine) {
              axisLine = constrLine as LineEntity;
            } else {
              const firstLine = sk.entities.find((e) => e.type === 'line');
              if (firstLine) {
                axisLine = firstLine as LineEntity;
              }
            }
          }
        }

        let axisOrigin: Point3D;
        let axisDirection: Point3D;

        if (axisLine) {
          // 利用 mapPoint2DTo3D 將 axisLine.start 轉為 3D 原點 axisOrigin
          const start3D = mapPoint2DTo3D(axisLine.start, sk.plane);
          const end3D = mapPoint2DTo3D(axisLine.end, sk.plane);
          const dx = end3D.x - start3D.x;
          const dy = end3D.y - start3D.y;
          const dz = end3D.z - start3D.z;
          const len = Math.hypot(dx, dy, dz);

          axisOrigin = start3D;
          axisDirection =
            len > 1e-9
              ? { x: dx / len, y: dy / len, z: dz / len }
              : {
                  x: sk.plane.yAxis.x,
                  y: sk.plane.yAxis.y,
                  z: sk.plane.yAxis.z,
                };
        } else {
          // 若無任何直線圖元可作軸線，回退使用基準面原點與 Y 軸向量
          axisOrigin = {
            x: sk.plane.origin.x,
            y: sk.plane.origin.y,
            z: sk.plane.origin.z,
          };
          axisDirection = {
            x: sk.plane.yAxis.x,
            y: sk.plane.yAxis.y,
            z: sk.plane.yAxis.z,
          };
        }

        // 篩選指定之 profileIds
        const profileIds = revFeature.profileIds;
        const targetProfiles =
          profileIds && profileIds.length > 0
            ? sk.profiles.filter((p) => profileIds.includes(p.id))
            : sk.profiles;

        if (targetProfiles.length > 0) {
          ops.push({
            featureId: revFeature.id,
            type: revFeature.type,
            operation: revFeature.type === 'REVOLVE' ? 'JOIN' : 'CUT',
            profiles: targetProfiles,
            plane: sk.plane,
            axis: {
              origin: axisOrigin,
              direction: axisDirection,
            },
            angle: revFeature.angle || 2 * Math.PI,
          });
        }
      }
    } else if (feature.type === 'LINEAR_PATTERN') {
      const feat = feature as LinearPatternFeature;
      const dir1 = normalizeVec3(feat.dir1);
      const dir2 = feat.dir2 ? normalizeVec3(feat.dir2) : undefined;

      ops.push({
        featureId: feat.id,
        type: 'LINEAR_PATTERN',
        operation: 'JOIN',
        targetFeatureIds: feat.targetFeatureIds,
        profiles: [],
        plane: {
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
        },
        patternLinear: {
          dir1,
          count1: Math.max(2, feat.count1 || 2),
          spacing1: feat.spacing1,
          dir2: feat.dir2 ? dir2 : undefined,
          count2: feat.count2 ? Math.max(1, feat.count2) : undefined,
          spacing2: feat.spacing2,
        },
      });
    } else if (feature.type === 'CIRCULAR_PATTERN') {
      const feat = feature as CircularPatternFeature;
      const axisDir = normalizeVec3(feat.axisDirection);

      ops.push({
        featureId: feat.id,
        type: 'CIRCULAR_PATTERN',
        operation: 'JOIN',
        targetFeatureIds: feat.targetFeatureIds,
        profiles: [],
        plane: {
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
        },
        patternCircular: {
          axis: {
            origin: feat.axisOrigin || { x: 0, y: 0, z: 0 },
            direction: axisDir,
          },
          count: Math.max(2, feat.count || 2),
          totalAngle: feat.totalAngle || 2 * Math.PI,
          equalSpacing: feat.equalSpacing ?? true,
        },
      });
    } else if (feature.type === 'MIRROR_3D') {
      const feat = feature as Mirror3DFeature;
      const refPlane = planeCache.get(feat.mirrorPlaneFeatureId) || {
        id: 'default-mirror-plane',
        name: 'Default Mirror Plane',
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
      };

      ops.push({
        featureId: feat.id,
        type: 'MIRROR_3D',
        operation: 'JOIN',
        targetFeatureIds: feat.targetFeatureIds,
        profiles: [],
        plane: refPlane,
        mirrorPlane: {
          origin: refPlane.origin,
          normal: normalizeVec3(refPlane.normal),
        },
      });
    } else if (feature.type === 'SWEEP') {
      const feat = feature as SweepFeature;
      const profileSk = sketchMap.get(feat.profileSketchId);
      const pathSk = sketchMap.get(feat.pathSketchId);

      if (
        profileSk &&
        pathSk &&
        profileSk.profiles &&
        profileSk.profiles.length > 0 &&
        pathSk.entities &&
        pathSk.entities.length > 0
      ) {
        const pathSegments: {
          type: 'line' | 'arc';
          start: Point3D;
          end: Point3D;
          center?: Point3D;
          radius?: number;
        }[] = [];

        for (const entity of pathSk.entities) {
          if (entity.isConstruction) continue;

          if (entity.type === 'line') {
            const line = entity as LineEntity;
            pathSegments.push({
              type: 'line',
              start: mapPoint2DTo3D(line.start, pathSk.plane),
              end: mapPoint2DTo3D(line.end, pathSk.plane),
            });
          } else if (entity.type === 'arc') {
            const arc = entity as ArcEntity;
            const start2D = {
              x: arc.center.x + arc.radius * Math.cos(arc.startAngle),
              y: arc.center.y + arc.radius * Math.sin(arc.startAngle),
            };
            const end2D = {
              x: arc.center.x + arc.radius * Math.cos(arc.endAngle),
              y: arc.center.y + arc.radius * Math.sin(arc.endAngle),
            };

            pathSegments.push({
              type: 'arc',
              start: mapPoint2DTo3D(start2D, pathSk.plane),
              end: mapPoint2DTo3D(end2D, pathSk.plane),
              center: mapPoint2DTo3D(arc.center, pathSk.plane),
              radius: arc.radius,
            });
          }
        }

        if (pathSegments.length > 0) {
          ops.push({
            featureId: feat.id,
            type: 'SWEEP',
            operation: 'JOIN',
            profiles: profileSk.profiles,
            plane: profileSk.plane,
            sweepData: {
              pathSegments,
            },
          });
        }
      }
    } else if (feature.type === 'LOFT') {
      const feat = feature as LoftFeature;
      if (feat.sketchIds && Array.isArray(feat.sketchIds) && feat.sketchIds.length >= 2) {
        const sections: {
          profiles: SketchFeature['profiles'];
          plane: CustomPlane;
        }[] = [];

        for (const skId of feat.sketchIds) {
          const sk = sketchMap.get(skId);
          if (sk && sk.profiles && sk.profiles.length > 0) {
            sections.push({
              profiles: sk.profiles,
              plane: sk.plane,
            });
          }
        }

        if (sections.length >= 2) {
          ops.push({
            featureId: feat.id,
            type: 'LOFT',
            operation: 'JOIN',
            profiles: [],
            plane: sections[0].plane,
            loftData: {
              sections,
              isSolid: feat.isSolid ?? true,
              ruled: feat.ruled ?? false,
            },
          });
        }
      }
    } else if (feature.type === 'FILLET_3D') {
      const feat = feature as Fillet3DFeature;
      ops.push({
        featureId: feat.id,
        type: 'FILLET_3D',
        operation: 'JOIN',
        profiles: [],
        plane: {
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
        },
        fillet3D: {
          radius: Math.max(0.1, feat.radius || 2),
          edgeSelectionMode: feat.edgeSelectionMode || 'all',
        },
      });
    } else if (feature.type === 'CHAMFER_3D') {
      const feat = feature as Chamfer3DFeature;
      ops.push({
        featureId: feat.id,
        type: 'CHAMFER_3D',
        operation: 'JOIN',
        profiles: [],
        plane: {
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
        },
        chamfer3D: {
          distance: Math.max(0.1, feat.distance || 2),
          edgeSelectionMode: feat.edgeSelectionMode || 'all',
        },
      });
    } else if (feature.type === 'SHELL_3D') {
      const feat = feature as Shell3DFeature;
      ops.push({
        featureId: feat.id,
        type: 'SHELL_3D',
        operation: 'JOIN',
        profiles: [],
        plane: {
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
        },
        shell3D: {
          thickness: Math.max(0.1, feat.thickness || 1.5),
          direction: feat.direction || 'inside',
        },
      });
    }
  }

  return ops;
}
