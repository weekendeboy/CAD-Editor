import React, { useMemo, useState, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { ExtrudeFeature, SketchFeature } from '../types/cad';
import { solidEngine } from '../core/3d/SolidEngine';

interface SolidFeatureMeshProps {
  feature: ExtrudeFeature;
  sketch: SketchFeature;
}

const SolidFeatureMesh: React.FC<SolidFeatureMeshProps> = ({ feature, sketch }) => {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let currentGeom: THREE.BufferGeometry | null = null;

    const computeMeshes = async () => {
      setLoading(true);
      
      try {
        await solidEngine.init();
        
        const profilesToExtrude = feature.profileIds && feature.profileIds.length > 0
          ? sketch.profiles.filter(p => feature.profileIds.includes(p.id))
          : sketch.profiles;

        if (profilesToExtrude.length === 0) {
          if (active) {
            setGeometry(null);
            setLoading(false);
          }
          return;
        }

        const depth = feature.direction === 'mid-plane' ? feature.depth / 2 : feature.depth;
        const meshData = await solidEngine.extrudeProfiles(profilesToExtrude, depth);
        
        if (!active) return;
        
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(meshData.vertices, 3));
        geom.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
        geom.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
        
        if (feature.direction === 'mid-plane' || feature.direction === 'reversed') {
          geom.translate(0, 0, -depth);
        }

        currentGeom = geom;

        if (active) {
          setGeometry((prev) => {
            prev?.dispose();
            return geom;
          });
          setLoading(false);
        } else {
          geom.dispose();
        }
      } catch (error) {
        console.error("Failed to generate solid mesh", error);
        if (active) setLoading(false);
      }
    };

    computeMeshes();

    return () => {
      active = false;
      if (currentGeom) {
        currentGeom.dispose();
      }
    };
  }, [feature, sketch]);

  const matrix = useMemo(() => {
    const m = new THREE.Matrix4();
    const xAxis = new THREE.Vector3(
      sketch.plane.xAxis.x,
      sketch.plane.xAxis.y,
      sketch.plane.xAxis.z
    );
    const yAxis = new THREE.Vector3(
      sketch.plane.yAxis.x,
      sketch.plane.yAxis.y,
      sketch.plane.yAxis.z
    );
    const normal = new THREE.Vector3(
      sketch.plane.normal.x,
      sketch.plane.normal.y,
      sketch.plane.normal.z
    );
    const origin = new THREE.Vector3(
      sketch.plane.origin.x,
      sketch.plane.origin.y,
      sketch.plane.origin.z
    );

    m.makeBasis(xAxis, yAxis, normal);
    m.setPosition(origin);
    return m;
  }, [sketch.plane]);

  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      {loading ? (
        <mesh>
          <boxGeometry args={[10, 10, 10]} />
          <meshBasicMaterial color="#ef4444" wireframe />
        </mesh>
      ) : (
        geometry && (
          <mesh geometry={geometry}>
            <meshStandardMaterial 
              color="#cbd5e1" 
              metalness={0.2} 
              roughness={0.5} 
              side={THREE.DoubleSide} 
            />
          </mesh>
        )
      )}
    </group>
  );
};

const CAD3DCanvas: React.FC = () => {
  const document = useCADStore(state => state.document);

  useEffect(() => {
    solidEngine.init();
  }, []);

  const renderFeatures = useMemo(() => {
    const extrudeFeatures = document.featureTree.filter(
      (f): f is ExtrudeFeature => f.type === 'EXTRUDE' && !f.suppressed
    );

    return extrudeFeatures.map(extrude => {
      const sketch = document.featureTree.find(
        (f): f is SketchFeature => f.id === extrude.sketchId && f.type === 'SKETCH'
      );
      if (!sketch) return null;

      return <SolidFeatureMesh key={extrude.id} feature={extrude} sketch={sketch} />;
    });
  }, [document.featureTree]);

  return (
    <div className="w-full h-full absolute inset-0 z-0 bg-slate-900">
      <Canvas camera={{ position: [100, 100, 100], fov: 50 }}>
        <color attach="background" args={['#1e293b']} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 10, 10]} intensity={1} />
        <Environment preset="city" />
        <OrbitControls makeDefault />
        {renderFeatures}
        <gridHelper args={[1000, 100, '#475569', '#334155']} rotation={[Math.PI / 2, 0, 0]} />
        <axesHelper args={[100]} />
      </Canvas>
    </div>
  );
};

export default CAD3DCanvas;
