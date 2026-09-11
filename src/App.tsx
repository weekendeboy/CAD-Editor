/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useCADStore } from './store/cadStore';
import { useCadShortcuts } from './hooks/useCadShortcuts';
import { CADSketchCanvas } from './components/CADSketchCanvas';
import { SketchFeature } from './types/cad';
import { OsnapSettingsModal } from './components/OsnapSettingsModal';
import { PolarSettingsModal } from './components/PolarSettingsModal';
import { exportSketchToDxf, downloadDxfFile } from './core/dxf/DxfWriter';
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
  Orbit,
  LayoutGrid,
  SquareSlash,
  Hexagon,
  FileDown,
} from 'lucide-react';

export default function App() {
  // 啟用全域快速鍵
  useCadShortcuts();

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
  } = useCADStore();

  // 取得當前草圖與求解器狀態
  const activeSketch = document.featureTree.find(
    (f) => f.id === activeSketchId && f.type === 'SKETCH'
  ) as SketchFeature | undefined;

  const solverState = activeSketch?.solverState || 'UnderDefined';
  const hasSelectedEntities = selectedEntityIds.length > 0;
  const isSingleSelected = selectedEntityIds.length === 1;
  const isDoubleSelected = selectedEntityIds.length === 2;
  const selectedId = selectedEntityIds[0];
  const selectedEntities =
    activeSketch?.entities.filter((e) => selectedEntityIds.includes(e.id)) || [];
  const isAnySelectedConstruction = selectedEntities.some((e) => e.isConstruction);

  const isBothLines =
    isDoubleSelected &&
    selectedEntities.length === 2 &&
    selectedEntities.every((e) => e.type === 'line');

  const isTangentApplicable =
    isDoubleSelected &&
    selectedEntities.length === 2 &&
    (() => {
      const t1 = selectedEntities[0].type;
      const t2 = selectedEntities[1].type;
      const isLine1 = t1 === 'line';
      const isLine2 = t2 === 'line';
      const isArcOrCircle1 = t1 === 'arc' || t1 === 'circle';
      const isArcOrCircle2 = t2 === 'arc' || t2 === 'circle';

      return (
        (isLine1 && isArcOrCircle2) ||
        (isArcOrCircle1 && isLine2) ||
        (isArcOrCircle1 && isArcOrCircle2)
      );
    })();

  const handleToggleConstruction = () => {
    selectedEntityIds.forEach((id) => toggleConstruction(id));
  };

  const handleAddHorizontal = () => {
    if (!selectedId) return;
    addConstraint({
      id: crypto.randomUUID(),
      type: 'horizontal',
      entityIds: [selectedId],
    });
  };

  const handleAddVertical = () => {
    if (!selectedId) return;
    addConstraint({
      id: crypto.randomUUID(),
      type: 'vertical',
      entityIds: [selectedId],
    });
  };

  const handleAddFix = () => {
    if (!selectedId) return;
    addConstraint({
      id: crypto.randomUUID(),
      type: 'fix',
      entityIds: [selectedId],
      pointIndices: [0], // 鎖定起點或中心點
    });
  };

  const handleAddParallel = () => {
    if (selectedEntityIds.length !== 2) return;
    addConstraint({
      id: crypto.randomUUID(),
      type: 'parallel',
      entityIds: [...selectedEntityIds],
    });
  };

  const handleAddPerpendicular = () => {
    if (selectedEntityIds.length !== 2) return;
    addConstraint({
      id: crypto.randomUUID(),
      type: 'perpendicular',
      entityIds: [...selectedEntityIds],
    });
  };

  const handleAddEqualLength = () => {
    if (selectedEntityIds.length !== 2) return;
    addConstraint({
      id: crypto.randomUUID(),
      type: 'equal_length',
      entityIds: [...selectedEntityIds],
    });
  };

  const handleAddTangent = () => {
    if (selectedEntityIds.length !== 2) return;
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

  return (
    <div className="w-full h-screen flex flex-col bg-neutral-900 text-white overflow-hidden">
      {/* Top Toolbar */}
      <header className="h-14 border-b border-neutral-800 bg-neutral-950 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2">
          <div className="font-bold text-lg mr-4">AI Studio CAD</div>

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
              title="Circle (C)"
            >
              <Circle size={18} />
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
            {hasSelectedEntities && (
              <>
                <div className="w-px h-5 bg-neutral-800 mx-1" />
                {isSingleSelected && (
                  <>
                    <button
                      onClick={handleAddHorizontal}
                      className="p-1.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                      title="Add Horizontal Constraint"
                    >
                      <MoveHorizontal size={18} />
                    </button>
                    <button
                      onClick={handleAddVertical}
                      className="p-1.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                      title="Add Vertical Constraint"
                    >
                      <MoveVertical size={18} />
                    </button>
                    <button
                      onClick={handleAddFix}
                      className="p-1.5 rounded text-neutral-400 hover:text-yellow-400 hover:bg-neutral-800 transition-colors"
                      title="Add Fix Point Constraint (Lock Anchor)"
                    >
                      <Lock size={18} />
                    </button>
                  </>
                )}
                {isDoubleSelected && (
                  <>
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
                    {isTangentApplicable && (
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
                  </>
                )}
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
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
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

          <div className="h-6 w-px bg-neutral-800 mx-1"></div>

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

          {/* Export DXF Button */}
          <button
            onClick={handleExportDxf}
            className="bg-neutral-800 hover:bg-neutral-700 text-neutral-200 hover:text-white px-3 py-1 rounded text-xs font-semibold border border-neutral-700 transition-colors shadow-sm flex items-center gap-1.5"
            title="Export DXF Drawing"
          >
            <FileDown size={15} className="text-blue-400" />
            <span>Export DXF</span>
          </button>

          <div className="flex items-center bg-neutral-900 px-3 py-1 rounded text-sm font-mono border border-neutral-800 text-neutral-300">
            <Maximize size={14} className="mr-2" />
            {viewMode} Mode
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="flex-1 relative">
        {solverState === 'OverDefined' && (
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-30 bg-red-950/95 border-2 border-red-500 text-red-100 px-5 py-3 rounded-md shadow-2xl flex items-center gap-3 animate-pulse">
            <AlertTriangle className="text-red-500 shrink-0" size={20} />
            <div>
              <span className="font-bold block text-sm">草圖過度定義 (Over-defined)</span>
              <span className="text-xs text-red-300">偵測到衝突的幾何約束或尺寸標註，請刪除衝突約束以恢復求解。</span>
            </div>
          </div>
        )}
        <CADSketchCanvas />
      </main>
      <OsnapSettingsModal />
      <PolarSettingsModal />
    </div>
  );
}

