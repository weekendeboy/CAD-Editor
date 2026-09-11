import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Point2D, BoundingBox2D } from '../types/cad';
import { ViewportTransform } from '../core/2d/ViewportTransform';

export interface UseViewportOptions {
  initialPan?: Point2D;
  initialScale?: number;
}

export interface CadZoomToBboxEventDetail {
  bbox: BoundingBox2D;
  padding?: number;
}

export function useViewport({
  initialPan = { x: 0, y: 0 },
  initialScale = 1.0,
}: UseViewportOptions = {}) {
  const [pan, setPan] = useState<Point2D>(initialPan);
  const [scale, setScale] = useState<number>(initialScale);

  // 使用 ref 來儲存拖曳狀態，避免不必要的重新渲染
  const dragState = useRef({
    isDragging: false,
    startPointer: { x: 0, y: 0 },
    startPan: { x: 0, y: 0 },
  });

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
      viewWidth: number,
      viewHeight: number,
      padding: number = 0
    ) => {
      const { pan: newPan, scale: newScale } = ViewportTransform.getZoomExtents(
        bbox,
        viewWidth,
        viewHeight,
        padding
      );
      const clampedScale = Math.max(0.001, Math.min(1000, newScale));
      setPan(newPan);
      setScale(clampedScale);
    },
    []
  );

  // 全域視圖自適應聚焦（Zoom to Extents）事件監聽
  useEffect(() => {
    const handleZoomToBbox = (e: Event) => {
      const customEvent = e as CustomEvent<CadZoomToBboxEventDetail>;
      if (customEvent.detail?.bbox) {
        const { bbox, padding } = customEvent.detail;
        const viewWidth = window.innerWidth;
        const viewHeight = Math.max(1, window.innerHeight - 56);
        const effectivePadding = padding ?? 80;

        const { pan: newPan, scale: newScale } = ViewportTransform.getZoomExtents(
          bbox,
          viewWidth,
          viewHeight,
          effectivePadding
        );

        // 安全防護：限制縮放比例介於 0.001 與 1000 之間
        const clampedScale = Math.max(0.001, Math.min(1000, newScale));

        setPan(newPan);
        setScale(clampedScale);
      }
    };

    window.addEventListener('cad-zoom-to-bbox', handleZoomToBbox);
    return () => {
      window.removeEventListener('cad-zoom-to-bbox', handleZoomToBbox);
    };
  }, []);

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
    },
  };
}
