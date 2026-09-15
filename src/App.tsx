/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { useCADStore } from './store/cadStore';
import { useCadShortcuts } from './hooks/useCadShortcuts';
import { CADSketchCanvas } from './components/CADSketchCanvas';
const CAD3DCanvas = React.lazy(() => import('./components/CAD3DCanvas'));
import { SketchFeature, BoundingBox2D, CADEntity2D } from './types/cad';
import { OsnapSettingsModal } from './components/OsnapSettingsModal';
import { PolarSettingsModal } from './components/PolarSettingsModal';
import { LayerControlBar } from './components/LayerControlBar';
import { LayerManagerModal } from './components/LayerManagerModal';
import { FeatureTreePanel } from './components/FeatureTreePanel';
import { ExtrudeFeatureModal } from './components/ExtrudeFeatureModal';
import { RevolveFeatureModal } from './components/RevolveFeatureModal';
import { PatternMirrorModal } from './components/PatternMirrorModal';
import { SweepLoftModal } from './components/SweepLoftModal';
import { exportSketchToDxf, downloadDxfFile } from './core/dxf/DxfWriter';
import { parseDxfContent } from './core/dxf/DxfParser';
import { solidEngine } from './core/3d/SolidEngine';
import { triggerFileExport, has3DSolidFeatures } from './lib/export3D';
import { createPlaneFromFaceNormal } from './core/3d/DatumPlaneEngine';
import { computeEntitiesBoundingBox } from './core/2d/ViewportTransform';
import {
  MousePointer2,
  Pencil,
  Square,
  Undo2,
  Redo2,
  Maximize,
  Circle,
  CircleDot,
  Compass,
  Spline,
  Magnet,
  MoveHorizontal,
  MoveVertical,
  Lock,
  Scissors,
  Ruler,
  CornerDownRight,
  MoveRight,
  AlertTriangle,
  Copy,
  CopyPlus,
  Share2,
  FlipHorizontal,
  Move,
  Scaling,
  RotateCw,
  RotateCcw,
  Orbit,
  LayoutGrid,
  SquareSlash,
  Hexagon,
  FileDown,
  FileUp,
  CheckCircle2,
  Box,
  Route,
  Layers,
  Disc,
  BoxSelect,
  Loader2,
} from 'lucide-react';

