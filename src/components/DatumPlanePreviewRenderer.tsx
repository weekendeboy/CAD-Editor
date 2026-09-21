import React, { useMemo, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Text, Html } from '@react-three/drei';
import { useCADStore } from '../store/cadStore';
import { DatumPlanePreviewState } from '../store/cadStore.types';
import {
  SketchFeature,
  CustomPlane,
  DatumFrontPlane,
  DatumPlaneFeature,
  LineEntity,
  ArcEntity,
  CircleEntity,
  Point3D,
} from '../types/cad';
import { mapPoint2DTo3D } from '../core/3d/FeaturePipelineAdapter';
import type { RuntimeBRepEdgeRef, RuntimeBRepVertexRef } from '../core/3d/SolidEngine.types';
import { resolveBRepEdgeToAxis } from '../core/3d/UnifiedReferenceResolver';

interface DatumPlanePreviewMeshProps {
  preview: NonNullable<DatumPlanePreviewState>;
}

interface CandidateAxisLineProps {
  line: LineEntity;
  plane: CustomPlane;
  isSelected: boolean;
  onSelect: (lineId: string) => void;
}

interface CandidateVertexPointProps {
  point: Point3D;
  id: string;
  label?: string;
  activePointIndex?: 1 | 2 | 3;
  onSelect: (point: Point3D) => void;
}

interface CandidateBRepEdgeLineProps {
  edgeRef: RuntimeBRepEdgeRef;
  isSelected: boolean;
  onSelect: (edgeRef: RuntimeBRepEdgeRef) => void;
}

/**
 * 3D 視圖中的實體邊線候選旋轉軸互動元件 (Solid B-Rep Edge)
 */
const CandidateBRepEdgeLine: React.FC<CandidateBRepEdgeLineProps> = ({
  edgeRef,
  isSelected,
  onSelect,
}) => {
  const [hovered, setHovered] = useState(false);

  const { mid, length, quaternion, lineGeom } = useMemo(() => {
    const start = edgeRef.startPoint || { x: 0, y: 0, z: 0 };
    const end = edgeRef.endPoint || { x: 0, y: 0, z: 0 };
    const v1 = new THREE.Vector3(start.x, start.y, start.z);
    const v2 = new THREE.Vector3(end.x, end.y, end.z);
    const m = v1.clone().add(v2).multiplyScalar(0.5);
    const dir = v2.clone().sub(v1);
    const len = Math.max(0.1, dir.length());
    dir.normalize();

    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir
    );

    const geom = new THREE.BufferGeometry().setFromPoints([v1, v2]);
    return { mid: m, length: len, quaternion: q, lineGeom: geom };
  }, [edgeRef.startPoint, edgeRef.endPoint]);

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
    onSelect(edgeRef);
  };

  return (
    <group name={`candidate-brep-edge-${edgeRef.edgeIndex}`}>
      {/* 寬容度拾取圓柱體 (Fat Hitbox Cylinder, 半徑 6mm) */}
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

      {/* 邊線可見幾何 */}
      <lineSegments geometry={lineGeom}>
        <lineBasicMaterial
          color={hovered || isSelected ? '#facc15' : '#818cf8'}
          linewidth={hovered || isSelected ? 4 : 2}
          depthTest={false}
        />
      </lineSegments>

      {/* 懸停提示標籤 */}
      {hovered && (
        <Html position={mid} center distanceFactor={140} zIndexRange={[160, 0]}>
          <div
            className="bg-neutral-950/95 border-2 border-amber-400 text-amber-300 px-2.5 py-1 rounded-lg text-xs font-mono font-bold shadow-2xl backdrop-blur flex items-center gap-1.5 pointer-events-none select-none animate-in fade-in zoom-in-90 duration-150 whitespace-nowrap"
            style={{ transform: 'translate3d(0, -22px, 0)' }}
          >
            <span>🎯 點擊設定為基準面旋轉軸</span>
            <span className="text-[10px] text-amber-200/70">
              (實體邊線 #{edgeRef.edgeIndex})
            </span>
          </div>
        </Html>
      )}
    </group>
  );
};

