import React from 'react';
import { Point2D, CircleEntity, ArcEntity, CADEntity2D } from '../types/cad';
import { DrawSession } from '../types/sketchInteraction';
import { calculate3PointArc, calculatePolygonVertices } from '../core/2d/GeometryMath';
import { useCADStore } from '../store/cadStore';
import { calculateTangentArcSegment } from '../core/2d/PolylineMath';
import { calculateLinearDimensionLayout, calculateRadialDimensionLayout, calculateAngularDimensionLayout, determineLinearDimType } from '../core/2d/DimensionEngine';
import { LineEntity } from '../types/cad';

export interface RubberbandPreviewProps {
  session: DrawSession;
  tool: string;
  worldToScreen: (pt: Point2D) => Point2D;
  scale: number;
  dimSelectedCircleOrArc?: CircleEntity | ArcEntity | null;
  dimLine1?: LineEntity | null;
  dimLine2?: LineEntity | null;
  polylineMode?: 'LINE' | 'ARC';
  lastTangentDir?: Point2D | null;
  movePreviewEntities?: CADEntity2D[] | null;
  scalePreviewEntities?: CADEntity2D[] | null;
  rotatePreviewEntities?: CADEntity2D[] | null;
  ttrPreviewCircle?: CircleEntity | null;
  ttrPickPoint1?: Point2D | null;
  ttrPickPoint2?: Point2D | null;
  circle3TPreviewCircle?: CircleEntity | null;
  circle3TPickPoint1?: Point2D | null;
  circle3TPickPoint2?: Point2D | null;
  circle3TPickPoint3?: Point2D | null;
}

