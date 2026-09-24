import React, { useMemo } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import {
  SketchFeature,
  CustomPlane,
  DatumFrontPlane,
  LineEntity,
  CircleEntity,
  ArcEntity,
  PolylineEntity,
  Point2D,
} from '../types/cad';
import { mapPoint2DTo3D } from '../core/3d/FeaturePipelineAdapter';
import { getArcSweepAngle } from '../core/2d/GeometryMath';

/**
 * 在 3D 視圖中將草圖圖元投影至對應基準面呈現 3D 線條
 * 讓使用者在進行 3D 建模、拉伸長料與除料時，能清晰辨識草圖輪廓與幾何位置。
 */
export const Sketch3DRenderer: React.FC = () => {
  const featureTree = useCADStore((state) => state.document.featureTree);
  const rollbackIndex = useCADStore((state) => state.document.rollbackIndex);
  const activeSketchId = useCADStore((state) => state.activeSketchId);
  const extrudePreview = useCADStore((state) => state.extrudePreview);
  const revolvePreview = useCADStore((state) => state.revolvePreview);

  const activeSlice = useMemo(() => {
    return (featureTree || []).slice(0, Math.max(0, rollbackIndex ?? 0));
  }, [featureTree, rollbackIndex]);

  const sketches = useMemo(() => {
    return activeSlice.filter(
      (f): f is SketchFeature => f.type === 'SKETCH' && !f.suppressed && f.visible !== false
    );
  }, [activeSlice]);

  const editingFeatureId = featureTree && typeof rollbackIndex === 'number' && rollbackIndex < featureTree.length ? featureTree[rollbackIndex]?.id : null;
  const previewFeatureId = extrudePreview?.isOpen ? (editingFeatureId || extrudePreview.sketchId) : null;
  const canonicalFeatureIds = useMemo(() => activeSlice.map((f) => f.id), [activeSlice]);
  const canonicalSolidIds = useMemo(() => {
    return activeSlice
      .filter((f) => f.type === 'EXTRUDE' || f.type === 'CUT_EXTRUDE' || f.type === 'REVOLVE' || f.type === 'REVOLVE_CUT' || f.type === 'SWEEP' || f.type === 'LOFT')
      .map((f) => f.id);
  }, [activeSlice]);
  const renderedSketchIds = useMemo(() => sketches.map((s) => s.id), [sketches]);

  console.log('[EDIT TRACE] Sketch3DRenderer', {
    editingFeatureId,
    rollbackIndex,
    canonicalFeatureIds,
    canonicalSolidIds,
    previewFeatureId,
    renderedSolidFeatureIds: canonicalSolidIds,
    renderedSketchIds,
  });

  // 為每個草圖建構 3D 頂點段 (每 2 頂點構成一條線段，供 lineSegments 批次渲染)
  const sketchMeshes = useMemo(() => {
    const results: {
      id: string;
      isActive: boolean;
      isTarget: boolean;
      isRevolveTarget: boolean;
      geometry: THREE.BufferGeometry;
    }[] = [];

    sketches.forEach((sketch) => {
      const plane: CustomPlane = sketch.plane || DatumFrontPlane;
      const isActive = sketch.id === activeSketchId;
      const isTarget = sketch.id === extrudePreview?.sketchId;
      const isRevolveTarget = sketch.id === revolvePreview?.sketchId;
      const segmentPoints: THREE.Vector3[] = [];

      (sketch.entities || []).forEach((entity) => {
        if (!entity.visible && entity.visible !== undefined) return;

        if (entity.type === 'line') {
          // 若為當前旋轉預覽目標草圖，直線圖元交由 RevolvePreviewRenderer 提供 3D 互動選軸與高亮
          if (isRevolveTarget) return;
          const line = entity as LineEntity;
          const p1 = mapPoint2DTo3D(line.start, plane);
          const p2 = mapPoint2DTo3D(line.end, plane);
          segmentPoints.push(new THREE.Vector3(p1.x, p1.y, p1.z));
          segmentPoints.push(new THREE.Vector3(p2.x, p2.y, p2.z));
        } else if (entity.type === 'circle') {
          const circle = entity as CircleEntity;
          const segments = 48;
          let prevPt: THREE.Vector3 | null = null;
          for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const pt2d: Point2D = {
              x: circle.center.x + circle.radius * Math.cos(angle),
              y: circle.center.y + circle.radius * Math.sin(angle),
            };
            const p3 = mapPoint2DTo3D(pt2d, plane);
            const currentPt = new THREE.Vector3(p3.x, p3.y, p3.z);
            if (prevPt) {
              segmentPoints.push(prevPt);
              segmentPoints.push(currentPt);
            }
            prevPt = currentPt;
          }
        } else if (entity.type === 'arc') {
          const arc = entity as ArcEntity;
          const segments = 32;
          const isCW = Boolean(arc.clockwise);
          const sweep = getArcSweepAngle({
            startAngle: arc.startAngle,
            endAngle: arc.endAngle,
            clockwise: isCW,
          });

          let prevPt: THREE.Vector3 | null = null;
          for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const angle = isCW
              ? arc.startAngle - sweep * t
              : arc.startAngle + sweep * t;
            const pt2d: Point2D = {
              x: arc.center.x + arc.radius * Math.cos(angle),
              y: arc.center.y + arc.radius * Math.sin(angle),
            };
            const p3 = mapPoint2DTo3D(pt2d, plane);
            const currentPt = new THREE.Vector3(p3.x, p3.y, p3.z);
            if (prevPt) {
              segmentPoints.push(prevPt);
              segmentPoints.push(currentPt);
            }
            prevPt = currentPt;
          }
        } else if (entity.type === 'polyline') {
          const poly = entity as PolylineEntity;
          if (poly.points && poly.points.length >= 2) {
            for (let i = 0; i < poly.points.length - 1; i++) {
              const p1 = mapPoint2DTo3D(poly.points[i], plane);
              const p2 = mapPoint2DTo3D(poly.points[i + 1], plane);
              segmentPoints.push(new THREE.Vector3(p1.x, p1.y, p1.z));
              segmentPoints.push(new THREE.Vector3(p2.x, p2.y, p2.z));
            }
            if (poly.closed && poly.points.length > 2) {
              const p1 = mapPoint2DTo3D(poly.points[poly.points.length - 1], plane);
              const p2 = mapPoint2DTo3D(poly.points[0], plane);
              segmentPoints.push(new THREE.Vector3(p1.x, p1.y, p1.z));
              segmentPoints.push(new THREE.Vector3(p2.x, p2.y, p2.z));
            }
          }
        }
      });

      if (segmentPoints.length > 0) {
        const geom = new THREE.BufferGeometry().setFromPoints(segmentPoints);
        results.push({
          id: sketch.id,
          isActive,
          isTarget,
          isRevolveTarget,
          geometry: geom,
        });
      }
    });

    return results;
  }, [sketches, activeSketchId, extrudePreview?.sketchId, revolvePreview?.sketchId]);

  return (
    <group name="sketch-3d-renderer">
      {sketchMeshes.map(({ id, isActive, isTarget, isRevolveTarget, geometry }) => {
        let color = '#94a3b8'; // 預設草圖灰色
        if (isRevolveTarget) {
          color = '#c084fc'; // 即將旋轉的目標草圖亮紫色
        } else if (isTarget) {
          color = '#fbbf24'; // 即將拉伸的目標草圖亮黃色
        } else if (isActive) {
          color = '#38bdf8'; // 當前作用中的草圖亮天藍色
        }

        return (
          <lineSegments key={id} geometry={geometry}>
            <lineBasicMaterial
              color={color}
              linewidth={isActive || isTarget || isRevolveTarget ? 2 : 1}
              depthTest={true}
            />
          </lineSegments>
        );
      })}
    </group>
  );
};

export default Sketch3DRenderer;
