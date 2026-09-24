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
  Point2D,
  Point3D,
  Vector3D,
  CADEntity2D,
  PolylineEntity,
  LineEntity,
  ArcEntity,
} from '../../types/cad';
import {
  DatumFrontPlane,
  DatumTopPlane,
  DatumRightPlane,
} from '../../types/cad';
import type { FeatureEvalOp, FeatureTransform } from './SolidEngine.types';
import type { TopoReference } from './PersistentTopology.types';
import { findClosedProfiles } from '../2d/TopologyEngine';
import { getArcMidPoint } from '../2d/GeometryMath';
import { decomposePolylineToEntities } from '../2d/PolylineUtils';

/**
 * 向量正規化輔助函式
 */
export function normalizeVec3(v: Vector3D): Vector3D {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-7) return { x: 1, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * 2D 局部點映射至 3D 世界點的純函數
 */
export function mapPoint2DTo3D(pt: Point2D, plane: CustomPlane): Point3D {
  return {
    x: plane.origin.x + pt.x * plane.xAxis.x + pt.y * plane.yAxis.x,
    y: plane.origin.y + pt.x * plane.xAxis.y + pt.y * plane.yAxis.y,
    z: plane.origin.z + pt.x * plane.xAxis.z + pt.y * plane.yAxis.z,
  };
}

/**
 * 2D 局部向量映射至 3D 世界向量的純函數
 */
export function mapVector2DTo3D(vec: Point2D, plane: CustomPlane): Vector3D {
  return {
    x: vec.x * plane.xAxis.x + vec.y * plane.yAxis.x,
    y: vec.x * plane.xAxis.y + vec.y * plane.yAxis.y,
    z: vec.x * plane.xAxis.z + vec.y * plane.yAxis.z,
  };
}

/**
 * 編譯後的特徵執行計畫 (Architecture Contract v1)
 */
export interface CompiledFeaturePlan {
  /**
   * 欲傳入 OCC Worker 的純粹幾何操作序列 (FeatureEvalOp[])
   */
  operations: FeatureEvalOp[];

  /**
   * History Index (CADDocument.featureTree[]) → Operation Index (FeatureEvalOp[])
   * 若該 History Feature 不產生 Operation (如 SKETCH, DATUM_PLANE, 未定義輪廓等)，對應值為 null。
   * 陣列長度嚴格等於 featureTree.length。
   */
  historyToOpIndex: Array<number | null>;

  /**
   * Feature ID → Operation Index (FeatureEvalOp[])
   */
  featureIdToOpIndex: Record<string, number>;

  /**
   * 第一個需要重新執行的 Operation Index。
   * null 表示沒有需要執行的 3D Operation（如僅為回退棒移動、全命中快取、或僅末端草圖被編輯）。
   */
  dirtyOpIndex: number | null;
}

/**
 * 將特徵樹編譯為結構化執行計畫 (CompiledFeaturePlan)
 * 嚴格維護 History Index 與 Operation Index 邊界
 */
export function compileFeaturePlan(
  featureTree: CADFeature[],
  rollbackIndex: number,
  planesMap: Record<string, CustomPlane> = {},
  dirtyFromHistoryIndex?: number | null,
  dirtyFeatureId?: string | null
): CompiledFeaturePlan {
  if (!featureTree || !Array.isArray(featureTree) || featureTree.length === 0) {
    return {
      operations: [],
      historyToOpIndex: [],
      featureIdToOpIndex: {},
      dirtyOpIndex: null,
    };
  }

  const clampedIndex =
    typeof rollbackIndex === 'number'
      ? Math.max(0, Math.min(rollbackIndex, featureTree.length))
      : featureTree.length;

  const sketchMap = new Map<string, SketchFeature>();
  const planeCache = new Map<string, CustomPlane>();

  planeCache.set('datum-front', DatumFrontPlane);
  planeCache.set('datum-top', DatumTopPlane);
  planeCache.set('datum-right', DatumRightPlane);

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

  // 第一階段：基準面與草圖對照表建構（僅限 active features）
  for (let h = 0; h < clampedIndex; h++) {
    const feature = featureTree[h];
    if (!feature || feature.suppressed) continue;

    try {
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
          const attachedRef = sketchFeature.attachedFaceRef || sketchFeature.plane?.attachedFaceRef;
          if (attachedRef) {
            activeSketch = {
              ...activeSketch,
              attachedFaceRef: attachedRef,
              plane: {
                ...activeSketch.plane,
                attachedFaceRef: attachedRef,
              },
            };
          }
          sketchMap.set(activeSketch.id, activeSketch);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.warn(`FeaturePipelineAdapter: Failed to resolve feature setup for ${feature.id}:`, err);
    }
  }

  const ops: FeatureEvalOp[] = [];
  const historyToOpIndex: Array<number | null> = new Array(featureTree.length).fill(null);
  const featureIdToOpIndex: Record<string, number> = {};
  const compiledOpsByFeatureId = new Map<string, FeatureEvalOp>();

  // 第二階段：依序走訪特徵產生運算指令，並建立精確 Mapping
  for (let h = 0; h < clampedIndex; h++) {
    const feature = featureTree[h];
    if (!feature || feature.suppressed) {
      continue;
    }

    const prevOpsLen = ops.length;
    try {
      if (feature.type === 'EXTRUDE') {
        const extrudeFeature = feature as ExtrudeFeature;
        const sketch = sketchMap.get(extrudeFeature.sketchId);

        
        let availableProfiles = sketch ? sketch.profiles : [];
        if (sketch && (!availableProfiles || availableProfiles.length === 0)) {
          availableProfiles = findClosedProfiles(sketch.entities, sketch.constraints);
        }
        if (sketch && availableProfiles && availableProfiles.length > 0) {

          const profileIds = extrudeFeature.profileIds;
          const profiles =
            profileIds && profileIds.length > 0
              ? availableProfiles.filter((p) => profileIds.includes(p.id))
              : availableProfiles;

          if (profiles.length > 0) {
            const attachedRef = sketch.attachedFaceRef || sketch.plane?.attachedFaceRef;
            let opPlane = sketch.plane;
            if (attachedRef) {
              opPlane = { ...opPlane, attachedFaceRef: attachedRef };
            }
            ops.push({
              featureId: extrudeFeature.id,
              type: 'EXTRUDE',
              operation: 'JOIN',
              profiles,
              plane: opPlane,
              sketchId: extrudeFeature.sketchId,
              depth: typeof extrudeFeature.depth === 'number' ? extrudeFeature.depth : 10,
              direction: extrudeFeature.direction || 'normal',
            });
          }
        }
      } else if (feature.type === 'CUT_EXTRUDE') {
        const cutFeature = feature as CutExtrudeFeature;
        const sketch = sketchMap.get(cutFeature.sketchId);

        
        let availableProfiles = sketch ? sketch.profiles : [];
        if (sketch && (!availableProfiles || availableProfiles.length === 0)) {
          availableProfiles = findClosedProfiles(sketch.entities, sketch.constraints);
        }
        if (sketch && availableProfiles && availableProfiles.length > 0) {

          const profileIds = cutFeature.profileIds;
          const profiles =
            profileIds && profileIds.length > 0
              ? availableProfiles.filter((p) => profileIds.includes(p.id))
              : availableProfiles;

          if (profiles.length > 0) {
            const attachedRef = sketch.attachedFaceRef || sketch.plane?.attachedFaceRef;
            let opPlane = sketch.plane;
            if (attachedRef) {
              opPlane = { ...opPlane, attachedFaceRef: attachedRef };
            }
            ops.push({
              featureId: cutFeature.id,
              type: 'CUT_EXTRUDE',
              operation: 'CUT',
              profiles,
              plane: opPlane,
              sketchId: cutFeature.sketchId,
              depth: typeof cutFeature.depth === 'number' ? cutFeature.depth : 10,
              direction: cutFeature.direction || 'normal',
              throughAll: cutFeature.throughAll,
            });
          }
        }
      } else if (feature.type === 'REVOLVE' || feature.type === 'REVOLVE_CUT') {
        const revFeature = feature as RevolveFeature | RevolveCutFeature;
        const sk = sketchMap.get(revFeature.sketchId);

        
        let availableProfiles = sk ? sk.profiles : [];
        if (sk && (!availableProfiles || availableProfiles.length === 0)) {
          availableProfiles = findClosedProfiles(sk.entities, sk.constraints);
        }
        if (sk && availableProfiles && availableProfiles.length > 0) {

          const attachedRef = sk.attachedFaceRef || sk.plane?.attachedFaceRef;
          let opPlane = sk.plane;
          if (attachedRef) {
            opPlane = { ...opPlane, attachedFaceRef: attachedRef };
          }
          const plane = opPlane;
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
            axisOrigin = mapPoint2DTo3D(axisLine.start, plane);
            const pEnd3D = mapPoint2DTo3D(axisLine.end, plane);
            axisDirection = normalizeVec3({
              x: pEnd3D.x - axisOrigin.x,
              y: pEnd3D.y - axisOrigin.y,
              z: pEnd3D.z - axisOrigin.z,
            });
          } else {
            axisOrigin = { x: plane.origin.x, y: plane.origin.y, z: plane.origin.z };
            axisDirection = normalizeVec3({ x: plane.yAxis.x, y: plane.yAxis.y, z: plane.yAxis.z });
          }

          let angleRad = revFeature.angle ?? (2 * Math.PI);
          if (Math.abs(angleRad) > 2 * Math.PI + 1e-4) {
            angleRad = (angleRad * Math.PI) / 180;
          }

          const profileIds = revFeature.profileIds;
          const targetProfiles =
            profileIds && profileIds.length > 0
              ? availableProfiles.filter((p) => profileIds.includes(p.id))
              : availableProfiles;

          if (targetProfiles.length > 0) {
            ops.push({
              featureId: revFeature.id,
              type: revFeature.type,
              operation: revFeature.type === 'REVOLVE' ? 'JOIN' : 'CUT',
              profiles: targetProfiles,
              plane: opPlane,
              sketchId: revFeature.sketchId,
              axis: {
                origin: axisOrigin,
                direction: axisDirection,
              },
              angle: angleRad,
            });
          }
        }
      } else if (feature.type === 'LINEAR_PATTERN') {
        const feat = feature as LinearPatternFeature;
        const dir1 = normalizeVec3(feat.dir1);
        const dir2 = feat.dir2 ? normalizeVec3(feat.dir2) : undefined;
        const count1 = Math.max(1, feat.count1 || 2);
        const spacing1 = feat.spacing1 || 0;
        const count2 = feat.count2 ? Math.max(1, feat.count2) : 1;
        const spacing2 = feat.spacing2 || 0;
        const targetIds = feat.targetFeatureIds || [];

        let unrolledCount = 0;
        for (let pIdx = 0; pIdx < count1; pIdx++) {
          for (let qIdx = 0; qIdx < count2; qIdx++) {
            if (pIdx === 0 && qIdx === 0) continue;

            const dx = pIdx * spacing1 * dir1.x + qIdx * spacing2 * (dir2?.x || 0);
            const dy = pIdx * spacing1 * dir1.y + qIdx * spacing2 * (dir2?.y || 0);
            const dz = pIdx * spacing1 * dir1.z + qIdx * spacing2 * (dir2?.z || 0);

            const transform: FeatureTransform = {
              type: 'translation',
              translation: { x: dx, y: dy, z: dz },
            };

            for (const tid of targetIds) {
              const origOp = compiledOpsByFeatureId.get(tid);
              if (origOp) {
                const unrolledOp: FeatureEvalOp = {
                  ...origOp,
                  featureId: `${feat.id}_unroll_${tid}_p${pIdx}_q${qIdx}`,
                  parentPatternFeatureId: feat.id,
                  originalFeatureId: tid,
                  transform,
                  sketchId: undefined,
                  profiles: undefined,
                  plane: undefined,
                  attachedFaceRef: undefined,
                };
                ops.push(unrolledOp);
                unrolledCount++;
              }
            }
          }
        }

        if (unrolledCount === 0) {
          ops.push({
            featureId: feat.id,
            type: 'LINEAR_PATTERN',
            operation: 'JOIN',
            targetFeatureIds: targetIds,
            profiles: [],
            plane: DatumFrontPlane,
            patternLinear: {
              dir1,
              count1,
              spacing1,
              dir2,
              count2,
              spacing2,
            },
          });
        }
      } else if (feature.type === 'CIRCULAR_PATTERN') {
        const feat = feature as CircularPatternFeature;
        const patternAxisEdgeRef = (feat as any).axisEdgeRef || (feat as any).axis?.edgeRef;
        const axisDir = normalizeVec3(feat.axisDirection || (feat as any).axis?.direction || { x: 0, y: 0, z: 1 });
        const axisOrigin = feat.axisOrigin || (feat as any).axis?.origin || { x: 0, y: 0, z: 0 };
        const count = Math.max(1, feat.count || 2);
        let totalAngle = typeof feat.totalAngle === 'number' && !isNaN(feat.totalAngle) ? feat.totalAngle : 2 * Math.PI;
        if (Math.abs(totalAngle) > 2 * Math.PI + 0.1) {
          totalAngle = (totalAngle * Math.PI) / 180;
        }
        const equalSpacing = feat.equalSpacing ?? true;
        const isSymmetric = Boolean(feat.isSymmetric);
        const targetIds = feat.targetFeatureIds || [];

        let deltaTheta = 0;
        if (equalSpacing) {
          const isFullCircle = Math.abs(Math.abs(totalAngle) - 2 * Math.PI) < 1e-4;
          if (isFullCircle) {
            deltaTheta = totalAngle / count;
          } else {
            deltaTheta = count > 1 ? totalAngle / (count - 1) : totalAngle;
          }
        } else {
          deltaTheta = totalAngle;
        }

        const opAxis = {
          origin: axisOrigin,
          direction: axisDir,
          edgeRef: patternAxisEdgeRef,
        };

        let unrolledCount = 0;
        for (let k = 0; k < count; k++) {
          const angle = isSymmetric
            ? -(totalAngle / 2) + k * deltaTheta
            : k * deltaTheta;

          if (Math.abs(angle) < 1e-7) continue;

          const transform: FeatureTransform = {
            type: 'rotation',
            rotationAx1: {
              origin: axisOrigin,
              direction: axisDir,
              angle,
              axisEdgeRef: patternAxisEdgeRef,
            },
          };

          for (const tid of targetIds) {
            const origOp = compiledOpsByFeatureId.get(tid);
            if (origOp) {
              const unrolledOp: FeatureEvalOp = {
                ...origOp,
                featureId: `${feat.id}_unroll_${tid}_k${k}`,
                parentPatternFeatureId: feat.id,
                originalFeatureId: tid,
                transform,
                axis: opAxis,
                axisEdgeRef: patternAxisEdgeRef,
                // 💥 強制斬斷草圖殭屍相依性！這是一個純幾何變換，不需要重新求值草圖！
                sketchId: undefined,
                profiles: undefined,
                plane: undefined,
                attachedFaceRef: undefined,
              };
              ops.push(unrolledOp);
              unrolledCount++;
            }
          }
        }

        if (unrolledCount === 0) {
          ops.push({
            featureId: feat.id,
            type: 'CIRCULAR_PATTERN',
            operation: 'JOIN',
            targetFeatureIds: targetIds,
            profiles: [],
            plane: DatumFrontPlane,
            axis: opAxis,
            axisEdgeRef: patternAxisEdgeRef,
            patternCircular: {
              axis: {
                origin: axisOrigin,
                direction: axisDir,
              },
              axisEdgeRef: patternAxisEdgeRef,
              count,
              totalAngle,
              equalSpacing,
              isSymmetric,
            },
          });
        }
      } else if (feature.type === 'MIRROR_3D') {
        const feat = feature as Mirror3DFeature;
        let origin: Point3D = { x: 0, y: 0, z: 0 };
        let normal: Vector3D = { x: 0, y: 0, z: 1 };
        let refPlane: CustomPlane | undefined;

        const planeId = feat.mirrorPlane?.planeId || feat.mirrorPlaneFeatureId;

        if (planeId && planeCache.has(planeId)) {
          refPlane = planeCache.get(planeId);
          if (refPlane) {
            origin = refPlane.origin;
            normal = normalizeVec3(refPlane.normal);
          }
        } else if (planeId && planesMap && planesMap[planeId]) {
          refPlane = planesMap[planeId];
          if (refPlane) {
            origin = refPlane.origin;
            normal = normalizeVec3(refPlane.normal);
          }
        } else if (feat.mirrorPlane?.origin && feat.mirrorPlane?.normal) {
          origin = feat.mirrorPlane.origin;
          normal = normalizeVec3(feat.mirrorPlane.normal);
        } else if (feat.mirrorPlaneFeatureId) {
          const found = planeCache.get(feat.mirrorPlaneFeatureId) || (planesMap && planesMap[feat.mirrorPlaneFeatureId]);
          if (found) {
            refPlane = found;
            origin = found.origin;
            normal = normalizeVec3(found.normal);
          }
        }

        const targetIds = feat.targetFeatureIds || [];
        const transform: FeatureTransform = {
          type: 'mirror',
          mirrorPlane: { origin, normal },
        };

        let unrolledCount = 0;
        for (const tid of targetIds) {
          const origOp = compiledOpsByFeatureId.get(tid);
          if (origOp) {
            const unrolledOp: FeatureEvalOp = {
              ...origOp,
              featureId: `${feat.id}_unroll_${tid}_mirror`,
              parentPatternFeatureId: feat.id,
              originalFeatureId: tid,
              transform,
            };
            ops.push(unrolledOp);
            unrolledCount++;
          }
        }

        if (unrolledCount === 0) {
          const mirrorPlaneConfig = {
            planeId,
            origin,
            normal,
          };

          ops.push({
            featureId: feat.id,
            type: 'MIRROR_3D',
            operation: 'JOIN',
            targetFeatureIds: targetIds,
            profiles: [],
            plane: refPlane || DatumFrontPlane,
            mirrorPlane: mirrorPlaneConfig,
            mirror3D: mirrorPlaneConfig,
          });
        }
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
            mid?: Point3D;
            center?: Point3D;
            radius?: number;
            clockwise?: boolean;
            sweepFlag?: number | boolean;
          }[] = [];

          // 收集所有有效路徑幾何圖元 (若為 Polyline 則打散為 line 與 arc)
          const rawEntities: CADEntity2D[] = [];
          for (const entity of pathSk.entities) {
            if (entity.isConstruction) continue;
            if (entity.type === 'polyline') {
              const decomposed = decomposePolylineToEntities(entity as PolylineEntity);
              rawEntities.push(...decomposed);
            } else {
              rawEntities.push(entity);
            }
          }

          for (const entity of rawEntities) {
            if (entity.type === 'line') {
              const line = entity as LineEntity;
              pathSegments.push({
                type: 'line',
                start: mapPoint2DTo3D(line.start, pathSk.plane),
                end: mapPoint2DTo3D(line.end, pathSk.plane),
              });
            } else if (entity.type === 'arc') {
              const arc = entity as ArcEntity;
              const isCW = Boolean(arc.clockwise);
              const start2D = {
                x: arc.center.x + arc.radius * Math.cos(arc.startAngle),
                y: arc.center.y + arc.radius * Math.sin(arc.startAngle),
              };
              const end2D = {
                x: arc.center.x + arc.radius * Math.cos(arc.endAngle),
                y: arc.center.y + arc.radius * Math.sin(arc.endAngle),
              };
              const mid2D = getArcMidPoint(arc);

              pathSegments.push({
                type: 'arc',
                start: mapPoint2DTo3D(start2D, pathSk.plane),
                end: mapPoint2DTo3D(end2D, pathSk.plane),
                mid: mapPoint2DTo3D(mid2D, pathSk.plane),
                center: mapPoint2DTo3D(arc.center, pathSk.plane),
                radius: arc.radius,
                clockwise: isCW,
                sweepFlag: isCW ? 1 : 0,
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
              sweepData: { pathSegments },
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
            
        let availableProfiles = sk ? sk.profiles : [];
        if (sk && (!availableProfiles || availableProfiles.length === 0)) {
          availableProfiles = findClosedProfiles(sk.entities, sk.constraints);
        }
        if (sk && availableProfiles && availableProfiles.length > 0) {

              sections.push({
                profiles: availableProfiles,
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
          plane: DatumFrontPlane,
          fillet3D: {
            radius: Math.max(0.1, feat.radius || 2),
            edgeSelectionMode: feat.edgeSelectionMode || 'all',
            edgeRefs: feat.edgeRefs || [],
            edgeIndices: feat.edgeIndices || [],
          },
        });
      } else if (feature.type === 'CHAMFER_3D') {
        const feat = feature as Chamfer3DFeature;
        ops.push({
          featureId: feat.id,
          type: 'CHAMFER_3D',
          operation: 'JOIN',
          profiles: [],
          plane: DatumFrontPlane,
          chamfer3D: {
            distance: Math.max(0.1, feat.distance || 2),
            edgeSelectionMode: feat.edgeSelectionMode || 'all',
            edgeRefs: feat.edgeRefs || [],
            edgeIndices: feat.edgeIndices || [],
          },
        });
      } else if (feature.type === 'SHELL_3D') {
        const feat = feature as Shell3DFeature;
        ops.push({
          featureId: feat.id,
          type: 'SHELL_3D',
          operation: 'JOIN',
          profiles: [],
          plane: DatumFrontPlane,
          shell3D: {
            thickness: Math.max(0.1, feat.thickness || 1.5),
            direction: feat.direction || 'inside',
            removedFaceRefs: feat.removedFaceRefs || [],
            faceIndices: feat.faceIndices || [],
          },
        });
      }
    } catch (err) {
      console.warn(`FeaturePipelineAdapter: Error processing feature ${feature.id} (${feature.type}):`, err);
    }

    // 若此特徵成功產生 3D Operation
    if (ops.length > prevOpsLen) {
      const opIndex = prevOpsLen;
      historyToOpIndex[h] = opIndex;
      featureIdToOpIndex[feature.id] = opIndex;
      compiledOpsByFeatureId.set(feature.id, ops[opIndex]);
    }
  }

  // 第三階段：Architecture Contract v1 — 精確推導 dirtyOpIndex
  let dirtyOpIndex: number | null = null;
  if (typeof dirtyFromHistoryIndex === 'number' && dirtyFromHistoryIndex >= 0) {
    for (let h = Math.max(0, dirtyFromHistoryIndex); h < clampedIndex; h++) {
      const opIdx = historyToOpIndex[h];
      if (opIdx !== null && opIdx !== undefined) {
        dirtyOpIndex = opIdx;
        break;
      }
    }
  } else if (dirtyFeatureId) {
    const dirtyH = featureTree.findIndex((f) => f.id === dirtyFeatureId);
    if (dirtyH >= 0) {
      for (let h = Math.max(0, dirtyH); h < clampedIndex; h++) {
        const opIdx = historyToOpIndex[h];
        if (opIdx !== null && opIdx !== undefined) {
          dirtyOpIndex = opIdx;
          break;
        }
      }
    }
  }

  return {
    operations: ops,
    historyToOpIndex,
    featureIdToOpIndex,
    dirtyOpIndex,
  };
}

/**
 * 將特徵樹轉譯為 Worker 執行的標準作業清單 (FeatureEvalOp[])
 * 向下相容函式：委派給 compileFeaturePlan 並取出 operations
 */
export function buildFeatureEvalOps(
  featureTree: CADFeature[],
  rollbackIndex: number,
  planesMap: Record<string, CustomPlane> = {}
): FeatureEvalOp[] {
  return compileFeaturePlan(featureTree, rollbackIndex, planesMap).operations;
}
