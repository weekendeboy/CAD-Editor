import React, { useMemo, useState, useEffect, useCallback } from 'react';
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
import { discretizeSketchProfile } from '../core/2d/ProfileDiscretizer';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

interface RevolvePreviewMeshProps {
  preview: NonNullable<RevolvePreviewState>;
}

interface CandidateAxisLineProps {
  line: LineEntity;
  plane: CustomPlane;
  isSelected: boolean;
  onSelect: (lineId: string) => void;
}

/**
 * 3D 視圖中的單一候選旋轉軸互動元件
 * - 具備加寬的不可見射線檢測圓柱體 (Raycast Hit Cylinder)，使滑鼠在 3D 畫面中極易點選
 * - 懸停 (Hover) 時高亮顯示金黃色光暈、頂點圓球與 3D 浮動提示標籤
 * - 點擊時立即呼叫 onSelect 將該線段設為旋轉軸
 */
const CandidateAxisLine: React.FC<CandidateAxisLineProps> = ({
  line,
  plane,
  isSelected,
  onSelect,
}) => {
  const [hovered, setHovered] = useState(false);

  const { p1, p2, mid, length, quaternion, lineGeom } = useMemo(() => {
    const pt1_3d = mapPoint2DTo3D(line.start, plane);
    const pt2_3d = mapPoint2DTo3D(line.end, plane);

    const v1 = new THREE.Vector3(pt1_3d.x, pt1_3d.y, pt1_3d.z);
    const v2 = new THREE.Vector3(pt2_3d.x, pt2_3d.y, pt2_3d.z);

    const delta = v2.clone().sub(v1);
    const len = Math.max(0.1, delta.length());
    const midPoint = v1.clone().add(v2).multiplyScalar(0.5);

    const dir = delta.clone().normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir
    );

    const geom = new THREE.BufferGeometry().setFromPoints([v1, v2]);

    return {
      p1: v1,
      p2: v2,
      mid: midPoint,
      length: len,
      quaternion: quat,
      lineGeom: geom,
    };
  }, [line, plane]);

  useEffect(() => {
    return () => {
      lineGeom.dispose();
    };
  }, [lineGeom]);

  const handlePointerOver = (e: any) => {
    e.stopPropagation();
    setHovered(true);
    document.body.style.cursor = 'pointer';
  };

  const handlePointerOut = () => {
    setHovered(false);
    document.body.style.cursor = 'auto';
  };

  const handleClick = (e: any) => {
    e.stopPropagation();
    onSelect(line.id);
  };

  // 如果此線已被選中為旋轉軸，則由主軸樣式渲染（但在上方顯示已選取標籤）
  if (isSelected) {
    return (
      <group name={`selected-axis-${line.id}`}>
        {/* 已選定軸線標籤 */}
        <Html position={mid} center distanceFactor={140} zIndexRange={[120, 0]}>
          <div
            className="bg-cyan-950/95 border border-cyan-400 text-cyan-200 px-2 py-0.5 rounded-md text-[11px] font-mono font-bold shadow-xl backdrop-blur flex items-center gap-1 pointer-events-none select-none animate-in fade-in zoom-in-95 duration-150"
            style={{ transform: 'translate3d(0, -18px, 0)' }}
          >
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping inline-block" />
            <span>🎯 旋轉軸 (#{line.id.slice(0, 5)})</span>
          </div>
        </Html>
      </group>
    );
  }

  // 候選線段：渲染可懸停與點選的外觀
  return (
    <group name={`candidate-axis-${line.id}`}>
      {/* 1. 不可見的寬容度射線拾取圓柱體 (Fat Hitbox Cylinder, 半徑 6mm) */}
      <mesh
        position={mid}
        quaternion={quaternion}
        onPointerOver={handlePointerOver}
        onPointerOut={handlePointerOut}
        onPointerDown={handleClick}
        onClick={handleClick}
      >
        <cylinderGeometry args={[6, 6, length, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* 2. 候選線段幾何外觀 */}
      <lineSegments geometry={lineGeom}>
        {hovered ? (
          <lineBasicMaterial
            color="#facc15"
            linewidth={4}
            depthTest={false}
          />
        ) : (
          <lineDashedMaterial
            color={line.isConstruction ? '#38bdf8' : '#a78bfa'}
            dashSize={4}
            gapSize={3}
            linewidth={2}
            depthTest={true}
          />
        )}
      </lineSegments>

      {/* 3. 兩端點圓球 */}
      <mesh position={p1}>
        <sphereGeometry args={[hovered ? 2.2 : 1.2, 12, 12]} />
        <meshBasicMaterial color={hovered ? '#facc15' : '#a78bfa'} depthTest={false} />
      </mesh>
      <mesh position={p2}>
        <sphereGeometry args={[hovered ? 2.2 : 1.2, 12, 12]} />
        <meshBasicMaterial color={hovered ? '#facc15' : '#a78bfa'} depthTest={false} />
      </mesh>

      {/* 4. 懸停時浮現 3D 提示點選標籤 */}
      {hovered && (
        <Html position={mid} center distanceFactor={140} zIndexRange={[150, 0]}>
          <div
            className="bg-neutral-950/95 border-2 border-amber-400 text-amber-300 px-2.5 py-1 rounded-lg text-xs font-mono font-bold shadow-2xl backdrop-blur flex items-center gap-1.5 pointer-events-none select-none animate-in fade-in zoom-in-90 duration-150 whitespace-nowrap"
            style={{ transform: 'translate3d(0, -22px, 0)' }}
          >
            <span>👆 點擊設定為旋轉軸</span>
            <span className="text-[10px] text-neutral-400">
              (線段 #{line.id.slice(0, 5)}{line.isConstruction ? '·建構線' : ''})
            </span>
          </div>
        </Html>
      )}
    </group>
  );
};

/**
 * 3D 旋轉長料 (Revolve Boss) 與旋轉除料 (Revolve Cut) 實體幾何即時預覽元件
 * - 計算 2D 草圖輪廓圍繞任意選定軸線的迴轉實體網格與特徵邊線 (Edges)
 * - 渲染高亮 3D 旋轉軸心輔助線 (Cyan Axis Line & Extension)
 * - 支援直接在 3D 畫面點選所有候選直線以即時切換旋轉軸
 * - 渲染旋轉角度方向軌跡弧線與箭頭 (Rotation Arc & Direction Arrow)
 * - 懸浮 3D 視角互動標籤 (角度讀數、軸線名稱與方向反轉按鈕)
 */
const RevolvePreviewMesh: React.FC<RevolvePreviewMeshProps> = ({ preview }) => {
  const featureTree = useCADStore((state) => state.document.featureTree);
  const planes = useCADStore((state) => state.document.planes);
  const setRevolvePreview = useCADStore((state) => state.setRevolvePreview);
  const setRevolveAxisEntityId = useCADStore((state) => state.setRevolveAxisEntityId);

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

  // 4. 所有候選直線清單 (包含普通線與建構線)
  const candidateLines = useMemo<LineEntity[]>(() => {
    if (!targetSketch || !targetSketch.entities) return [];
    return targetSketch.entities.filter((e): e is LineEntity => e.type === 'line');
  }, [targetSketch]);

  // 5. 解析當前旋轉軸線 (LineEntity)
  const axisLine = useMemo<LineEntity | null>(() => {
    if (candidateLines.length === 0) return null;

    if (preview.axisEntityId) {
      const match = candidateLines.find((l) => l.id === preview.axisEntityId);
      if (match) return match;
    }

    // 優先選取建構線，其次第一條普通線
    const constr = candidateLines.find((l) => l.isConstruction);
    return constr || candidateLines[0];
  }, [candidateLines, preview.axisEntityId]);

  const isBoss = preview.mode === 'REVOLVE';
  const rawAngle = Math.abs(preview.angle) > 1e-4 ? preview.angle : Math.PI * 2;
  const sweepAngle = preview.reversed ? -Math.abs(rawAngle) : Math.abs(rawAngle);

  // 6. 建立草圖平面空間矩陣 (Matrix4)
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

  // 7. 計算 2D 旋轉軸線幾何 (起點、方向向量 u 與垂直向量 v)
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

  // 8. 計算 3D 旋轉實體 BufferGeometry 與 Edges
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
      // 透過自適應離散化引擎還原圓弧與直線走勢，消弭直線弦化幾何誤差
      const disc = discretizeSketchProfile(prof, 5);
      if (!disc.outerLoop || disc.outerLoop.length < 3) return;

      const positions: number[] = [];

      // 8.1 邊界迴轉曲面 (Lateral Quad Strips)
      const loops: Point2D[][] = [disc.outerLoop];
      if (disc.innerLoops && disc.innerLoops.length > 0) {
        disc.innerLoops.forEach((hole) => {
          if (hole.length >= 3) loops.push(hole);
        });
      }

      loops.forEach((loop) => {
        const n = loop.length;
        for (let i = 0; i < n; i++) {
          const ptA = loop[i];
          const ptB = loop[(i + 1) % n];

          // 判斷是否兩端點均緊貼於軸心 (半徑近 0 則跳過退化三角形)
          const rA = (ptA.x - a0.x) * v.x + (ptA.y - a0.y) * v.y;
          const rB = (ptB.x - a0.x) * v.x + (ptB.y - a0.y) * v.y;
          if (Math.abs(rA) < 1e-5 && Math.abs(rB) < 1e-5) continue;

          // 若中點在軸線右側 (rMid < 0)，Z 軸運動方向反向，需調整三角形纏繞方向使法向始終朝外
          const rMid = (rA + rB) / 2;
          const flipNormal = (sweepAngle >= 0 ? 1 : -1) * (rMid >= 0 ? 1 : -1) < 0;

          for (let j = 0; j < numSegments; j++) {
            const phi1 = (j / numSegments) * sweepAngle;
            const phi2 = ((j + 1) / numSegments) * sweepAngle;

            const p00 = evalPt(ptA, phi1);
            const p10 = evalPt(ptB, phi1);
            const p11 = evalPt(ptB, phi2);
            const p01 = evalPt(ptA, phi2);

            if (!flipNormal) {
              // 正向: p00 -> p10 -> p11, p00 -> p11 -> p01
              positions.push(...p00, ...p10, ...p11);
              positions.push(...p00, ...p11, ...p01);
            } else {
              // 反向: p00 -> p11 -> p10, p00 -> p01 -> p11
              positions.push(...p00, ...p11, ...p10);
              positions.push(...p00, ...p01, ...p11);
            }
          }
        }
      });

      // 8.2 若非 360 度完整封閉迴轉，為起點與終點端面進行三角剖分 (Triangulate End Caps)
      if (!isFullCircle) {
        try {
          const outerVecs = disc.outerLoop.map((p) => new THREE.Vector2(p.x, p.y));
          const holesVecs = (disc.innerLoops || []).map((hole) =>
            hole.map((p) => new THREE.Vector2(p.x, p.y))
          );

          const holeIndicesList: THREE.Vector2[][] = [];
          holesVecs.forEach((hole) => {
            holeIndicesList.push(hole);
          });

          const triangles = THREE.ShapeUtils.triangulateShape(outerVecs, holeIndicesList);

          // 扁平化輪廓點陣列以利索引對應
          const flatPoints: Point2D[] = [...disc.outerLoop];
          (disc.innerLoops || []).forEach((hole) => {
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
        const rawGeom = new THREE.BufferGeometry();
        rawGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

        // 透過 mergeVertices 將四邊形相鄰共用頂點合流，產生帶索引網格並計算平滑法向量
        let geom: THREE.BufferGeometry;
        try {
          geom = BufferGeometryUtils.mergeVertices(rawGeom, 1e-4);
          rawGeom.dispose();
        } catch {
          geom = rawGeom;
        }

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

  // 9. 計算旋轉軸心 3D 延長線與視覺輔助指標
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

  useEffect(() => {
    return () => {
      if (axisVisual3D) {
        axisVisual3D.extGeom.dispose();
        axisVisual3D.segGeom.dispose();
      }
    };
  }, [axisVisual3D]);

  // 10. 計算旋轉運動軌跡弧線與箭頭指示 (Trajectory Arc & Arrow)
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
      arcGeom,
      arcMaterial,
      arcLine,
      tipPos,
      tipDir,
      labelPos,
    };
  }, [profiles, axisGeometry2D, sweepAngle, plane]);

  useEffect(() => {
    return () => {
      if (arcVisual) {
        arcVisual.arcGeom.dispose();
        arcVisual.arcMaterial.dispose();
      }
    };
  }, [arcVisual]);

  const toggleDirection = useCallback(() => {
    setRevolvePreview({
      ...preview,
      reversed: !preview.reversed,
    });
  }, [preview, setRevolvePreview]);

  const handleSelectAxisIn3D = useCallback((lineId: string) => {
    setRevolveAxisEntityId(lineId);
    setRevolvePreview({
      ...preview,
      axisEntityId: lineId,
    });
  }, [preview, setRevolveAxisEntityId, setRevolvePreview]);

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

      {/* 2. 3D 空間中所有候選直線（提供直接滑鼠點選與懸停高亮） */}
      <group name="revolve-candidate-axes">
        {candidateLines.map((line) => (
          <CandidateAxisLine
            key={line.id}
            line={line}
            plane={plane}
            isSelected={line.id === axisLine?.id}
            onSelect={handleSelectAxisIn3D}
          />
        ))}
      </group>

      {/* 3. 3D 當前旋轉軸線本體視覺展示 */}
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
              linewidth={3.5}
              depthTest={false}
            />
          </lineSegments>

          {/* 軸線兩端頂點標記圓球 */}
          <mesh position={axisVisual3D.ptLineStart3D}>
            <sphereGeometry args={[1.8, 16, 16]} />
            <meshBasicMaterial color="#06b6d4" depthTest={false} />
          </mesh>
          <mesh position={axisVisual3D.ptLineEnd3D}>
            <sphereGeometry args={[1.8, 16, 16]} />
            <meshBasicMaterial color="#06b6d4" depthTest={false} />
          </mesh>
        </group>
      )}

      {/* 4. 旋轉動態軌跡弧線與箭頭 (Rotation Arc & Arrow) */}
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

          {/* 5. 懸浮 3D HTML 標籤列 (視角不被遮擋) */}
          <Html position={arcVisual.labelPos} center distanceFactor={150}>
            <div
              className="bg-neutral-950/95 border border-purple-500/80 rounded-xl px-3 py-1.5 text-white shadow-2xl backdrop-blur-md pointer-events-auto flex items-center gap-2.5 select-none whitespace-nowrap text-xs animate-in fade-in duration-200"
              style={{ transform: 'translate3d(0, -18px, 0)' }}
            >
              <div className="flex items-center gap-1.5 font-mono font-bold text-purple-300">
                <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                <span>{isBoss ? '⟳ 旋轉長料' : '⟳ 旋轉除料'}:</span>
                <span className="text-white text-sm">{angleDeg}°</span>
              </div>

              {axisLine && (
                <span className="text-[11px] text-cyan-300 bg-cyan-950/80 border border-cyan-500/50 px-1.5 py-0.5 rounded font-mono font-semibold">
                  軸: #{axisLine.id.slice(0, 5)}
                </span>
              )}

              {/* 反轉方向按鈕 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleDirection();
                }}
                className="px-2 py-1 bg-purple-600/70 hover:bg-purple-500 text-white rounded-lg text-[11px] font-bold transition-all shadow-sm cursor-pointer border border-purple-400/40 active:scale-95"
                title="反轉旋轉方向 (Reverse Direction)"
              >
                反轉 ⇄
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
