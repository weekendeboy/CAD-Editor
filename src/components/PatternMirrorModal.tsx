import React, { useState, useEffect } from 'react';
import { useCADStore } from '../store/cadStore';
import {
  LinearPatternFeature,
  CircularPatternFeature,
  Mirror3DFeature,
  DatumPlaneFeature,
  Point3D,
} from '../types/cad';
import {
  LayoutGrid,
  Orbit,
  FlipHorizontal,
  X,
  Check,
  Layers,
  ArrowRight,
  RotateCw,
  Info,
  Maximize2,
  Box,
} from 'lucide-react';

export interface PatternMirrorModalProps {
  isOpen: boolean;
  mode: 'LINEAR_PATTERN' | 'CIRCULAR_PATTERN' | 'MIRROR_3D';
  onClose: () => void;
}

export const PatternMirrorModal: React.FC<PatternMirrorModalProps> = ({
  isOpen,
  mode,
  onClose,
}) => {
  const { document, addFeature, setViewMode } = useCADStore();

  // 過濾可作為陣列/鏡射目標的 3D 特徵
  const targetableFeatures = (document?.featureTree || []).filter(
    (f) =>
      f.type === 'EXTRUDE' ||
      f.type === 'CUT_EXTRUDE' ||
      f.type === 'REVOLVE' ||
      f.type === 'REVOLVE_CUT'
  );

  // 過濾特徵樹中的自訂基準面
  const datumPlaneFeatures = (document?.featureTree || []).filter(
    (f): f is DatumPlaneFeature => f.type === 'DATUM_PLANE'
  );

  // 共用狀態
  const [featureName, setFeatureName] = useState('');
  const [selectedTargetFeatureIds, setSelectedTargetFeatureIds] = useState<string[]>([]);

  // 線性陣列 (LINEAR_PATTERN) 狀態
  const [dir1, setDir1] = useState<[number, number, number]>([1, 0, 0]);
  const [spacing1, setSpacing1] = useState<number>(30);
  const [count1, setCount1] = useState<number>(3);

  const [enableDir2, setEnableDir2] = useState<boolean>(false);
  const [dir2, setDir2] = useState<[number, number, number]>([0, 1, 0]);
  const [spacing2, setSpacing2] = useState<number>(30);
  const [count2, setCount2] = useState<number>(2);

  // 環狀陣列 (CIRCULAR_PATTERN) 狀態
  const [axisDir, setAxisDir] = useState<[number, number, number]>([0, 0, 1]);
  const [axisOrigin, setAxisOrigin] = useState<[number, number, number]>([0, 0, 0]);
  const [circCount, setCircCount] = useState<number>(4);
  const [angleDeg, setAngleDeg] = useState<number>(360);
  const [equalSpacing, setEqualSpacing] = useState<boolean>(true);

  // 3D 鏡射 (MIRROR_3D) 狀態
  const [mirrorPlaneId, setMirrorPlaneId] = useState<string>('datum-front');

  // 初始化與模式切換
  useEffect(() => {
    if (!isOpen) return;

    const tree = document?.featureTree || [];

    // 設定預設名稱
    if (mode === 'LINEAR_PATTERN') {
      const count = tree.filter((f) => f.type === 'LINEAR_PATTERN').length + 1;
      setFeatureName(`LinearPattern${count}`);
    } else if (mode === 'CIRCULAR_PATTERN') {
      const count = tree.filter((f) => f.type === 'CIRCULAR_PATTERN').length + 1;
      setFeatureName(`CircularPattern${count}`);
    } else if (mode === 'MIRROR_3D') {
      const count = tree.filter((f) => f.type === 'MIRROR_3D').length + 1;
      setFeatureName(`Mirror3D${count}`);
    }

    // 預設勾選最新建立的一項特徵
    if (targetableFeatures.length > 0) {
      setSelectedTargetFeatureIds([targetableFeatures[targetableFeatures.length - 1].id]);
    } else {
      setSelectedTargetFeatureIds([]);
    }

    // 重設數值欄位為工業級標準預設值
    setDir1([1, 0, 0]);
    setSpacing1(30);
    setCount1(3);

    setEnableDir2(false);
    setDir2([0, 1, 0]);
    setSpacing2(30);
    setCount2(2);

    setAxisDir([0, 0, 1]);
    setAxisOrigin([0, 0, 0]);
    setCircCount(4);
    setAngleDeg(360);
    setEqualSpacing(true);

    setMirrorPlaneId('datum-front');
  }, [isOpen, mode, document?.featureTree]);

  if (!isOpen) return null;

  // 切換目標特徵核取狀態
  const toggleTargetFeature = (id: string) => {
    setSelectedTargetFeatureIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  // 確定建立表單處置
  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedTargetFeatureIds.length === 0) return;

    if (mode === 'LINEAR_PATTERN') {
      const parsedDir1: Point3D = { x: dir1[0], y: dir1[1], z: dir1[2] };
      const parsedDir2: Point3D | undefined = enableDir2
        ? { x: dir2[0], y: dir2[1], z: dir2[2] }
        : undefined;

      const newFeature: LinearPatternFeature = {
        id: `linear-pattern-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name: featureName.trim() || 'LinearPattern1',
        type: 'LINEAR_PATTERN',
        targetFeatureIds: selectedTargetFeatureIds,
        dir1: parsedDir1,
        count1: Math.max(2, Number(count1) || 2),
        spacing1: Number(spacing1) || 30,
        dir2: parsedDir2,
        count2: enableDir2 ? Math.max(1, Number(count2) || 1) : undefined,
        spacing2: enableDir2 ? Number(spacing2) || 30 : undefined,
        dependencies: selectedTargetFeatureIds,
        suppressed: false,
        visible: true,
      };

      addFeature(newFeature);
    } else if (mode === 'CIRCULAR_PATTERN') {
      const parsedAxisDir: Point3D = { x: axisDir[0], y: axisDir[1], z: axisDir[2] };
      const parsedAxisOrigin: Point3D = {
        x: axisOrigin[0],
        y: axisOrigin[1],
        z: axisOrigin[2],
      };
      const totalAngleRad = (Number(angleDeg) * Math.PI) / 180;

      const newFeature: CircularPatternFeature = {
        id: `circular-pattern-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name: featureName.trim() || 'CircularPattern1',
        type: 'CIRCULAR_PATTERN',
        targetFeatureIds: selectedTargetFeatureIds,
        axisOrigin: parsedAxisOrigin,
        axisDirection: parsedAxisDir,
        count: Math.max(2, Number(circCount) || 2),
        totalAngle: totalAngleRad,
        equalSpacing,
        dependencies: selectedTargetFeatureIds,
        suppressed: false,
        visible: true,
      };

      addFeature(newFeature);
    } else if (mode === 'MIRROR_3D') {
      const deps = [...selectedTargetFeatureIds];
      if (
        mirrorPlaneId &&
        !['datum-front', 'datum-top', 'datum-right'].includes(mirrorPlaneId)
      ) {
        deps.push(mirrorPlaneId);
      }

      const newFeature: Mirror3DFeature = {
        id: `mirror-3d-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name: featureName.trim() || 'Mirror3D1',
        type: 'MIRROR_3D',
        targetFeatureIds: selectedTargetFeatureIds,
        mirrorPlaneFeatureId: mirrorPlaneId,
        dependencies: deps,
        suppressed: false,
        visible: true,
      };

      addFeature(newFeature);
    }

    // 自動將 viewMode 切換為 '3D' 並關閉彈窗
    setViewMode('3D');
    onClose();
  };

  // UI 主題設定
  const isLinear = mode === 'LINEAR_PATTERN';
  const isCircular = mode === 'CIRCULAR_PATTERN';
  const isMirror = mode === 'MIRROR_3D';

  const titleText = isLinear
    ? '線性陣列 (Linear Pattern)'
    : isCircular
    ? '環狀陣列 (Circular Pattern)'
    : '3D 鏡射 (3D Mirror)';

  const subTitleText = isLinear
    ? '沿指定方向向量產生重複 3D 特徵矩陣'
    : isCircular
    ? '圍繞旋轉中心軸均勻或定角複製 3D 特徵'
    : '跨基準對稱鏡射實體特徵';

  const themeBorder = isLinear
    ? 'bg-blue-950/60 border-blue-800/40 text-blue-400'
    : isCircular
    ? 'bg-purple-950/60 border-purple-800/40 text-purple-400'
    : 'bg-emerald-950/60 border-emerald-800/40 text-emerald-400';

  const themeIconBox = isLinear
    ? 'bg-blue-600/20 text-blue-400 border-blue-500/40'
    : isCircular
    ? 'bg-purple-600/20 text-purple-400 border-purple-500/40'
    : 'bg-emerald-600/20 text-emerald-400 border-emerald-500/40';

  const themeBtnColor = isLinear
    ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/20'
    : isCircular
    ? 'bg-purple-600 hover:bg-purple-500 text-white shadow-purple-600/20'
    : 'bg-emerald-600 hover:bg-emerald-500 text-neutral-950 font-extrabold shadow-emerald-600/20';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className="w-full max-w-lg bg-neutral-950 border border-neutral-800 rounded-xl shadow-2xl overflow-hidden flex flex-col text-neutral-200 select-none max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 對話框頂部 Header */}
        <div className={`h-12 px-4 border-b flex items-center justify-between shrink-0 font-sans ${themeBorder}`}>
          <div className="flex items-center gap-2.5">
            <div className={`p-1.5 rounded-lg border shadow-sm ${themeIconBox}`}>
              {isLinear && <LayoutGrid size={20} />}
              {isCircular && <Orbit size={20} />}
              {isMirror && <FlipHorizontal size={20} />}
            </div>
            <div>
              <h3 className="text-sm font-bold tracking-wide text-white flex items-center gap-2">
                {titleText}
              </h3>
              <p className="text-[11px] text-neutral-400">{subTitleText}</p>
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
        <form onSubmit={handleConfirm} className="p-5 space-y-4 font-sans text-xs overflow-y-auto custom-scrollbar">
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
              placeholder={
                isLinear ? 'LinearPattern1' : isCircular ? 'CircularPattern1' : 'Mirror3D1'
              }
            />
          </div>

          {/* 目標實體特徵選取 */}
          <div className="space-y-1.5">
            <label className="block font-semibold text-neutral-300 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Box size={14} className="text-blue-400" />
                <span>目標實體特徵 (Target Features to Pattern/Mirror)</span>
              </span>
              <span className="text-[10px] font-mono text-neutral-400">
                已選取 {selectedTargetFeatureIds.length} 項
              </span>
            </label>

            {targetableFeatures.length === 0 ? (
              <div className="p-3 bg-amber-950/40 border border-amber-800/40 rounded-lg text-amber-300 text-[11px]">
                ⚠️ 目前特徵樹中尚未建立 Extrude 或 Revolve 實體特徵，請先建立基礎 3D 特徵。
              </div>
            ) : (
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-2 max-h-36 overflow-y-auto space-y-1 divide-y divide-neutral-850">
                {targetableFeatures.map((feat) => {
                  const isChecked = selectedTargetFeatureIds.includes(feat.id);
                  return (
                    <label
                      key={feat.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-neutral-800/60 cursor-pointer text-xs transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleTargetFeature(feat.id)}
                        className="w-4 h-4 rounded border-neutral-700 bg-neutral-950 text-blue-500 focus:ring-blue-500/40"
                      />
                      <span className="font-mono text-white flex-1">{feat.name}</span>
                      <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400">
                        {feat.type}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* 【1. 線性陣列專屬欄位】 */}
          {isLinear && (
            <div className="space-y-4 border-t border-neutral-850 pt-3">
              {/* 方向 1 */}
              <div className="p-3 bg-neutral-900/90 border border-neutral-800 rounded-lg space-y-3">
                <div className="flex items-center justify-between font-bold text-blue-300">
                  <span className="flex items-center gap-1.5">
                    <ArrowRight size={14} className="text-blue-400" />
                    方向 1 (Direction 1)
                  </span>
                </div>

                {/* 快捷切換方向 */}
                <div className="space-y-1">
                  <span className="text-[11px] text-neutral-400 block font-semibold">
                    軸向向量預設：
                  </span>
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      onClick={() => setDir1([1, 0, 0])}
                      className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                        dir1[0] === 1 && dir1[1] === 0 && dir1[2] === 0
                          ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                          : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                      }`}
                    >
                      X 軸 [1, 0, 0]
                    </button>
                    <button
                      type="button"
                      onClick={() => setDir1([0, 1, 0])}
                      className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                        dir1[0] === 0 && dir1[1] === 1 && dir1[2] === 0
                          ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                          : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                      }`}
                    >
                      Y 軸 [0, 1, 0]
                    </button>
                    <button
                      type="button"
                      onClick={() => setDir1([0, 0, 1])}
                      className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                        dir1[0] === 0 && dir1[1] === 0 && dir1[2] === 1
                          ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                          : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                      }`}
                    >
                      Z 軸 [0, 0, 1]
                    </button>
                  </div>
                </div>

                {/* 間距 & 數量 */}
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="space-y-1">
                    <label className="text-neutral-300 block font-semibold">
                      間距 Spacing 1 (mm)
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={spacing1}
                      onChange={(e) => setSpacing1(Number(e.target.value))}
                      className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded text-white font-mono focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-neutral-300 block font-semibold">
                      實例數量 Count 1
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={count1}
                      onChange={(e) => setCount1(Number(e.target.value))}
                      className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded text-white font-mono focus:outline-none focus:border-blue-500 font-bold"
                    />
                  </div>
                </div>
              </div>

              {/* 方向 2（可勾選啟用） */}
              <div className="p-3 bg-neutral-900/90 border border-neutral-800 rounded-lg space-y-3">
                <label className="flex items-center gap-2 cursor-pointer font-bold text-neutral-200">
                  <input
                    type="checkbox"
                    checked={enableDir2}
                    onChange={(e) => setEnableDir2(e.target.checked)}
                    className="w-4 h-4 rounded border-neutral-700 bg-neutral-950 text-blue-500 focus:ring-blue-500/40"
                  />
                  <span>啟用方向 2 (Enable Direction 2)</span>
                </label>

                {enableDir2 && (
                  <div className="space-y-3 pt-1 border-t border-neutral-800">
                    <div className="space-y-1">
                      <span className="text-[11px] text-neutral-400 block font-semibold">
                        軸向向量預設：
                      </span>
                      <div className="grid grid-cols-3 gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDir2([1, 0, 0])}
                          className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                            dir2[0] === 1 && dir2[1] === 0 && dir2[2] === 0
                              ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                              : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                          }`}
                        >
                          X 軸 [1, 0, 0]
                        </button>
                        <button
                          type="button"
                          onClick={() => setDir2([0, 1, 0])}
                          className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                            dir2[0] === 0 && dir2[1] === 1 && dir2[2] === 0
                              ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                              : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                          }`}
                        >
                          Y 軸 [0, 1, 0]
                        </button>
                        <button
                          type="button"
                          onClick={() => setDir2([0, 0, 1])}
                          className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                            dir2[0] === 0 && dir2[1] === 0 && dir2[2] === 1
                              ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                              : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                          }`}
                        >
                          Z 軸 [0, 0, 1]
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-neutral-300 block font-semibold">
                          間距 Spacing 2 (mm)
                        </label>
                        <input
                          type="number"
                          step="any"
                          value={spacing2}
                          onChange={(e) => setSpacing2(Number(e.target.value))}
                          className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded text-white font-mono focus:outline-none focus:border-blue-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-neutral-300 block font-semibold">
                          實例數量 Count 2
                        </label>
                        <input
                          type="number"
                          step="any"
                          value={count2}
                          onChange={(e) => setCount2(Number(e.target.value))}
                          className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded text-white font-mono focus:outline-none focus:border-blue-500 font-bold"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 【2. 環狀陣列專屬欄位】 */}
          {isCircular && (
            <div className="space-y-3 border-t border-neutral-850 pt-3">
              {/* 旋轉中心軸方向向量 */}
              <div className="p-3 bg-neutral-900/90 border border-neutral-800 rounded-lg space-y-2">
                <label className="text-purple-300 font-bold flex items-center gap-1.5">
                  <RotateCw size={14} className="text-purple-400" />
                  <span>旋轉中心軸方向向量 (Axis Direction)</span>
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setAxisDir([1, 0, 0])}
                    className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                      axisDir[0] === 1 && axisDir[1] === 0 && axisDir[2] === 0
                        ? 'bg-purple-600/30 border-purple-500 text-purple-300'
                        : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                    }`}
                  >
                    X 軸 [1, 0, 0]
                  </button>
                  <button
                    type="button"
                    onClick={() => setAxisDir([0, 1, 0])}
                    className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                      axisDir[0] === 0 && axisDir[1] === 1 && axisDir[2] === 0
                        ? 'bg-purple-600/30 border-purple-500 text-purple-300'
                        : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                    }`}
                  >
                    Y 軸 [0, 1, 0]
                  </button>
                  <button
                    type="button"
                    onClick={() => setAxisDir([0, 0, 1])}
                    className={`py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                      axisDir[0] === 0 && axisDir[1] === 0 && axisDir[2] === 1
                        ? 'bg-purple-600/30 border-purple-500 text-purple-300'
                        : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                    }`}
                  >
                    Z 軸 [0, 0, 1]
                  </button>
                </div>
              </div>

              {/* 旋轉軸起點 */}
              <div className="p-3 bg-neutral-900/90 border border-neutral-800 rounded-lg space-y-2">
                <label className="text-neutral-300 font-semibold block">
                  旋轉軸起點 (Axis Origin)
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <span className="text-[10px] text-neutral-400 font-mono block">X:</span>
                    <input
                      type="number"
                      step="any"
                      value={axisOrigin[0]}
                      onChange={(e) => setAxisOrigin([Number(e.target.value), axisOrigin[1], axisOrigin[2]])}
                      className="w-full px-2 py-1 bg-neutral-950 border border-neutral-800 rounded text-white font-mono text-xs focus:outline-none focus:border-purple-500"
                    />
                  </div>
                  <div>
                    <span className="text-[10px] text-neutral-400 font-mono block">Y:</span>
                    <input
                      type="number"
                      step="any"
                      value={axisOrigin[1]}
                      onChange={(e) => setAxisOrigin([axisOrigin[0], Number(e.target.value), axisOrigin[2]])}
                      className="w-full px-2 py-1 bg-neutral-950 border border-neutral-800 rounded text-white font-mono text-xs focus:outline-none focus:border-purple-500"
                    />
                  </div>
                  <div>
                    <span className="text-[10px] text-neutral-400 font-mono block">Z:</span>
                    <input
                      type="number"
                      step="any"
                      value={axisOrigin[2]}
                      onChange={(e) => setAxisOrigin([axisOrigin[0], axisOrigin[1], Number(e.target.value)])}
                      className="w-full px-2 py-1 bg-neutral-950 border border-neutral-800 rounded text-white font-mono text-xs focus:outline-none focus:border-purple-500"
                    />
                  </div>
                </div>
              </div>

              {/* 數量 & 角度 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-neutral-300 block font-semibold">
                    實例總數 (Instances)
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={circCount}
                    onChange={(e) => setCircCount(Number(e.target.value))}
                    className="w-full px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded text-white font-mono font-bold focus:outline-none focus:border-purple-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-neutral-300 block font-semibold">
                    總角度 (Angle °)
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={angleDeg}
                    onChange={(e) => setAngleDeg(Number(e.target.value))}
                    className="w-full px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded text-white font-mono focus:outline-none focus:border-purple-500"
                  />
                </div>
              </div>

              {/* 等間距排列 */}
              <label className="flex items-center gap-2.5 p-3 bg-neutral-900/90 border border-neutral-800 rounded-lg cursor-pointer hover:bg-neutral-850 transition-colors">
                <input
                  type="checkbox"
                  checked={equalSpacing}
                  onChange={(e) => setEqualSpacing(e.target.checked)}
                  className="w-4 h-4 rounded border-neutral-700 bg-neutral-950 text-purple-500 focus:ring-purple-500/40"
                />
                <div>
                  <span className="font-bold text-white block">等間距排列 (Equal Spacing)</span>
                  <span className="text-[11px] text-neutral-400 block">
                    自動依總角度將實體均勻分佈排列
                  </span>
                </div>
              </label>
            </div>
          )}

          {/* 【3. 3D 鏡射專屬欄位】 */}
          {isMirror && (
            <div className="space-y-3 border-t border-neutral-850 pt-3">
              <div className="space-y-1.5">
                <label className="block font-semibold text-neutral-300 flex items-center gap-1.5">
                  <FlipHorizontal size={14} className="text-emerald-400" />
                  <span>鏡射基準面 (Mirror Plane)</span>
                </label>
                <select
                  value={mirrorPlaneId}
                  onChange={(e) => setMirrorPlaneId(e.target.value)}
                  className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-emerald-500 transition-colors"
                >
                  <option value="datum-front">Front Plane (XY)</option>
                  <option value="datum-top">Top Plane (XZ)</option>
                  <option value="datum-right">Right Plane (YZ)</option>
                  {datumPlaneFeatures.map((plane) => (
                    <option key={plane.id} value={plane.id}>
                      {plane.name} (自訂基準面)
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* 提示備註 */}
          <div className="p-2.5 bg-neutral-900/80 border border-neutral-800/80 rounded-lg flex items-start gap-2 text-[11px] text-neutral-400">
            <Info size={15} className="text-blue-400 shrink-0 mt-0.5" />
            <span>
              確認建立後，系統將組合 3D 特徵陣列/鏡射，並自動寫入 SolidWorks 特徵樹，切換至 3D 畫布呈現運算結果。
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
              disabled={selectedTargetFeatureIds.length === 0}
              className={`px-5 py-2 rounded-lg font-bold flex items-center gap-1.5 shadow-lg transition-colors ${
                selectedTargetFeatureIds.length === 0
                  ? 'bg-neutral-800 text-neutral-500 border border-neutral-700 cursor-not-allowed'
                  : themeBtnColor
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

export default PatternMirrorModal;
