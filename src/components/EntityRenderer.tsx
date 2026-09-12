import React from 'react';
import { Point2D, CADEntity2D, EntityState } from '../types/cad';
import { getPolylineSvgPathData } from '../core/2d/PolylineUtils';

export interface EntityRendererProps {
  entities: CADEntity2D[];
  selectedIds: string[];
  worldToScreen: (pt: Point2D) => Point2D;
  scale: number;
  solverState?: EntityState;
  onSelectEntity?: (id: string, e: React.MouseEvent) => void;
  currentTool: string;
}

export const EntityRenderer: React.FC<EntityRendererProps> = ({
  entities,
  selectedIds,
  worldToScreen,
  scale,
  solverState = 'UnderDefined',
  onSelectEntity,
  currentTool,
}) => {
  const renderEntity = (entity: CADEntity2D) => {
    // 隱藏設定為不可見的圖元
    if (entity.visible === false) return null;

    const isSelected = selectedIds.includes(entity.id);
    const entityState: EntityState = (entity as any).state || solverState || 'UnderDefined';

    // 依據規格判定圖元顏色、線款與虛線樣式：
    // 1. 建構線 (isConstruction === true)：顯示為紫色虛線 (#c084fc / 選取時 #38bdf8)
    // 2. OverDefined：警示紅色 (#ef4444)
    // 3. Selected：亮藍色 (#38bdf8)
    // 4. FullyDefined：綠色 (#10b981)
    // 5. UnderDefined：藍色 (#60a5fa)
    let strokeColor = '#60a5fa';
    let strokeWidth = entity.lineWidth || 1.5;
    let strokeDasharray: string | undefined = undefined;

    if (entity.isConstruction === true) {
      strokeColor = isSelected ? '#38bdf8' : '#c084fc';
      strokeDasharray = '6,4';
      if (isSelected) {
        strokeWidth = 2.5;
      }
    } else if (entityState === 'OverDefined') {
      strokeColor = '#ef4444';
      strokeWidth = 2.5;
    } else if (isSelected) {
      strokeColor = '#38bdf8';
      strokeWidth = 3;
    } else if (entityState === 'FullyDefined') {
      strokeColor = '#10b981';
    } else {
      strokeColor = '#60a5fa';
    }

    const isSelectMode = currentTool === 'SELECT';

    const commonProps = {
      stroke: strokeColor,
      strokeWidth,
      strokeDasharray,
      fill: 'none',
      pointerEvents: (isSelectMode ? 'all' : 'none') as React.CSSProperties['pointerEvents'],
      style: {
        cursor: isSelectMode ? 'pointer' : 'crosshair',
        pointerEvents: (isSelectMode ? 'all' : 'none') as React.CSSProperties['pointerEvents'],
      },
      className: `cad-entity cad-entity-${entity.type} ${isSelected ? 'cad-entity-selected' : ''}`,
      onClick: (e: React.MouseEvent) => {
        if (isSelectMode) {
          e.stopPropagation();
          if (onSelectEntity) {
            onSelectEntity(entity.id, e);
          }
        }
      },
    };

    switch (entity.type) {
      case 'line': {
        const start = worldToScreen(entity.start);
        const end = worldToScreen(entity.end);
        return (
          <line
            key={entity.id}
            id={`cad-entity-${entity.id}`}
            x1={start.x}
            y1={start.y}
            x2={end.x}
            y2={end.y}
            {...commonProps}
          />
        );
      }

      case 'circle': {
        const center = worldToScreen(entity.center);
        const screenRadius = entity.radius * scale;
        return (
          <circle
            key={entity.id}
            id={`cad-entity-${entity.id}`}
            cx={center.x}
            cy={center.y}
            r={screenRadius}
            {...commonProps}
          />
        );
      }

      case 'arc': {
        // 計算世界座標的起終點
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
        const sweepFlag = 0;

        const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

        return (
          <path
            key={entity.id}
            id={`cad-entity-${entity.id}`}
            d={pathData}
            {...commonProps}
          />
        );
      }

      case 'polyline': {
        const pathData = getPolylineSvgPathData(entity, worldToScreen, scale);
        if (!pathData) return null;

        return (
          <path
            key={entity.id}
            id={`cad-entity-${entity.id}`}
            d={pathData}
            {...commonProps}
          />
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
