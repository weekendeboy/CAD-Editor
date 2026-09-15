import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useCADStore } from '../store/cadStore';
import { FeatureTreeItem } from './FeatureTreeItem';
import {
  ChevronLeft,
  ChevronRight,
  Box,
  SquareStack,
  Crosshair,
  GripHorizontal,
  Folder,
  Layers,
  RotateCcw,
  Info,
  Pencil,
} from 'lucide-react';

export const FeatureTreePanel: React.FC = () => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isDraggingRollback, setIsDraggingRollback] = useState(false);
  const [selectedPlaneId, setSelectedPlaneId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const {
    document,
    selectedFeatureId,
    setSelectedFeatureId,
    toggleFeatureSuppression,
    renameFeature,
    removeFeature,
    updateFeature,
    setRollbackIndex,
    createSketchOnPlane,
    activeSketchId,
    setActiveSketch,
    setViewMode,
  } = useCADStore();

  const featureTree = document?.featureTree || [];
  const rollbackIndex =
    typeof document?.rollbackIndex === 'number'
      ? Math.max(0, Math.min(document.rollbackIndex, featureTree.length))
      : featureTree.length;

  // 計算滑鼠位置對應的回退棒索引 Slot Index
  const calculateSlotIndexFromY = useCallback(
    (clientY: number): number => {
      if (!listRef.current) return featureTree.length;

      const itemElements = Array.from(
        listRef.current.querySelectorAll('[data-feature-index]')
      ) as HTMLElement[];

      if (itemElements.length === 0) return 0;

      for (let i = 0; i < itemElements.length; i++) {
        const rect = itemElements[i].getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (clientY < midY) {
          return i;
        }
      }

      return itemElements.length;
    },
    [featureTree.length]
  );

  // 回退棒滑鼠拖曳處理機制
  const handleMouseDownRollback = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingRollback(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const newIndex = calculateSlotIndexFromY(moveEvent.clientY);
      setRollbackIndex(newIndex);
    };

    const handleMouseUp = () => {
      setIsDraggingRollback(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // 點擊特徵間隙 Slot 直接瞬移回退棒
  const handleSlotClick = (slotIndex: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setRollbackIndex(slotIndex);
  };

  // 可見度切換 Helper
  const handleToggleVisibility = (id: string) => {
    const target = featureTree.find((f) => f.id === id);
    if (target) {
      updateFeature(id, { visible: target.visible === false });
    }
  };

  // 若收合狀態，僅顯示折疊後的小側邊欄
  if (isCollapsed) {
    return (
      <div className="w-10 h-full bg-neutral-950 border-r border-neutral-800 flex flex-col items-center py-3 text-neutral-400 select-none shrink-0 z-20">
        <button
          onClick={() => setIsCollapsed(false)}
          className="p-2 hover:bg-neutral-800 hover:text-white rounded-md transition-colors"
          title="展開 FeatureManager Design Tree"
        >
          <ChevronRight className="w-5 h-5 text-amber-400" />
        </button>
        <div className="mt-6 flex flex-col items-center gap-4 text-xs">
          <span
            className="[writing-mode:vertical-lr] rotate-180 tracking-wider font-mono font-semibold text-neutral-400 uppercase text-[11px]"
          >
            Feature Tree
          </span>
          <Box className="w-4 h-4 text-amber-400/80" />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`w-[260px] h-full bg-neutral-950 border-r border-neutral-800 flex flex-col select-none text-neutral-200 shrink-0 z-20 transition-all duration-150 ${
        isDraggingRollback ? 'cursor-ns-resize' : ''
      }`}
    >
      {/* 頂部標題列 */}
      <div className="h-9 px-3 bg-neutral-900/90 border-b border-neutral-800 flex items-center justify-between shrink-0 font-sans">
        <div className="flex items-center gap-2 min-w-0">
          <Folder className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="text-xs font-semibold tracking-wide truncate text-neutral-200">
            FeatureManager Design Tree
          </span>
        </div>
        <button
          onClick={() => setIsCollapsed(true)}
          className="p-1 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded transition-colors"
          title="收合特徵樹"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>

      {/* 特徵樹內容區域 */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-2 space-y-1 font-mono text-xs custom-scrollbar">
        {/* 文件根節點 */}
        <div
          onClick={() => {
            setSelectedFeatureId(null);
            setSelectedPlaneId(null);
          }}
          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
            !selectedFeatureId && !selectedPlaneId
              ? 'bg-neutral-800 text-white font-semibold'
              : 'hover:bg-neutral-900 text-neutral-300'
          }`}
        >
          <Box className="w-4 h-4 text-sky-400 shrink-0" />
          <span className="truncate">{document?.title || 'Part1'}</span>
        </div>

        {/* 材質條目 (Material) */}
        <div className="flex items-center gap-2 px-2 py-1 text-neutral-400 hover:bg-neutral-900/60 rounded cursor-default text-[11px] ml-1">
          <Layers className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
          <span className="truncate italic">材質 (未指定)</span>
        </div>

        {/* 基準面常駐清單 (Planes & Origin) */}
        <div className="my-1 border-y border-neutral-900 py-1 space-y-0.5">
          {/* Front Plane */}
          <div
            onClick={() => {
              setSelectedPlaneId('datum-front');
              setSelectedFeatureId(null);
            }}
            className={`group flex items-center justify-between px-2 py-1 rounded cursor-pointer transition-colors ${
              selectedPlaneId === 'datum-front'
                ? 'bg-sky-950/80 text-sky-300 border border-sky-800/60'
                : 'hover:bg-neutral-900 text-neutral-300'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <SquareStack className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate text-xs">Front Plane (前基準面)</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                createSketchOnPlane('datum-front');
              }}
              className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-neutral-700 hover:text-white text-neutral-400 transition-all shrink-0"
              title="在此平面繪製草圖"
            >
              <Pencil className="w-3 h-3" />
            </button>
          </div>

          {/* Top Plane */}
          <div
            onClick={() => {
              setSelectedPlaneId('datum-top');
              setSelectedFeatureId(null);
            }}
            className={`group flex items-center justify-between px-2 py-1 rounded cursor-pointer transition-colors ${
              selectedPlaneId === 'datum-top'
                ? 'bg-sky-950/80 text-sky-300 border border-sky-800/60'
                : 'hover:bg-neutral-900 text-neutral-300'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <SquareStack className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate text-xs">Top Plane (上基準面)</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                createSketchOnPlane('datum-top');
              }}
              className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-neutral-700 hover:text-white text-neutral-400 transition-all shrink-0"
              title="在此平面繪製草圖"
            >
              <Pencil className="w-3 h-3" />
            </button>
          </div>

          {/* Right Plane */}
          <div
            onClick={() => {
              setSelectedPlaneId('datum-right');
              setSelectedFeatureId(null);
            }}
            className={`group flex items-center justify-between px-2 py-1 rounded cursor-pointer transition-colors ${
              selectedPlaneId === 'datum-right'
                ? 'bg-sky-950/80 text-sky-300 border border-sky-800/60'
                : 'hover:bg-neutral-900 text-neutral-300'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <SquareStack className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate text-xs">Right Plane (右基準面)</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                createSketchOnPlane('datum-right');
              }}
              className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-neutral-700 hover:text-white text-neutral-400 transition-all shrink-0"
              title="在此平面繪製草圖"
            >
              <Pencil className="w-3 h-3" />
            </button>
          </div>

          {/* Origin */}
          <div
            onClick={() => {
              setSelectedPlaneId('origin');
              setSelectedFeatureId(null);
            }}
            className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer transition-colors ${
              selectedPlaneId === 'origin'
                ? 'bg-sky-950/80 text-sky-300 border border-sky-800/60'
                : 'hover:bg-neutral-900 text-neutral-300'
            }`}
          >
            <Crosshair className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="truncate text-xs">Origin (原點)</span>
          </div>
        </div>

        {/* 特徵清單區域與回退棒 */}
        <div ref={listRef} className="relative pt-1 space-y-0.5">
          {featureTree.length === 0 ? (
            <div className="py-4 text-center text-neutral-500 text-[11px]">
              尚無特徵，點擊工具列建立草圖或特徵
            </div>
          ) : null}

          {/* 遍歷特徵樹項目 */}
          {featureTree.map((feature, idx) => {
            const isPast = idx >= rollbackIndex;
            const showRollbackHere = idx === rollbackIndex;

            return (
              <React.Fragment key={feature.id}>
                {/* 若回退棒部位於此特徵上方 */}
                {showRollbackHere && (
                  <RollbackBar
                    isDragging={isDraggingRollback}
                    onMouseDown={handleMouseDownRollback}
                  />
                )}

                {/* 特徵間隙點擊區 */}
                <div
                  onClick={(e) => handleSlotClick(idx, e)}
                  className="h-1 -my-0.5 group cursor-pointer relative z-10"
                  title={`移至此位置 (Rollback to index ${idx})`}
                >
                  <div className="h-full group-hover:bg-amber-400/40 rounded transition-colors" />
                </div>

                {/* 渲染 FeatureTreeItem */}
                <div data-feature-index={idx} className="relative group/tree-item">
                  <FeatureTreeItem
                    feature={feature}
                    isSelected={selectedFeatureId === feature.id}
                    isPastRollback={isPast}
                    onSelect={(id) => {
                      setSelectedPlaneId(null);
                      setSelectedFeatureId(id);
                    }}
                    onToggleSuppress={(id) => toggleFeatureSuppression(id)}
                    onToggleVisibility={(id) => handleToggleVisibility(id)}
                    onRename={(id, newName) => renameFeature(id, newName)}
                    onDelete={(id) => removeFeature(id)}
                  />
                  {feature.type === 'DATUM_PLANE' && !isPast && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        createSketchOnPlane(feature.id);
                      }}
                      className="absolute right-12 top-2 p-1 rounded opacity-0 group-hover/tree-item:opacity-100 hover:bg-neutral-700 hover:text-white text-neutral-400 transition-all z-10"
                      title="在此平面繪製草圖"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {feature.type === 'SKETCH' && !isPast && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveSketch(feature.id);
                        setViewMode('2D');
                      }}
                      className={`absolute right-12 top-2 p-1 rounded transition-all z-10 ${
                        activeSketchId === feature.id
                          ? 'opacity-100 text-amber-400'
                          : 'opacity-0 group-hover/tree-item:opacity-100 hover:bg-neutral-700 hover:text-white text-neutral-400'
                      }`}
                      title="編輯此草圖 (切換至 2D)"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </React.Fragment>
            );
          })}

          {/* 若回退棒部位於末端 */}
          {rollbackIndex === featureTree.length && (
            <RollbackBar
              isDragging={isDraggingRollback}
              onMouseDown={handleMouseDownRollback}
            />
          )}

          {/* 底部 Slot 觸發點 */}
          <div
            onClick={(e) => handleSlotClick(featureTree.length, e)}
            className="h-2 group cursor-pointer relative z-10 mt-1"
            title={`移至最底端 (Rollback to end)`}
          >
            <div className="h-full group-hover:bg-amber-400/40 rounded transition-colors" />
          </div>

          {/* 回退凍結區提示 (當有特徵位於回退棒下方時顯示) */}
          {rollbackIndex < featureTree.length && (
            <div className="mt-2 p-2 bg-amber-950/20 border border-dashed border-amber-500/40 rounded text-[11px] text-amber-300/80 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>回退凍結區：棒下方特徵暫停運算</span>
            </div>
          )}
        </div>
      </div>

      {/* 底部狀態列 / 快捷動作列 */}
      <div className="h-8 px-3 bg-neutral-900/60 border-t border-neutral-800 flex items-center justify-between text-[11px] text-neutral-400">
        <span className="truncate">
          {featureTree.length} 個特徵 ({rollbackIndex}/{featureTree.length} 生效)
        </span>
        {rollbackIndex < featureTree.length && (
          <button
            onClick={() => setRollbackIndex(featureTree.length)}
            className="flex items-center gap-1 text-amber-400 hover:text-amber-300 transition-colors font-semibold"
            title="復原至最底端"
          >
            <RotateCcw className="w-3 h-3" />
            <span>完全展開</span>
          </button>
        )}
      </div>
    </div>
  );
};

// 經典 SolidWorks 亮黃色可拖曳回退棒組件
interface RollbackBarProps {
  isDragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}

const RollbackBar: React.FC<RollbackBarProps> = ({ isDragging, onMouseDown }) => {
  return (
    <div
      onMouseDown={onMouseDown}
      className={`relative my-1 z-30 group cursor-ns-resize select-none transition-all ${
        isDragging ? 'scale-y-110' : ''
      }`}
      title="按住拖曳 SolidWorks 回退棒 (Rollback Bar)"
    >
      {/* 亮黃色主橫條 */}
      <div className="h-2.5 bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-400 rounded-sm shadow-[0_0_8px_rgba(251,191,36,0.5)] border border-amber-200/80 flex items-center justify-between px-1.5 transition-transform group-hover:scale-y-125">
        {/* 左側拖曳點 */}
        <GripHorizontal className="w-3.5 h-3.5 text-neutral-900/80" />

        {/* 中間標註文字 */}
        <span className="text-[9px] font-bold tracking-wider uppercase text-neutral-950 font-mono">
          Rollback Bar
        </span>

        {/* 右側拖曳點 */}
        <GripHorizontal className="w-3.5 h-3.5 text-neutral-900/80" />
      </div>

      {/* 橫條懸停高亮輔助線 */}
      <div className="absolute inset-x-0 -top-0.5 -bottom-0.5 bg-amber-400/20 opacity-0 group-hover:opacity-100 rounded pointer-events-none transition-opacity" />
    </div>
  );
};

export default FeatureTreePanel;