export default function App() {
  // 啟用全域快速鍵
  useCadShortcuts();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<NodeJS.Timeout | null>(null);
  const dragCounterRef = useRef<number>(0);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<'STEP' | 'STL' | null>(null);
  const [importToast, setImportToast] = useState<{
    entityCount: number;
    units: string;
    mergedPointsCount?: number;
    removedEntitiesCount?: number;
  } | null>(null);

  // 伸長長料 (Extrude Boss) / 伸長除料 (Extrude Cut) 參數設定彈窗狀態
  const [extrudeModalConfig, setExtrudeModalConfig] = useState<{
    isOpen: boolean;
    mode: 'EXTRUDE' | 'CUT_EXTRUDE';
  }>({
    isOpen: false,
    mode: 'EXTRUDE',
  });

  // 旋轉長料 (Revolve Boss) / 旋轉除料 (Revolve Cut) 參數設定彈窗狀態
  const [revolveModalConfig, setRevolveModalConfig] = useState<{
    isOpen: boolean;
    mode: 'REVOLVE' | 'REVOLVE_CUT';
  }>({
    isOpen: false,
    mode: 'REVOLVE',
  });

  // 3D 陣列與鏡射 (Linear / Circular / Mirror 3D) 參數設定彈窗狀態
  const [patternModalConfig, setPatternModalConfig] = useState<{
    isOpen: boolean;
    mode: 'LINEAR_PATTERN' | 'CIRCULAR_PATTERN' | 'MIRROR_3D';
  }>({
    isOpen: false,
    mode: 'LINEAR_PATTERN',
  });

  // 掃出 (Sweep Boss) / 疊層拉伸 (Loft Boss) 參數設定彈窗狀態
  const [sweepLoftModalConfig, setSweepLoftModalConfig] = useState<{
    isOpen: boolean;
    mode: 'SWEEP' | 'LOFT';
  }>({
    isOpen: false,
    mode: 'SWEEP',
  });

  const {
    currentTool,
    setTool,
    viewMode,
    undo,
    redo,
    canUndo,
    canRedo,
    osnapEnabled,
    toggleOsnap,
    orthoEnabled,
    toggleOrtho,
    setOsnapModalOpen,
    document,
    activeSketchId,
    selectedEntityIds,
    addConstraint,
    toggleConstruction,
    polygonSides,
    setPolygonSides,
    polygonMethod,
    setPolygonMethod,
    importDxfData,
    showProfiles,
    toggleShowProfiles,
    show3DEdges,
    toggleShow3DEdges,
    selectedFaceInfo,
    setSelectedFaceInfo,
    createSketchOnFacePlane,
    setViewMode,
  } = useCADStore();

  // 清除彈窗 Timer 清理機制
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // 取得當前草圖與求解器狀態
  const activeSketch = document.featureTree.find(
    (f) => f.id === activeSketchId && f.type === 'SKETCH'
  ) as SketchFeature | undefined;

  const solverState = activeSketch?.solverState || 'UnderDefined';

  // 選取實體提取相容虛擬原點 (Virtual Origin Compatible)
  const hasOrigin = selectedEntityIds.includes('origin');
  const realSelectedEntities =
    activeSketch?.entities.filter((e) => selectedEntityIds.includes(e.id)) || [];
  const totalSelectedCount = selectedEntityIds.length;
  const isAnySelectedConstruction = realSelectedEntities.some((e) => e.isConstruction);

  // 約束適用性布林判定 (Constraint Applicability)
  // 1. 水平 / 垂直 (Horizontal / Vertical)
  const canApplyHorizontalVertical =
    (totalSelectedCount === 1 && realSelectedEntities[0]?.type === 'line') ||
    (totalSelectedCount === 2 && hasOrigin && realSelectedEntities.length === 1) ||
    (totalSelectedCount === 2 &&
      realSelectedEntities.length === 2 &&
      realSelectedEntities.every((e) => e.type === 'circle' || e.type === 'arc')) ||
    (totalSelectedCount === 2 &&
      realSelectedEntities.length === 2 &&
      realSelectedEntities.some((e) => e.type === 'circle' || e.type === 'arc') &&
      realSelectedEntities.some((e) => e.type === 'line'));

  // 2. 重合 / 同心 (Coincident / Concentric)
  const canApplyCoincident =
    totalSelectedCount === 2 &&
    (hasOrigin ? realSelectedEntities.length === 1 : realSelectedEntities.length === 2);

  // 3. 相切 (Tangent)
  const isLineAndCurve =
    realSelectedEntities.length === 2 &&
    ((realSelectedEntities[0].type === 'line' &&
      (realSelectedEntities[1].type === 'circle' || realSelectedEntities[1].type === 'arc')) ||
      ((realSelectedEntities[0].type === 'circle' || realSelectedEntities[0].type === 'arc') &&
        realSelectedEntities[1].type === 'line'));

  const isBothCurves =
    realSelectedEntities.length === 2 &&
    (realSelectedEntities[0].type === 'circle' || realSelectedEntities[0].type === 'arc') &&
    (realSelectedEntities[1].type === 'circle' || realSelectedEntities[1].type === 'arc');

  const canApplyTangent =
    totalSelectedCount === 2 &&
    !hasOrigin &&
    realSelectedEntities.length === 2 &&
    (isLineAndCurve || isBothCurves);

  // 4. 等半徑 (Equal Radius)
  const canApplyEqualRadius =
    totalSelectedCount === 2 &&
    !hasOrigin &&
    realSelectedEntities.length === 2 &&
    realSelectedEntities.every((e) => e.type === 'circle' || e.type === 'arc');

  // 5. 平行 / 垂直 / 等長 (Parallel / Perpendicular / Equal Length)
  const isBothLines =
    totalSelectedCount === 2 &&
    !hasOrigin &&
    realSelectedEntities.length === 2 &&
    realSelectedEntities.every((e) => e.type === 'line');

  // 6. 固定約束 (Fix)
  const canApplyFix = totalSelectedCount === 1 && !hasOrigin;

  const handleToggleConstruction = () => {
    realSelectedEntities.forEach((entity) => toggleConstruction(entity.id));
  };

  const handleAddHorizontal = () => {
    if (totalSelectedCount === 1 && selectedEntityIds[0]) {
      addConstraint({
        id: crypto.randomUUID(),
        type: 'horizontal',
        entityIds: [selectedEntityIds[0]],
      });
    } else if (totalSelectedCount === 2) {
      addConstraint({
        id: crypto.randomUUID(),
        type: 'horizontal',
        entityIds: [...selectedEntityIds],
      });
    }
  };

  const handleAddVertical = () => {
    if (totalSelectedCount === 1 && selectedEntityIds[0]) {
      addConstraint({
        id: crypto.randomUUID(),
        type: 'vertical',
        entityIds: [selectedEntityIds[0]],
      });
    } else if (totalSelectedCount === 2) {
      addConstraint({
        id: crypto.randomUUID(),
        type: 'vertical',
        entityIds: [...selectedEntityIds],
      });
    }
  };

  const handleAddFix = () => {
    if (totalSelectedCount === 1 && selectedEntityIds[0] && !hasOrigin) {
      addConstraint({
        id: crypto.randomUUID(),
        type: 'fix',
        entityIds: [selectedEntityIds[0]],
        pointIndices: [0], // 鎖定起點或中心點
      });
    }
  };

  const handleAddCoincident = () => {
    if (totalSelectedCount !== 2) return;
    addConstraint({
      id: crypto.randomUUID(),
      type: 'coincident',
      entityIds: [...selectedEntityIds],
    });
  };

  const handleAddParallel = () => {
    if (totalSelectedCount !== 2) return;
    addConstraint({
      id: crypto.randomUUID(),
      type: 'parallel',
      entityIds: [...selectedEntityIds],
    });
  };

  const handleAddPerpendicular = () => {
    if (totalSelectedCount !== 2) return;
    addConstraint({
      id: crypto.randomUUID(),
      type: 'perpendicular',
      entityIds: [...selectedEntityIds],
    });
  };

  const handleAddEqualLength = () => {
    if (totalSelectedCount !== 2) return;
    addConstraint({
      id: crypto.randomUUID(),
      type: 'equal_length',
      entityIds: [...selectedEntityIds],
    });
  };

  const handleAddEqualRadius = () => {
    if (totalSelectedCount !== 2) return;
    addConstraint({
      id: crypto.randomUUID(),
      type: 'equal_radius',
      entityIds: [...selectedEntityIds],
    });
  };

  const handleAddTangent = () => {
    if (totalSelectedCount !== 2) return;
    addConstraint({
      id: crypto.randomUUID(),
      type: 'tangent',
      entityIds: [...selectedEntityIds],
    });
  };

  const handleExportDxf = () => {
    const filename = `${activeSketch?.name || 'sketch'}.dxf`;
    const sketchToExport: SketchFeature = activeSketch || {
      id: activeSketchId || 'sketch-1',
      name: 'sketch',
      type: 'SKETCH',
      plane: {
        id: 'datum-front',
        name: 'Front Plane (XY)',
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
      },
      entities: [],
      constraints: [],
      dimensions: [],
      profiles: [],
      solverState: 'UnderDefined',
      dependencies: [],
      suppressed: false,
    };
    const dxfContent = exportSketchToDxf(sketchToExport, {
      units: document.units || 'mm',
      layers: document.layers || {},
    });
    downloadDxfFile(dxfContent, filename);
  };

  const handleExportSTEP = async () => {
    if (!has3DSolidFeatures(document.featureTree)) {
      alert('Failed to export. Make sure to generate a 3D solid first.');
      return;
    }
    setExportingFormat('STEP');
    try {
      await triggerFileExport(
        'STEP',
        document.featureTree,
        document.rollbackIndex,
        document.planes,
        document.title || 'cad_model'
      );
    } catch (e: any) {
      console.error('Export STEP failed:', e);
    } finally {
      setExportingFormat(null);
    }
  };

  const handleExportSTL = async () => {
    if (!has3DSolidFeatures(document.featureTree)) {
      alert('Failed to export. Make sure to generate a 3D solid first.');
      return;
    }
    setExportingFormat('STL');
    try {
      await triggerFileExport(
        'STL',
        document.featureTree,
        document.rollbackIndex,
        document.planes,
        document.title || 'cad_model'
      );
    } catch (e: any) {
      console.error('Export STL failed:', e);
    } finally {
      setExportingFormat(null);
    }
  };

  /**
   * 檔案處理核心函式：讀取並解析 DXF 檔案、匯入實體並發送自適應居中全景事件
   */
  const handleProcessDxfFile = async (file: File) => {
    try {
      const text = await file.text();
      const result = parseDxfContent(text, {
        targetUnits: document.units || 'mm',
        decomposePolylines: false,
        flattenBlocks: true,
        autoStitch: true,
        stitchTolerance: 1e-3,
      });

      if (result.warnings && result.warnings.length > 0) {
        console.warn('DXF Import Warnings:', result.warnings);
      }

      if (result.entities && result.entities.length > 0) {
        importDxfData(result.entities, result.layers);

        const bbox = computeEntitiesBoundingBox(result.entities);

        window.dispatchEvent(
          new CustomEvent('cad-zoom-to-bbox', {
            detail: { bbox, padding: 80 },
          })
        );

        // 顯示匯入成功浮條，包含圖元數量、單位換算與端點縫合統計，於 4 秒後自動消失
        setImportToast({
          entityCount: result.entities.length,
          units: result.units || document.units || 'mm',
          mergedPointsCount: result.stitchStats?.mergedPointsCount,
          removedEntitiesCount: result.stitchStats?.removedEntitiesCount,
        });

        if (toastTimerRef.current) {
          clearTimeout(toastTimerRef.current);
        }
        toastTimerRef.current = setTimeout(() => {
          setImportToast(null);
        }, 4000);
      }
    } catch (error) {
      console.error('Failed to process DXF file:', error);
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleProcessDxfFile(file);
    }
    e.target.value = '';
  };

  // 拖曳放置 handlers（使用 Drag Counter 結合 pointer-events-none 防止進入子元素時閃爍）
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDraggingOver(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDraggingOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);

    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleProcessDxfFile(file);
    }
  };

  return (
    <div
      className="w-full h-screen flex flex-col bg-neutral-900 text-white overflow-hidden relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 隱藏的檔案上傳輸入框 */}
      <input
        type="file"
        accept=".dxf"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        className="hidden"
      />

      {/* Top Toolbar: Double-Row Ribbon Bar */}
      <header className="h-auto py-1.5 border-b border-neutral-800 bg-neutral-950 px-4 shrink-0 flex flex-col gap-1.5">
        {/* 第一排：2D 繪圖與編輯工具列 */}
        <div className="flex items-center justify-between gap-2 w-full overflow-x-auto">
          {/* 左側：Logo「AI Studio CAD」與 2D 工具箱群組 */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="font-bold text-lg mr-4 select-none shrink-0">AI Studio CAD</div>

            {/* Tools */}
            <div className="flex bg-neutral-900 p-1 rounded-md border border-neutral-800 items-center gap-0.5">
              <button
                onClick={() => setTool('SELECT')}
                className={`p-1.5 rounded ${
                  currentTool === 'SELECT'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Select (S)"
              >
                <MousePointer2 size={18} />
              </button>
              <button
                onClick={() => setTool('LINE')}
                className={`p-1.5 rounded ${
                  currentTool === 'LINE'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Line (L)"
              >
                <Pencil size={18} />
              </button>
              <button
                onClick={() => setTool('POLYLINE')}
                className={`p-1.5 rounded ${
                  currentTool === 'POLYLINE'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Polyline (P)"
              >
                <Share2 size={18} />
              </button>
              <button
                onClick={() => setTool('RECTANGLE')}
                className={`p-1.5 rounded ${
                  currentTool === 'RECTANGLE'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Rectangle (R)"
              >
                <Square size={18} />
              </button>
              <button
                id="btn-tool-polygon"
                onClick={() => setTool('POLYGON')}
                className={`p-1.5 rounded transition-colors ${
                  currentTool === 'POLYGON'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Polygon (正多邊形)"
              >
                <Hexagon size={18} />
              </button>
              <button
                onClick={() => setTool('CIRCLE')}
                className={`p-1.5 rounded ${
                  currentTool === 'CIRCLE'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Circle: Center-Radius (C)"
              >
                <Circle size={18} />
              </button>
              <button
                id="btn-tool-circle-ttr"
                onClick={() => setTool('CIRCLE_TTR')}
                className={`p-1.5 rounded transition-colors ${
                  currentTool === 'CIRCLE_TTR'
                    ? 'bg-neutral-800 text-amber-400 border border-amber-500/40 shadow-sm'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Circle: Tangent, Tangent, Radius (TTR - 相切、相切、半徑)"
              >
                <div className="relative flex items-center justify-center">
                  <Circle size={18} />
                  <span className="absolute -bottom-1 -right-1 text-[8px] font-black font-mono text-amber-400 leading-none">T</span>
                </div>
              </button>
              <button
                id="btn-tool-circle-3t"
                onClick={() => setTool('CIRCLE_3T')}
                className={`p-1.5 rounded transition-colors ${
                  currentTool === 'CIRCLE_3T'
                    ? 'bg-neutral-800 text-emerald-400 border border-emerald-500/40 shadow-sm'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Circle: 3-Tangent (3T - 三相切畫圓)"
              >
                <div className="relative flex items-center justify-center">
                  <Circle size={18} />
                  <span className="absolute -bottom-1 -right-1 text-[8px] font-black font-mono text-emerald-400 leading-none">3T</span>
                </div>
              </button>
              <button
                onClick={() => setTool('ARC_3P')}
                className={`p-1.5 rounded ${
                  currentTool === 'ARC_3P' || currentTool === 'ARC'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Arc (A)"
              >
                <Compass size={18} />
              </button>
              <button
                onClick={() => setTool('ARC_CENTER')}
                className={`p-1.5 rounded ${
                  currentTool === 'ARC_CENTER'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Center-Start-End Arc"
              >
                <CircleDot size={18} />
              </button>
              <button
                onClick={() => setTool('TRIM')}
                className={`p-1.5 rounded ${
                  currentTool === 'TRIM'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Trim (T)"
              >
                <Scissors size={18} />
              </button>
              <button
                onClick={() => setTool('EXTEND')}
                className={`p-1.5 rounded ${
                  currentTool === 'EXTEND'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Extend (E)"
              >
                <MoveRight size={18} />
              </button>
              <button
                onClick={() => setTool('DIMENSION')}
                className={`p-1.5 rounded ${
                  currentTool === 'DIMENSION'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Dimension (D)"
              >
                <Ruler size={18} />
              </button>
              <button
                onClick={() => setTool('FILLET')}
                className={`p-1.5 rounded ${
                  currentTool === 'FILLET'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Fillet (F)"
              >
                <CornerDownRight size={18} />
              </button>
              <button
                onClick={() => setTool('CHAMFER')}
                className={`p-1.5 rounded ${
                  currentTool === 'CHAMFER'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Chamfer"
              >
                <SquareSlash size={18} />
              </button>
              <button
                onClick={() => setTool('OFFSET')}
                className={`p-1.5 rounded ${
                  currentTool === 'OFFSET'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Offset (O)"
              >
                <Copy size={18} />
              </button>
              <button
                onClick={() => setTool('PROJECT')}
                className={`p-1.5 rounded transition-colors ${
                  currentTool === 'PROJECT'
                    ? 'bg-neutral-800 text-blue-400 border border-blue-500/40 shadow-sm'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="投影幾何圖元 (Project Geometry)"
              >
                <BoxSelect size={18} />
              </button>
              <button
                onClick={() => setTool('MIRROR')}
                className={`p-1.5 rounded ${
                  currentTool === 'MIRROR'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Mirror (M)"
              >
                <FlipHorizontal size={18} />
              </button>
              <button
                onClick={() => setTool('MOVE')}
                className={`p-1.5 rounded ${
                  currentTool === 'MOVE'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Move"
              >
                <Move size={18} />
              </button>
              <button
                onClick={() => setTool('COPY')}
                className={`p-1.5 rounded ${
                  currentTool === 'COPY'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Copy"
              >
                <CopyPlus size={18} />
              </button>
              <button
                onClick={() => setTool('SCALE')}
                className={`p-1.5 rounded ${
                  currentTool === 'SCALE'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Scale"
              >
                <Scaling size={18} />
              </button>
              <button
                onClick={() => setTool('ROTATE')}
                className={`p-1.5 rounded ${
                  currentTool === 'ROTATE'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Rotate"
              >
                <RotateCw size={18} />
              </button>
              <button
                id="btn-tool-circular-array"
                onClick={() => setTool('CIRCULAR_ARRAY')}
                className={`p-1.5 rounded transition-colors ${
                  currentTool === 'CIRCULAR_ARRAY'
                    ? 'bg-neutral-800 text-purple-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Circular Array (環形陣列)"
              >
                <Orbit size={18} />
              </button>
              <button
                id="btn-tool-rectangular-array"
                onClick={() => setTool('RECT_ARRAY')}
                className={`p-1.5 rounded transition-colors ${
                  currentTool === 'RECT_ARRAY'
                    ? 'bg-neutral-800 text-blue-400'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Rectangular Array (矩形陣列)"
              >
                <LayoutGrid size={18} />
              </button>

              {currentTool === 'POLYGON' && (
                <div className="flex items-center gap-1.5 bg-neutral-900 border border-amber-500/40 px-2.5 py-0.5 rounded text-xs select-none shadow-lg">
                  <span className="text-amber-400 font-semibold">邊數:</span>
                  <input
                    type="number"
                    min={3}
                    max={1024}
                    value={polygonSides}
                    onChange={(e) => setPolygonSides(Number(e.target.value))}
                    className="w-14 px-1 py-0.5 bg-neutral-950 border border-neutral-700 rounded text-center text-amber-400 font-mono font-bold focus:outline-none focus:border-amber-500"
                  />
                  <div className="w-px h-4 bg-neutral-800 mx-1" />
                  <button
                    onClick={() => setPolygonMethod('inscribed')}
                    className={`px-2 py-0.5 rounded text-xs font-semibold transition-colors ${
                      polygonMethod === 'inscribed'
                        ? 'bg-amber-500 text-neutral-950 font-bold shadow-sm'
                        : 'bg-neutral-800 text-neutral-400 hover:text-white'
                    }`}
                    title="內接於圓 (Inscribed)"
                  >
                    內接於圓
                  </button>
                  <button
                    onClick={() => setPolygonMethod('circumscribed')}
                    className={`px-2 py-0.5 rounded text-xs font-semibold transition-colors ${
                      polygonMethod === 'circumscribed'
                        ? 'bg-amber-500 text-neutral-950 font-bold shadow-sm'
                        : 'bg-neutral-800 text-neutral-400 hover:text-white'
                    }`}
                    title="外切於圓 (Circumscribed)"
                  >
                    外切於圓
                  </button>
                </div>
              )}

              <div className="w-px h-5 bg-neutral-800 mx-1" />

              <div className="flex items-center gap-0.5">
                <button
                  onClick={toggleOsnap}
                  className={`p-1.5 rounded transition-colors ${
                    osnapEnabled
                      ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/50'
                      : 'text-neutral-400 hover:text-white'
                  }`}
                  title="Object Snap [F3]"
                >
                  <Magnet size={18} />
                </button>
                <button
                  onClick={() => setOsnapModalOpen(true)}
                  className="p-1 text-[10px] text-neutral-400 hover:text-white hover:bg-neutral-800 rounded transition-colors shrink-0"
                  title="Osnap Settings"
                >
                  ▼
                </button>
              </div>

              <button
                onClick={toggleOrtho}
                className={`p-1.5 rounded transition-colors ${
                  orthoEnabled
                    ? 'bg-cyan-950/80 text-cyan-400 border border-cyan-800/50'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Ortho Mode [F8]"
              >
                <Move size={18} />
              </button>

              {/* Constraints toolbar & Entity operations (appears when entity is selected) */}
              {totalSelectedCount > 0 && (
                <>
                  <div className="w-px h-5 bg-neutral-800 mx-1" />

                  {/* 水平 / 垂直 (Horizontal / Vertical) */}
                  {canApplyHorizontalVertical && (
                    <>
                      <button
                        onClick={handleAddHorizontal}
                        className="p-1.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                        title="水平 (Horizontal)"
                      >
                        <MoveHorizontal size={18} />
                      </button>
                      <button
                        onClick={handleAddVertical}
                        className="p-1.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                        title="垂直 (Vertical)"
                      >
                        <MoveVertical size={18} />
                      </button>
                    </>
                  )}

                  {/* 重合 / 同心 (Coincident / Concentric) */}
                  {canApplyCoincident && (
                    <button
                      onClick={handleAddCoincident}
                      className="p-1.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                      title="重合/同心 (Coincident)"
                    >
                      <CircleDot size={18} />
                    </button>
                  )}

                  {/* 固定約束 (Fix) */}
                  {canApplyFix && (
                    <button
                      onClick={handleAddFix}
                      className="p-1.5 rounded text-neutral-400 hover:text-yellow-400 hover:bg-neutral-800 transition-colors"
                      title="固定 (Fix) 錨定點"
                    >
                      <Lock size={18} />
                    </button>
                  )}

                  {/* 平行 / 垂直 / 等長 (Parallel / Perpendicular / Equal Length) */}
                  {isBothLines && (
                    <>
                      <button
                        onClick={handleAddParallel}
                        className="p-1.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                        title="平行 (Parallel)"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="6" y1="20" x2="14" y2="4" />
                          <line x1="10" y1="20" x2="18" y2="4" />
                        </svg>
                      </button>
                      <button
                        onClick={handleAddPerpendicular}
                        className="p-1.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                        title="垂直 (Perpendicular)"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="12" y1="4" x2="12" y2="20" />
                          <line x1="4" y1="20" x2="20" y2="20" />
                          <path d="M 12 16 L 16 16 L 16 20" strokeWidth="1.5" />
                        </svg>
                      </button>
                      <button
                        onClick={handleAddEqualLength}
                        className="p-1.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                        title="等長 (Equal Length)"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <line x1="6" y1="10" x2="18" y2="10" />
                          <line x1="6" y1="14" x2="18" y2="14" />
                        </svg>
                      </button>
                    </>
                  )}

                  {/* 相切 (Tangent) */}
                  {canApplyTangent && (
                    <button
                      onClick={handleAddTangent}
                      className="p-1.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                      title="相切 (Tangent)"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="10" cy="14" r="6" />
                        <line x1="2" y1="8" x2="18" y2="8" />
                      </svg>
                    </button>
                  )}

                  {/* 等半徑 (Equal Radius) */}
                  {canApplyEqualRadius && (
                    <button
                      onClick={handleAddEqualRadius}
                      className="p-1.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                      title="等半徑 (Equal Radius)"
                    >
                      <Disc size={18} />
                    </button>
                  )}

                  {/* 切換建構線 (Toggle Construction) */}
                  {realSelectedEntities.length > 0 && (
                    <button
                      onClick={handleToggleConstruction}
                      className={`p-1.5 rounded transition-colors ${
                        isAnySelectedConstruction
                          ? 'bg-purple-950/80 text-purple-400 border border-purple-800/50'
                          : 'text-neutral-400 hover:text-purple-400 hover:bg-neutral-800'
                      }`}
                      title="切換建構線 (Toggle Construction) [X]"
                    >
                      <Spline size={18} />
                    </button>
                  )}
                </>
              )}
            </div>

            <div className="w-px h-6 bg-neutral-800 mx-1 shrink-0" />

            {/* Layer Control Bar */}
            <LayerControlBar />
          </div>

          {/* 右側：Undo/Redo、求解器狀態標籤、DXF匯入匯出、STEP/STL、2D/3D切換鈕 */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-2">
              <button
                onClick={undo}
                disabled={!canUndo()}
                className="p-1.5 rounded text-neutral-400 hover:text-white disabled:opacity-30 disabled:hover:text-neutral-400"
                title="Undo (Ctrl+Z)"
              >
                <Undo2 size={18} />
              </button>
              <button
                onClick={redo}
                disabled={!canRedo()}
                className="p-1.5 rounded text-neutral-400 hover:text-white disabled:opacity-30 disabled:hover:text-neutral-400"
                title="Redo (Ctrl+Y)"
              >
                <Redo2 size={18} />
              </button>
            </div>

            <div className="h-6 w-px bg-neutral-800 mx-1" />

            {/* Solver State Badge */}
            <div
              className={`px-2.5 py-1 rounded text-xs font-semibold tracking-wider border ${
                solverState === 'FullyDefined'
                  ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800/50'
                  : solverState === 'OverDefined'
                  ? 'bg-red-950/80 text-red-400 border-red-800/50'
                  : 'bg-blue-950/80 text-blue-400 border-blue-800/50'
              }`}
            >
              [{solverState}]
            </div>

            {/* Import DXF Button */}
            <button
              onClick={handleImportClick}
              className="bg-neutral-800 hover:bg-neutral-700 text-neutral-200 hover:text-white px-3 py-1 rounded text-xs font-semibold border border-neutral-700 transition-colors shadow-sm flex items-center gap-1.5"
              title="Import DXF Drawing"
            >
              <FileUp size={15} className="text-emerald-400" />
              <span>Import DXF</span>
            </button>

            {/* Export DXF Button */}
            <button
              onClick={handleExportDxf}
              className="bg-neutral-800 hover:bg-neutral-700 text-neutral-200 hover:text-white px-3 py-1 rounded text-xs font-semibold border border-neutral-700 transition-colors shadow-sm flex items-center gap-1.5"
              title="Export DXF Drawing"
            >
              <FileDown size={15} className="text-blue-400" />
              <span>Export DXF</span>
            </button>

            {viewMode === '3D' && (
              <>
                <button
                  type="button"
                  disabled={exportingFormat !== null}
                  onClick={handleExportSTEP}
                  className="bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-neutral-200 hover:text-white px-3 py-1 rounded text-xs font-semibold border border-neutral-700 transition-colors shadow-sm flex items-center gap-1.5 cursor-pointer"
                  title="Export STEP Model"
                  id="app-btn-export-step"
                >
                  {exportingFormat === 'STEP' ? (
                    <>
                      <Loader2 size={15} className="animate-spin text-purple-300" />
                      <span>正在生成 STEP 檔案...</span>
                    </>
                  ) : (
                    <>
                      <FileDown size={15} className="text-purple-400" />
                      <span>Export STEP</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  disabled={exportingFormat !== null}
                  onClick={handleExportSTL}
                  className="bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-neutral-200 hover:text-white px-3 py-1 rounded text-xs font-semibold border border-neutral-700 transition-colors shadow-sm flex items-center gap-1.5 cursor-pointer"
                  title="Export STL Mesh"
                  id="app-btn-export-stl"
                >
                  {exportingFormat === 'STL' ? (
                    <>
                      <Loader2 size={15} className="animate-spin text-pink-300" />
                      <span>正在生成 STL 檔案...</span>
                    </>
                  ) : (
                    <>
                      <FileDown size={15} className="text-pink-400" />
                      <span>Export STL</span>
                    </>
                  )}
                </button>
              </>
            )}

            {/* Toggle Profiles Button */}
            <button
              onClick={toggleShowProfiles}
              className={`px-3 py-1 rounded text-xs font-semibold border transition-colors shadow-sm flex items-center gap-1.5 ${
                showProfiles
                  ? 'bg-neutral-800 hover:bg-neutral-700 text-sky-400 border-sky-600/50'
                  : 'bg-neutral-900 hover:bg-neutral-800 text-neutral-500 border-neutral-800'
              }`}
              title="Toggle Profiles Fill (切換草圖輪廓填色)"
            >
              <Layers size={15} className={showProfiles ? 'text-sky-400' : 'text-neutral-500'} />
              <span>Toggle Profiles</span>
            </button>

            {/* Toggle 3D Edges Button */}
            {viewMode === '3D' && (
              <button
                onClick={toggleShow3DEdges}
                className={`px-3 py-1 rounded text-xs font-semibold border transition-colors shadow-sm flex items-center gap-1.5 ${
                  show3DEdges
                    ? 'bg-neutral-800 hover:bg-neutral-700 text-indigo-400 border-indigo-600/50'
                    : 'bg-neutral-900 hover:bg-neutral-800 text-neutral-500 border-neutral-800'
                }`}
                title="3D 實體模型特徵邊線 (Toggle 3D Model Edges)"
              >
                <BoxSelect size={15} className={show3DEdges ? 'text-indigo-400' : 'text-neutral-500'} />
                <span>3D 邊線: {show3DEdges ? 'ON' : 'OFF'}</span>
              </button>
            )}

            {/* 當處於 2D 編輯模式且有 activeSketch 時，顯示當前草圖狀態與返回 3D 按鈕 */}
            {viewMode === '2D' && activeSketch && (
              <div className="flex items-center gap-2 bg-amber-950/80 border border-amber-500/70 px-2.5 py-1 rounded text-xs text-amber-200 shadow-sm">
                <Pencil size={12} className="text-amber-400" />
                <span>草圖: <span className="font-semibold text-white">{activeSketch.name}</span></span>
                <button
                  onClick={() => setViewMode('3D')}
                  className="ml-1.5 px-2 py-0.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded text-[11px] transition-colors shadow cursor-pointer active:scale-95"
                  title="完成草圖繪製並返回 3D 視角"
                >
                  完成並返回 3D
                </button>
              </div>
            )}

            {/* 2D/3D Toggle Button */}
            <button
              onClick={() => useCADStore.getState().setViewMode(viewMode === '2D' ? '3D' : '2D')}
              className={`px-3 py-1 rounded text-xs font-semibold border transition-colors shadow-sm flex items-center gap-1.5 ${
                viewMode === '3D'
                  ? 'bg-blue-600 hover:bg-blue-500 text-white border-blue-500'
                  : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border-neutral-700'
              }`}
              title="Toggle 2D/3D View"
            >
              {viewMode === '2D' ? 'Switch to 3D' : 'Switch to 2D'}
            </button>

            <div className="flex items-center bg-neutral-900 px-3 py-1 rounded text-sm font-mono border border-neutral-800 text-neutral-300">
              <Maximize size={14} className="mr-2" />
              {viewMode} Mode
            </div>

            {/* 縮放至全圖按鈕 (支援點擊或雙擊滑鼠中鍵) */}
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('cad-zoom-to-fit'))}
              className="flex items-center gap-1.5 px-2.5 py-1 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 border border-neutral-700 hover:border-amber-500/80 rounded text-xs font-semibold transition-all shadow-sm cursor-pointer group active:scale-95"
              title="縮放至全圖範圍 (提示: 於 2D 或 3D 視窗雙擊滑鼠中鍵 / Zoom to Fit)"
            >
              <Maximize size={13} className="text-amber-400 group-hover:scale-110 transition-transform" />
              <span>全圖置中</span>
              <span className="text-[10px] text-neutral-400 font-mono hidden sm:inline">(中鍵雙擊)</span>
            </button>
          </div>
        </div>

        {/* 第二排：3D 實體特徵工具列（全新建立獨立一排，純圖示縮圖） */}
        <div className="flex items-center gap-1 w-full overflow-x-auto">
          <div className="flex items-center gap-1 py-1 px-1 bg-neutral-900/60 rounded border border-neutral-800/80 w-fit shrink-0">
            <span className="text-[11px] font-semibold text-neutral-400 px-2 font-mono select-none">
              3D FEATURES:
            </span>

            {/* 長料/除料特徵群組 */}
            <button
              onClick={() => setExtrudeModalConfig({ isOpen: true, mode: 'EXTRUDE' })}
              className="p-1.5 rounded transition-colors text-neutral-400 hover:text-blue-400 hover:bg-neutral-800"
              title="伸長長料 (Extrude Boss)"
            >
              <Box size={18} />
            </button>
            <button
              onClick={() => setExtrudeModalConfig({ isOpen: true, mode: 'CUT_EXTRUDE' })}
              className="p-1.5 rounded transition-colors text-neutral-400 hover:text-amber-400 hover:bg-neutral-800"
              title="伸長除料 (Extrude Cut)"
            >
              <Scissors size={18} />
            </button>

            {/* 直立細分隔線 */}
            <div className="w-px h-4 bg-neutral-800 mx-1" />

            {/* 旋轉特徵群組 */}
            <button
              onClick={() => setRevolveModalConfig({ isOpen: true, mode: 'REVOLVE' })}
              className="p-1.5 rounded transition-colors text-neutral-400 hover:text-purple-400 hover:bg-neutral-800"
              title="旋轉長料 (Revolve Boss)"
            >
              <RotateCw size={18} />
            </button>
            <button
              onClick={() => setRevolveModalConfig({ isOpen: true, mode: 'REVOLVE_CUT' })}
              className="p-1.5 rounded transition-colors text-neutral-400 hover:text-rose-400 hover:bg-neutral-800"
              title="旋轉除料 (Revolve Cut)"
            >
              <RotateCcw size={18} />
            </button>

            {/* 直立細分隔線 */}
            <div className="w-px h-4 bg-neutral-800 mx-1" />

            {/* 多草圖成形群組 */}
            <button
              onClick={() => setSweepLoftModalConfig({ isOpen: true, mode: 'SWEEP' })}
              className="p-1.5 rounded transition-colors text-neutral-400 hover:text-teal-400 hover:bg-neutral-800"
              title="掃出 (Sweep Boss)"
            >
              <Route size={18} />
            </button>
            <button
              onClick={() => setSweepLoftModalConfig({ isOpen: true, mode: 'LOFT' })}
              className="p-1.5 rounded transition-colors text-neutral-400 hover:text-violet-400 hover:bg-neutral-800"
              title="疊層拉伸 (Loft Boss)"
            >
              <Layers size={18} />
            </button>

            {/* 直立細分隔線 */}
            <div className="w-px h-4 bg-neutral-800 mx-1" />

            {/* 陣列與鏡射群組 */}
            <button
              onClick={() => setPatternModalConfig({ isOpen: true, mode: 'LINEAR_PATTERN' })}
              className="p-1.5 rounded transition-colors text-neutral-400 hover:text-sky-400 hover:bg-neutral-800"
              title="線性陣列 (Linear Pattern)"
            >
              <LayoutGrid size={18} />
            </button>
            <button
              onClick={() => setPatternModalConfig({ isOpen: true, mode: 'CIRCULAR_PATTERN' })}
              className="p-1.5 rounded transition-colors text-neutral-400 hover:text-indigo-400 hover:bg-neutral-800"
              title="環狀陣列 (Circular Pattern)"
            >
              <Orbit size={18} />
            </button>
            <button
              onClick={() => setPatternModalConfig({ isOpen: true, mode: 'MIRROR_3D' })}
              className="p-1.5 rounded transition-colors text-neutral-400 hover:text-emerald-400 hover:bg-neutral-800"
              title="3D 鏡射 (3D Mirror)"
            >
              <FlipHorizontal size={18} />
            </button>

            {/* 若當前在 3D 選取了模型面，在此處顯著顯示「在此面建立草圖」按鈕 */}
            {selectedFaceInfo && (
              <>
                <div className="w-px h-4 bg-neutral-700 mx-1" />
                <div className="flex items-center gap-1.5 pl-1">
                  <button
                    id="btn-toolbar-create-sketch-on-face"
                    onClick={() => {
                      const newPlane = createPlaneFromFaceNormal(
                        selectedFaceInfo.point,
                        selectedFaceInfo.normal
                      );
                      createSketchOnFacePlane(newPlane);
                      setSelectedFaceInfo(null);
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded transition-colors shadow cursor-pointer active:scale-95"
                    title="在目前選取的模型面上建立 2D 草圖"
                  >
                    <Pencil size={13} className="stroke-[2.5]" />
                    <span>在此面建立草圖</span>
                  </button>
                  <button
                    onClick={() => setSelectedFaceInfo(null)}
                    className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-800"
                    title="取消選取面"
                  >
                    ✕
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="flex-1 relative flex overflow-hidden">
        {/* 左側 SolidWorks 特徵樹面板 */}
        <FeatureTreePanel />

        {/* 右側繪圖與 3D 視圖區域 */}
        <div className="flex-1 relative overflow-hidden">
          {solverState === 'OverDefined' && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-30 bg-red-950/95 border-2 border-red-500 text-red-100 px-5 py-3 rounded-md shadow-2xl flex items-center gap-3 animate-pulse pointer-events-none">
              <AlertTriangle className="text-red-500 shrink-0" size={20} />
              <div>
                <span className="font-bold block text-sm">草圖過度定義 (Over-defined)</span>
                <span className="text-xs text-red-300">偵測到衝突的幾何約束或尺寸標註，請刪除衝突約束以恢復求解。</span>
              </div>
            </div>
          )}

          {/* 匯入 DXF 成功訊息浮條 */}
          {importToast && (
            <div className="absolute top-4 right-4 z-40 bg-emerald-950/95 border border-emerald-500/60 text-emerald-100 px-4 py-3 rounded-lg shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-200">
              <CheckCircle2 className="text-emerald-400 shrink-0" size={22} />
              <div>
                <span className="font-bold block text-sm text-emerald-300">
                  DXF 匯入成功
                </span>
                <span className="text-xs text-emerald-200/90 block">
                  已載入 {importToast.entityCount} 個圖元 (單位: {importToast.units})
                  {importToast.mergedPointsCount !== undefined && importToast.mergedPointsCount > 0 ? (
                    <span className="ml-1 text-emerald-400">
                      • 縫合 {importToast.mergedPointsCount} 個端點
                    </span>
                  ) : null}
                  {importToast.removedEntitiesCount !== undefined && importToast.removedEntitiesCount > 0 ? (
                    <span className="ml-1 text-emerald-400">
                      • 移除 {importToast.removedEntitiesCount} 個無效圖元
                    </span>
                  ) : null}
                </span>
              </div>
            </div>
          )}

          {/* 獨立全螢幕拖曳上傳 Overlay 遮罩 */}
          {isDraggingOver && (
            <div className="fixed inset-0 z-[9999] bg-neutral-950/80 backdrop-blur-sm border-4 border-dashed border-emerald-500 rounded-lg flex flex-col items-center justify-center text-emerald-400 transition-all duration-200 pointer-events-none">
              <FileUp size={64} className="mb-4 animate-bounce text-emerald-400" />
              <span className="text-xl font-bold tracking-wide">放開滑鼠以匯入 DXF 圖面</span>
              <span className="text-sm text-emerald-500/80 mt-1">支援標準 2D DXF 檔案拖放匯入</span>
            </div>
          )}

          <div
            className="absolute inset-0 w-full h-full"
            style={
              viewMode === '3D'
                ? { opacity: 0.1, pointerEvents: 'none', zIndex: 1 }
                : { opacity: 1, zIndex: 10 }
            }
          >
            <CADSketchCanvas />
          </div>

          {viewMode === '3D' && (
            <div className="absolute inset-0 w-full h-full z-10">
              <React.Suspense
                fallback={
                  <div className="w-full h-full flex items-center justify-center bg-slate-900 text-sky-400 font-mono text-xs">
                    載入 3D 視圖與 CAD 運算核心中...
                  </div>
                }
              >
                <CAD3DCanvas />
              </React.Suspense>
            </div>
          )}
        </div>
      </main>

      {/* 輔助與特徵彈窗群 */}
      <OsnapSettingsModal />
      <PolarSettingsModal />
      <LayerManagerModal />
      <ExtrudeFeatureModal
        isOpen={extrudeModalConfig.isOpen}
        mode={extrudeModalConfig.mode}
        onClose={() => setExtrudeModalConfig((prev) => ({ ...prev, isOpen: false }))}
      />
      <RevolveFeatureModal
        isOpen={revolveModalConfig.isOpen}
        mode={revolveModalConfig.mode}
        onClose={() => setRevolveModalConfig((prev) => ({ ...prev, isOpen: false }))}
      />
      <PatternMirrorModal
        isOpen={patternModalConfig.isOpen}
        mode={patternModalConfig.mode}
        onClose={() => setPatternModalConfig((prev) => ({ ...prev, isOpen: false }))}
      />
      <SweepLoftModal
        isOpen={sweepLoftModalConfig.isOpen}
        mode={sweepLoftModalConfig.mode}
        onClose={() => setSweepLoftModalConfig((prev) => ({ ...prev, isOpen: false }))}
      />
    </div>
  );
}