export const RubberbandPreview: React.FC<RubberbandPreviewProps> = ({
  session,
  tool,
  worldToScreen,
  scale,
  dimSelectedCircleOrArc,
  dimLine1,
  dimLine2,
  polylineMode,
  lastTangentDir,
  movePreviewEntities,
  scalePreviewEntities,
  rotatePreviewEntities,
  ttrPreviewCircle,
  ttrPickPoint1,
  ttrPickPoint2,
  circle3TPreviewCircle,
  circle3TPickPoint1,
  circle3TPickPoint2,
  circle3TPickPoint3,
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
    // 當處於 ARC 模式且有上一段的相切方向時，繪製相切弧預覽
    if (polylineMode === 'ARC' && lastTangentDir) {
      const arcData = calculateTangentArcSegment(session.startPoint, lastTangentDir, session.currentCursor);
      if (arcData) {
        const screenRadius = arcData.radius * scale;
        const worldStart = {
          x: arcData.center.x + arcData.radius * Math.cos(arcData.startAngle),
          y: arcData.center.y + arcData.radius * Math.sin(arcData.startAngle),
        };
        const worldEnd = {
          x: arcData.center.x + arcData.radius * Math.cos(arcData.endAngle),
          y: arcData.center.y + arcData.radius * Math.sin(arcData.endAngle),
        };
        const start = worldToScreen(worldStart);
        const end = worldToScreen(worldEnd);

        let diff = arcData.endAngle - arcData.startAngle;
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
            <circle cx={startScreen.x} cy={startScreen.y} r={3} fill={strokeColor} />
            <circle cx={cursorScreen.x} cy={cursorScreen.y} r={2.5} fill={strokeColor} opacity={0.6} />
          </g>
        );
      } else {
        // 退化至相切射線輔助導引線，防止閃爍崩溃
        const dx = session.currentCursor.x - session.startPoint.x;
        const dy = session.currentCursor.y - session.startPoint.y;
        const lenT = Math.hypot(lastTangentDir.x, lastTangentDir.y);
        if (lenT > 1e-8) {
          const tx = lastTangentDir.x / lenT;
          const ty = lastTangentDir.y / lenT;
          const dot = dx * tx + dy * ty;
          const projWorld = {
            x: session.startPoint.x + dot * tx,
            y: session.startPoint.y + dot * ty,
          };
          const projScreen = worldToScreen(projWorld);
          return (
            <g>
              <line
                x1={startScreen.x}
                y1={startScreen.y}
                x2={projScreen.x}
                y2={projScreen.y}
                stroke={strokeColor}
                strokeWidth={strokeWidth}
                strokeDasharray={strokeDasharray}
                fill="none"
              />
              <circle cx={startScreen.x} cy={startScreen.y} r={3} fill={strokeColor} />
              <circle cx={projScreen.x} cy={projScreen.y} r={2.5} fill={strokeColor} opacity={0.6} />
            </g>
          );
        }
      }
    }

    // 預設或退化（無上一段/無相切方向時）繪製直線射線段
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
    } else if (session.step === 3 && dimLine1 && dimLine2) {
      try {
        const layout = calculateAngularDimensionLayout(dimLine1, dimLine2, session.currentCursor);
        if (layout) {
          const sText = worldToScreen(layout.textCenter);
          const textStr = `${layout.angleDeg.toFixed(1)}°`;
          const charCount = textStr.length;
          const rectWidth = charCount * 7.5 + 12;
          const rectHeight = 18;

          // Convert arcPath from world to screen.
          // Wait, calculateAngularDimensionLayout returns world coords for arcPath? Yes.
          // It's easier to recreate the path using screen coordinates here.
          const V = worldToScreen({
             x: layout.textCenter.x - (Math.cos(layout.textRotation - Math.PI/2) * (Math.hypot(layout.textCenter.x - dimLine1.start.x, layout.textCenter.y - dimLine1.start.y) - 4.0)), // not exact
             y: layout.textCenter.y // this is too complex.
          });
          // Wait, instead of recalculating, calculateAngularDimensionLayout should ideally take screen coords or we just scale its output.
          // Let's just use the fact that SVG scale transform works!
          // Actually, calculateAngularDimensionLayout has everything in world coords.
          // We can map the points!
          const sArrow1Tip = worldToScreen(layout.arrow1.tip);
          const sArrow1W1 = worldToScreen(layout.arrow1.wing1);
          const sArrow1W2 = worldToScreen(layout.arrow1.wing2);

          const sArrow2Tip = worldToScreen(layout.arrow2.tip);
          const sArrow2W1 = worldToScreen(layout.arrow2.wing1);
          const sArrow2W2 = worldToScreen(layout.arrow2.wing2);

          // For the arc, we can extract the world points and convert them, OR we can recalculate it using screen coords!
          // Let's just call calculateAngularDimensionLayout with SCREEN coordinates!
          
          const sLine1 = { ...dimLine1, start: worldToScreen(dimLine1.start), end: worldToScreen(dimLine1.end) };
          const sLine2 = { ...dimLine2, start: worldToScreen(dimLine2.start), end: worldToScreen(dimLine2.end) };
          
          const sLayout = calculateAngularDimensionLayout(sLine1, sLine2, cursorScreen);
          
          if (sLayout) {
             const sText = sLayout.textCenter;
             const rx = sText.x - rectWidth / 2;
             const ry = sText.y - rectHeight / 2;
             return (
               <g id="dimension-angular-rubberband" opacity="0.8">
                 <path d={sLayout.arcPath} fill="none" stroke="#eab308" strokeWidth="1.2" strokeDasharray={strokeDasharray} className="pointer-events-none" />
                 <polygon points={`${sLayout.arrow1.tip.x},${sLayout.arrow1.tip.y} ${sLayout.arrow1.wing1.x},${sLayout.arrow1.wing1.y} ${sLayout.arrow1.wing2.x},${sLayout.arrow1.wing2.y}`} fill="#eab308" className="pointer-events-none" />
                 <polygon points={`${sLayout.arrow2.tip.x},${sLayout.arrow2.tip.y} ${sLayout.arrow2.wing1.x},${sLayout.arrow2.wing1.y} ${sLayout.arrow2.wing2.x},${sLayout.arrow2.wing2.y}`} fill="#eab308" className="pointer-events-none" />
                 <g transform={`rotate(${(sLayout.textRotation * 180) / Math.PI}, ${sLayout.textCenter.x}, ${sLayout.textCenter.y})`}>
                   <rect x={rx} y={ry} width={rectWidth} height={rectHeight} rx="4" fill="#1e293b" stroke="#eab308" strokeWidth="1.2" strokeDasharray={strokeDasharray} opacity="0.95" />
                   <text x={sLayout.textCenter.x} y={sLayout.textCenter.y} fill="#facc15" fontSize="11" fontFamily="monospace" fontWeight="bold" textAnchor="middle" dominantBaseline="central">
                     {textStr}
                   </text>
                 </g>
               </g>
             );
          }
        }
      } catch (err) {
        console.error("Error rendering angular dimension preview:", err);
      }
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
          const dimType = determineLinearDimType(session.startPoint, session.secondPoint, session.currentCursor);

          const layout = calculateLinearDimensionLayout(
            sP1,
            sP2,
            sText,
            dimType,
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
              {layout.leaderPoints && layout.leaderPoints.length >= 2 && (
                <polyline
                  points={layout.leaderPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke="#eab308"
                  strokeWidth="1.2"
                  className="pointer-events-none"
                />
              )}
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

  if (tool === 'MOVE' || tool === 'COPY') {
    const isCopy = tool === 'COPY';
    const accentColor = isCopy ? '#38bdf8' : '#f59e0b';

    return (
      <g className="pointer-events-none select-none">
        {/* 移動/複製向量引導虛線 (Base Point to Target Point) */}
        <line
          x1={startScreen.x}
          y1={startScreen.y}
          x2={cursorScreen.x}
          y2={cursorScreen.y}
          stroke={accentColor}
          strokeWidth={1.5}
          strokeDasharray="4,4"
          fill="none"
        />
        {/* 基準點指示十字與微圈標記 */}
        <circle
          cx={startScreen.x}
          cy={startScreen.y}
          r={5}
          fill="none"
          stroke={accentColor}
          strokeWidth={1.5}
        />
        <line
          x1={startScreen.x - 7}
          y1={startScreen.y}
          x2={startScreen.x + 7}
          y2={startScreen.y}
          stroke={accentColor}
          strokeWidth={1}
        />
        <line
          x1={startScreen.x}
          y1={startScreen.y - 7}
          x2={startScreen.x}
          y2={startScreen.y + 7}
          stroke={accentColor}
          strokeWidth={1}
        />

        {/* 目標點十字指示 */}
        <circle
          cx={cursorScreen.x}
          cy={cursorScreen.y}
          r={3}
          fill={accentColor}
        />

        {/* 預覽幾何圖元動態渲染 */}
        {movePreviewEntities &&
          movePreviewEntities.map((entity) => {
            const previewProps = {
              stroke: accentColor,
              strokeWidth: 2,
              strokeDasharray: '6,4',
              fill: 'none',
              opacity: 0.85,
            };

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
          })}
      </g>
    );
  }

  if (tool === 'SCALE') {
    const accentColor = '#38bdf8';

    return (
      <g className="pointer-events-none select-none">
        {/* 縮放引導虛線 (Base Point to Cursor) */}
        <line
          x1={startScreen.x}
          y1={startScreen.y}
          x2={cursorScreen.x}
          y2={cursorScreen.y}
          stroke={accentColor}
          strokeWidth={1.5}
          strokeDasharray="4,4"
          fill="none"
        />
        {/* 基準點指示十字與雙圈標記 */}
        <circle
          cx={startScreen.x}
          cy={startScreen.y}
          r={6}
          fill="none"
          stroke={accentColor}
          strokeWidth={1.5}
        />
        <circle
          cx={startScreen.x}
          cy={startScreen.y}
          r={2}
          fill={accentColor}
        />
        <line
          x1={startScreen.x - 9}
          y1={startScreen.y}
          x2={startScreen.x + 9}
          y2={startScreen.y}
          stroke={accentColor}
          strokeWidth={1.2}
        />
        <line
          x1={startScreen.x}
          y1={startScreen.y - 9}
          x2={startScreen.x}
          y2={startScreen.y + 9}
          stroke={accentColor}
          strokeWidth={1.2}
        />

        {/* 游標目標點指示 */}
        <circle
          cx={cursorScreen.x}
          cy={cursorScreen.y}
          r={3.5}
          fill={accentColor}
        />

        {/* 縮放動態虛線圖元預覽渲染 */}
        {(scalePreviewEntities || movePreviewEntities) &&
          (scalePreviewEntities || movePreviewEntities)!.map((entity) => {
            const previewProps = {
              stroke: accentColor,
              strokeWidth: 2,
              strokeDasharray: '6,4',
              fill: 'none',
              opacity: 0.9,
            };

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
          })}
      </g>
    );
  }

  if (tool === 'ROTATE') {
    const accentColor = '#38bdf8';
    const angleRad = Math.atan2(
      session.currentCursor.y - session.startPoint.y,
      session.currentCursor.x - session.startPoint.x
    );
    const angleDeg = (angleRad * 180) / Math.PI;

    // Angle indicator arc radius
    const cursorDist = Math.hypot(cursorScreen.x - startScreen.x, cursorScreen.y - startScreen.y);
    const arcRadius = Math.min(Math.max(cursorDist * 0.4, 25), 60);

    return (
      <g className="pointer-events-none select-none">
        {/* 基準點水平參考線 (Angle 0 reference) */}
        <line
          x1={startScreen.x}
          y1={startScreen.y}
          x2={startScreen.x + arcRadius + 15}
          y2={startScreen.y}
          stroke="#94a3b8"
          strokeWidth={1}
          strokeDasharray="3,3"
          opacity={0.6}
        />

        {/* 旋轉引導虛線 (Base Point to Cursor) */}
        <line
          x1={startScreen.x}
          y1={startScreen.y}
          x2={cursorScreen.x}
          y2={cursorScreen.y}
          stroke={accentColor}
          strokeWidth={1.5}
          strokeDasharray="4,4"
          fill="none"
        />

        {/* 角度動態圓弧指示 (Arc showing rotated angle) */}
        {cursorDist > 20 && Math.abs(angleRad) > 0.05 && (() => {
          // In screen coordinates, positive CAD angle goes upward (y is inverted)
          const startPt = { x: startScreen.x + arcRadius, y: startScreen.y };
          const endPt = {
            x: startScreen.x + arcRadius * Math.cos(angleRad),
            y: startScreen.y - arcRadius * Math.sin(angleRad),
          };
          let sweep = angleRad > 0 ? 0 : 1;
          let largeArc = Math.abs(angleRad) > Math.PI ? 1 : 0;
          return (
            <path
              d={`M ${startPt.x} ${startPt.y} A ${arcRadius} ${arcRadius} 0 ${largeArc} ${sweep} ${endPt.x} ${endPt.y}`}
              fill="none"
              stroke="#f59e0b"
              strokeWidth={1.5}
              strokeDasharray="2,2"
            />
          );
        })()}

        {/* 旋轉基準點指示標記 (圓環與旋轉樞紐) */}
        <circle
          cx={startScreen.x}
          cy={startScreen.y}
          r={7}
          fill="none"
          stroke={accentColor}
          strokeWidth={1.8}
        />
        <circle
          cx={startScreen.x}
          cy={startScreen.y}
          r={2.5}
          fill={accentColor}
        />
        <line
          x1={startScreen.x - 10}
          y1={startScreen.y}
          x2={startScreen.x + 10}
          y2={startScreen.y}
          stroke={accentColor}
          strokeWidth={1.2}
        />
        <line
          x1={startScreen.x}
          y1={startScreen.y - 10}
          x2={startScreen.x}
          y2={startScreen.y + 10}
          stroke={accentColor}
          strokeWidth={1.2}
        />

        {/* 游標目標點指示 */}
        <circle
          cx={cursorScreen.x}
          cy={cursorScreen.y}
          r={3.5}
          fill={accentColor}
        />

        {/* 旋轉動態虛線圖元預覽渲染 */}
        {rotatePreviewEntities &&
          rotatePreviewEntities.map((entity) => {
            const previewProps = {
              stroke: accentColor,
              strokeWidth: 2,
              strokeDasharray: '6,4',
              fill: 'none',
              opacity: 0.9,
            };

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
          })}
      </g>
    );
  }

  if (tool === 'POLYGON') {
    const sides = useCADStore.getState().polygonSides || 5;
    const method = useCADStore.getState().polygonMethod || 'inscribed';
    const vertices = calculatePolygonVertices(session.startPoint, session.currentCursor, sides, method);
    const screenVertices = vertices.map((pt) => worldToScreen(pt));
    const polyPointsStr = screenVertices.map((pt) => `${pt.x},${pt.y}`).join(' ');

    const centerDist = Math.hypot(
      session.currentCursor.x - session.startPoint.x,
      session.currentCursor.y - session.startPoint.y
    );
    const screenCenterDist = centerDist * scale;

    return (
      <g className="pointer-events-none select-none">
        {/* 中心圓/外接圓/內切圓參考虛線 */}
        {screenCenterDist > 2 && (
          <circle
            cx={startScreen.x}
            cy={startScreen.y}
            r={screenCenterDist}
            stroke={strokeColor}
            strokeWidth={1}
            strokeDasharray="3,3"
            opacity={0.35}
            fill="none"
          />
        )}

        {/* 中心點至游標導引虛線 */}
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

        {/* 正多邊形動態虛線輪廓 */}
        <polygon
          points={polyPointsStr}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={strokeDasharray}
          fill="rgba(245, 158, 11, 0.08)"
        />

        {/* 各頂點端點指示標記 */}
        {screenVertices.map((pt, idx) => (
          <circle key={idx} cx={pt.x} cy={pt.y} r={2.5} fill={strokeColor} opacity={0.8} />
        ))}

        {/* 中心點標記 */}
        <circle cx={startScreen.x} cy={startScreen.y} r={3.5} fill={strokeColor} />
      </g>
    );
  }

  if (tool === 'MIRROR') {
    const accentColor = '#c084fc';
    const markerColor = '#a855f7';

    return (
      <g className="pointer-events-none select-none">
        {/* 鏡射軸橡皮筋虛線 (Mirror Axis Preview: Point 1 to Cursor) */}
        <line
          x1={startScreen.x}
          y1={startScreen.y}
          x2={cursorScreen.x}
          y2={cursorScreen.y}
          stroke={accentColor}
          strokeWidth={1.5}
          strokeDasharray="5,4"
          fill="none"
        />

        {/* 鏡射軸第一點 (P1) 十字與同心圓標記 */}
        <circle
          cx={startScreen.x}
          cy={startScreen.y}
          r={5.5}
          fill="none"
          stroke={markerColor}
          strokeWidth={1.5}
        />
        <circle
          cx={startScreen.x}
          cy={startScreen.y}
          r={2}
          fill={markerColor}
        />
        <line
          x1={startScreen.x - 8}
          y1={startScreen.y}
          x2={startScreen.x + 8}
          y2={startScreen.y}
          stroke={markerColor}
          strokeWidth={1.2}
        />
        <line
          x1={startScreen.x}
          y1={startScreen.y - 8}
          x2={startScreen.x}
          y2={startScreen.y + 8}
          stroke={markerColor}
          strokeWidth={1.2}
        />

        {/* 當前游標端點指示標記 */}
        <circle
          cx={cursorScreen.x}
          cy={cursorScreen.y}
          r={3.5}
          fill={markerColor}
          opacity={0.9}
        />
      </g>
    );
  }

  if (tool === 'CIRCLE_TTR') {
    const pt1Screen = ttrPickPoint1 ? worldToScreen(ttrPickPoint1) : null;
    const pt2Screen = ttrPickPoint2 ? worldToScreen(ttrPickPoint2) : null;
    const circleCenterScreen = ttrPreviewCircle ? worldToScreen(ttrPreviewCircle.center) : null;
    const screenRadius = ttrPreviewCircle ? ttrPreviewCircle.radius * scale : null;

    return (
      <g className="pointer-events-none select-none">
        {/* 第一切點標記 */}
        {pt1Screen && (
          <g>
            <circle cx={pt1Screen.x} cy={pt1Screen.y} r={7} fill="none" stroke="#10b981" strokeWidth={1.5} />
            <line x1={pt1Screen.x - 9} y1={pt1Screen.y - 7} x2={pt1Screen.x + 9} y2={pt1Screen.y - 7} stroke="#10b981" strokeWidth={1.5} />
            <circle cx={pt1Screen.x} cy={pt1Screen.y} r={2.5} fill="#10b981" />
            <text x={pt1Screen.x + 10} y={pt1Screen.y - 5} fill="#10b981" fontSize="10" fontFamily="monospace" fontWeight="bold">tan 1</text>
          </g>
        )}

        {/* 第二切點標記 */}
        {pt2Screen && (
          <g>
            <circle cx={pt2Screen.x} cy={pt2Screen.y} r={7} fill="none" stroke="#10b981" strokeWidth={1.5} />
            <line x1={pt2Screen.x - 9} y1={pt2Screen.y - 7} x2={pt2Screen.x + 9} y2={pt2Screen.y - 7} stroke="#10b981" strokeWidth={1.5} />
            <circle cx={pt2Screen.x} cy={pt2Screen.y} r={2.5} fill="#10b981" />
            <text x={pt2Screen.x + 10} y={pt2Screen.y - 5} fill="#10b981" fontSize="10" fontFamily="monospace" fontWeight="bold">tan 2</text>
          </g>
        )}

        {/* 預覽圓 */}
        {circleCenterScreen && screenRadius && screenRadius > 0 && (
          <g>
            <circle
              cx={circleCenterScreen.x}
              cy={circleCenterScreen.y}
              r={screenRadius}
              stroke={strokeColor}
              strokeWidth={strokeWidth}
              strokeDasharray={strokeDasharray}
              fill="rgba(245, 158, 11, 0.08)"
            />
            <circle cx={circleCenterScreen.x} cy={circleCenterScreen.y} r={3.5} fill={strokeColor} />
            <line
              x1={circleCenterScreen.x}
              y1={circleCenterScreen.y}
              x2={cursorScreen.x}
              y2={cursorScreen.y}
              stroke={strokeColor}
              strokeWidth={1}
              strokeDasharray="3,3"
              opacity={0.6}
            />
          </g>
        )}

        {/* 第二點至游標的連線 */}
        {session.step === 2 && pt2Screen && (
          <line
            x1={pt2Screen.x}
            y1={pt2Screen.y}
            x2={cursorScreen.x}
            y2={cursorScreen.y}
            stroke={strokeColor}
            strokeWidth={1}
            strokeDasharray="4,4"
            opacity={0.8}
          />
        )}
      </g>
    );
  }

  if (tool === 'CIRCLE_3T') {
    const pt1Screen = circle3TPickPoint1 ? worldToScreen(circle3TPickPoint1) : null;
    const pt2Screen = circle3TPickPoint2 ? worldToScreen(circle3TPickPoint2) : null;
    const pt3Screen = circle3TPickPoint3 ? worldToScreen(circle3TPickPoint3) : null;
    const circleCenterScreen = circle3TPreviewCircle ? worldToScreen(circle3TPreviewCircle.center) : null;
    const screenRadius = circle3TPreviewCircle ? circle3TPreviewCircle.radius * scale : null;

    return (
      <g className="pointer-events-none select-none">
        {/* 第一切點標記 */}
        {pt1Screen && (
          <g>
            <circle cx={pt1Screen.x} cy={pt1Screen.y} r={7} fill="none" stroke="#10b981" strokeWidth={1.5} />
            <line x1={pt1Screen.x - 9} y1={pt1Screen.y - 7} x2={pt1Screen.x + 9} y2={pt1Screen.y - 7} stroke="#10b981" strokeWidth={1.5} />
            <circle cx={pt1Screen.x} cy={pt1Screen.y} r={2.5} fill="#10b981" />
            <text x={pt1Screen.x + 10} y={pt1Screen.y - 5} fill="#10b981" fontSize="10" fontFamily="monospace" fontWeight="bold">tan 1</text>
          </g>
        )}

        {/* 第二切點標記 */}
        {pt2Screen && (
          <g>
            <circle cx={pt2Screen.x} cy={pt2Screen.y} r={7} fill="none" stroke="#10b981" strokeWidth={1.5} />
            <line x1={pt2Screen.x - 9} y1={pt2Screen.y - 7} x2={pt2Screen.x + 9} y2={pt2Screen.y - 7} stroke="#10b981" strokeWidth={1.5} />
            <circle cx={pt2Screen.x} cy={pt2Screen.y} r={2.5} fill="#10b981" />
            <text x={pt2Screen.x + 10} y={pt2Screen.y - 5} fill="#10b981" fontSize="10" fontFamily="monospace" fontWeight="bold">tan 2</text>
          </g>
        )}

        {/* 第三切點標記 (若有) */}
        {pt3Screen && (
          <g>
            <circle cx={pt3Screen.x} cy={pt3Screen.y} r={7} fill="none" stroke="#10b981" strokeWidth={1.5} />
            <line x1={pt3Screen.x - 9} y1={pt3Screen.y - 7} x2={pt3Screen.x + 9} y2={pt3Screen.y - 7} stroke="#10b981" strokeWidth={1.5} />
            <circle cx={pt3Screen.x} cy={pt3Screen.y} r={2.5} fill="#10b981" />
            <text x={pt3Screen.x + 10} y={pt3Screen.y - 5} fill="#10b981" fontSize="10" fontFamily="monospace" fontWeight="bold">tan 3</text>
          </g>
        )}

        {/* 預覽圓 */}
        {circleCenterScreen && screenRadius && screenRadius > 0 && (
          <g>
            <circle
              cx={circleCenterScreen.x}
              cy={circleCenterScreen.y}
              r={screenRadius}
              stroke={strokeColor}
              strokeWidth={strokeWidth}
              strokeDasharray={strokeDasharray}
              fill="rgba(245, 158, 11, 0.08)"
            />
            <circle cx={circleCenterScreen.x} cy={circleCenterScreen.y} r={3.5} fill={strokeColor} />
            <line
              x1={circleCenterScreen.x}
              y1={circleCenterScreen.y}
              x2={cursorScreen.x}
              y2={cursorScreen.y}
              stroke={strokeColor}
              strokeWidth={1}
              strokeDasharray="3,3"
              opacity={0.6}
            />
          </g>
        )}

        {/* 第一點至游標連線 (步驟 1) */}
        {session.step === 1 && pt1Screen && (
          <line
            x1={pt1Screen.x}
            y1={pt1Screen.y}
            x2={cursorScreen.x}
            y2={cursorScreen.y}
            stroke={strokeColor}
            strokeWidth={1}
            strokeDasharray="4,4"
            opacity={0.8}
          />
        )}

        {/* 第二點至游標連線 (步驟 2) */}
        {session.step === 2 && pt2Screen && (
          <line
            x1={pt2Screen.x}
            y1={pt2Screen.y}
            x2={cursorScreen.x}
            y2={cursorScreen.y}
            stroke={strokeColor}
            strokeWidth={1}
            strokeDasharray="4,4"
            opacity={0.8}
          />
        )}
      </g>
    );
  }

  return null;
};
