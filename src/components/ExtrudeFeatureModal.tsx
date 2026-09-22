import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useCADStore } from '../store/cadStore';
import { findClosedProfiles } from '../core/2d/TopologyEngine';
import { SketchFeature, ExtrudeFeature, CutExtrudeFeature } from '../types/cad';
import { useDraggableModal } from '../hooks/useDraggableModal';
import {
  Box,
  Scissors,
  X,
  Layers,
  ArrowUpDown,
  Check,
  ArrowLeftRight,
  Info,
  Sliders,
  Eye,
} from 'lucide-react';

export interface ExtrudeFeatureModalProps {
  isOpen: boolean;
  mode: 'EXTRUDE' | 'CUT_EXTRUDE';
  featureId?: string;
  onClose: () => void;
}

interface ExtrudeFeatureModalContentProps {
  mode: 'EXTRUDE' | 'CUT_EXTRUDE';
  featureId?: string;
  onClose: () => void;
}

/**
 * 內部內容元件：僅在 isOpen 為 true 時掛載。
 * 初始狀態於建構時一次性計算，杜絕 useEffect 依賴改變導致使用者輸入被重設。
 */
const ExtrudeFeatureModalContent: React.FC<ExtrudeFeatureModalContentProps> = ({
  mode,
  featureId,
  onClose,
}) => {
  const document = useCADStore((s) => s.document);
  const activeSketchId = useCADStore((s) => s.activeSketchId);
  const addFeature = useCADStore((s) => s.addFeature);
  const updateFeature = useCADStore((s) => s.updateFeature);
  const viewMode = useCADStore((s) => s.viewMode);
  const setViewMode = useCADStore((s) => s.setViewMode);
  const setExtrudePreview = useCADStore((s) => s.setExtrudePreview);

  const featureTree = document?.featureTree || [];
  const sketches = useMemo(
    () => featureTree.filter((f): f is SketchFeature => f.type === 'SKETCH'),
    [featureTree]
  );

  const isBoss = mode === 'EXTRUDE';
  const isEditMode = Boolean(featureId);

  // 取得目標特徵（若為編輯模式）
  const targetFeature = useMemo(() => {
    if (!featureId) return null;
    const f = featureTree.find((item) => item.id === featureId);
    if (f && (f.type === 'EXTRUDE' || f.type === 'CUT_EXTRUDE')) {
      return f as ExtrudeFeature | CutExtrudeFeature;
    }
    return null;
  }, [featureTree, featureId]);

  // 表單初始狀態 (僅在 Component Mount 時一次性計算，避免任何 rerender 覆寫使用者輸入)
  const [featureName, setFeatureName] = useState<string>(() => {
    if (targetFeature) {
      return targetFeature.name || (isBoss ? 'Extrude1' : 'Cut-Extrude1');
    }
    if (mode === 'EXTRUDE') {
      const count = featureTree.filter((f) => f.type === 'EXTRUDE').length + 1;
      return `Extrude${count}`;
    } else {
      const count = featureTree.filter((f) => f.type === 'CUT_EXTRUDE').length + 1;
      return `Cut-Extrude${count}`;
    }
  });

  const [selectedSketchId, setSelectedSketchId] = useState<string>(() => {
    if (targetFeature) {
      return targetFeature.sketchId || (sketches.length > 0 ? sketches[0].id : '');
    }
    const validActive = sketches.find((s) => s.id === activeSketchId);
    if (validActive) return validActive.id;
    return sketches.length > 0 ? sketches[0].id : '';
  });

  const [depth, setDepth] = useState<number>(() => {
    if (targetFeature) {
      return typeof targetFeature.depth === 'number' ? targetFeature.depth : 20;
    }
    return 20;
  });

  const [direction, setDirection] = useState<'normal' | 'reversed' | 'mid-plane'>(() => {
    if (targetFeature) {
      return targetFeature.direction || 'normal';
    }
    return 'normal';
  });

  const [throughAll, setThroughAll] = useState<boolean>(() => {
    if (targetFeature && targetFeature.type === 'CUT_EXTRUDE') {
      return Boolean((targetFeature as CutExtrudeFeature).throughAll);
    }
    return false;
  });

  const { position, dragHandleProps } = useDraggableModal({ defaultX: 280, defaultY: 70 });

  // 自動確保切換至 3D 視圖
  useEffect(() => {
    if (viewMode !== '3D') {
      setViewMode('3D');
    }
  }, [viewMode, setViewMode]);

  // 元件卸載時清除 3D 預覽
  useEffect(() => {
    return () => {
      setExtrudePreview(null);
    };
  }, [setExtrudePreview]);

  // 即時同步拉伸預覽狀態至 3D 視圖
  useEffect(() => {
    if (!selectedSketchId) {
      setExtrudePreview(null);
      return;
    }

    const parsedDepth = Math.max(0.1, Number(depth) || 20);
    setExtrudePreview({
      isOpen: true,
      mode,
      sketchId: selectedSketchId,
      depth: parsedDepth,
      direction,
      throughAll: !isBoss && throughAll,
    });
  }, [mode, selectedSketchId, depth, direction, throughAll, isBoss, setExtrudePreview]);

  const targetSketch = sketches.find((s) => s.id === selectedSketchId);
  const computedProfiles = useMemo(() => {
    if (!targetSketch) return [];
    if (targetSketch.profiles && targetSketch.profiles.length > 0) return targetSketch.profiles;
    return findClosedProfiles(targetSketch.entities, targetSketch.constraints);
  }, [targetSketch]);

  const handleClose = useCallback(() => {
    setExtrudePreview(null);
    onClose();
  }, [setExtrudePreview, onClose]);

  const sketchProfileCount = computedProfiles.length;

  // 切換正向/反向
  const toggleDirectionFlip = () => {
    if (direction === 'normal') {
      setDirection('reversed');
    } else if (direction === 'reversed') {
      setDirection('normal');
    } else {
      setDirection('normal');
    }
  };

  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSketchId) return;

    const profileIds = computedProfiles.map((p) => p.id);
    const parsedDepth = Math.max(0.1, Number(depth) || 20);

    if (featureId) {
      // 編輯模式：更新既有特徵，保持 featureId 不變
      const updates: Partial<ExtrudeFeature | CutExtrudeFeature> = {
        name: featureName.trim() || (isBoss ? 'Extrude1' : 'Cut-Extrude1'),
        sketchId: selectedSketchId,
        profileIds,
        depth: parsedDepth,
        direction,
        dependencies: [selectedSketchId],
      };
      if (!isBoss) {
        (updates as Partial<CutExtrudeFeature>).throughAll = throughAll;
      }
      updateFeature(featureId, updates);
    } else {
      // 新建模式：產生全新特徵實例
      if (mode === 'EXTRUDE') {
        const newFeature: ExtrudeFeature = {
          id: `extrude-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          name: featureName.trim() || 'Extrude1',
          type: 'EXTRUDE',
          sketchId: selectedSketchId,
          profileIds,
          depth: parsedDepth,
          direction,
          dependencies: [selectedSketchId],
          suppressed: false,
          visible: true,
          mergeResult: true,
        };
        addFeature(newFeature);
      } else {
        const newFeature: CutExtrudeFeature = {
          id: `cut-extrude-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          name: featureName.trim() || 'Cut-Extrude1',
          type: 'CUT_EXTRUDE',
          sketchId: selectedSketchId,
          profileIds,
          depth: parsedDepth,
          direction,
          throughAll,
          dependencies: [selectedSketchId],
          suppressed: false,
          visible: true,
        };
        addFeature(newFeature);
      }
    }

    // 自動切換視圖模式至 3D 並清除預覽
    setViewMode('3D');
    handleClose();
  };

  return (
    <div className="fixed inset-0 z-40 pointer-events-none">
      <div
        style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)`, position: 'fixed', top: 0, left: 0 }}
        className="w-96 max-h-[calc(100vh-5rem)] overflow-hidden flex flex-col bg-neutral-950/95 backdrop-blur-md border border-neutral-800 rounded-xl shadow-2xl text-neutral-200 select-none animate-in fade-in slide-in-from-left-4 duration-200 pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
        id="extrude-feature-propertymanager"
      >
        {/* SolidWorks 經典 PropertyManager 頂部 Header */}
        <div
          {...dragHandleProps}
          className={`h-12 px-4 border-b flex items-center justify-between shrink-0 font-sans cursor-move select-none ${
            isBoss
              ? 'bg-blue-950/70 border-blue-800/50'
              : 'bg-amber-950/70 border-amber-800/50'
          }`}
        >
        <div className="flex items-center gap-2.5">
          <div
            className={`p-1.5 rounded-lg border shadow-sm ${
              isBoss
                ? 'bg-blue-600/20 text-blue-400 border-blue-500/40'
                : 'bg-amber-600/20 text-amber-400 border-amber-500/40'
            }`}
          >
            {isBoss ? <Box size={18} /> : <Scissors size={18} />}
          </div>
          <div>
            <h3 className="text-sm font-bold tracking-wide text-white flex items-center gap-2">
              {isEditMode
                ? isBoss
                  ? '編輯伸長長料 (Edit Extrude Boss)'
                  : '編輯伸長除料 (Edit Extrude Cut)'
                : isBoss
                ? '伸長長料 (Extrude Boss)'
                : '伸長除料 (Extrude Cut)'}
            </h3>
            <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
              <Eye size={11} className={isBoss ? 'text-amber-400' : 'text-rose-400'} />
              <span>3D 即時實體幾何與方向預覽中</span>
            </div>
          </div>
        </div>
        <button
          onClick={handleClose}
          className="p-1 text-neutral-400 hover:text-white hover:bg-neutral-800/80 rounded-lg transition-colors cursor-pointer"
          title="關閉 (Esc)"
        >
          <X size={18} />
        </button>
      </div>

      {/* 表單內容主體 */}
      <form onSubmit={handleConfirm} noValidate className="p-4 space-y-4 font-sans text-xs overflow-y-auto">
        {/* 特徵名稱 */}
        <div className="space-y-1.5">
          <label className="block font-semibold text-neutral-300 flex items-center justify-between">
            <span>特徵名稱 (Feature Name)</span>
            <span className="text-[10px] font-mono text-neutral-500">
              {isEditMode ? featureId : 'Auto ID'}
            </span>
          </label>
          <input
            type="text"
            required
            value={featureName}
            onChange={(e) => setFeatureName(e.target.value)}
            className="w-full px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-blue-500/80 transition-colors text-xs"
            placeholder={isBoss ? 'Extrude1' : 'Cut-Extrude1'}
          />
        </div>

        {/* 目標草圖 */}
        <div className="space-y-1.5">
          <label className="block font-semibold text-neutral-300 flex items-center gap-1.5">
            <Layers size={14} className="text-blue-400" />
            <span>目標草圖 (Target Sketch)</span>
          </label>
          {sketches.length === 0 ? (
            <div className="p-2.5 bg-red-950/40 border border-red-800/40 rounded-lg text-red-300 text-[11px]">
              ⚠️ 目前特徵樹中尚無可用草圖，請先建立草圖繪製輪廓。
            </div>
          ) : (
            <select
              value={selectedSketchId}
              onChange={(e) => setSelectedSketchId(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-blue-500/80 transition-colors text-xs"
            >
              {sketches.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.plane?.name || 'Front Plane'}) — {s.profiles?.length || 0} 個封閉輪廓
                </option>
              ))}
            </select>
          )}
          {targetSketch && (
            <div className="flex items-center justify-between text-[11px] text-neutral-400 px-1 pt-0.5">
              <span>
                輪廓封閉區:{' '}
                <span
                  className={
                    sketchProfileCount > 0
                      ? 'text-emerald-400 font-bold'
                      : 'text-amber-400 font-bold'
                  }
                >
                  {sketchProfileCount} 個區域
                </span>
              </span>
              {selectedSketchId === activeSketchId && (
                <span className="text-blue-400 font-semibold">[當前作用草圖]</span>
              )}
            </div>
          )}
        </div>

        {/* 伸長深度 (含即時滑桿與快速數值按鈕) */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between font-semibold text-neutral-300">
            <span className="flex items-center gap-1.5">
              <ArrowUpDown size={14} className="text-emerald-400" />
              <span>伸長深度 (Depth)</span>
            </span>
            <span className="text-amber-400 font-mono font-bold text-sm">
              {depth} <span className="text-xs text-neutral-400">mm</span>
            </span>
          </div>

          <div className="relative flex items-center gap-2">
            <input
              type="number"
              min={0.001}
              step="any"
              disabled={!isBoss && throughAll}
              value={depth === 0 ? '' : depth}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) {
                  setDepth(val);
                } else if (e.target.value === '') {
                  setDepth(0);
                }
              }}
              onBlur={() => {
                if (depth <= 0) {
                  setDepth(10);
                }
              }}
              className={`w-28 px-3 py-1.5 bg-neutral-900 border rounded-lg text-white font-mono font-bold text-center focus:outline-none transition-colors ${
                !isBoss && throughAll
                  ? 'opacity-40 border-neutral-800 cursor-not-allowed bg-neutral-950'
                  : 'border-neutral-800 focus:border-blue-500/80'
              }`}
            />
            <input
              type="range"
              min={0.5}
              max={Math.max(200, depth)}
              step="any"
              disabled={!isBoss && throughAll}
              value={Math.min(Math.max(200, depth), Math.max(0.5, depth))}
              onChange={(e) => setDepth(Number(e.target.value))}
              className="flex-1 accent-amber-500 cursor-pointer h-2 bg-neutral-800 rounded-lg"
            />
          </div>

          {/* 常用深度快選膠囊 */}
          {(!throughAll || isBoss) && (
            <div className="flex items-center gap-1.5 pt-1">
              {[10, 20, 30, 50, 100].map((val) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setDepth(val)}
                  className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                    depth === val
                      ? 'bg-amber-500/20 text-amber-300 border-amber-500/50 font-bold'
                      : 'bg-neutral-900 text-neutral-400 border-neutral-800 hover:text-white hover:border-neutral-700'
                  }`}
                >
                  {val}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 伸長方向 (Direction) + 一鍵反轉按鈕 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between font-semibold text-neutral-300">
            <span>伸長方向 (Direction)</span>
            <button
              type="button"
              onClick={toggleDirectionFlip}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-900 hover:bg-neutral-800 text-amber-400 hover:text-amber-300 border border-neutral-700 text-[10px] font-semibold transition-colors cursor-pointer"
              title="一鍵反向伸長方向向量"
            >
              <ArrowLeftRight size={11} />
              <span>反轉方向</span>
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              onClick={() => setDirection('normal')}
              className={`py-2 px-1.5 rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
                direction === 'normal'
                  ? 'bg-blue-600/25 border-blue-500 text-blue-300 font-bold shadow-sm ring-1 ring-blue-500/30'
                  : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-855'
              }`}
            >
              <span className="text-xs">正向 (Normal)</span>
              <span className="text-[10px] text-neutral-500 font-mono">+Z 法向量</span>
            </button>

            <button
              type="button"
              onClick={() => setDirection('reversed')}
              className={`py-2 px-1.5 rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
                direction === 'reversed'
                  ? 'bg-blue-600/25 border-blue-500 text-blue-300 font-bold shadow-sm ring-1 ring-blue-500/30'
                  : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-855'
              }`}
            >
              <span className="text-xs">反向 (Reversed)</span>
              <span className="text-[10px] text-neutral-500 font-mono">-Z 反法向</span>
            </button>

            <button
              type="button"
              onClick={() => setDirection('mid-plane')}
              className={`py-2 px-1.5 rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
                direction === 'mid-plane'
                  ? 'bg-blue-600/25 border-blue-500 text-blue-300 font-bold shadow-sm ring-1 ring-blue-500/30'
                  : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-855'
              }`}
            >
              <span className="text-xs">兩側對稱</span>
              <span className="text-[10px] text-neutral-500 font-mono">Mid-Plane</span>
            </button>
          </div>
        </div>

        {/* 若為除料模式（CUT_EXTRUDE），提供完全貫穿（Through All）核取方塊 */}
        {!isBoss && (
          <div className="pt-0.5">
            <label className="flex items-center gap-2.5 p-2.5 bg-amber-950/20 border border-amber-800/40 rounded-lg cursor-pointer hover:bg-amber-950/30 transition-colors">
              <input
                type="checkbox"
                checked={throughAll}
                onChange={(e) => setThroughAll(e.target.checked)}
                className="w-4 h-4 rounded border-neutral-700 bg-neutral-900 text-amber-500 focus:ring-amber-500/40"
              />
              <div className="flex-1">
                <span className="font-bold text-amber-300 block text-xs">
                  完全貫穿 (Through All)
                </span>
                <span className="text-[10px] text-neutral-400 block">
                  自動沿除料方向完全切穿整個 3D 實體模型
                </span>
              </div>
            </label>
          </div>
        )}

        {/* 預覽與操作提示說明 */}
        <div className="p-2.5 bg-neutral-900/90 border border-neutral-800 rounded-lg flex items-start gap-2 text-[11px] text-neutral-400">
          <Info size={14} className={isBoss ? 'text-amber-400 shrink-0 mt-0.5' : 'text-rose-400 shrink-0 mt-0.5'} />
          <span>
            3D 視角中已開啟即時預覽：
            <strong className={isBoss ? 'text-amber-300' : 'text-rose-300'}>
              {isBoss ? ' 黃色半透明柱體' : ' 紅色半透明除料體'}
            </strong>
            ，並帶有方向指示箭頭與深度標註，可直接旋轉 3D 視角檢視方向。
          </span>
        </div>

        {/* 底部按鈕列 */}
        <div className="pt-2 flex items-center justify-end gap-2 border-t border-neutral-800">
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-1.5 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded-lg border border-neutral-800 font-semibold transition-colors text-xs cursor-pointer"
          >
            取消 (Esc)
          </button>
          <button
            type="submit"
            disabled={!selectedSketchId}
            className={`px-4 py-1.5 rounded-lg font-bold flex items-center gap-1.5 shadow-lg transition-colors text-xs cursor-pointer ${
              !selectedSketchId
                ? 'bg-neutral-800 text-neutral-500 border border-neutral-700 cursor-not-allowed'
                : isBoss
                ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/20 active:scale-95'
                : 'bg-amber-500 hover:bg-amber-400 text-neutral-950 shadow-amber-600/20 active:scale-95'
            }`}
          >
            <Check size={15} />
            <span>{isEditMode ? '確定更新' : '確定建立'}</span>
          </button>
        </div>
      </form>
    </div>
  </div>
  );
};

export const ExtrudeFeatureModal: React.FC<ExtrudeFeatureModalProps> = ({
  isOpen,
  mode,
  featureId,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <ExtrudeFeatureModalContent
      key={`${mode}-${featureId || 'new'}`}
      mode={mode}
      featureId={featureId}
      onClose={onClose}
    />
  );
};

export default ExtrudeFeatureModal;

