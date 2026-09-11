import React from 'react';
import { LayoutGrid, Plus, Minus, Check, ArrowRightLeft, ArrowUpDown } from 'lucide-react';
import { useCADStore } from '../store/cadStore';

interface RectangularArrayPanelProps {
  selectedCount: number;
  onConfirm: () => void;
}

export const RectangularArrayPanel: React.FC<RectangularArrayPanelProps> = ({
  selectedCount,
  onConfirm,
}) => {
  const rectArrayCols = useCADStore((state) => state.rectArrayCols);
  const rectArrayRows = useCADStore((state) => state.rectArrayRows);
  const rectArrayColSpacing = useCADStore((state) => state.rectArrayColSpacing);
  const rectArrayRowSpacing = useCADStore((state) => state.rectArrayRowSpacing);

  const setRectArrayCols = useCADStore((state) => state.setRectArrayCols);
  const setRectArrayRows = useCADStore((state) => state.setRectArrayRows);
  const setRectArrayColSpacing = useCADStore((state) => state.setRectArrayColSpacing);
  const setRectArrayRowSpacing = useCADStore((state) => state.setRectArrayRowSpacing);

  const handleColsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val)) {
      setRectArrayCols(Math.max(1, Math.min(100, val)));
    }
  };

  const handleRowsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val)) {
      setRectArrayRows(Math.max(1, Math.min(100, val)));
    }
  };

  const handleColSpacingChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      setRectArrayColSpacing(val);
    }
  };

  const handleRowSpacingChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      setRectArrayRowSpacing(val);
    }
  };

  const totalInstances = rectArrayCols * rectArrayRows;

  return (
    <div
      id="rectangular-array-settings-panel"
      className="absolute top-4 right-4 z-40 w-80 bg-neutral-900/95 backdrop-blur-md border border-blue-500/40 rounded-xl shadow-2xl p-4 text-neutral-200 select-none animate-in fade-in duration-150"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-blue-500/10 rounded-lg text-blue-400">
            <LayoutGrid size={18} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-neutral-100 tracking-tight">Rectangular Array</h3>
            <p className="text-[11px] text-neutral-400">矩形陣列參數設定</p>
          </div>
        </div>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full border bg-blue-500/10 text-blue-300 border-blue-500/30">
          {rectArrayCols} × {rectArrayRows} ({totalInstances})
        </span>
      </div>

      {/* Selected Items & Execution Trigger */}
      <div className="mt-3 p-2.5 rounded-lg bg-neutral-950/60 border border-neutral-800 text-xs">
        <div className="flex items-center justify-between text-neutral-300 mb-1.5">
          <span>來源圖元：</span>
          <span className="font-mono font-bold text-blue-400">{selectedCount} 個選取</span>
        </div>
        {selectedCount > 0 ? (
          <button
            type="button"
            id="btn-rect-array-confirm"
            onClick={onConfirm}
            className="w-full py-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-xs font-semibold rounded-md flex items-center justify-center gap-1.5 transition-colors shadow-sm"
          >
            <Check size={15} />
            <span>產生矩形陣列 (Enter)</span>
          </button>
        ) : (
          <p className="text-[11px] text-neutral-400 leading-relaxed">
            點擊畫面中的實體加入陣列選取，或先框選後點擊啟動工具。
          </p>
        )}
      </div>

      {/* Array Configuration Inputs */}
      <div className="mt-4 space-y-3.5">
        {/* 1. Columns (行數 / X軸) */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <label htmlFor="rect-array-cols-input" className="text-neutral-300 font-medium flex items-center gap-1">
              <span>Columns (行數 / X軸)</span>
            </label>
            <span className="text-[11px] text-neutral-500 font-mono">X 軸個數</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              id="btn-rect-dec-cols"
              onClick={() => setRectArrayCols(Math.max(1, rectArrayCols - 1))}
              className="p-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md border border-neutral-700 transition-colors"
              title="減少 1 行"
            >
              <Minus size={14} />
            </button>
            <input
              id="rect-array-cols-input"
              type="number"
              min={1}
              max={100}
              step={1}
              value={rectArrayCols}
              onChange={handleColsChange}
              className="flex-1 bg-neutral-950 border border-neutral-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-neutral-100 font-mono text-center text-sm py-1 rounded-md outline-none transition-colors"
            />
            <button
              type="button"
              id="btn-rect-inc-cols"
              onClick={() => setRectArrayCols(Math.min(100, rectArrayCols + 1))}
              className="p-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md border border-neutral-700 transition-colors"
              title="增加 1 行"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* 2. Rows (列數 / Y軸) */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <label htmlFor="rect-array-rows-input" className="text-neutral-300 font-medium flex items-center gap-1">
              <span>Rows (列數 / Y軸)</span>
            </label>
            <span className="text-[11px] text-neutral-500 font-mono">Y 軸個數</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              id="btn-rect-dec-rows"
              onClick={() => setRectArrayRows(Math.max(1, rectArrayRows - 1))}
              className="p-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md border border-neutral-700 transition-colors"
              title="減少 1 列"
            >
              <Minus size={14} />
            </button>
            <input
              id="rect-array-rows-input"
              type="number"
              min={1}
              max={100}
              step={1}
              value={rectArrayRows}
              onChange={handleRowsChange}
              className="flex-1 bg-neutral-950 border border-neutral-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-neutral-100 font-mono text-center text-sm py-1 rounded-md outline-none transition-colors"
            />
            <button
              type="button"
              id="btn-rect-inc-rows"
              onClick={() => setRectArrayRows(Math.min(100, rectArrayRows + 1))}
              className="p-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md border border-neutral-700 transition-colors"
              title="增加 1 列"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* 3. Col Spacing (X軸間距) */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <label htmlFor="rect-array-col-spacing-input" className="text-neutral-300 font-medium flex items-center gap-1">
              <ArrowRightLeft size={13} className="text-blue-400" />
              <span>Col Spacing (X軸間距)</span>
            </label>
            <span className="text-[11px] text-neutral-500 font-mono">ΔX</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <input
                id="rect-array-col-spacing-input"
                type="number"
                step="any"
                value={rectArrayColSpacing}
                onChange={handleColSpacingChange}
                className="w-full bg-neutral-950 border border-neutral-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-neutral-100 font-mono text-sm py-1.5 px-3 pr-8 rounded-md outline-none transition-colors"
              />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-500 text-xs font-mono">
                mm
              </span>
            </div>
            <button
              type="button"
              onClick={() => setRectArrayColSpacing(-rectArrayColSpacing)}
              className="px-2 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-mono rounded-md border border-neutral-700 transition-colors"
              title="反向 X 軸間距 (Invert Sign)"
            >
              ±
            </button>
          </div>
        </div>

        {/* 4. Row Spacing (Y軸間距) */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <label htmlFor="rect-array-row-spacing-input" className="text-neutral-300 font-medium flex items-center gap-1">
              <ArrowUpDown size={13} className="text-blue-400" />
              <span>Row Spacing (Y軸間距)</span>
            </label>
            <span className="text-[11px] text-neutral-500 font-mono">ΔY</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <input
                id="rect-array-row-spacing-input"
                type="number"
                step="any"
                value={rectArrayRowSpacing}
                onChange={handleRowSpacingChange}
                className="w-full bg-neutral-950 border border-neutral-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-neutral-100 font-mono text-sm py-1.5 px-3 pr-8 rounded-md outline-none transition-colors"
              />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-500 text-xs font-mono">
                mm
              </span>
            </div>
            <button
              type="button"
              onClick={() => setRectArrayRowSpacing(-rectArrayRowSpacing)}
              className="px-2 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-mono rounded-md border border-neutral-700 transition-colors"
              title="反向 Y 軸間距 (Invert Sign)"
            >
              ±
            </button>
          </div>
        </div>

        {/* Quick presets for Spacing */}
        <div className="flex items-center gap-1.5 pt-1">
          {[10, 20, 30, 50].map((spacing) => (
            <button
              key={spacing}
              type="button"
              onClick={() => {
                setRectArrayColSpacing(spacing);
                setRectArrayRowSpacing(spacing);
              }}
              className={`flex-1 py-1 text-[11px] font-mono rounded border transition-colors ${
                rectArrayColSpacing === spacing && rectArrayRowSpacing === spacing
                  ? 'bg-blue-600/30 border-blue-500 text-blue-300 font-bold'
                  : 'bg-neutral-800/60 border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800'
              }`}
            >
              {spacing}mm
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
