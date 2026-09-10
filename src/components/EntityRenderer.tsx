import React from 'react';
import { Point2D, CADEntity2D } from '../types/cad';

export interface EntityRendererProps {
  entities: CADEntity2D[];
  selectedIds: string[];
  worldToScreen: (pt: Point2D) => Point2D;
  scale: number;
  solverState?: 'UnderDefined' | 'FullyDefined' | 'OverDefined';
  onSelectEntity?: (id: string, e: React.MouseEvent) => void;
}

export const EntityRenderer: React.FC<EntityRendererProps> = ({
  entities,
  selectedIds,
  worldToScreen,
  scale,
  solverState = 'UnderDefined',
  onSelectEntity,
}) => {
  const renderEntity = (entity: CADEntity2D) => {
    // 處理不可見的圖元
    if (entity.visible === false) return null;

    const isSelected = selectedIds.includes(entity.id);
    const entityState = (entity as any).state || solverState;

    // 圖元顏色與線寬判定規則：
    // 若為 OverDefined：無論是否選取，線條均呈現警示紅色 #ef4444（加粗 2.5px）
    // 若為選取狀態（且非過定義）：呈現亮青色 #38bdf8，粗線 3px
    // 若為 FullyDefined：呈現白色 #f8fafc
    // 若為 UnderDefined：呈現經典天藍色 #60a5fa
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
      strokeColor = '#f8fafc';
    } else {
      strokeColor = '#60a5fa';
    }

    const commonProps = {
      stroke: strokeColor,
      strokeWidth,
      strokeDasharray,
      fill: 'none',
      style: { cursor: 'pointer' },
      className: `cad-entity cad-entity-${entity.type}`,
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation(); // 阻止事件冒泡到底層畫布避免觸發繪圖取點
        if (onSelectEntity) {
          onSelectEntity(entity.id, e);
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
        return (
          <circle
            key={entity.id}
            cx={center.x}
            cy={center.y}
            r={entity.radius * scale}
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

        // 計算夾角以決定是否為大弧 (Large Arc)
        let diff = entity.endAngle - entity.startAngle;
        while (diff < 0) diff += 2 * Math.PI;
        while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

        const largeArcFlag = diff > Math.PI ? 1 : 0;

        // 繪製方向 (Sweep Flag)
        const sweepFlag = 0;

        const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

        return <path key={entity.id} d={pathData} {...commonProps} />;
      }

      case 'polyline': {
        if (entity.points.length === 0) return null;

        const pointsStr = entity.points
          .map((pt) => worldToScreen(pt))
          .map((p) => `${p.x},${p.y}`)
          .join(' ');

        if (entity.closed) {
          return <polygon key={entity.id} points={pointsStr} {...commonProps} />;
        }
        return <polyline key={entity.id} points={pointsStr} {...commonProps} />;
      }

      default:
        return null;
    }
  };

  return <g className="entity-layer">{entities.map(renderEntity)}</g>;
};