interface CandidateBRepVertexPointProps {
  vertexRef: RuntimeBRepVertexRef;
  activePointIndex?: 1 | 2 | 3;
  onSelect: (point: Point3D, vertexRef: RuntimeBRepVertexRef) => void;
}

/**
 * 3D 視圖中的實體頂點候選點互動元件 (Solid B-Rep Vertex)
 */
const CandidateBRepVertexPoint: React.FC<CandidateBRepVertexPointProps> = ({
  vertexRef,
  activePointIndex = 1,
  onSelect,
}) => {
  const [hovered, setHovered] = useState(false);
  const pos = useMemo(
    () => new THREE.Vector3(vertexRef.point.x, vertexRef.point.y, vertexRef.point.z),
    [vertexRef.point]
  );

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
    onSelect(vertexRef.point, vertexRef);
  };

  return (
    <group position={pos} name={`candidate-brep-vertex-${vertexRef.vertexIndex}`}>
      {/* 寬容度拾取球 (Fat Hitbox Sphere, 半徑 6mm) */}
      <mesh
        onPointerOver={handlePointerOver}
        onPointerOut={handlePointerOut}
        onPointerDown={handleClick}
        onClick={handleClick}
      >
        <sphereGeometry args={[6, 12, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* 可見頂點外觀 */}
      <mesh>
        <sphereGeometry args={[hovered ? 2.5 : 1.4, 16, 16]} />
        <meshBasicMaterial
          color={hovered ? '#facc15' : '#06b6d4'}
          depthTest={false}
        />
      </mesh>

      {/* 懸停提示標籤 */}
      {hovered && (
        <Html center distanceFactor={140} zIndexRange={[170, 0]}>
          <div
            className="bg-neutral-950/95 border-2 border-amber-400 text-amber-300 px-2.5 py-1 rounded-lg text-xs font-mono font-bold shadow-2xl backdrop-blur flex items-center gap-1.5 pointer-events-none select-none animate-in fade-in zoom-in-90 duration-150 whitespace-nowrap"
            style={{ transform: 'translate3d(0, -22px, 0)' }}
          >
            <span>🎯 點擊設定為 P{activePointIndex}</span>
            <span className="text-[10px] text-amber-200/70">
              (實體頂點 #{vertexRef.vertexIndex}: {vertexRef.point.x.toFixed(1)}, {vertexRef.point.y.toFixed(1)}, {vertexRef.point.z.toFixed(1)})
            </span>
          </div>
        </Html>
      )}
    </group>
  );
};

/**
 * 3D 視圖中的單一候選旋轉軸互動元件
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

  if (isSelected) {
    return (
      <group name={`selected-datum-axis-${line.id}`}>
        <Html position={mid} center distanceFactor={140} zIndexRange={[120, 0]}>
          <div
            className="bg-purple-950/95 border border-purple-400 text-purple-200 px-2 py-0.5 rounded-md text-[11px] font-mono font-bold shadow-xl backdrop-blur flex items-center gap-1 pointer-events-none select-none animate-in fade-in zoom-in-95 duration-150"
            style={{ transform: 'translate3d(0, -18px, 0)' }}
          >
            <span className="w-2 h-2 rounded-full bg-purple-400 animate-ping inline-block" />
            <span>🎯 基準面旋轉軸 (#{line.id.slice(0, 5)})</span>
          </div>
        </Html>
      </group>
    );
  }

  return (
    <group name={`candidate-datum-axis-${line.id}`}>
      {/* 1. 寬容度射線拾取圓柱體 (Fat Hitbox Cylinder, 半徑 6mm) */}
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
            color={line.isConstruction ? '#38bdf8' : '#c084fc'}
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
        <meshBasicMaterial color={hovered ? '#facc15' : '#c084fc'} depthTest={false} />
      </mesh>
      <mesh position={p2}>
        <sphereGeometry args={[hovered ? 2.2 : 1.2, 12, 12]} />
        <meshBasicMaterial color={hovered ? '#facc15' : '#c084fc'} depthTest={false} />
      </mesh>

      {/* 4. 懸停時浮現 3D 提示標籤 */}
      {hovered && (
        <Html position={mid} center distanceFactor={140} zIndexRange={[150, 0]}>
          <div
            className="bg-neutral-950/95 border-2 border-amber-400 text-amber-300 px-2.5 py-1 rounded-lg text-xs font-mono font-bold shadow-2xl backdrop-blur flex items-center gap-1.5 pointer-events-none select-none animate-in fade-in zoom-in-90 duration-150 whitespace-nowrap"
            style={{ transform: 'translate3d(0, -22px, 0)' }}
          >
            <span>👆 點擊設定為基準面旋轉軸</span>
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
 * 3D 視圖中的候選空間頂點互動元件 (Three-Point 模式)
 */
const CandidateVertexPoint: React.FC<CandidateVertexPointProps> = ({
  point,
  id,
  label,
  activePointIndex = 1,
  onSelect,
}) => {
  const [hovered, setHovered] = useState(false);
  const pos = useMemo(() => new THREE.Vector3(point.x, point.y, point.z), [point]);

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
    onSelect(point);
  };

  return (
    <group position={pos} name={`candidate-vertex-${id}`}>
      {/* 1. 寬容度射線拾取球 (Fat Hitbox Sphere, 半徑 6mm) */}
      <mesh
        onPointerOver={handlePointerOver}
        onPointerOut={handlePointerOut}
        onPointerDown={handleClick}
        onClick={handleClick}
      >
        <sphereGeometry args={[6, 12, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* 2. 可見頂點外觀 */}
      <mesh>
        <sphereGeometry args={[hovered ? 2.5 : 1.2, 16, 16]} />
        <meshBasicMaterial
          color={hovered ? '#facc15' : '#34d399'}
          depthTest={false}
        />
      </mesh>

      {/* 3. 懸停時提示標籤 */}
      {hovered && (
        <Html center distanceFactor={140} zIndexRange={[160, 0]}>
          <div
            className="bg-neutral-950/95 border-2 border-amber-400 text-amber-300 px-2.5 py-1 rounded-lg text-xs font-mono font-bold shadow-2xl backdrop-blur flex items-center gap-1.5 pointer-events-none select-none animate-in fade-in zoom-in-90 duration-150 whitespace-nowrap"
            style={{ transform: 'translate3d(0, -22px, 0)' }}
          >
            <span>🎯 點擊設定為 P{activePointIndex}</span>
            <span className="text-[10px] text-neutral-400">
              ({point.x.toFixed(1)}, {point.y.toFixed(1)}, {point.z.toFixed(1)})
            </span>
          </div>
        </Html>
      )}
    </group>
  );
};

/**
 * 空間基準面即時預覽網格元件 (Datum Plane Preview Mesh)
 * 支援 Offset, Angle, Three-Point 模式
 */
const DatumPlanePreviewMesh: React.FC<DatumPlanePreviewMeshProps> = ({ preview }) => {
  const groupRef = useRef<THREE.Group>(null);
  const plane = preview.plane;
  if (!plane) return null;

  const isAngle = preview.mode === 'angle';
  const isThreePoint = preview.mode === 'three-point';

  // 空間姿態矩陣
  const matrix = useMemo(() => {
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
    );
    const origin = new THREE.Vector3(
      plane.origin?.x ?? 0,
      plane.origin?.y ?? 0,
      plane.origin?.z ?? 0
    );

    m.makeBasis(xAxis, yAxis, normal);
    m.setPosition(origin);
    return m;
  }, [plane]);

  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.matrix.copy(matrix);
      groupRef.current.matrixAutoUpdate = false;
      groupRef.current.matrixWorldNeedsUpdate = true;
    }
  }, [matrix]);

  // 200x200 mm 邊框幾何
  const borderGeometry = useMemo(() => {
    const points = [
      new THREE.Vector3(-100, -100, 0),
      new THREE.Vector3(100, -100, 0),
      new THREE.Vector3(100, 100, 0),
      new THREE.Vector3(-100, 100, 0),
      new THREE.Vector3(-100, -100, 0),
    ];
    return new THREE.BufferGeometry().setFromPoints(points);
  }, []);

  useEffect(() => {
    return () => {
      borderGeometry.dispose();
    };
  }, [borderGeometry]);

  // 局部坐標軸 Trihedron (X 紅, Y 綠, Z 藍/紫/翡翠綠)
  const trihedronGroup = useMemo(() => {
    const group = new THREE.Group();
    const origin = new THREE.Vector3(0, 0, 0);
    const length = 25;
    const headLength = 5;
    const headWidth = 3;

    const xArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      origin,
      length,
      0xef4444,
      headLength,
      headWidth
    );
    const yArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      origin,
      length,
      0x22c55e,
      headLength,
      headWidth
    );
    const zArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1),
      origin,
      length,
      isThreePoint ? 0x10b981 : isAngle ? 0xa855f7 : 0x06b6d4,
      headLength,
      headWidth
    );

    group.add(xArrow);
    group.add(yArrow);
    group.add(zArrow);
    return group;
  }, [isAngle, isThreePoint]);

  useEffect(() => {
    return () => {
      trihedronGroup.traverse((child) => {
        if ((child as THREE.Mesh).geometry) {
          (child as THREE.Mesh).geometry.dispose();
        }
        if ((child as THREE.Mesh).material) {
          const mat = (child as THREE.Mesh).material;
          if (Array.isArray(mat)) {
            mat.forEach((m) => m.dispose());
          } else {
            mat.dispose();
          }
        }
      });
    };
  }, [trihedronGroup]);

  // 動態文字標籤
  const label = useMemo(() => {
    if (isThreePoint) {
      return `[預覽 Preview] 三點基準面 (Three Point Plane)`;
    }
    if (isAngle) {
      const angle = preview.rotationAngleDeg ?? 0;
      const axisInfo =
        preview.axisSourceMode === 'sketch_edge'
          ? `草圖直線 #${preview.selectedLineEntityId?.slice(0, 5) || ''}`
          : `${preview.standardAxis || 'X'} 軸`;
      return `[預覽 Preview] 旋轉: ${angle >= 0 ? '+' : ''}${angle}° (${axisInfo})`;
    }
    const dist = preview.offsetDistance ?? 0;
    return `[預覽 Preview] 偏移: ${dist >= 0 ? '+' : ''}${dist} mm`;
  }, [isThreePoint, isAngle, preview.rotationAngleDeg, preview.axisSourceMode, preview.selectedLineEntityId, preview.standardAxis, preview.offsetDistance]);

  const planeColor = isThreePoint ? '#10b981' : isAngle ? '#a855f7' : '#06b6d4';
  const borderColor = isThreePoint ? '#34d399' : isAngle ? '#c084fc' : '#22d3ee';
  const textColor = isThreePoint ? '#a7f3d0' : isAngle ? '#e9d5ff' : '#67e8f9';

  return (
    <group ref={groupRef} name="datum-plane-preview-group">
      {/* 半透明預覽面 (透明度 0.22) */}
      <mesh>
        <planeGeometry args={[200, 200]} />
        <meshBasicMaterial
          color={planeColor}
          side={THREE.DoubleSide}
          transparent
          opacity={0.22}
          depthWrite={false}
        />
      </mesh>

      {/* 邊框線 */}
      <lineLoop geometry={borderGeometry}>
        <lineBasicMaterial
          color={borderColor}
          linewidth={2}
          depthTest={false}
        />
      </lineLoop>

      {/* 局部坐標軸 Trihedron */}
      <primitive object={trihedronGroup} />

      {/* 頂部文字標籤 */}
      <Text
        position={[-95, 92, 0.5]}
        fontSize={8.5}
        color={textColor}
        anchorX="left"
        anchorY="top"
        outlineWidth={0.8}
        outlineColor="#082f49"
      >
        {label}
      </Text>
    </group>
  );
};

