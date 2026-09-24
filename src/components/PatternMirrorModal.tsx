import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useCADStore } from '../store/cadStore';
import { useDraggableModal } from '../hooks/useDraggableModal';
import { solidEngine } from '../core/3d/SolidEngine';
import { FeatureEvalOp } from '../core/3d/SolidEngine.types';
import {
  LinearPatternFeature,
  CircularPatternFeature,
  Mirror3DFeature,
  DatumPlaneFeature,
  DatumFrontPlane,
  DatumTopPlane,
  DatumRightPlane,
  CustomPlane,
  Point3D,
} from '../types/cad';
import type { TopoReference } from '../core/3d/PersistentTopology.types';
import { resolveBRepEdgeToAxis } from '../core/3d/UnifiedReferenceResolver';
import {
  LayoutGrid,
  Orbit,
  FlipHorizontal,
  X,
  Check,
  Layers,
  ArrowRight,
  RotateCw,
  RotateCcw,
  Info,
  Maximize2,
  Box,
  ArrowLeftRight,
  MousePointerClick,
} from 'lucide-react';

export interface PatternMirrorModalProps {
  isOpen: boolean;
  mode: 'LINEAR_PATTERN' | 'CIRCULAR_PATTERN' | 'MIRROR_3D';
  featureId?: string;
  onClose: () => void;
}

