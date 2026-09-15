import React, { useMemo, useEffect, useCallback } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { RevolvePreviewState } from '../store/cadStore.types';
import {
  SketchFeature,
  CustomPlane,
  DatumFrontPlane,
  DatumPlaneFeature,
  LineEntity,
  Point2D,
} from '../types/cad';
import { mapPoint2DTo3D } from '../core/3d/FeaturePipelineAdapter';
import { findClosedProfiles } from '../core/2d/TopologyEngine';

interface RevolvePreviewMeshProps {
  preview: NonNullable<RevolvePreviewState>;
}

/**
 * 3D 旋轉長料 (Revolve Boss) 與旋轉除料 (Revolve Cut) 實體幾何即時預覽元件
 * - 計算 2D 草圖輪廓圍繞任意選定軸線的迴轉實體網格與特徵邊線 (Edges)
 * - 渲染高亮 3D 旋轉軸心輔助線 (Cyan Axis Line & Extension)
 * - 渲染旋轉角度方向軌跡弧線與箭頭 (Rotation Arc & Direction Arrow)
 * - 懸浮 3D 視角互動標籤 (角度讀數、軸線名稱與方向反轉按鈕)
 */
const RevolvePreviewMesh: React.FC<RevolvePreviewMeshProps> = ({ preview }) => {
  const featureTree = useCADStore((state) => state.document.featureTree);
  const planes = useCADStore((state) => state.document.planes);
  const setRevolvePreview = useCADStore((state) => state.setRevolvePreview);
  const setViewMode = useCADStore((state) => state.setViewMode);
  const setIsPickingRevolveAxis = useCADStore((state) => state.setIsPickingRevolveAxis);

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

  // 4. 解析旋轉軸線 (LineEntity)
  const axisLine = useMemo<LineEntity | null>(() => {
    if (!targetSketch || !targetSketch.entities) return null;
    const lines = targetSketch.entities.filter((e): e is LineEntity => e.type === 'line');
    if (lines.length === 0) return null;

    if (preview.axisEntityId) {
      const match = lines.find((l) => l.id === preview.axisEntityId);
      if (match) return match;
    }

    // 優先選取建構線，其次第一條普通線
    const constr = lines.find((l) => l.isConstruction);
    return constr || lines[0];
  }, [targetSketch, preview.axisEntityId]);

  const isBoss = preview.mode === 'REVOLVE';
  const rawAngle = Math.abs(preview.angle) > 1e-4 ? preview.angle : Math.PI * 2;
  const sweepAngle = preview.reversed ? -Math.abs(rawAngle) : Math.abs(rawAngle);

  // 5. 建立草圖平面空間矩陣 (Matrix4)
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

  // 6. 計算 2D 旋轉軸線幾何 (起點、方向向量 u 與垂直向量 v)
  const axisGeometry2D = useMemo(() => {
    if (axisLine) {
      const p1 = axisLine.start;
      const p2 = axisLine.end;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) {
        const ux = dx / len;
        const uy = dy / len;
        return {
          origin: p1,
          u: { x: ux, y: uy },
          v: { x: -uy, y: ux }, // 逆時針 90 度垂直法向量
          length: len,
          start: p1,
          end: p2,
        };
      }
    }
    // 回退預設：草圖 Y 軸
    return {
      origin: { x: 0, y: 0 },
      u: { x: 0, y: 1 },
      v: { x: -1, y: 0 },
      length: 100,
      start: { x: 0, y: 0 },
      end: { x: 0, y: 100 },
    };
  }, [axisLine]);

  // 7. 計算 3D 旋轉實體 BufferGeometry 與 Edges
  const previewGeometries = useMemo(() => {
    if (!profiles || profiles.length === 0) return [];

    const { origin: a0, u, v } = axisGeometry2D;
    const absSweep = Math.abs(sweepAngle);
    const isFullCircle = Math.abs(absSweep - Math.PI * 2) < 1e-4;

    // 依旋轉角度動態調配取樣密度 (全圓約 48 段，平滑度與運算效能達到最佳平衡)
    const numSegments = Math.max(
      12,
      Math.min(64, Math.round(48 * (absSweep / (Math.PI * 2))))
    );

    // 2D 點在旋轉角 phi 處的局部 3D 座標評估函數
    const evalPt = (pt: Point2D, phi: number): [number, number, number] => {
      const relX = pt.x - a0.x;
      const relY = pt.y - a0.y;
      const h = relX * u.x + relY * u.y;
      const r = relX * v.x + relY * v.y;

      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);

      const px = a0.x + h * u.x + r * cosP * v.x;
      const py = a0.y + h * u.y + r * cosP * v.y;
      const pz = r * sinP;

      return [px, py, pz];
    };

    const geoms: { geom: THREE.BufferGeometry; edges: THREE.EdgesGeometry }[] = [];

    profiles.forEach((prof) => {
      if (!prof.outerLoop || prof.outerLoop.length < 3) return;

      const positions: number[] = [];

      // 7.1 邊界迴轉曲面 (Lateral Quad Strips)
      const loops: Point2D[][] = [prof.outerLoop];
      if (prof.innerLoops && prof.innerLoops.length > 0) {
        prof.innerLoops.forEach((hole) => {
          if (hole.length >= 3) loops.push(hole);
        });
      }

      loops.forEach((loop) => {
        const n = loop.length;
        for (let i = 0; i < n; i++) {
          const ptA = loop[i];
          const ptB = loop[(i + 1) % n];

          // 判斷是否兩端點均緊貼於軸心 (半徑近 0 則跳過退化三角形)
          const rA = Math.abs((ptA.x - a0.x) * v.x + (ptA.y - a0.y) * v.y);
          const rB = Math.abs((ptB.x - a0.x) * v.x + (ptB.y - a0.y) * v.y);
          if (rA < 1e-5 && rB < 1e-5) continue;

          for (let j = 0; j < numSegments; j++) {
            const phi1 = (j / numSegments) * sweepAngle;
            const phi2 = ((j + 1) / numSegments) * sweepAngle;

            const p00 = evalPt(ptA, phi1);
            const p10 = evalPt(ptB, phi1);
            const p11 = evalPt(ptB, phi2);
            const p01 = evalPt(ptA, phi2);

            if (sweepAngle >= 0) {
              // 三角形 1: p00 -> p10 -> p11
              positions.push(...p00, ...p10, ...p11);
              // 三角形 2: p00 -> p11 -> p01
              positions.push(...p00, ...p11, ...p01);
            } else {
              // 反向旋轉修正法向量朝外
              positions.push(...p00, ...p11, ...p10);
              positions.push(...p00, ...p01, ...p11);
            }
          }
        }
      });

      // 7.2 若非 360 度完整封閉迴轉，為起點與終點端面進行三角剖分 (Triangulate End Caps)
      if (!isFullCircle) {
        try {
          const outerVecs = prof.outerLoop.map((p) => new THREE.Vector2(p.x, p.y));
          const holesVecs = (prof.innerLoops || []).map((hole) =>
            hole.map((p) => new THREE.Vector2(p.x, p.y))
          );

          const all2DPts = [...outerVecs];
          const holeIndicesList: THREE.Vector2[][] = [];
          holesVecs.forEach((hole) => {
            holeIndicesList.push(hole);
          });

          const triangles = THREE.ShapeUtils.triangulateShape(outerVecs, holeIndicesList);

          // 扁平化輪廓點陣列以利索引對應
          const flatPoints: Point2D[] = [...prof.outerLoop];
          (prof.innerLoops || []).forEach((hole) => {
            flatPoints.push(...hole);
          });

          triangles.forEach(([i1, i2, i3]) => {
            if (i1 < flatPoints.length && i2 < flatPoints.length && i3 < flatPoints.length) {
              const p1 = flatPoints[i1];
              const p2 = flatPoints[i2];
              const p3 = flatPoints[i3];

              // 起點端面 (phi = 0)
              const start1 = evalPt(p1, 0);
              const start2 = evalPt(p2, 0);
              const start3 = evalPt(p3, 0);

              // 終點端面 (phi = sweepAngle)
              const end1 = evalPt(p1, sweepAngle);
              const end2 = evalPt(p2, sweepAngle);
              const end3 = evalPt(p3, sweepAngle);

              if (sweepAngle >= 0) {
                // 起點端面法向量朝反向
                positions.push(...start1, ...start3, ...start2);
                // 終點端面法向量朝前向
                positions.push(...end1, ...end2, ...end3);
              } else {
                positions.push(...start1, ...start2, ...start3);
                positions.push(...end1, ...end3, ...end2);
              }
            }
          });
        } catch (e) {
          console.warn('RevolvePreview: Failed to triangulate end caps', e);
        }
      }

      if (positions.length > 0) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geom.computeVertexNormals();

        const edges = new THREE.EdgesGeometry(geom, 22);
        geoms.push({ geom, edges });
      }
    });

    return geoms;
  }, [profiles, axisGeometry2D, sweepAngle]);

  // 清理幾何避免記憶體洩漏
  useEffect(() => {
    return () => {
      previewGeometries.forEach(({ geom, edges }) => {
        geom.dispose();
        edges.dispose();
      });
    };
  }, [previewGeometries]);

  // 8. 計算旋轉軸心 3D 延長線與視覺輔助指標
  const axisVisual3D = useMemo(() => {
    const { start: a1, end: a2, u } = axisGeometry2D;

    // 計算輪廓中心點與軸線範圍以動態擴展延長線
    let minH = 0;
    let maxH = axisGeometry2D.length;
    let maxR = 40;

    if (profiles && profiles.length > 0) {
      profiles.forEach((p) => {
        p.outerLoop.forEach((pt) => {
          const rx = pt.x - axisGeometry2D.origin.x;
          const ry = pt.y - axisGeometry2D.origin.y;
          const h = rx * u.x + ry * u.y;
          const r = Math.abs(rx * axisGeometry2D.v.x + ry * axisGeometry2D.v.y);
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
          if (r > maxR) maxR = r;
        });
      });
    }

    const extendPad = Math.max(30, (maxH - minH) * 0.25);
    const pStartExtended2D: Point2D = {
      x: axisGeometry2D.origin.x + (minH - extendPad) * u.x,
      y: axisGeometry2D.origin.y + (minH - extendPad) * u.y,
    };
    const pEndExtended2D: Point2D = {
      x: axisGeometry2D.origin.x + (maxH + extendPad) * u.x,
      y: axisGeometry2D.origin.y + (maxH + extendPad) * u.y,
    };

    const ptStart3D = mapPoint2DTo3D(pStartExtended2D, plane);
    const ptEnd3D = mapPoint2DTo3D(pEndExtended2D, plane);
    const ptLineStart3D = mapPoint2DTo3D(a1, plane);
    const ptLineEnd3D = mapPoint2DTo3D(a2, plane);

    // 延長線段點陣列
    const extPoints = [
      new THREE.Vector3(ptStart3D.x, ptStart3D.y, ptStart3D.z),
      new THREE.Vector3(ptEnd3D.x, ptEnd3D.y, ptEnd3D.z),
    ];
    const extGeom = new THREE.BufferGeometry().setFromPoints(extPoints);

    // 實體線段點陣列
    const segPoints = [
      new THREE.Vector3(ptLineStart3D.x, ptLineStart3D.y, ptLineStart3D.z),
      new THREE.Vector3(ptLineEnd3D.x, ptLineEnd3D.y, ptLineEnd3D.z),
    ];
    const segGeom = new THREE.BufferGeometry().setFromPoints(segPoints);

    // 軸中心點
    const mid2D: Point2D = {
      x: (a1.x + a2.x) / 2,
      y: (a1.y + a2.y) / 2,
    };
    const center3D = mapPoint2DTo3D(mid2D, plane);

    return {
      extGeom,
      segGeom,
      ptStart3D: new THREE.Vector3(ptStart3D.x, ptStart3D.y, ptStart3D.z),
      ptEnd3D: new THREE.Vector3(ptEnd3D.x, ptEnd3D.y, ptEnd3D.z),
      ptLineStart3D: new THREE.Vector3(ptLineStart3D.x, ptLineStart3D.y, ptLineStart3D.z),
      ptLineEnd3D: new THREE.Vector3(ptLineEnd3D.x, ptLineEnd3D.y, ptLineEnd3D.z),
      center3D: new THREE.Vector3(center3D.x, center3D.y, center3D.z),
      maxRadius: maxR,
    };
  }, [axisGeometry2D, profiles, plane]);

  // 9. 計算旋轉運動軌跡弧線與箭頭指示 (Trajectory Arc & Arrow)
  const arcVisual = useMemo(() => {
    if (!profiles || profiles.length === 0) return null;

    // 計算輪廓中心
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    profiles.forEach((p) => {
      p.outerLoop.forEach((pt) => {
        sumX += pt.x;
        sumY += pt.y;
        count++;
      });
    });

    if (count === 0) return null;
    const center2D: Point2D = { x: sumX / count, y: sumY / count };
    const { origin: a0, u, v } = axisGeometry2D;

    const relX = center2D.x - a0.x;
    const relY = center2D.y - a0.y;
    const h = relX * u.x + relY * u.y;
    const r = relX * v.x + relY * v.y;

    if (Math.abs(r) < 1.0) return null; // 輪廓剛好在軸線上則免繪弧線

    const numArcPts = 32;
    const arcPoints: THREE.Vector3[] = [];

    for (let i = 0; i <= numArcPts; i++) {
      const phi = (i / numArcPts) * sweepAngle;
      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);

      const px = a0.x + h * u.x + r * cosP * v.x;
      const py = a0.y + h * u.y + r * cosP * v.y;
      const pz = r * sinP;

      const p3 = mapPoint2DTo3D({ x: px, y: py }, plane);
      // 注意 pz 為草圖法向局部偏移，疊加至 3D 空間
      const normal = new THREE.Vector3(
        plane.normal?.x ?? 0,
        plane.normal?.y ?? 0,
        plane.normal?.z ?? 1
      ).normalize();

      const pt = new THREE.Vector3(p3.x, p3.y, p3.z).addScaledVector(normal, pz);
      arcPoints.push(pt);
    }

    const arcGeom = new THREE.BufferGeometry().setFromPoints(arcPoints);
    const arcMaterial = new THREE.LineBasicMaterial({ color: '#38bdf8', depthTest: false });
    const arcLine = new THREE.Line(arcGeom, arcMaterial);
    
    const tipPos = arcPoints[arcPoints.length - 1];
    const prevPos = arcPoints[arcPoints.length - 2] || arcPoints[0];
    const tipDir = tipPos.clone().sub(prevPos).normalize();

    // 弧線中心點供標籤懸浮定位
    const midIdx = Math.floor(arcPoints.length / 2);
    const labelPos = arcPoints[midIdx] || tipPos;

    return {
      arcLine,
      tipPos,
      tipDir,
      labelPos,
    };
  }, [profiles, axisGeometry2D, sweepAngle, plane]);

  const toggleDirection = useCallback(() => {
    setRevolvePreview({
      ...preview,
      reversed: !preview.reversed,
    });
  }, [preview, setRevolvePreview]);

  if (!targetSketch || previewGeometries.length === 0) {
    return null;
  }

  const angleDeg = ((preview.angle * 180) / Math.PI).toFixed(1).replace(/\.0$/, '');

  return (
    <group name="revolve-preview-mesh">
      {/* 1. 旋轉預覽實體網格與邊線 */}
      <group matrix={planeMatrix} matrixAutoUpdate={false}>
        {previewGeometries.map(({ geom, edges }, idx) => (
          <group key={idx}>
            <mesh geometry={geom} castShadow={false} receiveShadow={false}>
              <meshStandardMaterial
                color={isBoss ? '#a855f7' : '#f43f5e'}
                transparent
                opacity={isBoss ? 0.48 : 0.55}
                depthWrite={false}
                side={THREE.DoubleSide}
                roughness={0.25}
                metalness={0.15}
                polygonOffset
                polygonOffsetFactor={1}
                polygonOffsetUnits={1}
              />
            </mesh>
            <lineSegments geometry={edges}>
              <lineBasicMaterial
                color={isBoss ? '#d8b4fe' : '#fda4af'}
                linewidth={2}
                depthTest={true}
              />
            </lineSegments>
          </group>
        ))}
      </group>

      {/* 2. 3D 旋轉軸線視覺展示 */}
      {axisVisual3D && (
        <group name="revolve-axis-visual">
          {/* 軸線延長參考虛線 (Cyan Dashed Ray) */}
          <lineSegments geometry={axisVisual3D.extGeom}>
            <lineDashedMaterial
              color="#06b6d4"
              dashSize={6}
              gapSize={4}
              linewidth={1.5}
              depthTest={false}
            />
          </lineSegments>

          {/* 軸線本體加粗實線 (Cyan Solid Segment) */}
          <lineSegments geometry={axisVisual3D.segGeom}>
            <lineBasicMaterial
              color="#22d3ee"
              linewidth={3}
              depthTest={false}
            />
          </lineSegments>

          {/* 軸線兩端頂點標記圓球 */}
          <mesh position={axisVisual3D.ptLineStart3D}>
            <sphereGeometry args={[1.5, 16, 16]} />
            <meshBasicMaterial color="#06b6d4" />
          </mesh>
          <mesh position={axisVisual3D.ptLineEnd3D}>
            <sphereGeometry args={[1.5, 16, 16]} />
            <meshBasicMaterial color="#06b6d4" />
          </mesh>
        </group>
      )}

      {/* 3. 旋轉動態軌跡弧線與箭頭 (Rotation Arc & Arrow) */}
      {arcVisual && (
        <group name="revolve-arc-visual">
          <primitive object={arcVisual.arcLine} />

          {/* 箭頭錐體 (Cone Indicator) */}
          <mesh
            position={arcVisual.tipPos}
            quaternion={
              new THREE.Quaternion().setFromUnitVectors(
                new THREE.Vector3(0, 1, 0),
                arcVisual.tipDir
              )
            }
          >
            <coneGeometry args={[2.5, 7, 16]} />
            <meshBasicMaterial color="#38bdf8" depthTest={false} />
          </mesh>

          {/* 4. 懸浮 3D HTML 標籤列 (視角不被遮擋) */}
          <Html position={arcVisual.labelPos} center distanceFactor={150}>
            <div
              className="bg-neutral-950/90 border border-purple-500/70 rounded-lg px-2.5 py-1 text-white shadow-2xl backdrop-blur-sm pointer-events-auto flex items-center gap-2 select-none whitespace-nowrap text-xs animate-in fade-in duration-200"
              style={{ transform: 'translate3d(0, -15px, 0)' }}
            >
              <div className="flex items-center gap-1 font-mono font-bold text-purple-300">
                <span>{isBoss ? '⟳ 旋轉長料' : '⟳ 旋轉除料'}:</span>
                <span className="text-white">{angleDeg}°</span>
              </div>

              {axisLine && (
                <span className="text-[10px] text-cyan-400 font-mono hidden sm:inline">
                  [軸: #{axisLine.id.slice(0, 5)}]
                </span>
              )}

              {/* 反轉方向按鈕 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleDirection();
                }}
                className="px-1.5 py-0.5 bg-purple-600/60 hover:bg-purple-500 text-purple-100 hover:text-white rounded text-[11px] font-semibold transition-colors cursor-pointer border border-purple-400/40"
                title="反轉旋轉方向 (Reverse Direction)"
              >
                反轉 ⇄
              </button>

              {/* 切換至 2D 點選按鈕 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setViewMode('2D');
                  setIsPickingRevolveAxis(true);
                }}
                className="px-1.5 py-0.5 bg-cyan-600/40 hover:bg-cyan-500 text-cyan-200 hover:text-white rounded text-[11px] font-semibold transition-colors cursor-pointer border border-cyan-400/40"
                title="切換至 2D 草圖視圖以點選直線作為旋轉軸"
              >
                2D 選軸 ✎
              </button>
            </div>
          </Html>
        </group>
      )}
    </group>
  );
};

export const RevolvePreviewRenderer: React.FC = () => {
  const revolvePreview = useCADStore((state) => state.revolvePreview);

  if (!revolvePreview || !revolvePreview.isOpen) {
    return null;
  }

  return <RevolvePreviewMesh preview={revolvePreview} />;
};

export default RevolvePreviewRenderer;
