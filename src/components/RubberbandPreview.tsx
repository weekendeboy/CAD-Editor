import React from 'react';
import { Point2D, CircleEntity, ArcEntity } from '../types/cad';
import { DrawSession } from '../types/sketchInteraction';
import { calculate3PointArc } from '../core/2d/GeometryMath';
import {
  calculateLinearDimensionLayout,
  calculateRadialDimensionLayout
} from '../core/2d/DimensionEngine';

export interface RubberbandPreviewProps {
  session: DrawSession;
  tool: string;
  worldToScreen: (pt: Point2D) => Point2D;
  scale: number;
  dimSelectedCircleOrArc?: CircleEntity | ArcEntity | null;
}

export const RubberbandPreview: React.FC<RubberbandPreviewProps> = ({
  session,
  tool,
  worldToScreen,
  scale,
  dimSelectedCircleOrArc,
}) => {
  if (!session.isDrawing || !session.startPoint || !session.currentCursor) {
    return null;
  }

  const startScreen = worldToScreen(session.startPoint);
  const cursorScreen = worldToScreen(session.currentCursor);

  const strokeColor = '#f59e0b';
  const strokeWidth = 1.5;
  const strokeDasharray = '5,5';

  if (tool === 'LINE') {
    return (
      <g>
        <line
          x1={startScreen.x}
          y1={startScreen.y}
          x2={cursorScreen.x}
          y2={cursorScreen.y}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={strokeDasharray}
          fill="none"
        />
        {session.inferredConstraint && (
          <g transform={`translate(${cursorScreen.x + 16}, ${cursorScreen.y - 16})`}>
            <rect
              x={-8}
              y={-8}
              width={16}
              height={16}
              rx={3}
              fill="#facc15"
              stroke="#b57a00"
              strokeWidth={1}
            />
            <text
              x={0}
              y={0}
              fill="#1e293b"
              fontSize="12"
              fontWeight="bold"
              textAnchor="middle"
              dominantBaseline="central"
              fontFamily="sans-serif"
            >
              {session.inferredConstraint === 'horizontal' ? '—' : '|'}
            </text>
          </g>
        )}
      </g>
    );
  }

  if (tool === 'CIRCLE') {
    const radius = Math.hypot(
      cursorScreen.x - startScreen.x,
      cursorScreen.y - startScreen.y
    );
    return (
      <circle
        cx={startScreen.x}
        cy={startScreen.y}
        r={radius}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDasharray}
        fill="none"
      />
    );
  }

  if (tool === 'RECTANGLE') {
    const x = Math.min(startScreen.x, cursorScreen.x);
    const y = Math.min(startScreen.y, cursorScreen.y);
    const width = Math.abs(cursorScreen.x - startScreen.x);
    const height = Math.abs(cursorScreen.y - startScreen.y);

    return (
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDasharray}
        fill="none"
      />
    );
  }

  if (tool === 'ARC_3P' || tool === 'ARC') {
    // 步驟 1：已定起點 (startPoint)，游標正在指定終點 (secondPoint)
    if (session.step === 1 || !session.secondPoint) {
      return (
        <g>
          <line
            x1={startScreen.x}
            y1={startScreen.y}
            x2={cursorScreen.x}
            y2={cursorScreen.y}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={strokeDasharray}
            fill="none"
          />
          <circle cx={startScreen.x} cy={startScreen.y} r={3} fill={strokeColor} />
          <circle cx={cursorScreen.x} cy={cursorScreen.y} r={2.5} fill={strokeColor} opacity={0.6} />
        </g>
      );
    }

    // 步驟 2：已定起點 (startPoint) 與終點 (secondPoint)，游標 (currentCursor) 正在指定弧上通過點
    const secondScreen = worldToScreen(session.secondPoint);
    const arc = calculate3PointArc(session.startPoint, session.secondPoint, session.currentCursor);

    if (arc) {
      const screenRadius = arc.radius * scale;
      const worldStart = {
        x: arc.center.x + arc.radius * Math.cos(arc.startAngle),
        y: arc.center.y + arc.radius * Math.sin(arc.startAngle),
      };
      const worldEnd = {
        x: arc.center.x + arc.radius * Math.cos(arc.endAngle),
        y: arc.center.y + arc.radius * Math.sin(arc.endAngle),
      };
      const start = worldToScreen(worldStart);
      const end = worldToScreen(worldEnd);

      let diff = arc.endAngle - arc.startAngle;
      while (diff < 0) diff += 2 * Math.PI;
      while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

      const largeArcFlag = diff > Math.PI ? 1 : 0;
      const sweepFlag = 0;

      const pathData = `M ${start.x} ${start.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${end.x} ${end.y}`;

      return (
        <g>
          <path
            d={pathData}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={strokeDasharray}
            fill="none"
          />
          <circle cx={startScreen.x} cy={startScreen.y} r={3.5} fill={strokeColor} />
          <circle cx={secondScreen.x} cy={secondScreen.y} r={3.5} fill={strokeColor} />
          <circle cx={cursorScreen.x} cy={cursorScreen.y} r={2.5} fill={strokeColor} opacity={0.8} />
        </g>
      );
    }

    // 若三點共線或距離過近，則呈現連接起終點的輔助虛線
    return (
      <g>
        <line
          x1={startScreen.x}
          y1={startScreen.y}
          x2={secondScreen.x}
          y2={secondScreen.y}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={strokeDasharray}
          fill="none"
        />
        <circle cx={startScreen.x} cy={startScreen.y} r={3} fill={strokeColor} />
        <circle cx={secondScreen.x} cy={secondScreen.y} r={3} fill={strokeColor} />
      </g>
    );
  }

  if (tool === 'ARC_CENTER') {
    // 步驟 1：已定圓心 (startPoint)，游標正在指定半徑與起點 P_start
    if (session.step === 1 || !session.secondPoint) {
      const centerScreen = startScreen;
      const radiusScreen = Math.hypot(cursorScreen.x - centerScreen.x, cursorScreen.y - centerScreen.y);

      return (
        <g>
          {/* 半徑導引虛線 */}
          <line
            x1={centerScreen.x}
            y1={centerScreen.y}
            x2={cursorScreen.x}
            y2={cursorScreen.y}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={strokeDasharray}
            fill="none"
          />
          {/* 輔助參考全圓輪廓 */}
          {radiusScreen > 2 && (
            <circle
              cx={centerScreen.x}
              cy={centerScreen.y}
              r={radiusScreen}
              stroke={strokeColor}
              strokeWidth={1}
              strokeDasharray="3,3"
              opacity={0.35}
              fill="none"
            />
          )}
          {/* 圓心與游標點指示 */}
          <circle cx={centerScreen.x} cy={centerScreen.y} r={3.5} fill={strokeColor} />
          <circle cx={cursorScreen.x} cy={cursorScreen.y} r={2.5} fill={strokeColor} opacity={0.7} />
        </g>
      );
    }

    // 步驟 2：已定圓心 (startPoint) 與起點 P_start (secondPoint)，游標正在指定終止角度 endAngle
    const C = session.startPoint;
    const P_start = session.secondPoint;
    const centerScreen = startScreen;
    const startPtScreen = worldToScreen(P_start);

    const radius = Math.hypot(P_start.x - C.x, P_start.y - C.y);
    const screenRadius = radius * scale;

    const startAngle = Math.atan2(P_start.y - C.y, P_start.x - C.x);
    const currAngle = Math.atan2(session.currentCursor.y - C.y, session.currentCursor.x - C.x);

    // 計算當前在圓弧半徑上的終點座標
    const worldEnd = {
      x: C.x + radius * Math.cos(currAngle),
      y: C.y + radius * Math.sin(currAngle),
    };
    const endPtScreen = worldToScreen(worldEnd);

    // 計算逆時針夾角以決定是否為大弧 (Large Arc)
    let diff = currAngle - startAngle;
    while (diff < 0) diff += 2 * Math.PI;
    while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;

    const largeArcFlag = diff > Math.PI ? 1 : 0;
    const sweepFlag = 0; // CAD 標準逆時針在 SVG 畫面中對應 sweepFlag = 0

    const arcPathData = `M ${startPtScreen.x} ${startPtScreen.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${endPtScreen.x} ${endPtScreen.y}`;
    const sectorPathData = `M ${centerScreen.x} ${centerScreen.y} L ${startPtScreen.x} ${startPtScreen.y} A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${endPtScreen.x} ${endPtScreen.y} Z`;

    return (
      <g>
        {/* 扇形半透明填充 */}
        {diff > 0.005 && screenRadius > 1 && (
          <path d={sectorPathData} fill="rgba(245, 158, 11, 0.08)" />
        )}

        {/* 扇形導引線：圓心至起點 */}
        <line
          x1={centerScreen.x}
          y1={centerScreen.y}
          x2={startPtScreen.x}
          y2={startPtScreen.y}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={strokeDasharray}
          fill="none"
        />

        {/* 扇形導引線：圓心至當前終止角度點 */}
        <line
          x1={centerScreen.x}
          y1={centerScreen.y}
          x2={endPtScreen.x}
          y2={endPtScreen.y}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={strokeDasharray}
          fill="none"
        />

        {/* 若游標離圓弧半徑有距離，提供從弧終點連至實際游標的對齊虛線 */}
        <line
          x1={endPtScreen.x}
          y1={endPtScreen.y}
          x2={cursorScreen.x}
          y2={cursorScreen.y}
          stroke={strokeColor}
          strokeWidth={1}
          strokeDasharray="2,2"
          opacity={0.4}
          fill="none"
        />

        {/* 掃掠區間的圓弧虛線預覽 */}
        {diff > 0.005 && screenRadius > 1 && (
          <path
            d={arcPathData}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={strokeDasharray}
            fill="none"
          />
        )}

        {/* 圓心、起點、當前弧端點與游標標記點 */}
        <circle cx={centerScreen.x} cy={centerScreen.y} r={3.5} fill={strokeColor} />
        <circle cx={startPtScreen.x} cy={startPtScreen.y} r={3} fill={strokeColor} />
        <circle cx={endPtScreen.x} cy={endPtScreen.y} r={3} fill={strokeColor} />
        <circle cx={cursorScreen.x} cy={cursorScreen.y} r={2} fill={strokeColor} opacity={0.8} />
      </g>
    );
  }

  if (tool === 'POLYLINE') {
    const basePoints =
      session.polylinePoints && session.polylinePoints.length > 0
        ? session.polylinePoints
        : [session.startPoint];

    const allPoints = [...basePoints, session.currentCursor];
    const pointsString = allPoints
      .map(worldToScreen)
      .map((p: Point2D) => `${p.x},${p.y}`)
      .join(' ');

    return (
      <polyline
        points={pointsString}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDasharray}
        fill="none"
      />
    );
  }

  if (tool === 'DIMENSION') {
    if (session.step === 1 || !session.secondPoint) {
      return (
        <g id="dimension-rubberband-step1">
          <line
            x1={startScreen.x}
            y1={startScreen.y}
            x2={cursorScreen.x}
            y2={cursorScreen.y}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={strokeDasharray}
            fill="none"
          />
          <circle cx={startScreen.x} cy={startScreen.y} r={3.5} fill={strokeColor} />
          <circle cx={cursorScreen.x} cy={cursorScreen.y} r={2.5} fill={strokeColor} opacity={0.7} />
        </g>
      );
    } else if (session.step === 2 && session.secondPoint) {
      if (dimSelectedCircleOrArc) {
        try {
          const center = session.startPoint;
          const edge = session.secondPoint;
          const radius = Math.hypot(edge.x - center.x, edge.y - center.y);

          const sCenter = worldToScreen(center);
          const sText = cursorScreen;

          const sRadius = radius * scale;
          const isDiameter = dimSelectedCircleOrArc.type === 'circle';

          const layout = calculateRadialDimensionLayout(
            sCenter,
            sRadius,
            sText,
            isDiameter,
            7.0,         // 箭頭長度
            Math.PI / 6, // 箭頭夾角 (30度)
            10.0         // 折線長度
          );

          const textStr = isDiameter
            ? `Ø ${(radius * 2).toFixed(1)} mm`
            : `R ${radius.toFixed(1)} mm`;

          const charCount = textStr.length;
          const rectWidth = charCount * 7.5 + 12;
          const rectHeight = 18;
          const rx = layout.textCenter.x - rectWidth / 2;
          const ry = layout.textCenter.y - rectHeight / 2;

          const polylinePoints = layout.leaderPoints
            .map((p) => `${p.x},${p.y}`)
            .join(' ');

          return (
            <g id="dimension-radial-rubberband" opacity="0.8">
              <polyline
                points={polylinePoints}
                fill="none"
                stroke="#eab308"
                strokeWidth="1.2"
                className="pointer-events-none"
              />

              {layout.landingLine && (
                <line
                  x1={layout.landingLine.start.x}
                  y1={layout.landingLine.start.y}
                  x2={layout.landingLine.end.x}
                  y2={layout.landingLine.end.y}
                  stroke="#eab308"
                  strokeWidth="1.2"
                  className="pointer-events-none"
                />
              )}

              {layout.arrow1 && (
                <polygon
                  points={`${layout.arrow1.tip.x},${layout.arrow1.tip.y} ${layout.arrow1.wing1.x},${layout.arrow1.wing1.y} ${layout.arrow1.wing2.x},${layout.arrow1.wing2.y}`}
                  fill="#eab308"
                  className="pointer-events-none"
                />
              )}

              {layout.arrow2 && (
                <polygon
                  points={`${layout.arrow2.tip.x},${layout.arrow2.tip.y} ${layout.arrow2.wing1.x},${layout.arrow2.wing1.y} ${layout.arrow2.wing2.x},${layout.arrow2.wing2.y}`}
                  fill="#eab308"
                  className="pointer-events-none"
                />
              )}

              <g transform={`translate(${layout.textCenter.x}, ${layout.textCenter.y}) rotate(${(layout.textRotation * 180) / Math.PI})`}>
                <rect
                  x={-rectWidth / 2}
                  y={-rectHeight / 2}
                  width={rectWidth}
                  height={rectHeight}
                  rx="4"
                  fill="#1e293b"
                  stroke="#eab308"
                  strokeWidth="1.2"
                  opacity="0.95"
                />
                <text
                  x={0}
                  y={0}
                  fill="#facc15"
                  fontSize="11"
                  fontFamily="monospace"
                  fontWeight="bold"
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {textStr}
                </text>
              </g>
            </g>
          );
        } catch (err) {
          console.error("Error rendering radial dimension preview:", err);
        }
      } else {
        const sP1 = startScreen;
        const sP2 = worldToScreen(session.secondPoint);
        const sText = cursorScreen;

        try {
          const layout = calculateLinearDimensionLayout(
            sP1,
            sP2,
            sText,
            true,
            7.0,
            Math.PI / 6,
            3.0,
            4.0
          );

          const physicalLen = Math.hypot(session.secondPoint.x - session.startPoint.x, session.secondPoint.y - session.startPoint.y);
          const textStr = `${physicalLen.toFixed(1)} mm`;

          const charCount = textStr.length;
          const rectWidth = charCount * 7.5 + 12;
          const rectHeight = 18;
          const rx = layout.textCenter.x - rectWidth / 2;
          const ry = layout.textCenter.y - rectHeight / 2;

          return (
            <g id="dimension-rubberband-step2" opacity="0.8">
              <line
                x1={layout.extension1.start.x}
                y1={layout.extension1.start.y}
                x2={layout.extension1.end.x}
                y2={layout.extension1.end.y}
                stroke="#eab308"
                strokeWidth="1.2"
                className="pointer-events-none"
              />
              <line
                x1={layout.extension2.start.x}
                y1={layout.extension2.start.y}
                x2={layout.extension2.end.x}
                y2={layout.extension2.end.y}
                stroke="#eab308"
                strokeWidth="1.2"
                className="pointer-events-none"
              />
              <line
                x1={layout.dimensionLine.start.x}
                y1={layout.dimensionLine.start.y}
                x2={layout.dimensionLine.end.x}
                y2={layout.dimensionLine.end.y}
                stroke="#eab308"
                strokeWidth="1.2"
                className="pointer-events-none"
              />
              <polygon
                points={`${layout.arrow1.tip.x},${layout.arrow1.tip.y} ${layout.arrow1.wing1.x},${layout.arrow1.wing1.y} ${layout.arrow1.wing2.x},${layout.arrow1.wing2.y}`}
                fill="#eab308"
                className="pointer-events-none"
              />
              <polygon
                points={`${layout.arrow2.tip.x},${layout.arrow2.tip.y} ${layout.arrow2.wing1.x},${layout.arrow2.wing1.y} ${layout.arrow2.wing2.x},${layout.arrow2.wing2.y}`}
                fill="#eab308"
                className="pointer-events-none"
              />
              <g transform={`rotate(${(layout.textRotation * 180) / Math.PI}, ${layout.textCenter.x}, ${layout.textCenter.y})`}>
                <rect
                  x={rx}
                  y={ry}
                  width={rectWidth}
                  height={rectHeight}
                  rx="4"
                  fill="#1e293b"
                  stroke="#eab308"
                  strokeWidth="1.2"
                  opacity="0.95"
                />
                <text
                  x={layout.textCenter.x}
                  y={layout.textCenter.y}
                  fill="#facc15"
                  fontSize="11"
                  fontFamily="monospace"
                  fontWeight="bold"
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {textStr}
                </text>
              </g>
            </g>
          );
        } catch (err) {
          console.error("Error rendering dimension preview:", err);
        }
      }
    }
  }

  return null;
};