/**
 * 空間旋轉軸 3D 可視化輔助線 (Rotation Axis Visualizer)
 */
const ActiveRotationAxisVisualizer: React.FC<{
  axisOrigin: { x: number; y: number; z: number };
  axisDirection: { x: number; y: number; z: number };
}> = ({ axisOrigin, axisDirection }) => {
  const { lineGeom, originVec, dirVec, p1, p2 } = useMemo(() => {
    const origin = new THREE.Vector3(axisOrigin.x, axisOrigin.y, axisOrigin.z);
    const dir = new THREE.Vector3(axisDirection.x, axisDirection.y, axisDirection.z).normalize();
    const p1 = origin.clone().add(dir.clone().multiplyScalar(-200));
    const p2 = origin.clone().add(dir.clone().multiplyScalar(200));
    const geom = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    return { lineGeom: geom, originVec: origin, dirVec: dir, p1, p2 };
  }, [axisOrigin, axisDirection]);

  useEffect(() => {
    return () => {
      lineGeom.dispose();
    };
  }, [lineGeom]);

  return (
    <group name="active-rotation-axis-visualizer">
      {/* 延伸虛線 */}
      <lineSegments geometry={lineGeom}>
        <lineDashedMaterial
          color="#e879f9"
          dashSize={8}
          gapSize={4}
          linewidth={3}
          depthTest={false}
        />
      </lineSegments>

      {/* 軸線中心原點球體 */}
      <mesh position={originVec}>
        <sphereGeometry args={[2.5, 16, 16]} />
        <meshBasicMaterial color="#f472b6" depthTest={false} />
      </mesh>

      {/* 方向箭頭 */}
      <arrowHelper
        args={[dirVec, originVec, 50, 0xf472b6, 8, 4]}
      />
    </group>
  );
};

