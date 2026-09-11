import React from 'react';
import { Orbit, Plus, Minus, Check } from 'lucide-react';
import { useCADStore } from '../store/cadStore';

interface CircularArrayPanelProps {
  arrayStep: 'PICK_OBJECTS' | 'PICK_CENTER';
  selectedCount: number;
  onProceedToCenter?: () => void;
}

export const CircularArrayPanel: React.FC<CircularArrayPanelProps> = ({
  arrayStep,
  selectedCount,
  onProceedToCenter,
}) => {
  const arrayItems = useCADStore((state) => state.arrayItems);
  const arrayFillAngle = useCADStore((state) => state.arrayFillAngle);
  const setArrayItems = useCADStore((state) => state.setArrayItems);
  const setArrayFillAngle = useCADStore((state) => state.setArrayFillAngle);

  const handleItemsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val)) {
      setArrayItems(Math.max(2, Math.min(100, val)));
    }
  };

  const handleAngleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      setArrayFillAngle(val);
    }
  };

  return (
    <div
      id="circular-array-settings-panel"
      className="absolute top-4 right-4 z-40 w-72 bg-neutral-900/95 backdrop-blur-md border border-purple-500/40 rounded-xl shadow-2xl p-4 text-neutral-200 select-none animate-in fade-in duration-150"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-purple-500/10 rounded-lg text-purple-400">
            <Orbit size={18} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-neutral-100 tracking-tight">Circular Array</h3>
            <p className="text-[11px] text-neutral-400">環形陣列參數設定</p>
          </div>
        </div>
        <span
          className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
            arrayStep === 'PICK_OBJECTS'
              ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
              : 'bg-purple-500/10 text-purple-300 border-purple-500/30'
          }`}
        >
          {arrayStep === 'PICK_OBJECTS' ? '步驟 1: 選取圖元' : '步驟 2: 指定中心點'}
        </span>
      </div>

      {/* Step guidance */}
      <div className="mt-3 p-2.5 rounded-lg bg-neutral-950/60 border border-neutral-800 text-xs">
        {arrayStep === 'PICK_OBJECTS' ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-neutral-300">
              <span>已選取圖元：</span>
              <span className="font-mono font-bold text-purple-400">{selectedCount} 個</span>
            </div>
            {selectedCount > 0 ? (
              <button
                id="btn-array-next-step"
                onClick={onProceedToCenter}
                className="w-full mt-1.5 py-1.5 bg-purple-600 hover:bg-purple-500 active:bg-purple-700 text-white text-xs font-medium rounded-md flex items-center justify-center gap-1.5 transition-colors shadow-sm"
              >
                <Check size={14} />
                <span>指定中心點 (Enter)</span>
              </button>
            ) : (
              <p className="text-[11px] text-neutral-400">
                點擊畫面中的實體加入陣列選取，或先框選後啟動工具。
              </p>
            )}
          </div>
        ) : (
          <div className="text-neutral-300 space-y-1">
            <p className="font-medium text-purple-300">請在畫布上點擊「陣列中心點」</p>
            <p className="text-[11px] text-neutral-400">
              即時預覽將隨游標旋轉展示，點擊後立刻生成實體。
            </p>
          </div>
        )}
      </div>

      {/* Parameters */}
      <div className="mt-4 space-y-3">
        {/* Items (項目總數) */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <label htmlFor="array-items-input" className="text-neutral-300 font-medium">
              Items (項目總數)
            </label>
            <span className="text-[11px] text-neutral-500 font-mono">預設: 4</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              id="btn-decrement-items"
              onClick={() => setArrayItems(Math.max(2, arrayItems - 1))}
              className="p-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md border border-neutral-700 transition-colors"
              title="減少 1 個項目"
            >
              <Minus size={14} />
            </button>
            <input
              id="array-items-input"
              type="number"
              min={2}
              max={100}
              step={1}
              value={arrayItems}
              onChange={handleItemsChange}
              className="flex-1 bg-neutral-950 border border-neutral-700 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 text-neutral-100 font-mono text-center text-sm py-1 rounded-md outline-none transition-colors"
            />
            <button
              type="button"
              id="btn-increment-items"
              onClick={() => setArrayItems(Math.min(100, arrayItems + 1))}
              className="p-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md border border-neutral-700 transition-colors"
              title="增加 1 個項目"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* Fill Angle (填滿角度) */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <label htmlFor="array-angle-input" className="text-neutral-300 font-medium">
              Fill Angle (填滿角度)
            </label>
            <span className="text-[11px] text-neutral-500 font-mono">預設: 360°</span>
          </div>
          <div className="relative">
            <input
              id="array-angle-input"
              type="number"
              step={1}
              value={arrayFillAngle}
              onChange={handleAngleChange}
              className="w-full bg-neutral-950 border border-neutral-700 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 text-neutral-100 font-mono text-sm py-1.5 px-3 pr-8 rounded-md outline-none transition-colors"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 text-xs font-mono">
              °
            </span>
          </div>

          {/* Quick presets */}
          <div className="flex items-center gap-1.5 mt-2">
            {[360, 180, 90, -360].map((deg) => (
              <button
                key={deg}
                type="button"
                onClick={() => setArrayFillAngle(deg)}
                className={`flex-1 py-1 text-[11px] font-mono rounded border transition-colors ${
                  arrayFillAngle === deg
                    ? 'bg-purple-600/30 border-purple-500 text-purple-300 font-bold'
                    : 'bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800'
                }`}
              >
                {deg > 0 ? `${deg}°` : `${deg}°`}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
