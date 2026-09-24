import React, { useMemo, useState, useEffect, useRef, Suspense, Component, ErrorInfo, ReactNode, useCallback } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Environment, Grid, Text, Html } from '@react-three/drei';
import * as THREE from 'three';
import { Pencil, X } from 'lucide-react';

// 攔截 console.warn 來隱藏 THREE.Clock 的棄用警告，避免修改唯讀的 ES 模組導致 Crash
const originalWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('THREE.Clock: This module has been deprecated')) {
    return;
  }
  originalWarn(...args);
};

import { useCADStore } from '../store/cadStore';
import {
  CustomPlane,
  DatumFrontPlane,
  DatumTopPlane,
  DatumRightPlane,
  DatumPlaneFeature,
  Point3D,
} from '../types/cad';
import { solidEngine } from '../core/3d/SolidEngine';
import { createPlaneFromFaceNormal } from '../core/3d/DatumPlaneEngine';
import { resolveTriangleToFace, resolveMeshEdgeToEdge } from '../core/3d/MeshSubshapeResolver';
import { resolveBRepFaceToReference, resolveBRepEdgeToAxis } from '../core/3d/UnifiedReferenceResolver';
import { sampleArcPoints, generateArcHitboxSegments } from '../core/3d/ArcGeometryHelper';
import type { RuntimeBRepFaceRef, RuntimeBRepEdgeRef, MeshSubshapeMapping } from '../core/3d/SolidEngine.types';
import { ExtrudePreviewRenderer } from './ExtrudePreviewRenderer';
import { RevolvePreviewRenderer } from './RevolvePreviewRenderer';
import { DatumPlanePreviewRenderer } from './DatumPlanePreviewRenderer';
import { Sketch3DRenderer } from './Sketch3DRenderer';

// Error Boundary 元件，防止 3D Canvas 渲染或 WebGL 錯誤導致整個 React 畫面白屏
interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ThreeErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('CAD3DCanvas Error Boundary caught an error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div
          className="w-full h-full flex flex-col items-center justify-center bg-slate-900 text-slate-300 p-6"
          id="three-error-boundary-fallback"
        >
          <div className="bg-slate-800 border border-red-500/50 rounded-lg p-6 max-w-md text-center shadow-xl">
            <h3 className="text-lg font-bold text-red-400 mb-2">3D 視圖載入異常</h3>
            <p className="text-sm text-slate-400 mb-4">
              {this.state.error?.message || '渲染 3D 實體模型時發生錯誤。'}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-semibold transition-colors"
              id="retry-three-rendering-btn"
            >
              重新嘗試載入
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

interface DatumPlaneMeshProps {
  plane: CustomPlane;
  name: string;
  visible?: boolean;
  isSelected: boolean;
  onSelect?: () => void;
}

const DatumPlaneMesh: React.FC<DatumPlaneMeshProps> = ({
  plane,
  name,
  visible = true,
  isSelected,
  onSelect,
}) => {
  const groupRef = useRef<THREE.Group>(null);

  // 姿態變換：使用 THREE.Matrix4.makeBasis(xAxis, yAxis, normal) 並 setPosition(origin)
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

  // 預設 200x200 mm 邊框幾何 (Border Wireframe)
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

  // 局部坐標軸 (Trihedron)：在原點繪製長度 25mm 的微型坐標箭頭 (X 紅、Y 綠、Z 藍)
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
      0x3b82f6,
      headLength,
      headWidth
    );

    group.add(xArrow);
    group.add(yArrow);
    group.add(zArrow);
    return group;
  }, []);

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

  const datumPreview = useCADStore((state) => state.datumPlanePreview);
  const isPickingRefPlane = datumPreview?.isOpen && datumPreview.activePicker === 'reference_plane';
  const [hovered, setHovered] = useState(false);

  if (!visible) return null;

  return (
    <group
      ref={groupRef}
      onPointerOver={(e) => {
        if (isPickingRefPlane) {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }
      }}
      onPointerOut={() => {
        if (isPickingRefPlane) {
          setHovered(false);
          document.body.style.cursor = 'auto';
        }
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (isPickingRefPlane) {
          window.dispatchEvent(
            new CustomEvent('cad-set-datum-reference-plane', {
              detail: {
                plane,
                planeId: plane.id,
                name,
              },
            })
          );
          useCADStore.getState().setDatumPickerTarget(null);
          return;
        }
        if (onSelect) onSelect();
      }}
    >
      {/* 半透明平面 (尺寸 200x200 mm，天藍色 #0284c7，未選中透明度 0.08，選中時 0.2，拾取懸停時 0.35) */}
      <mesh>
        <planeGeometry args={[200, 200]} />
        <meshBasicMaterial
          color={isPickingRefPlane && hovered ? '#10b981' : '#0284c7'}
          side={THREE.DoubleSide}
          transparent
          opacity={isPickingRefPlane && hovered ? 0.35 : isSelected ? 0.2 : 0.08}
          depthWrite={false}
        />
      </mesh>

      {/* 邊框線 (Border Wireframe)：選中或拾取懸停時金黃/綠色 */}
      <lineLoop geometry={borderGeometry}>
        <lineBasicMaterial
          color={isPickingRefPlane && hovered ? '#34d399' : isSelected ? '#facc15' : '#0369a1'}
          linewidth={isPickingRefPlane && hovered ? 3 : 2}
        />
      </lineLoop>

      {/* 局部坐標軸 Trihedron (X 紅, Y 綠, Z 藍) */}
      <primitive object={trihedronGroup} />

      {/* 文字標籤：左上角顯示基準面名稱 */}
      <Text
        position={[-95, 92, 0.5]}
        fontSize={9}
        color={isPickingRefPlane && hovered ? '#34d399' : isSelected ? '#fde047' : '#38bdf8'}
        anchorX="left"
        anchorY="top"
        outlineWidth={0.6}
        outlineColor="#0f172a"
      >
        {name}
      </Text>

      {/* 3D 拾取參考面提示 */}
      {isPickingRefPlane && hovered && (
        <Html position={[0, 0, 0]} center distanceFactor={140} zIndexRange={[160, 0]}>
          <div
            className="bg-emerald-950/95 border-2 border-emerald-400 text-emerald-300 px-2.5 py-1 rounded-lg text-xs font-mono font-bold shadow-2xl backdrop-blur flex items-center gap-1.5 pointer-events-none select-none animate-in fade-in zoom-in-90 duration-150 whitespace-nowrap"
            style={{ transform: 'translate3d(0, -20px, 0)' }}
          >
            <span>🎯 點擊設定為 Reference Plane</span>
            <span className="text-[10px] text-emerald-200/70">({name})</span>
          </div>
        </Html>
      )}
    </group>
  );
};

