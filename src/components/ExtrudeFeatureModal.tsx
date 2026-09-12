import React, { useState, useEffect } from 'react';
import { useCADStore } from '../store/cadStore';
import { SketchFeature, ExtrudeFeature, CutExtrudeFeature } from '../types/cad';
import {
  Box,
  Scissors,
  X,
  Layers,
  ArrowUpDown,
  Check,
  RotateCcw,
  Sparkles,
  Info,
} from 'lucide-react';

export interface ExtrudeFeatureModalProps {
  isOpen: boolean;
  mode: 'EXTRUDE' | 'CUT_EXTRUDE';
  onClose: () => void;
}

export const ExtrudeFeatureModal: React.FC<ExtrudeFeatureModalProps> = ({
  isOpen,
  mode,
  onClose,
}) => {
  const { document, activeSketchId, addFeature, setViewMode } = useCADStore();

  // 取得目前特徵樹中的所有草圖特徵
  const sketches = (document?.featureTree || []).filter(
    (f): f is SketchFeature => f.type === 'SKETCH'
  );

  // 表單狀態
  const [featureName, setFeatureName] = useState('');
  const [selectedSketchId, setSelectedSketchId] = useState('');
  const [depth, setDepth] = useState<number>(20);
  const [direction, setDirection] = useState<'normal' | 'reversed' | 'mid-plane'>('normal');
  const [throughAll, setThroughAll] = useState(false);

  // 當彈窗開啟或 mode 切換時，重新初始化表單數值與預設特徵名稱
  useEffect(() => {
    if (!isOpen) return;

    // 計算自動名稱
    const tree = document?.featureTree || [];
    if (mode === 'EXTRUDE') {
      const count = tree.filter((f) => f.type === 'EXTRUDE').length + 1;
      setFeatureName(`Extrude${count}`);
    } else {
      const count = tree.filter((f) => f.type === 'CUT_EXTRUDE').length + 1;
      setFeatureName(`Cut-Extrude${count}`);
    }

    // 預設目標草圖為當前 activeSketchId，若無則降級選取第一張草圖
    const validActive = sketches.find((s) => s.id === activeSketchId);
    if (validActive) {
      setSelectedSketchId(validActive.id);
    } else if (sketches.length > 0) {
      setSelectedSketchId(sketches[0].id);
    } else {
      setSelectedSketchId('');
    }

    setDepth(20);
    setDirection('normal');
    setThroughAll(false);
  }, [isOpen, mode, activeSketchId, document?.featureTree]);

  if (!isOpen) return null;

  const targetSketch = sketches.find((s) => s.id === selectedSketchId);
  const sketchProfileCount = targetSketch?.profiles?.length || 0;

  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSketchId) return;

    const profileIds = targetSketch?.profiles
      ? targetSketch.profiles.map((p) => p.id)
      : [];

    const parsedDepth = Math.max(0.1, Number(depth) || 20);

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

    // 自動切換視圖模式至 3D 並關閉彈窗
    setViewMode('3D');
    onClose();
  };

  const isBoss = mode === 'EXTRUDE';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className="w-full max-w-md bg-neutral-950 border border-neutral-800 rounded-xl shadow-2xl overflow-hidden flex flex-col text-neutral-200 select-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* SW 經典對話框頂部 Header */}
        <div
          className={`h-12 px-4 border-b flex items-center justify-between shrink-0 font-sans ${
            isBoss
              ? 'bg-blue-950/60 border-blue-800/40'
              : 'bg-amber-950/60 border-amber-800/40'
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
              {isBoss ? <Box size={20} /> : <Scissors size={20} />}
            </div>
            <div>
              <h3 className="text-sm font-bold tracking-wide text-white flex items-center gap-2">
                {isBoss ? '伸長長料 (Extrude Boss)' : '伸長除料 (Extrude Cut)'}
              </h3>
              <p className="text-[11px] text-neutral-400">
                SolidWorks 3D Feature PropertyManager
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-neutral-400 hover:text-white hover:bg-neutral-800/80 rounded-lg transition-colors"
            title="關閉 (Esc)"
          >
            <X size={18} />
          </button>
        </div>

        {/* 表單內容主體 */}
        <form onSubmit={handleConfirm} className="p-5 space-y-4 font-sans text-xs">
          {/* 特徵名稱 */}
          <div className="space-y-1.5">
            <label className="block font-semibold text-neutral-300 flex items-center justify-between">
              <span>特徵名稱 (Feature Name)</span>
              <span className="text-[10px] font-mono text-neutral-500">ID: Auto</span>
            </label>
            <input
              type="text"
              required
              value={featureName}
              onChange={(e) => setFeatureName(e.target.value)}
              className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-blue-500/80 transition-colors"
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
              <div className="p-3 bg-red-950/40 border border-red-800/40 rounded-lg text-red-300 text-[11px]">
                ⚠️ 目前特徵樹中尚無可用草圖，請先建立草圖繪製圖元。
              </div>
            ) : (
              <select
                value={selectedSketchId}
                onChange={(e) => setSelectedSketchId(e.target.value)}
                className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-blue-500/80 transition-colors"
              >
                {sketches.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.plane?.name || 'Front Plane'}) — {s.entities?.length || 0} entities / {s.profiles?.length || 0} profiles
                  </option>
                ))}
              </select>
            )}
            {targetSketch && (
              <div className="flex items-center justify-between text-[11px] text-neutral-400 px-1 pt-0.5">
                <span>
                  草圖輪廓 (Profiles):{' '}
                  <span
                    className={
                      sketchProfileCount > 0
                        ? 'text-emerald-400 font-bold'
                        : 'text-amber-400 font-bold'
                    }
                  >
                    {sketchProfileCount} 個封閉區域
                  </span>
                </span>
                {selectedSketchId === activeSketchId && (
                  <span className="text-blue-400 font-semibold">[當前作用草圖]</span>
                )}
              </div>
            )}
          </div>

          {/* 伸長深度 */}
          <div className="space-y-1.5">
            <label className="block font-semibold text-neutral-300 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <ArrowUpDown size={14} className="text-emerald-400" />
                <span>伸長深度 (Extrude Depth)</span>
              </span>
              <span className="text-neutral-400 font-mono">mm</span>
            </label>
            <div className="relative flex items-center">
              <input
                type="number"
                step="0.5"
                min="0.1"
                disabled={!isBoss && throughAll}
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
                className={`w-full px-3 py-2 bg-neutral-900 border rounded-lg text-white font-mono font-bold focus:outline-none transition-colors ${
                  !isBoss && throughAll
                    ? 'opacity-40 border-neutral-800 cursor-not-allowed bg-neutral-950'
                    : 'border-neutral-800 focus:border-blue-500/80'
                }`}
              />
              <div className="absolute right-3 text-neutral-500 text-xs font-mono pointer-events-none">
                mm
              </div>
            </div>
          </div>

          {/* 伸長方向 (Direction) */}
          <div className="space-y-1.5">
            <label className="block font-semibold text-neutral-300">
              伸長方向 (Extrude Direction)
            </label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setDirection('normal')}
                className={`py-2 px-2 rounded-lg border flex flex-col items-center justify-center gap-1 transition-colors ${
                  direction === 'normal'
                    ? 'bg-blue-600/20 border-blue-500 text-blue-300 font-bold shadow-sm'
                    : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-850'
                }`}
              >
                <span className="text-xs">正向 (Normal)</span>
                <span className="text-[10px] text-neutral-500 font-mono">+Z Normal</span>
              </button>

              <button
                type="button"
                onClick={() => setDirection('reversed')}
                className={`py-2 px-2 rounded-lg border flex flex-col items-center justify-center gap-1 transition-colors ${
                  direction === 'reversed'
                    ? 'bg-blue-600/20 border-blue-500 text-blue-300 font-bold shadow-sm'
                    : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-850'
                }`}
              >
                <span className="text-xs">反向 (Reversed)</span>
                <span className="text-[10px] text-neutral-500 font-mono">-Z Normal</span>
              </button>

              <button
                type="button"
                onClick={() => setDirection('mid-plane')}
                className={`py-2 px-2 rounded-lg border flex flex-col items-center justify-center gap-1 transition-colors ${
                  direction === 'mid-plane'
                    ? 'bg-blue-600/20 border-blue-500 text-blue-300 font-bold shadow-sm'
                    : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-850'
                }`}
              >
                <span className="text-xs">兩側對稱</span>
                <span className="text-[10px] text-neutral-500 font-mono">Mid-Plane</span>
              </button>
            </div>
          </div>

          {/* 若為除料模式（CUT_EXTRUDE），提供完全貫穿（Through All）核取方塊 */}
          {!isBoss && (
            <div className="pt-1">
              <label className="flex items-center gap-2.5 p-3 bg-amber-950/20 border border-amber-800/40 rounded-lg cursor-pointer hover:bg-amber-950/30 transition-colors">
                <input
                  type="checkbox"
                  checked={throughAll}
                  onChange={(e) => setThroughAll(e.target.checked)}
                  className="w-4 h-4 rounded border-neutral-700 bg-neutral-900 text-amber-500 focus:ring-amber-500/40"
                />
                <div className="flex-1">
                  <span className="font-bold text-amber-300 block">
                    完全貫穿 (Through All)
                  </span>
                  <span className="text-[11px] text-neutral-400 block">
                    自動沿伸長方向完全貫穿整個實體幾何模型
                  </span>
                </div>
              </label>
            </div>
          )}

          {/* 提示備註 */}
          <div className="p-2.5 bg-neutral-900/80 border border-neutral-800/80 rounded-lg flex items-start gap-2 text-[11px] text-neutral-400">
            <Info size={15} className="text-blue-400 shrink-0 mt-0.5" />
            <span>
              確認建立後，將自動組裝 {isBoss ? 'ExtrudeFeature' : 'CutExtrudeFeature'}{' '}
              並插入特徵樹，且切換至 3D 檢視模式進行高精細 CAD 實體渲染。
            </span>
          </div>

          {/* 底部按鈕列 */}
          <div className="pt-2 flex items-center justify-end gap-2 border-t border-neutral-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded-lg border border-neutral-800 font-semibold transition-colors"
            >
              取消 (Cancel)
            </button>
            <button
              type="submit"
              disabled={!selectedSketchId}
              className={`px-5 py-2 rounded-lg font-bold flex items-center gap-1.5 shadow-lg transition-colors ${
                !selectedSketchId
                  ? 'bg-neutral-800 text-neutral-500 border border-neutral-700 cursor-not-allowed'
                  : isBoss
                  ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/20'
                  : 'bg-amber-600 hover:bg-amber-500 text-neutral-950 shadow-amber-600/20'
              }`}
            >
              <Check size={16} />
              <span>確定建立</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ExtrudeFeatureModal;
