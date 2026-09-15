import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Point2D, BoundingBox2D } from '../types/cad';
import { ViewportTransform } from '../core/2d/ViewportTransform';

export interface UseViewportOptions {
  initialPan?: Point2D;
  initialScale?: number;
  onMiddleDoubleClick?: () => void;
}

export interface CadZoomToBboxEventDetail {
  bbox: BoundingBox2D;
  padding?: number;
}

export function useViewport({
  initialPan = { x: 0, y: 0 },
  initialScale = 1.0,
  onMiddleDoubleClick,
}: UseViewportOptions = {}) {
  const [pan, setPan] = useState<Point2D>(initialPan);
  const [scale, setScale] = useState<number>(initialScale);

  const panRef = useRef<Point2D>(pan);
  const scaleRef = useRef<number>(scale);
  const animFrameRef = useRef<number | null>(null);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  useEffect(() => {
    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, []);

  // 使用 ref 來儲存拖曳狀態，避免不必要的重新渲染
  const dragState = useRef({
    isDragging: false,
    startPointer: { x: 0, y: 0 },
    startPan: { x: 0, y: 0 },
  });

  // 記錄前一次滑鼠中鍵點擊時間與座標，用於偵測「滑鼠中鍵雙擊 (Middle Double Click)」
  const lastMiddleClickRef = useRef<{ time: number; x: number; y: number }>({
    time: 0,
    x: 0,
    y: 0,
  });

  const onMiddleDoubleClickRef = useRef(onMiddleDoubleClick);
  useEffect(() => {
    onMiddleDoubleClickRef.current = onMiddleDoubleClick;
  }, [onMiddleDoubleClick]);

  const handleWheel = useCallback(
    (e: React.WheelEvent<Element>) => {
      // 阻止預設滾動行為（需要確保該元素可接收 wheel 事件）
      e.preventDefault();

      // 設定縮放倍率，這裡設定每次捲動為 10% 的縮放
      const zoomFactor = 1.1;
      const newScale = e.deltaY > 0 ? scale / zoomFactor : scale * zoomFactor;

      // 限制縮放範圍在 0.05 至 100 之間
      const clampedScale = Math.max(0.05, Math.min(100, newScale));

      // 計算游標在容器內的相對位置
      const rect = e.currentTarget.getBoundingClientRect();
      const mousePos = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };

      // 計算新的平移量以確保以游標為中心縮放
      const newPan = ViewportTransform.calculateZoomPan(
        mousePos,
        pan,
        scale,
        clampedScale
      );

      setScale(clampedScale);
      setPan(newPan);
    },
    [pan, scale]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<Element>) => {
      // 按下滑鼠中鍵 (button 為 1)
      if (e.button === 1) {
        e.preventDefault();

        // 偵測滑鼠中鍵雙擊 (Middle Button Double Click)
        const now = performance.now();
        const dt = now - lastMiddleClickRef.current.time;
        const dist = Math.hypot(
          e.clientX - lastMiddleClickRef.current.x,
          e.clientY - lastMiddleClickRef.current.y
        );

        if (dt < 400 && dist < 30) {
          // 判定為中鍵連點兩下
          lastMiddleClickRef.current = { time: 0, x: 0, y: 0 };
          dragState.current.isDragging = false;
          if (onMiddleDoubleClickRef.current) {
            onMiddleDoubleClickRef.current();
          } else {
            window.dispatchEvent(new CustomEvent('cad-zoom-to-fit'));
          }
          return;
        }

        lastMiddleClickRef.current = { time: now, x: e.clientX, y: e.clientY };

        dragState.current = {
          isDragging: true,
          startPointer: { x: e.clientX, y: e.clientY },
          startPan: { ...pan },
        };
        // 捕獲指標，防止滑鼠移出畫布時平移中斷
        e.currentTarget.setPointerCapture(e.pointerId);
      }
    },
    [pan]
  );

  const handleAuxClick = useCallback((e: React.MouseEvent<Element>) => {
    // 阻止中鍵點擊觸發瀏覽器原生滾動圖示 (Windows / Linux 自動捲動圖示)
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<Element>) => {
    if (dragState.current.isDragging) {
      const dx = e.clientX - dragState.current.startPointer.x;
      const dy = e.clientY - dragState.current.startPointer.y;

      setPan({
        x: dragState.current.startPan.x + dx,
        y: dragState.current.startPan.y + dy,
      });
    }
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<Element>) => {
    if (dragState.current.isDragging) {
      dragState.current.isDragging = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const handlePointerCancel = useCallback((e: React.PointerEvent<Element>) => {
    if (dragState.current.isDragging) {
      dragState.current.isDragging = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const worldToScreen = useCallback(
    (worldPt: Point2D) => {
      const transform = new ViewportTransform(pan, scale);
      return transform.worldToScreen(worldPt);
    },
    [pan, scale]
  );

  const screenToWorld = useCallback(
    (screenPt: Point2D) => {
      const transform = new ViewportTransform(pan, scale);
      return transform.screenToWorld(screenPt);
    },
    [pan, scale]
  );

  const zoomExtents = useCallback(
    (
      bbox: BoundingBox2D,
      arg2?: number,
      arg3?: number,
      arg4?: number,
      animate: boolean = true
    ) => {
      let viewWidth = typeof window !== 'undefined' ? window.innerWidth : 1000;
      let viewHeight = typeof window !== 'undefined' ? Math.max(1, window.innerHeight - 56) : 800;
      let padding = 80;

      if (typeof arg2 === 'number' && typeof arg3 === 'number') {
        viewWidth = arg2;
        viewHeight = arg3;
        if (typeof arg4 === 'number') {
          padding = arg4;
        }
      } else if (typeof arg2 === 'number') {
        padding = arg2;
      }

      const { pan: targetPan, scale: targetScale } = ViewportTransform.getZoomExtents(
        bbox,
        viewWidth,
        viewHeight,
        padding
      );
      const clampedScale = Math.max(0.001, Math.min(1000, targetScale));

      if (!animate) {
        setPan(targetPan);
        setScale(clampedScale);
        return;
      }

      // 平滑緩動過渡 (Smooth Cubic Ease-out Animation)
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }

      const startPan = { ...panRef.current };
      const startScale = scaleRef.current;
      const startTime = performance.now();
      const duration = 250;

      const step = (now: number) => {
        const elapsed = now - startTime;
        const p = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - p, 3);

        setPan({
          x: startPan.x + (targetPan.x - startPan.x) * ease,
          y: startPan.y + (targetPan.y - startPan.y) * ease,
        });
        setScale(startScale + (clampedScale - startScale) * ease);

        if (p < 1) {
          animFrameRef.current = requestAnimationFrame(step);
        } else {
          setPan(targetPan);
          setScale(clampedScale);
        }
      };

      animFrameRef.current = requestAnimationFrame(step);
    },
    []
  );

  // 全域視圖自適應聚焦（Zoom to Extents）事件監聽
  useEffect(() => {
    const handleZoomToBbox = (e: Event) => {
      const customEvent = e as CustomEvent<CadZoomToBboxEventDetail>;
      if (customEvent.detail?.bbox) {
        const { bbox, padding } = customEvent.detail;
        zoomExtents(bbox, padding);
      }
    };

    window.addEventListener('cad-zoom-to-bbox', handleZoomToBbox);
    return () => {
      window.removeEventListener('cad-zoom-to-bbox', handleZoomToBbox);
    };
  }, [zoomExtents]);

  return {
    pan,
    scale,
    setPan,
    setScale,
    worldToScreen,
    screenToWorld,
    zoomExtents,
    handlers: {
      onWheel: handleWheel,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
      onAuxClick: handleAuxClick,
    },
  };
}