export interface SelectedFaceState {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  triangleIndex?: number;
  faceRef?: RuntimeBRepFaceRef;
}

export interface SelectedEdgeState {
  edgeRef: RuntimeBRepEdgeRef;
  startPoint: Point3D;
  endPoint: Point3D;
  meshEdgeIndex?: number;
}

interface InteractiveBRepEdgeProps {
  edgeRef: RuntimeBRepEdgeRef;
  mapping: MeshSubshapeMapping;
  edgeVertices: Float32Array | null;
  isSelected: boolean;
  isHovered: boolean;
  onHover: (edgeIndex: number | null) => void;
  onSelect: (edge: SelectedEdgeState, isShift: boolean) => void;
}

/**
 * 3D 視圖中的實體邊線 (Solid B-Rep Edge) 獨立拾取與高亮元件
 */
const InteractiveBRepEdge: React.FC<InteractiveBRepEdgeProps> = ({
  edgeRef,
  mapping,
  edgeVertices,
  isSelected,
  isHovered,
  onHover,
  onSelect,
}) => {
  const start = edgeRef.startPoint || { x: 0, y: 0, z: 0 };
  const end = edgeRef.endPoint || { x: 0, y: 0, z: 0 };

  // 1. 取得真實曲線上之高密度取樣點 (圓弧/曲線取樣 32 段，直線則為起訖兩點)
  const arcPoints = useMemo(() => sampleArcPoints(edgeRef, 32), [edgeRef]);

  // 2. 依據真實幾何生成一組或多組 Fat Hitbox 圓柱段落 (半徑 6mm)
  const hitboxSegments = useMemo(() => generateArcHitboxSegments(arcPoints), [arcPoints]);

  // 3. 幾何渲染線：若 mapping 有提供連續頂點段落則使用，否則使用 arcPoints 建立連續線段
  const lineGeom = useMemo(() => {
    const range = mapping.edgeSegmentRanges?.find((r) => r.edgeIndex === edgeRef.edgeIndex);
    if (range && range.segmentCount > 0 && edgeVertices) {
      const startFloat = range.startSegment * 6;
      const endFloat = startFloat + range.segmentCount * 6;
      if (edgeVertices.length >= endFloat) {
        const segmentFloats = edgeVertices.subarray(startFloat, endFloat);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segmentFloats), 3));
        return geom;
      }
    }
    // 由 arcPoints 建立連續線段
    const lineFloats: number[] = [];
    for (let i = 0; i < arcPoints.length - 1; i++) {
      lineFloats.push(arcPoints[i].x, arcPoints[i].y, arcPoints[i].z, arcPoints[i + 1].x, arcPoints[i + 1].y, arcPoints[i + 1].z);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lineFloats), 3));
    return geom;
  }, [mapping, edgeRef, edgeVertices, arcPoints]);

  useEffect(() => {
    return () => {
      lineGeom.dispose();
    };
  }, [lineGeom]);

  // 4. 懸停標籤位置：落在真實圓弧的中間頂點 (Apex)，而非 chord 中間
  const labelPos = useMemo(() => {
    if (arcPoints.length > 0) {
      const midIdx = Math.floor(arcPoints.length / 2);
      return new THREE.Vector3(arcPoints[midIdx].x, arcPoints[midIdx].y, arcPoints[midIdx].z);
    }
    return new THREE.Vector3((start.x + end.x) * 0.5, (start.y + end.y) * 0.5, (start.z + end.z) * 0.5);
  }, [arcPoints, start, end]);

  const handlePointerOver = (e: any) => {
    e.stopPropagation();
    onHover(edgeRef.edgeIndex);
    document.body.style.cursor = 'pointer';
  };

  const handlePointerOut = (e: any) => {
    e.stopPropagation();
    onHover(null);
    document.body.style.cursor = 'auto';
  };

  const handleClick = (e: any) => {
    e.stopPropagation();
    if (e.nativeEvent?.stopImmediatePropagation) {
      e.nativeEvent.stopImmediatePropagation();
    }
    const isShift = !!(e.shiftKey || e.nativeEvent?.shiftKey);
    onSelect({
      edgeRef,
      startPoint: start,
      endPoint: end,
      meshEdgeIndex: edgeRef.edgeIndex,
    }, isShift);
  };

  const lineColor = isSelected ? '#facc15' : isHovered ? '#38bdf8' : '#334155';
  const lineWidth = isSelected ? 4 : isHovered ? 3 : 1.5;

  return (
    <group name={`brep-edge-${edgeRef.edgeIndex}`}>
      {/* 寬容度拾取圓柱體組 (Fat Hitbox Cylinders, 半徑 6mm, 沿真實圓弧/直線分段包覆) */}
      {hitboxSegments.map((seg) => {
        const q = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(seg.direction.x, seg.direction.y, seg.direction.z)
        );
        return (
          <mesh
            key={`hitbox-seg-${seg.segmentIndex}`}
            position={[seg.mid.x, seg.mid.y, seg.mid.z]}
            quaternion={q}
            onPointerOver={handlePointerOver}
            onPointerOut={handlePointerOut}
            onPointerDown={handleClick}
            onClick={handleClick}
          >
            <cylinderGeometry args={[6, 6, seg.length, 8]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        );
      })}

      {/* 邊線可見幾何 (平滑圓弧或直線) */}
      <lineSegments geometry={lineGeom}>
        <lineBasicMaterial
          color={lineColor}
          linewidth={lineWidth}
          depthTest={true}
        />
      </lineSegments>

      {/* 選取狀態下的端點高亮指示球 */}
      {isSelected && (
        <>
          <mesh position={[start.x, start.y, start.z]}>
            <sphereGeometry args={[1.5, 16, 16]} />
            <meshBasicMaterial color="#facc15" />
          </mesh>
          <mesh position={[end.x, end.y, end.z]}>
            <sphereGeometry args={[1.5, 16, 16]} />
            <meshBasicMaterial color="#facc15" />
          </mesh>
        </>
      )}

      {/* 懸停提示標籤 (置於圓弧本體 Apex 處) */}
      {isHovered && !isSelected && (
        <Html position={labelPos} center distanceFactor={140} zIndexRange={[160, 0]}>
          <div
            className="bg-slate-900/95 border border-sky-400 text-sky-300 px-2.5 py-1 rounded-lg text-xs font-mono font-bold shadow-2xl backdrop-blur flex items-center gap-1.5 pointer-events-none select-none animate-in fade-in zoom-in-90 duration-150 whitespace-nowrap"
            style={{ transform: 'translate3d(0, -20px, 0)' }}
          >
            <span>
              {edgeRef.curveType === 'circle' ? '圓弧邊線' : '邊線'} #{edgeRef.edgeIndex}
            </span>
            <span className="text-[10px] text-slate-400">
              {edgeRef.radius ? `(R: ${edgeRef.radius.toFixed(1)}mm)` : edgeRef.length ? `(長度: ${edgeRef.length.toFixed(1)}mm)` : ''}
            </span>
          </div>
        </Html>
      )}
    </group>
  );
};

