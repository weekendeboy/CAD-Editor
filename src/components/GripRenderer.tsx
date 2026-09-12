import React, { useState, useMemo } from 'react';
import { CADEntity2D, Point2D } from '../types/cad';
import { EntityGrip, getEntityGrips } from '../core/2d/GripManager';

export interface GripRendererProps {
  selectedEntities: CADEntity2D[];
  activeGripId?: string | null; // 當前正在被拖曳/點擊的熱夾點 ID（Hot Grip）
  worldToScreen: (pt: Point2D) => Point2D;
  onGripPointerDown: (grip: EntityGrip, e: React.PointerEvent) => void;
  currentTool: string;
}

export const GripRenderer: React.FC<GripRendererProps> = React.memo(
  ({
    selectedEntities,
    activeGripId,
    worldToScreen,
    onGripPointerDown,
    currentTool,
  }) => {
    const [hoveredGripId, setHoveredGripId] = useState<string | null>(null);

    // 僅在 currentTool === 'SELECT' 且 selectedEntities 非空時計算夾點
    const grips = useMemo(() => {
      if (currentTool !== 'SELECT' || !selectedEntities || selectedEntities.length === 0) {
        return [];
      }

      const allGrips = selectedEntities.flatMap((entity) => getEntityGrips(entity));

      // 座標容差微小去重 ( world 距離 < 1e-4 )
      const uniqueGrips: EntityGrip[] = [];
      for (const grip of allGrips) {
        const existingIndex = uniqueGrips.findIndex(
          (existing) =>
            Math.hypot(existing.point.x - grip.point.x, existing.point.y - grip.point.y) < 1e-4
        );

        if (existingIndex === -1) {
          uniqueGrips.push(grip);
        } else if (grip.id === activeGripId) {
          // 若有重複點位且該夾點為熱點，優先保留熱點 ID
          uniqueGrips[existingIndex] = grip;
        }
      }

      return uniqueGrips;
    }, [selectedEntities, currentTool, activeGripId]);

    // 不符合渲染條件時回傳 null
    if (currentTool !== 'SELECT' || selectedEntities.length === 0 || grips.length === 0) {
      return null;
    }

    return (
      <g className="cad-grip-layer" style={{ pointerEvents: 'all' }}>
        {grips.map((grip) => {
          const screenPt = worldToScreen(grip.point);
          const isHot = activeGripId === grip.id;
          const isHovered = !isHot && hoveredGripId === grip.id;

          // AutoCAD 經典外觀狀態決定
          let fill = '#0284c7'; // Cold Grip: 天藍色 sky-600
          let stroke = '#ffffff'; // 純白細邊
          let strokeWidth = 1;

          if (isHot) {
            fill = '#ef4444'; // Hot Grip: 紅色熱點 red-500
            stroke = '#ffffff';
            strokeWidth = 1.5;
          } else if (isHovered) {
            fill = '#38bdf8'; // Hovered Grip: 亮藍色 sky-400
            stroke = '#facc15'; // 黃色邊框 yellow-400
            strokeWidth = 1.5;
          }

          return (
            <g
              key={grip.id}
              className="cad-grip-item"
              style={{ pointerEvents: 'all', cursor: grip.cursorStyle || 'pointer' }}
              onPointerEnter={() => setHoveredGripId(grip.id)}
              onPointerLeave={() => setHoveredGripId(null)}
              onPointerDown={(e) => {
                e.stopPropagation();
                const target = e.target as Element;
                if (target && typeof target.setPointerCapture === 'function') {
                  target.setPointerCapture(e.pointerId);
                }
                onGripPointerDown(grip, e);
              }}
            >
              {/* 隱形 Hitbox：尺寸 14x14px (x - 7, y - 7) */}
              <rect
                x={screenPt.x - 7}
                y={screenPt.y - 7}
                width={14}
                height={14}
                fill="transparent"
                stroke="none"
                style={{ pointerEvents: 'all' }}
              />
              {/* 可視方塊：尺寸 8x8px (x - 4, y - 4) */}
              <rect
                x={screenPt.x - 4}
                y={screenPt.y - 4}
                width={8}
                height={8}
                fill={fill}
                stroke={stroke}
                strokeWidth={strokeWidth}
                style={{ pointerEvents: 'all' }}
              />
            </g>
          );
        })}
      </g>
    );
  }
);

GripRenderer.displayName = 'GripRenderer';

export default GripRenderer;
