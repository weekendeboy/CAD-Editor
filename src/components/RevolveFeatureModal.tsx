import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useCADStore } from '../store/cadStore';
import { useDraggableModal } from '../hooks/useDraggableModal';
import {
  SketchFeature,
  RevolveFeature,
  RevolveCutFeature,
  LineEntity,
} from '../types/cad';
import { findClosedProfiles } from '../core/2d/TopologyEngine';
import {
  RotateCw,
  RotateCcw,
  X,
  Layers,
  Check,
  Info,
  AlertTriangle,
  ArrowLeftRight,
  MousePointerClick,
  Sparkles,
} from 'lucide-react';

export interface RevolveFeatureModalProps {
  isOpen: boolean;
  mode: 'REVOLVE' | 'REVOLVE_CUT';
  onClose: () => void;
}

interface RevolveFeatureModalContentProps {
  mode: 'REVOLVE' | 'REVOLVE_CUT';
  featureId?: string;
  onClose: () => void;
}

/**
 * 內部內容元件：僅在 isOpen 為 true 時掛載。
 * 初始狀態於建構時一次性計算，杜絕 useEffect 初始化的巢狀 setState 與重繪迴圈。
 */
const RevolveFeatureModalContent: React.FC<RevolveFeatureModalContentProps> = ({
  mode,
  featureId,
  onClose,
}) => {
  const featureTree = useCADStore((s) => s.document?.featureTree) || [];
  const activeSketchId = useCADStore((s) => s.activeSketchId);
  const addFeature = useCADStore((s) => s.addFeature);
  const viewMode = useCADStore((s) => s.viewMode);
  const setViewMode = useCADStore((s) => s.setViewMode);
  const setRevolvePreview = useCADStore((s) => s.setRevolvePreview);

  // 取得目前特徵樹中的所有草圖特徵
  const sketches = useMemo(() => {
    return featureTree.filter(
      (f): f is SketchFeature => f.type === 'SKETCH'
    );
  }, [featureTree]);

  // 決定初始草圖 (優先選擇目前作用中的草圖，否則降級選擇第一張草圖)
  const initialSketch = useMemo(() => {
    return sketches.find((s) => s.id === activeSketchId) || sketches[0] || null;
  }, [sketches, activeSketchId]);

  // 同步初始化表單狀態 (避免在 useEffect 內重複呼叫 setState 觸發 Max Update Depth)
  const [featureName, setFeatureName] = useState<string>(() => {
    if (mode === 'REVOLVE') {
      const count = featureTree.filter((f) => f.type === 'REVOLVE').length + 1;
      return `Revolve${count}`;
    } else {
      const count = featureTree.filter((f) => f.type === 'REVOLVE_CUT').length + 1;
      return `Revolve-Cut${count}`;
    }
  });

  const [selectedSketchId, setSelectedSketchId] = useState<string>(
    () => initialSketch?.id || ''
  );

  const [selectedAxisId, setSelectedAxisId] = useState<string>(() => {
    const lines = (initialSketch?.entities || []).filter(
      (e): e is LineEntity => e.type === 'line'
    );
    const constr = lines.find((l) => l.isConstruction);
    return constr?.id || lines[0]?.id || '';
  });

  const [angleDeg, setAngleDeg] = useState<number>(360);
  const [reversed, setReversed] = useState<boolean>(false);

  const { position, dragHandleProps } = useDraggableModal({ defaultX: 280, defaultY: 70 });

  // 自動確保切換至 3D 視圖
  useEffect(() => {
    if (viewMode !== '3D') {
      setViewMode('3D');
    }
  }, [viewMode, setViewMode]);

  const rollbackTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 當進入特徵編輯模式時，自動將 3D 回退索引設定至目標特徵位置前，隔離編輯預覽
  useEffect(() => {
    if (!featureId) return;

    if (rollbackTimerRef.current) {
      clearTimeout(rollbackTimerRef.current);
      rollbackTimerRef.current = null;
    }

    // 1. 組件掛載/進入編輯時，退回歷史
    const currentState = useCADStore.getState();
    const tree = currentState.document.featureTree;
    const idx = tree.findIndex((f) => f.id === featureId);
    if (idx >= 0) {
      if (currentState.document.rollbackIndex !== idx) {
        currentState.setRollbackIndex(idx);
      }
    }

    // 2. 只有在組件真正卸載 (Unmount) 或 featureId 改變時，才恢復到樹的末端
    return () => {
      if (rollbackTimerRef.current) {
        clearTimeout(rollbackTimerRef.current);
      }
      rollbackTimerRef.current = setTimeout(() => {
        const state = useCADStore.getState();
        const treeLen = state.document.featureTree.length;
        if (state.document.rollbackIndex !== treeLen) {
          state.setRollbackIndex(treeLen);
        }
      }, 0);
    };
  }, [featureId]);

  // 當前選取草圖物件與線段實體
  const targetSketch = useMemo(() => {
    return sketches.find((s) => s.id === selectedSketchId);
  }, [sketches, selectedSketchId]);

  const lineEntities = useMemo(() => {
    return (targetSketch?.entities || []).filter(
      (e): e is LineEntity => e.type === 'line'
    );
  }, [targetSketch]);

  const computedProfiles = useMemo(() => {
    if (!targetSketch) return [];
    if (targetSketch.profiles && targetSketch.profiles.length > 0) return targetSketch.profiles;
    return findClosedProfiles(targetSketch.entities, targetSketch.constraints);
  }, [targetSketch]);

  // 監聽 3D 視圖或 2D 畫布中直接點擊軸線與切換方向的自訂事件
  useEffect(() => {
    const handleAxisSelected = (e: CustomEvent<string>) => {
      if (e.detail) {
        setSelectedAxisId(e.detail);
      }
    };
    const handleToggleDir = () => {
      setReversed((prev) => !prev);
    };

    window.addEventListener('cad-set-revolve-axis' as any, handleAxisSelected);
    window.addEventListener('cad-toggle-revolve-direction' as any, handleToggleDir);

    return () => {
      window.removeEventListener('cad-set-revolve-axis' as any, handleAxisSelected);
      window.removeEventListener('cad-toggle-revolve-direction' as any, handleToggleDir);
    };
  }, []);

  // 目標草圖切換事件處理
  const handleSketchChange = useCallback((newSketchId: string) => {
    setSelectedSketchId(newSketchId);
    const sketch = sketches.find((s) => s.id === newSketchId);
    const lines = (sketch?.entities || []).filter((e): e is LineEntity => e.type === 'line');
    const constr = lines.find((l) => l.isConstruction);
    const defaultAxisId = constr?.id || lines[0]?.id || '';
    setSelectedAxisId(defaultAxisId);
  }, [sketches]);

  // 單向推送預覽狀態至 CAD Store (Modal 為唯一的權威來源，杜絕雙向 Ping-Pong 迴圈)
  useEffect(() => {
    if (!selectedSketchId) {
      setRevolvePreview(null);
      return;
    }

    const validAngleDeg = Math.max(0.1, Math.min(360, Number(angleDeg) || 360));
    const angleRad = (validAngleDeg * Math.PI) / 180;

    setRevolvePreview({
      isOpen: true,
      mode,
      sketchId: selectedSketchId,
      axisEntityId: selectedAxisId,
      angle: angleRad,
      reversed,
    });
  }, [mode, selectedSketchId, selectedAxisId, angleDeg, reversed, setRevolvePreview]);

  // 元件卸載時安全清除預覽狀態
  useEffect(() => {
    return () => {
      setRevolvePreview(null);
    };
  }, [setRevolvePreview]);

  const sketchProfileCount = computedProfiles.length;
  const isBoss = mode === 'REVOLVE';
  const currentAxisLine = lineEntities.find((l) => l.id === selectedAxisId);

  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSketchId || !selectedAxisId) return;

    // 將角度換算為弧度（含反轉方向設定）
    const validAngleDeg = Math.max(0.1, Math.min(360, Number(angleDeg) || 360));
    const angleRad = ((validAngleDeg * Math.PI) / 180) * (reversed ? -1 : 1);

    const profileIds = computedProfiles.map((p) => p.id);

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

    setViewMode('3D');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 pointer-events-none">
      <div
        style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)`, position: 'fixed', top: 0, left: 0 }}
        className="w-96 max-h-[calc(100vh-5rem)] overflow-hidden flex flex-col bg-neutral-950/95 backdrop-blur-md border border-neutral-800 rounded-xl shadow-2xl text-neutral-200 select-none animate-in fade-in slide-in-from-left-4 duration-200 pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
        id="revolve-feature-propertymanager"
      >
        {/* 頂部 Header */}
        <div
          {...dragHandleProps}
          className={`h-12 px-4 border-b flex items-center justify-between shrink-0 font-sans cursor-move select-none ${
            isBoss
              ? 'bg-purple-950/70 border-purple-800/50'
              : 'bg-rose-950/70 border-rose-800/50'
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
          className="p-1 text-neutral-400 hover:text-white hover:bg-neutral-800/80 rounded-lg transition-colors cursor-pointer"
          title="關閉 (Esc)"
        >
          <X size={18} />
        </button>
      </div>

      {/* 表單內容主體 */}
      <form onSubmit={handleConfirm} noValidate className="p-5 space-y-4 font-sans text-xs overflow-y-auto">
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
              onChange={(e) => handleSketchChange(e.target.value)}
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
        <div className="space-y-2 p-3 bg-neutral-900/90 rounded-xl border border-neutral-800">
          <div className="flex items-center justify-between">
            <label className="font-semibold text-neutral-200 flex items-center gap-1.5">
              <RotateCw size={14} className="text-cyan-400" />
              <span>旋轉軸線 (Axis of Revolution)</span>
            </label>
            <span className="text-[10px] bg-cyan-950 text-cyan-300 border border-cyan-800/60 px-1.5 py-0.5 rounded font-mono flex items-center gap-1">
              <MousePointerClick size={11} /> 支援 3D 點選
            </span>
          </div>

          {/* 3D 點選提示橫幅 */}
          <div className="p-2 bg-cyan-950/40 border border-cyan-800/40 rounded-lg text-cyan-200 text-[11px] flex items-center gap-2">
            <Sparkles size={14} className="text-cyan-400 shrink-0" />
            <span>在 3D 預覽畫面中直接<strong>點選任意直線</strong>即可立即更換旋轉軸</span>
          </div>

          {lineEntities.length === 0 ? (
            <div className="p-3 bg-amber-950/40 border border-amber-800/50 rounded-lg text-amber-300 text-[11px] flex items-start gap-2">
              <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
              <span>草圖中無可用直線作為旋轉軸，請先繪製軸線或建構線</span>
            </div>
          ) : (
            <div className="space-y-2">
              <select
                value={selectedAxisId}
                onChange={(e) => setSelectedAxisId(e.target.value)}
                className="w-full px-3 py-2 bg-neutral-950 border border-cyan-500/40 rounded-lg text-cyan-200 font-mono text-xs focus:outline-none focus:border-cyan-400 transition-colors"
              >
                {lineEntities.map((line) => {
                  const dx = line.end.x - line.start.x;
                  const dy = line.end.y - line.start.y;
                  const len = Math.hypot(dx, dy).toFixed(1);
                  const label = `線段 #${line.id.slice(0, 6)} (${line.isConstruction ? '建構線' : '實線'}, 長度: ${len}mm)`;
                  return (
                    <option key={line.id} value={line.id}>
                      {label}
                    </option>
                  );
                })}
              </select>

              {currentAxisLine && (
                <div className="p-2 bg-neutral-950/60 rounded border border-neutral-800 text-[11px] font-mono text-neutral-400 space-y-0.5">
                  <div className="flex justify-between">
                    <span>起點: ({currentAxisLine.start.x.toFixed(1)}, {currentAxisLine.start.y.toFixed(1)})</span>
                    <span>終點: ({currentAxisLine.end.x.toFixed(1)}, {currentAxisLine.end.y.toFixed(1)})</span>
                  </div>
                  <div className="flex justify-between text-neutral-500 text-[10px]">
                    <span>屬性: {currentAxisLine.isConstruction ? '建構線 (Construction)' : '輪廓實線 (Normal Line)'}</span>
                    <span className="text-cyan-400 font-semibold">✓ 目前已套用</span>
                  </div>
                </div>
              )}
            </div>
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

          {/* 快速設值按鈕 */}
          <div className="flex items-center gap-1.5 pt-0.5">
            <span className="text-[11px] text-neutral-500 mr-1">快速設值:</span>
            {[90, 180, 270, 360].map((deg) => (
              <button
                key={deg}
                type="button"
                onClick={() => setAngleDeg(deg)}
                className={`flex-1 py-1 px-1.5 rounded text-[11px] font-mono font-semibold border transition-colors cursor-pointer ${
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
            className={`w-full p-2.5 rounded-lg border flex items-center justify-between transition-colors cursor-pointer ${
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
            並存入特徵樹，透過 OpenCASCADE CSG 進行累進評估與渲染。
          </span>
        </div>

        {/* 底部按鈕列 */}
        <div className="pt-2 flex items-center justify-end gap-2 border-t border-neutral-800">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded-lg border border-neutral-800 font-semibold transition-colors cursor-pointer"
          >
            取消 (Cancel)
          </button>
          <button
            type="submit"
            disabled={!selectedSketchId || !selectedAxisId}
            className={`px-5 py-2 rounded-lg font-bold flex items-center gap-1.5 shadow-lg transition-colors cursor-pointer ${
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

export const RevolveFeatureModal: React.FC<RevolveFeatureModalProps> = ({
  isOpen,
  mode,
  onClose,
}) => {
  if (!isOpen) return null;
  return <RevolveFeatureModalContent mode={mode} onClose={onClose} />;
};

export default RevolveFeatureModal;
