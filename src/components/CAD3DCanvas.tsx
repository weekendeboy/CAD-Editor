import React, { useMemo, useState, useEffect, useRef, Suspense, Component, ErrorInfo, ReactNode } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, Grid, Text } from '@react-three/drei';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import {
  CustomPlane,
  DatumFrontPlane,
  DatumTopPlane,
  DatumRightPlane,
  DatumPlaneFeature,
  ExtrudeFeature,
  SketchFeature,
} from '../types/cad';
import { solidEngine } from '../core/3d/SolidEngine';
import { buildFeatureEvalOps } from '../core/3d/FeaturePipelineAdapter';

// Error Boundary 元件，防止 3D Canvas 渲染或 WebGL 錯誤導致整個 React 畫面白屏消失
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
        <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900 text-slate-300 p-6">
          <div className="bg-slate-800 border border-red-500/50 rounded-lg p-6 max-w-md text-center shadow-xl">
            <h3 className="text-lg font-bold text-red-400 mb-2">3D 視圖載入異常</h3>
            <p className="text-sm text-slate-400 mb-4">
              {this.state.error?.message || '渲染 3D 實體模型時發生錯誤。'}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-semibold transition-colors"
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

  if (!visible) return null;

  return (
    <group
      ref={groupRef}
      onClick={(e) => {
        e.stopPropagation();
        if (onSelect) onSelect();
      }}
    >
      {/* 半透明平面 (尺寸 200x200 mm，天藍色 #0284c7，未選中透明度 0.08，選中時 0.2) */}
      <mesh>
        <planeGeometry args={[200, 200]} />
        <meshBasicMaterial
          color="#0284c7"
          side={THREE.DoubleSide}
          transparent
          opacity={isSelected ? 0.2 : 0.08}
          depthWrite={false}
        />
      </mesh>

      {/* 邊框線 (Border Wireframe)：選中時黃色 #facc15，未選中深藍色 #0369a1 */}
      <lineLoop geometry={borderGeometry}>
        <lineBasicMaterial
          color={isSelected ? '#facc15' : '#0369a1'}
          linewidth={2}
        />
      </lineLoop>

      {/* 局部坐標軸 Trihedron (X 紅, Y 綠, Z 藍) */}
      <primitive object={trihedronGroup} />

      {/* 文字標籤：左上角顯示基準面名稱 */}
      <Text
        position={[-95, 92, 0.5]}
        fontSize={9}
        color={isSelected ? '#fde047' : '#38bdf8'}
        anchorX="left"
        anchorY="top"
        outlineWidth={0.6}
        outlineColor="#0f172a"
      >
        {name}
      </Text>
    </group>
  );
};

/**
 * 單一累進實體模型渲染元件 CumulativePartMesh
 * 訂閱 document.featureTree 與 document.rollbackIndex
 * 當特徵樹或回退棒變更時，透過 OpenCASCADE 執行完整 CSG 布林運算（含 Boolean Cut 除料）
 */
const CumulativePartMesh: React.FC = () => {
  const document = useCADStore((state) => state.document);
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const featureTree = document?.featureTree ?? [];
  const rollbackIndex = document?.rollbackIndex ?? 0;
  const planes = document?.planes ?? {};

  // 金屬質感灰色 Standard 材質 (color="#cbd5e1", metalness=0.2, roughness=0.5)
  const material = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: '#cbd5e1',
      metalness: 0.2,
      roughness: 0.5,
      side: THREE.DoubleSide,
    });
  }, []);

  useEffect(() => {
    return () => {
      material.dispose();
    };
  }, [material]);

  // 當特徵樹、回退棒或基準面變更時重新計算實體網格
  useEffect(() => {
    let active = true;

    const evaluateTree = async () => {
      setLoading(true);

      try {
        await solidEngine.init();

        const ops = buildFeatureEvalOps(featureTree, rollbackIndex, planes);

        if (!ops || ops.length === 0) {
          if (active) {
            setGeometry((prev) => {
              if (prev) prev.dispose();
              return null;
            });
            setLoading(false);
          }
          return;
        }

        const meshData = await solidEngine.evaluateFeatureTree(ops);

        if (!active) return;

        if (!meshData || !meshData.vertices || meshData.vertices.length === 0) {
          setGeometry((prev) => {
            if (prev) prev.dispose();
            return null;
          });
          setLoading(false);
          return;
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(meshData.vertices, 3));
        geom.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
        geom.setIndex(new THREE.BufferAttribute(meshData.indices, 1));

        if (active) {
          setGeometry((prev) => {
            if (prev) prev.dispose();
            return geom;
          });
          setLoading(false);
        } else {
          geom.dispose();
        }
      } catch (error) {
        console.error('Failed to evaluate cumulative solid part mesh:', error);
        if (active) {
          setGeometry((prev) => {
            if (prev) prev.dispose();
            return null;
          });
          setLoading(false);
        }
      }
    };

    evaluateTree();

    return () => {
      active = false;
    };
  }, [featureTree, rollbackIndex, planes]);

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
      {geometry && (
        <mesh geometry={geometry} material={material} castShadow receiveShadow />
      )}
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

  useEffect(() => {
    solidEngine.init().catch((err) => {
      console.error('Failed to initialize solid engine in CanvasContent:', err);
    });
  }, []);

  // 1. 常駐三大預設基準面 (Front, Top, Right)
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

  // 2. 遍歷 document.featureTree 中所有類型為 'DATUM_PLANE' 且 !f.suppressed && f.visible 的特徵並渲染
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
      <OrbitControls makeDefault minDistance={1} maxDistance={5000} />
      {renderDefaultPlanes}
      {renderDatumPlaneFeatures}
      <CumulativePartMesh />
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
  return (
    <ThreeErrorBoundary>
      <div className="w-full h-full absolute inset-0 z-0 bg-slate-900">
        <Canvas
          gl={{ logarithmicDepthBuffer: true, antialias: true }}
          camera={{
            position: [150, 150, 150],
            fov: 45,
            near: 0.1,
            far: 50000,
          }}
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
