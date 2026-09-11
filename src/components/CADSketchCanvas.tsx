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
import { createFillet } from '../core/2d/FilletManager';
import { createChamfer } from '../core/2d/ChamferManager';
import { isAngleOnArc } from '../core/2d/IntersectionEngine';
import { CircularArrayPanel } from './CircularArrayPanel';
import { RectangularArrayPanel } from './RectangularArrayPanel';

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

function getDistanceToArcSegment(
  p: Point2D,
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number
): number {
  const thetaP = Math.atan2(p.y - center.y, p.x - center.x);
  if (isAngleOnArc(thetaP, startAngle, endAngle)) {
    const distToCenter = Math.hypot(p.x - center.x, p.y - center.y);
    return Math.abs(distToCenter - radius);
  } else {
    const pStart = {
      x: center.x + radius * Math.cos(startAngle),
      y: center.y + radius * Math.sin(startAngle),
    };
    const pEnd = {
      x: center.x + radius * Math.cos(endAngle),
      y: center.y + radius * Math.sin(endAngle),
    };
    const dStart = Math.hypot(p.x - pStart.x, p.y - pStart.y);
    const dEnd = Math.hypot(p.x - pEnd.x, p.y - pEnd.y);
    return Math.min(dStart, dEnd);
  }
}

function getDistanceToEntity(p: Point2D, entity: CADEntity2D): number {
  if (entity.type === 'line') {
    return getDistanceToLineSegment(p, entity.start, entity.end);
  } else if (entity.type === 'arc') {
    return getDistanceToArcSegment(p, entity.center, entity.radius, entity.startAngle, entity.endAngle);
  }
  return Infinity;
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

  // 圓角錯誤狀態 (如半徑過大超出線段)
  const [filletError, setFilletError] = useState<string | null>(null);
  // 倒角錯誤狀態 (如距離過大超出線段或平行)
  const [chamferError, setChamferError] = useState<string | null>(null);

  const {
    currentTool,
    activeSketchId,
    document,
    selectedEntityIds,
    osnapEnabled,
    selectEntity,
    clearSelection,
    updateConstraintValue,
    orthoEnabled,
    polarTrackingEnabled,
    polarAngleStep,
    setPolarModalOpen,
    arrayItems,
    arrayFillAngle,
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
    extendPreview,
    handlePointerMove: handleDrawPointerMove,
    handleCanvasClick,
    dimSelectedCircleOrArc,
    dimSelectedLineId,
    dimSelectedLineId2,
    filletFirstEntityId,
    filletRadius,
    setFilletRadius,
    chamferFirstEntityId,
    chamferDistance,
    setChamferDistance,
    cancelDrawing,
    offsetTargetId,
    offsetDistance,
    setOffsetDistance,
    offsetPreviewEntity,
    polylineMode,
    lastTangentDir,
    togglePolylineMode,
    polylineWarning,
    mirrorStep,
    mirrorSourceIds,
    mirrorPreviewEntities,
    setMirrorStep,
    moveStep,
    setMoveStep,
    moveSourceIds,
    setMoveSourceIds,
    moveBasePoint,
    movePreviewEntities,
    scaleStep,
    setScaleStep,
    scaleSourceIds,
    setScaleSourceIds,
    scaleBasePoint,
    scalePreviewEntities,
    currentScaleFactor,
    submitScaleFactor,
    rotateStep,
    setRotateStep,
    rotateSourceIds,
    setRotateSourceIds,
    rotateBasePoint,
    rotatePreviewEntities,
    currentRotateAngleDeg,
    submitRotateAngle,
    arrayStep,
    setArrayStep,
    arraySourceIds,
    setArraySourceIds,
    arrayCenterPoint,
    arrayPreviewEntities,
    rectArraySourceIds,
    setRectArraySourceIds,
    rectArrayPreviewEntities,
    polarTracking,
    polarExtensionIntersection,
    otrackAnchors,
    otrackGuideLines,
    submitExactLength,
    isDraggingDimText,
    startDragDimensionText,
    endDragDimensionText,
  } = useDrawMachine();

  // Dynamic DDE / HUD states
  const [hudInputLength, setHudInputLength] = useState<string>('');
  const [isHudFocused, setIsHudFocused] = useState<boolean>(false);
  const hudRef = useRef<HTMLInputElement>(null);

  // Auto-reset DDE HUD when drawing ends
  useEffect(() => {
    if (!drawSession.isDrawing) {
      setHudInputLength('');
      setIsHudFocused(false);
    }
  }, [drawSession.isDrawing]);

  // Global keydown interception to capture numbers and dot keys
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        isHudFocused
      ) {
        return;
      }

      if (
        (currentTool === 'LINE' || currentTool === 'POLYLINE' || currentTool === 'CIRCLE' || currentTool === 'MOVE' || currentTool === 'COPY' || currentTool === 'SCALE' || currentTool === 'ROTATE') &&
        drawSession.isDrawing
      ) {
        // Intercept digit keys 0-9, period '.', and minus '-'
        if (/^[0-9.-]$/.test(e.key)) {
          e.preventDefault();
          setHudInputLength(e.key);
          setIsHudFocused(true);
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown, true);
    };
  }, [currentTool, drawSession.isDrawing, isHudFocused]);

  // Focus input when DDE becomes active
  useEffect(() => {
    if (isHudFocused && hudRef.current) {
      hudRef.current.focus();
    }
  }, [isHudFocused]);

  const {
    pan,
    scale,
    worldToScreen,
    screenToWorld,
    handlers: viewportHandlers,
  } = useViewport({ initialPan: { x: 0, y: 0 }, initialScale: 1.0 });

  // 清除 filletError / chamferError 當切換工具或第一條線被取消選取時
  useEffect(() => {
    setFilletError(null);
    setChamferError(null);
  }, [currentTool, filletFirstEntityId, chamferFirstEntityId]);

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

  // 執行矩形陣列生成：讀取來源圖元與 Store 參數並套用變異
  const executeRectArray = useCallback(() => {
    if (rectArraySourceIds.length === 0) return;
    const {
      rectArrayCols: cols,
      rectArrayRows: rows,
      rectArrayColSpacing: colSpacing,
      rectArrayRowSpacing: rowSpacing,
      rectArrayEntities: applyRectArray,
    } = useCADStore.getState();
    applyRectArray(rectArraySourceIds, cols, rows, colSpacing, rowSpacing);
    cancelDrawing();
  }, [rectArraySourceIds, cancelDrawing]);

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

  // 計算向內偏移半徑錯誤狀態
  const getOffsetRadiusError = () => {
    if (currentTool !== 'OFFSET' || !offsetTargetId) return null;
    const targetEntity = currentEntities.find((e) => e.id === offsetTargetId);
    if (!targetEntity || (targetEntity.type !== 'circle' && targetEntity.type !== 'arc')) return null;

    // 計算滑鼠到圓心/弧心的距離，以判斷是否在內側 (向內偏移)
    const dist = Math.hypot(mouseWorldPos.x - targetEntity.center.x, mouseWorldPos.y - targetEntity.center.y);
    if (dist < targetEntity.radius && offsetDistance >= targetEntity.radius) {
      return 'Offset distance exceeds radius!';
    }
    return null;
  };
  const offsetRadiusError = getOffsetRadiusError();

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
            if (entity.type === 'line' || entity.type === 'arc') {
              const dist = getDistanceToEntity(clickPt, entity);
              if (dist < minDistance) {
                minDistance = dist;
                closestEntity = entity;
              }
            }
          }

          if (closestEntity && (closestEntity.type === 'line' || closestEntity.type === 'arc')) {
            if (!filletFirstEntityId) {
              setFilletError(null);
              handleCanvasClick(worldPt, scale);
            } else if (closestEntity.id !== filletFirstEntityId) {
              const firstEnt = currentEntities.find((ent) => ent.id === filletFirstEntityId);
              if (firstEnt && (firstEnt.type === 'line' || firstEnt.type === 'arc')) {
                const filletResult = createFillet(firstEnt, closestEntity, filletRadius);
                if (!filletResult) {
                  // 圓角半徑過大，阻斷並在狀態列顯示錯誤
                  setFilletError('Fillet radius too large or invalid geometry transition');
                  return;
                }
              }
              setFilletError(null);
              handleCanvasClick(worldPt, scale);
            }
          } else {
            // 點擊未命中任何線段/圓弧：明確攔截事件並提供清空選擇與取消提示，防止狀態穿透
            e.stopPropagation();
            if (filletFirstEntityId) {
              setFilletError('Selection cleared. Pick first line or arc again.');
              cancelDrawing();
            } else {
              setFilletError('Please select a line or arc segment.');
            }
          }
        } else if (currentTool === 'CHAMFER') {
          // Chamfer 工具的防呆與邊界驗證
          const clickPt = currentSnap ? currentSnap.point : worldPt;
          const threshold = 15 / scale;
          let closestEntity: any = null;
          let minDistance = threshold;

          for (const entity of currentEntities) {
            if (entity.type === 'line') {
              const dist = getDistanceToEntity(clickPt, entity);
              if (dist < minDistance) {
                minDistance = dist;
                closestEntity = entity;
              }
            }
          }

          if (closestEntity && closestEntity.type === 'line') {
            if (!chamferFirstEntityId) {
              setChamferError(null);
              handleCanvasClick(worldPt, scale);
            } else if (closestEntity.id !== chamferFirstEntityId) {
              const firstEnt = currentEntities.find((ent) => ent.id === chamferFirstEntityId);
              if (firstEnt && firstEnt.type === 'line') {
                const chamferResult = createChamfer(firstEnt, closestEntity, chamferDistance);
                if (!chamferResult) {
                  // 倒角距離過大或兩線平行，阻斷並在狀態列顯示錯誤
                  setChamferError('Chamfer distance too large or lines are parallel');
                  return;
                }
              }
              setChamferError(null);
              handleCanvasClick(worldPt, scale);
            }
          } else {
            // 點擊未命中任何直線：明確攔截事件並提供清空選擇與取消提示，防止狀態穿透
            e.stopPropagation();
            if (chamferFirstEntityId) {
              setChamferError('Selection cleared. Pick first line again.');
              cancelDrawing();
            } else {
              setChamferError('Please select a line segment.');
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
      filletFirstEntityId,
      filletRadius,
      chamferFirstEntityId,
      chamferDistance,
      cancelDrawing,
    ]
  );

  const handleStartDragDimensionText = useCallback(
    (dim: Dimension, e: React.PointerEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const screenPt = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      const worldPt = screenToWorld(screenPt);
      startDragDimensionText(dim.id, dim.textPosition, worldPt);
    },
    [screenToWorld, startDragDimensionText]
  );

  // 處理滑鼠放開
  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      viewportHandlers.onPointerUp(e);

      if (isDraggingDimText) {
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const screenPt = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          };
          const worldPt = screenToWorld(screenPt);
          endDragDimensionText(worldPt);
        } else {
          endDragDimensionText();
        }
        return;
      }

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
    [viewportHandlers, isDraggingDimText, endDragDimensionText, boxSelectStart, screenToWorld, scale, currentEntities, selectEntity]
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
              onStartDragDimensionText={handleStartDragDimensionText}
            />
          </g>
          {/* 疊加繪圖預覽層 */}
          <RubberbandPreview
            session={drawSession}
            tool={currentTool}
            worldToScreen={worldToScreen}
            scale={scale}
            dimSelectedCircleOrArc={dimSelectedCircleOrArc}
            dimLine1={currentEntities.find(e => e.id === dimSelectedLineId) as any}
            dimLine2={currentEntities.find(e => e.id === dimSelectedLineId2) as any}
            polylineMode={polylineMode}
            lastTangentDir={lastTangentDir}
            movePreviewEntities={movePreviewEntities}
            scalePreviewEntities={scalePreviewEntities}
            rotatePreviewEntities={rotatePreviewEntities}
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

          {/* Extend 預覽高亮層 */}
          {extendPreview && currentTool === 'EXTEND' && (() => {
            const previewEntity = extendPreview.previewEntity;
            const commonProps = {
              stroke: '#10b981',
              strokeWidth: 3,
              strokeDasharray: '4,4',
              fill: 'none',
              className: 'cad-extend-preview',
            };

            if (previewEntity.type === 'line') {
              const start = worldToScreen(previewEntity.start);
              const end = worldToScreen(previewEntity.end);
              return (
                <line
                  key={`extend-preview-${previewEntity.id}`}
                  x1={start.x}
                  y1={start.y}
                  x2={end.x}
                  y2={end.y}
                  {...commonProps}
                />
              );
            } else if (previewEntity.type === 'arc') {
              const worldStart = {
                x: previewEntity.center.x + previewEntity.radius * Math.cos(previewEntity.startAngle),
                y: previewEntity.center.y + previewEntity.radius * Math.sin(previewEntity.startAngle),
              };
              const worldEnd = {
                x: previewEntity.center.x + previewEntity.radius * Math.cos(previewEntity.endAngle),
                y: previewEntity.center.y + previewEntity.radius * Math.sin(previewEntity.endAngle),
              };

              const start = worldToScreen(worldStart);
              const end = worldToScreen(worldEnd);
              const screenRadius = previewEntity.radius * scale;

              let diff = previewEntity.endAngle - previewEntity.startAngle;
              while (diff < 0) diff += 2 * Math.PI;
              while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

              const largeArcFlag = diff > Math.PI ? 1 : 0;
              const sweepFlag = 0;

              const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

              return (
                <path
                  key={`extend-preview-${previewEntity.id}`}
                  d={pathData}
                  {...commonProps}
                />
              );
            }
            return null;
          })()}

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

          {/* Offset 預覽高亮層 */}
          {offsetPreviewEntity && currentTool === 'OFFSET' && (() => {
            const commonProps = {
              stroke: '#38bdf8',
              strokeWidth: 2,
              strokeDasharray: '5,5',
              fill: 'none',
              className: 'cad-offset-preview',
            };

            if (offsetPreviewEntity.type === 'line') {
              const start = worldToScreen(offsetPreviewEntity.start);
              const end = worldToScreen(offsetPreviewEntity.end);
              return (
                <line
                  key={`offset-preview-${offsetPreviewEntity.id}`}
                  x1={start.x}
                  y1={start.y}
                  x2={end.x}
                  y2={end.y}
                  {...commonProps}
                />
              );
            } else if (offsetPreviewEntity.type === 'circle') {
              const center = worldToScreen(offsetPreviewEntity.center);
              return (
                <circle
                  key={`offset-preview-${offsetPreviewEntity.id}`}
                  cx={center.x}
                  cy={center.y}
                  r={offsetPreviewEntity.radius * scale}
                  {...commonProps}
                />
              );
            } else if (offsetPreviewEntity.type === 'arc') {
              const worldStart = {
                x: offsetPreviewEntity.center.x + offsetPreviewEntity.radius * Math.cos(offsetPreviewEntity.startAngle),
                y: offsetPreviewEntity.center.y + offsetPreviewEntity.radius * Math.sin(offsetPreviewEntity.startAngle),
              };
              const worldEnd = {
                x: offsetPreviewEntity.center.x + offsetPreviewEntity.radius * Math.cos(offsetPreviewEntity.endAngle),
                y: offsetPreviewEntity.center.y + offsetPreviewEntity.radius * Math.sin(offsetPreviewEntity.endAngle),
              };

              const start = worldToScreen(worldStart);
              const end = worldToScreen(worldEnd);
              const screenRadius = offsetPreviewEntity.radius * scale;

              let diff = offsetPreviewEntity.endAngle - offsetPreviewEntity.startAngle;
              while (diff < 0) diff += 2 * Math.PI;
              while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

              const largeArcFlag = diff > Math.PI ? 1 : 0;
              const sweepFlag = 0;

              const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

              return (
                <path
                  key={`offset-preview-${offsetPreviewEntity.id}`}
                  d={pathData}
                  {...commonProps}
                />
              );
            }
            return null;
          })()}

          {/* Fillet first entity yellow dashed overlay */}
          {filletFirstEntityId && (() => {
            const entity = currentEntities.find((e) => e.id === filletFirstEntityId);
            if (!entity) return null;

            const commonOverlayProps = {
              stroke: '#eab308', // yellow-500
              strokeWidth: 3.5,
              strokeDasharray: '6,4',
              fill: 'none',
            };

            if (entity.type === 'line') {
              const start = worldToScreen(entity.start);
              const end = worldToScreen(entity.end);
              return (
                <g key="fillet-first-entity-overlay">
                  <line
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    {...commonOverlayProps}
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
                    已選中第一條圖元，請點選第二條圖元
                  </text>
                </g>
              );
            } else if (entity.type === 'arc') {
              const worldStart = {
                x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
                y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
              };
              const worldEnd = {
                x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
                y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
              };

              const start = worldToScreen(worldStart);
              const end = worldToScreen(worldEnd);
              const screenRadius = entity.radius * scale;

              let diff = entity.endAngle - entity.startAngle;
              while (diff < 0) diff += 2 * Math.PI;
              while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

              const largeArcFlag = diff > Math.PI ? 1 : 0;
              const sweepFlag = 0;

              const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;
              const centerScreen = worldToScreen(entity.center);

              return (
                <g key="fillet-first-entity-overlay">
                  <path d={pathData} {...commonOverlayProps} />
                  <text
                    x={centerScreen.x}
                    y={centerScreen.y - 12}
                    fill="#facc15" // yellow-400
                    fontSize="12"
                    fontFamily="monospace"
                    textAnchor="middle"
                    className="select-none pointer-events-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
                  >
                    已選中第一條圖元，請點選第二條圖元
                  </text>
                </g>
              );
            }
            return null;
          })()}

          {/* Chamfer first entity purple dashed overlay */}
          {chamferFirstEntityId && (() => {
            const entity = currentEntities.find((e) => e.id === chamferFirstEntityId);
            if (!entity || entity.type !== 'line') return null;

            const commonOverlayProps = {
              stroke: '#a855f7', // purple-500
              strokeWidth: 3.5,
              strokeDasharray: '6,4',
              fill: 'none',
            };

            const start = worldToScreen(entity.start);
            const end = worldToScreen(entity.end);
            return (
              <g key="chamfer-first-entity-overlay">
                <line
                  x1={start.x}
                  y1={start.y}
                  x2={end.x}
                  y2={end.y}
                  {...commonOverlayProps}
                />
                <text
                  x={(start.x + end.x) / 2}
                  y={(start.y + end.y) / 2 - 12}
                  fill="#c084fc" // purple-400
                  fontSize="12"
                  fontFamily="monospace"
                  textAnchor="middle"
                  className="select-none pointer-events-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
                >
                  已選中第一條圖元，請點選第二條直線圖元
                </text>
              </g>
            );
          })()}

          {/* Mirror 來源圖元加粗高亮 */}
          {currentTool === 'MIRROR' && mirrorSourceIds.length > 0 && (() => {
            return currentEntities
              .filter((e) => mirrorSourceIds.includes(e.id))
              .map((entity) => {
                const commonProps = {
                  stroke: '#c084fc', // purple-400
                  strokeWidth: 5,
                  fill: 'none',
                  opacity: 0.6,
                };

                if (entity.type === 'line') {
                  const start = worldToScreen(entity.start);
                  const end = worldToScreen(entity.end);
                  return (
                    <line
                      key={`mirror-source-${entity.id}`}
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'circle') {
                  const center = worldToScreen(entity.center);
                  return (
                    <circle
                      key={`mirror-source-${entity.id}`}
                      cx={center.x}
                      cy={center.y}
                      r={entity.radius * scale}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'arc') {
                  const worldStart = {
                    x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
                    y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
                  };
                  const worldEnd = {
                    x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
                    y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
                  };

                  const start = worldToScreen(worldStart);
                  const end = worldToScreen(worldEnd);
                  const screenRadius = entity.radius * scale;

                  let diff = entity.endAngle - entity.startAngle;
                  while (diff < 0) diff += 2 * Math.PI;
                  while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

                  const largeArcFlag = diff > Math.PI ? 1 : 0;
                  const sweepFlag = 0;

                  const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

                  return (
                    <path
                      key={`mirror-source-${entity.id}`}
                      d={pathData}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'polyline') {
                  const points = entity.points.map(pt => worldToScreen(pt));
                  const pathData = points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ') + (entity.closed ? ' Z' : '');
                  return (
                    <path
                      key={`mirror-source-${entity.id}`}
                      d={pathData}
                      {...commonProps}
                    />
                  );
                }
                return null;
              });
          })()}

          {/* Mirror 預覽圖元 */}
          {currentTool === 'MIRROR' && mirrorPreviewEntities && (() => {
            return mirrorPreviewEntities.map((entity) => {
              const commonProps = {
                stroke: '#a855f7', // purple-500
                strokeWidth: 2,
                strokeDasharray: '4,4',
                fill: 'none',
              };

              if (entity.type === 'line') {
                const start = worldToScreen(entity.start);
                const end = worldToScreen(entity.end);
                return (
                  <line
                    key={`mirror-preview-${entity.id}`}
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    {...commonProps}
                  />
                );
              } else if (entity.type === 'circle') {
                const center = worldToScreen(entity.center);
                return (
                  <circle
                    key={`mirror-preview-${entity.id}`}
                    cx={center.x}
                    cy={center.y}
                    r={entity.radius * scale}
                    {...commonProps}
                  />
                );
              } else if (entity.type === 'arc') {
                const worldStart = {
                  x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
                  y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
                };
                const worldEnd = {
                  x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
                  y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
                };

                const start = worldToScreen(worldStart);
                const end = worldToScreen(worldEnd);
                const screenRadius = entity.radius * scale;

                let diff = entity.endAngle - entity.startAngle;
                while (diff < 0) diff += 2 * Math.PI;
                while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

                const largeArcFlag = diff > Math.PI ? 1 : 0;
                const sweepFlag = 0;

                const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

                return (
                  <path
                    key={`mirror-preview-${entity.id}`}
                    d={pathData}
                    {...commonProps}
                  />
                );
              } else if (entity.type === 'polyline') {
                const points = entity.points.map(pt => worldToScreen(pt));
                const pathData = points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ') + (entity.closed ? ' Z' : '');
                return (
                  <path
                    key={`mirror-preview-${entity.id}`}
                    d={pathData}
                    {...commonProps}
                  />
                );
              }
              return null;
            });
          })()}

          {/* Move / Copy 來源圖元加粗高亮 */}
          {(currentTool === 'MOVE' || currentTool === 'COPY') && moveSourceIds.length > 0 && (() => {
            const isCopy = currentTool === 'COPY';
            const highlightColor = isCopy ? '#38bdf8' : '#f59e0b';
            return currentEntities
              .filter((e) => moveSourceIds.includes(e.id))
              .map((entity) => {
                const commonProps = {
                  stroke: highlightColor,
                  strokeWidth: 4,
                  fill: 'none',
                  opacity: 0.6,
                };

                if (entity.type === 'line') {
                  const start = worldToScreen(entity.start);
                  const end = worldToScreen(entity.end);
                  return (
                    <line
                      key={`move-source-${entity.id}`}
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'circle') {
                  const center = worldToScreen(entity.center);
                  return (
                    <circle
                      key={`move-source-${entity.id}`}
                      cx={center.x}
                      cy={center.y}
                      r={entity.radius * scale}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'arc') {
                  const worldStart = {
                    x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
                    y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
                  };
                  const worldEnd = {
                    x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
                    y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
                  };

                  const start = worldToScreen(worldStart);
                  const end = worldToScreen(worldEnd);
                  const screenRadius = entity.radius * scale;

                  let diff = entity.endAngle - entity.startAngle;
                  while (diff < 0) diff += 2 * Math.PI;
                  while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

                  const largeArcFlag = diff > Math.PI ? 1 : 0;
                  const sweepFlag = 0;

                  const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

                  return (
                    <path
                      key={`move-source-${entity.id}`}
                      d={pathData}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'polyline') {
                  const points = entity.points.map((pt) => worldToScreen(pt));
                  const pathData =
                    points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ') +
                    (entity.closed ? ' Z' : '');
                  return (
                    <path
                      key={`move-source-${entity.id}`}
                      d={pathData}
                      {...commonProps}
                    />
                  );
                }
                return null;
              });
          })()}

          {/* Rotate 來源圖元加粗高亮 */}
          {currentTool === 'ROTATE' && rotateSourceIds.length > 0 && (() => {
            const highlightColor = '#38bdf8';
            return currentEntities
              .filter((e) => rotateSourceIds.includes(e.id))
              .map((entity) => {
                const commonProps = {
                  stroke: highlightColor,
                  strokeWidth: 4,
                  fill: 'none',
                  opacity: 0.6,
                };

                if (entity.type === 'line') {
                  const start = worldToScreen(entity.start);
                  const end = worldToScreen(entity.end);
                  return (
                    <line
                      key={`rotate-source-${entity.id}`}
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'circle') {
                  const center = worldToScreen(entity.center);
                  return (
                    <circle
                      key={`rotate-source-${entity.id}`}
                      cx={center.x}
                      cy={center.y}
                      r={entity.radius * scale}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'arc') {
                  const worldStart = {
                    x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
                    y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
                  };
                  const worldEnd = {
                    x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
                    y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
                  };

                  const start = worldToScreen(worldStart);
                  const end = worldToScreen(worldEnd);
                  const screenRadius = entity.radius * scale;

                  let diff = entity.endAngle - entity.startAngle;
                  while (diff < 0) diff += 2 * Math.PI;
                  while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

                  const largeArcFlag = diff > Math.PI ? 1 : 0;
                  const sweepFlag = 0;

                  const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

                  return (
                    <path
                      key={`rotate-source-${entity.id}`}
                      d={pathData}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'polyline') {
                  const points = entity.points.map((pt) => worldToScreen(pt));
                  const pathData =
                    points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ') +
                    (entity.closed ? ' Z' : '');
                  return (
                    <path
                      key={`rotate-source-${entity.id}`}
                      d={pathData}
                      {...commonProps}
                    />
                  );
                }
                return null;
              });
          })()}

          {/* Circular Array 來源圖元加粗高亮 */}
          {currentTool === 'CIRCULAR_ARRAY' && arraySourceIds.length > 0 && (() => {
            const highlightColor = '#c084fc';
            return currentEntities
              .filter((e) => arraySourceIds.includes(e.id))
              .map((entity) => {
                const commonProps = {
                  stroke: highlightColor,
                  strokeWidth: 4,
                  fill: 'none',
                  opacity: 0.7,
                };

                if (entity.type === 'line') {
                  const start = worldToScreen(entity.start);
                  const end = worldToScreen(entity.end);
                  return (
                    <line
                      key={`array-source-${entity.id}`}
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'circle') {
                  const center = worldToScreen(entity.center);
                  return (
                    <circle
                      key={`array-source-${entity.id}`}
                      cx={center.x}
                      cy={center.y}
                      r={entity.radius * scale}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'arc') {
                  const worldStart = {
                    x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
                    y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
                  };
                  const worldEnd = {
                    x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
                    y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
                  };

                  const start = worldToScreen(worldStart);
                  const end = worldToScreen(worldEnd);
                  const screenRadius = entity.radius * scale;

                  let diff = entity.endAngle - entity.startAngle;
                  while (diff < 0) diff += 2 * Math.PI;
                  while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

                  const largeArcFlag = diff > Math.PI ? 1 : 0;
                  const sweepFlag = 0;

                  const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

                  return (
                    <path
                      key={`array-source-${entity.id}`}
                      d={pathData}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'polyline') {
                  const points = entity.points.map((pt) => worldToScreen(pt));
                  const pathData =
                    points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ') +
                    (entity.closed ? ' Z' : '');
                  return (
                    <path
                      key={`array-source-${entity.id}`}
                      d={pathData}
                      {...commonProps}
                    />
                  );
                }
                return null;
              });
          })()}

          {/* Circular Array 即時分身動態預覽 */}
          {currentTool === 'CIRCULAR_ARRAY' && arrayPreviewEntities && arrayPreviewEntities.length > 0 && (() => {
            const previewProps = {
              stroke: '#d8b4fe',
              strokeWidth: 2,
              strokeDasharray: '6,4',
              fill: 'none',
              opacity: 0.85,
            };

            return arrayPreviewEntities.map((entity) => {
              if (entity.type === 'line') {
                const start = worldToScreen(entity.start);
                const end = worldToScreen(entity.end);
                return (
                  <line
                    key={entity.id}
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    {...previewProps}
                  />
                );
              } else if (entity.type === 'circle') {
                const center = worldToScreen(entity.center);
                return (
                  <circle
                    key={entity.id}
                    cx={center.x}
                    cy={center.y}
                    r={entity.radius * scale}
                    {...previewProps}
                  />
                );
              } else if (entity.type === 'arc') {
                const worldStart = {
                  x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
                  y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
                };
                const worldEnd = {
                  x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
                  y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
                };

                const start = worldToScreen(worldStart);
                const end = worldToScreen(worldEnd);
                const screenRadius = entity.radius * scale;

                let diff = entity.endAngle - entity.startAngle;
                while (diff < 0) diff += 2 * Math.PI;
                while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

                const largeArcFlag = diff > Math.PI ? 1 : 0;
                const sweepFlag = 0;

                const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

                return (
                  <path
                    key={entity.id}
                    d={pathData}
                    {...previewProps}
                  />
                );
              } else if (entity.type === 'polyline') {
                const points = entity.points.map((pt) => worldToScreen(pt));
                const pathData =
                  points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ') +
                  (entity.closed ? ' Z' : '');
                return (
                  <path
                    key={entity.id}
                    d={pathData}
                    {...previewProps}
                  />
                );
              }
              return null;
            });
          })()}

          {/* Rectangular Array 來源選取外框高亮 */}
          {currentTool === 'RECT_ARRAY' && rectArraySourceIds.length > 0 && (() => {
            const highlightColor = '#60a5fa'; // blue-400
            return currentEntities
              .filter((e) => rectArraySourceIds.includes(e.id))
              .map((entity) => {
                const commonProps = {
                  stroke: highlightColor,
                  strokeWidth: 4,
                  fill: 'none',
                  opacity: 0.75,
                };

                if (entity.type === 'line') {
                  const start = worldToScreen(entity.start);
                  const end = worldToScreen(entity.end);
                  return (
                    <line
                      key={`rect-array-source-${entity.id}`}
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'circle') {
                  const center = worldToScreen(entity.center);
                  return (
                    <circle
                      key={`rect-array-source-${entity.id}`}
                      cx={center.x}
                      cy={center.y}
                      r={entity.radius * scale}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'arc') {
                  const worldStart = {
                    x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
                    y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
                  };
                  const worldEnd = {
                    x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
                    y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
                  };

                  const start = worldToScreen(worldStart);
                  const end = worldToScreen(worldEnd);
                  const screenRadius = entity.radius * scale;

                  let diff = entity.endAngle - entity.startAngle;
                  while (diff < 0) diff += 2 * Math.PI;
                  while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

                  const largeArcFlag = diff > Math.PI ? 1 : 0;
                  const sweepFlag = 0;

                  const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

                  return (
                    <path
                      key={`rect-array-source-${entity.id}`}
                      d={pathData}
                      {...commonProps}
                    />
                  );
                } else if (entity.type === 'polyline') {
                  const points = entity.points.map((pt) => worldToScreen(pt));
                  const pathData =
                    points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ') +
                    (entity.closed ? ' Z' : '');
                  return (
                    <path
                      key={`rect-array-source-${entity.id}`}
                      d={pathData}
                      {...commonProps}
                    />
                  );
                }
                return null;
              });
          })()}

          {/* Rectangular Array 即時動態分身預覽 */}
          {currentTool === 'RECT_ARRAY' && rectArrayPreviewEntities && rectArrayPreviewEntities.length > 0 && (() => {
            const previewProps = {
              stroke: '#60a5fa', // blue-400
              strokeWidth: 2,
              strokeDasharray: '6,4',
              fill: 'none',
              opacity: 0.85,
            };

            return rectArrayPreviewEntities.map((entity) => {
              if (entity.type === 'line') {
                const start = worldToScreen(entity.start);
                const end = worldToScreen(entity.end);
                return (
                  <line
                    key={entity.id}
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    {...previewProps}
                  />
                );
              } else if (entity.type === 'circle') {
                const center = worldToScreen(entity.center);
                return (
                  <circle
                    key={entity.id}
                    cx={center.x}
                    cy={center.y}
                    r={entity.radius * scale}
                    {...previewProps}
                  />
                );
              } else if (entity.type === 'arc') {
                const worldStart = {
                  x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
                  y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
                };
                const worldEnd = {
                  x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
                  y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
                };

                const start = worldToScreen(worldStart);
                const end = worldToScreen(worldEnd);
                const screenRadius = entity.radius * scale;

                let diff = entity.endAngle - entity.startAngle;
                while (diff < 0) diff += 2 * Math.PI;
                while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

                const largeArcFlag = diff > Math.PI ? 1 : 0;
                const sweepFlag = 0;

                const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

                return (
                  <path
                    key={entity.id}
                    d={pathData}
                    {...previewProps}
                  />
                );
              } else if (entity.type === 'polyline') {
                const points = entity.points.map((pt) => worldToScreen(pt));
                const pathData =
                  points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ') +
                  (entity.closed ? ' Z' : '');
                return (
                  <path
                    key={entity.id}
                    d={pathData}
                    {...previewProps}
                  />
                );
              }
              return null;
            });
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

          {/* Polar Tracking Ray Line */}
          {polarTracking && (() => {
            const start = worldToScreen(polarTracking.rayStart);
            const end = worldToScreen(polarTracking.rayEnd);
            return (
              <line
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                stroke="#f97316"
                strokeDasharray="4,4"
                strokeWidth={1}
                className="pointer-events-none"
              />
            );
          })()}

          {/* Polar Extension Line (Green/Yellow dashed line connecting segment endpoint to intersection) */}
          {polarExtensionIntersection && (() => {
            const start = worldToScreen(polarExtensionIntersection.extensionRay.start);
            const end = worldToScreen(polarExtensionIntersection.extensionRay.end);
            return (
              <line
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                stroke="#22c55e" // elegant green-500 line
                strokeDasharray="5,4"
                strokeWidth={1.5}
                className="pointer-events-none"
              />
            );
          })()}

          {/* Object Tracking (OTrack) Guide Lines */}
          {otrackGuideLines.map((gl, idx) => {
            const start = worldToScreen(gl.anchor);
            const end = worldToScreen(gl.targetPoint);
            return (
              <line
                key={`otrack-gl-${idx}`}
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                stroke="#facc15"
                strokeDasharray="4,4"
                strokeWidth={1.2}
                className="pointer-events-none"
              />
            );
          })}

          {/* Object Tracking (OTrack) Anchors */}
          {otrackAnchors.map((anchor) => {
            const screenPt = worldToScreen(anchor.point);
            return (
              <g key={`otrack-anchor-${anchor.id}`} transform={`translate(${screenPt.x}, ${screenPt.y})`}>
                <circle cx="0" cy="0" r="6" fill="#ca8a04" fillOpacity="0.2" />
                <path d="M -5 0 L 5 0 M 0 -5 L 0 5" stroke="#eab308" strokeWidth="1.5" />
              </g>
            );
          })}
        </svg>
      )}

      {/* AutoCAD style Direct Distance Entry (HUD Distance Input) */}
      {((currentTool === 'LINE' || (currentTool === 'POLYLINE' && polylineMode === 'LINE') || currentTool === 'MOVE' || currentTool === 'COPY') &&
        drawSession.isDrawing &&
        drawSession.startPoint) && (() => {
          const midPointWorld = {
            x: (drawSession.startPoint.x + drawSession.currentCursor.x) / 2,
            y: (drawSession.startPoint.y + drawSession.currentCursor.y) / 2,
          };
          const midPointScreen = worldToScreen(midPointWorld);
          const liveDistance = Math.hypot(
            drawSession.currentCursor.x - drawSession.startPoint.x,
            drawSession.currentCursor.y - drawSession.startPoint.y
          );
          const displayValue = isHudFocused ? hudInputLength : liveDistance.toFixed(1);

          return (
            <div
              style={{
                position: 'absolute',
                left: `${midPointScreen.x}px`,
                top: `${midPointScreen.y}px`,
                transform: 'translate(-50%, -140%)',
              }}
              className="z-50 px-3 py-1 bg-neutral-950/90 border border-emerald-500/80 focus-within:border-amber-500/95 text-emerald-400 font-mono text-xs rounded-full shadow-2xl flex items-center gap-1.5"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                ref={hudRef}
                type="text"
                className="w-16 text-center text-emerald-400 focus:text-amber-400 bg-transparent border-none focus:outline-none focus:ring-0 font-bold font-mono p-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                value={displayValue}
                onChange={(e) => {
                  setHudInputLength(e.target.value);
                  setIsHudFocused(true);
                }}
                onFocus={() => {
                  setIsHudFocused(true);
                  if (!hudInputLength) {
                    setHudInputLength(liveDistance.toFixed(1));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const num = parseFloat(hudInputLength || displayValue);
                    if (!isNaN(num) && num > 0) {
                      submitExactLength(num);
                    }
                    setHudInputLength('');
                    setIsHudFocused(false);
                    hudRef.current?.blur();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    if (isHudFocused) {
                      setHudInputLength('');
                      setIsHudFocused(false);
                      hudRef.current?.blur();
                    } else {
                      cancelDrawing();
                    }
                  }
                }}
              />
              <span className="text-neutral-500 font-bold">mm</span>
            </div>
          );
        })()}

      {/* AutoCAD style Direct Distance Entry (HUD Distance Input) for CIRCLE */}
      {(currentTool === 'CIRCLE' &&
        drawSession.isDrawing &&
        drawSession.startPoint &&
        drawSession.currentCursor) && (() => {
          const center = drawSession.startPoint;
          const cursor = drawSession.currentCursor;
          const midPointWorld = {
            x: (center.x + cursor.x) / 2,
            y: (center.y + cursor.y) / 2,
          };
          const midPointScreen = worldToScreen(midPointWorld);
          const currentRadius = Math.hypot(cursor.x - center.x, cursor.y - center.y);

          // If focused: Prefix R:, Input has hudInputLength, MM suffix
          // If NOT focused: input shows `R: ${currentRadius.toFixed(1)} mm` or similar
          const displayValue = isHudFocused 
            ? hudInputLength 
            : `R: ${currentRadius.toFixed(1)} mm`;

          return (
            <div
              style={{
                position: 'absolute',
                left: `${midPointScreen.x}px`,
                top: `${midPointScreen.y}px`,
                transform: 'translate(-50%, -140%)',
              }}
              className="z-50 px-3 py-1 bg-neutral-950/90 border border-emerald-500/80 focus-within:border-amber-500/95 text-emerald-400 font-mono text-xs rounded-full shadow-2xl flex items-center gap-1"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {isHudFocused && (
                <span className="text-amber-400 font-bold mr-0.5 select-none font-mono">R:</span>
              )}
              <input
                ref={hudRef}
                type="text"
                className={`${isHudFocused ? 'w-16 text-center' : 'w-28 text-center'} text-emerald-400 focus:text-amber-400 bg-transparent border-none focus:outline-none focus:ring-0 font-bold font-mono p-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                value={displayValue}
                onChange={(e) => {
                  setHudInputLength(e.target.value);
                  setIsHudFocused(true);
                }}
                onFocus={() => {
                  setIsHudFocused(true);
                  if (!hudInputLength) {
                    setHudInputLength(currentRadius.toFixed(1));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const typedVal = hudInputLength || currentRadius.toFixed(1);
                    const num = parseFloat(typedVal);
                    if (!isNaN(num) && num > 0) {
                      submitExactLength(num);
                    }
                    setHudInputLength('');
                    setIsHudFocused(false);
                    hudRef.current?.blur();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    if (hudInputLength) {
                      setHudInputLength('');
                      setIsHudFocused(false);
                      hudRef.current?.blur();
                    } else {
                      cancelDrawing();
                    }
                  }
                }}
              />
              {isHudFocused && (
                <span className="text-neutral-500 font-bold ml-0.5 select-none">mm</span>
              )}
            </div>
          );
        })()}

      {/* AutoCAD style Direct Scale Factor Entry (HUD Scale Factor Input) for SCALE */}
      {(currentTool === 'SCALE' &&
        drawSession.isDrawing &&
        drawSession.startPoint &&
        drawSession.currentCursor) && (() => {
          const base = drawSession.startPoint;
          const cursor = drawSession.currentCursor;
          const midPointWorld = {
            x: (base.x + cursor.x) / 2,
            y: (base.y + cursor.y) / 2,
          };
          const midPointScreen = worldToScreen(midPointWorld);
          const liveFactor = currentScaleFactor ?? 1.0;

          const displayValue = isHudFocused
            ? hudInputLength
            : `Scale: ${liveFactor.toFixed(2)}x`;

          return (
            <div
              style={{
                position: 'absolute',
                left: `${midPointScreen.x}px`,
                top: `${midPointScreen.y}px`,
                transform: 'translate(-50%, -140%)',
              }}
              className="z-50 px-3 py-1 bg-neutral-950/90 border border-sky-500/80 focus-within:border-amber-500/95 text-sky-400 font-mono text-xs rounded-full shadow-2xl flex items-center gap-1"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {isHudFocused && (
                <span className="text-amber-400 font-bold mr-0.5 select-none font-mono">Scale:</span>
              )}
              <input
                ref={hudRef}
                type="text"
                className={`${isHudFocused ? 'w-16 text-center' : 'w-28 text-center'} text-sky-400 focus:text-amber-400 bg-transparent border-none focus:outline-none focus:ring-0 font-bold font-mono p-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                value={displayValue}
                onChange={(e) => {
                  setHudInputLength(e.target.value);
                  setIsHudFocused(true);
                }}
                onFocus={() => {
                  setIsHudFocused(true);
                  if (!hudInputLength) {
                    setHudInputLength(liveFactor.toFixed(2));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const typedVal = hudInputLength || liveFactor.toFixed(2);
                    const num = parseFloat(typedVal);
                    if (!isNaN(num) && num > 0) {
                      submitScaleFactor(num);
                    }
                    setHudInputLength('');
                    setIsHudFocused(false);
                    hudRef.current?.blur();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    if (hudInputLength) {
                      setHudInputLength('');
                      setIsHudFocused(false);
                      hudRef.current?.blur();
                    } else {
                      cancelDrawing();
                    }
                  }
                }}
              />
              {isHudFocused && (
                <span className="text-neutral-500 font-bold ml-0.5 select-none">x</span>
              )}
            </div>
          );
        })()}

      {/* AutoCAD style Direct Angle Entry (HUD Rotation Angle Input) for ROTATE */}
      {(currentTool === 'ROTATE' &&
        drawSession.isDrawing &&
        drawSession.startPoint &&
        drawSession.currentCursor) && (() => {
          const base = drawSession.startPoint;
          const cursor = drawSession.currentCursor;
          const midPointWorld = {
            x: (base.x + cursor.x) / 2,
            y: (base.y + cursor.y) / 2,
          };
          const midPointScreen = worldToScreen(midPointWorld);
          const liveAngle = currentRotateAngleDeg ?? 0;

          const displayValue = isHudFocused
            ? hudInputLength
            : `Angle: ${liveAngle.toFixed(1)}°`;

          return (
            <div
              style={{
                position: 'absolute',
                left: `${midPointScreen.x}px`,
                top: `${midPointScreen.y}px`,
                transform: 'translate(-50%, -140%)',
              }}
              className="z-50 px-3 py-1 bg-neutral-950/90 border border-sky-500/80 focus-within:border-amber-500/95 text-sky-400 font-mono text-xs rounded-full shadow-2xl flex items-center gap-1"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {isHudFocused && (
                <span className="text-amber-400 font-bold mr-0.5 select-none font-mono">Angle:</span>
              )}
              <input
                ref={hudRef}
                type="text"
                className={`${isHudFocused ? 'w-16 text-center' : 'w-28 text-center'} text-sky-400 focus:text-amber-400 bg-transparent border-none focus:outline-none focus:ring-0 font-bold font-mono p-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                value={displayValue}
                onChange={(e) => {
                  setHudInputLength(e.target.value);
                  setIsHudFocused(true);
                }}
                onFocus={() => {
                  setIsHudFocused(true);
                  if (!hudInputLength) {
                    setHudInputLength(liveAngle.toFixed(1));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const typedVal = hudInputLength || liveAngle.toFixed(1);
                    const num = parseFloat(typedVal);
                    if (!isNaN(num)) {
                      submitRotateAngle(num);
                    }
                    setHudInputLength('');
                    setIsHudFocused(false);
                    hudRef.current?.blur();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    if (hudInputLength) {
                      setHudInputLength('');
                      setIsHudFocused(false);
                      hudRef.current?.blur();
                    } else {
                      cancelDrawing();
                    }
                  }
                }}
              />
              {isHudFocused && (
                <span className="text-neutral-500 font-bold ml-0.5 select-none">°</span>
              )}
            </div>
          );
        })()}

      {/* Polar Tracking Tooltip Capsule */}
      {polarTracking && drawSession.isDrawing && (() => {
        const cursorScreen = worldToScreen(drawSession.currentCursor);
        const dx = polarTracking.snappedPoint.x - polarTracking.rayStart.x;
        const dy = polarTracking.snappedPoint.y - polarTracking.rayStart.y;
        const dist = Math.hypot(dx, dy);
        const unit = document.units || 'mm';
        
        return (
          <div
            style={{
              position: 'absolute',
              left: cursorScreen.x + 15,
              top: cursorScreen.y + 15,
              pointerEvents: 'none',
            }}
            className="z-50 px-2.5 py-1 bg-neutral-900/90 border border-[#f97316] text-[#f97316] font-mono text-[10px] rounded-full shadow-lg flex items-center gap-1 select-none whitespace-nowrap"
          >
            <span className="font-bold">Polar:</span>
            <span>{polarTracking.angleDeg.toFixed(1)}°</span>
            <span className="opacity-60">&lt;</span>
            <span className="font-bold">{dist.toFixed(1)}{unit}</span>
          </div>
        );
      })()}

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

      {/* Chamfer 距離即時微調膠囊框 */}
      {currentTool === 'CHAMFER' && (
        <div className="absolute top-4 right-4 z-40 px-4 py-2 bg-neutral-900/90 border border-neutral-700 text-neutral-200 font-mono text-xs rounded-full shadow-2xl flex items-center gap-2 select-none">
          <span className="text-neutral-400 font-bold tracking-wider">Distance:</span>
          <div className="flex items-center bg-neutral-950 border border-neutral-700 hover:border-purple-500 focus-within:border-purple-500 rounded px-1.5 py-0.5 transition-colors">
            <input
              type="number"
              min="0.1"
              step="0.5"
              className="w-14 text-center text-purple-400 bg-transparent border-none focus:outline-none focus:ring-0 font-bold font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none p-0"
              value={chamferDistance === 0 ? '' : chamferDistance}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) {
                  setChamferDistance(val);
                  setChamferError(null);
                } else {
                  setChamferDistance(0);
                }
              }}
              onBlur={() => {
                if (chamferDistance <= 0) {
                  setChamferDistance(10);
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

      {/* Offset 距離即時微調膠囊框 */}
      {currentTool === 'OFFSET' && (
        <div className="absolute top-4 right-4 z-40 px-4 py-2 bg-neutral-900/90 border border-neutral-700 text-neutral-200 font-mono text-xs rounded-full shadow-2xl flex items-center gap-2 select-none">
          <span className="text-neutral-400 font-bold tracking-wider">Offset:</span>
          <div className="flex items-center bg-neutral-950 border border-neutral-700 hover:border-sky-500 focus-within:border-sky-500 rounded px-1.5 py-0.5 transition-colors">
            <input
              type="number"
              min="0.1"
              step="0.5"
              className="w-14 text-center text-sky-400 bg-transparent border-none focus:outline-none focus:ring-0 font-bold font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none p-0"
              value={offsetDistance === 0 ? '' : offsetDistance}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) {
                  setOffsetDistance(val);
                } else {
                  setOffsetDistance(0);
                }
              }}
              onBlur={() => {
                if (offsetDistance <= 0) {
                  setOffsetDistance(10);
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

      {/* Mirror 步驟切換與說明膠囊框 */}
      {currentTool === 'MIRROR' && (
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-40 px-4 py-2 bg-neutral-900/90 border border-neutral-700 text-neutral-200 font-mono text-xs rounded-full shadow-2xl flex items-center gap-3 select-none">
          <span className="text-neutral-400 font-bold tracking-wider">Mirror:</span>
          <div className="flex bg-neutral-950 rounded-full p-0.5 border border-neutral-800">
            <button
              onClick={() => setMirrorStep('PICK_SOURCE')}
              className={`px-3 py-1 rounded-full text-xs font-bold transition-colors ${
                mirrorStep === 'PICK_SOURCE'
                  ? 'bg-purple-500 text-neutral-950 shadow-sm'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              1. Select Source ({mirrorSourceIds.length})
            </button>
            <button
              onClick={() => {
                if (mirrorSourceIds.length > 0) {
                  setMirrorStep('PICK_AXIS');
                }
              }}
              disabled={mirrorSourceIds.length === 0}
              className={`px-3 py-1 rounded-full text-xs font-bold transition-colors ${
                mirrorStep === 'PICK_AXIS'
                  ? 'bg-purple-500 text-neutral-950 shadow-sm'
                  : 'text-neutral-400 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed'
              }`}
            >
              2. Pick Axis
            </button>
          </div>
          <span className="text-neutral-400 text-xs font-bold">
            (Enter to proceed)
          </span>
        </div>
      )}

      {/* Polyline 模式切換與說明膠囊框 */}
      {currentTool === 'POLYLINE' && drawSession.isDrawing && (
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-40 px-4 py-2 bg-neutral-900/90 border border-neutral-700 text-neutral-200 font-mono text-xs rounded-full shadow-2xl flex items-center gap-3 select-none">
          <span className="text-neutral-400 font-bold tracking-wider">Mode:</span>
          <div className="flex bg-neutral-950 rounded-full p-0.5 border border-neutral-800">
            <button
              onClick={() => polylineMode !== 'LINE' && togglePolylineMode()}
              className={`px-3 py-1 rounded-full text-xs font-bold transition-colors ${
                polylineMode === 'LINE'
                  ? 'bg-amber-500 text-neutral-950 shadow-sm'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              Line
            </button>
            <button
              onClick={() => polylineMode !== 'ARC' && togglePolylineMode()}
              className={`px-3 py-1 rounded-full text-xs font-bold transition-colors ${
                polylineMode === 'ARC'
                  ? 'bg-amber-500 text-neutral-950 shadow-sm'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              Arc
            </button>
          </div>
          <span className="text-neutral-400 text-xs font-bold">
            (Toggle: A or L)
          </span>
        </div>
      )}

      {/* Move / Copy 物件選取確認提示浮動列 */}
      {(currentTool === 'MOVE' || currentTool === 'COPY') && moveStep === 'PICK_OBJECTS' && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-neutral-900/95 border border-neutral-700 text-neutral-200 px-4 py-2 rounded-full shadow-2xl flex items-center gap-3 select-none">
          <span className="text-xs font-mono">
            {currentTool === 'MOVE' ? '移動' : '複製'}：
            {moveSourceIds.length > 0 ? (
              <span className="text-amber-400 font-bold">已選取 {moveSourceIds.length} 個圖元</span>
            ) : (
              '點選要變更的圖元'
            )}
          </span>
          {moveSourceIds.length > 0 && (
            <button
              onClick={() => setMoveStep('PICK_BASE')}
              className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-neutral-950 text-xs font-bold rounded-full transition-colors shadow-sm"
            >
              下一步：指定基準點 (Enter)
            </button>
          )}
        </div>
      )}

      {/* Scale 物件選取確認提示浮動列 */}
      {currentTool === 'SCALE' && scaleStep === 'PICK_OBJECTS' && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-neutral-900/95 border border-sky-700 text-neutral-200 px-4 py-2 rounded-full shadow-2xl flex items-center gap-3 select-none">
          <span className="text-xs font-mono">
            縮放：
            {scaleSourceIds.length > 0 ? (
              <span className="text-sky-400 font-bold">已選取 {scaleSourceIds.length} 個圖元</span>
            ) : (
              '點選要縮放的圖元'
            )}
          </span>
          {scaleSourceIds.length > 0 && (
            <button
              onClick={() => setScaleStep('PICK_BASE')}
              className="px-3 py-1 bg-sky-500 hover:bg-sky-400 text-neutral-950 text-xs font-bold rounded-full transition-colors shadow-sm"
            >
              下一步：指定基準點 (Enter)
            </button>
          )}
        </div>
      )}

      {/* Rotate 物件選取確認提示浮動列 */}
      {currentTool === 'ROTATE' && rotateStep === 'PICK_OBJECTS' && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-neutral-900/95 border border-sky-700 text-neutral-200 px-4 py-2 rounded-full shadow-2xl flex items-center gap-3 select-none">
          <span className="text-xs font-mono">
            旋轉：
            {rotateSourceIds.length > 0 ? (
              <span className="text-sky-400 font-bold">已選取 {rotateSourceIds.length} 個圖元</span>
            ) : (
              '點選要旋轉的圖元'
            )}
          </span>
          {rotateSourceIds.length > 0 && (
            <button
              onClick={() => setRotateStep('PICK_BASE')}
              className="px-3 py-1 bg-sky-500 hover:bg-sky-400 text-neutral-950 text-xs font-bold rounded-full transition-colors shadow-sm"
            >
              下一步：指定基準點 (Enter)
            </button>
          )}
        </div>
      )}

      {/* Circular Array 物件選取確認提示浮動列 */}
      {currentTool === 'CIRCULAR_ARRAY' && arrayStep === 'PICK_OBJECTS' && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-neutral-900/95 border border-purple-700 text-neutral-200 px-4 py-2 rounded-full shadow-2xl flex items-center gap-3 select-none">
          <span className="text-xs font-mono">
            環形陣列：
            {arraySourceIds.length > 0 ? (
              <span className="text-purple-400 font-bold">已選取 {arraySourceIds.length} 個圖元</span>
            ) : (
              '點選要陣列的圖元'
            )}
          </span>
          {arraySourceIds.length > 0 && (
            <button
              onClick={() => setArrayStep('PICK_CENTER')}
              className="px-3 py-1 bg-purple-500 hover:bg-purple-400 text-neutral-950 text-xs font-bold rounded-full transition-colors shadow-sm"
            >
              下一步：指定中心點 (Enter)
            </button>
          )}
        </div>
      )}

      {/* Circular Array 陣列參數設定面板 */}
      {currentTool === 'CIRCULAR_ARRAY' && (
        <CircularArrayPanel
          arrayStep={arrayStep}
          selectedCount={arraySourceIds.length}
          onProceedToCenter={() => setArrayStep('PICK_CENTER')}
        />
      )}

      {/* Rectangular Array 陣列參數設定面板 */}
      {currentTool === 'RECT_ARRAY' && (
        <RectangularArrayPanel
          selectedCount={rectArraySourceIds.length}
          onConfirm={executeRectArray}
        />
      )}

      {/* AutoCAD 風格的黑色半透明狀態列 */}
      <div className="absolute bottom-0 right-0 m-4 px-4 py-2 bg-black bg-opacity-70 text-green-400 font-mono text-sm rounded pointer-events-none select-none flex gap-6 items-center">
        <div className={(filletError || chamferError || offsetRadiusError || polylineWarning) ? "text-red-400 font-bold animate-pulse" : ""}>
          {filletError
            ? filletError
            : chamferError
            ? chamferError
            : offsetRadiusError
            ? offsetRadiusError
            : polylineWarning
            ? polylineWarning
            : currentTool === 'TRIM'
            ? 'Trim: Click intersecting edge to cut'
            : currentTool === 'EXTEND'
            ? 'Extend: Click edge near endpoint to extend to boundary'
            : currentTool === 'DIMENSION'
            ? 'Dimension: Click entity/points, then click to place dimension'
            : currentTool === 'FILLET'
            ? (filletFirstEntityId
                ? 'Fillet: Pick second line or arc'
                : `Fillet: Pick first line or arc (R=${filletRadius}mm)`)
            : currentTool === 'CHAMFER'
            ? (chamferFirstEntityId
                ? 'Chamfer: Pick second line'
                : `Chamfer: Pick first line (Dist=${chamferDistance}mm)`)
            : currentTool === 'OFFSET'
            ? (offsetTargetId
                ? 'Offset: Click on side to offset'
                : `Offset: Pick line, arc, or circle (Dist=${offsetDistance}mm)`)
            : currentTool === 'MIRROR'
            ? (mirrorStep === 'PICK_SOURCE'
                ? 'Mirror: Select objects to mirror, then press Enter or switch step'
                : 'Mirror: Pick mirror line/axis (Construction or Line)')
            : currentTool === 'MOVE'
            ? (moveStep === 'PICK_OBJECTS'
                ? (moveSourceIds.length > 0 ? `Move: ${moveSourceIds.length} selected, press Enter to specify base point` : 'Move: Select objects to move, then press Enter')
                : moveStep === 'PICK_BASE'
                ? 'Move: Specify base point'
                : 'Move: Specify target point or type distance in HUD')
            : currentTool === 'COPY'
            ? (moveStep === 'PICK_OBJECTS'
                ? (moveSourceIds.length > 0 ? `Copy: ${moveSourceIds.length} selected, press Enter to specify base point` : 'Copy: Select objects to copy, then press Enter')
                : moveStep === 'PICK_BASE'
                ? 'Copy: Specify base point'
                : 'Copy: Specify target point or type distance in HUD')
            : currentTool === 'SCALE'
            ? (scaleStep === 'PICK_OBJECTS'
                ? (scaleSourceIds.length > 0 ? `Scale: ${scaleSourceIds.length} selected, press Enter to specify base point` : 'Scale: Select objects to scale, then press Enter')
                : scaleStep === 'PICK_BASE'
                ? 'Scale: Specify base point'
                : 'Scale: Drag cursor to adjust factor or type scale factor in HUD (e.g. 1.5)')
            : currentTool === 'ROTATE'
            ? (rotateStep === 'PICK_OBJECTS'
                ? (rotateSourceIds.length > 0 ? `Rotate: ${rotateSourceIds.length} selected, press Enter to specify base point` : 'Rotate: Select objects to rotate, then press Enter')
                : rotateStep === 'PICK_BASE'
                ? 'Rotate: Specify base point'
                : 'Rotate: Drag cursor to adjust angle or type angle in HUD (e.g. 45 or -30)')
            : currentTool === 'CIRCULAR_ARRAY'
            ? (arrayStep === 'PICK_OBJECTS'
                ? (arraySourceIds.length > 0 ? `Circular Array: ${arraySourceIds.length} selected, press Enter to specify center point` : 'Circular Array: Select objects to array, then press Enter')
                : `Circular Array: Click center point to generate array (Items=${arrayItems}, Angle=${arrayFillAngle}°)`)
            : currentTool === 'RECT_ARRAY'
            ? (rectArraySourceIds.length > 0
                ? `Rectangular Array: ${rectArraySourceIds.length} selected, adjust parameters in panel and press Enter or Confirm`
                : 'Rectangular Array: Select objects to array, then adjust settings in panel')
            : currentTool === 'POLYLINE' && drawSession.isDrawing
            ? 'Polyline: Pick next point [A for Arc, L for Line, ESC to exit, Click start to close]'
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
        <div className={orthoEnabled ? 'text-yellow-400 font-bold' : 'text-neutral-500 font-bold'}>
          {orthoEnabled ? 'ORTHO: ON' : 'ORTHO: OFF'}
        </div>
        <div
          onClick={() => setPolarModalOpen(true)}
          className={`pointer-events-auto cursor-pointer hover:underline select-none transition-all ${
            polarTrackingEnabled ? 'text-amber-400 font-bold' : 'text-neutral-500 font-bold'
          }`}
          title="Click to open Polar Settings"
        >
          POLAR: {polarTrackingEnabled ? `${polarAngleStep}°` : 'OFF'}
        </div>
        <div className="text-amber-500 font-bold">
          OTRACK: ACTIVE
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
          <span className="text-xs text-neutral-400 font-mono pr-1">
            {editingDimension.dimension.type === 'angular' ? '°' : 'mm'}
          </span>
        </div>
      )}
    </div>
  );
};
