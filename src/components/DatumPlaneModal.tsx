import React, { useState, useEffect } from 'react';
import { useCADStore } from '../store/cadStore';
import { CustomPlane, DatumPlaneFeature, Point3D, LineEntity, SketchFeature } from '../types/cad';
import {
  createOffsetPlane,
  createRotatedPlaneAroundAxis,
  FRONT_PLANE,
  TOP_PLANE,
  RIGHT_PLANE,
  map2DTo3DWorld,
  sub3D,
  normalize3D,
} from '../core/3d/DatumPlaneEngine';
import { X, Layers, RotateCw, ArrowUpRight, SquareDashed, Check } from 'lucide-react';

interface DatumPlaneModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DatumPlaneModal: React.FC<DatumPlaneModalProps> = ({ isOpen, onClose }) => {
  const { document, activeSketchId } = useCADStore();

  const [planeType, setPlaneType] = useState<'offset' | 'angle'>('offset');
  const [featureName, setFeatureName] = useState<string>('');
  const [selectedRefPlaneId, setSelectedRefPlaneId] = useState<string>('datum-front');

  // 偏移模式參數
  const [offsetDistance, setOffsetDistance] = useState<number>(30);
  const [flipOffset, setFlipOffset] = useState<boolean>(false);

  // 旋轉模式參數
  const [rotationAngleDeg, setRotationAngleDeg] = useState<number>(45);
  const [flipAngle, setFlipAngle] = useState<boolean>(false);
  const [axisSourceMode, setAxisSourceMode] = useState<'standard' | 'sketch_edge'>('standard');
  const [standardAxis, setStandardAxis] = useState<'X' | 'Y' | 'Z'>('X');
  const [selectedLineEntityId, setSelectedLineEntityId] = useState<string>('');

  // 當彈窗開啟時，自動預設特徵名稱與相關選單
  useEffect(() => {
    if (isOpen) {
      const datumCount = document.featureTree.filter((f) => f.type === 'DATUM_PLANE').length;
      setFeatureName(`DatumPlane${datumCount + 1}`);
      setSelectedRefPlaneId('datum-front');
      setOffsetDistance(30);
      setFlipOffset(false);
      setRotationAngleDeg(45);
      setFlipAngle(false);
      setAxisSourceMode('standard');
      setStandardAxis('X');
      setSelectedLineEntityId('');
    }
  }, [isOpen, document.featureTree]);

  if (!isOpen) return null;

  // 取得可用的基準面選項 (包含三大預設面與歷史 DatumPlane 特徵)
  const availableRefPlanes: { id: string; name: string; plane: CustomPlane }[] = [
    { id: FRONT_PLANE.id, name: FRONT_PLANE.name, plane: FRONT_PLANE },
    { id: TOP_PLANE.id, name: TOP_PLANE.name, plane: TOP_PLANE },
    { id: RIGHT_PLANE.id, name: RIGHT_PLANE.name, plane: RIGHT_PLANE },
  ];

  document.featureTree.forEach((f) => {
    if (f.type === 'DATUM_PLANE') {
      const dp = f as DatumPlaneFeature;
      if (dp.plane && !['datum-front', 'datum-top', 'datum-right'].includes(dp.id)) {
        availableRefPlanes.push({
          id: dp.id,
          name: dp.name,
          plane: dp.plane,
        });
      }
    }
  });

  // 取得可用的草圖直線清單 (作為旋轉邊線參考)
  const availableLines: { id: string; name: string; line: LineEntity; sketch: SketchFeature }[] = [];
  document.featureTree.forEach((f) => {
    if (f.type === 'SKETCH') {
      const sketch = f as SketchFeature;
      sketch.entities.forEach((ent) => {
        if (ent.type === 'line') {
          availableLines.push({
            id: ent.id,
            name: `${sketch.name} - Line (${ent.id.substring(0, 6)})`,
            line: ent as LineEntity,
            sketch,
          });
        }
      });
    }
  });

  // 解析當前所選的參照面 CustomPlane
  const resolveRefPlane = (): CustomPlane => {
    const found = availableRefPlanes.find((p) => p.id === selectedRefPlaneId);
    if (found) return found.plane;
    if (document.planes && document.planes[selectedRefPlaneId]) {
      return document.planes[selectedRefPlaneId];
    }
    return FRONT_PLANE;
  };