interface CumulativePartMeshProps {
  onFaceSelect: (selection: SelectedFaceState) => void;
  onEdgeSelect?: (selection: SelectedEdgeState, isShift: boolean) => void;
}

/**
 * 單一累進實體模型渲染元件 CumulativePartMesh
 * 訂閱 document.featureTree 與 document.rollbackIndex
 * 當特徵樹或回退棒變更時，透過 OpenCASCADE 執行完整 CSG 布林運算（含 Boolean Cut 除料）
 */
const CumulativePartMesh: React.FC<CumulativePartMeshProps> = ({ onFaceSelect, onEdgeSelect }) => {
  const document = useCADStore((state) => state.document);
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [mapping, setMapping] = useState<MeshSubshapeMapping | null>(null);
  const [edgeVertices, setEdgeVertices] = useState<Float32Array | null>(null);
  const [hoveredEdgeIndex, setHoveredEdgeIndex] = useState<number | null>(null);

  const selectedEdgeInfo = useCADStore((state) => state.selectedEdgeInfo);
  const selectedEdgeList = useCADStore((state) => state.selectedEdgeList);
  const filletChamferPreview = useCADStore((state) => state.filletChamferPreview);

  const featureTree = document?.featureTree ?? [];
  const rollbackIndex = document?.rollbackIndex ?? 0;
  const planes = document?.planes ?? {};
  const show3DEdges = useCADStore((state) => state.show3DEdges);
  const extrudePreview = useCADStore((state) => state.extrudePreview);

  const editingFeatureId = featureTree && rollbackIndex < featureTree.length ? featureTree[rollbackIndex]?.id : null;
  const previewFeatureId = extrudePreview?.isOpen ? (editingFeatureId || extrudePreview.sketchId) : null;
  const canonicalFeatureIds = useMemo(() => (featureTree || []).slice(0, Math.max(0, rollbackIndex)).map((f) => f.id), [featureTree, rollbackIndex]);
  const canonicalSolidIds = useMemo(() => {
    return (featureTree || [])
      .slice(0, Math.max(0, rollbackIndex))
      .filter((f) => f.type === 'EXTRUDE' || f.type === 'CUT_EXTRUDE' || f.type === 'REVOLVE' || f.type === 'REVOLVE_CUT' || f.type === 'SWEEP' || f.type === 'LOFT')
      .map((f) => f.id);
  }, [featureTree, rollbackIndex]);

  useEffect(() => {
    console.log('[EDIT TRACE]', {
      editingFeatureId,
      rollbackIndex,
      canonicalFeatureIds,
      canonicalSolidIds,
      previewFeatureId,
      renderedSolidFeatureIds: canonicalSolidIds,
      renderedSketchIds: (featureTree || []).slice(0, Math.max(0, rollbackIndex)).filter((f) => f.type === 'SKETCH' && !f.suppressed && f.visible !== false).map((f) => f.id),
    });
  }, [editingFeatureId, rollbackIndex, canonicalFeatureIds, canonicalSolidIds, previewFeatureId, featureTree]);

  // 金屬質感灰色 Standard 材質 (color="#cbd5e1", metalness=0.2, roughness=0.5)
  // polygonOffset 讓面稍微後退，確保特徵邊線 (Edges) 清晰顯示且無 Z-fighting 閃爍
  const material = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: '#cbd5e1',
      metalness: 0.2,
      roughness: 0.5,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
  }, []);

  useEffect(() => {
    return () => {
      material.dispose();
    };
  }, [material]);

  // 即時 3D Live Preview Mesh (Fillet / Chamfer)
  const previewGeometry = useMemo(() => {
    if (!filletChamferPreview?.mesh?.vertices || filletChamferPreview.mesh.vertices.length === 0) {
      return null;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(filletChamferPreview.mesh.vertices, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(filletChamferPreview.mesh.normals, 3));
    geom.setIndex(new THREE.BufferAttribute(filletChamferPreview.mesh.indices, 1));
    return geom;
  }, [filletChamferPreview?.mesh]);

  useEffect(() => {
    return () => {
      if (previewGeometry) previewGeometry.dispose();
    };
  }, [previewGeometry]);

  const previewMaterial = useMemo(() => {
    const isFillet = filletChamferPreview?.type === 'FILLET_3D';
    const isLinearPattern = filletChamferPreview?.type === 'LINEAR_PATTERN';
    const isSweep = filletChamferPreview?.type === 'SWEEP' || filletChamferPreview?.type === 'SWEEP_3D';
    const isLoft = filletChamferPreview?.type === 'LOFT';
    return new THREE.MeshStandardMaterial({
      color: isFillet ? '#34d399' : isLinearPattern ? '#38bdf8' : isSweep ? '#2dd4bf' : isLoft ? '#a78bfa' : '#818cf8',
      metalness: 0.2,
      roughness: 0.4,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
  }, [filletChamferPreview?.type]);

  useEffect(() => {
    return () => {
      previewMaterial.dispose();
    };
  }, [previewMaterial]);

  const previewEdgesGeometry = useMemo(() => {
    if (!previewGeometry) return null;
    return new THREE.EdgesGeometry(previewGeometry, 24);
  }, [previewGeometry]);

  useEffect(() => {
    return () => {
      if (previewEdgesGeometry) previewEdgesGeometry.dispose();
    };
  }, [previewEdgesGeometry]);

  useEffect(() => {
    if (filletChamferPreview?.mesh) {
      material.transparent = true;
      material.opacity = 0.25;
      material.depthWrite = false;
    } else {
      material.transparent = false;
      material.opacity = 1.0;
      material.depthWrite = true;
    }
    material.needsUpdate = true;
  }, [material, filletChamferPreview?.mesh]);

  // 提取實體模型的特徵幾何邊線 (閾值 24 度，過濾掉曲面內部三角化網格，只呈現真正的特徵線與分模邊界)
  const edgesGeometry = useMemo(() => {
    if (!geometry) return null;
    return new THREE.EdgesGeometry(geometry, 24);
  }, [geometry]);

  useEffect(() => {
    return () => {
      if (edgesGeometry) edgesGeometry.dispose();
    };
  }, [edgesGeometry]);

  const cumulativePartMesh = useCADStore((state) => state.cumulativePartMesh);
  const isRegenerating = useCADStore((state: any) => state.isRegenerating || false);

  useEffect(() => {
    setLoading(isRegenerating);
  }, [isRegenerating]);

  // 當 Store 中的 cumulativePartMesh 更新時，轉換為 Three.js BufferGeometry 供 Canvas 渲染
  useEffect(() => {
    if (canonicalSolidIds.length === 0 || !cumulativePartMesh || !cumulativePartMesh.vertices || cumulativePartMesh.vertices.length === 0) {
      setGeometry((prev) => {
        if (prev) prev.dispose();
        return null;
      });
      setEdgeVertices(null);
      setMapping(null);
      useCADStore.getState().setCumulativeSubshapeMapping(null);
      return;
    }

    setMapping(cumulativePartMesh.mapping || null);
    setEdgeVertices(cumulativePartMesh.edgeVertices || cumulativePartMesh.edges || null);
    useCADStore.getState().setCumulativeSubshapeMapping(cumulativePartMesh.mapping || null);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(cumulativePartMesh.vertices, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(cumulativePartMesh.normals, 3));
    geom.setIndex(new THREE.BufferAttribute(cumulativePartMesh.indices, 1));

    setGeometry((prev) => {
      if (prev) prev.dispose();
      return geom;
    });
  }, [cumulativePartMesh, canonicalSolidIds]);

  // 初次載入或當 Store 尚無累積網格但有實體特徵時，觸發 Store 重算
  useEffect(() => {
    if (!cumulativePartMesh && canonicalSolidIds.length > 0) {
      useCADStore.getState().regenerateFeatureTree();
    }
  }, [cumulativePartMesh, canonicalSolidIds.length]);

  // 卸載時清理 Geometry 記憶體
  useEffect(() => {
    return () => {
      setGeometry((prev) => {
        if (prev) prev.dispose();
        return null;
      });
    };
  }, []);

  return (
    <group>
      {loading && (
        <mesh>
          <boxGeometry args={[10, 10, 10]} />
          <meshBasicMaterial color="#38bdf8" wireframe />
        </mesh>
      )}
      {/* 基礎實體幾何 */}
      {geometry && (
        <mesh
          geometry={geometry}
          material={material}
          castShadow
          receiveShadow
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.face && e.object) {
              const hitPoint = e.point.clone();
              const worldNormal = e.face.normal
                .clone()
                .transformDirection(e.object.matrixWorld)
                .normalize();

              const triangleIndex = e.faceIndex;
              let faceRef: RuntimeBRepFaceRef | undefined = undefined;
              if (typeof triangleIndex === 'number' && mapping) {
                const resolved = resolveTriangleToFace(mapping, triangleIndex);
                if (resolved.status === 'exact' && resolved.faceRef) {
                  faceRef = resolved.faceRef;
                }
              }

              // 檢查是否處於 Datum Plane 3D 參考面選取模式 (activePicker === 'reference_plane')
              const datumPreview = useCADStore.getState().datumPlanePreview;
              if (datumPreview?.isOpen && datumPreview.activePicker === 'reference_plane') {
                if (faceRef) {
                  const resolvedRef = resolveBRepFaceToReference(faceRef, hitPoint);
                  if (!resolvedRef.isValid || !resolvedRef.reference) {
                    alert(resolvedRef.error || '選取的表面非平面，無法作為基準面參考');
                    return;
                  }
                  window.dispatchEvent(
                    new CustomEvent('cad-set-datum-reference-face', {
                      detail: {
                        plane: resolvedRef.reference.plane,
                        faceRef,
                        name: `實體表面 #${faceRef.faceIndex}`,
                      },
                    })
                  );
                } else {
                  const plane = createPlaneFromFaceNormal(hitPoint, worldNormal, '實體表面');
                  window.dispatchEvent(
                    new CustomEvent('cad-set-datum-reference-face', {
                      detail: {
                        plane,
                        name: '實體表面',
                      },
                    })
                  );
                }
                useCADStore.getState().setDatumPickerTarget(null);
                return;
              }

              onFaceSelect({
                point: hitPoint,
                normal: worldNormal,
                triangleIndex,
                faceRef,
              });
            }
          }}
        />
      )}

      {/* Fillet / Chamfer / Linear Pattern / Sweep 即時 3D Live Preview Mesh (獨立於基礎幾何，無本體時亦可正常顯示) */}
      {previewGeometry && (
        <group name="fillet-chamfer-preview">
          <mesh
            geometry={previewGeometry}
            material={previewMaterial}
          />
          {previewEdgesGeometry && (
            <lineSegments geometry={previewEdgesGeometry}>
              <lineBasicMaterial
                color={
                  filletChamferPreview?.type === 'FILLET_3D'
                    ? '#059669'
                    : filletChamferPreview?.type === 'LINEAR_PATTERN'
                    ? '#0284c7'
                    : filletChamferPreview?.type === 'SWEEP' || filletChamferPreview?.type === 'SWEEP_3D'
                    ? '#0d9488'
                    : '#4f46e5'
                }
                linewidth={2}
                depthTest={true}
              />
            </lineSegments>
          )}
        </group>
      )}

      {/* 交互式 B-Rep 邊線渲染 (支援獨立選取、懸停提示與高亮) */}
      {geometry && (
        <>
          {show3DEdges && mapping?.edges && mapping.edges.length > 0 ? (
            mapping.edges.map((edgeRef) => (
              <InteractiveBRepEdge
                key={`edge-${edgeRef.edgeIndex}`}
                edgeRef={edgeRef}
                mapping={mapping}
                edgeVertices={edgeVertices}
                isSelected={selectedEdgeList.some((e) => e.edgeRef.edgeIndex === edgeRef.edgeIndex)}
                isHovered={hoveredEdgeIndex === edgeRef.edgeIndex}
                onHover={setHoveredEdgeIndex}
                onSelect={(edge, isShift) => {
                  if (onEdgeSelect) {
                    onEdgeSelect(edge, isShift);
                  }
                }}
              />
            ))
          ) : (
            show3DEdges && edgesGeometry && (
              <lineSegments geometry={edgesGeometry}>
                <lineBasicMaterial
                  color="#0f172a"
                  linewidth={1.5}
                  depthTest={true}
                />
              </lineSegments>
            )
          )}
        </>
      )}
    </group>
  );
};

