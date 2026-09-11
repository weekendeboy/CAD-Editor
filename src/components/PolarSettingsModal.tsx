import React, { useEffect, useState } from 'react';
import { useCADStore } from '../store/cadStore';
import { X, Plus, Trash2, Check } from 'lucide-react';

const PRESET_ANGLES = [
  { value: 90, label: '90°, 180°, 270°, 360°' },
  { value: 45, label: '45°, 90°, 135°, 180°, 225°, 270°, 315°, 360°' },
  { value: 30, label: '30°, 60°, 90°, 120°, 150°, 180°, 210°, 240°, 270°, 300°, 330°, 360°' },
  { value: 15, label: '15°, 30°, 45°, 60°, 75°, 90°, 105°, 120°, 135°, 150°, 165°, 180° ...' },
  { value: 5, label: '5°, 10°, 15°, 20°, 25°, 30°, 35°, 40°, 45°, 50°, 55°, 60° ...' },
];

export const PolarSettingsModal: React.FC = () => {
  const {
    isPolarModalOpen,
    setPolarModalOpen,
    polarTrackingEnabled,
    togglePolarTracking,
    polarAngleStep,
    setPolarAngleStep,
    customPolarAngles,
    addCustomPolarAngle,
    removeCustomPolarAngle,
  } = useCADStore();

  const [inputAngle, setInputAngle] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');

  // Close on ESC
  useEffect(() => {
    if (!isPolarModalOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPolarModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPolarModalOpen, setPolarModalOpen]);

  if (!isPolarModalOpen) return null;

  const handleAddCustomAngle = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    const angle = parseFloat(inputAngle);
    if (isNaN(angle)) {
      setErrorMsg('請輸入有效的數字角度');
      return;
    }

    if (angle < 0 || angle >= 360) {
      setErrorMsg('角度範圍應介於 0° 至 360° 之間');
      return;
    }

    // Round to 4 decimal places for accuracy
    const sanitizedAngle = Math.round(angle * 10000) / 10000;

    if (customPolarAngles.includes(sanitizedAngle)) {
      setErrorMsg('此角度已存在自訂清單中');
      return;
    }

    addCustomPolarAngle(sanitizedAngle);
    setInputAngle('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-neutral-950/70 backdrop-blur-sm transition-opacity"
        onClick={() => setPolarModalOpen(false)}
      />

      {/* Modal Container */}
      <div className="relative w-full max-w-lg transform overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-left align-middle shadow-2xl transition-all">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 pb-4">
          <h3 className="text-lg font-bold text-neutral-100 flex items-center gap-2">
            極座標追蹤設定 (Polar Tracking Settings)
          </h3>
          <button
            onClick={() => setPolarModalOpen(false)}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="mt-4 space-y-5">
          {/* Main Toggle */}
          <div className="flex items-center justify-between p-3.5 bg-neutral-950/40 rounded-xl border border-neutral-800">
            <div>
              <h4 className="text-sm font-semibold text-neutral-200">啟用極座標追蹤 (Polar Tracking)</h4>
              <p className="text-xs text-neutral-400 mt-0.5">繪線時提供自訂極軸角度的參考軌跡引導，自動鎖定指定增量方向。</p>
            </div>
            <button
              onClick={togglePolarTracking}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                polarTrackingEnabled ? 'bg-amber-500' : 'bg-neutral-800'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  polarTrackingEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div className={`grid grid-cols-1 md:grid-cols-2 gap-4 transition-opacity ${polarTrackingEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
            {/* Step Angles preset */}
            <div className="space-y-3">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-400 block">
                增量步進角度 (Increment Angle)
              </span>
              <div className="space-y-2">
                {PRESET_ANGLES.map((preset) => {
                  const selected = polarAngleStep === preset.value;
                  return (
                    <label
                      key={preset.value}
                      className={`flex flex-col px-3 py-2 rounded-lg border cursor-pointer select-none transition-all ${
                        selected
                          ? 'bg-amber-950/30 border-amber-500/40 text-amber-300'
                          : 'bg-neutral-950/20 border-neutral-800/80 text-neutral-400 hover:border-neutral-800 hover:text-neutral-300'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <input
                          type="radio"
                          name="polarAngleStep"
                          className="sr-only"
                          checked={selected}
                          onChange={() => setPolarAngleStep(preset.value)}
                        />
                        <div
                          className={`w-4.5 h-4.5 flex items-center justify-center rounded-full border transition-all ${
                            selected
                              ? 'border-amber-500 bg-amber-500 text-neutral-950'
                              : 'border-neutral-700 bg-neutral-900'
                          }`}
                        >
                          {selected && <div className="w-1.5 h-1.5 bg-neutral-950 rounded-full" />}
                        </div>
                        <span className="text-sm font-bold">{preset.value}°</span>
                      </div>
                      <span className="text-[10px] text-neutral-500 pl-7 mt-0.5 whitespace-nowrap overflow-hidden text-ellipsis">
                        {preset.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Custom Additional Angles */}
            <div className="flex flex-col space-y-3">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-400 block">
                自訂額外捕捉角度 (Additional Angles)
              </span>
              
              {/* Form to add */}
              <form onSubmit={handleAddCustomAngle} className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={inputAngle}
                    onChange={(e) => setInputAngle(e.target.value)}
                    placeholder="例如 22.5"
                    className="w-full rounded-lg bg-neutral-950 border border-neutral-800 px-3 py-1.5 font-mono text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs font-bold text-neutral-500 select-none">
                    度 (°)
                  </span>
                </div>
                <button
                  type="submit"
                  className="p-1.5 bg-amber-500 text-neutral-950 hover:bg-amber-400 active:bg-amber-600 rounded-lg transition-colors flex items-center justify-center shrink-0"
                  title="新增自訂角度"
                >
                  <Plus size={18} strokeWidth={2.5} />
                </button>
              </form>

              {errorMsg && (
                <p className="text-[11px] text-red-400 font-medium">{errorMsg}</p>
              )}

              {/* Angle list */}
              <div className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950/30 p-2 overflow-y-auto max-h-[140px] min-h-[100px] flex flex-col gap-1.5">
                {customPolarAngles.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center text-xs text-neutral-600 italic">
                    無其他自訂角度
                  </div>
                ) : (
                  customPolarAngles.map((angle) => (
                    <div
                      key={angle}
                      className="flex items-center justify-between bg-neutral-900/60 border border-neutral-850 px-2.5 py-1.5 rounded-md hover:border-neutral-700 transition-all group"
                    >
                      <span className="font-mono text-sm text-neutral-300 font-bold">
                        {angle.toFixed(1)}°
                      </span>
                      <button
                        type="button"
                        onClick={() => removeCustomPolarAngle(angle)}
                        className="text-neutral-500 hover:text-red-400 p-1 rounded hover:bg-neutral-800/50 transition-colors"
                        title="刪除此角度"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-6 flex justify-end border-t border-neutral-800 pt-4">
          <button
            onClick={() => setPolarModalOpen(false)}
            className="px-5 py-1.5 text-sm font-semibold rounded-lg bg-amber-500 text-neutral-950 hover:bg-amber-400 active:bg-amber-600 transition-colors"
          >
            確定關閉
          </button>
        </div>
      </div>
    </div>
  );
};
