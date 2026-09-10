import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useCADStore } from '../store/cadStore';
import { useViewport } from '../hooks/useViewport';
import { CADGrid } from './CADGrid';
import { EntityRenderer } from './EntityRenderer';
import { ProfileRenderer } from './ProfileRenderer';
import { DimensionRenderer } from './DimensionRenderer';
import { Point2D, SketchFeature, Dimension, CADEntity2D } from '../types/cad';
import { useDrawMachine } from '../hooks/useDrawMachine';
import { RubberbandPreview } from './RubberbandPreview';
import { SnapMarker } from './SnapMarker';
import { isEntityInSelectionBox, SelectionBox } from '../core/2d/BoxSelection';
import { ConstraintBadgeRenderer } from './ConstraintBadgeRenderer';
import { createFilletArc } from '../core/2d/FilletManager';

// 輔助函式：計算點到線段的最短距離
function getDistanceToLineSegment(p: Point2D, sStart: Point2D, sEnd: Point2D): number {
  const vx = sEnd.x - sStart.x;
  const vy = sEnd.y - sStart.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-10) {
    return Math.hypot(p.x - sStart.x, p.y - sStart.y);
  }
  const dx = p.x - sStart.x;
  const dy = p.y - sStart.y;
  const t = Math.max(0, Math.min(1, (dx * vx + dy * vy) / lenSq));
  const projX = sStart.x + t * vx;
  const projY = sStart.y + t * vy;
  return Math.hypot(p.x - projX, p.y - projY);
}