interface FaceHighlightAndOverlayProps {
  selectedFace: SelectedFaceState;
  setSelectedFace: (face: SelectedFaceState | null) => void;
}

/**
 * 表面選取視覺高亮與懸浮卡片按鈕
 */
const FaceHighlightAndOverlay: React.FC<FaceHighlightAndOverlayProps> = ({
  selectedFace,
  setSelectedFace,
}) => {
  // 使用四元數將 (0,0,1) 對齊法向量 normal
  const quaternion = useMemo(() => {
    return new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      selectedFace.normal
    );
  }, [selectedFace.normal]);

  // 沿法向量微幅偏移 0.05mm 避免 Z-Fighting
  const offsetPosition = useMemo(() => {
    return selectedFace.point.clone().addScaledVector(selectedFace.normal, 0.05);
  }, [selectedFace.point, selectedFace.normal]);

  // 微型法向箭頭指示
  const arrowHelper = useMemo(() => {
    return new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, 0),
      12,
      0xfacc15,
      3,
      2
    );
  }, []);

  useEffect(() => {
    return () => {
      arrowHelper.dispose();
    };
  }, [arrowHelper]);

  const handleCreateSketch = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.nativeEvent?.stopImmediatePropagation?.();
    const newPlane = createPlaneFromFaceNormal(
      { x: selectedFace.point.x, y: selectedFace.point.y, z: selectedFace.point.z },
      { x: selectedFace.normal.x, y: selectedFace.normal.y, z: selectedFace.normal.z }
    );

    let parentFeatId = (selectedFace.faceRef?.topoRef as any)?.featureId;
    const currentTree = useCADStore.getState().document.featureTree;
    const isValidFeature = parentFeatId && currentTree.some((f) => f.id === parentFeatId);

    if (!isValidFeature) {
      const lastSolidFeature = [...currentTree]
        .reverse()
        .find(
          (f) =>
            f.type === 'EXTRUDE' ||
            f.type === 'REVOLVE' ||
            f.type === 'LOFT' ||
            f.type === 'SWEEP' ||
            f.type === 'CUT_EXTRUDE' ||
            f.type === 'REVOLVE_CUT'
        );
      parentFeatId = lastSolidFeature ? lastSolidFeature.id : undefined;
    }

    console.log('[AttachedFace Debug] Bound Sketch to Parent Feature ID:', parentFeatId);

    const attachedFaceRef = selectedFace.faceRef
      ? {
          parentFeatureId: parentFeatId!,
          faceIndex: selectedFace.faceRef.faceIndex,
          persistentId: (selectedFace.faceRef.topoRef as any)?.persistentId || selectedFace.faceRef.runtimeId,
          faceNormal: { x: selectedFace.normal.x, y: selectedFace.normal.y, z: selectedFace.normal.z },
          faceCenter: { x: selectedFace.point.x, y: selectedFace.point.y, z: selectedFace.point.z },
        }
      : undefined;
    useCADStore.getState().createSketchOnFacePlane(newPlane, attachedFaceRef);
    setSelectedFace(null);
    useCADStore.getState().setSelectedFaceInfo(null);
  };

  const handleDismiss = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.nativeEvent?.stopImmediatePropagation?.();
    setSelectedFace(null);
    useCADStore.getState().setSelectedFaceInfo(null);
  };

  return (
    <group position={offsetPosition} quaternion={quaternion}>
      {/* 微型半透明平面/圓盤 (半徑 10，顏色黃色 #facc15，透明度 0.6) 貼齊表面 */}
      <mesh>
        <circleGeometry args={[10, 32]} />
        <meshBasicMaterial
          color="#facc15"
          side={THREE.DoubleSide}
          transparent
          opacity={0.6}
          depthWrite={false}
        />
      </mesh>

      {/* 外圈高亮邊框 */}
      <mesh>
        <ringGeometry args={[9.7, 10.3, 32]} />
        <meshBasicMaterial
          color="#eab308"
          side={THREE.DoubleSide}
          transparent
          opacity={0.9}
          depthWrite={false}
        />
      </mesh>

      {/* 微型法向箭頭指示 */}
      <primitive object={arrowHelper} />

      {/* 懸浮按鈕 (HTML Overlay) */}
      <Html position={[0, 0, 0]} center zIndexRange={[100, 0]} style={{ pointerEvents: 'auto' }}>
        <div
          className="flex flex-row items-center gap-1.5 bg-slate-900/95 text-white px-2.5 py-1.5 rounded-lg shadow-2xl backdrop-blur border border-amber-400/80 pointer-events-auto select-none mt-12 whitespace-nowrap"
          id="face-sketch-action-overlay"
          onPointerDown={(e) => {
            e.stopPropagation();
            e.nativeEvent?.stopImmediatePropagation?.();
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.nativeEvent?.stopImmediatePropagation?.();
          }}
          onPointerUp={(e) => {
            e.stopPropagation();
            e.nativeEvent?.stopImmediatePropagation?.();
          }}
          onMouseUp={(e) => {
            e.stopPropagation();
            e.nativeEvent?.stopImmediatePropagation?.();
          }}
          onClick={(e) => {
            e.stopPropagation();
            e.nativeEvent?.stopImmediatePropagation?.();
          }}
        >
          <button
            id="btn-create-sketch-on-selected-face"
            className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold px-2.5 py-1 rounded text-xs transition-colors shadow-sm cursor-pointer active:scale-95"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.nativeEvent?.stopImmediatePropagation?.();
            }}
            onClick={handleCreateSketch}
          >
            <Pencil size={13} className="stroke-[2.5]" />
            在此面建立草圖
          </button>
          <div className="w-px h-4 bg-slate-700 mx-0.5" />
          <button
            id="btn-dismiss-selected-face"
            className="hover:bg-slate-800 p-1 rounded transition-colors text-slate-400 hover:text-white cursor-pointer active:scale-95"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.nativeEvent?.stopImmediatePropagation?.();
            }}
            onClick={handleDismiss}
            title="取消選取"
          >
            <X size={14} />
          </button>
        </div>
      </Html>
    </group>
  );
};

