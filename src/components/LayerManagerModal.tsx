import React, { useState, useEffect, useRef } from 'react';
import { useCADStore } from '../store/cadStore';
import { CADLayer } from '../types/cad';
import {
  Layers,
  X,
  Plus,
  Trash2,
  Check,
  CheckCircle2,
  Lightbulb,
  LightbulbOff,
  Lock,
  Unlock,
  Printer,
  Search,
  AlertCircle,
  Palette,
} from 'lucide-react';

export interface LayerManagerModalProps {
  isOpen?: boolean;
  onClose?: () => void;
}

// AutoCAD 經典常用調色盤 (ACI Colors)
const PRESET_COLORS = [
  { name: 'Red (1)', hex: '#FF0000' },
  { name: 'Yellow (2)', hex: '#FFFF00' },
  { name: 'Green (3)', hex: '#00FF00' },
  { name: 'Cyan (4)', hex: '#00FFFF' },
  { name: 'Blue (5)', hex: '#0000FF' },
  { name: 'Magenta (6)', hex: '#FF00FF' },
  { name: 'White (7)', hex: '#FFFFFF' },
  { name: 'Gray (8)', hex: '#808080' },
  { name: 'Light Gray (9)', hex: '#C0C0C0' },
  { name: 'Orange', hex: '#FFA500' },
  { name: 'Lime', hex: '#32CD32' },
  { name: 'Sky Blue', hex: '#38BDF8' },
  { name: 'Purple', hex: '#A855F7' },
  { name: 'Pink', hex: '#EC4899' },
];

