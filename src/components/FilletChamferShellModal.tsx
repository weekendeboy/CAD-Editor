import React, { useState, useEffect, useCallback } from 'react';
import { useCADStore } from '../store/cadStore';
import { Fillet3DFeature, Chamfer3DFeature, Shell3DFeature } from '../types/cad';
import {
  X,
  CornerDownRight,
  SquareSlash,
  Box,
  Layers,
  Sliders,
  Check,
  Info,
} from 'lucide-react';

export interface FilletChamferShellModalProps {
  isOpen: boolean;
  mode: 'FILLET_3D' | 'CHAMFER_3D' | 'SHELL_3D';
  onClose: () => void;
}

export const FilletChamferShellModal: React.FC<FilletChamferShellModalProps> = ({
  isOpen,
  mode,
  onClose,
}) => {
  const { document, addFeature, viewMode, setViewMode } = useCADStore();

  // 表單狀態
  const [featureName, setFeatureName] = useState('');
  
  // Fillet / Chamfer 共享與專屬狀態
  const [radius, setRadius] = useState<number>(2.0);
  const [distance, setDistance] = useState<number>(2.0);
  const [edgeSelectionMode, setEdgeSelectionMode] = useState<'all' | 'vertical' | 'horizontal'>('all');

  // Shell 專屬狀態
  const [thickness, setThickness] = useState<number>(1.5);
  const [direction, setDirection] = useState<'inside' | 'outside'>('inside');

  // 每次開啟或切換 mode 時自動初始化名稱與狀態
  useEffect(() => {
    if (!isOpen) return;

    // 當彈窗開啟時，若不在 3D 模式則自動切換為 3D 視角以利預覽
    if (viewMode !== '3D') {
      setViewMode('3D');
    }

    const tree = document?.featureTree || [];
    
    if (mode === 'FILLET_3D') {
      const count = tree.filter((f) => f.type === 'FILLET_3D').length + 1;
      setFeatureName(`Fillet${count}`);
      setRadius(2.0);
      setEdgeSelectionMode('all');
    } else if (mode === 'CHAMFER_3D') {
      const count = tree.filter((f) => f.type === 'CHAMFER_3D').length + 1;
      setFeatureName(`Chamfer${count}`);
      setDistance(2.0);
      setEdgeSelectionMode('all');
    } else {
      const count = tree.filter((f) => f.type === 'SHELL_3D').length + 1;
      setFeatureName(`Shell${count}`);
      setThickness(1.5);
      setDirection('inside');
    }
  }, [isOpen, mode, document?.featureTree, viewMode, setViewMode]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  if (!isOpen) return null;

  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();

    const name = featureName.trim() || (mode === 'FILLET_3D' ? 'Fillet1' : mode === 'CHAMFER_3D' ? 'Chamfer1' : 'Shell1');

    if (mode === 'FILLET_3D') {
      const newFeature: Fillet3DFeature = {
        id: `fillet-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name,
        type: 'FILLET_3D',
        radius: Math.max(0.1, radius),
        edgeSelectionMode,
        suppressed: false,
        dependencies: [],
      };
      addFeature(newFeature);
    } else if (mode === 'CHAMFER_3D') {
      const newFeature: Chamfer3DFeature = {
        id: `chamfer-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name,
        type: 'CHAMFER_3D',
        distance: Math.max(0.1, distance),
        edgeSelectionMode,
        suppressed: false,
        dependencies: [],
      };
      addFeature(newFeature);
    } else if (mode === 'SHELL_3D') {
      const newFeature: Shell3DFeature = {
        id: `shell-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name,
        type: 'SHELL_3D',
        thickness: Math.max(0.1, thickness),
        direction,
        suppressed: false,
        dependencies: [],
      };
      addFeature(newFeature);
    }

    setViewMode('3D');
    handleClose();
  };

  // 渲染專屬面板顏色與圖示
  const getHeaderStyle = () => {
    switch (mode) {
      case 'FILLET_3D':
        return {
          bgColor: 'bg-emerald-950/70 border-emerald-800/50',
          iconColor: 'bg-emerald-600/20 text-emerald-400 border-emerald-500/40',
          title: '3D 圓角 (Fillet 3D)',
          icon: <CornerDownRight size={18} />,
        };
      case 'CHAMFER_3D':
        return {
          bgColor: 'bg-indigo-950/70 border-indigo-800/50',
          iconColor: 'bg-indigo-600/20 text-indigo-400 border-indigo-500/40',
          title: '3D 倒角 (Chamfer 3D)',
          icon: <SquareSlash size={18} />,
        };
      case 'SHELL_3D':
        return {
          bgColor: 'bg-purple-950/70 border-purple-800/50',
          iconColor: 'bg-purple-600/20 text-purple-400 border-purple-500/40',
          title: '3D 薄殼 (Shell 3D)',
          icon: <Box size={18} />,
        };
    }
  };

  const header = getHeaderStyle();

  return (
    <div
      className="fixed top-24 left-4 z-40 w-96 max-h-[calc(100vh-7rem)] overflow-hidden flex flex-col bg-neutral-950/95 backdrop-blur-md border border-neutral-800 rounded-xl shadow-2xl text-neutral-200 select-none animate-in fade-in slide-in-from-left-4 duration-200 pointer-events-auto"
      onClick={(e) => e.stopPropagation()}
      id="fillet-chamfer-shell-propertymanager"
    >
      {/* Modal 頂部 Header */}
      <div className={`h-12 px-4 border-b flex items-center justify-between shrink-0 font-sans ${header.bgColor}`}>
        <div className="flex items-center gap-2.5">
          <div className={`p-1.5 rounded-lg border shadow-sm ${header.iconColor}`}>
            {header.icon}
          </div>
          <div>
            <h3 className="text-sm font-bold tracking-wide text-white flex items-center gap-2">
              {header.title}
            </h3>
            <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
              <Sliders size={11} className="text-amber-400" />
              <span>實體拓撲重構修飾中</span>
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
            <span className="text-[10px] font-mono text-neutral-500">Auto ID</span>
          </label>
          <input
            type="text"
            required
            value={featureName}
            onChange={(e) => setFeatureName(e.target.value)}
            className="w-full px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-blue-500/80 transition-colors text-xs"
            placeholder={mode === 'FILLET_3D' ? 'Fillet1' : mode === 'CHAMFER_3D' ? 'Chamfer1' : 'Shell1'}
          />
        </div>

        {/* 【3D 圓角專屬欄位（mode === 'FILLET_3D'）】 */}
        {mode === 'FILLET_3D' && (
          <>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between font-semibold text-neutral-300">
                <span className="flex items-center gap-1.5">
                  <CornerDownRight size={14} className="text-emerald-400" />
                  <span>圓角半徑 (Radius)</span>
                </span>
                <span className="text-emerald-400 font-mono font-bold text-sm">
                  {radius} <span className="text-xs text-neutral-400">mm</span>
                </span>
              </div>

              <div className="relative flex items-center gap-2">
                <input
                  type="number"
                  min={0.1}
                  step="any"
                  value={radius === 0 ? '' : radius}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      setRadius(val);
                    } else if (e.target.value === '') {
                      setRadius(0);
                    }
                  }}
                  onBlur={() => {
                    if (radius < 0.1) {
                      setRadius(2.0);
                    }
                  }}
                  className="w-28 px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono font-bold text-center focus:outline-none focus:border-emerald-500 transition-colors text-xs"
                />
                <input
                  type="range"
                  min={0.1}
                  max={50}
                  step="0.1"
                  value={radius}
                  onChange={(e) => setRadius(Number(e.target.value))}
                  className="flex-1 accent-emerald-500 cursor-pointer h-2 bg-neutral-800 rounded-lg"
                />
              </div>

              {/* 常用半徑快選膠囊 */}
              <div className="flex items-center gap-1.5 pt-1">
                {[1, 2, 5, 10].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setRadius(val)}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                      radius === val
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 font-bold'
                        : 'bg-neutral-900 text-neutral-400 border-neutral-800 hover:text-white hover:border-neutral-700'
                    }`}
                  >
                    {val}mm
                  </button>
                ))}
              </div>
            </div>

            {/* 邊界篩選模式 */}
            <div className="space-y-1.5">
              <label className="block font-semibold text-neutral-300">
                邊界篩選模式 (Edge Selection Mode)
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['all', 'vertical', 'horizontal'] as const).map((sel) => (
                  <button
                    key={sel}
                    type="button"
                    onClick={() => setEdgeSelectionMode(sel)}
                    className={`py-2 px-1 rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
                      edgeSelectionMode === sel
                        ? 'bg-emerald-600/25 border-emerald-500 text-emerald-300 font-bold shadow-sm ring-1 ring-emerald-500/30'
                        : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-850'
                    }`}
                  >
                    <span className="text-xs uppercase">{sel}</span>
                    <span className="text-[9px] text-neutral-500 font-sans">
                      {sel === 'all' ? '全部模型邊線' : sel === 'vertical' ? '僅垂直邊線' : '僅水平邊線'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* 【3D 倒角專屬欄位（mode === 'CHAMFER_3D'）】 */}
        {mode === 'CHAMFER_3D' && (
          <>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between font-semibold text-neutral-300">
                <span className="flex items-center gap-1.5">
                  <SquareSlash size={14} className="text-indigo-400" />
                  <span>倒角距離 (Distance)</span>
                </span>
                <span className="text-indigo-400 font-mono font-bold text-sm">
                  {distance} <span className="text-xs text-neutral-400">mm</span>
                </span>
              </div>

              <div className="relative flex items-center gap-2">
                <input
                  type="number"
                  min={0.1}
                  step="any"
                  value={distance === 0 ? '' : distance}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      setDistance(val);
                    } else if (e.target.value === '') {
                      setDistance(0);
                    }
                  }}
                  onBlur={() => {
                    if (distance < 0.1) {
                      setDistance(2.0);
                    }
                  }}
                  className="w-28 px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono font-bold text-center focus:outline-none focus:border-indigo-500 transition-colors text-xs"
                />
                <input
                  type="range"
                  min={0.1}
                  max={50}
                  step="0.1"
                  value={distance}
                  onChange={(e) => setDistance(Number(e.target.value))}
                  className="flex-1 accent-indigo-500 cursor-pointer h-2 bg-neutral-800 rounded-lg"
                />
              </div>

              {/* 常用距離快選膠囊 */}
              <div className="flex items-center gap-1.5 pt-1">
                {[1, 2, 5].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setDistance(val)}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                      distance === val
                        ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/50 font-bold'
                        : 'bg-neutral-900 text-neutral-400 border-neutral-800 hover:text-white hover:border-neutral-700'
                    }`}
                  >
                    {val}mm
                  </button>
                ))}
              </div>
            </div>

            {/* 邊界篩選模式 */}
            <div className="space-y-1.5">
              <label className="block font-semibold text-neutral-300">
                邊界篩選模式 (Edge Selection Mode)
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['all', 'vertical', 'horizontal'] as const).map((sel) => (
                  <button
                    key={sel}
                    type="button"
                    onClick={() => setEdgeSelectionMode(sel)}
                    className={`py-2 px-1 rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
                      edgeSelectionMode === sel
                        ? 'bg-indigo-600/25 border-indigo-500 text-indigo-300 font-bold shadow-sm ring-1 ring-indigo-500/30'
                        : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-850'
                    }`}
                  >
                    <span className="text-xs uppercase">{sel}</span>
                    <span className="text-[9px] text-neutral-500 font-sans">
                      {sel === 'all' ? '全部模型邊線' : sel === 'vertical' ? '僅垂直邊線' : '僅水平邊線'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* 【3D 薄殼專屬欄位（mode === 'SHELL_3D'）】 */}
        {mode === 'SHELL_3D' && (
          <>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between font-semibold text-neutral-300">
                <span className="flex items-center gap-1.5">
                  <Layers size={14} className="text-purple-400" />
                  <span>殼體厚度 (Thickness)</span>
                </span>
                <span className="text-purple-400 font-mono font-bold text-sm">
                  {thickness} <span className="text-xs text-neutral-400">mm</span>
                </span>
              </div>

              <div className="relative flex items-center gap-2">
                <input
                  type="number"
                  min={0.1}
                  step="any"
                  value={thickness === 0 ? '' : thickness}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      setThickness(val);
                    } else if (e.target.value === '') {
                      setThickness(0);
                    }
                  }}
                  onBlur={() => {
                    if (thickness < 0.1) {
                      setThickness(1.5);
                    }
                  }}
                  className="w-28 px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono font-bold text-center focus:outline-none focus:border-purple-500 transition-colors text-xs"
                />
                <input
                  type="range"
                  min={0.1}
                  max={20}
                  step="0.1"
                  value={thickness}
                  onChange={(e) => setThickness(Number(e.target.value))}
                  className="flex-1 accent-purple-500 cursor-pointer h-2 bg-neutral-800 rounded-lg"
                />
              </div>
            </div>

            {/* 薄殼方向 */}
            <div className="space-y-1.5">
              <label className="block font-semibold text-neutral-300">
                薄殼方向 (Direction)
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDirection('inside')}
                  className={`py-2.5 px-2 rounded-lg border flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
                    direction === 'inside'
                      ? 'bg-purple-600/25 border-purple-500 text-purple-300 font-bold shadow-sm ring-1 ring-purple-500/30'
                      : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-850'
                  }`}
                >
                  <span className="text-xs font-semibold">向內掏空 (Inside)</span>
                  <span className="text-[10px] text-neutral-500">保留外部幾何</span>
                </button>

                <button
                  type="button"
                  onClick={() => setDirection('outside')}
                  className={`py-2.5 px-2 rounded-lg border flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
                    direction === 'outside'
                      ? 'bg-purple-600/25 border-purple-500 text-purple-300 font-bold shadow-sm ring-1 ring-purple-500/30'
                      : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-850'
                  }`}
                >
                  <span className="text-xs font-semibold">向外擴展 (Outside)</span>
                  <span className="text-[10px] text-neutral-500">擴展外部尺寸</span>
                </button>
              </div>
            </div>
          </>
        )}

        {/* 說明提示塊 */}
        <div className="p-2.5 bg-neutral-900/90 border border-neutral-800 rounded-lg flex items-start gap-2 text-[11px] text-neutral-400">
          <Info size={14} className="text-amber-400 shrink-0 mt-0.5" />
          <span>
            {mode === 'FILLET_3D' && '3D 圓角將根據設定半徑，自動平滑重構模型所有篩選合規之邊緣。'}
            {mode === 'CHAMFER_3D' && '3D 倒角將根據設定距離，自動對所有篩選合規之邊緣進行 45 度面切除。'}
            {mode === 'SHELL_3D' && '3D 薄殼將自動計算模型最頂部的開放面，並以設定厚度將其餘壁面掏空。'}
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
            className={`px-4 py-1.5 rounded-lg font-bold flex items-center gap-1.5 shadow-lg transition-colors text-xs cursor-pointer ${
              mode === 'FILLET_3D'
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/20 active:scale-95'
                : mode === 'CHAMFER_3D'
                ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/20 active:scale-95'
                : 'bg-purple-600 hover:bg-purple-500 text-white shadow-purple-600/20 active:scale-95'
            }`}
          >
            <Check size={15} />
            <span>確定建立</span>
          </button>
        </div>
      </form>
    </div>
  );
};

export default FilletChamferShellModal;