const CanvasContent: React.FC = () => {
  const document = useCADStore((state) => state.document);
  const selectedFeatureId = useCADStore((state) => state.selectedFeatureId);
  const setSelectedFeatureId = useCADStore((state) => state.setSelectedFeatureId);

  const featureTree = document?.featureTree ?? [];
  const rollbackIndex = document?.rollbackIndex ?? 0;
  const planes = document?.planes ?? {};

  const { scene, camera, gl } = useThree();
  const controlsRef = useRef<any>(null);
  const animFrameRef = useRef<number | null>(null);

  // 1. 狀態擴充：維護選取的表面狀態
  const [selectedFace, setSelectedFace] = useState<{
    point: THREE.Vector3;
    normal: THREE.Vector3;
  } | null>(null);

  const selectedFaceInfo = useCADStore((state) => state.selectedFaceInfo);
  useEffect(() => {
    if (!selectedFaceInfo) {
      setSelectedFace(null);
    }
  }, [selectedFaceInfo]);

  useEffect(() => {
    solidEngine.init().catch((err) => {
      console.error('Failed to initialize solid engine in CanvasContent:', err);
    });
  }, []);

  // 3D 全圖置中與最適縮放 (Zoom to Fit 3D)
  const zoomToFit3D = useCallback(
    (animate: boolean = true) => {
      const box = new THREE.Box3();
      let hasGeometry = false;

      scene.traverse((obj) => {
        // 排除無窮網格、輔助座標軸、光源、相機等非模型元素
        if (
          obj.type === 'AxesHelper' ||
          obj.type === 'GridHelper' ||
          (obj as any).isGrid ||
          (obj as any).isHelper ||
          (obj as any).isLight ||
          (obj as any).isCamera ||
          obj.name?.includes?.('grid') ||
          obj.name?.includes?.('Grid') ||
          obj.name?.includes?.('axes') ||
          obj.name?.includes?.('arrow')
        ) {
          return;
        }

        if (obj instanceof THREE.Mesh) {
          // 排除表面選取指示環
          if (obj.geometry?.type === 'CircleGeometry' || obj.geometry?.type === 'RingGeometry') {
            return;
          }

          if (obj.geometry && obj.geometry.attributes?.position) {
            if (!obj.geometry.boundingBox) {
              obj.geometry.computeBoundingBox();
            }
            if (obj.geometry.boundingBox) {
              const meshBox = obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld);
              const sz = new THREE.Vector3();
              meshBox.getSize(sz);
              // 排除過大輔助網格（如 2000mm 的背景平面）
              if (sz.x > 0.001 && sz.x < 10000 && sz.y < 10000 && sz.z < 10000) {
                box.union(meshBox);
                hasGeometry = true;
              }
            }
          }
        } else if (obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
          if (obj.geometry && obj.geometry.attributes?.position) {
            if (!obj.geometry.boundingBox) {
              obj.geometry.computeBoundingBox();
            }
            if (obj.geometry.boundingBox) {
              const lineBox = obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld);
              const sz = new THREE.Vector3();
              lineBox.getSize(sz);
              if (sz.x > 0.001 && sz.x < 10000 && sz.y < 10000 && sz.z < 10000) {
                box.union(lineBox);
                hasGeometry = true;
              }
            }
          }
        }
      });

      if (!hasGeometry || box.isEmpty()) {
        box.set(new THREE.Vector3(-60, -60, -60), new THREE.Vector3(60, 60, 60));
      }

      const center = new THREE.Vector3();
      box.getCenter(center);
      const size = new THREE.Vector3();
      box.getSize(size);

      const maxDim = Math.max(size.x, size.y, size.z, 25);
      const perspCam = camera as THREE.PerspectiveCamera;
      const fov = ((perspCam.fov || 45) * Math.PI) / 180;
      let cameraDistance = (maxDim / 2) / Math.tan(fov / 2);
      cameraDistance *= 1.65; // 預留適當邊距

      const currentTarget = controlsRef.current ? controlsRef.current.target : new THREE.Vector3();
      let dir = camera.position.clone().sub(currentTarget).normalize();
      if (dir.lengthSq() < 0.001 || isNaN(dir.x)) {
        dir = new THREE.Vector3(1, 1, 1).normalize();
      }

      const targetCameraPos = center.clone().addScaledVector(dir, cameraDistance);

      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }

      if (!animate) {
        camera.position.copy(targetCameraPos);
        if (controlsRef.current) {
          controlsRef.current.target.copy(center);
          controlsRef.current.update();
        }
        camera.updateProjectionMatrix();
        return;
      }

      // 平滑緩動相機移動 (Smooth Ease-out animation)
      const startCamPos = camera.position.clone();
      const startTarget = currentTarget.clone();
      const startTime = performance.now();
      const duration = 280;

      const step = (now: number) => {
        const elapsed = now - startTime;
        const p = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - p, 3);

        camera.position.lerpVectors(startCamPos, targetCameraPos, ease);
        if (controlsRef.current) {
          controlsRef.current.target.lerpVectors(startTarget, center, ease);
          controlsRef.current.update();
        }

        if (p < 1) {
          animFrameRef.current = requestAnimationFrame(step);
        } else {
          camera.position.copy(targetCameraPos);
          if (controlsRef.current) {
            controlsRef.current.target.copy(center);
            controlsRef.current.update();
          }
          camera.updateProjectionMatrix();
        }
      };

      animFrameRef.current = requestAnimationFrame(step);
    },
    [camera, scene]
  );

  // 滑鼠中鍵雙擊 (Middle Double Click) 監聽與 cad-zoom-to-fit 全域事件
  useEffect(() => {
    const dom = gl?.domElement;
    if (!dom || typeof dom.addEventListener !== 'function') return;

    let lastClickTime = 0;
    let lastClickX = 0;
    let lastClickY = 0;

    const handlePointerDown = (e: PointerEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        const now = performance.now();
        const dt = now - lastClickTime;
        const dist = Math.hypot(e.clientX - lastClickX, e.clientY - lastClickY);

        if (dt < 400 && dist < 30) {
          lastClickTime = 0;
          zoomToFit3D(true);
        } else {
          lastClickTime = now;
          lastClickX = e.clientX;
          lastClickY = e.clientY;
        }
      }
    };

    const handleAuxClick = (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    dom.addEventListener('pointerdown', handlePointerDown);
    dom.addEventListener('auxclick', handleAuxClick);

    const handleGlobalZoom = () => {
      zoomToFit3D(true);
    };
    window.addEventListener('cad-zoom-to-fit', handleGlobalZoom);

    return () => {
      if (dom && typeof dom.removeEventListener === 'function') {
        dom.removeEventListener('pointerdown', handlePointerDown);
        dom.removeEventListener('auxclick', handleAuxClick);
      }
      window.removeEventListener('cad-zoom-to-fit', handleGlobalZoom);
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [gl, zoomToFit3D]);

  // 常駐三大預設基準面 (Front, Top, Right)
  const defaultPlanes = useMemo(() => {
    return [
      planes['datum-front'] || DatumFrontPlane,
      planes['datum-top'] || DatumTopPlane,
      planes['datum-right'] || DatumRightPlane,
    ];
  }, [planes]);

  const renderDefaultPlanes = useMemo(() => {
    return defaultPlanes.map((plane) => (
      <DatumPlaneMesh
        key={plane.id}
        plane={plane}
        name={plane.name}
        visible={true}
        isSelected={selectedFeatureId === plane.id}
        onSelect={() => setSelectedFeatureId(plane.id)}
      />
    ));
  }, [defaultPlanes, selectedFeatureId, setSelectedFeatureId]);

  // 遍歷 document.featureTree 中所有類型為 'DATUM_PLANE' 且 !f.suppressed && f.visible 的特徵並渲染
  const renderDatumPlaneFeatures = useMemo(() => {
    const activeTreeSlice = featureTree.slice(0, Math.max(0, rollbackIndex));
    const defaultPlaneIds = new Set(['datum-front', 'datum-top', 'datum-right']);

    return activeTreeSlice.map((feature) => {
      if (!feature || feature.suppressed) return null;

      if (feature.type === 'DATUM_PLANE') {
        const datumFeature = feature as DatumPlaneFeature;
        if (datumFeature.visible === false) return null;
        if (defaultPlaneIds.has(datumFeature.id)) return null;

        return (
          <DatumPlaneMesh
            key={datumFeature.id}
            plane={datumFeature.plane}
            name={datumFeature.name}
            visible={datumFeature.visible}
            isSelected={selectedFeatureId === datumFeature.id}
            onSelect={() => setSelectedFeatureId(datumFeature.id)}
          />
        );
      }

      return null;
    });
  }, [featureTree, rollbackIndex, selectedFeatureId, setSelectedFeatureId]);

  return (
    <>
      <color attach="background" args={['#1e293b']} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[100, 200, 100]} intensity={1.2} castShadow />
      <directionalLight position={[-100, -100, -100]} intensity={0.4} />
      <Suspense fallback={null}>
        <Environment preset="city" />
      </Suspense>
      {gl?.domElement && (
        <OrbitControls ref={controlsRef} makeDefault minDistance={1} maxDistance={5000} domElement={gl.domElement} />
      )}
      
      {/* 基準面渲染 */}
      {renderDefaultPlanes}
      {renderDatumPlaneFeatures}

      {/* 3D 空間草圖輪廓渲染 */}
      <Sketch3DRenderer />

      {/* 3D 即時伸長長料 / 除料幾何與方向向量預覽 */}
      <ExtrudePreviewRenderer />

      {/* 3D 即時旋轉長料 / 除料幾何、旋轉軸心與軌跡預覽 */}
      <RevolvePreviewRenderer />

      {/* 3D 即時空間基準面偏移姿態預覽 */}
      <DatumPlanePreviewRenderer />

      {/* 實體網格渲染 */}
      <CumulativePartMesh
        onFaceSelect={(face) => {
          setSelectedFace(face);
          useCADStore.getState().setSelectedFaceInfo({
            point: { x: face.point.x, y: face.point.y, z: face.point.z },
            normal: { x: face.normal.x, y: face.normal.y, z: face.normal.z },
            triangleIndex: face.triangleIndex,
            faceRef: face.faceRef,
          });
        }}
        onEdgeSelect={(edge, isShift) => {
          setSelectedFace(null);
          useCADStore.getState().setSelectedEdgeInfo({
            edgeRef: edge.edgeRef,
            startPoint: edge.startPoint,
            endPoint: edge.endPoint,
            meshEdgeIndex: edge.meshEdgeIndex,
          }, isShift);

          // 檢查是否處於 Datum Plane 旋轉軸選取模式 (activePicker === 'rotation_axis')
          const datumPreview = useCADStore.getState().datumPlanePreview;
          if (datumPreview?.isOpen && datumPreview.activePicker === 'rotation_axis') {
            const resolved = resolveBRepEdgeToAxis(edge.edgeRef);
            if (resolved.isValid && resolved.reference) {
              window.dispatchEvent(
                new CustomEvent('cad-set-datum-rotation-axis', {
                  detail: {
                    axisOrigin: resolved.reference.axisOrigin,
                    axisDirection: resolved.reference.axisDirection,
                    edgeRef: edge.edgeRef,
                    name: `實體邊線 #${edge.edgeRef.edgeIndex}`,
                  },
                })
              );
              useCADStore.getState().setDatumPickerTarget(null);
            }
          }
        }}
      />

      {/* 選取表面高亮與懸浮按鈕 */}
      {selectedFace && (
        <FaceHighlightAndOverlay
          selectedFace={selectedFace}
          setSelectedFace={setSelectedFace}
        />
      )}

      <Grid
        position={[0, -0.01, 0]}
        args={[2000, 2000]}
        cellSize={10}
        cellThickness={0.6}
        cellColor="#334155"
        sectionSize={50}
        sectionThickness={1.2}
        sectionColor="#475569"
        fadeDistance={800}
        fadeStrength={1}
        infiniteGrid
      />
      <axesHelper args={[100]} />
    </>
  );
};

