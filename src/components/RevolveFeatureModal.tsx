import React, { useState, useEffect } from 'react';
import { useCADStore } from '../store/cadStore';
import {
  SketchFeature,
  RevolveFeature,
  RevolveCutFeature,
  LineEntity,
} from '../types/cad';
import {
  RotateCw,
  RotateCcw,
  X,
  Layers,
  Check,
  Info,
  AlertTriangle,
  ArrowLeftRight,
} from 'lucide-react';

export interface RevolveFeatureModalProps {
  isOpen: boolean;
  mode: 'REVOLVE' | 'REVOLVE_CUT';
  onClose: () => void;
}

export const RevolveFeatureModal: React.FC<RevolveFeatureModalProps> = ({
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
  const [selectedAxisId, setSelectedAxisId] = useState('');
  const [angleDeg, setAngleDeg] = useState<number>(360);
  const [reversed, setReversed] = useState<boolean>(false);

  // 當彈窗開啟或 mode 切換時，初始化預設表單狀態與名稱
  useEffect(() => {
    if (!isOpen) return;

    // 自動產生特徵名稱
    const tree = document?.featureTree || [];
    if (mode === 'REVOLVE') {
      const count = tree.filter((f) => f.type === 'REVOLVE').length + 1;
      setFeatureName(`Revolve${count}`);
    } else {
      const count = tree.filter((f) => f.type === 'REVOLVE_CUT').length + 1;
      setFeatureName(`Revolve-Cut${count}`);
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

    setAngleDeg(360);
    setReversed(false);
  }, [isOpen, mode, activeSketchId, document?.featureTree]);

  // 當選取的目標草圖變更時，自動切換旋轉軸線選取
  const targetSketch = sketches.find((s) => s.id === selectedSketchId);
  const lineEntities = (targetSketch?.entities || []).filter(
    (e): e is LineEntity => e.type === 'line'
  );

  useEffect(() => {
    if (!targetSketch || lineEntities.length === 0) {
      setSelectedAxisId('');
      return;
    }

    // 優先選取第一條建構線；若無，預設選取第一條普通直線
    const constructionLine = lineEntities.find((l) => l.isConstruction);
    if (constructionLine) {
      setSelectedAxisId(constructionLine.id);
    } else {
      setSelectedAxisId(lineEntities[0].id);
    }
  }, [selectedSketchId, targetSketch?.id, lineEntities.length]);

  if (!isOpen) return null;

  const sketchProfileCount = targetSketch?.profiles?.length || 0;
  const isBoss = mode === 'REVOLVE';

  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSketchId || !selectedAxisId) return;

    // 將角度換算為弧度（含反轉方向設定）
    const validAngleDeg = Math.max(0.1, Math.min(360, Number(angleDeg) || 360));
    const angleRad = ((validAngleDeg * Math.PI) / 180) * (reversed ? -1 : 1);

    const profileIds = targetSketch?.profiles
      ? targetSketch.profiles.map((p) => p.id)
      : [];

    if (mode === 'REVOLVE') {
      const newFeature: RevolveFeature = {
        id: `revolve-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name: featureName.trim() || 'Revolve1',
        type: 'REVOLVE',
        sketchId: selectedSketchId,
        profileIds,
        axisEntityId: selectedAxisId,
        angle: angleRad,
        dependencies: [selectedSketchId],
        suppressed: false,
        visible: true,
      };
      addFeature(newFeature);
    } else {
      const newFeature: RevolveCutFeature = {
        id: `revolve-cut-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name: featureName.trim() || 'Revolve-Cut1',
        type: 'REVOLVE_CUT',
        sketchId: selectedSketchId,
        profileIds,
        axisEntityId: selectedAxisId,
        angle: angleRad,
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
              ? 'bg-purple-950/60 border-purple-800/40'
              : 'bg-rose-950/60 border-rose-800/40'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <div
              className={`p-1.5 rounded-lg border shadow-sm ${
                isBoss
                  ? 'bg-purple-600/20 text-purple-400 border-purple-500/40'
                  : 'bg-rose-600/20 text-rose-400 border-rose-500/40'
              }`}
            >
              {isBoss ? <RotateCw size={20} /> : <RotateCcw size={20} />}
            </div>
            <div>
              <h3 className="text-sm font-bold tracking-wide text-white flex items-center gap-2">
                {isBoss ? '旋轉長料 (Revolve Boss)' : '旋轉除料 (Revolve Cut)'}
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
              className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-purple-500/80 transition-colors"
              placeholder={isBoss ? 'Revolve1' : 'Revolve-Cut1'}
            />
          </div>

          {/* 目標草圖 */}
          <div className="space-y-1.5">
            <label className="block font-semibold text-neutral-300 flex items-center gap-1.5">
              <Layers size={14} className="text-purple-400" />
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
                className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-purple-500/80 transition-colors"
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
                  <span className="text-purple-400 font-semibold">[當前作用草圖]</span>
                )}
              </div>
            )}
          </div>

          {/* 旋轉軸線 (Axis of Revolution) */}
          <div className="space-y-1.5">
            <label className="block font-semibold text-neutral-300 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <RotateCw size={14} className="text-cyan-400" />
                <span>旋轉軸線 (Axis of Revolution)</span>
              </span>
              <span className="text-[10px] text-neutral-500 font-mono">
                Line / Construction Line
              </span>
            </label>
            {lineEntities.length === 0 ? (
              <div className="p-3 bg-amber-950/40 border border-amber-800/50 rounded-lg text-amber-300 text-[11px] flex items-start gap-2">
                <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
                <span>草圖中無可用直線作為旋轉軸，請先繪製軸線或建構線</span>
              </div>
            ) : (
              <select
                value={selectedAxisId}
                onChange={(e) => setSelectedAxisId(e.target.value)}
                className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono text-xs focus:outline-none focus:border-purple-500/80 transition-colors"
              >
                {lineEntities.map((line) => {
                  const label = `線段 #${line.id.slice(0, 6)} (起點: ${line.start.x.toFixed(
                    1
                  )}, ${line.start.y.toFixed(1)})${
                    line.isConstruction ? ' [建構線]' : ''
                  }`;
                  return (
                    <option key={line.id} value={line.id}>
                      {label}
                    </option>
                  );
                })}
              </select>
            )}
          </div>

          {/* 旋轉角度 (Angle in Degrees) */}
          <div className="space-y-2">
            <label className="block font-semibold text-neutral-300 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <RotateCw size={14} className="text-emerald-400" />
                <span>旋轉角度 (Angle in Degrees)</span>
              </span>
              <span className="text-neutral-400 font-mono">度 (°)</span>
            </label>
            <div className="relative flex items-center">
              <input
                type="number"
                step="any"
                value={angleDeg}
                onChange={(e) => setAngleDeg(Number(e.target.value))}
                className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono font-bold focus:outline-none focus:border-purple-500/80 transition-colors"
              />
              <div className="absolute right-3 text-neutral-500 text-xs font-mono pointer-events-none">
                °
              </div>
            </div>

            {/* 快速填入按鈕 */}
            <div className="flex items-center gap-1.5 pt-0.5">
              <span className="text-[11px] text-neutral-500 mr-1">快速設值:</span>
              {[90, 180, 270, 360].map((deg) => (
                <button
                  key={deg}
                  type="button"
                  onClick={() => setAngleDeg(deg)}
                  className={`flex-1 py-1 px-1.5 rounded text-[11px] font-mono font-semibold border transition-colors ${
                    angleDeg === deg
                      ? 'bg-purple-600/30 text-purple-300 border-purple-500/60 font-bold'
                      : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-850'
                  }`}
                >
                  {deg}°
                </button>
              ))}
            </div>
          </div>

          {/* 反轉方向 (Reverse Direction) */}
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setReversed(!reversed)}
              className={`w-full p-2.5 rounded-lg border flex items-center justify-between transition-colors ${
                reversed
                  ? 'bg-purple-950/30 border-purple-700/60 text-purple-300'
                  : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white'
              }`}
            >
              <div className="flex items-center gap-2">
                <ArrowLeftRight size={15} className={reversed ? 'text-purple-400' : 'text-neutral-500'} />
                <span className="font-semibold text-xs">反轉旋轉方向 (Reverse Direction)</span>
              </div>
              <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
                reversed ? 'bg-purple-600 text-white' : 'bg-neutral-800 text-neutral-400'
              }`}>
                {reversed ? '反向 (-)' : '正向 (+)'}
              </span>
            </button>
          </div>

          {/* 提示備註 */}
          <div className="p-2.5 bg-neutral-900/80 border border-neutral-800/80 rounded-lg flex items-start gap-2 text-[11px] text-neutral-400">
            <Info size={15} className="text-purple-400 shrink-0 mt-0.5" />
            <span>
              確認建立後，將自動組裝 {isBoss ? 'RevolveFeature' : 'RevolveCutFeature'}{' '}
              並存入特徵樹，且自動切換至 3D 檢視模式進行累進評估與渲染。
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
              disabled={!selectedSketchId || !selectedAxisId}
              className={`px-5 py-2 rounded-lg font-bold flex items-center gap-1.5 shadow-lg transition-colors ${
                !selectedSketchId || !selectedAxisId
                  ? 'bg-neutral-800 text-neutral-500 border border-neutral-700 cursor-not-allowed'
                  : isBoss
                  ? 'bg-purple-600 hover:bg-purple-500 text-white shadow-purple-600/20'
                  : 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/20'
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

export default RevolveFeatureModal;
