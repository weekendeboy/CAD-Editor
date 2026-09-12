import React, { useState, useRef, useEffect } from 'react';
import { useCADStore } from '../store/cadStore';
import { SketchFeature } from '../types/cad';
import {
  Layers,
  ChevronDown,
  Lightbulb,
  LightbulbOff,
  Lock,
  Unlock,
  Check,
} from 'lucide-react';

export interface LayerControlBarProps {
  onOpenManager?: () => void;
}

export const LayerControlBar: React.FC<LayerControlBarProps> = ({ onOpenManager }) => {
  const {
    document,
    activeLayerId,
    setActiveLayer,
    toggleLayerVisibility,
    toggleLayerLock,
    setLayerModalOpen,
    activeSketchId,
    selectedEntityIds,
    updateEntities,
  } = useCADStore();

  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 取得當前作用中圖層物件（預設圖層 '0'）
  const layers = document.layers || {};
  const activeLayer = layers[activeLayerId] || layers['0'] || {
    id: '0',
    name: '0',
    color: '#FFFFFF',
    visible: true,
    locked: false,
    lineType: 'CONTINUOUS',
  };

  // 取得當前草圖
  const activeSketch = document.featureTree.find(
    (f) => f.id === activeSketchId && f.type === 'SKETCH'
  ) as SketchFeature | undefined;

  const hasSelection = selectedEntityIds.length > 0;

  // 點擊外部自動收合下拉選單
  useEffect(() => {
    if (!isOpen) return;

    const handleOutsideClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    window.addEventListener('mousedown', handleOutsideClick);
    return () => {
      window.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isOpen]);

  // 切換圖層處理函式：
  // 若畫面中有選取圖元（selectedEntityIds.length > 0），自動將被選取的圖元批量轉移至所選圖層
  const handleSelectLayer = (targetLayerId: string) => {
    if (hasSelection && activeSketch) {
      const entitiesToTransfer = activeSketch.entities
        .filter((ent) => selectedEntityIds.includes(ent.id))
        .map((ent) => ({
          ...ent,
          layerId: targetLayerId,
          isConstruction: targetLayerId === 'CONSTRUCTION' ? true : ent.isConstruction,
        }));

      if (entitiesToTransfer.length > 0) {
        updateEntities(entitiesToTransfer);
      }
    }

    setActiveLayer(targetLayerId);
    setIsOpen(false);
  };

  const handleOpenManagerClick = () => {
    if (onOpenManager) {
      onOpenManager();
    } else {
      setLayerModalOpen(true);
    }
  };

  return (
    <div className="flex items-center bg-neutral-900 border border-neutral-800 rounded-md p-1 gap-1 text-xs select-none">
      {/* 圖層特性管理員按鈕 */}
      <button
        id="btn-layer-manager"
        onClick={handleOpenManagerClick}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-neutral-300 hover:text-white hover:bg-neutral-800 transition-colors border border-transparent hover:border-neutral-700"
        title="圖層特性管理員 (Layer Properties Manager) - 點擊開啟管理面板"
      >
        <Layers size={15} className="text-sky-400 shrink-0" />
        <span className="font-semibold hidden lg:inline">圖層</span>
      </button>

      <div className="h-4 w-px bg-neutral-800 mx-0.5" />

      {/* 當前圖層快速開關（可見度與鎖定） */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => toggleLayerVisibility(activeLayer.id)}
          className={`p-1 rounded transition-transform active:scale-95 ${
            activeLayer.visible !== false
              ? 'text-amber-400 hover:bg-amber-950/40'
              : 'text-neutral-600 hover:text-neutral-400 hover:bg-neutral-800'
          }`}
          title={
            activeLayer.visible !== false
              ? `圖層「${activeLayer.name}」已開啟 (點擊關閉可見度)`
              : `圖層「${activeLayer.name}」已關閉 (點擊開啟可見度)`
          }
        >
          {activeLayer.visible !== false ? (
            <Lightbulb size={15} className="fill-amber-400/20" />
          ) : (
            <LightbulbOff size={15} />
          )}
        </button>

        <button
          onClick={() => toggleLayerLock(activeLayer.id)}
          className={`p-1 rounded transition-transform active:scale-95 ${
            activeLayer.locked
              ? 'text-amber-400 hover:bg-amber-950/40'
              : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800'
          }`}
          title={
            activeLayer.locked
              ? `圖層「${activeLayer.name}」已鎖定 (點擊解鎖)`
              : `圖層「${activeLayer.name}」未鎖定 (點擊鎖定)`
          }
        >
          {activeLayer.locked ? <Lock size={14} /> : <Unlock size={14} />}
        </button>
      </div>

      {/* 圖層快捷下拉選單容器 */}
      <div className="relative" ref={dropdownRef}>
        <button
          id="btn-layer-dropdown"
          onClick={() => setIsOpen((prev) => !prev)}
          className={`flex items-center gap-2 px-2 py-1 rounded border transition-all text-left ${
            isOpen
              ? 'bg-neutral-800 border-sky-500 text-white'
              : 'bg-neutral-950 border-neutral-700/80 hover:border-neutral-600 text-neutral-200'
          }`}
          title={
            hasSelection
              ? `切換下拉選單將自動轉移 ${selectedEntityIds.length} 個選取的圖元至所選圖層`
              : '切換目前繪圖圖層'
          }
        >
          {/* 當前圖層顏色方塊/圓點 */}
          <span
            className="w-3 h-3 rounded-xs border border-neutral-600 shrink-0"
            style={{ backgroundColor: activeLayer.color || '#FFFFFF' }}
          />

          {/* 當前圖層名稱 */}
          <span className="font-mono font-medium max-w-[90px] sm:max-w-[120px] truncate text-[11px]">
            {activeLayer.name}
          </span>

          {/* 若有選取圖元，顯示轉移提示標記 */}
          {hasSelection && (
            <span className="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-[9px] px-1 rounded font-sans font-bold shrink-0">
              {selectedEntityIds.length}
            </span>
          )}

          <ChevronDown
            size={13}
            className={`text-neutral-400 transition-transform duration-150 shrink-0 ${
              isOpen ? 'rotate-180 text-sky-400' : ''
            }`}
          />
        </button>

        {/* 下拉面板 */}
        {isOpen && (
          <div className="absolute left-0 mt-1.5 w-64 bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl py-1 z-50 animate-in fade-in zoom-in-95 duration-100 divide-y divide-neutral-800/80">
            {/* 標頭提示 */}
            <div className="px-3 py-1.5 text-[10px] text-neutral-400 flex items-center justify-between bg-neutral-950/60 font-sans">
              <span>選擇目前繪圖圖層</span>
              {hasSelection && (
                <span className="text-sky-400 font-semibold">
                  (轉移 {selectedEntityIds.length} 個選取物件)
                </span>
              )}
            </div>

            {/* 圖層清單 */}
            <div className="max-h-60 overflow-y-auto py-0.5">
              {Object.values(layers).map((layer) => {
                const isActive = layer.id === activeLayer.id;
                return (
                  <div
                    key={layer.id}
                    onClick={() => handleSelectLayer(layer.id)}
                    className={`flex items-center justify-between px-3 py-1.5 cursor-pointer text-xs transition-colors ${
                      isActive
                        ? 'bg-sky-950/40 text-sky-300 font-semibold'
                        : 'hover:bg-neutral-800 text-neutral-200'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {/* 顏色方塊 */}
                      <span
                        className="w-3.5 h-3.5 rounded-xs border border-neutral-600 shrink-0"
                        style={{ backgroundColor: layer.color || '#FFFFFF' }}
                      />

                      {/* 圖層名稱 */}
                      <span className="truncate font-mono text-[11px]">{layer.name}</span>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      {/* 圖層線型縮寫標記 */}
                      <span className="text-[9px] font-mono text-neutral-500 uppercase">
                        {layer.lineType === 'CONTINUOUS'
                          ? 'SOL'
                          : layer.lineType === 'DASHED'
                          ? 'DSH'
                          : layer.lineType === 'CENTER'
                          ? 'CTR'
                          : 'HID'}
                      </span>

                      {/* 快速開關狀態圖示 */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleLayerVisibility(layer.id);
                        }}
                        className={`p-0.5 rounded ${
                          layer.visible !== false ? 'text-amber-400' : 'text-neutral-600'
                        }`}
                        title={layer.visible !== false ? '圖層開啟' : '圖層關閉'}
                      >
                        {layer.visible !== false ? (
                          <Lightbulb size={12} className="fill-amber-400/20" />
                        ) : (
                          <LightbulbOff size={12} />
                        )}
                      </button>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleLayerLock(layer.id);
                        }}
                        className={`p-0.5 rounded ${
                          layer.locked ? 'text-amber-400' : 'text-neutral-600'
                        }`}
                        title={layer.locked ? '圖層鎖定' : '圖層未鎖定'}
                      >
                        {layer.locked ? <Lock size={12} /> : <Unlock size={12} />}
                      </button>

                      {/* 目前圖層勾號 */}
                      <div className="w-4 flex items-center justify-center">
                        {isActive && <Check size={13} className="text-emerald-400 font-bold" />}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 底部快速開啟圖層特性管理員按鈕 */}
            <div className="p-1 bg-neutral-950/60">
              <button
                onClick={() => {
                  setIsOpen(false);
                  handleOpenManagerClick();
                }}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-neutral-300 hover:text-white hover:bg-neutral-800 text-xs font-semibold transition-colors"
              >
                <Layers size={13} className="text-sky-400" />
                <span>圖層特性管理員...</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
