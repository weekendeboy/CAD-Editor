import React from 'react';
import { Point2D, CADEntity2D, EntityState } from '../types/cad';
import { getPolylineSvgPathData } from '../core/2d/PolylineUtils';
import { useCADStore } from '../store/cadStore';

export interface EntityRendererProps {
  entities: CADEntity2D[];
  selectedIds: string[];
  worldToScreen: (pt: Point2D) => Point2D;
  scale: number;
  solverState?: EntityState | string;
  onSelectEntity?: (id: string, e: React.MouseEvent) => void;
  currentTool: string;
}

/**
 * EntityRenderer
 * 純函數渲染元件，支援渲染 line, circle, arc, polyline 等 CAD 圖元。
 * - 採用雙重渲染（Double Render）機制：外層 <g> 包覆隱形加粗的感應區（Hitbox）與可見圖元。
 * - isConstruction 為 true 時以紫色虛線渲染。
 * - 在 selectedIds 內時以亮藍色選取高亮狀態渲染。
 */
export const EntityRenderer: React.FC<EntityRendererProps> = ({
  entities,
  selectedIds,
  worldToScreen,
  scale,
  solverState = 'UnderDefined',
  onSelectEntity,
  currentTool,
}) => {
  const document = useCADStore((state) => state.document);
  const layers = document.layers;

  const renderEntity = (entity: CADEntity2D) => {
    // 獲取圖層資料
    const layer = layers[entity.layerId || '0'];
    
    // 隱藏設定為不可見的圖元：圖元自身設定或圖層設定
    if (entity.visible === false || (layer && layer.visible === false)) return null;

    const isSelected = selectedIds.includes(entity.id);
    const entityState: EntityState = (entity.state || solverState || 'UnderDefined') as EntityState;

    // 依據規格判定圖元顏色、線寬與虛線樣式：
    let strokeColor = '#60a5fa';
    let strokeWidth = entity.lineWidth || (layer ? layer.lineWidth : 1.5) || 1.5;
    let strokeDasharray: string | undefined = undefined;

    // ByLayer 顏色判定
    const byLayerColor = entity.color || (layer ? layer.color : undefined) || '#60a5fa';
    const byLayerLineType = entity.lineType || (layer ? layer.lineType : 'CONTINUOUS');

    if (isSelected) {
      strokeColor = '#38bdf8';
      strokeWidth = 3;
      if (entity.isConstruction) {
        strokeDasharray = '6,4';
      } else if (byLayerLineType === 'DASHED' || byLayerLineType === 'HIDDEN') {
        strokeDasharray = '8,4';
      }
    } else if (entity.isConstruction) {
      strokeColor = '#c084fc';
      strokeDasharray = '6,4';
    } else if (entityState === 'OverDefined') {
      strokeColor = '#ef4444';
      strokeWidth = 2.5;
    } else if (entityState === 'FullyDefined') {
      strokeColor = '#10b981';
    } else {
      strokeColor = byLayerColor;
      if (byLayerLineType === 'DASHED' || byLayerLineType === 'HIDDEN') {
        strokeDasharray = '8,4';
      }
    }

    const isSelectMode = currentTool === 'SELECT';
    const isLocked = layer && layer.locked === true;
    
    // 若圖層被鎖定，SELECT 模式下不可被點擊選取（ pointerEvents: 'none'，且透明度降低至 0.6）
    const pointerEvents = (isSelectMode && !isLocked) ? 'all' : 'none';
    const opacity = (isSelectMode && isLocked) ? 0.6 : 1.0;

    // Hitbox 屬性（感應區加寬至 12px，負責接收滑鼠事件）
    const hitboxProps = {
      stroke: 'transparent',
      fill: 'none',
      strokeWidth: 12,
      strokeLinecap: 'round' as const,
      strokeLinejoin: 'round' as const,
      opacity: 1,
      style: {
        cursor: (isSelectMode && !isLocked) ? 'pointer' : 'crosshair',
        pointerEvents: pointerEvents as React.CSSProperties['pointerEvents'],
      },
      className: `cad-entity cad-entity-hitbox cad-entity-${entity.type}`,
      onClick: (e: React.MouseEvent) => {
        if (isSelectMode && !isLocked) {
          e.stopPropagation();
          if (onSelectEntity) {
            onSelectEntity(entity.id, e);
          }
        }
      },
    };

    // 可見圖元屬性（純視覺展示，設定 pointerEvents: 'none'）
    const commonProps = {
      stroke: strokeColor,
      strokeWidth,
      strokeDasharray,
      fill: 'none',
      opacity,
      style: {
        pointerEvents: 'none' as React.CSSProperties['pointerEvents'],
      },
      className: `cad-entity cad-entity-visible cad-entity-${entity.type} ${isSelected ? 'cad-entity-selected' : ''} ${isLocked ? 'cad-entity-locked' : ''}`,
    };

    switch (entity.type) {
      case 'line': {
        const start = worldToScreen(entity.start);
        const end = worldToScreen(entity.end);
        return (
          <g key={entity.id} id={`cad-entity-${entity.id}`} className="cad-entity-group">
            {/* 隱形感應區 (Hitbox) */}
            <line
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              {...hitboxProps}
            />
            {/* 可見細線圖形 */}
            <line
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              {...commonProps}
            />
          </g>
        );
      }

      case 'circle': {
        const center = worldToScreen(entity.center);
        const screenRadius = entity.radius * scale;
        return (
          <g key={entity.id} id={`cad-entity-${entity.id}`} className="cad-entity-group">
            {/* 隱形感應區 (Hitbox) */}
            <circle
              cx={center.x}
              cy={center.y}
              r={screenRadius}
              {...hitboxProps}
            />
            {/* 可見細線圖形 */}
            <circle
              cx={center.x}
              cy={center.y}
              r={screenRadius}
              {...commonProps}
            />
          </g>
        );
      }

      case 'arc': {
        // 計算世界座標的起終點 (CCW 逆時針方向)
        const worldStart = {
          x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
          y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
        };
        const worldEnd = {
          x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
          y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
        };

        // 轉換為螢幕座標
        const start = worldToScreen(worldStart);
        const end = worldToScreen(worldEnd);
        const screenRadius = entity.radius * scale;

        // 計算夾角以決定是否為大弧 (Large Arc Flag)
        let diff = entity.endAngle - entity.startAngle;
        while (diff < 0) diff += 2 * Math.PI;
        while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

        const largeArcFlag = diff > Math.PI ? 1 : 0;
        const sweepFlag = 0; // CAD 笛卡爾座標系 Y 向上映射至 SVG Y 向下時，CCW 弧對應 sweepFlag = 0

        const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

        return (
          <g key={entity.id} id={`cad-entity-${entity.id}`} className="cad-entity-group">
            {/* 隱形感應區 (Hitbox) */}
            <path
              d={pathData}
              {...hitboxProps}
            />
            {/* 可見細線圖形 */}
            <path
              d={pathData}
              {...commonProps}
            />
          </g>
        );
      }

      case 'polyline': {
        const pathData = getPolylineSvgPathData(entity, worldToScreen, scale);
        if (!pathData) return null;

        return (
          <g key={entity.id} id={`cad-entity-${entity.id}`} className="cad-entity-group">
            {/* 隱形感應區 (Hitbox) */}
            <path
              d={pathData}
              {...hitboxProps}
            />
            {/* 可見細線圖形 */}
            <path
              d={pathData}
              {...commonProps}
            />
          </g>
        );
      }

      default:
        return null;
    }
  };

  return (
    <g id="cad-entity-layer" className="entity-layer">
      {entities.map(renderEntity)}
    </g>
  );
};