/**
 * 三點基準面 3D 輔助三角形與點標籤可視化元件
 */
const ThreePointVisualizer: React.FC<{
  p1?: Point3D | null;
  p2?: Point3D | null;
  p3?: Point3D | null;
}> = ({ p1, p2, p3 }) => {
  const v1 = useMemo(() => (p1 ? new THREE.Vector3(p1.x, p1.y, p1.z) : null), [p1]);
  const v2 = useMemo(() => (p2 ? new THREE.Vector3(p2.x, p2.y, p2.z) : null), [p2]);
  const v3 = useMemo(() => (p3 ? new THREE.Vector3(p3.x, p3.y, p3.z) : null), [p3]);

  // 三角形邊框線條
  const triangleGeom = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    if (v1 && v2) {
      pts.push(v1, v2);
    }
    if (v2 && v3) {
      pts.push(v2, v3);
    }
    if (v3 && v1) {
      pts.push(v3, v1);
    }
    if (pts.length === 0) return null;
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [v1, v2, v3]);

  useEffect(() => {
    return () => {
      triangleGeom?.dispose();
    };
  }, [triangleGeom]);

  return (
    <group name="three-point-visualizer">
      {/* 1. 連接線條 */}
      {triangleGeom && (
        <lineSegments geometry={triangleGeom}>
          <lineBasicMaterial color="#34d399" linewidth={2} depthTest={false} />
        </lineSegments>
      )}

      {/* 2. 點 1 (原點) */}
      {v1 && (
        <group position={v1}>
          <mesh>
            <sphereGeometry args={[2.5, 16, 16]} />
            <meshBasicMaterial color="#10b981" depthTest={false} />
          </mesh>
          <Html center distanceFactor={140} zIndexRange={[140, 0]}>
            <div
              className="bg-emerald-950/95 border border-emerald-400 text-emerald-200 px-2 py-0.5 rounded-md text-[11px] font-mono font-bold shadow-xl backdrop-blur pointer-events-none select-none whitespace-nowrap"
              style={{ transform: 'translate3d(0, -18px, 0)' }}
            >
              📍 P1 (原點)
            </div>
          </Html>
        </group>
      )}

      {/* 3. 點 2 (X軸向) */}
      {v2 && (
        <group position={v2}>
          <mesh>
            <sphereGeometry args={[2.5, 16, 16]} />
            <meshBasicMaterial color="#3b82f6" depthTest={false} />
          </mesh>
          <Html center distanceFactor={140} zIndexRange={[140, 0]}>
            <div
              className="bg-blue-950/95 border border-blue-400 text-blue-200 px-2 py-0.5 rounded-md text-[11px] font-mono font-bold shadow-xl backdrop-blur pointer-events-none select-none whitespace-nowrap"
              style={{ transform: 'translate3d(0, -18px, 0)' }}
            >
              📍 P2 (X 軸向)
            </div>
          </Html>
        </group>
      )}

      {/* 4. 點 3 (平面法向) */}
      {v3 && (
        <group position={v3}>
          <mesh>
            <sphereGeometry args={[2.5, 16, 16]} />
            <meshBasicMaterial color="#f59e0b" depthTest={false} />
          </mesh>
          <Html center distanceFactor={140} zIndexRange={[140, 0]}>
            <div
              className="bg-amber-950/95 border border-amber-400 text-amber-200 px-2 py-0.5 rounded-md text-[11px] font-mono font-bold shadow-xl backdrop-blur pointer-events-none select-none whitespace-nowrap"
              style={{ transform: 'translate3d(0, -18px, 0)' }}
            >
              📍 P3 (平面定向)
            </div>
          </Html>
        </group>
      )}
    </group>
  );
};