  const handleConfirm = () => {
    const refPlane = resolveRefPlane();
    const planeId = `datum-plane-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const finalName = featureName.trim() || 'DatumPlane';

    let calculatedPlane: CustomPlane;
    let effDist = 0;
    let angleRad = 0;
    let axisOrigin: Point3D | undefined = undefined;
    let axisDir: Point3D | undefined = undefined;

    if (planeType === 'offset') {
      effDist = offsetDistance * (flipOffset ? -1 : 1);
      calculatedPlane = createOffsetPlane(refPlane, effDist, planeId, finalName);
    } else {
      // 繞軸/邊旋轉模式
      angleRad = ((rotationAngleDeg * Math.PI) / 180) * (flipAngle ? -1 : 1);

      if (axisSourceMode === 'standard') {
        axisOrigin = { ...refPlane.origin };
        if (standardAxis === 'X') {
          axisDir = { x: 1, y: 0, z: 0 };
        } else if (standardAxis === 'Y') {
          axisDir = { x: 0, y: 1, z: 0 };
        } else {
          axisDir = { x: 0, y: 0, z: 1 };
        }
      } else {
        // 從選取的草圖直線推導 3D 空間軸
        const lineItem = availableLines.find((l) => l.id === selectedLineEntityId);
        if (lineItem) {
          const sketchPlane = lineItem.sketch.plane || FRONT_PLANE;
          const start3D = map2DTo3DWorld(lineItem.line.start, sketchPlane);
          const end3D = map2DTo3DWorld(lineItem.line.end, sketchPlane);
          axisOrigin = start3D;
          axisDir = normalize3D(sub3D(end3D, start3D));
        } else {
          // 備用退化選定: 以參照面原點與 X 軸作為軸線
          axisOrigin = { ...refPlane.origin };
          axisDir = { ...refPlane.xAxis };
        }
      }

      calculatedPlane = createRotatedPlaneAroundAxis(
        refPlane,
        axisOrigin,
        axisDir,
        angleRad,
        planeId,
        finalName
      );
    }

    const newFeature: DatumPlaneFeature = {
      id: planeId,
      name: finalName,
      type: 'DATUM_PLANE',
      planeType,
      referencePlaneId: selectedRefPlaneId,
      offsetDistance: effDist,
      rotationAngle: angleRad,
      rotationAngleDeg: planeType === 'angle' ? rotationAngleDeg : undefined,
      axisOrigin,
      axisDirection: axisDir,
      referenceEdgeEntityId:
        planeType === 'angle' && axisSourceMode === 'sketch_edge'
          ? selectedLineEntityId
          : undefined,
      plane: calculatedPlane,
      dependencies: [selectedRefPlaneId],
      suppressed: false,
      visible: true,
    };

    const store = useCADStore.getState();
    store.addFeature(newFeature);

    // 擴充全域 planes 快取
    useCADStore.setState((state) => ({
      document: {
        ...state.document,
        planes: {
          ...state.document.planes,
          [newFeature.id]: calculatedPlane,
        },
      },
    }));

    // 切換至 3D 視角檢視新建的空間基準面
    store.setViewMode('3D');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="bg-neutral-900 border border-neutral-800 text-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800 bg-neutral-950/80">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-cyan-950/80 border border-cyan-700/50 rounded-lg text-cyan-400">
              <SquareDashed size={18} />
            </div>
            <div>
              <h3 className="font-bold text-sm text-neutral-100">建立空間基準面 (Datum Plane)</h3>
              <p className="text-[11px] text-neutral-400">定義平面法向偏移或繞空間軸旋轉姿態</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-neutral-400 hover:text-white rounded-md hover:bg-neutral-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-4 text-xs">
          {/* 特徵名稱輸入框 */}
          <div>
            <label className="block text-neutral-400 mb-1 font-semibold">特徵名稱 (Feature Name)</label>
            <input
              type="text"
              value={featureName}
              onChange={(e) => setFeatureName(e.target.value)}
              className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded-lg text-neutral-200 focus:outline-none focus:border-cyan-500 font-mono text-xs"
              placeholder="DatumPlane1"
            />
          </div>

          {/* 模式切換 Tabs */}
          <div>
            <label className="block text-neutral-400 mb-1.5 font-semibold">建立模式 (Plane Type)</label>
            <div className="grid grid-cols-2 gap-2 p-1 bg-neutral-950 border border-neutral-800 rounded-lg">
              <button
                type="button"
                onClick={() => setPlaneType('offset')}
                className={`py-1.5 px-3 rounded-md font-medium text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  planeType === 'offset'
                    ? 'bg-cyan-600 text-white font-bold shadow-sm'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                <ArrowUpRight size={14} />
                <span>法向偏移 (Offset)</span>
              </button>
              <button
                type="button"
                onClick={() => setPlaneType('angle')}
                className={`py-1.5 px-3 rounded-md font-medium text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  planeType === 'angle'
                    ? 'bg-purple-600 text-white font-bold shadow-sm'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                <RotateCw size={14} />
                <span>繞軸旋轉 (Angled)</span>
              </button>
            </div>
          </div>

          {/* 參照基準面下拉選單 */}
          <div>
            <label className="block text-neutral-400 mb-1 font-semibold">參照基準面 (Reference Plane)</label>
            <select
              value={selectedRefPlaneId}
              onChange={(e) => setSelectedRefPlaneId(e.target.value)}
              className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded-lg text-neutral-200 focus:outline-none focus:border-cyan-500 font-mono text-xs cursor-pointer"
            >
              {availableRefPlanes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* 偏移模式控制項 */}
          {planeType === 'offset' && (
            <div className="space-y-3 p-3 bg-neutral-950/60 border border-neutral-800/80 rounded-lg">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-neutral-300 font-medium">偏移距離 (Distance)</label>
                  <span className="text-[11px] text-cyan-400 font-mono font-bold">mm</span>
                </div>
                <input
                  type="number"
                  step="1"
                  value={offsetDistance}
                  onChange={(e) => setOffsetDistance(parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-700 rounded-md text-cyan-400 font-mono font-bold text-sm focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="chk-flip-offset"
                  checked={flipOffset}
                  onChange={(e) => setFlipOffset(e.target.checked)}
                  className="rounded border-neutral-700 text-cyan-500 focus:ring-cyan-500 bg-neutral-900 cursor-pointer"
                />
                <label htmlFor="chk-flip-offset" className="text-neutral-300 cursor-pointer select-none">
                  反向偏移 (Reverse Offset Direction)
                </label>
              </div>
            </div>
          )}

          {/* 繞軸旋轉模式控制項 */}
          {planeType === 'angle' && (
            <div className="space-y-3 p-3 bg-neutral-950/60 border border-neutral-800/80 rounded-lg">
              {/* 旋轉角度輸入與快捷鈕 */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-neutral-300 font-medium">旋轉角度 (Rotation Angle)</label>
                  <span className="text-[11px] text-purple-400 font-mono font-bold">度 (°)</span>
                </div>
                <div className="flex gap-2 mb-2">
                  <input
                    type="number"
                    step="1"
                    value={rotationAngleDeg}
                    onChange={(e) => setRotationAngleDeg(parseFloat(e.target.value) || 0)}
                    className="flex-1 px-3 py-1.5 bg-neutral-950 border border-neutral-700 rounded-md text-purple-400 font-mono font-bold text-sm focus:outline-none focus:border-purple-500"
                  />
                </div>
                {/* 快捷填寫按鈕 */}
                <div className="flex gap-1.5">
                  {[30, 45, 90, 180].map((deg) => (
                    <button
                      key={deg}
                      type="button"
                      onClick={() => setRotationAngleDeg(deg)}
                      className={`flex-1 py-1 rounded text-[11px] font-mono font-semibold transition-colors cursor-pointer ${
                        rotationAngleDeg === deg
                          ? 'bg-purple-600 text-white'
                          : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                      }`}
                    >
                      {deg}°
                    </button>
                  ))}
                </div>
              </div>

              {/* 旋轉軸來源設定 */}
              <div>
                <label className="block text-neutral-400 mb-1 font-semibold">旋轉軸來源 (Rotation Axis Source)</label>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => setAxisSourceMode('standard')}
                    className={`py-1 px-2 rounded border text-[11px] font-medium transition-colors cursor-pointer ${
                      axisSourceMode === 'standard'
                        ? 'bg-neutral-800 border-purple-500 text-purple-300'
                        : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                    }`}
                  >
                    標準坐標軸
                  </button>
                  <button
                    type="button"
                    onClick={() => setAxisSourceMode('sketch_edge')}
                    className={`py-1 px-2 rounded border text-[11px] font-medium transition-colors cursor-pointer ${
                      axisSourceMode === 'sketch_edge'
                        ? 'bg-neutral-800 border-purple-500 text-purple-300'
                        : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'
                    }`}
                  >
                    草圖直線邊界
                  </button>
                </div>

                {axisSourceMode === 'standard' ? (
                  <div className="flex gap-2">
                    {(['X', 'Y', 'Z'] as const).map((axis) => (
                      <button
                        key={axis}
                        type="button"
                        onClick={() => setStandardAxis(axis)}
                        className={`flex-1 py-1 rounded border text-xs font-mono font-bold transition-colors cursor-pointer ${
                          standardAxis === axis
                            ? 'bg-purple-950 border-purple-500 text-purple-300'
                            : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white'
                        }`}
                      >
                        {axis} 軸
                      </button>
                    ))}
                  </div>
                ) : (
                  <select
                    value={selectedLineEntityId}
                    onChange={(e) => setSelectedLineEntityId(e.target.value)}
                    className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-700 rounded-md text-neutral-200 text-xs focus:outline-none focus:border-purple-500 cursor-pointer"
                  >
                    <option value="">-- 請選擇草圖直線作為軸線 --</option>
                    {availableLines.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="chk-flip-angle"
                  checked={flipAngle}
                  onChange={(e) => setFlipAngle(e.target.checked)}
                  className="rounded border-neutral-700 text-purple-500 focus:ring-purple-500 bg-neutral-900 cursor-pointer"
                />
                <label htmlFor="chk-flip-angle" className="text-neutral-300 cursor-pointer select-none">
                  反向旋轉 (Reverse Rotation Direction)
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-neutral-800 bg-neutral-950/80">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-lg transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-5 py-1.5 text-xs font-bold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors shadow-sm flex items-center gap-1.5 cursor-pointer active:scale-95"
          >
            <Check size={14} className="stroke-[3]" />
            <span>確定建立</span>
          </button>
        </div>
      </div>
    </div>
  );
};
