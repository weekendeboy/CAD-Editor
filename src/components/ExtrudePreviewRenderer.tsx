import React, { useMemo, useEffect, useCallback } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { ExtrudePreviewState } from '../store/cadStore.types';
import {
  SketchFeature,
  CustomPlane,
  DatumFrontPlane,
  DatumPlaneFeature,
} from '../types/cad';
import { mapPoint2DTo3D } from '../core/3d/FeaturePipelineAdapter';
import { findClosedProfiles } from '../core/2d/TopologyEngine';

interface ExtrudePreviewMeshProps {
  preview: NonNullable<ExtrudePreviewState>;
}

/**
 * 3D 伸長長料 (Extrude Boss) 與伸長除料 (Extrude Cut) 實體預覽網格與方向指示箭頭
 * 所有 React Hooks 均在頂層無條件調用，保證完全符合 React Rules of Hooks。
 */
const ExtrudePreviewMesh: React.FC<ExtrudePreviewMeshProps> = ({ preview }) => {
  const featureTree = useCADStore((state) => state.document.featureTree);
  const planes = useCADStore((state) => state.document.planes);
  const setExtrudePreview = useCADStore((state) => state.setExtrudePreview);

  // 1. 尋找目標草圖
  const targetSketch = useMemo(() => {
    return (featureTree || []).find(
      (f) => f.id === preview.sketchId
    ) as SketchFeature | undefined;
  }, [featureTree, preview.sketchId]);

  // 2. 解析所屬基準面
  const plane = useMemo<CustomPlane>(() => {
    if (!targetSketch) return DatumFrontPlane;
    if (targetSketch.planeFeatureId) {
      const datumFeat = (featureTree || []).find(
        (f) => f.id === targetSketch.planeFeatureId
      ) as DatumPlaneFeature | undefined;
      if (datumFeat?.plane) {
        return datumFeat.plane;
      } else if (planes && planes[targetSketch.planeFeatureId]) {
        return planes[targetSketch.planeFeatureId];
      }
    }
    return targetSketch.plane || DatumFrontPlane;
  }, [targetSketch, featureTree, planes]);

  // 3. 取得封閉輪廓清單
  const profiles = useMemo(() => {
    if (!targetSketch) return [];
    if (targetSketch.profiles && targetSketch.profiles.length > 0) {
      return targetSketch.profiles;
    }
    try {
      return findClosedProfiles(
        targetSketch.entities || [],
        targetSketch.constraints || []
      );
    } catch {
      return [];
    }
  }, [targetSketch]);

  const isBoss = preview.mode === 'EXTRUDE';
  const depth = preview.throughAll ? 150 : Math.max(0.1, preview.depth);

  // 4. 計算局部 Z 偏移量
  const localZOffset = useMemo(() => {
    if (preview.direction === 'normal') {
      return 0;
    } else if (preview.direction === 'reversed') {
      return -depth;
    } else {
      return -depth / 2;
    }
  }, [preview.direction, depth]);

  // 5. 建立草圖平面空間矩陣
  const planeMatrix = useMemo(() => {
    const m = new THREE.Matrix4();
    const xAxis = new THREE.Vector3(
      plane.xAxis?.x ?? 1,
      plane.xAxis?.y ?? 0,
      plane.xAxis?.z ?? 0
    );
    const yAxis = new THREE.Vector3(
      plane.yAxis?.x ?? 0,
      plane.yAxis?.y ?? 1,
      plane.yAxis?.z ?? 0
    );
    const normal = new THREE.Vector3(
      plane.normal?.x ?? 0,
      plane.normal?.y ?? 0,
      plane.normal?.z ?? 1
    ).normalize();

    m.makeBasis(xAxis, yAxis, normal);
    m.setPosition(
      new THREE.Vector3(
        plane.origin?.x ?? 0,
        plane.origin?.y ?? 0,
        plane.origin?.z ?? 0
      )
    );
    return m;
  }, [plane]);

  // 6. 為輪廓產生 ExtrudeGeometry 與特徵邊線
  const previewGeometries = useMemo(() => {
    if (!profiles || profiles.length === 0) return [];

    const geoms: { geom: THREE.ExtrudeGeometry; edges: THREE.EdgesGeometry }[] = [];

    profiles.forEach((prof) => {
      if (!prof.outerLoop || prof.outerLoop.length < 3) return;

      const shape = new THREE.Shape();
      prof.outerLoop.forEach((pt, idx) => {
        if (idx === 0) shape.moveTo(pt.x, pt.y);
        else shape.lineTo(pt.x, pt.y);
      });
      shape.closePath();

      if (prof.innerLoops && prof.innerLoops.length > 0) {
        prof.innerLoops.forEach((holePts) => {
          if (holePts.length >= 3) {
            const hole = new THREE.Path();
            holePts.forEach((pt, idx) => {
              if (idx === 0) hole.moveTo(pt.x, pt.y);
              else hole.lineTo(pt.x, pt.y);
            });
            hole.closePath();
            shape.holes.push(hole);
          }
        });
      }

      const geom = new THREE.ExtrudeGeometry(shape, {
        depth: depth,
        bevelEnabled: false,
      });
      const edges = new THREE.EdgesGeometry(geom, 24);
      geoms.push({ geom, edges });
    });

    return geoms;
  }, [profiles, depth]);

  // 卸載與重新計算時清理 Geometry 避免記憶體洩漏
  useEffect(() => {
    return () => {
      previewGeometries.forEach(({ geom, edges }) => {
        geom.dispose();
        edges.dispose();
      });
    };
  }, [previewGeometries]);

  // 7. 計算輪廓中心點 (2D -> 3D) 與基準面法向量
  const { center3D, normalVec } = useMemo(() => {
    let sumX = 0;
    let sumY = 0;
    let count = 0;

    if (profiles && profiles.length > 0) {
      profiles.forEach((p) => {
        p.outerLoop.forEach((pt) => {
          sumX += pt.x;
          sumY += pt.y;
          count++;
        });
      });
    }

    const center2D = count > 0 ? { x: sumX / count, y: sumY / count } : { x: 0, y: 0 };
    const pt3D = mapPoint2DTo3D(center2D, plane);

    const norm = new THREE.Vector3(
      plane.normal?.x ?? 0,
      plane.normal?.y ?? 0,
      plane.normal?.z ?? 1
    ).normalize();

    return {
      center3D: new THREE.Vector3(pt3D.x, pt3D.y, pt3D.z),
      normalVec: norm,
    };
  }, [profiles, plane]);

  // 8. 計算伸長方向向量箭頭資訊
  const arrowInfo = useMemo(() => {
    const len = Math.max(25, Math.min(80, depth));

    if (preview.direction === 'normal') {
      const dir = normalVec.clone();
      const head = center3D.clone().addScaledVector(dir, len);
      return [{ dir, origin: center3D, length: len, head, label: '+Z 法向' }];
    } else if (preview.direction === 'reversed') {
      const dir = normalVec.clone().negate();
      const head = center3D.clone().addScaledVector(dir, len);
      return [{ dir, origin: center3D, length: len, head, label: '-Z 反法向' }];
    } else {
      // 兩側對稱
      const halfLen = len / 2;
      const dir1 = normalVec.clone();
      const head1 = center3D.clone().addScaledVector(dir1, halfLen);
      const dir2 = normalVec.clone().negate();
      const head2 = center3D.clone().addScaledVector(dir2, halfLen);
      return [
        { dir: dir1, origin: center3D, length: halfLen, head: head1, label: '+Z' },
        { dir: dir2, origin: center3D, length: halfLen, head: head2, label: '-Z' },
      ];
    }
  }, [preview.direction, normalVec, center3D, depth]);

  const toggleDirection = useCallback(() => {
    if (preview.direction === 'normal') {
      setExtrudePreview({ ...preview, direction: 'reversed' });
    } else if (preview.direction === 'reversed') {
      setExtrudePreview({ ...preview, direction: 'normal' });
    } else {
      setExtrudePreview({ ...preview, direction: 'normal' });
    }
  }, [preview, setExtrudePreview]);

  // 若找不到草圖或無法建構輪廓幾何，安全回傳 null（此時所有 Hooks 已無條件執行完成）
  if (!targetSketch || previewGeometries.length === 0) {
    return null;
  }

  return (
    <group name="extrude-preview-mesh">
      {/* 1. 預覽實體網格與特徵邊線 */}
      <group matrix={planeMatrix} matrixAutoUpdate={false}>
        <group position={[0, 0, localZOffset]}>
          {previewGeometries.map(({ geom, edges }, idx) => (
            <group key={idx}>
              <mesh geometry={geom} castShadow={false} receiveShadow={false}>
                <meshStandardMaterial
                  color={isBoss ? '#f59e0b' : '#ef4444'}
                  transparent
                  opacity={isBoss ? 0.45 : 0.55}
                  depthWrite={false}
                  side={THREE.DoubleSide}
                  roughness={0.3}
                  metalness={0.1}
                  polygonOffset
                  polygonOffsetFactor={1}
                  polygonOffsetUnits={1}
                />
              </mesh>
              <lineSegments geometry={edges}>
                <lineBasicMaterial
                  color={isBoss ? '#fbbf24' : '#fca5a5'}
                  linewidth={2}
                  depthTest={true}
                />
              </lineSegments>
            </group>
          ))}
        </group>
      </group>

      {/* 2. 伸長方向指示箭頭 */}
      {arrowInfo.map((arrow, idx) => {
        const rotQuaternion = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          arrow.dir
        );

        return (
          <group key={idx} position={arrow.origin}>
            {/* 箭頭主體 (桿身 + 箭頭圓錐) */}
            <group quaternion={rotQuaternion}>
              {/* 圓柱桿身 */}
              <mesh position={[0, arrow.length * 0.4, 0]}>
                <cylinderGeometry args={[0.8, 0.8, arrow.length * 0.8, 16]} />
                <meshBasicMaterial
                  color={isBoss ? '#fbbf24' : '#f87171'}
                  depthTest={false}
                />
              </mesh>
              {/* 圓錐頭部 */}
              <mesh position={[0, arrow.length * 0.9, 0]}>
                <coneGeometry args={[3.2, 8, 16]} />
                <meshBasicMaterial
                  color={isBoss ? '#f59e0b' : '#ef4444'}
                  depthTest={false}
                />
              </mesh>
            </group>

            {/* 3D 空間懸浮標籤與反向切換按鈕 */}
            <Html
              position={[
                arrow.head.x - arrow.origin.x,
                arrow.head.y - arrow.origin.y + 4,
                arrow.head.z - arrow.origin.z,
              ]}
              center
              style={{ pointerEvents: 'auto' }}
            >
              <div
                className={`px-2 py-1 rounded-md text-[11px] font-mono font-bold shadow-xl border flex items-center gap-1.5 whitespace-nowrap select-none ${
                  isBoss
                    ? 'bg-amber-950/95 text-amber-300 border-amber-500/80 shadow-amber-900/50'
                    : 'bg-rose-950/95 text-rose-300 border-rose-500/80 shadow-rose-900/50'
                }`}
              >
                <span>
                  {isBoss ? '長料方向' : '除料方向'}:{' '}
                  {preview.throughAll
                    ? '完全貫穿'
                    : preview.direction === 'mid-plane'
                    ? `±${(preview.depth / 2).toFixed(1)} mm`
                    : `${preview.depth} mm`}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleDirection();
                  }}
                  className="px-1.5 py-0.5 rounded bg-neutral-900 hover:bg-neutral-800 text-white text-[10px] border border-neutral-700 hover:border-neutral-500 transition-colors cursor-pointer shadow-sm active:scale-95"
                  title="點擊切換伸長方向"
                >
                  反轉 ⇄
                </button>
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
};

/**
 * 伸長預覽渲染容器
 * 僅負責訂閱 extrudePreview 狀態，有激活預覽時才掛載 ExtrudePreviewMesh
 */
export const ExtrudePreviewRenderer: React.FC = () => {
  const extrudePreview = useCADStore((state) => state.extrudePreview);

  if (!extrudePreview || !extrudePreview.isOpen || !extrudePreview.sketchId) {
    return null;
  }

  return <ExtrudePreviewMesh preview={extrudePreview} />;
};

export default ExtrudePreviewRenderer;