/**
 * 基準面即時預覽渲染容器
 * 訂閱 datumPlanePreview 狀態，存在預覽時掛載 DatumPlanePreviewMesh 與候選互動元件
 */
export const DatumPlanePreviewRenderer: React.FC = () => {
  const datumPlanePreview = useCADStore((state) => state.datumPlanePreview);
  const featureTree = useCADStore((state) => state.document.featureTree);
  const planes = useCADStore((state) => state.document.planes);
  const cumulativeSubshapeMapping = useCADStore((state) => state.cumulativeSubshapeMapping);

  // 解析模型實體邊線 (作為候選旋轉軸)
  const candidateBRepEdges = useMemo(() => {
    if (!datumPlanePreview || datumPlanePreview.mode !== 'angle') return [];
    if (!cumulativeSubshapeMapping?.edges) return [];
    return cumulativeSubshapeMapping.edges.filter(
      (e) =>
        e.startPoint &&
        e.endPoint &&
        (Math.abs(e.startPoint.x - e.endPoint.x) > 1e-3 ||
          Math.abs(e.startPoint.y - e.endPoint.y) > 1e-3 ||
          Math.abs(e.startPoint.z - e.endPoint.z) > 1e-3)
    );
  }, [datumPlanePreview, cumulativeSubshapeMapping]);

  // 解析模型實體頂點 (作為候選 Three-Point 點)
  const candidateBRepVertices = useMemo(() => {
    if (!datumPlanePreview || datumPlanePreview.mode !== 'three-point') return [];
    if (!cumulativeSubshapeMapping?.vertices) return [];
    return cumulativeSubshapeMapping.vertices.filter((v) => v.point !== undefined);
  }, [datumPlanePreview, cumulativeSubshapeMapping]);

  // 解析所有草圖中的線段實體 (作為候選旋轉軸)
  const candidateSketchesWithLines = useMemo(() => {
    if (!datumPlanePreview || datumPlanePreview.mode !== 'angle') return [];

    const results: { line: LineEntity; plane: CustomPlane }[] = [];
    (featureTree || []).forEach((f) => {
      if (f.type === 'SKETCH') {
        const sketch = f as SketchFeature;
        let sketchPlane: CustomPlane = DatumFrontPlane;
        if (sketch.planeFeatureId) {
          if (planes && planes[sketch.planeFeatureId]) {
            sketchPlane = planes[sketch.planeFeatureId];
          } else {
            const datumFeat = (featureTree || []).find(
              (feat) => feat.id === sketch.planeFeatureId
            ) as DatumPlaneFeature | undefined;
            if (datumFeat?.plane) sketchPlane = datumFeat.plane;
          }
        } else if (sketch.plane) {
          sketchPlane = sketch.plane;
        }

        (sketch.entities || []).forEach((ent) => {
          if (ent.type === 'line') {
            results.push({
              line: ent as LineEntity,
              plane: sketchPlane,
            });
          }
        });
      }
    });
    return results;
  }, [datumPlanePreview, featureTree, planes]);

  // 解析所有草圖中的頂點/中心點 (作為 Three-Point 候選點)
  const candidateVertices = useMemo(() => {
    if (!datumPlanePreview || datumPlanePreview.mode !== 'three-point') return [];

    const results: { id: string; point: Point3D; label: string }[] = [];
    const seen = new Set<string>();

    (featureTree || []).forEach((f) => {
      if (f.type === 'SKETCH') {
        const sketch = f as SketchFeature;
        let sketchPlane: CustomPlane = DatumFrontPlane;
        if (sketch.planeFeatureId) {
          if (planes && planes[sketch.planeFeatureId]) {
            sketchPlane = planes[sketch.planeFeatureId];
          } else {
            const datumFeat = (featureTree || []).find(
              (feat) => feat.id === sketch.planeFeatureId
            ) as DatumPlaneFeature | undefined;
            if (datumFeat?.plane) sketchPlane = datumFeat.plane;
          }
        } else if (sketch.plane) {
          sketchPlane = sketch.plane;
        }

        (sketch.entities || []).forEach((ent) => {
          if (ent.type === 'line') {
            const line = ent as LineEntity;
            const p1 = mapPoint2DTo3D(line.start, sketchPlane);
            const p2 = mapPoint2DTo3D(line.end, sketchPlane);
            const k1 = `${p1.x.toFixed(2)},${p1.y.toFixed(2)},${p1.z.toFixed(2)}`;
            const k2 = `${p2.x.toFixed(2)},${p2.y.toFixed(2)},${p2.z.toFixed(2)}`;
            if (!seen.has(k1)) {
              seen.add(k1);
              results.push({ id: `${ent.id}-start`, point: p1, label: `${sketch.name} Line Start` });
            }
            if (!seen.has(k2)) {
              seen.add(k2);
              results.push({ id: `${ent.id}-end`, point: p2, label: `${sketch.name} Line End` });
            }
          } else if (ent.type === 'arc') {
            const arc = ent as ArcEntity;
            const startPt = {
              x: arc.center.x + arc.radius * Math.cos(arc.startAngle),
              y: arc.center.y + arc.radius * Math.sin(arc.startAngle),
            };
            const endPt = {
              x: arc.center.x + arc.radius * Math.cos(arc.endAngle),
              y: arc.center.y + arc.radius * Math.sin(arc.endAngle),
            };
            const p1 = mapPoint2DTo3D(startPt, sketchPlane);
            const p2 = mapPoint2DTo3D(endPt, sketchPlane);
            const pc = mapPoint2DTo3D(arc.center, sketchPlane);
            const k1 = `${p1.x.toFixed(2)},${p1.y.toFixed(2)},${p1.z.toFixed(2)}`;
            const k2 = `${p2.x.toFixed(2)},${p2.y.toFixed(2)},${p2.z.toFixed(2)}`;
            const kc = `${pc.x.toFixed(2)},${pc.y.toFixed(2)},${pc.z.toFixed(2)}`;
            if (!seen.has(k1)) { seen.add(k1); results.push({ id: `${ent.id}-start`, point: p1, label: 'Arc Start' }); }
            if (!seen.has(k2)) { seen.add(k2); results.push({ id: `${ent.id}-end`, point: p2, label: 'Arc End' }); }
            if (!seen.has(kc)) { seen.add(kc); results.push({ id: `${ent.id}-center`, point: pc, label: 'Arc Center' }); }
          } else if (ent.type === 'circle') {
            const circle = ent as CircleEntity;
            const pc = mapPoint2DTo3D(circle.center, sketchPlane);
            const kc = `${pc.x.toFixed(2)},${pc.y.toFixed(2)},${pc.z.toFixed(2)}`;
            if (!seen.has(kc)) { seen.add(kc); results.push({ id: `${ent.id}-center`, point: pc, label: 'Circle Center' }); }
          }
        });
      }
    });
    return results;
  }, [datumPlanePreview, featureTree, planes]);

  const handleSelectAxisLine = (lineId: string) => {
    window.dispatchEvent(
      new CustomEvent('cad-set-datum-axis', { detail: lineId })
    );
  };

  const handleSelectBRepEdge = (edgeRef: RuntimeBRepEdgeRef) => {
    const resolved = resolveBRepEdgeToAxis(edgeRef);
    if (!resolved.isValid || !resolved.reference) {
      alert(resolved.error || '無法使用該邊線作為旋轉軸');
      return;
    }
    window.dispatchEvent(
      new CustomEvent('cad-set-datum-axis-edge', {
        detail: {
          axisOrigin: resolved.reference.axisOrigin,
          axisDirection: resolved.reference.axisDirection,
          edgeRef,
        },
      })
    );
    useCADStore.getState().setDatumPickerTarget(null);
  };

  const handleSelectPoint = (point: Point3D, vertexRef?: RuntimeBRepVertexRef) => {
    window.dispatchEvent(
      new CustomEvent('cad-set-datum-point', {
        detail: {
          point,
          index: datumPlanePreview?.activePointIndex || 1,
          vertexRef,
        },
      })
    );
  };

  if (!datumPlanePreview || !datumPlanePreview.isOpen) {
    return null;
  }

  const isAngle = datumPlanePreview.mode === 'angle';
  const isThreePoint = datumPlanePreview.mode === 'three-point';

  return (
    <group name="datum-plane-preview-container">
      {/* 1. 基準面姿態網格與 Trihedron 預覽 (若已求解出有效 CustomPlane) */}
      {datumPlanePreview.plane && datumPlanePreview.isValid && (
        <DatumPlanePreviewMesh preview={datumPlanePreview} />
      )}

      {/* 2. Angle 模式：渲染當前旋轉軸線可視化 */}
      {isAngle && datumPlanePreview.axisOrigin && datumPlanePreview.axisDirection && (
        <ActiveRotationAxisVisualizer
          axisOrigin={datumPlanePreview.axisOrigin}
          axisDirection={datumPlanePreview.axisDirection}
        />
      )}

      {/* 3. Angle 模式：渲染候選旋轉軸 (包含實體邊線與草圖直線) */}
      {isAngle &&
        candidateBRepEdges.map((edgeRef) => (
          <CandidateBRepEdgeLine
            key={`brep-edge-${edgeRef.edgeIndex}`}
            edgeRef={edgeRef}
            isSelected={
              datumPlanePreview.selectedEdgeRef?.edgeIndex === edgeRef.edgeIndex
            }
            onSelect={handleSelectBRepEdge}
          />
        ))}

      {isAngle &&
        candidateSketchesWithLines.map(({ line, plane }) => (
          <CandidateAxisLine
            key={line.id}
            line={line}
            plane={plane}
            isSelected={datumPlanePreview.selectedLineEntityId === line.id}
            onSelect={handleSelectAxisLine}
          />
        ))}

      {/* 4. Three-Point 模式：渲染當前選取的 P1, P2, P3 點與三角形連結 */}
      {isThreePoint && (
        <ThreePointVisualizer
          p1={datumPlanePreview.point1}
          p2={datumPlanePreview.point2}
          p3={datumPlanePreview.point3}
        />
      )}

      {/* 5. Three-Point 模式：渲染候選空間頂點 (包含實體頂點與草圖頂點) */}
      {isThreePoint &&
        candidateBRepVertices.map((v) => (
          <CandidateBRepVertexPoint
            key={`brep-v-${v.vertexIndex}`}
            vertexRef={v}
            activePointIndex={datumPlanePreview.activePointIndex}
            onSelect={handleSelectPoint}
          />
        ))}

      {isThreePoint &&
        candidateVertices.map((v) => (
          <CandidateVertexPoint
            key={v.id}
            id={v.id}
            point={v.point}
            label={v.label}
            activePointIndex={datumPlanePreview.activePointIndex}
            onSelect={handleSelectPoint}
          />
        ))}
    </group>
  );
};

export default DatumPlanePreviewRenderer;