export const CADSketchCanvas: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [mouseWorldPos, setMouseWorldPos] = useState<Point2D>({ x: 0, y: 0 });

  // 框選狀態
  const [boxSelectStart, setBoxSelectStart] = useState<Point2D | null>(null);
  const [boxSelectCurrent, setBoxSelectCurrent] = useState<Point2D | null>(null);

  // 尺寸編輯狀態
  const [editingDimension, setEditingDimension] = useState<{
    dimension: Dimension;
    screenPos: Point2D;
    currentValue: string;
  } | null>(null);

  // 倒角錯誤狀態 (如半徑過大超出線段)
  const [filletError, setFilletError] = useState<string | null>(null);

  const {
    currentTool,
    activeSketchId,
    document,
    selectedEntityIds,
    osnapEnabled,
    selectEntity,
    clearSelection,
    updateConstraintValue,
  } = useCADStore();

  const handleSelectEntity = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (currentTool === 'SELECT') {
        if (!e.shiftKey) {
          clearSelection();
        }
        selectEntity(id);
      }
    },
    [currentTool, clearSelection, selectEntity]
  );

  const {
    drawSession,
    currentSnap,
    trimPreviewEntity,
    handlePointerMove: handleDrawPointerMove,
    handleCanvasClick,
    dimSelectedCircleOrArc,
    filletFirstLineId,
    filletRadius,
    setFilletRadius,
  } = useDrawMachine();

  const {
    pan,
    scale,
    worldToScreen,
    screenToWorld,
    handlers: viewportHandlers,
  } = useViewport({ initialPan: { x: 0, y: 0 }, initialScale: 1.0 });

  // 清除 filletError 當切換工具或第一條線被取消選取時
  useEffect(() => {
    setFilletError(null);
  }, [currentTool, filletFirstLineId]);

  // 處理雙擊編輯尺寸標註事件
  const handleEditDimension = useCallback((dim: Dimension) => {
    if (!dim.constraintId) return;
    
    // 找出對應的約束，讀取目前數值
    const sketch = document.featureTree.find(
      (f) => f.id === activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;
    const constraints = sketch?.constraints || [];
    const linkedConstraint = constraints.find((c) => c.id === dim.constraintId);
    
    const initialVal = linkedConstraint?.value !== undefined 
      ? linkedConstraint.value 
      : (dim.type === 'linear' 
          ? Math.hypot(dim.points[1].x - dim.points[0].x, dim.points[1].y - dim.points[0].y)
          : Math.hypot((dim.points[1]?.x || dim.points[0].x + 10) - dim.points[0].x, (dim.points[1]?.y || dim.points[0].y) - dim.points[0].y)
        );

    // 計算文字的螢幕座標位置
    const screenPt = worldToScreen(dim.textPosition);

    setEditingDimension({
      dimension: dim,
      screenPos: screenPt,
      currentValue: Number(initialVal.toFixed(2)).toString(),
    });
  }, [document, activeSketchId, worldToScreen]);

  const handleConfirmEdit = () => {
    if (!editingDimension) return;
    const { dimension, currentValue } = editingDimension;
    const value = parseFloat(currentValue);
    
    if (!isNaN(value) && value > 0) {
      if (dimension.constraintId) {
        updateConstraintValue(dimension.constraintId, value);
      }
    }
    setEditingDimension(null);
  };

  // 處理 Resize
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // 處理滑鼠移動時更新世界座標與繪圖狀態 (包含 scale 以進行鎖點計算)
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      viewportHandlers.onPointerMove(e);

      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const screenPt = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      
      const worldPt = screenToWorld(screenPt);
      setMouseWorldPos(worldPt);
      handleDrawPointerMove(worldPt, scale);

      // 若正在框選，更新目前世界座標
      if (boxSelectStart) {
        setBoxSelectCurrent(worldPt);
      }
    },
    [viewportHandlers, screenToWorld, handleDrawPointerMove, scale, boxSelectStart]
  );

  // 取得目前草圖內的 entities, profiles, constraints, dimensions 與 solverState
  let currentEntities: any[] = [];
  let currentProfiles: any[] = [];
  let currentConstraints: any[] = [];
  let currentDimensions: any[] = [];
  let currentSolverState: any = 'UnderDefined';
  if (activeSketchId) {
    const sketch = document.featureTree.find(
      (f) => f.id === activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;
    if (sketch) {
      currentEntities = sketch.entities;
      currentProfiles = sketch.profiles || [];
      currentConstraints = sketch.constraints || [];
      currentDimensions = sketch.dimensions || [];
      currentSolverState = sketch.solverState;
    }
  }

  // 處理滑鼠按鍵按下
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      viewportHandlers.onPointerDown(e);
      
      // 僅左鍵點擊 (button 0) 才觸發繪圖或框選事件
      if (e.button === 0) {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const screenPt = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        };
        const worldPt = screenToWorld(screenPt);

        if (currentTool === 'SELECT') {
          // 若點擊在空白背景處（未直接選中圖元），記錄框選起始點與當前點
          if (!(e.target as HTMLElement).closest('.cad-entity')) {
            setBoxSelectStart(worldPt);
            setBoxSelectCurrent(worldPt);
            // 若未按住 Shift 鍵，先呼叫 clearSelection() 清空已選圖元
            if (!e.shiftKey) {
              clearSelection();
            }
          }
        } else if (currentTool === 'FILLET') {
          // Fillet 工具的防呆與邊界驗證
          const clickPt = currentSnap ? currentSnap.point : worldPt;
          const threshold = 15 / scale;
          let closestEntity: any = null;
          let minDistance = threshold;

          for (const entity of currentEntities) {
            if (entity.type === 'line') {
              const dist = getDistanceToLineSegment(clickPt, entity.start, entity.end);
              if (dist < minDistance) {
                minDistance = dist;
                closestEntity = entity;
              }
            }
          }

          if (closestEntity && closestEntity.type === 'line') {
            if (!filletFirstLineId) {
              setFilletError(null);
              handleCanvasClick(worldPt, scale);
            } else if (closestEntity.id !== filletFirstLineId) {
              const firstLine = currentEntities.find((ent) => ent.id === filletFirstLineId);
              if (firstLine && firstLine.type === 'line') {
                const filletResult = createFilletArc(firstLine, closestEntity, filletRadius);
                if (!filletResult) {
                  // 圓角半徑過大，阻斷並在狀態列顯示錯誤
                  setFilletError('Fillet radius too large for selected lines');
                  return;
                }
              }
              setFilletError(null);
              handleCanvasClick(worldPt, scale);
            }
          }
        } else {
          handleCanvasClick(worldPt, scale);
        }
      }
    },
    [
      viewportHandlers,
      screenToWorld,
      currentTool,
      clearSelection,
      handleCanvasClick,
      scale,
      currentEntities,
      currentSnap,
      filletFirstLineId,
      filletRadius,
    ]
  );

  // 處理滑鼠放開
  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      viewportHandlers.onPointerUp(e);

      if (boxSelectStart) {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const screenPt = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        };
        const worldPt = screenToWorld(screenPt);

        // 計算世界座標包圍盒
        const minX = Math.min(boxSelectStart.x, worldPt.x);
        const maxX = Math.max(boxSelectStart.x, worldPt.x);
        const minY = Math.min(boxSelectStart.y, worldPt.y);
        const maxY = Math.max(boxSelectStart.y, worldPt.y);

        // 判定拖曳方向
        const isCrossing = worldPt.x < boxSelectStart.x; // 向左拉為 Crossing 綠框；向右拉為 Window 藍框

        // 若框的寬度與高度皆大於 1 / scale（避免單擊誤觸）
        if (maxX - minX > 1 / scale && maxY - minY > 1 / scale) {
          const selectionBox: SelectionBox = {
            minX,
            maxX,
            minY,
            maxY,
            isCrossing,
          };

          // 遍歷 currentEntities，篩選出符合條件的圖元
          const matchedEntities = currentEntities.filter((entity) =>
            isEntityInSelectionBox(entity, selectionBox)
          );

          // 將命中的圖元 ID 加入 Zustand 的 selectEntity
          matchedEntities.forEach((entity) => {
            selectEntity(entity.id);
          });
        }
      }

      // 清空框選狀態
      setBoxSelectStart(null);
      setBoxSelectCurrent(null);
    },
    [viewportHandlers, boxSelectStart, screenToWorld, scale, currentEntities, selectEntity]
  );

  // 處理滑鼠取消事件
  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      viewportHandlers.onPointerCancel(e);
      setBoxSelectStart(null);
      setBoxSelectCurrent(null);
    },
    [viewportHandlers]
  );

  // 格式化鎖點類型名稱
  const snapLabel = currentSnap
    ? `SNAP: [${currentSnap.type.charAt(0).toUpperCase() + currentSnap.type.slice(1)}]`
    : osnapEnabled
    ? 'SNAP: FREE'
    : 'SNAP: OFF';

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden bg-[#1E1E1E]"
      onWheel={viewportHandlers.onWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      style={{ touchAction: 'none' }}
    >
      {dimensions.width > 0 && dimensions.height > 0 && (
        <CADGrid
          pan={pan}
          scale={scale}
          width={dimensions.width}
          height={dimensions.height}
          screenToWorld={screenToWorld}
        />
      )}

      {dimensions.width > 0 && dimensions.height > 0 && (
        <svg
          width={dimensions.width}
          height={dimensions.height}
          style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
        >
          {/* 封閉面渲染層 (置於線條與節點下方) */}
          <ProfileRenderer
            profiles={currentProfiles}
            worldToScreen={worldToScreen}
          />
          <g style={{ pointerEvents: 'all' }}>
            <EntityRenderer
              entities={currentEntities}
              selectedIds={selectedEntityIds}
              worldToScreen={worldToScreen}
              scale={scale}
              solverState={currentSolverState}
              onSelectEntity={handleSelectEntity}
            />
          </g>
          {/* 約束視覺標記渲染層 (置於圖元渲染層上方) */}
          <ConstraintBadgeRenderer
            constraints={currentConstraints}
            entities={currentEntities}
            worldToScreen={worldToScreen}
          />
          {/* 尺寸標註渲染層 */}
          <g style={{ pointerEvents: 'all' }}>
            <DimensionRenderer
              dimensions={currentDimensions}
              entities={currentEntities}
              worldToScreen={worldToScreen}
              onEditDimension={handleEditDimension}
            />
          </g>
          {/* 疊加繪圖預覽層 */}
          <RubberbandPreview
            session={drawSession}
            tool={currentTool}
            worldToScreen={worldToScreen}
            scale={scale}
            dimSelectedCircleOrArc={dimSelectedCircleOrArc}
          />
          {/* 疊加鎖點標記層 (地位於圖元與預覽層上方) */}
          <SnapMarker
            snap={currentSnap}
            worldToScreen={worldToScreen}
          />
          {/* 固定點 (Fix Constraint) 標記層 (金黃色微型鎖頭圖示) */}
          {currentConstraints
            .filter((c: any) => c.type === 'fix' && c.entityIds?.length > 0)
            .map((c: any) => {
              const entityId = c.entityIds[0];
              const ptIdx = c.pointIndices?.[0] ?? 0;
              const entity = currentEntities.find((e: any) => e.id === entityId);
              if (!entity) return null;

              let worldPt: Point2D | null = null;
              if (entity.type === 'line') {
                worldPt = ptIdx === 1 ? entity.end : entity.start;
              } else if (entity.type === 'circle' || entity.type === 'arc') {
                worldPt = entity.center;
              } else if (entity.type === 'polyline') {
                worldPt = entity.points?.[ptIdx] || entity.points?.[0] || null;
              }

              if (!worldPt) return null;
              const screenPt = worldToScreen(worldPt);

              return (
                <g
                  key={c.id}
                  transform={`translate(${screenPt.x}, ${screenPt.y})`}
                  className="pointer-events-none select-none"
                >
                  {/* 背景微光圈 */}
                  <circle cx="0" cy="0" r="8" fill="#18181b" stroke="#eab308" strokeWidth="1.2" opacity="0.95" />
                  {/* 鎖扣 (Lock Shackle) */}
                  <path
                    d="M -2.5 -1 L -2.5 -3.2 A 2.5 2.5 0 0 1 2.5 -3.2 L 2.5 -1"
                    fill="none"
                    stroke="#facc15"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                  {/* 鎖身 (Lock Body) */}
                  <rect
                    x="-3.5"
                    y="-1"
                    width="7"
                    height="5.5"
                    rx="1"
                    fill="#facc15"
                  />
                  {/* 鎖孔 (Keyhole) */}
                  <circle cx="0" cy="1.6" r="0.6" fill="#18181b" />
                </g>
              );
            })}

          {/* Trim 預覽高亮層 */}
          {trimPreviewEntity && currentTool === 'TRIM' && (() => {
            const commonProps = {
              stroke: '#ef4444',
              strokeWidth: 3,
              strokeDasharray: '4,4',
              fill: 'none',
              className: 'cad-trim-preview',
            };

            if (trimPreviewEntity.type === 'line') {
              const start = worldToScreen(trimPreviewEntity.start);
              const end = worldToScreen(trimPreviewEntity.end);
              return (
                <line
                  key={trimPreviewEntity.id}
                  x1={start.x}
                  y1={start.y}
                  x2={end.x}
                  y2={end.y}
                  {...commonProps}
                />
              );
            } else if (trimPreviewEntity.type === 'arc') {
              const worldStart = {
                x: trimPreviewEntity.center.x + trimPreviewEntity.radius * Math.cos(trimPreviewEntity.startAngle),
                y: trimPreviewEntity.center.y + trimPreviewEntity.radius * Math.sin(trimPreviewEntity.startAngle),
              };
              const worldEnd = {
                x: trimPreviewEntity.center.x + trimPreviewEntity.radius * Math.cos(trimPreviewEntity.endAngle),
                y: trimPreviewEntity.center.y + trimPreviewEntity.radius * Math.sin(trimPreviewEntity.endAngle),
              };

              const start = worldToScreen(worldStart);
              const end = worldToScreen(worldEnd);
              const screenRadius = trimPreviewEntity.radius * scale;

              let diff = trimPreviewEntity.endAngle - trimPreviewEntity.startAngle;
              while (diff < 0) diff += 2 * Math.PI;
              while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

              const largeArcFlag = diff > Math.PI ? 1 : 0;
              const sweepFlag = 0;

              const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

              return (
                <path
                  key={trimPreviewEntity.id}
                  d={pathData}
                  {...commonProps}
                />
              );
            }
            return null;
          })()}

          {/* Fillet first line yellow dashed line overlay */}
          {filletFirstLineId && (() => {
            const line = currentEntities.find((e) => e.id === filletFirstLineId);
            if (line && line.type === 'line') {
              const start = worldToScreen(line.start);
              const end = worldToScreen(line.end);
              return (
                <g key="fillet-first-line-overlay">
                  <line
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    stroke="#eab308" // yellow-500
                    strokeWidth="3.5"
                    strokeDasharray="6,4"
                    fill="none"
                  />
                  <text
                    x={(start.x + end.x) / 2}
                    y={(start.y + end.y) / 2 - 12}
                    fill="#facc15" // yellow-400
                    fontSize="12"
                    fontFamily="monospace"
                    textAnchor="middle"
                    className="select-none pointer-events-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
                  >
                    已選中第一條線，請點選第二條線
                  </text>
                </g>
              );
            }
            return null;
          })()}

          {/* AutoCAD 框選矩形預覽 */}
          {boxSelectStart && boxSelectCurrent && (() => {
            const pStart = worldToScreen(boxSelectStart);
            const pCur = worldToScreen(boxSelectCurrent);
            const rectX = Math.min(pStart.x, pCur.x);
            const rectY = Math.min(pStart.y, pCur.y);
            const rectW = Math.abs(pCur.x - pStart.x);
            const rectH = Math.abs(pCur.y - pStart.y);

            const isCrossing = pCur.x < pStart.x;
            const fill = isCrossing ? 'rgba(52, 199, 89, 0.15)' : 'rgba(0, 122, 255, 0.15)';
            const stroke = isCrossing ? '#34c759' : '#007aff';
            const strokeDasharray = isCrossing ? '4,4' : undefined;

            return (
              <rect
                x={rectX}
                y={rectY}
                width={rectW}
                height={rectH}
                fill={fill}
                stroke={stroke}
                strokeWidth="1"
                strokeDasharray={strokeDasharray}
                className="pointer-events-none"
              />
            );
          })()}
        </svg>
      )}

      {/* Fillet 半徑即時微調膠囊框 */}
      {currentTool === 'FILLET' && (
        <div className="absolute top-4 right-4 z-40 px-4 py-2 bg-neutral-900/90 border border-neutral-700 text-neutral-200 font-mono text-xs rounded-full shadow-2xl flex items-center gap-2 select-none">
          <span className="text-neutral-400 font-bold tracking-wider">Radius:</span>
          <div className="flex items-center bg-neutral-950 border border-neutral-700 hover:border-amber-500 focus-within:border-amber-500 rounded px-1.5 py-0.5 transition-colors">
            <input
              type="number"
              min="0.1"
              step="0.5"
              className="w-14 text-center text-amber-400 bg-transparent border-none focus:outline-none focus:ring-0 font-bold font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none p-0"
              value={filletRadius === 0 ? '' : filletRadius}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) {
                  setFilletRadius(val);
                  setFilletError(null);
                } else {
                  setFilletRadius(0);
                }
              }}
              onBlur={() => {
                if (filletRadius <= 0) {
                  setFilletRadius(10);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
            />
            <span className="text-neutral-500 select-none font-bold ml-1">mm</span>
          </div>
        </div>
      )}

      {/* AutoCAD 風格的黑色半透明狀態列 */}
      <div className="absolute bottom-0 right-0 m-4 px-4 py-2 bg-black bg-opacity-70 text-green-400 font-mono text-sm rounded pointer-events-none select-none flex gap-6 items-center">
        <div className={filletError ? "text-red-400 font-bold animate-pulse" : ""}>
          {filletError
            ? filletError
            : currentTool === 'TRIM'
            ? 'Trim: Click intersecting edge to cut'
            : currentTool === 'DIMENSION'
            ? 'Dimension: Click entity/points, then click to place dimension'
            : currentTool === 'FILLET'
            ? (filletFirstLineId
                ? 'Fillet: Pick second intersecting line'
                : `Fillet: Pick first line (R=${filletRadius}mm)`)
            : drawSession.isDrawing
            ? `Drawing: ${currentTool} (Pick next point or ESC to exit)`
            : 'Ready'}
        </div>
        <div className="text-sky-300 font-bold">
          {currentProfiles.length > 0
            ? `Profiles: ${currentProfiles.length} (${currentProfiles
                .reduce((acc, p) => acc + p.area, 0)
                .toFixed(1)} mm²)`
            : 'Profiles: 0 (Open)'}
        </div>
        <div className={currentSnap ? 'text-emerald-400 font-bold' : 'text-green-400'}>
          {snapLabel}
        </div>
        <div>
          X: {mouseWorldPos.x.toFixed(2)}, Y: {mouseWorldPos.y.toFixed(2)}
        </div>
        <div>
          Scale: {scale.toFixed(2)}x
        </div>
      </div>

      {/* 尺寸修改浮動輸入框 */}
      {editingDimension && (
        <div
          className="absolute z-50 p-2 bg-neutral-900/95 border border-neutral-700 rounded-md shadow-2xl flex items-center gap-1.5"
          style={{
            left: `${editingDimension.screenPos.x}px`,
            top: `${editingDimension.screenPos.y}px`,
            transform: 'translate(-50%, -50%)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="text"
            className="w-24 px-2 py-1 text-sm text-center font-mono text-emerald-400 bg-neutral-950 border border-neutral-600 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
            value={editingDimension.currentValue}
            onChange={(e) =>
              setEditingDimension({
                ...editingDimension,
                currentValue: e.target.value,
              })
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleConfirmEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditingDimension(null);
              }
            }}
            autoFocus
            onFocus={(e) => e.target.select()}
            onBlur={handleConfirmEdit}
          />
          <span className="text-xs text-neutral-400 font-mono pr-1">mm</span>
        </div>
      )}
    </div>
  );
};
