import React, { useState, useCallback, useRef, useEffect } from 'react';

export interface UseDraggableModalOptions {
  defaultX?: number;
  defaultY?: number;
}

export interface DragHandleProps {
  onMouseDown: (e: React.MouseEvent) => void;
}

export function useDraggableModal(options: UseDraggableModalOptions = {}) {
  const { defaultX = 280, defaultY = 70 } = options;

  const [position, setPosition] = useState<{ x: number; y: number }>({
    x: defaultX,
    y: defaultY,
  });

  const isDraggingRef = useRef(false);
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const positionRef = useRef(position);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  const resetPosition = useCallback(() => {
    setPosition({ x: defaultX, y: defaultY });
  }, [defaultX, defaultY]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // 若點擊目標為按鈕、輸入框、選單等互動元件，不啟動拖曳
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a, [role="button"]')) {
      return;
    }

    isDraggingRef.current = true;
    dragOffsetRef.current = {
      x: e.clientX - positionRef.current.x,
      y: e.clientY - positionRef.current.y,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;

      let newX = moveEvent.clientX - dragOffsetRef.current.x;
      let newY = moveEvent.clientY - dragOffsetRef.current.y;

      // 邊界防呆 Clamp：避免面板拖出螢幕可視範圍
      const maxX = Math.max(0, window.innerWidth - 100);
      const maxY = Math.max(0, window.innerHeight - 50);

      newX = Math.max(0, Math.min(maxX, newX));
      newY = Math.max(0, Math.min(maxY, newY));

      setPosition({ x: newX, y: newY });
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, []);

  const dragHandleProps: DragHandleProps = {
    onMouseDown,
  };

  return {
    position,
    setPosition,
    resetPosition,
    dragHandleProps,
  };
}

export default useDraggableModal;