const CAD3DCanvas: React.FC = () => {
  const selectedFaceInfo = useCADStore((state) => state.selectedFaceInfo);
  const setSelectedFaceInfo = useCADStore((state) => state.setSelectedFaceInfo);
  const selectedEdgeInfo = useCADStore((state) => state.selectedEdgeInfo);
  const selectedEdgeList = useCADStore((state) => state.selectedEdgeList);
  const setSelectedEdgeInfo = useCADStore((state) => state.setSelectedEdgeInfo);
  const createSketchOnFacePlane = useCADStore((state) => state.createSketchOnFacePlane);

  const handleCreateSketchFromBar = () => {
    if (!selectedFaceInfo) return;
    const newPlane = createPlaneFromFaceNormal(selectedFaceInfo.point, selectedFaceInfo.normal);

    let parentFeatId = (selectedFaceInfo.faceRef?.topoRef as any)?.featureId;
    const currentTree = useCADStore.getState().document.featureTree;
    const isValidFeature = parentFeatId && currentTree.some((f) => f.id === parentFeatId);

    if (!isValidFeature) {
      const lastSolidFeature = [...currentTree]
        .reverse()
        .find(
          (f) =>
            f.type === 'EXTRUDE' ||
            f.type === 'REVOLVE' ||
            f.type === 'LOFT' ||
            f.type === 'SWEEP' ||
            f.type === 'CUT_EXTRUDE' ||
            f.type === 'REVOLVE_CUT'
        );
      parentFeatId = lastSolidFeature ? lastSolidFeature.id : undefined;
    }

    console.log('[AttachedFace Debug] Bound Sketch to Parent Feature ID:', parentFeatId);

    const attachedFaceRef = selectedFaceInfo.faceRef
      ? {
          parentFeatureId: parentFeatId!,
          faceIndex: selectedFaceInfo.faceRef.faceIndex,
          persistentId: (selectedFaceInfo.faceRef.topoRef as any)?.persistentId || selectedFaceInfo.faceRef.runtimeId,
          faceNormal: selectedFaceInfo.normal,
          faceCenter: selectedFaceInfo.point,
        }
      : undefined;
    createSketchOnFacePlane(newPlane, attachedFaceRef);
    setSelectedFaceInfo(null);
  };

  return (
    <ThreeErrorBoundary>
      <div
        className="w-full h-full absolute inset-0 z-0 bg-slate-900 overflow-hidden select-none"
        id="cad-3d-canvas-container"
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        {/* 選取表面固定浮動提示列 (保證 100% 可點擊且不被 3D 物件遮擋) */}
        {selectedFaceInfo && (
          <div
            id="bar-selected-face-action"
            className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-slate-900/95 border border-amber-500/90 text-white px-4 py-2 rounded-xl shadow-2xl backdrop-blur flex items-center gap-3 select-none pointer-events-auto"
          >
            <div className="flex items-center gap-2 text-xs font-mono text-amber-300">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse inline-block" />
              <span className="font-semibold">
                {selectedFaceInfo.faceRef
                  ? `B-Rep Face #${selectedFaceInfo.faceRef.faceIndex} (${selectedFaceInfo.faceRef.surfaceType || 'plane'})`
                  : '已選取模型表面'}
              </span>
              <span className="text-slate-400 hidden md:inline">
                (法向量: [{selectedFaceInfo.normal.x.toFixed(2)}, {selectedFaceInfo.normal.y.toFixed(2)}, {selectedFaceInfo.normal.z.toFixed(2)}]
                {typeof selectedFaceInfo.triangleIndex === 'number' && ` | Tri #${selectedFaceInfo.triangleIndex}`})
              </span>
            </div>
            <button
              id="btn-bar-create-sketch"
              onClick={handleCreateSketchFromBar}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-lg transition-colors shadow cursor-pointer active:scale-95"
            >
              <Pencil size={13} className="stroke-[2.5]" />
              在此面建立草圖
            </button>
            <button
              id="btn-bar-dismiss-face"
              onClick={() => setSelectedFaceInfo(null)}
              className="p-1 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors cursor-pointer"
              title="取消選取"
            >
              <X size={15} />
            </button>
          </div>
        )}

        {/* 選取邊線固定浮動提示列 (保證 100% 可點擊且清晰呈現 Edge 拓撲資訊，支援多選模式) */}
        {selectedEdgeList.length > 0 && (
          <div
            id="bar-selected-edge-action"
            className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-slate-900/95 border border-amber-400/90 text-white px-4 py-2 rounded-xl shadow-2xl backdrop-blur flex items-center gap-3 select-none pointer-events-auto"
          >
            <div className="flex items-center gap-2 text-xs font-mono text-amber-300">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse inline-block" />
              {selectedEdgeList.length === 1 ? (
                <>
                  <span className="font-semibold">
                    B-Rep Edge #{selectedEdgeList[0].edgeRef.edgeIndex} ({selectedEdgeList[0].edgeRef.curveType === 'circle' ? `Arc/Circle${selectedEdgeList[0].edgeRef.radius ? ` R=${selectedEdgeList[0].edgeRef.radius.toFixed(1)}mm` : ''}` : 'Line'})
                  </span>
                  <span className="text-slate-400 hidden md:inline">
                    長度: {selectedEdgeList[0].edgeRef.length ? `${selectedEdgeList[0].edgeRef.length.toFixed(2)} mm` : '—'}
                  </span>
                  <span className="text-slate-400 text-[10px] ml-1 bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">
                    Shift+Click 多選
                  </span>
                </>
              ) : (
                <>
                  <span className="font-semibold">
                    已選取 {selectedEdgeList.length} 條邊線 (
                    {selectedEdgeList.map((e) => `#${e.edgeRef.edgeIndex}`).join(', ')}
                    )
                  </span>
                  <span className="text-slate-400 text-[10px] ml-1 bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">
                    Shift+Click 切換/多選
                  </span>
                </>
              )}
            </div>
            <button
              id="btn-bar-dismiss-edge"
              onClick={() => useCADStore.getState().clearSelectedEdges()}
              className="p-1 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors cursor-pointer"
              title="清除所有邊線選取"
            >
              <X size={15} />
            </button>
          </div>
        )}

        <Canvas
          gl={{ logarithmicDepthBuffer: true, antialias: true }}
          camera={{
            position: [150, 150, 150],
            fov: 45,
            near: 0.1,
            far: 50000,
          }}
          id="cad-3d-fiber-canvas"
        >
          <Suspense fallback={null}>
            <CanvasContent />
          </Suspense>
        </Canvas>
      </div>
    </ThreeErrorBoundary>
  );
};

export default CAD3DCanvas;