export const PatternMirrorModal: React.FC<PatternMirrorModalProps> = ({
  isOpen,
  mode,
  featureId,
  onClose,
}) => {
  const {
    document,
    addFeature,
    updateFeature,
    setViewMode,
    setFilletChamferPreview,
    selectedEdgeInfo,
    setSelectedEdgeInfo,
  } = useCADStore();

  const selectedFaceInfo = useCADStore((state) => state.selectedFaceInfo);
  const setSelectedFaceInfo = useCADStore((state) => state.setSelectedFaceInfo);

  // 過濾可作為陣列/鏡射目標的 3D 特徵
  const targetableFeatures = (document?.featureTree || []).filter(
    (f) =>
      f.type === 'EXTRUDE' ||
      f.type === 'CUT_EXTRUDE' ||
      f.type === 'REVOLVE' ||
      f.type === 'REVOLVE_CUT' ||
      f.type === 'FILLET_3D' ||
      f.type === 'CHAMFER_3D'
  );

  // 基準面清單：收集內建與自訂基準面 (包含 document.featureTree 中的 DATUM_PLANE 與 document.planes)
  const availablePlanes = useMemo(() => {
    const list: { id: string; name: string; plane?: CustomPlane }[] = [
      { id: 'datum-front', name: 'Front Plane (XY)', plane: DatumFrontPlane },
      { id: 'datum-top', name: 'Top Plane (XZ)', plane: DatumTopPlane },
      { id: 'datum-right', name: 'Right Plane (YZ)', plane: DatumRightPlane },
    ];
    const seen = new Set(['datum-front', 'datum-top', 'datum-right']);

    // 1. 從 featureTree
    for (const f of document?.featureTree || []) {
      if (f.type === 'DATUM_PLANE' && !seen.has(f.id)) {
        const dp = f as DatumPlaneFeature;
        list.push({ id: dp.id, name: `${dp.name || '自訂基準面'} (自訂基準面)`, plane: dp.plane });
        seen.add(dp.id);
      }
    }

    // 2. 從 document.planes
    if (document?.planes) {
      for (const [id, plane] of Object.entries(document.planes)) {
        if (!seen.has(id) && plane) {
          list.push({ id, name: `${plane.name || '自訂基準面'} (自訂基準面)`, plane });
          seen.add(id);
        }
      }
    }

    return list;
  }, [document?.featureTree, document?.planes]);

  // 共用狀態
  const [featureName, setFeatureName] = useState('');
  const [selectedTargetFeatureIds, setSelectedTargetFeatureIds] = useState<string[]>([]);
  const { position, resetPosition, dragHandleProps } = useDraggableModal({ defaultX: 280, defaultY: 70 });

  // 線性陣列 (LINEAR_PATTERN) 狀態
  const [dir1, setDir1] = useState<[number, number, number]>([1, 0, 0]);
  const [spacing1, setSpacing1] = useState<number>(30);
  const [count1, setCount1] = useState<number>(3);

  const [enableDir2, setEnableDir2] = useState<boolean>(false);
  const [dir2, setDir2] = useState<[number, number, number]>([0, 1, 0]);
  const [spacing2, setSpacing2] = useState<number>(30);
  const [count2, setCount2] = useState<number>(2);

  // 環狀陣列 (CIRCULAR_PATTERN) 狀態
  const [axisType, setAxisType] = useState<'X' | 'Y' | 'Z' | 'CUSTOM_EDGE'>('Z');
  const [selectedEdgeLabel, setSelectedEdgeLabel] = useState<string | null>(null);
  const [axisDir, setAxisDir] = useState<[number, number, number]>([0, 0, 1]);
  const [axisOrigin, setAxisOrigin] = useState<[number, number, number]>([0, 0, 0]);
  const [axisEdgeRef, setAxisEdgeRef] = useState<TopoReference | undefined>(undefined);
  const [circCount, setCircCount] = useState<number>(4);
  const [angleDeg, setAngleDeg] = useState<number>(360);
  const [equalSpacing, setEqualSpacing] = useState<boolean>(true);
  const [isSymmetric, setIsSymmetric] = useState<boolean>(false);

  // 3D 鏡射 (MIRROR_3D) 狀態
  const [mirrorPlaneSource, setMirrorPlaneSource] = useState<'DATUM_PLANE' | 'PLANAR_FACE'>('DATUM_PLANE');
  const [mirrorPlaneId, setMirrorPlaneId] = useState<string>('datum-front');
  const [customFacePlane, setCustomFacePlane] = useState<{
    origin: Point3D;
    normal: Point3D;
    faceLabel: string;
    faceRef?: any;
  } | null>(null);

  // 單次 Hydration 防護機制 Ref
  const prevOpenRef = useRef<{ isOpen: boolean; featureId?: string; mode?: string }>({
    isOpen: false,
    featureId: undefined,
    mode: undefined,
  });

  // 初始化與資料回填（Hydration）
  useEffect(() => {
    const isJustOpened =
      isOpen &&
      (!prevOpenRef.current.isOpen ||
        prevOpenRef.current.featureId !== featureId ||
        prevOpenRef.current.mode !== mode);

    prevOpenRef.current = { isOpen, featureId, mode };

    if (!isJustOpened || !isOpen) return;

    resetPosition();

    const tree = document?.featureTree || [];

    // 編輯模式：回填舊特徵資料
    if (featureId) {
      const existing = tree.find((f) => f.id === featureId);
      if (existing) {
        setFeatureName(existing.name || '');

        if (existing.type === 'LINEAR_PATTERN') {
          const lp = existing as LinearPatternFeature;
          setSelectedTargetFeatureIds(lp.targetFeatureIds || []);

          if (lp.dir1) setDir1([lp.dir1.x, lp.dir1.y, lp.dir1.z]);
          setSpacing1(typeof lp.spacing1 === 'number' ? lp.spacing1 : 30);
          setCount1(typeof lp.count1 === 'number' ? lp.count1 : 3);

          if (lp.dir2) {
            setEnableDir2(true);
            setDir2([lp.dir2.x, lp.dir2.y, lp.dir2.z]);
            setSpacing2(typeof lp.spacing2 === 'number' ? lp.spacing2 : 30);
            setCount2(typeof lp.count2 === 'number' ? lp.count2 : 2);
          } else {
            setEnableDir2(false);
            setDir2([0, 1, 0]);
            setSpacing2(30);
            setCount2(2);
          }
          return;
        } else if (existing.type === 'CIRCULAR_PATTERN') {
          const cp = existing as CircularPatternFeature;
          setSelectedTargetFeatureIds(cp.targetFeatureIds || []);
          const dir: [number, number, number] = cp.axisDirection
            ? [cp.axisDirection.x, cp.axisDirection.y, cp.axisDirection.z]
            : [0, 0, 1];
          const orig: [number, number, number] = cp.axisOrigin
            ? [cp.axisOrigin.x, cp.axisOrigin.y, cp.axisOrigin.z]
            : [0, 0, 0];

          setAxisDir(dir);
          setAxisOrigin(orig);
          setAxisEdgeRef(cp.axisEdgeRef);

          const isStandardX =
            dir[0] === 1 && dir[1] === 0 && dir[2] === 0 && orig[0] === 0 && orig[1] === 0 && orig[2] === 0;
          const isStandardY =
            dir[0] === 0 && dir[1] === 1 && dir[2] === 0 && orig[0] === 0 && orig[1] === 0 && orig[2] === 0;
          const isStandardZ =
            dir[0] === 0 && dir[1] === 0 && dir[2] === 1 && orig[0] === 0 && orig[1] === 0 && orig[2] === 0;

          if (isStandardX) {
            setAxisType('X');
            setAxisEdgeRef(undefined);
            setSelectedEdgeLabel(null);
          } else if (isStandardY) {
            setAxisType('Y');
            setAxisEdgeRef(undefined);
            setSelectedEdgeLabel(null);
          } else if (isStandardZ) {
            setAxisType('Z');
            setAxisEdgeRef(undefined);
            setSelectedEdgeLabel(null);
          } else {
            setAxisType('CUSTOM_EDGE');
            setSelectedEdgeLabel(cp.axisEdgeRef?.persistentId ? `拓撲邊線 (${cp.axisEdgeRef.persistentId.slice(-8)})` : '自訂實體軸線');
          }

          setCircCount(cp.count || 4);
          setAngleDeg(
            typeof cp.totalAngle === 'number'
              ? Math.round(((cp.totalAngle * 180) / Math.PI) * 100) / 100
              : 360
          );
          setEqualSpacing(cp.equalSpacing !== false);
          setIsSymmetric(Boolean(cp.isSymmetric));
          return;
        } else if (existing.type === 'MIRROR_3D') {
          const mp = existing as Mirror3DFeature;
          setSelectedTargetFeatureIds(mp.targetFeatureIds || []);
          if (mp.mirrorPlane?.faceLabel || (!mp.mirrorPlaneFeatureId && mp.mirrorPlane?.origin)) {
            setMirrorPlaneSource('PLANAR_FACE');
            setCustomFacePlane({
              origin: mp.mirrorPlane.origin,
              normal: mp.mirrorPlane.normal,
              faceLabel: mp.mirrorPlane.faceLabel || '平面 #1',
              faceRef: mp.mirrorPlane.faceRef,
            });
            setMirrorPlaneId('');
          } else {
            setMirrorPlaneSource('DATUM_PLANE');
            const planeId = mp.mirrorPlane?.planeId || mp.mirrorPlaneFeatureId || 'datum-front';
            setMirrorPlaneId(planeId);
            setCustomFacePlane(null);
          }
          return;
        }
      }
    }

    // 新建模式：給定預設值與預設名稱
    if (mode === 'LINEAR_PATTERN') {
      const count = tree.filter((f) => f.type === 'LINEAR_PATTERN').length + 1;
      setFeatureName(`LinearPattern${count}`);
    } else if (mode === 'CIRCULAR_PATTERN') {
      const count = tree.filter((f) => f.type === 'CIRCULAR_PATTERN').length + 1;
      setFeatureName(`CircularPattern${count}`);
    } else if (mode === 'MIRROR_3D') {
      const count = tree.filter((f) => f.type === 'MIRROR_3D').length + 1;
      setFeatureName(`Mirror3D${count}`);
      setMirrorPlaneSource('DATUM_PLANE');
      setMirrorPlaneId('datum-front');
      setCustomFacePlane(null);
    }

    if (targetableFeatures.length > 0) {
      setSelectedTargetFeatureIds([
        targetableFeatures[targetableFeatures.length - 1].id,
      ]);
    } else {
      setSelectedTargetFeatureIds([]);
    }

    setDir1([1, 0, 0]);
    setSpacing1(30);
    setCount1(3);

    setEnableDir2(false);
    setDir2([0, 1, 0]);
    setSpacing2(30);
    setCount2(2);

    setAxisType('Z');
    setSelectedEdgeLabel(null);
    setAxisDir([0, 0, 1]);
    setAxisOrigin([0, 0, 0]);
    setCircCount(4);
    setAngleDeg(360);
    setEqualSpacing(true);
    setIsSymmetric(false);

    setMirrorPlaneSource('DATUM_PLANE');
    setMirrorPlaneId('datum-front');
    setCustomFacePlane(null);
  }, [isOpen, featureId, mode, document?.featureTree]);

  // 監聽 3D 視圖實體邊線選取 (當處於環狀陣列且軸向為 CUSTOM_EDGE 自訂邊線時)
  useEffect(() => {
    if (!isOpen || mode !== 'CIRCULAR_PATTERN' || axisType !== 'CUSTOM_EDGE') {
      return;
    }

    if (selectedEdgeInfo?.edgeRef) {
      const res = resolveBRepEdgeToAxis(selectedEdgeInfo.edgeRef);
      if (res.isValid && res.reference) {
        setAxisOrigin([
          res.reference.axisOrigin.x,
          res.reference.axisOrigin.y,
          res.reference.axisOrigin.z,
        ]);
        setAxisDir([
          res.reference.axisDirection.x,
          res.reference.axisDirection.y,
          res.reference.axisDirection.z,
        ]);
        setSelectedEdgeLabel(`邊線 #${selectedEdgeInfo.edgeRef.edgeIndex ?? 0}`);
        const edgeTopoRef = selectedEdgeInfo.edgeRef.topoRef || (selectedEdgeInfo.edgeRef as any);
        if (typeof window !== 'undefined') {
          (window as any).__LAST_SELECTED_EDGE_TOPO_REF__ = edgeTopoRef;
        }
        setAxisEdgeRef(edgeTopoRef);
      }
      setSelectedEdgeInfo(null);
    }
  }, [isOpen, mode, axisType, selectedEdgeInfo, setSelectedEdgeInfo]);

  // 監聽 3D 視圖實體表面選取 (當處於 3D 鏡射且選擇來源為模型表面時)
  useEffect(() => {
    if (!isOpen || mode !== 'MIRROR_3D' || mirrorPlaneSource !== 'PLANAR_FACE') {
      return;
    }

    if (selectedFaceInfo) {
      const origin: Point3D = {
        x: selectedFaceInfo.point.x,
        y: selectedFaceInfo.point.y,
        z: selectedFaceInfo.point.z,
      };
      const normal: Point3D = {
        x: selectedFaceInfo.normal.x,
        y: selectedFaceInfo.normal.y,
        z: selectedFaceInfo.normal.z,
      };
      const faceIdx =
        selectedFaceInfo.faceRef?.faceIndex !== undefined
          ? selectedFaceInfo.faceRef.faceIndex
          : selectedFaceInfo.triangleIndex !== undefined
          ? selectedFaceInfo.triangleIndex
          : 1;
      const label = `平面 #${faceIdx}`;

      setCustomFacePlane({
        origin,
        normal,
        faceLabel: label,
        faceRef: selectedFaceInfo.faceRef,
      });
      setSelectedFaceInfo(null);
    }
  }, [isOpen, mode, mirrorPlaneSource, selectedFaceInfo, setSelectedFaceInfo]);

  // 卸載時清理預覽狀態
  useEffect(() => {
    return () => {
      setFilletChamferPreview(null);
    };
  }, [setFilletChamferPreview]);

  // 即時 3D Live Preview 計算 (Debounce 80ms，調用 SolidEngine 進行線性/環狀陣列與鏡射幾何預覽)
  useEffect(() => {
    if (
      !isOpen ||
      (mode !== 'LINEAR_PATTERN' && mode !== 'CIRCULAR_PATTERN' && mode !== 'MIRROR_3D') ||
      selectedTargetFeatureIds.length === 0
    ) {
      setFilletChamferPreview(null);
      return;
    }

    let isCancelled = false;

    const timer = setTimeout(async () => {
      try {
        let op: FeatureEvalOp;

        if (mode === 'LINEAR_PATTERN') {
          op = {
            featureId: 'preview-linear-pattern',
            type: 'LINEAR_PATTERN',
            operation: 'JOIN',
            profiles: [],
            plane: DatumFrontPlane,
            targetFeatureIds: selectedTargetFeatureIds,
            patternLinear: {
              dir1: { x: dir1[0], y: dir1[1], z: dir1[2] },
              count1: Math.max(1, Number(count1) || 1),
              spacing1: Number(spacing1) || 0,
              dir2: enableDir2 ? { x: dir2[0], y: dir2[1], z: dir2[2] } : undefined,
              count2: enableDir2 ? Math.max(1, Number(count2) || 1) : undefined,
              spacing2: enableDir2 ? Number(spacing2) || 0 : undefined,
            },
          };
        } else if (mode === 'CIRCULAR_PATTERN') {
          const totalAngleRad = (Number(angleDeg) * Math.PI) / 180;
          op = {
            featureId: 'preview-circular-pattern',
            type: 'CIRCULAR_PATTERN',
            operation: 'JOIN',
            profiles: [],
            plane: DatumFrontPlane,
            targetFeatureIds: selectedTargetFeatureIds,
            axisEdgeRef: axisType === 'CUSTOM_EDGE' ? axisEdgeRef : undefined,
            patternCircular: {
              axis: {
                origin: { x: axisOrigin[0], y: axisOrigin[1], z: axisOrigin[2] },
                direction: { x: axisDir[0], y: axisDir[1], z: axisDir[2] },
              },
              axisEdgeRef: axisType === 'CUSTOM_EDGE' ? axisEdgeRef : undefined,
              count: Math.max(1, Number(circCount) || 1),
              totalAngle: totalAngleRad,
              equalSpacing,
              isSymmetric,
            },
          };
        } else {
          let previewOrigin: Point3D = { x: 0, y: 0, z: 0 };
          let previewNormal: Point3D = { x: 0, y: 0, z: 1 };

          if (mirrorPlaneSource === 'PLANAR_FACE' && customFacePlane) {
            previewOrigin = customFacePlane.origin;
            previewNormal = customFacePlane.normal;
          } else {
            const foundItem = availablePlanes.find((p) => p.id === mirrorPlaneId);
            const foundPlane =
              foundItem?.plane ||
              (document?.planes && document.planes[mirrorPlaneId]) ||
              (document?.featureTree?.find((f) => f.id === mirrorPlaneId) as DatumPlaneFeature)?.plane ||
              (mirrorPlaneId === 'datum-front'
                ? DatumFrontPlane
                : mirrorPlaneId === 'datum-top'
                ? DatumTopPlane
                : mirrorPlaneId === 'datum-right'
                ? DatumRightPlane
                : DatumFrontPlane);
            if (foundPlane) {
              previewOrigin = foundPlane.origin;
              previewNormal = foundPlane.normal;
            }
          }

          op = {
            featureId: 'preview-mirror-3d',
            type: 'MIRROR_3D',
            operation: 'JOIN',
            profiles: [],
            plane: DatumFrontPlane,
            targetFeatureIds: selectedTargetFeatureIds,
            mirrorPlane: {
              origin: previewOrigin,
              normal: previewNormal,
            },
            mirror3D: {
              origin: previewOrigin,
              normal: previewNormal,
            },
          };
        }

        const meshResult = await solidEngine.previewOperation(op);
        if (!isCancelled) {
          setFilletChamferPreview({
            type: mode as any,
            mesh: meshResult,
          });
        }
      } catch (err: any) {
        if (!isCancelled) {
          setFilletChamferPreview({
            type: mode as any,
            mesh: null,
            error:
              err?.message ||
              (mode === 'LINEAR_PATTERN'
                ? '線性陣列預覽失敗'
                : mode === 'CIRCULAR_PATTERN'
                ? '環狀陣列預覽失敗'
                : '3D 鏡射預覽失敗'),
          });
        }
      }
    }, 80);

    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [
    isOpen,
    mode,
    selectedTargetFeatureIds,
    dir1,
    spacing1,
    count1,
    enableDir2,
    dir2,
    spacing2,
    count2,
    axisDir,
    axisOrigin,
    circCount,
    angleDeg,
    equalSpacing,
    isSymmetric,
    mirrorPlaneSource,
    mirrorPlaneId,
    customFacePlane,
    availablePlanes,
    document?.planes,
    document?.featureTree,
    setFilletChamferPreview,
  ]);

  const handleModalClose = () => {
    setFilletChamferPreview(null);
    onClose();
  };

  if (!isOpen) return null;

  // 切換目標特徵核取狀態
  const toggleTargetFeature = (id: string) => {
    setSelectedTargetFeatureIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  // 方向標籤輔助函式
  const getDirectionTag = (dir: [number, number, number]) => {
    if (dir[0] === 1 && dir[1] === 0 && dir[2] === 0) return '+X';
    if (dir[0] === -1 && dir[1] === 0 && dir[2] === 0) return '-X';
    if (dir[0] === 0 && dir[1] === 1 && dir[2] === 0) return '+Y';
    if (dir[0] === 0 && dir[1] === -1 && dir[2] === 0) return '-Y';
    if (dir[0] === 0 && dir[1] === 0 && dir[2] === 1) return '+Z';
    if (dir[0] === 0 && dir[1] === 0 && dir[2] === -1) return '-Z';
    return `[${dir[0]}, ${dir[1]}, ${dir[2]}]`;
  };

  // 確定建立/更新表單處置
  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedTargetFeatureIds.length === 0) return;

    if (mode === 'LINEAR_PATTERN') {
      const parsedDir1: Point3D = { x: dir1[0], y: dir1[1], z: dir1[2] };
      const parsedDir2: Point3D | undefined = enableDir2
        ? { x: dir2[0], y: dir2[1], z: dir2[2] }
        : undefined;

      const updates: Partial<LinearPatternFeature> = {
        name: featureName.trim() || 'LinearPattern1',
        targetFeatureIds: selectedTargetFeatureIds,
        dir1: parsedDir1,
        count1: Math.max(2, Number(count1) || 2),
        spacing1: Number(spacing1) || 30,
        dir2: parsedDir2,
        count2: enableDir2 ? Math.max(1, Number(count2) || 1) : undefined,
        spacing2: enableDir2 ? Number(spacing2) || 30 : undefined,
        dependencies: selectedTargetFeatureIds,
      };

      if (featureId) {
        updateFeature(featureId, updates);
      } else {
        const newFeature: LinearPatternFeature = {
          id: `linear-pattern-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          type: 'LINEAR_PATTERN',
          name: updates.name!,
          targetFeatureIds: updates.targetFeatureIds!,
          dir1: updates.dir1!,
          count1: updates.count1!,
          spacing1: updates.spacing1!,
          dir2: updates.dir2,
          count2: updates.count2,
          spacing2: updates.spacing2,
          dependencies: updates.dependencies!,
          suppressed: false,
          visible: true,
        };
        addFeature(newFeature);
      }
    } else if (mode === 'CIRCULAR_PATTERN') {
      const parsedAxisDir: Point3D = { x: axisDir[0], y: axisDir[1], z: axisDir[2] };
      const parsedAxisOrigin: Point3D = {
        x: axisOrigin[0],
        y: axisOrigin[1],
        z: axisOrigin[2],
      };
      const totalAngleRad = (Number(angleDeg) * Math.PI) / 180;

      const edgeRefToSave = (axisType === 'CUSTOM_EDGE' || axisEdgeRef !== undefined || (typeof window !== 'undefined' && (window as any).__LAST_SELECTED_EDGE_TOPO_REF__))
        ? (axisEdgeRef || (selectedEdgeInfo?.edgeRef as any)?.topoRef || (selectedEdgeInfo?.edgeRef as any) || (typeof window !== 'undefined' && (window as any).__LAST_SELECTED_EDGE_TOPO_REF__))
        : undefined;

      const updates: Partial<CircularPatternFeature> = {
        name: featureName.trim() || 'CircularPattern1',
        targetFeatureIds: selectedTargetFeatureIds,
        axisOrigin: parsedAxisOrigin,
        axisDirection: parsedAxisDir,
        axisEdgeRef: edgeRefToSave,
        count: Math.max(2, Number(circCount) || 2),
        totalAngle: totalAngleRad,
        equalSpacing,
        isSymmetric,
        dependencies: selectedTargetFeatureIds,
      };

      if (featureId) {
        updateFeature(featureId, updates);
      } else {
        const newFeature: CircularPatternFeature = {
          id: `circular-pattern-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          type: 'CIRCULAR_PATTERN',
          name: updates.name!,
          targetFeatureIds: updates.targetFeatureIds!,
          axisOrigin: updates.axisOrigin!,
          axisDirection: updates.axisDirection!,
          axisEdgeRef: edgeRefToSave,
          count: updates.count!,
          totalAngle: updates.totalAngle!,
          equalSpacing: updates.equalSpacing!,
          isSymmetric,
          dependencies: updates.dependencies!,
          suppressed: false,
          visible: true,
        };
        addFeature(newFeature);
      }
    } else if (mode === 'MIRROR_3D') {
      let resolvedOrigin: Point3D = { x: 0, y: 0, z: 0 };
      let resolvedNormal: Point3D = { x: 0, y: 0, z: 1 };
      let planeIdToStore: string | undefined = undefined;

      if (mirrorPlaneSource === 'PLANAR_FACE' && customFacePlane) {
        resolvedOrigin = customFacePlane.origin;
        resolvedNormal = customFacePlane.normal;
      } else {
        planeIdToStore = mirrorPlaneId || 'datum-front';
        const foundItem = availablePlanes.find((p) => p.id === planeIdToStore);
        const foundPlane =
          foundItem?.plane ||
          (document?.planes && document.planes[planeIdToStore]) ||
          (document?.featureTree?.find((f) => f.id === planeIdToStore) as DatumPlaneFeature)?.plane ||
          (planeIdToStore === 'datum-front'
            ? DatumFrontPlane
            : planeIdToStore === 'datum-top'
            ? DatumTopPlane
            : planeIdToStore === 'datum-right'
            ? DatumRightPlane
            : DatumFrontPlane);

        if (foundPlane) {
          resolvedOrigin = foundPlane.origin;
          resolvedNormal = foundPlane.normal;
        }
      }

      const deps = [...selectedTargetFeatureIds];
      if (
        planeIdToStore &&
        !['datum-front', 'datum-top', 'datum-right'].includes(planeIdToStore)
      ) {
        deps.push(planeIdToStore);
      }

      const updates: Partial<Mirror3DFeature> = {
        name: featureName.trim() || 'Mirror3D1',
        targetFeatureIds: selectedTargetFeatureIds,
        mirrorPlaneFeatureId: planeIdToStore,
        mirrorPlane: {
          planeId: planeIdToStore,
          origin: resolvedOrigin,
          normal: resolvedNormal,
          faceLabel: mirrorPlaneSource === 'PLANAR_FACE' ? customFacePlane?.faceLabel : undefined,
          faceRef: mirrorPlaneSource === 'PLANAR_FACE' ? customFacePlane?.faceRef : undefined,
        },
        dependencies: deps,
      };

      if (featureId) {
        updateFeature(featureId, updates);
      } else {
        const newFeature: Mirror3DFeature = {
          id: `mirror-3d-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          type: 'MIRROR_3D',
          name: updates.name!,
          targetFeatureIds: updates.targetFeatureIds!,
          mirrorPlaneFeatureId: updates.mirrorPlaneFeatureId,
          mirrorPlane: updates.mirrorPlane,
          dependencies: updates.dependencies!,
          suppressed: false,
          visible: true,
        };
        addFeature(newFeature);
      }
    }

    // 清除預覽、切換 viewMode 為 '3D' 並關閉彈窗
    setFilletChamferPreview(null);
    setViewMode('3D');
    onClose();
  };

  // UI 主題與模式判斷
  const isLinear = mode === 'LINEAR_PATTERN';
  const isCircular = mode === 'CIRCULAR_PATTERN';
  const isMirror = mode === 'MIRROR_3D';
  const isEditMode = Boolean(featureId);

  const titleText = isLinear
    ? `${isEditMode ? '編輯' : ''}線性陣列 (Linear Pattern)`
    : isCircular
    ? `${isEditMode ? '編輯' : ''}環狀陣列 (Circular Pattern)`
    : `${isEditMode ? '編輯' : ''}3D 鏡射 (3D Mirror)`;

  const subTitleText = isLinear
    ? '沿指定方向向量產生重複 3D 特徵矩陣'
    : isCircular
    ? '圍繞旋轉中心軸均勻或定角複製 3D 特徵'
    : '跨基準對稱鏡射實體特徵';

  const themeBorder = isLinear
    ? 'bg-blue-950/60 border-blue-800/40 text-blue-400'
    : isCircular
    ? 'bg-purple-950/60 border-purple-800/40 text-purple-400'
    : 'bg-emerald-950/60 border-emerald-800/40 text-emerald-400';

  const themeIconBox = isLinear
    ? 'bg-blue-600/20 text-blue-400 border-blue-500/40'
    : isCircular
    ? 'bg-purple-600/20 text-purple-400 border-purple-500/40'
    : 'bg-emerald-600/20 text-emerald-400 border-emerald-500/40';

  const themeBtnColor = isLinear
    ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/20'
    : isCircular
    ? 'bg-purple-600 hover:bg-purple-500 text-white shadow-purple-600/20'
    : 'bg-emerald-600 hover:bg-emerald-500 text-neutral-950 font-extrabold shadow-emerald-600/20';

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 pointer-events-none animate-in fade-in duration-150">
      <div
        id="pattern-mirror-propertymanager"
        style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)`, position: 'fixed', top: 0, left: 0 }}
        className="w-96 max-h-[calc(100vh-5rem)] bg-neutral-950/95 border border-neutral-800 rounded-xl shadow-2xl overflow-hidden flex flex-col text-neutral-200 select-none pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 對話框頂部 Header */}
        <div
          {...dragHandleProps}
          className={`h-12 px-4 border-b flex items-center justify-between shrink-0 font-sans cursor-move select-none ${themeBorder}`}
        >
          <div className="flex items-center gap-2.5">
            <div className={`p-1.5 rounded-lg border shadow-sm ${themeIconBox}`}>
              {isLinear && <LayoutGrid size={20} />}
              {isCircular && <Orbit size={20} />}
              {isMirror && <FlipHorizontal size={20} />}
            </div>
            <div>
              <h3 className="text-sm font-bold tracking-wide text-white flex items-center gap-2">
                {titleText}
              </h3>
              <p className="text-[11px] text-neutral-400">{subTitleText}</p>
            </div>
          </div>
          <button
            onClick={handleModalClose}
            className="p-1 text-neutral-400 hover:text-white hover:bg-neutral-800/80 rounded-lg transition-colors"
            title="關閉 (Esc)"
          >
            <X size={18} />
          </button>
        </div>

        {/* 表單內容主體 */}
        <form onSubmit={handleConfirm} noValidate className="p-5 space-y-4 font-sans text-xs overflow-y-auto custom-scrollbar">
          {/* 特徵名稱 */}
          <div className="space-y-1.5">
            <label className="block font-semibold text-neutral-300 flex items-center justify-between">
              <span>特徵名稱 (Feature Name)</span>
              <span className="text-[10px] font-mono text-neutral-500">ID: {featureId || 'Auto'}</span>
            </label>
            <input
              type="text"
              required
              value={featureName}
              onChange={(e) => setFeatureName(e.target.value)}
              className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-blue-500/80 transition-colors"
              placeholder={
                isLinear ? 'LinearPattern1' : isCircular ? 'CircularPattern1' : 'Mirror3D1'
              }
            />
          </div>

          {/* 目標實體特徵選取 */}
          <div className="space-y-1.5">
            <label className="block font-semibold text-neutral-300 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Box size={14} className="text-blue-400" />
                <span>目標實體特徵 (Target Features to Pattern/Mirror)</span>
              </span>
              <span className="text-[10px] font-mono text-neutral-400">
                已選取 {selectedTargetFeatureIds.length} 項
              </span>
            </label>

            {targetableFeatures.length === 0 ? (
              <div className="p-3 bg-amber-950/40 border border-amber-800/40 rounded-lg text-amber-300 text-[11px]">
                ⚠️ 目前特徵樹中尚未建立 Extrude 或 Revolve 實體特徵，請先建立基礎 3D 特徵。
              </div>
            ) : (
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-2 max-h-36 overflow-y-auto space-y-1 divide-y divide-neutral-850">
                {targetableFeatures.map((feat) => {
                  const isChecked = selectedTargetFeatureIds.includes(feat.id);
                  return (
                    <label
                      key={feat.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-neutral-800/60 cursor-pointer text-xs transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleTargetFeature(feat.id)}
                        className="w-4 h-4 rounded border-neutral-700 bg-neutral-950 text-blue-500 focus:ring-blue-500/40"
                      />
                      <span className="font-mono text-white flex-1">{feat.name}</span>
                      <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400">
                        {feat.type}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* 【1. 線性陣列專屬欄位】 */}
          {isLinear && (
            <div className="space-y-4 border-t border-neutral-850 pt-3">
              {/* 方向 1 */}
              <div className="p-3 bg-neutral-900/90 border border-neutral-800 rounded-lg space-y-3">
                <div className="flex items-center justify-between font-bold text-blue-300">
                  <span className="flex items-center gap-1.5">
                    <ArrowRight size={14} className="text-blue-400" />
                    方向 1 (Direction 1)
                  </span>
                </div>

                {/* 軸向選擇與反向 */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-neutral-400 font-semibold">
                      軸向向量與反向：
                    </span>
                    <span className="text-[11px] font-mono font-bold text-sky-400 bg-sky-950/80 border border-sky-800/60 px-2 py-0.5 rounded">
                      當前軸向: {getDirectionTag(dir1)}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    <button
                      type="button"
                      onClick={() => setDir1([dir1[0] < 0 ? -1 : 1, 0, 0])}
                      className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                        Math.abs(dir1[0]) === 1 && dir1[1] === 0 && dir1[2] === 0
                          ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                          : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                      }`}
                    >
                      {dir1[0] < 0 ? '-X 軸' : '+X 軸'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDir1([0, dir1[1] < 0 ? -1 : 1, 0])}
                      className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                        dir1[0] === 0 && Math.abs(dir1[1]) === 1 && dir1[2] === 0
                          ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                          : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                      }`}
                    >
                      {dir1[1] < 0 ? '-Y 軸' : '+Y 軸'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDir1([0, 0, dir1[2] < 0 ? -1 : 1])}
                      className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                        dir1[0] === 0 && dir1[1] === 0 && Math.abs(dir1[2]) === 1
                          ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                          : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                      }`}
                    >
                      {dir1[2] < 0 ? '-Z 軸' : '+Z 軸'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDir1([-dir1[0], -dir1[1], -dir1[2]])}
                      className="py-1.5 px-2 bg-neutral-900 hover:bg-neutral-800 text-amber-400 border border-neutral-700 hover:border-amber-500/50 rounded text-xs font-semibold transition-colors flex items-center justify-center gap-1 shrink-0"
                      title="反轉方向向量 (Flip +/- Direction)"
                    >
                      <ArrowLeftRight size={14} />
                      <span>反向</span>
                    </button>
                  </div>
                </div>

                {/* 間距 & 數量 */}
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="space-y-1">
                    <label className="text-neutral-300 block font-semibold">
                      間距 Spacing 1 (mm)
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={spacing1}
                      onChange={(e) => setSpacing1(Number(e.target.value))}
                      className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded text-white font-mono focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-neutral-300 block font-semibold">
                      實例數量 Count 1
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={count1}
                      onChange={(e) => setCount1(Number(e.target.value))}
                      className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded text-white font-mono focus:outline-none focus:border-blue-500 font-bold"
                    />
                  </div>
                </div>
              </div>

              {/* 方向 2（可勾選啟用） */}
              <div className="p-3 bg-neutral-900/90 border border-neutral-800 rounded-lg space-y-3">
                <label className="flex items-center gap-2 cursor-pointer font-bold text-neutral-200">
                  <input
                    type="checkbox"
                    checked={enableDir2}
                    onChange={(e) => setEnableDir2(e.target.checked)}
                    className="w-4 h-4 rounded border-neutral-700 bg-neutral-950 text-blue-500 focus:ring-blue-500/40"
                  />
                  <span>啟用方向 2 (Enable Direction 2)</span>
                </label>

                {enableDir2 && (
                  <div className="space-y-3 pt-1 border-t border-neutral-800">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-neutral-400 font-semibold">
                          軸向向量與反向：
                        </span>
                        <span className="text-[11px] font-mono font-bold text-sky-400 bg-sky-950/80 border border-sky-800/60 px-2 py-0.5 rounded">
                          當前軸向: {getDirectionTag(dir2)}
                        </span>
                      </div>
                      <div className="grid grid-cols-4 gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDir2([dir2[0] < 0 ? -1 : 1, 0, 0])}
                          className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                            Math.abs(dir2[0]) === 1 && dir2[1] === 0 && dir2[2] === 0
                              ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                              : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                          }`}
                        >
                          {dir2[0] < 0 ? '-X 軸' : '+X 軸'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDir2([0, dir2[1] < 0 ? -1 : 1, 0])}
                          className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                            dir2[0] === 0 && Math.abs(dir2[1]) === 1 && dir2[2] === 0
                              ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                              : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                          }`}
                        >
                          {dir2[1] < 0 ? '-Y 軸' : '+Y 軸'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDir2([0, 0, dir2[2] < 0 ? -1 : 1])}
                          className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                            dir2[0] === 0 && dir2[1] === 0 && Math.abs(dir2[2]) === 1
                              ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                              : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                          }`}
                        >
                          {dir2[2] < 0 ? '-Z 軸' : '+Z 軸'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDir2([-dir2[0], -dir2[1], -dir2[2]])}
                          className="py-1.5 px-2 bg-neutral-900 hover:bg-neutral-800 text-amber-400 border border-neutral-700 hover:border-amber-500/50 rounded text-xs font-semibold transition-colors flex items-center justify-center gap-1 shrink-0"
                          title="反轉方向向量 (Flip +/- Direction)"
                        >
                          <ArrowLeftRight size={14} />
                          <span>反向</span>
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-neutral-300 block font-semibold">
                          間距 Spacing 2 (mm)
                        </label>
                        <input
                          type="number"
                          step="any"
                          value={spacing2}
                          onChange={(e) => setSpacing2(Number(e.target.value))}
                          className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded text-white font-mono focus:outline-none focus:border-blue-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-neutral-300 block font-semibold">
                          實例數量 Count 2
                        </label>
                        <input
                          type="number"
                          step="any"
                          value={count2}
                          onChange={(e) => setCount2(Number(e.target.value))}
                          className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded text-white font-mono focus:outline-none focus:border-blue-500 font-bold"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 【2. 環狀陣列專屬欄位】 */}
          {isCircular && (
            <div className="space-y-3 border-t border-neutral-850 pt-3">
              {/* 旋轉中心軸方向與邊線選取 */}
              <div className="p-3 bg-neutral-900/90 border border-neutral-800 rounded-lg space-y-2.5">
                <div className="flex items-center justify-between">
                  <label className="text-purple-300 font-bold flex items-center gap-1.5">
                    <RotateCw size={14} className="text-purple-400" />
                    <span>旋轉中心軸 (Rotation Axis)</span>
                  </label>
                  {axisType === 'CUSTOM_EDGE' && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-950/80 text-purple-300 border border-purple-800/60 font-semibold">
                      自訂實體邊
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-4 gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setAxisType('X');
                      setAxisDir([1, 0, 0]);
                      setAxisOrigin([0, 0, 0]);
                      setAxisEdgeRef(undefined);
                      setSelectedEdgeLabel(null);
                    }}
                    className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                      axisType === 'X'
                        ? 'bg-purple-600/30 border-purple-500 text-purple-300'
                        : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                    }`}
                  >
                    X 軸
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAxisType('Y');
                      setAxisDir([0, 1, 0]);
                      setAxisOrigin([0, 0, 0]);
                      setAxisEdgeRef(undefined);
                      setSelectedEdgeLabel(null);
                    }}
                    className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                      axisType === 'Y'
                        ? 'bg-purple-600/30 border-purple-500 text-purple-300'
                        : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                    }`}
                  >
                    Y 軸
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAxisType('Z');
                      setAxisDir([0, 0, 1]);
                      setAxisOrigin([0, 0, 0]);
                      setAxisEdgeRef(undefined);
                      setSelectedEdgeLabel(null);
                    }}
                    className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                      axisType === 'Z'
                        ? 'bg-purple-600/30 border-purple-500 text-purple-300'
                        : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                    }`}
                  >
                    Z 軸
                  </button>
                  <button
                    id="btn-axis-custom-edge"
                    type="button"
                    onClick={() => {
                      setAxisType('CUSTOM_EDGE');
                      setViewMode('3D');
                    }}
                    className={`py-1.5 px-1 rounded text-xs font-bold border transition-colors flex items-center justify-center gap-1 ${
                      axisType === 'CUSTOM_EDGE'
                        ? 'bg-purple-600/30 border-purple-500 text-purple-300 shadow-sm'
                        : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                    }`}
                    title="點選 3D 視圖中的實體邊線作為旋轉軸"
                  >
                    <MousePointerClick size={13} className="shrink-0" />
                    <span>選取實體邊</span>
                  </button>
                </div>

                {/* 當切換為選取實體邊 (CUSTOM_EDGE) 時的狀態與提示 */}
                {axisType === 'CUSTOM_EDGE' && (
                  <div className="pt-2 border-t border-neutral-800 space-y-2">
                    {selectedEdgeLabel ? (
                      <div className="flex items-center justify-between p-2 rounded-lg bg-purple-950/40 border border-purple-800/50 text-xs">
                        <div className="flex items-center gap-2">
                          <Check size={14} className="text-emerald-400 shrink-0" />
                          <span className="text-neutral-300">已選取：</span>
                          <span className="font-mono font-bold text-purple-300 bg-purple-900/60 px-2 py-0.5 rounded border border-purple-700/50">
                            {selectedEdgeLabel}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setAxisType('Z');
                            setAxisDir([0, 0, 1]);
                            setAxisOrigin([0, 0, 0]);
                            setSelectedEdgeLabel(null);
                          }}
                          className="text-[11px] text-neutral-400 hover:text-rose-400 px-2 py-1 rounded bg-neutral-900 hover:bg-neutral-850 border border-neutral-800 transition-colors flex items-center gap-1"
                          title="清除選取並重設回預設 Z 軸"
                        >
                          <RotateCcw size={12} />
                          <span>清除選取</span>
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between p-2.5 rounded-lg bg-purple-950/30 border border-purple-800/60 text-purple-300 text-xs animate-pulse">
                        <div className="flex items-center gap-2">
                          <MousePointerClick size={15} className="text-purple-400 shrink-0" />
                          <span>請點選 3D 視圖中的直線邊線...</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setAxisType('Z');
                            setAxisDir([0, 0, 1]);
                            setAxisOrigin([0, 0, 0]);
                            setSelectedEdgeLabel(null);
                          }}
                          className="text-[11px] text-neutral-400 hover:text-white px-2 py-0.5 rounded bg-neutral-900 border border-neutral-800 transition-colors"
                        >
                          重設回 Z 軸
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 旋轉軸起點 */}
              <div className="p-3 bg-neutral-900/90 border border-neutral-800 rounded-lg space-y-2">
                <label className="text-neutral-300 font-semibold block">
                  旋轉軸起點 (Axis Origin)
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <span className="text-[10px] text-neutral-400 font-mono block">X:</span>
                    <input
                      type="number"
                      step="any"
                      value={axisOrigin[0]}
                      onChange={(e) => setAxisOrigin([Number(e.target.value), axisOrigin[1], axisOrigin[2]])}
                      className="w-full px-2 py-1 bg-neutral-950 border border-neutral-800 rounded text-white font-mono text-xs focus:outline-none focus:border-purple-500"
                    />
                  </div>
                  <div>
                    <span className="text-[10px] text-neutral-400 font-mono block">Y:</span>
                    <input
                      type="number"
                      step="any"
                      value={axisOrigin[1]}
                      onChange={(e) => setAxisOrigin([axisOrigin[0], Number(e.target.value), axisOrigin[2]])}
                      className="w-full px-2 py-1 bg-neutral-950 border border-neutral-800 rounded text-white font-mono text-xs focus:outline-none focus:border-purple-500"
                    />
                  </div>
                  <div>
                    <span className="text-[10px] text-neutral-400 font-mono block">Z:</span>
                    <input
                      type="number"
                      step="any"
                      value={axisOrigin[2]}
                      onChange={(e) => setAxisOrigin([axisOrigin[0], axisOrigin[1], Number(e.target.value)])}
                      className="w-full px-2 py-1 bg-neutral-950 border border-neutral-800 rounded text-white font-mono text-xs focus:outline-none focus:border-purple-500"
                    />
                  </div>
                </div>
              </div>

              {/* 數量 & 角度 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-neutral-300 block font-semibold">
                    實例總數 (Instances)
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={circCount}
                    onChange={(e) => setCircCount(Number(e.target.value))}
                    className="w-full px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded text-white font-mono font-bold focus:outline-none focus:border-purple-500"
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-neutral-300 font-semibold block text-xs">
                      總角度 (Angle °)
                    </label>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-semibold border ${
                        angleDeg < 0
                          ? 'bg-amber-950/80 text-amber-300 border-amber-800/60'
                          : 'bg-purple-950/80 text-purple-300 border-purple-800/60'
                      }`}
                    >
                      {angleDeg < 0 ? '順時針 (CW)' : '逆時針 (CCW)'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      step="any"
                      value={angleDeg}
                      onChange={(e) => setAngleDeg(Number(e.target.value))}
                      className="flex-1 min-w-0 px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded text-white font-mono focus:outline-none focus:border-purple-500"
                    />
                    <button
                      type="button"
                      onClick={() => setAngleDeg((prev) => (prev === 0 ? -360 : -prev))}
                      className="px-2.5 py-1.5 bg-neutral-950 hover:bg-neutral-800 text-purple-300 hover:text-purple-200 border border-neutral-800 hover:border-purple-500/50 rounded text-xs font-semibold transition-colors flex items-center gap-1 shrink-0"
                      title={angleDeg < 0 ? '切換為逆時針 (CCW)' : '切換為順時針 (CW)'}
                    >
                      {angleDeg < 0 ? <RotateCw size={14} /> : <RotateCcw size={14} />}
                      <span className="text-[11px] font-mono">{angleDeg < 0 ? 'CW' : 'CCW'}</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* 等間距排列 */}
              <label className="flex items-center gap-2.5 p-3 bg-neutral-900/90 border border-neutral-800 rounded-lg cursor-pointer hover:bg-neutral-850 transition-colors">
                <input
                  type="checkbox"
                  checked={equalSpacing}
                  onChange={(e) => setEqualSpacing(e.target.checked)}
                  className="w-4 h-4 rounded border-neutral-700 bg-neutral-950 text-purple-500 focus:ring-purple-500/40"
                />
                <div>
                  <span className="font-bold text-white block">等間距排列 (Equal Spacing)</span>
                  <span className="text-[11px] text-neutral-400 block">
                    自動依總角度將實體均勻分佈排列
                  </span>
                </div>
              </label>

              {/* 中心對稱分佈 */}
              <label className="flex items-center gap-2.5 p-3 bg-neutral-900/90 border border-neutral-800 rounded-lg cursor-pointer hover:bg-neutral-850 transition-colors">
                <input
                  type="checkbox"
                  id="circular-pattern-symmetric-checkbox"
                  checked={isSymmetric}
                  onChange={(e) => setIsSymmetric(e.target.checked)}
                  className="w-4 h-4 rounded border-neutral-700 bg-neutral-950 text-purple-500 focus:ring-purple-500/40"
                />
                <div>
                  <span className="font-bold text-white block">中心對稱分佈 (Symmetric / Centered)</span>
                  <span className="text-[11px] text-neutral-400 block">
                    以當前特徵為幾何中心，向左（順時針）與向右（逆時針）對稱展開陣列
                  </span>
                </div>
              </label>
            </div>
          )}

          {/* 【3. 3D 鏡射專屬欄位】 */}
          {isMirror && (
            <div className="space-y-3 border-t border-neutral-850 pt-3">
              <div className="space-y-1.5">
                <label className="block font-semibold text-neutral-300 flex items-center gap-1.5">
                  <FlipHorizontal size={14} className="text-emerald-400" />
                  <span>鏡射對稱面來源 (Mirror Plane Source)</span>
                </label>

                {/* 來源切換按鈕：基準面 vs 點選模型表面 */}
                <div className="grid grid-cols-2 gap-2 p-1 bg-neutral-900 rounded-lg border border-neutral-800">
                  <button
                    type="button"
                    onClick={() => setMirrorPlaneSource('DATUM_PLANE')}
                    className={`py-1.5 px-3 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                      mirrorPlaneSource === 'DATUM_PLANE'
                        ? 'bg-emerald-600 text-white shadow-md'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    <Layers size={13} />
                    <span>基準面 (Datum Plane)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMirrorPlaneSource('PLANAR_FACE')}
                    className={`py-1.5 px-3 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                      mirrorPlaneSource === 'PLANAR_FACE'
                        ? 'bg-emerald-600 text-white shadow-md'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    <MousePointerClick size={13} />
                    <span>點選模型表面 (Planar Face)</span>
                  </button>
                </div>
              </div>

              {mirrorPlaneSource === 'DATUM_PLANE' ? (
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-neutral-400">
                    選擇基準面
                  </label>
                  <select
                    value={mirrorPlaneId}
                    onChange={(e) => setMirrorPlaneId(e.target.value)}
                    className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-emerald-500 transition-colors text-xs"
                  >
                    {availablePlanes.map((plane) => (
                      <option key={plane.id} value={plane.id}>
                        {plane.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-neutral-400">
                    選定實體表面 (Selected Face)
                  </label>
                  <div
                    className={`p-3 rounded-lg border flex items-center justify-between transition-all ${
                      customFacePlane
                        ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300'
                        : 'bg-neutral-900/90 border-dashed border-emerald-500/40 text-neutral-400 animate-pulse'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <MousePointerClick size={16} className={customFacePlane ? 'text-emerald-400' : 'text-neutral-500'} />
                      <div className="text-xs">
                        {customFacePlane ? (
                          <>
                            <div className="font-bold text-white">
                              {customFacePlane.faceLabel || '平面 #1'}
                            </div>
                            <div className="text-[11px] text-emerald-400 font-mono">
                              法向 N: [{customFacePlane.normal.x.toFixed(2)}, {customFacePlane.normal.y.toFixed(2)}, {customFacePlane.normal.z.toFixed(2)}]
                            </div>
                          </>
                        ) : (
                          <div className="text-neutral-300">
                            👉 請在 3D 視圖點選實體的平面
                          </div>
                        )}
                      </div>
                    </div>
                    {customFacePlane && (
                      <button
                        type="button"
                        onClick={() => setCustomFacePlane(null)}
                        className="px-2 py-1 text-[11px] bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded border border-neutral-700"
                      >
                        重新選取
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 提示備註 */}
          <div className="p-2.5 bg-neutral-900/80 border border-neutral-800/80 rounded-lg flex items-start gap-2 text-[11px] text-neutral-400">
            <Info size={15} className="text-blue-400 shrink-0 mt-0.5" />
            <span>
              確認後系統將組合 3D 特徵陣列/鏡射，寫入 SolidWorks 特徵樹，切換至 3D 畫布呈現運算結果。
            </span>
          </div>

          {/* 底部按鈕列 */}
          <div className="pt-2 flex items-center justify-end gap-2 border-t border-neutral-800">
            <button
              type="button"
              onClick={handleModalClose}
              className="px-4 py-2 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded-lg border border-neutral-800 font-semibold transition-colors"
            >
              取消 (Cancel)
            </button>
            <button
              type="submit"
              disabled={
                selectedTargetFeatureIds.length === 0 ||
                (isMirror && mirrorPlaneSource === 'PLANAR_FACE' && !customFacePlane)
              }
              className={`px-5 py-2 rounded-lg font-bold flex items-center gap-1.5 shadow-lg transition-colors ${
                selectedTargetFeatureIds.length === 0 ||
                (isMirror && mirrorPlaneSource === 'PLANAR_FACE' && !customFacePlane)
                  ? 'bg-neutral-800 text-neutral-500 border border-neutral-700 cursor-not-allowed'
                  : themeBtnColor
              }`}
            >
              <Check size={16} />
              <span>{isEditMode ? '確定更新' : '確定建立'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PatternMirrorModal;
