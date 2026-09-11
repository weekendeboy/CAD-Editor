import React, { useEffect } from 'react';
import { useCADStore } from '../store/cadStore';
import { OsnapMode } from '../store/cadStore.types';
import { X, Check } from 'lucide-react';

const OSNAP_LABELS: Record<OsnapMode, string> = {
  endpoint: '端點 (Endpoint)',
  midpoint: '中點 (Midpoint)',
  center: '圓心 (Center)',
  quadrant: '四分象限點 (Quadrant)',
  intersection: '交點 (Intersection)',
  extension: '延伸線 (Extension)',
  perpendicular: '垂足 (Perpendicular)',
  tangent: '切點 (Tangent)',
  parallel: '平行線 (Parallel)',
};

export const OsnapSettingsModal: React.FC = () => {
  const {
    isOsnapModalOpen,
    setOsnapModalOpen,
    osnapSettings,
    toggleOsnapMode,
    setAllOsnapModes,
  } = useCADStore();

  // Close on ESC key press
  useEffect(() => {
    if (!isOsnapModalOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOsnapModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOsnapModalOpen, setOsnapModalOpen]);

  if (!isOsnapModalOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-neutral-950/70 backdrop-blur-sm transition-opacity"
        onClick={() => setOsnapModalOpen(false)}
      />

      {/* Modal Container */}
      <div className="relative w-full max-w-md transform overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-left align-middle shadow-2xl transition-all">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 pb-4">
          <h3 className="text-lg font-bold text-neutral-100 flex items-center gap-2">
            物件鎖點設定 (Object Snap Settings)
          </h3>
          <button
            onClick={() => setOsnapModalOpen(false)}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="mt-4">
          <p className="text-xs text-neutral-400 mb-4">
            啟用或停用特定物件捕捉模式，使草圖繪製時自動對齊特定的幾何特徵點。
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(Object.keys(OSNAP_LABELS) as OsnapMode[]).map((mode) => {
              const active = osnapSettings[mode];
              return (
                <label
                  key={mode}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer select-none transition-all ${
                    active
                      ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                      : 'bg-neutral-950/40 border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={active}
                    onChange={() => toggleOsnapMode(mode)}
                  />
                  <div
                    className={`w-5 h-5 flex items-center justify-center rounded border transition-all ${
                      active
                        ? 'bg-emerald-500 border-emerald-400 text-neutral-950'
                        : 'border-neutral-700 bg-neutral-900'
                    }`}
                  >
                    {active && <Check size={14} strokeWidth={3} />}
                  </div>
                  <span className="text-sm font-medium whitespace-nowrap">
                    {OSNAP_LABELS[mode]}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-between border-t border-neutral-800 pt-4">
          <div className="flex gap-2">
            <button
              onClick={() => setAllOsnapModes(true)}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-neutral-800 text-neutral-200 hover:bg-neutral-700 transition-colors border border-neutral-700"
            >
              全選 (Select All)
            </button>
            <button
              onClick={() => setAllOsnapModes(false)}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-neutral-800 text-neutral-200 hover:bg-neutral-700 transition-colors border border-neutral-700"
            >
              全部清除 (Clear All)
            </button>
          </div>
          <button
            onClick={() => setOsnapModalOpen(false)}
            className="px-5 py-1.5 text-sm font-semibold rounded-lg bg-emerald-500 text-neutral-950 hover:bg-emerald-400 active:bg-emerald-600 transition-colors"
          >
            確定關閉
          </button>
        </div>
      </div>
    </div>
  );
};