export const LayerManagerModal: React.FC<LayerManagerModalProps> = ({
  isOpen: propIsOpen,
  onClose: propOnClose,
}) => {
  const {
    document,
    activeLayerId,
    setActiveLayer,
    addLayer,
    updateLayer,
    removeLayer,
    renameLayer,
    toggleLayerVisibility,
    toggleLayerLock,
    isLayerModalOpen: storeIsOpen,
    setLayerModalOpen: storeSetOpen,
  } = useCADStore();

  const isOpen = propIsOpen !== undefined ? propIsOpen : storeIsOpen;
  const handleClose = () => {
    if (propOnClose) {
      propOnClose();
    } else {
      storeSetOpen(false);
    }
  };

  const [selectedRowLayerId, setSelectedRowLayerId] = useState<string>(activeLayerId || '0');
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [colorPickerTarget, setColorPickerTarget] = useState<{
    layerId: string;
    currentColor: string;
    position: { top: number; left: number };
  } | null>(null);

  const editInputRef = useRef<HTMLInputElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  // 當開啟時，將目前選取的資料列同步為目前 Active Layer
  useEffect(() => {
    if (isOpen) {
      setSelectedRowLayerId(activeLayerId || '0');
    }
  }, [isOpen, activeLayerId]);

  // ESC 鍵關閉視窗 / 關閉選色盤
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (colorPickerTarget) {
          setColorPickerTarget(null);
        } else if (editingLayerId) {
          setEditingLayerId(null);
        } else {
          handleClose();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, colorPickerTarget, editingLayerId]);

  // 點擊選色器外部關閉選色器
  useEffect(() => {
    if (!colorPickerTarget) return;

    const handleOutsideClick = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setColorPickerTarget(null);
      }
    };

    window.addEventListener('mousedown', handleOutsideClick);
    return () => {
      window.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [colorPickerTarget]);

  // 當進入重新命名時自動聚焦選取文字
  useEffect(() => {
    if (editingLayerId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingLayerId]);

  if (!isOpen) return null;

  const layersList = Object.values(document.layers || {});
  const filteredLayers = layersList.filter((layer) =>
    layer.name.toLowerCase().includes(searchQuery.trim().toLowerCase())
  );

  const selectedLayer = document.layers[selectedRowLayerId] || document.layers['0'];

  // 新增圖層
  const handleAddNewLayer = () => {
    let index = 1;
    let newName = `Layer${index}`;
    while (layersList.some((l) => l.name.toLowerCase() === newName.toLowerCase())) {
      index++;
      newName = `Layer${index}`;
    }

    const paletteCycle = ['#00FFFF', '#00FF00', '#FFFF00', '#FF00FF', '#38BDF8', '#F97316'];
    const newColor = paletteCycle[(layersList.length - 3) % paletteCycle.length] || '#00FFFF';

    const newLayer: CADLayer = {
      id: crypto.randomUUID(),
      name: newName,
      color: newColor,
      aciColor: 4,
      lineType: 'CONTINUOUS',
      lineWidth: 0.25,
      visible: true,
      locked: false,
      isPlot: true,
    };

    addLayer(newLayer);
    setSelectedRowLayerId(newLayer.id);
    setEditingLayerId(newLayer.id);
    setEditingName(newLayer.name);
  };

  // 刪除選定圖層
  const handleDeleteSelectedLayer = () => {
    if (!selectedRowLayerId) return;
    if (selectedRowLayerId === '0' || selectedRowLayerId.toUpperCase() === 'DEFPOINTS') {
      return;
    }
    const layerToDelete = document.layers[selectedRowLayerId];
    if (!layerToDelete) return;

    removeLayer(selectedRowLayerId);
    setSelectedRowLayerId('0');
  };

  // 開始更名
  const handleStartRename = (layer: CADLayer) => {
    if (layer.id === '0' || layer.id.toUpperCase() === 'DEFPOINTS' || layer.name === '0' || layer.name.toUpperCase() === 'DEFPOINTS') {
      return;
    }
    setEditingLayerId(layer.id);
    setEditingName(layer.name);
  };

  // 提交更名
  const handleCommitRename = (layerId: string) => {
    if (!editingLayerId) return;
    const trimmed = editingName.trim();
    if (trimmed && trimmed.length > 0) {
      renameLayer(layerId, trimmed);
    }
    setEditingLayerId(null);
  };

  // 設為目前圖層
  const handleSetCurrent = (layerId: string) => {
    setActiveLayer(layerId);
    setSelectedRowLayerId(layerId);
  };

  // 開啟顏色選擇器
  const handleOpenColorPicker = (layer: CADLayer, e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setColorPickerTarget({
      layerId: layer.id,
      currentColor: layer.color || '#FFFFFF',
      position: {
        top: Math.min(rect.bottom + 6, window.innerHeight - 260),
        left: Math.max(16, Math.min(rect.left, window.innerWidth - 280)),
      },
    });
  };

  const handleColorSelect = (layerId: string, newColor: string) => {
    updateLayer(layerId, { color: newColor });
    setColorPickerTarget(null);
  };

  const isSelectedProtected =
    selectedRowLayerId === '0' ||
    selectedRowLayerId.toUpperCase() === 'DEFPOINTS' ||
    selectedLayer?.name === '0' ||
    selectedLayer?.name.toUpperCase() === 'DEFPOINTS';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-neutral-950/75 backdrop-blur-xs transition-opacity"
        onClick={handleClose}
      />

      {/* AutoCAD 風格浮動視窗容器 */}
      <div className="relative w-full max-w-4xl h-[560px] flex flex-col transform overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl text-neutral-200 select-none">
        {/* 對話框標題列 */}
        <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-950 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <Layers size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-neutral-100 flex items-center gap-2">
                圖層特性管理員
                <span className="text-xs font-normal text-neutral-400 font-mono">
                  (Layer Properties Manager)
                </span>
              </h2>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors"
            title="關閉 [Esc]"
          >
            <X size={18} />
          </button>
        </div>

        {/* 頂部操作工具條與搜尋欄 */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-neutral-900/90 border-b border-neutral-800 shrink-0">
          {/* 左側：新增、刪除、設為目前快捷動作按鈕 */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleAddNewLayer}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white text-xs font-semibold shadow-sm transition-colors"
              title="建立新圖層 (Alt+N)"
            >
              <Plus size={15} />
              <span>新增圖層</span>
            </button>

            <button
              onClick={handleDeleteSelectedLayer}
              disabled={isSelectedProtected}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-neutral-800 hover:bg-red-950/80 hover:text-red-300 hover:border-red-700/50 active:bg-red-900 text-neutral-300 text-xs font-semibold border border-neutral-700 disabled:opacity-40 disabled:pointer-events-none transition-colors"
              title={
                isSelectedProtected
                  ? "圖層 '0' 與 'DEFPOINTS' 為 CAD 核心系統保留圖層，禁止刪除"
                  : '刪除選定圖層'
              }
            >
              <Trash2 size={14} />
              <span>刪除圖層</span>
            </button>

            <div className="h-5 w-px bg-neutral-800 mx-1" />

            <button
              onClick={() => handleSetCurrent(selectedRowLayerId)}
              disabled={selectedRowLayerId === activeLayerId}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors ${
                selectedRowLayerId === activeLayerId
                  ? 'bg-emerald-950/50 border-emerald-600/50 text-emerald-400 cursor-default'
                  : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
              }`}
              title="將選定的圖層設為目前的繪圖圖層"
            >
              <Check size={14} className={selectedRowLayerId === activeLayerId ? 'text-emerald-400' : 'text-neutral-400'} />
              <span>設為目前</span>
            </button>
          </div>

          {/* 右側：搜尋過濾框 */}
          <div className="relative flex items-center">
            <Search size={14} className="absolute left-2.5 text-neutral-500 pointer-events-none" />
            <input
              type="text"
              placeholder="搜尋圖層名稱..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-48 sm:w-60 bg-neutral-950 border border-neutral-700 rounded-md pl-8 pr-3 py-1 text-xs text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-sky-500 transition-colors"
            />
          </div>
        </div>

        {/* 圖層清單資料表格 */}
        <div className="flex-1 overflow-auto bg-neutral-950/40">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-neutral-900/90 sticky top-0 z-10 text-neutral-400 border-b border-neutral-800 select-none">
              <tr>
                <th className="py-2.5 px-3 w-12 text-center font-semibold">狀態</th>
                <th className="py-2.5 px-3 font-semibold min-w-[140px]">圖層名稱</th>
                <th className="py-2.5 px-3 w-16 text-center font-semibold">開啟</th>
                <th className="py-2.5 px-3 w-16 text-center font-semibold">鎖定</th>
                <th className="py-2.5 px-3 w-28 text-center font-semibold">顏色</th>
                <th className="py-2.5 px-3 w-36 font-semibold">線型</th>
                <th className="py-2.5 px-3 w-16 text-center font-semibold">列印</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/60 font-mono">
              {filteredLayers.map((layer) => {
                const isActive = layer.id === activeLayerId;
                const isSelected = layer.id === selectedRowLayerId;
                const isProtected =
                  layer.id === '0' ||
                  layer.id.toUpperCase() === 'DEFPOINTS' ||
                  layer.name === '0' ||
                  layer.name.toUpperCase() === 'DEFPOINTS';
                const isEditing = editingLayerId === layer.id;

                return (
                  <tr
                    key={layer.id}
                    onClick={() => setSelectedRowLayerId(layer.id)}
                    onDoubleClick={() => {
                      if (!isProtected) {
                        handleStartRename(layer);
                      } else {
                        handleSetCurrent(layer.id);
                      }
                    }}
                    className={`group transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-sky-950/40 text-white'
                        : 'hover:bg-neutral-800/50 text-neutral-300'
                    }`}
                  >
                    {/* 狀態欄：設為目前圖層 */}
                    <td className="py-2 px-3 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSetCurrent(layer.id);
                        }}
                        className={`w-6 h-6 mx-auto flex items-center justify-center rounded transition-colors ${
                          isActive
                            ? 'text-emerald-400 bg-emerald-950/60 border border-emerald-600/40'
                            : 'text-neutral-600 hover:text-neutral-300 hover:bg-neutral-800'
                        }`}
                        title={isActive ? '目前作用中繪圖圖層' : '點擊設為目前圖層'}
                      >
                        {isActive ? (
                          <CheckCircle2 size={15} />
                        ) : (
                          <span className="text-[10px] text-neutral-600 group-hover:text-neutral-400">
                            ○
                          </span>
                        )}
                      </button>
                    </td>

                    {/* 圖層名稱：支援雙擊更名 */}
                    <td className="py-2 px-3 font-sans">
                      {isEditing ? (
                        <input
                          ref={editInputRef}
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onBlur={() => handleCommitRename(layer.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCommitRename(layer.id);
                            if (e.key === 'Escape') setEditingLayerId(null);
                          }}
                          className="w-full bg-neutral-950 border border-sky-500 rounded px-2 py-0.5 text-xs text-white focus:outline-none"
                        />
                      ) : (
                        <div className="flex items-center justify-between">
                          <span
                            className={`truncate font-medium ${
                              isActive ? 'text-sky-300 font-bold' : 'text-neutral-200'
                            }`}
                          >
                            {layer.name}
                          </span>
                          {isProtected && (
                            <span className="text-[10px] text-neutral-500 bg-neutral-800/80 px-1.5 py-0.2 rounded border border-neutral-700/60 shrink-0 ml-2">
                              保留
                            </span>
                          )}
                        </div>
                      )}
                    </td>

                    {/* 可見度：燈泡圖示切換 */}
                    <td className="py-2 px-3 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleLayerVisibility(layer.id);
                        }}
                        className={`p-1.5 rounded transition-transform active:scale-90 ${
                          layer.visible !== false
                            ? 'text-amber-400 hover:bg-amber-950/40'
                            : 'text-neutral-600 hover:text-neutral-400 hover:bg-neutral-800'
                        }`}
                        title={layer.visible !== false ? '圖層已開啟 (可見)' : '圖層已關閉 (隱藏)'}
                      >
                        {layer.visible !== false ? (
                          <Lightbulb size={16} className="fill-amber-400/20" />
                        ) : (
                          <LightbulbOff size={16} />
                        )}
                      </button>
                    </td>

                    {/* 鎖定狀態：鎖頭圖示切換 */}
                    <td className="py-2 px-3 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleLayerLock(layer.id);
                        }}
                        className={`p-1.5 rounded transition-transform active:scale-90 ${
                          layer.locked
                            ? 'text-amber-400 hover:bg-amber-950/40'
                            : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800'
                        }`}
                        title={layer.locked ? '圖層已鎖定 (防誤觸修改)' : '圖層未鎖定'}
                      >
                        {layer.locked ? <Lock size={15} /> : <Unlock size={15} />}
                      </button>
                    </td>

                    {/* 顏色方塊：點擊開啟選色盤 */}
                    <td className="py-2 px-3 text-center">
                      <button
                        onClick={(e) => handleOpenColorPicker(layer, e)}
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-neutral-900 border border-neutral-700 hover:border-sky-500 transition-colors"
                        title="點擊變更圖層顏色"
                      >
                        <span
                          className="w-3.5 h-3.5 rounded-sm border border-neutral-600 shrink-0"
                          style={{ backgroundColor: layer.color || '#FFFFFF' }}
                        />
                        <span className="text-[11px] font-mono text-neutral-300 uppercase">
                          {layer.color || '#FFFFFF'}
                        </span>
                      </button>
                    </td>

                    {/* 線型：下拉選單切換 */}
                    <td className="py-2 px-3">
                      <select
                        value={layer.lineType || 'CONTINUOUS'}
                        onChange={(e) =>
                          updateLayer(layer.id, {
                            lineType: e.target.value as 'CONTINUOUS' | 'DASHED' | 'CENTER' | 'HIDDEN',
                          })
                        }
                        onClick={(e) => e.stopPropagation()}
                        className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-200 focus:outline-none focus:border-sky-500 transition-colors w-full cursor-pointer"
                      >
                        <option value="CONTINUOUS">CONTINUOUS (實線)</option>
                        <option value="DASHED">DASHED (虛線)</option>
                        <option value="CENTER">CENTER (中心線)</option>
                        <option value="HIDDEN">HIDDEN (隱藏線)</option>
                      </select>
                    </td>

                    {/* 列印旗標：印表機圖示切換 */}
                    <td className="py-2 px-3 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          updateLayer(layer.id, { isPlot: layer.isPlot === false ? true : false });
                        }}
                        className={`p-1.5 rounded transition-colors relative ${
                          layer.isPlot !== false
                            ? 'text-neutral-300 hover:text-white hover:bg-neutral-800'
                            : 'text-red-400 hover:bg-red-950/40'
                        }`}
                        title={
                          layer.isPlot !== false
                            ? '可列印 (Plot enabled)'
                            : '不可列印 (Plot disabled, 如 CONSTRUCTION/DEFPOINTS)'
                        }
                      >
                        <Printer size={15} />
                        {layer.isPlot === false && (
                          <span className="absolute inset-0 flex items-center justify-center text-red-500 font-bold pointer-events-none text-xs">
                            /
                          </span>
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}

              {filteredLayers.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-neutral-500 text-xs">
                    找不到符合「{searchQuery}」的圖層
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 底部狀態列與確定關閉 */}
        <div className="flex items-center justify-between px-4 py-3 bg-neutral-950 border-t border-neutral-800 shrink-0 text-xs text-neutral-400">
          <div className="flex items-center gap-4">
            <span>
              總計 <strong className="text-neutral-200">{layersList.length}</strong> 個圖層
            </span>
            <span>
              目前圖層: <strong className="text-sky-400">{document.layers[activeLayerId]?.name || activeLayerId}</strong>
            </span>
            {selectedLayer && selectedLayer.id !== activeLayerId && (
              <span className="hidden sm:inline text-neutral-500">
                選定: <span className="text-neutral-300">{selectedLayer.name}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleClose}
              className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-neutral-800 text-neutral-200 hover:bg-neutral-700 transition-colors border border-neutral-700"
            >
              關閉
            </button>
          </div>
        </div>

        {/* 浮動顏色選擇器 Popover */}
        {colorPickerTarget && (
          <div
            ref={colorPickerRef}
            style={{
              position: 'fixed',
              top: `${colorPickerTarget.position.top}px`,
              left: `${colorPickerTarget.position.left}px`,
            }}
            className="z-[60] w-64 p-3 rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl animate-in fade-in zoom-in-95 duration-100"
          >
            <div className="flex items-center justify-between border-b border-neutral-800 pb-2 mb-2">
              <span className="text-xs font-bold text-neutral-200 flex items-center gap-1.5">
                <Palette size={13} className="text-sky-400" />
                選取圖層顏色
              </span>
              <button
                onClick={() => setColorPickerTarget(null)}
                className="text-neutral-400 hover:text-white p-0.5 rounded"
              >
                <X size={14} />
              </button>
            </div>

            <div className="text-[11px] text-neutral-400 mb-1.5">AutoCAD 常用標準色 (ACI)</div>
            <div className="grid grid-cols-7 gap-1.5 mb-3">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c.hex}
                  onClick={() => handleColorSelect(colorPickerTarget.layerId, c.hex)}
                  className="w-7 h-7 rounded border border-neutral-700 hover:scale-110 hover:border-white transition-transform relative group"
                  style={{ backgroundColor: c.hex }}
                  title={c.name}
                >
                  {colorPickerTarget.currentColor.toUpperCase() === c.hex.toUpperCase() && (
                    <Check
                      size={12}
                      className={`absolute inset-0 m-auto ${
                        c.hex === '#FFFFFF' || c.hex === '#FFFF00' ? 'text-black' : 'text-white'
                      }`}
                      strokeWidth={3}
                    />
                  )}
                </button>
              ))}
            </div>

            <div className="border-t border-neutral-800 pt-2 flex items-center justify-between">
              <label className="text-[11px] text-neutral-300 flex items-center gap-2 cursor-pointer">
                <span>自訂原生選色:</span>
                <input
                  type="color"
                  value={colorPickerTarget.currentColor || '#FFFFFF'}
                  onChange={(e) => handleColorSelect(colorPickerTarget.layerId, e.target.value)}
                  className="w-6 h-6 rounded border border-neutral-700 bg-transparent cursor-pointer"
                />
              </label>
              <span className="text-[11px] font-mono text-neutral-400 uppercase">
                {colorPickerTarget.currentColor}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
