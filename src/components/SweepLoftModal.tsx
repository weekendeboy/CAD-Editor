import React, { useState, useEffect } from 'react';
import { useCADStore } from '../store/cadStore';
import { SketchFeature, SweepFeature, LoftFeature } from '../types/cad';
import {
  Route,
  Layers,
  X,
  Check,
  ArrowUp,
  ArrowDown,
  Trash2,
  AlertTriangle,
  Info,
  Plus,
  Sparkles,
  Spline,
  Box,
} from 'lucide-react';

export interface SweepLoftModalProps {
  isOpen: boolean;
  mode: 'SWEEP' | 'LOFT';
  onClose: () => void;
}

export const SweepLoftModal: React.FC<SweepLoftModalProps> = ({
  isOpen,
  mode,
  onClose,
}) => {
  const { document, activeSketchId, addFeature, setViewMode } = useCADStore();

  // 取得目前特徵樹中所有草圖特徵
  const allSketches = (document?.featureTree || []).filter(
    (f): f is SketchFeature => f.type === 'SKETCH'
  );

  // 表單通用狀態
  const [featureName, setFeatureName] = useState('');

  // 掃出 (SWEEP) 專屬狀態
  const [selectedProfileSketchId, setSelectedProfileSketchId] = useState('');
  const [selectedPathSketchId, setSelectedPathSketchId] = useState('');

  // 疊層拉伸 (LOFT) 專屬狀態
  const [selectedSketchIds, setSelectedSketchIds] = useState<string[]>([]);
  const [sketchToAdd, setSketchToAdd] = useState('');
  const [ruled, setRuled] = useState(false);
  const [isSolid, setIsSolid] = useState(true);

  // 篩選具備封閉輪廓的草圖清單（可用於截面 profile）
  const profileSketches = allSketches.filter(
    (s) => s.profiles && s.profiles.length > 0
  );

  // 篩選具備可用路徑幾何圖元的草圖清單（非建構線）
  const pathCandidateSketches = allSketches.filter(
    (s) => s.entities && s.entities.some((e) => !e.isConstruction)
  );

  // 當彈窗開啟或 mode 切換時，重新初始化表單數值
  useEffect(() => {
    if (!isOpen) return;

    const tree = document?.featureTree || [];

    if (mode === 'SWEEP') {
      const count = tree.filter((f) => f.type === 'SWEEP').length + 1;
      setFeatureName(`Sweep${count}`);

      // 預設截面草圖：若當前 activeSketchId 具有封閉輪廓則優先選取，否則選取第 1 個可用草圖
      const activeIsProfile = profileSketches.find((s) => s.id === activeSketchId);
      const initialProfileId = activeIsProfile
        ? activeIsProfile.id
        : profileSketches.length > 0
        ? profileSketches[0].id
        : '';
      setSelectedProfileSketchId(initialProfileId);

      // 預設路徑草圖：選取與截面不同之草圖
      const initialPathSketch = pathCandidateSketches.find(
        (s) => s.id !== initialProfileId
      );
      setSelectedPathSketchId(initialPathSketch ? initialPathSketch.id : '');
    } else {
      const count = tree.filter((f) => f.type === 'LOFT').length + 1;
      setFeatureName(`Loft${count}`);

      // 疊層拉伸預設加入現有的前 2 組草圖（若有）
      const initialLoftSketches = profileSketches.slice(0, 2).map((s) => s.id);
      setSelectedSketchIds(initialLoftSketches);
      setSketchToAdd('');
      setRuled(false);
      setIsSolid(true);
    }
  }, [isOpen, mode, activeSketchId, document?.featureTree]);

  // 當 Sweep 截面草圖切換時，自動校正路徑草圖避免衝突
  const handleProfileChange = (newProfileId: string) => {
    setSelectedProfileSketchId(newProfileId);
    if (selectedPathSketchId === newProfileId) {
      const nextPath = pathCandidateSketches.find((s) => s.id !== newProfileId);
      setSelectedPathSketchId(nextPath ? nextPath.id : '');
    }
  };

  // Loft 斷面調整函式
  const handleAddLoftSketch = () => {
    if (!sketchToAdd || selectedSketchIds.includes(sketchToAdd)) return;
    setSelectedSketchIds((prev) => [...prev, sketchToAdd]);
    setSketchToAdd('');
  };

  const handleRemoveLoftSketch = (idToRemove: string) => {
    setSelectedSketchIds((prev) => prev.filter((id) => id !== idToRemove));
  };

  const handleMoveLoftSketch = (index: number, direction: 'UP' | 'DOWN') => {
    const targetIndex = direction === 'UP' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= selectedSketchIds.length) return;

    setSelectedSketchIds((prev) => {
      const next = [...prev];
      const temp = next[index];
      next[index] = next[targetIndex];
      next[targetIndex] = temp;
      return next;
    });
  };

  if (!isOpen) return null;

  const isSweep = mode === 'SWEEP';

  // 驗證檢查
  const isSweepValid =
    Boolean(selectedProfileSketchId) &&
    Boolean(selectedPathSketchId) &&
    selectedProfileSketchId !== selectedPathSketchId;

  const isLoftValid = selectedSketchIds.length >= 2;

  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedName =
      featureName.trim() || (isSweep ? 'Sweep1' : 'Loft1');

    const generateId = () =>
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${isSweep ? 'sweep' : 'loft'}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    if (isSweep) {
      if (!isSweepValid) return;

      const newFeature: SweepFeature = {
        id: generateId(),
        name: trimmedName,
        type: 'SWEEP',
        profileSketchId: selectedProfileSketchId,
        pathSketchId: selectedPathSketchId,
        suppressed: false,
        visible: true,
        dependencies: [selectedProfileSketchId, selectedPathSketchId],
      };

      addFeature(newFeature);
    } else {
      if (!isLoftValid) return;

      const newFeature: LoftFeature = {
        id: generateId(),
        name: trimmedName,
        type: 'LOFT',
        sketchIds: selectedSketchIds,
        isSolid,
        ruled,
        suppressed: false,
        visible: true,
        dependencies: [...selectedSketchIds],
      };

      addFeature(newFeature);
    }

    // 自動切換視圖模式至 3D 並關閉彈窗
    setViewMode('3D');
    onClose();
  };

  // 可供 Loft 新增之尚未選取的草圖
  const unselectedLoftSketches = allSketches.filter(
    (s) => !selectedSketchIds.includes(s.id)
  );

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className="w-full max-w-md bg-neutral-950 border border-neutral-800 rounded-xl shadow-2xl overflow-hidden flex flex-col text-neutral-200 select-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* SW 經典對話框頂部 Header */}
        <div
          className={`h-12 px-4 border-b flex items-center justify-between shrink-0 font-sans ${
            isSweep
              ? 'bg-teal-950/60 border-teal-800/40'
              : 'bg-violet-950/60 border-violet-800/40'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <div
              className={`p-1.5 rounded-lg border shadow-sm ${
                isSweep
                  ? 'bg-teal-600/20 border-teal-500/30 text-teal-400'
                  : 'bg-violet-600/20 border-violet-500/30 text-violet-400'
              }`}
            >
              {isSweep ? <Route size={18} /> : <Layers size={18} />}
            </div>
            <div className="flex flex-col">
              <span className="font-bold text-sm text-neutral-100 flex items-center gap-1.5">
                {isSweep ? '掃出長料 (Sweep Boss)' : '疊層拉伸 (Loft Boss)'}
              </span>
              <span className="text-[11px] text-neutral-400">
                {isSweep
                  ? '沿導引路徑掃出草圖輪廓截面'
                  : '在多個草圖斷面之間建立過渡實體'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800/80 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* 表單主體 */}
        <form onSubmit={handleConfirm} className="p-4 space-y-4 max-h-[80vh] overflow-y-auto">
          {/* 特徵名稱 */}
          <div>
            <label className="block text-xs font-semibold text-neutral-300 mb-1">
              特徵名稱 (Feature Name)
            </label>
            <input
              type="text"
              value={featureName}
              onChange={(e) => setFeatureName(e.target.value)}
              className="w-full px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-sm text-neutral-100 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500/50 transition-all font-mono"
              placeholder={isSweep ? 'Sweep1' : 'Loft1'}
            />
          </div>

          {/* ======================= 掃出模式專屬欄位 ======================= */}
          {isSweep && (
            <div className="space-y-3.5">
              {/* 防呆提示：有效草圖少於 2 個 */}
              {allSketches.length < 2 && (
                <div className="p-3 bg-amber-950/40 border border-amber-800/50 rounded-lg flex items-start gap-2.5 text-amber-200/90 text-xs">
                  <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
                  <span>掃出特徵需至少 2 組草圖（一組輪廓截面，一組導引路徑）。請先建立第二組草圖。</span>
                </div>
              )}

              {/* 截面草圖 (Profile Sketch) */}
              <div>
                <label className="block text-xs font-semibold text-neutral-300 mb-1 flex items-center justify-between">
                  <span>截面草圖 (Profile Sketch)</span>
                  <span className="text-[10px] text-teal-400 font-normal">需包含封閉輪廓</span>
                </label>
                <select
                  value={selectedProfileSketchId}
                  onChange={(e) => handleProfileChange(e.target.value)}
                  className="w-full px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-sm text-neutral-100 focus:outline-none focus:border-teal-500 transition-colors"
                >
                  {profileSketches.length === 0 ? (
                    <option value="" disabled>
                      尚無包含封閉輪廓的草圖
                    </option>
                  ) : (
                    profileSketches.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.profiles?.length || 0} 個封閉輪廓)
                      </option>
                    ))
                  )}
                </select>
                {selectedProfileSketchId && (
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-400">
                    <Info size={12} className="text-teal-400" />
                    <span>
                      已選取截面：
                      {allSketches.find((s) => s.id === selectedProfileSketchId)?.name}
                    </span>
                  </div>
                )}
              </div>

              {/* 導引路徑草圖 (Path Sketch) */}
              <div>
                <label className="block text-xs font-semibold text-neutral-300 mb-1 flex items-center justify-between">
                  <span>導引路徑草圖 (Path Sketch)</span>
                  <span className="text-[10px] text-teal-400 font-normal">草圖路徑軌跡</span>
                </label>
                <select
                  value={selectedPathSketchId}
                  onChange={(e) => setSelectedPathSketchId(e.target.value)}
                  className="w-full px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-sm text-neutral-100 focus:outline-none focus:border-teal-500 transition-colors"
                >
                  {pathCandidateSketches.filter((s) => s.id !== selectedProfileSketchId).length === 0 ? (
                    <option value="" disabled>
                      尚無可用的導引路徑草圖
                    </option>
                  ) : (
                    pathCandidateSketches
                      .filter((s) => s.id !== selectedProfileSketchId)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.entities?.filter((e) => !e.isConstruction).length || 0} 條線段)
                        </option>
                      ))
                  )}
                </select>
                {selectedPathSketchId && (
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-400">
                    <Info size={12} className="text-teal-400" />
                    <span>
                      已選取路徑：
                      {allSketches.find((s) => s.id === selectedPathSketchId)?.name}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ======================= 疊層拉伸模式專屬欄位 ======================= */}
          {!isSweep && (
            <div className="space-y-3.5">
              {/* 斷面草圖清單說明與防呆 */}
              {selectedSketchIds.length < 2 && (
                <div className="p-3 bg-amber-950/40 border border-amber-800/50 rounded-lg flex items-start gap-2.5 text-amber-200/90 text-xs">
                  <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
                  <span>疊層拉伸特徵需依序選取至少 2 組斷面草圖。</span>
                </div>
              )}

              {/* 斷面草圖清單 */}
              <div>
                <label className="block text-xs font-semibold text-neutral-300 mb-1 flex items-center justify-between">
                  <span>斷面草圖順序 (Section Sketches)</span>
                  <span className="text-[10px] text-violet-400 font-mono font-medium">
                    已選取 {selectedSketchIds.length} 個斷面
                  </span>
                </label>

                {/* 已選斷面列表 */}
                <div className="space-y-1.5 max-h-48 overflow-y-auto p-1 bg-neutral-900 border border-neutral-800 rounded-lg">
                  {selectedSketchIds.length === 0 ? (
                    <div className="py-4 text-center text-xs text-neutral-500">
                      尚未加入任何斷面草圖
                    </div>
                  ) : (
                    selectedSketchIds.map((sketchId, index) => {
                      const sketch = allSketches.find((s) => s.id === sketchId);
                      return (
                        <div
                          key={sketchId}
                          className="flex items-center justify-between px-2.5 py-1.5 bg-neutral-950/80 border border-neutral-800/80 rounded-md text-xs"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-5 h-5 rounded-full bg-violet-600/30 border border-violet-500/40 text-violet-300 text-[10px] font-bold font-mono flex items-center justify-center shrink-0">
                              {index + 1}
                            </span>
                            <span className="font-medium text-neutral-200 truncate">
                              {sketch ? sketch.name : sketchId}
                            </span>
                            {sketch?.profiles && sketch.profiles.length > 0 && (
                              <span className="text-[10px] px-1.5 py-0.2 bg-violet-950 text-violet-400 rounded border border-violet-800/40 shrink-0">
                                {sketch.profiles.length} 輪廓
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-1 shrink-0 ml-2">
                            <button
                              type="button"
                              onClick={() => handleMoveLoftSketch(index, 'UP')}
                              disabled={index === 0}
                              className="p-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 disabled:opacity-25 disabled:hover:text-neutral-400"
                              title="上移順序"
                            >
                              <ArrowUp size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleMoveLoftSketch(index, 'DOWN')}
                              disabled={index === selectedSketchIds.length - 1}
                              className="p-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 disabled:opacity-25 disabled:hover:text-neutral-400"
                              title="下移順序"
                            >
                              <ArrowDown size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveLoftSketch(sketchId)}
                              className="p-1 rounded text-neutral-400 hover:text-red-400 hover:bg-red-950/40 transition-colors"
                              title="移除此斷面"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* 加入新斷面草圖控制項 */}
                {unselectedLoftSketches.length > 0 && (
                  <div className="flex items-center gap-2 mt-2">
                    <select
                      value={sketchToAdd}
                      onChange={(e) => setSketchToAdd(e.target.value)}
                      className="flex-1 px-2.5 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-xs text-neutral-200 focus:outline-none focus:border-violet-500"
                    >
                      <option value="">-- 選取草圖加入斷面 --</option>
                      {unselectedLoftSketches.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.profiles?.length || 0} 輪廓)
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleAddLoftSketch}
                      disabled={!sketchToAdd}
                      className="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:bg-neutral-800 text-white disabled:text-neutral-500 rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors shadow-sm shrink-0"
                    >
                      <Plus size={14} />
                      <span>加入</span>
                    </button>
                  </div>
                )}
              </div>

              {/* 過渡與實體參數 */}
              <div className="space-y-2.5 pt-2 border-t border-neutral-800/80">
                <label className="flex items-center gap-2.5 cursor-pointer select-none text-xs text-neutral-300">
                  <input
                    type="checkbox"
                    checked={ruled}
                    onChange={(e) => setRuled(e.target.checked)}
                    className="w-4 h-4 rounded bg-neutral-900 border-neutral-700 text-violet-600 focus:ring-violet-500/40 focus:ring-offset-0"
                  />
                  <div className="flex flex-col">
                    <span className="font-medium text-neutral-200">直紋面 (Ruled Surface)</span>
                    <span className="text-[11px] text-neutral-400">
                      {ruled
                        ? '直線折面過渡（直線段連接相鄰斷面）'
                        : 'B-Spline 平滑過渡（平滑曲線過渡表面）'}
                    </span>
                  </div>
                </label>

                <label className="flex items-center gap-2.5 cursor-pointer select-none text-xs text-neutral-300">
                  <input
                    type="checkbox"
                    checked={isSolid}
                    onChange={(e) => setIsSolid(e.target.checked)}
                    className="w-4 h-4 rounded bg-neutral-900 border-neutral-700 text-violet-600 focus:ring-violet-500/40 focus:ring-offset-0"
                  />
                  <div className="flex flex-col">
                    <span className="font-medium text-neutral-200">實體成形 (Is Solid)</span>
                    <span className="text-[11px] text-neutral-400">
                      封閉頂底斷面端蓋以構成封閉實體
                    </span>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* 底部按鈕群 */}
          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-neutral-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-xs font-semibold text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isSweep ? !isSweepValid : !isLoftValid}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all shadow-md ${
                isSweep
                  ? 'bg-teal-600 hover:bg-teal-500 disabled:bg-neutral-800 text-white disabled:text-neutral-500 shadow-teal-950/50'
                  : 'bg-violet-600 hover:bg-violet-500 disabled:bg-neutral-800 text-white disabled:text-neutral-500 shadow-violet-950/50'
              }`}
            >
              <Check size={14} />
              <span>{isSweep ? '建立掃出特徵' : '建立疊層拉伸特徵'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
