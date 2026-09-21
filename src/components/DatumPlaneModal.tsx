import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useCADStore } from '../store/cadStore';
import {
  CustomPlane,
  DatumPlaneFeature,
  Point3D,
  LineEntity,
  SketchFeature,
  DatumFrontPlane,
} from '../types/cad';
import type { RuntimeBRepFaceRef, RuntimeBRepEdgeRef, RuntimeBRepVertexRef } from '../core/3d/SolidEngine.types';
import {
  createOffsetPlane,
  createRotatedPlaneAroundAxis,
  createThreePointPlane,
  validateThreePoints,
  FRONT_PLANE,
  TOP_PLANE,
  RIGHT_PLANE,
  map2DTo3DWorld,
  sub3D,
  normalize3D,
} from '../core/3d/DatumPlaneEngine';
import {
  X,
  Layers,
  RotateCw,
  ArrowUpRight,
  SquareDashed,
  Check,
  Eye,
  Axis3d,
  MousePointerClick,
  Sparkles,
  Triangle,
  MapPin,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react';

export interface DatumPlaneModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DatumPlaneModal: React.FC<DatumPlaneModalProps> = ({ isOpen, onClose }) => {
  const { document, activeSketchId, setDatumPlanePreview, viewMode, setViewMode } = useCADStore();
  const activePicker = useCADStore((state) => state.datumPlanePreview?.activePicker);

  const [planeType, setPlaneType] = useState<'offset' | 'angle' | 'three-point'>('offset');
  const [featureName, setFeatureName] = useState<string>('');
  const [selectedRefPlaneId, setSelectedRefPlaneId] = useState<string>('datum-front');

  // 3D 視圖直接選取的參考實體表面
  const [customRefPlane, setCustomRefPlane] = useState<CustomPlane | null>(null);
  const [customRefPlaneName, setCustomRefPlaneName] = useState<string | null>(null);
  const [selectedFaceRef, setSelectedFaceRef] = useState<RuntimeBRepFaceRef | null>(null);

  // 偏移模式參數
  const [offsetDistance, setOffsetDistance] = useState<number>(30);
  const [flipOffset, setFlipOffset] = useState<boolean>(false);

  // 旋轉模式參數
  const [rotationAngleDeg, setRotationAngleDeg] = useState<number>(45);
  const [flipAngle, setFlipAngle] = useState<boolean>(false);
  const [axisSourceMode, setAxisSourceMode] = useState<'standard' | 'sketch_edge' | 'brep_edge'>('standard');
  const [standardAxis, setStandardAxis] = useState<'X' | 'Y' | 'Z'>('X');
  const [selectedLineEntityId, setSelectedLineEntityId] = useState<string>('');

  // 3D 實體邊線旋轉軸參數
  const [selectedEdgeRef, setSelectedEdgeRef] = useState<RuntimeBRepEdgeRef | null>(null);
  const [brepAxisOrigin, setBrepAxisOrigin] = useState<Point3D | null>(null);
  const [brepAxisDirection, setBrepAxisDirection] = useState<Point3D | null>(null);

  // 三點模式參數
  const [point1, setPoint1] = useState<Point3D | null>({ x: 0, y: 0, z: 0 });
  const [point2, setPoint2] = useState<Point3D | null>({ x: 100, y: 0, z: 0 });
  const [point3, setPoint3] = useState<Point3D | null>({ x: 0, y: 100, z: 0 });
  const [point1Ref, setPoint1Ref] = useState<RuntimeBRepVertexRef | null>(null);
  const [point2Ref, setPoint2Ref] = useState<RuntimeBRepVertexRef | null>(null);
  const [point3Ref, setPoint3Ref] = useState<RuntimeBRepVertexRef | null>(null);
  const [activePointIndex, setActivePointIndex] = useState<1 | 2 | 3>(1);

  // 當開啟時自動切換為 3D 視角以利即時預覽與 3D 點/軸選取
  useEffect(() => {
    if (isOpen && viewMode !== '3D') {
      setViewMode('3D');
    }
  }, [isOpen, viewMode, setViewMode]);

  // 當彈窗開啟時，初始化特徵名稱與預設參數
  useEffect(() => {
    if (isOpen) {
      const datumCount = document.featureTree.filter((f) => f.type === 'DATUM_PLANE').length;
      setFeatureName(`DatumPlane${datumCount + 1}`);
      setSelectedRefPlaneId('datum-front');
      setCustomRefPlane(null);
      setCustomRefPlaneName(null);
      setSelectedFaceRef(null);
      setSelectedEdgeRef(null);
      setBrepAxisOrigin(null);
      setBrepAxisDirection(null);
      setOffsetDistance(30);
      setFlipOffset(false);
      setRotationAngleDeg(45);
      setFlipAngle(false);
      setAxisSourceMode('standard');
      setStandardAxis('X');
      setSelectedLineEntityId('');
      setPoint1({ x: 0, y: 0, z: 0 });
      setPoint2({ x: 100, y: 0, z: 0 });
      setPoint3({ x: 0, y: 100, z: 0 });
      setPoint1Ref(null);
      setPoint2Ref(null);
      setPoint3Ref(null);
      setActivePointIndex(1);
    } else {
      useCADStore.getState().setDatumPickerTarget(null);
    }
  }, [isOpen, document.featureTree]);

  // 取得可用的基準面選項 (包含三大預設面與歷史 DatumPlane 特徵)
  const availableRefPlanes = useMemo(() => {
    const planes: { id: string; name: string; plane: CustomPlane }[] = [
      { id: FRONT_PLANE.id, name: FRONT_PLANE.name, plane: FRONT_PLANE },
      { id: TOP_PLANE.id, name: TOP_PLANE.name, plane: TOP_PLANE },
      { id: RIGHT_PLANE.id, name: RIGHT_PLANE.name, plane: RIGHT_PLANE },
    ];

    document.featureTree.forEach((f) => {
      if (f.type === 'DATUM_PLANE') {
        const dp = f as DatumPlaneFeature;
        if (dp.plane && !['datum-front', 'datum-top', 'datum-right'].includes(dp.id)) {
          planes.push({
            id: dp.id,
            name: dp.name,
            plane: dp.plane,
          });
        }
      }
    });

    return planes;
  }, [document.featureTree]);

  // 取得可用的草圖直線清單 (作為旋轉邊線參考)
  const availableLines = useMemo(() => {
    const lines: { id: string; name: string; line: LineEntity; sketch: SketchFeature }[] = [];
    document.featureTree.forEach((f) => {
      if (f.type === 'SKETCH') {
        const sketch = f as SketchFeature;
        sketch.entities.forEach((ent) => {
          if (ent.type === 'line') {
            lines.push({
              id: ent.id,
              name: `${sketch.name} - Line (${ent.id.substring(0, 6)})${ent.isConstruction ? '·建構線' : ''}`,
              line: ent as LineEntity,
              sketch,
            });
          }
        });
      }
    });
    return lines;
  }, [document.featureTree]);

  // 當切換至草圖直線邊界且未選擇直線時，自動選定第一條可用直線
  useEffect(() => {
    if (axisSourceMode === 'sketch_edge' && !selectedLineEntityId && availableLines.length > 0) {
      const constr = availableLines.find((l) => l.line.isConstruction);
      setSelectedLineEntityId(constr?.id || availableLines[0].id);
    }
  }, [axisSourceMode, selectedLineEntityId, availableLines]);

  // 解析當前所選的參照面 CustomPlane
  const resolveRefPlane = useCallback((): CustomPlane => {
    if (customRefPlane) {
      return customRefPlane;
    }
    const found = availableRefPlanes.find((p) => p.id === selectedRefPlaneId);
    if (found) return found.plane;
    if (document.planes && document.planes[selectedRefPlaneId]) {
      return document.planes[selectedRefPlaneId];
    }
    const feat = document.featureTree.find((f) => f.id === selectedRefPlaneId);
    if (feat && feat.type === 'DATUM_PLANE') {
      const dp = feat as DatumPlaneFeature;
      if (dp.plane) return dp.plane;
    }
    return FRONT_PLANE;
  }, [customRefPlane, availableRefPlanes, selectedRefPlaneId, document.planes, document.featureTree]);

  // 解析草圖所屬基準面
  const resolveSketchPlane = useCallback(
    (sketch: SketchFeature): CustomPlane => {
      if (sketch.planeFeatureId) {
        if (document.planes && document.planes[sketch.planeFeatureId]) {
          return document.planes[sketch.planeFeatureId];
        }
        const datum = document.featureTree.find(
          (f) => f.id === sketch.planeFeatureId
        ) as DatumPlaneFeature | undefined;
        if (datum?.plane) return datum.plane;
      }
      return sketch.plane || FRONT_PLANE;
    },
    [document.planes, document.featureTree]
  );

  // 監聽 3D 視圖中點選參考面/實體表面、旋轉軸 (邊線/草圖直線)、頂點事件
  useEffect(() => {
    const handleRefFace = (
      e: CustomEvent<{ plane: CustomPlane; faceRef?: RuntimeBRepFaceRef; name?: string }>
    ) => {
      if (e.detail?.plane) {
        setCustomRefPlane(e.detail.plane);
        setCustomRefPlaneName(e.detail.name || `實體表面 #${e.detail.faceRef?.faceIndex ?? ''}`);
        setSelectedFaceRef(e.detail.faceRef || null);
        setSelectedRefPlaneId('custom-face');
      }
    };

    const handleRefPlane = (
      e: CustomEvent<{ plane: CustomPlane; planeId?: string; name?: string }>
    ) => {
      if (e.detail?.plane) {
        setCustomRefPlane(null);
        setCustomRefPlaneName(null);
        setSelectedFaceRef(null);
        setSelectedRefPlaneId(e.detail.planeId || e.detail.plane.id);
      }
    };

    const handleAxisSelected = (e: CustomEvent<string>) => {
      if (e.detail) {
        setAxisSourceMode('sketch_edge');
        setSelectedLineEntityId(e.detail);
        setSelectedEdgeRef(null);
        setBrepAxisOrigin(null);
        setBrepAxisDirection(null);
      }
    };

    const handleAxisEdgeSelected = (
      e: CustomEvent<{ axisOrigin: Point3D; axisDirection: Point3D; edgeRef?: RuntimeBRepEdgeRef }>
    ) => {
      if (e.detail) {
        setAxisSourceMode('brep_edge');
        setSelectedEdgeRef(e.detail.edgeRef || null);
        setBrepAxisOrigin(e.detail.axisOrigin);
        setBrepAxisDirection(e.detail.axisDirection);
        setSelectedLineEntityId('');
      }
    };

    const handlePointSelected = (
      e: CustomEvent<{ point: Point3D; index?: 1 | 2 | 3; vertexRef?: RuntimeBRepVertexRef }>
    ) => {
      if (e.detail && e.detail.point) {
        const targetIdx = e.detail.index || activePointIndex;
        const newPt = { ...e.detail.point };
        const vRef = e.detail.vertexRef || null;
        if (targetIdx === 1) {
          setPoint1(newPt);
          setPoint1Ref(vRef);
          setActivePointIndex(2);
          useCADStore.getState().setDatumPickerTarget('point2');
        } else if (targetIdx === 2) {
          setPoint2(newPt);
          setPoint2Ref(vRef);
          setActivePointIndex(3);
          useCADStore.getState().setDatumPickerTarget('point3');
        } else {
          setPoint3(newPt);
          setPoint3Ref(vRef);
          useCADStore.getState().setDatumPickerTarget(null);
        }
      }
    };

    window.addEventListener('cad-set-datum-reference-face' as any, handleRefFace);
    window.addEventListener('cad-set-datum-reference-plane' as any, handleRefPlane);
    window.addEventListener('cad-set-datum-axis' as any, handleAxisSelected);
    window.addEventListener('cad-set-datum-axis-edge' as any, handleAxisEdgeSelected);
    window.addEventListener('cad-set-datum-point' as any, handlePointSelected);

    return () => {
      window.removeEventListener('cad-set-datum-reference-face' as any, handleRefFace);
      window.removeEventListener('cad-set-datum-reference-plane' as any, handleRefPlane);
      window.removeEventListener('cad-set-datum-axis' as any, handleAxisSelected);
      window.removeEventListener('cad-set-datum-axis-edge' as any, handleAxisEdgeSelected);
      window.removeEventListener('cad-set-datum-point' as any, handlePointSelected);
    };
  }, [activePointIndex]);

  // 三點合法性驗證
  const threePointValidation = useMemo(() => {
    if (planeType !== 'three-point') return { isValid: true };
    if (!point1 || !point2 || !point3) {
      return { isValid: false, error: '請指定完整的三個 3D 空間參考點' };
    }
    return validateThreePoints(point1, point2, point3);
  }, [planeType, point1, point2, point3]);

  // 即時計算與推送基準面 Preview 狀態至 CAD Store
  useEffect(() => {
    if (!isOpen) {
      setDatumPlanePreview(null);
      return;
    }

    if (planeType === 'offset') {
      const refPlane = resolveRefPlane();
      const effDist = flipOffset ? -offsetDistance : offsetDistance;
      const previewName = `${customRefPlaneName || refPlane.name || 'Plane'} (Preview Offset: ${effDist >= 0 ? '+' : ''}${effDist}mm)`;
      const previewPlane = createOffsetPlane(refPlane, effDist, 'datum-plane-preview', previewName);

      setDatumPlanePreview({
        isOpen: true,
        mode: 'offset',
        referencePlaneId: customRefPlane ? 'custom-face' : selectedRefPlaneId,
        offsetDistance: effDist,
        isValid: true,
        plane: previewPlane,
        activePicker,
        selectedFaceRef: selectedFaceRef || undefined,
      });
    } else if (planeType === 'angle') {
      // Angle 模式
      const refPlane = resolveRefPlane();
      const effAngleDeg = flipAngle ? -rotationAngleDeg : rotationAngleDeg;
      const angleRad = (effAngleDeg * Math.PI) / 180;

      let axisOrigin: Point3D;
      let axisDir: Point3D;

      if (axisSourceMode === 'standard') {
        axisOrigin = { ...refPlane.origin };
        if (standardAxis === 'X') {
          axisDir = { x: 1, y: 0, z: 0 };
        } else if (standardAxis === 'Y') {
          axisDir = { x: 0, y: 1, z: 0 };
        } else {
          axisDir = { x: 0, y: 0, z: 1 };
        }
      } else if (axisSourceMode === 'brep_edge' && brepAxisOrigin && brepAxisDirection) {
        axisOrigin = brepAxisOrigin;
        axisDir = brepAxisDirection;
      } else {
        const lineItem = availableLines.find((l) => l.id === selectedLineEntityId);
        if (lineItem) {
          const sketchPlane = resolveSketchPlane(lineItem.sketch);
          const start3D = map2DTo3DWorld(lineItem.line.start, sketchPlane);
          const end3D = map2DTo3DWorld(lineItem.line.end, sketchPlane);
          axisOrigin = start3D;
          axisDir = normalize3D(sub3D(end3D, start3D));
        } else {
          axisOrigin = { ...refPlane.origin };
          axisDir = { ...refPlane.xAxis };
        }
      }

      const previewName = `${customRefPlaneName || refPlane.name || 'Plane'} (Preview Angle: ${effAngleDeg >= 0 ? '+' : ''}${effAngleDeg}°)`;
      const previewPlane = createRotatedPlaneAroundAxis(
        refPlane,
        axisOrigin,
        axisDir,
        angleRad,
        'datum-plane-preview',
        previewName
      );

      setDatumPlanePreview({
        isOpen: true,
        mode: 'angle',
        referencePlaneId: customRefPlane ? 'custom-face' : selectedRefPlaneId,
        rotationAngleDeg: effAngleDeg,
        rotationAngleRad: angleRad,
        axisSourceMode,
        standardAxis,
        axisOrigin,
        axisDirection: axisDir,
        selectedLineEntityId: axisSourceMode === 'sketch_edge' ? selectedLineEntityId : undefined,
        selectedEdgeRef: selectedEdgeRef || undefined,
        activePicker,
        isValid: true,
        plane: previewPlane,
      });
    } else {
      // Three-Point 模式
      if (point1 && point2 && point3 && threePointValidation.isValid) {
        try {
          const previewPlane = createThreePointPlane(
            point1,
            point2,
            point3,
            'Three-Point Plane (Preview)',
            'datum-plane-preview'
          );

          setDatumPlanePreview({
            isOpen: true,
            mode: 'three-point',
            point1,
            point2,
            point3,
            activePointIndex,
            activePicker,
            isValid: true,
            errorMessage: null,
            plane: previewPlane,
          });
        } catch (err: any) {
          setDatumPlanePreview({
            isOpen: true,
            mode: 'three-point',
            point1,
            point2,
            point3,
            activePointIndex,
            activePicker,
            isValid: false,
            errorMessage: err?.message || '三點無法構成有效平面',
            plane: null,
          });
        }
      } else {
        setDatumPlanePreview({
          isOpen: true,
          mode: 'three-point',
          point1,
          point2,
          point3,
          activePointIndex,
          activePicker,
          isValid: false,
          errorMessage: threePointValidation.error || '請選取完整的三個 3D 空間點',
          plane: null,
        });
      }
    }
  }, [
    isOpen,
    planeType,
    selectedRefPlaneId,
    customRefPlane,
    customRefPlaneName,
    selectedFaceRef,
    offsetDistance,
    flipOffset,
    rotationAngleDeg,
    flipAngle,
    axisSourceMode,
    standardAxis,
    selectedLineEntityId,
    selectedEdgeRef,
    brepAxisOrigin,
    brepAxisDirection,
    availableLines,
    point1,
    point2,
    point3,
    activePointIndex,
    activePicker,
    threePointValidation,
    resolveRefPlane,
    resolveSketchPlane,
    setDatumPlanePreview,
  ]);

  // 元件卸載時務必清除預覽
  useEffect(() => {
    return () => {
      setDatumPlanePreview(null);
    };
  }, [setDatumPlanePreview]);

  const handleClose = () => {
    setDatumPlanePreview(null);
    useCADStore.getState().setDatumPickerTarget(null);
    onClose();
  };

  if (!isOpen) return null;

  const handleConfirm = () => {
    if (planeType === 'three-point' && (!threePointValidation.isValid || !point1 || !point2 || !point3)) {
      alert(threePointValidation.error || '請確認三個 3D 點皆合法且不共線');
      return;
    }

    // 1. 建立正式特徵前先清除即時預覽
    setDatumPlanePreview(null);
    useCADStore.getState().setDatumPickerTarget(null);

    const planeId = `datum-plane-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const finalName = featureName.trim() || 'DatumPlane';

    let calculatedPlane: CustomPlane;
    let effDist: number | undefined = undefined;
    let angleRad: number | undefined = undefined;
    let axisOrigin: Point3D | undefined = undefined;
    let axisDir: Point3D | undefined = undefined;
    let refPlaneId: string | undefined = undefined;

    if (planeType === 'offset') {
      const refPlane = resolveRefPlane();
      refPlaneId = customRefPlane ? undefined : selectedRefPlaneId;
      effDist = offsetDistance * (flipOffset ? -1 : 1);
      calculatedPlane = createOffsetPlane(refPlane, effDist, planeId, finalName);
    } else if (planeType === 'angle') {
      // 繞軸/邊旋轉模式
      const refPlane = resolveRefPlane();
      refPlaneId = customRefPlane ? undefined : selectedRefPlaneId;
      const effAngleDeg = flipAngle ? -rotationAngleDeg : rotationAngleDeg;
      angleRad = (effAngleDeg * Math.PI) / 180;

      if (axisSourceMode === 'standard') {
        axisOrigin = { ...refPlane.origin };
        if (standardAxis === 'X') {
          axisDir = { x: 1, y: 0, z: 0 };
        } else if (standardAxis === 'Y') {
          axisDir = { x: 0, y: 1, z: 0 };
        } else {
          axisDir = { x: 0, y: 0, z: 1 };
        }
      } else if (axisSourceMode === 'brep_edge' && brepAxisOrigin && brepAxisDirection) {
        axisOrigin = brepAxisOrigin;
        axisDir = brepAxisDirection;
      } else {
        const lineItem = availableLines.find((l) => l.id === selectedLineEntityId);
        if (lineItem) {
          const sketchPlane = resolveSketchPlane(lineItem.sketch);
          const start3D = map2DTo3DWorld(lineItem.line.start, sketchPlane);
          const end3D = map2DTo3DWorld(lineItem.line.end, sketchPlane);
          axisOrigin = start3D;
          axisDir = normalize3D(sub3D(end3D, start3D));
        } else {
          axisOrigin = { ...refPlane.origin };
          axisDir = { ...refPlane.xAxis };
        }
      }

      calculatedPlane = createRotatedPlaneAroundAxis(
        refPlane,
        axisOrigin,
        axisDir,
        angleRad,
        planeId,
        finalName
      );
    } else {
      // Three-Point 模式
      if (!point1 || !point2 || !point3) return;
      calculatedPlane = createThreePointPlane(point1, point2, point3, finalName, planeId);
    }

    const newFeature: DatumPlaneFeature = {
      id: planeId,
      name: finalName,
      type: 'DATUM_PLANE',
      planeType: customRefPlane ? 'face_reference' : planeType,
      referencePlaneId: refPlaneId,
      referenceFaceRef: selectedFaceRef ? selectedFaceRef.topoRef : undefined,
      referenceEdgeRef: selectedEdgeRef ? selectedEdgeRef.topoRef : undefined,
      offsetDistance: planeType === 'offset' ? effDist : undefined,
      rotationAngle: planeType === 'angle' ? angleRad : undefined,
      rotationAngleDeg: planeType === 'angle' ? rotationAngleDeg : undefined,
      axisOrigin,
      axisDirection: axisDir,
      referenceEdgeEntityId:
        planeType === 'angle' && axisSourceMode === 'sketch_edge'
          ? selectedLineEntityId
          : undefined,
      point1: planeType === 'three-point' ? point1 || undefined : undefined,
      point2: planeType === 'three-point' ? point2 || undefined : undefined,
      point3: planeType === 'three-point' ? point3 || undefined : undefined,
      point1Ref: point1Ref ? point1Ref.topoRef : undefined,
      point2Ref: point2Ref ? point2Ref.topoRef : undefined,
      point3Ref: point3Ref ? point3Ref.topoRef : undefined,
      plane: calculatedPlane,
      dependencies: refPlaneId ? [refPlaneId] : [],
      suppressed: false,
      visible: true,
    };

    const store = useCADStore.getState();
    store.addFeature(newFeature);

    // 擴充全域 planes 快取
    useCADStore.setState((state) => ({
      document: {
        ...state.document,
        planes: {
          ...state.document.planes,
          [newFeature.id]: calculatedPlane,
        },
      },
    }));

    // 切換至 3D 視角檢視新建的空間基準面
    store.setViewMode('3D');
    onClose();
  };

  const isAngle = planeType === 'angle';
  const isThreePoint = planeType === 'three-point';

  const themeColor = isThreePoint
    ? {
        headerBg: 'bg-emerald-950/80 border-emerald-800/50',
        badgeBg: 'bg-emerald-600/20 text-emerald-400 border-emerald-500/40',
        focusBorder: 'focus:border-emerald-500/80',
        btnPrimary: 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-900/30',
        iconColor: 'text-emerald-400',
      }
    : isAngle
    ? {
        headerBg: 'bg-purple-950/80 border-purple-800/50',
        badgeBg: 'bg-purple-600/20 text-purple-400 border-purple-500/40',
        focusBorder: 'focus:border-purple-500/80',
        btnPrimary: 'bg-purple-600 hover:bg-purple-500 shadow-purple-900/30',
        iconColor: 'text-purple-400',
      }
    : {
        headerBg: 'bg-cyan-950/80 border-cyan-800/50',
        badgeBg: 'bg-cyan-600/20 text-cyan-400 border-cyan-500/40',
        focusBorder: 'focus:border-cyan-500/80',
        btnPrimary: 'bg-cyan-600 hover:bg-cyan-500 shadow-cyan-900/30',
        iconColor: 'text-cyan-400',
      };

  return (
    <div
      className="fixed top-20 left-4 z-40 w-96 max-h-[calc(100vh-6rem)] overflow-hidden flex flex-col bg-neutral-950/95 backdrop-blur-md border border-neutral-800 rounded-xl shadow-2xl text-neutral-200 select-none animate-in fade-in slide-in-from-left-4 duration-200 pointer-events-auto"
      onClick={(e) => e.stopPropagation()}
      id="datum-plane-propertymanager"
    >
      {/* 頂部 Header */}
      <div
        className={`h-12 px-4 border-b flex items-center justify-between shrink-0 font-sans ${themeColor.headerBg}`}
      >
        <div className="flex items-center gap-2.5">
          <div className={`p-1.5 rounded-lg border shadow-sm ${themeColor.badgeBg}`}>
            {isThreePoint ? <Triangle size={18} /> : isAngle ? <RotateCw size={18} /> : <SquareDashed size={18} />}
          </div>
          <div>
            <h3 className="text-sm font-bold tracking-wide text-white flex items-center gap-2">
              {isThreePoint
                ? '三點基準面 (Three Point Plane)'
                : isAngle
                ? '旋轉基準面 (Angle Datum Plane)'
                : '偏移基準面 (Offset Datum Plane)'}
            </h3>
            <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
              <Eye size={11} className={themeColor.iconColor} />
              <span>3D 空間姿態即時預覽中</span>
            </div>
          </div>
        </div>
        <button
          onClick={handleClose}
          className="p-1 text-neutral-400 hover:text-white hover:bg-neutral-800/80 rounded-lg transition-colors cursor-pointer"
          title="關閉 (Esc)"
        >
          <X size={16} />
        </button>
      </div>

      {/* 表單內容主體 */}
      <form onSubmit={(e) => { e.preventDefault(); handleConfirm(); }} className="p-4 space-y-4 font-sans text-xs overflow-y-auto">
        {/* 特徵名稱 */}
        <div className="space-y-1.5">
          <label className="block font-semibold text-neutral-300 flex items-center justify-between">
            <span>特徵名稱 (Feature Name)</span>
            <span className="text-[10px] font-mono text-neutral-500">Auto ID</span>
          </label>
          <input
            type="text"
            value={featureName}
            onChange={(e) => setFeatureName(e.target.value)}
            className={`w-full px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none transition-colors text-xs ${themeColor.focusBorder}`}
            placeholder="DatumPlane1"
          />
        </div>

        {/* 建立模式切換 Tabs */}
        <div className="space-y-1.5">
          <label className="block text-neutral-400 font-semibold">建立模式 (Plane Type)</label>
          <div className="grid grid-cols-3 gap-1.5 p-1 bg-neutral-900 border border-neutral-800 rounded-lg">
            <button
              type="button"
              onClick={() => setPlaneType('offset')}
              className={`py-1.5 px-2 rounded-md font-medium text-[11px] flex items-center justify-center gap-1 transition-all cursor-pointer ${
                planeType === 'offset'
                  ? 'bg-cyan-600 text-white font-bold shadow-sm'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <ArrowUpRight size={13} />
              <span>偏移 (Offset)</span>
            </button>
            <button
              type="button"
              onClick={() => setPlaneType('angle')}
              className={`py-1.5 px-2 rounded-md font-medium text-[11px] flex items-center justify-center gap-1 transition-all cursor-pointer ${
                planeType === 'angle'
                  ? 'bg-purple-600 text-white font-bold shadow-sm'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <RotateCw size={13} />
              <span>旋轉 (Angle)</span>
            </button>
            <button
              type="button"
              onClick={() => setPlaneType('three-point')}
              className={`py-1.5 px-2 rounded-md font-medium text-[11px] flex items-center justify-center gap-1 transition-all cursor-pointer ${
                planeType === 'three-point'
                  ? 'bg-emerald-600 text-white font-bold shadow-sm'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <Triangle size={13} />
              <span>三點 (3-Pt)</span>
            </button>
          </div>
        </div>

        {/* 參照基準面選擇 (Offset 與 Angle 模式需要) */}
        {planeType !== 'three-point' && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="block font-semibold text-neutral-300 flex items-center gap-1.5">
                <Layers size={14} className={themeColor.iconColor} />
                <span>參照基準面 (Reference Plane)</span>
              </label>
              <button
                type="button"
                onClick={() => {
                  const next = activePicker === 'reference_plane' ? null : 'reference_plane';
                  useCADStore.getState().setDatumPickerTarget(next);
                }}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all flex items-center gap-1 cursor-pointer ${
                  activePicker === 'reference_plane'
                    ? 'bg-amber-400 text-neutral-950 shadow-md animate-pulse ring-1 ring-amber-300'
                    : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700'
                }`}
                title="點擊後可直接在 3D 視圖中點選基準面或實體表面"
              >
                <MousePointerClick size={12} />
                <span>{activePicker === 'reference_plane' ? '🎯 3D 拾取中' : '3D 拾取參考面'}</span>
              </button>
            </div>
            <div className="flex gap-1.5 items-center">
              <select
                value={customRefPlane ? 'custom-face' : selectedRefPlaneId}
                onChange={(e) => {
                  if (e.target.value !== 'custom-face') {
                    setCustomRefPlane(null);
                    setCustomRefPlaneName(null);
                    setSelectedFaceRef(null);
                    setSelectedRefPlaneId(e.target.value);
                  }
                }}
                className={`flex-1 px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none transition-colors ${themeColor.focusBorder}`}
              >
                {customRefPlane && (
                  <option value="custom-face">
                    ✨ {customRefPlaneName || '實體表面 (Planar Face)'}
                  </option>
                )}
                {availableRefPlanes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {customRefPlane && (
                <button
                  type="button"
                  onClick={() => {
                    setCustomRefPlane(null);
                    setCustomRefPlaneName(null);
                    setSelectedFaceRef(null);
                    setSelectedRefPlaneId('datum-front');
                  }}
                  className="p-2 text-neutral-400 hover:text-red-400 bg-neutral-900 border border-neutral-800 rounded-lg transition-colors cursor-pointer"
                  title="清除自訂表面並重設為 Front Plane"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* 法向偏移模式控制項 */}
        {planeType === 'offset' && (
          <div className="space-y-3 p-3 bg-neutral-900/60 border border-neutral-800/80 rounded-lg">
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-neutral-300 font-semibold">偏移距離 (Offset Distance)</label>
                <span className="text-[11px] text-cyan-400 font-mono font-bold">mm</span>
              </div>
              <input
                type="number"
                step="1"
                value={offsetDistance}
                onChange={(e) => setOffsetDistance(parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-700 rounded-md text-cyan-400 font-mono font-bold text-sm focus:outline-none focus:border-cyan-500"
              />
            </div>

            {/* 快速距離按鈕 */}
            <div className="flex gap-1.5">
              {[10, 20, 30, 50, 100].map((dist) => (
                <button
                  key={dist}
                  type="button"
                  onClick={() => setOffsetDistance(dist)}
                  className={`flex-1 py-1 rounded text-[11px] font-mono font-semibold transition-colors cursor-pointer ${
                    offsetDistance === dist
                      ? 'bg-cyan-600 text-white'
                      : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                  }`}
                >
                  {dist}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="chk-flip-offset"
                checked={flipOffset}
                onChange={(e) => setFlipOffset(e.target.checked)}
                className="rounded border-neutral-700 text-cyan-500 focus:ring-cyan-500 bg-neutral-900 cursor-pointer"
              />
              <label htmlFor="chk-flip-offset" className="text-neutral-300 cursor-pointer select-none">
                反向偏移 (Reverse Offset Direction)
              </label>
            </div>
          </div>
        )}

        {/* 繞軸旋轉模式控制項 */}
        {planeType === 'angle' && (
          <div className="space-y-3 p-3 bg-neutral-900/60 border border-neutral-800/80 rounded-lg">
            {/* 旋轉角度輸入與快捷鈕 */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-neutral-300 font-semibold">旋轉角度 (Rotation Angle)</label>
                <span className="text-[11px] text-purple-400 font-mono font-bold">度 (°)</span>
              </div>
              <div className="flex gap-2 mb-2">
                <input
                  type="number"
                  step="1"
                  value={rotationAngleDeg}
                  onChange={(e) => setRotationAngleDeg(parseFloat(e.target.value) || 0)}
                  className="flex-1 px-3 py-1.5 bg-neutral-950 border border-neutral-700 rounded-md text-purple-400 font-mono font-bold text-sm focus:outline-none focus:border-purple-500"
                />
              </div>
              {/* 快捷填寫按鈕 */}
              <div className="flex gap-1.5">
                {[30, 45, 60, 90, 135, 180].map((deg) => (
                  <button
                    key={deg}
                    type="button"
                    onClick={() => setRotationAngleDeg(deg)}
                    className={`flex-1 py-1 rounded text-[11px] font-mono font-semibold transition-colors cursor-pointer ${
                      rotationAngleDeg === deg
                        ? 'bg-purple-600 text-white'
                        : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                    }`}
                  >
                    {deg}°
                  </button>
                ))}
              </div>
            </div>

            {/* 旋轉軸來源設定 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="block text-neutral-300 font-semibold flex items-center gap-1">
                  <span>旋轉軸來源 (Rotation Axis)</span>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const next = activePicker === 'rotation_axis' ? null : 'rotation_axis';
                    useCADStore.getState().setDatumPickerTarget(next);
                  }}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all flex items-center gap-1 cursor-pointer ${
                    activePicker === 'rotation_axis'
                      ? 'bg-amber-400 text-neutral-950 shadow-md animate-pulse ring-1 ring-amber-300'
                      : 'bg-purple-900/60 hover:bg-purple-800/80 text-purple-200 border border-purple-700/60'
                  }`}
                  title="點擊後可直接在 3D 視圖中選取邊線或直線作為旋轉軸"
                >
                  <MousePointerClick size={12} />
                  <span>{activePicker === 'rotation_axis' ? '🎯 3D 拾取軸中' : '3D 拾取旋轉軸 (Edge)'}</span>
                </button>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={() => setAxisSourceMode('standard')}
                  className={`py-1.5 px-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer flex items-center justify-center gap-1 ${
                    axisSourceMode === 'standard'
                      ? 'bg-purple-950 border-purple-500 text-purple-300 font-bold'
                      : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white'
                  }`}
                >
                  <Axis3d size={13} />
                  <span>坐標軸</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAxisSourceMode('brep_edge')}
                  className={`py-1.5 px-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer flex items-center justify-center gap-1 ${
                    axisSourceMode === 'brep_edge'
                      ? 'bg-purple-950 border-purple-500 text-purple-300 font-bold'
                      : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white'
                  }`}
                >
                  <Sparkles size={13} />
                  <span>實體邊線</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAxisSourceMode('sketch_edge')}
                  className={`py-1.5 px-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer flex items-center justify-center gap-1 ${
                    axisSourceMode === 'sketch_edge'
                      ? 'bg-purple-950 border-purple-500 text-purple-300 font-bold'
                      : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white'
                  }`}
                >
                  <RotateCw size={13} />
                  <span>草圖線</span>
                </button>
              </div>

              {axisSourceMode === 'standard' ? (
                <div className="flex gap-2 pt-1">
                  {(['X', 'Y', 'Z'] as const).map((axis) => (
                    <button
                      key={axis}
                      type="button"
                      onClick={() => setStandardAxis(axis)}
                      className={`flex-1 py-1.5 rounded-lg border text-xs font-mono font-bold transition-colors cursor-pointer ${
                        standardAxis === axis
                          ? 'bg-purple-600 border-purple-400 text-white shadow-sm'
                          : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white'
                      }`}
                    >
                      {axis} 軸
                    </button>
                  ))}
                </div>
              ) : axisSourceMode === 'brep_edge' ? (
                <div className="p-2.5 bg-purple-950/40 border border-purple-800/40 rounded-lg text-purple-300 text-xs font-mono space-y-1">
                  {selectedEdgeRef ? (
                    <>
                      <div className="flex items-center justify-between font-bold text-purple-200">
                        <span>🎯 已選定實體邊線 (Edge #{selectedEdgeRef.edgeIndex})</span>
                      </div>
                      <div className="text-[10px] text-purple-300/80">
                        原點: ({brepAxisOrigin?.x.toFixed(1)}, {brepAxisOrigin?.y.toFixed(1)}, {brepAxisOrigin?.z.toFixed(1)})
                      </div>
                      <div className="text-[10px] text-purple-300/80">
                        向量: ({brepAxisDirection?.x.toFixed(2)}, {brepAxisDirection?.y.toFixed(2)}, {brepAxisDirection?.z.toFixed(2)})
                      </div>
                    </>
                  ) : (
                    <div className="text-amber-300/90 text-[11px]">
                      💡 請在 3D 視圖中點選模型的邊線，或點擊上方「3D 拾取旋轉軸」
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-1 pt-1">
                  {availableLines.length === 0 ? (
                    <div className="p-2.5 bg-amber-950/40 border border-amber-800/40 rounded-lg text-amber-300 text-[11px]">
                      ⚠️ 目前尚無草圖直線，請在 2D 草圖中繪製直線或建構線。
                    </div>
                  ) : (
                    <select
                      value={selectedLineEntityId}
                      onChange={(e) => setSelectedLineEntityId(e.target.value)}
                      className="w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-lg text-neutral-200 text-xs focus:outline-none focus:border-purple-500 cursor-pointer font-mono"
                    >
                      {availableLines.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <p className="text-[10px] text-neutral-400 px-1">
                    💡 可直接在 3D 視圖中將滑鼠懸停於草圖線上點擊選取
                  </p>
                </div>
              )}
            </div>

            {/* 反向旋轉 Checkbox */}
            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="chk-flip-angle"
                checked={flipAngle}
                onChange={(e) => setFlipAngle(e.target.checked)}
                className="rounded border-neutral-700 text-purple-500 focus:ring-purple-500 bg-neutral-900 cursor-pointer"
              />
              <label htmlFor="chk-flip-angle" className="text-neutral-300 cursor-pointer select-none">
                反向旋轉 (Reverse Rotation Direction)
              </label>
            </div>
          </div>
        )}

        {/* 三點定義模式控制項 */}
        {planeType === 'three-point' && (
          <div className="space-y-3 p-3 bg-neutral-900/60 border border-neutral-800/80 rounded-lg">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-neutral-300 flex items-center gap-1.5">
                <MapPin size={14} className="text-emerald-400" />
                <span>3D 空間定位三點</span>
              </span>
              <span className="text-[10px] text-emerald-400 font-mono">
                💡 點擊右側按鈕並在 3D 視圖拾取點
              </span>
            </div>

            {/* 快速幾何預設 */}
            <div className="space-y-1">
              <label className="text-[10px] text-neutral-400 font-semibold">快速幾何預設 (Presets)</label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setPoint1({ x: 0, y: 0, z: 0 });
                    setPoint2({ x: 100, y: 0, z: 0 });
                    setPoint3({ x: 0, y: 100, z: 0 });
                  }}
                  className="py-1 px-2 bg-neutral-800/80 hover:bg-neutral-700 border border-neutral-700 rounded text-[11px] font-mono text-neutral-300 hover:text-white transition-colors cursor-pointer text-left"
                >
                  📐 XY 平面 (Z=0)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPoint1({ x: 0, y: 0, z: 0 });
                    setPoint2({ x: 100, y: 0, z: 0 });
                    setPoint3({ x: 0, y: 100, z: 100 });
                  }}
                  className="py-1 px-2 bg-neutral-800/80 hover:bg-neutral-700 border border-neutral-700 rounded text-[11px] font-mono text-neutral-300 hover:text-white transition-colors cursor-pointer text-left"
                >
                  📐 3D 傾斜面 (45°)
                </button>
              </div>
            </div>

            {/* 點 1 (原點) */}
            <div
              className={`p-2.5 rounded-lg border transition-all ${
                activePicker === 'point1' || activePointIndex === 1
                  ? 'bg-emerald-950/50 border-emerald-500 shadow-md shadow-emerald-950/50'
                  : 'bg-neutral-950/60 border-neutral-800'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="font-bold text-emerald-300">Point 1 (基準原點)</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      const next = activePicker === 'point1' ? null : 'point1';
                      setActivePointIndex(1);
                      useCADStore.getState().setDatumPickerTarget(next);
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                      activePicker === 'point1'
                        ? 'bg-amber-400 text-neutral-950 animate-pulse font-extrabold shadow-sm'
                        : activePointIndex === 1
                        ? 'bg-emerald-500 text-black'
                        : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                    }`}
                  >
                    {activePicker === 'point1' ? '🎯 3D 拾取中' : '3D 拾取'}
                  </button>
                  {point1 && (
                    <button
                      type="button"
                      onClick={() => {
                        setPoint1(null);
                        setPoint1Ref(null);
                      }}
                      className="p-1 text-neutral-400 hover:text-red-400 transition-colors"
                      title="清除"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1.5 font-mono text-[11px]">
                <div className="flex items-center gap-1 bg-neutral-900 px-1.5 py-1 rounded border border-neutral-800">
                  <span className="text-red-400 font-bold">X:</span>
                  <input
                    type="number"
                    value={point1?.x ?? ''}
                    onChange={(e) =>
                      setPoint1({
                        x: parseFloat(e.target.value) || 0,
                        y: point1?.y ?? 0,
                        z: point1?.z ?? 0,
                      })
                    }
                    placeholder="0"
                    className="w-full bg-transparent text-white focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-1 bg-neutral-900 px-1.5 py-1 rounded border border-neutral-800">
                  <span className="text-green-400 font-bold">Y:</span>
                  <input
                    type="number"
                    value={point1?.y ?? ''}
                    onChange={(e) =>
                      setPoint1({
                        x: point1?.x ?? 0,
                        y: parseFloat(e.target.value) || 0,
                        z: point1?.z ?? 0,
                      })
                    }
                    placeholder="0"
                    className="w-full bg-transparent text-white focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-1 bg-neutral-900 px-1.5 py-1 rounded border border-neutral-800">
                  <span className="text-blue-400 font-bold">Z:</span>
                  <input
                    type="number"
                    value={point1?.z ?? ''}
                    onChange={(e) =>
                      setPoint1({
                        x: point1?.x ?? 0,
                        y: point1?.y ?? 0,
                        z: parseFloat(e.target.value) || 0,
                      })
                    }
                    placeholder="0"
                    className="w-full bg-transparent text-white focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* 點 2 (X 軸向) */}
            <div
              className={`p-2.5 rounded-lg border transition-all ${
                activePicker === 'point2' || activePointIndex === 2
                  ? 'bg-blue-950/50 border-blue-500 shadow-md shadow-blue-950/50'
                  : 'bg-neutral-950/60 border-neutral-800'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-blue-400" />
                  <span className="font-bold text-blue-300">Point 2 (X 軸方向)</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      const next = activePicker === 'point2' ? null : 'point2';
                      setActivePointIndex(2);
                      useCADStore.getState().setDatumPickerTarget(next);
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                      activePicker === 'point2'
                        ? 'bg-amber-400 text-neutral-950 animate-pulse font-extrabold shadow-sm'
                        : activePointIndex === 2
                        ? 'bg-blue-500 text-white'
                        : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                    }`}
                  >
                    {activePicker === 'point2' ? '🎯 3D 拾取中' : '3D 拾取'}
                  </button>
                  {point2 && (
                    <button
                      type="button"
                      onClick={() => {
                        setPoint2(null);
                        setPoint2Ref(null);
                      }}
                      className="p-1 text-neutral-400 hover:text-red-400 transition-colors"
                      title="清除"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1.5 font-mono text-[11px]">
                <div className="flex items-center gap-1 bg-neutral-900 px-1.5 py-1 rounded border border-neutral-800">
                  <span className="text-red-400 font-bold">X:</span>
                  <input
                    type="number"
                    value={point2?.x ?? ''}
                    onChange={(e) =>
                      setPoint2({
                        x: parseFloat(e.target.value) || 0,
                        y: point2?.y ?? 0,
                        z: point2?.z ?? 0,
                      })
                    }
                    placeholder="0"
                    className="w-full bg-transparent text-white focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-1 bg-neutral-900 px-1.5 py-1 rounded border border-neutral-800">
                  <span className="text-green-400 font-bold">Y:</span>
                  <input
                    type="number"
                    value={point2?.y ?? ''}
                    onChange={(e) =>
                      setPoint2({
                        x: point2?.x ?? 0,
                        y: parseFloat(e.target.value) || 0,
                        z: point2?.z ?? 0,
                      })
                    }
                    placeholder="0"
                    className="w-full bg-transparent text-white focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-1 bg-neutral-900 px-1.5 py-1 rounded border border-neutral-800">
                  <span className="text-blue-400 font-bold">Z:</span>
                  <input
                    type="number"
                    value={point2?.z ?? ''}
                    onChange={(e) =>
                      setPoint2({
                        x: point2?.x ?? 0,
                        y: point2?.y ?? 0,
                        z: parseFloat(e.target.value) || 0,
                      })
                    }
                    placeholder="0"
                    className="w-full bg-transparent text-white focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* 點 3 (決定平面法向) */}
            <div
              className={`p-2.5 rounded-lg border transition-all ${
                activePicker === 'point3' || activePointIndex === 3
                  ? 'bg-amber-950/50 border-amber-500 shadow-md shadow-amber-950/50'
                  : 'bg-neutral-950/60 border-neutral-800'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-400" />
                  <span className="font-bold text-amber-300">Point 3 (決定平面法向)</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      const next = activePicker === 'point3' ? null : 'point3';
                      setActivePointIndex(3);
                      useCADStore.getState().setDatumPickerTarget(next);
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                      activePicker === 'point3'
                        ? 'bg-amber-400 text-neutral-950 animate-pulse font-extrabold shadow-sm'
                        : activePointIndex === 3
                        ? 'bg-amber-500 text-black'
                        : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                    }`}
                  >
                    {activePicker === 'point3' ? '🎯 3D 拾取中' : '3D 拾取'}
                  </button>
                  {point3 && (
                    <button
                      type="button"
                      onClick={() => {
                        setPoint3(null);
                        setPoint3Ref(null);
                      }}
                      className="p-1 text-neutral-400 hover:text-red-400 transition-colors"
                      title="清除"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1.5 font-mono text-[11px]">
                <div className="flex items-center gap-1 bg-neutral-900 px-1.5 py-1 rounded border border-neutral-800">
                  <span className="text-red-400 font-bold">X:</span>
                  <input
                    type="number"
                    value={point3?.x ?? ''}
                    onChange={(e) =>
                      setPoint3({
                        x: parseFloat(e.target.value) || 0,
                        y: point3?.y ?? 0,
                        z: point3?.z ?? 0,
                      })
                    }
                    placeholder="0"
                    className="w-full bg-transparent text-white focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-1 bg-neutral-900 px-1.5 py-1 rounded border border-neutral-800">
                  <span className="text-green-400 font-bold">Y:</span>
                  <input
                    type="number"
                    value={point3?.y ?? ''}
                    onChange={(e) =>
                      setPoint3({
                        x: point3?.x ?? 0,
                        y: parseFloat(e.target.value) || 0,
                        z: point3?.z ?? 0,
                      })
                    }
                    placeholder="0"
                    className="w-full bg-transparent text-white focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-1 bg-neutral-900 px-1.5 py-1 rounded border border-neutral-800">
                  <span className="text-blue-400 font-bold">Z:</span>
                  <input
                    type="number"
                    value={point3?.z ?? ''}
                    onChange={(e) =>
                      setPoint3({
                        x: point3?.x ?? 0,
                        y: point3?.y ?? 0,
                        z: parseFloat(e.target.value) || 0,
                      })
                    }
                    placeholder="0"
                    className="w-full bg-transparent text-white focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* 錯誤/警告提示 */}
            {!threePointValidation.isValid && (
              <div className="p-2.5 bg-red-950/50 border border-red-800/60 rounded-lg text-red-300 text-[11px] flex items-center gap-2">
                <AlertTriangle size={14} className="text-red-400 shrink-0" />
                <span>{threePointValidation.error}</span>
              </div>
            )}
          </div>
        )}

        {/* 底部按鈕群 */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-800">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-xs font-semibold text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-lg transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={planeType === 'three-point' && !threePointValidation.isValid}
            className={`px-5 py-2 text-xs font-bold text-white rounded-lg shadow-lg flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${themeColor.btnPrimary}`}
          >
            <Check size={15} />
            <span>確定建立基準面</span>
          </button>
        </div>
      </form>
    </div>
  );
};

export default DatumPlaneModal;
