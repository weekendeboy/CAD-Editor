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
    const rawState = (entity.state || solverState || 'UnderDefined').toString();
    const isOverDefined = rawState === 'OverDefined' || rawState === 'over_constrained' || rawState === 'Overconstrained';
    const isFullyDefined = rawState === 'FullyDefined' || rawState === 'fully_constrained' || rawState === 'Fullyconstrained';
    const entityState: EntityState = isOverDefined ? 'OverDefined' : isFullyDefined ? 'FullyDefined' : 'UnderDefined';
    const isProjected = Boolean(entity.isProjected || entity.id.includes('_proj_'));

    // 依據規格判定圖元顏色、線寬與虛線樣式：
    let strokeColor = '#38bdf8';
    let strokeWidth = entity.lineWidth || (layer ? layer.lineWidth : 1.5) || 1.5;
    let strokeDasharray: string | undefined = undefined;

    const byLayerLineType = entity.lineType || (layer ? layer.lineType : 'CONTINUOUS');

    // 判定是否為深色畫布 (CAD 畫布背景預設為 #1E1E1E 或深色主題)
    const isDarkCanvas = typeof window !== 'undefined' && (
      window.document?.documentElement?.classList?.contains('dark') ||
      Boolean(window.document?.querySelector('.bg-\\[\\#1E1E1E\\]')) ||
      true // 2D 草圖畫布預設為 #1E1E1E 暗色背景
    );

    // 嚴格色彩優先級：
    if (isSelected) {
      strokeColor = isProjected ? '#fbbf24' : '#facc15'; // 選取高亮 (黃色/亮橘色)
      strokeWidth = isProjected ? 3.5 : 3.0;
      if (entity.isConstruction) {
        strokeDasharray = '6,4';
      } else if (byLayerLineType === 'DASHED' || byLayerLineType === 'HIDDEN') {
        strokeDasharray = '8,4';
      }
    } else if (isProjected) {
      // 投影幾何圖元 (Projected Geometry)：專屬明亮高可見度琥珀黃金 (#f59e0b)，加粗 2.5px
      strokeColor = entity.color && entity.color !== '#38bdf8' && entity.color !== '#60a5fa' && entity.color !== '#ffffff' ? entity.color : '#f59e0b';
      strokeWidth = Math.max(2.5, strokeWidth);
    } else if (entity.isConstruction) {
      strokeColor = '#c084fc';
      strokeDasharray = '6,4';
    } else if (isOverDefined) {
      strokeColor = '#ef4444'; // 過度約束/衝突 (紅色)
      strokeWidth = 2.8;
    } else if (isFullyDefined) {
      // 暗色背景使用高亮純白 (#ffffff)，淺色背景使用高對比純深黑 (#09090b)
      strokeColor = isDarkCanvas ? '#ffffff' : '#09090b'; // 完全約束
      strokeWidth = 2.8;
    } else {
      // 【核心修正】：欠約束 (UnderDefined 或未定義)，在草圖模式下一律強制為亮天藍色！嚴禁退回白色圖層色
      strokeColor = '#38bdf8'; // 亮天藍色
      strokeWidth = 2.0;
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
        const nodeR = entityState === 'FullyDefined' ? 3.2 : 2.5;
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
            {/* 可見線條圖形 */}
            <line
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              {...commonProps}
            />
            {/* 端點標記 (Endpoints Nodes) */}
            {!entity.isConstruction && !isProjected && (
              <>
                <circle cx={start.x} cy={start.y} r={nodeR} fill={strokeColor} opacity={opacity} style={{ pointerEvents: 'none' }} />
                <circle cx={end.x} cy={end.y} r={nodeR} fill={strokeColor} opacity={opacity} style={{ pointerEvents: 'none' }} />
              </>
            )}
          </g>
        );
      }

      case 'circle': {
        const center = worldToScreen(entity.center);
        const screenRadius = entity.radius * scale;
        const nodeR = entityState === 'FullyDefined' ? 3.2 : 2.5;
        return (
          <g key={entity.id} id={`cad-entity-${entity.id}`} className="cad-entity-group">
            {/* 隱形感應區 (Hitbox) */}
            <circle
              cx={center.x}
              cy={center.y}
              r={screenRadius}
              {...hitboxProps}
            />
            {/* 可見圓形圖形 */}
            <circle
              cx={center.x}
              cy={center.y}
              r={screenRadius}
              {...commonProps}
            />
            {/* 圓心點標記 */}
            {!entity.isConstruction && !isProjected && (
              <circle cx={center.x} cy={center.y} r={nodeR} fill={strokeColor} opacity={opacity} style={{ pointerEvents: 'none' }} />
            )}
          </g>
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

        // 計算夾角以決定是否為大弧 (Large Arc Flag) 與方向 (100% 依據 clockwise 旗標)
        const isCW = Boolean(entity.clockwise);
        let sweep = isCW ? entity.startAngle - entity.endAngle : entity.endAngle - entity.startAngle;
        while (sweep < 0) sweep += 2 * Math.PI;
        while (sweep >= 2 * Math.PI) sweep -= 2 * Math.PI;

        const largeArcFlag = sweep > Math.PI ? 1 : 0;
        // CAD 笛卡爾座標系 Y 向上映射至 SVG Y 向下時：CCW 對應 sweepFlag = 0，CW 對應 sweepFlag = 1
        const sweepFlag = isCW ? 1 : 0;

        const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;
        const nodeR = entityState === 'FullyDefined' ? 3.2 : 2.5;

        return (
          <g key={entity.id} id={`cad-entity-${entity.id}`} className="cad-entity-group">
            {/* 隱形感應區 (Hitbox) */}
            <path
              d={pathData}
              {...hitboxProps}
            />
            {/* 可見圓弧圖形 */}
            <path
              d={pathData}
              {...commonProps}
            />
            {/* 圓弧端點標記 */}
            {!entity.isConstruction && !isProjected && (
              <>
                <circle cx={start.x} cy={start.y} r={nodeR} fill={strokeColor} opacity={opacity} style={{ pointerEvents: 'none' }} />
                <circle cx={end.x} cy={end.y} r={nodeR} fill={strokeColor} opacity={opacity} style={{ pointerEvents: 'none' }} />
              </>
            )}
          </g>
        );
      }

      case 'polyline': {
        const pathData = getPolylineSvgPathData(entity, worldToScreen, scale);
        if (!pathData) return null;
        const nodeR = entityState === 'FullyDefined' ? 3.2 : 2.5;
        const screenPts = (entity.points || []).map(p => worldToScreen(p));

        return (
          <g key={entity.id} id={`cad-entity-${entity.id}`} className="cad-entity-group">
            {/* 隱形感應區 (Hitbox) */}
            <path
              d={pathData}
              {...hitboxProps}
            />
            {/* 可見折線圖形 */}
            <path
              d={pathData}
              {...commonProps}
            />
            {/* 折線頂點標記 */}
            {!entity.isConstruction && !isProjected && screenPts.map((sp, idx) => (
              <circle key={`pt-${idx}`} cx={sp.x} cy={sp.y} r={nodeR} fill={strokeColor} opacity={opacity} style={{ pointerEvents: 'none' }} />
            ))}
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
