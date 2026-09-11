import React from 'react';
import { Point2D, Dimension, CADEntity2D } from '../types/cad';
import {
  calculateLinearDimensionLayout,
  calculateRadialDimensionLayout,
  calculateAngularDimensionLayout
} from '../core/2d/DimensionEngine';

interface DimensionRendererProps {
  dimensions: Dimension[];
  entities: CADEntity2D[];
  worldToScreen: (pt: Point2D) => Point2D;
  onEditDimension: (dim: Dimension) => void;
  onStartDragDimensionText?: (dim: Dimension, e: React.PointerEvent) => void;
}

function getEntityPoints(entity: CADEntity2D): Point2D[] {
  if (entity.type === 'line') {
    return [entity.start, entity.end];
  } else if (entity.type === 'circle') {
    return [entity.center];
  } else if (entity.type === 'arc') {
    const startAngle = entity.startAngle;
    const endAngle = entity.endAngle;
    const arcStart = {
      x: entity.center.x + entity.radius * Math.cos(startAngle),
      y: entity.center.y + entity.radius * Math.sin(startAngle),
    };
    const arcEnd = {
      x: entity.center.x + entity.radius * Math.cos(endAngle),
      y: entity.center.y + entity.radius * Math.sin(endAngle),
    };
    return [arcStart, arcEnd, entity.center];
  } else if (entity.type === 'polyline') {
    return entity.points;
  }
  return [];
}

function getClosestEntityPoint(entity: CADEntity2D, origPt: Point2D): Point2D {
  const pts = getEntityPoints(entity);
  if (pts.length === 0) return origPt;
  let closest = pts[0];
  let minDist = Math.hypot(pts[0].x - origPt.x, pts[0].y - origPt.y);
  for (let i = 1; i < pts.length; i++) {
    const dist = Math.hypot(pts[i].x - origPt.x, pts[i].y - origPt.y);
    if (dist < minDist) {
      minDist = dist;
      closest = pts[i];
    }
  }
  return closest;
}

export const DimensionRenderer: React.FC<DimensionRendererProps> = ({
  dimensions,
  entities,
  worldToScreen,
  onEditDimension,
  onStartDragDimensionText,
}) => {
  if (!dimensions || dimensions.length === 0) return null;

  const occupiedCircles: { x: number; y: number; r: number }[] = [];
  function checkOverlap(c1: { x: number, y: number, r: number }) {
    return occupiedCircles.some(c2 => Math.hypot(c1.x - c2.x, c1.y - c2.y) < (c1.r + c2.r - 2));
  }

  return (
    <g id="cad-dimensions-layer" className="select-none">
      {dimensions.map((dim) => {
        if (!dim.points || dim.points.length === 0) return null;
        
        const isReference = !!(dim as any).isReference;
        const strokeColor = isReference ? '#67e8f9' : '#10b981';
        const textColor = isReference ? '#cffafe' : '#34d399';

        try {
          if (dim.type === 'linear') {
            if (dim.points.length < 2) return null;

            let p1 = dim.points[0];
            let p2 = dim.points[1];
            let resolved = false;

            if (dim.entityIds && dim.entityIds.length > 0) {
              if (dim.entityIds.length === 1) {
                const ent = entities.find((e) => e.id === dim.entityIds![0]);
                if (ent && ent.type === 'line') {
                  p1 = ent.start;
                  p2 = ent.end;
                  resolved = true;
                }
              } else if (dim.entityIds.length === 2) {
                const ent1 = entities.find((e) => e.id === dim.entityIds![0]);
                const ent2 = entities.find((e) => e.id === dim.entityIds![1]);
                if (ent1 && ent2) {
                  p1 = getClosestEntityPoint(ent1, dim.points[0]);
                  p2 = getClosestEntityPoint(ent2, dim.points[1]);
                  resolved = true;
                }
              }
            }

            let textPosition = dim.textPosition;
            if (resolved) {
              const dx = ((p1.x - dim.points[0].x) + (p2.x - dim.points[1].x)) / 2;
              const dy = ((p1.y - dim.points[0].y) + (p2.y - dim.points[1].y)) / 2;
              textPosition = {
                x: dim.textPosition.x + dx,
                y: dim.textPosition.y + dy,
              };
            }
            
            const sP1 = worldToScreen(p1);
            const sP2 = worldToScreen(p2);
            let sText = worldToScreen(textPosition);

            const isAligned = dim.dimType ? dim.dimType : ((dim as any).isAligned !== false);

            let layout = calculateLinearDimensionLayout(
              sP1,
              sP2,
              sText,
              isAligned,
              7.0,             // 箭頭長度
              Math.PI / 6,     // 箭頭夾角 (30度)
              3.0,             // gap 間距
              4.0              // extend 伸出量
            );

            const physicalLen = dim.dimType === 'horizontal'
              ? Math.abs(p2.x - p1.x)
              : dim.dimType === 'vertical'
              ? Math.abs(p2.y - p1.y)
              : Math.hypot(p2.x - p1.x, p2.y - p1.y);
            let textStr = `${physicalLen.toFixed(1)} mm`;
            if (isReference) textStr = `(${textStr})`;

            const charCount = textStr.length;
            const rectWidth = charCount * 7.5 + 12;
            const rectHeight = 18;
            const collisionRadius = Math.hypot(rectWidth / 2, rectHeight / 2) * 0.8;

            let attempts = 0;
            while (attempts < 8 && layout) {
              if (!checkOverlap({ x: layout.textCenter.x, y: layout.textCenter.y, r: collisionRadius })) break;
              // shift perpendicular to textRotation
              sText.x -= Math.sin(layout.textRotation) * 22;
              sText.y += Math.cos(layout.textRotation) * 22;
              layout = calculateLinearDimensionLayout(sP1, sP2, sText, isAligned, 7.0, Math.PI / 6, 3.0, 4.0);
              attempts++;
            }
            
            if (!layout) return null;
            occupiedCircles.push({ x: layout.textCenter.x, y: layout.textCenter.y, r: collisionRadius });

            return (
              <g key={dim.id} id={`dimension-linear-${dim.id}`}>
                <line
                  x1={layout.extension1.start.x}
                  y1={layout.extension1.start.y}
                  x2={layout.extension1.end.x}
                  y2={layout.extension1.end.y}
                  stroke={strokeColor}
                  strokeWidth="1"
                  className="pointer-events-none"
                />
                <line
                  x1={layout.extension2.start.x}
                  y1={layout.extension2.start.y}
                  x2={layout.extension2.end.x}
                  y2={layout.extension2.end.y}
                  stroke={strokeColor}
                  strokeWidth="1"
                  className="pointer-events-none"
                />
                <line
                  x1={layout.dimensionLine.start.x}
                  y1={layout.dimensionLine.start.y}
                  x2={layout.dimensionLine.end.x}
                  y2={layout.dimensionLine.end.y}
                  stroke={strokeColor}
                  strokeWidth="1"
                  className="pointer-events-none"
                />
                {layout.leaderPoints && layout.leaderPoints.length >= 2 && (
                  <polyline
                    points={layout.leaderPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth="1"
                    className="pointer-events-none"
                  />
                )}
                {layout.landingLine && (
                  <line
                    x1={layout.landingLine.start.x}
                    y1={layout.landingLine.start.y}
                    x2={layout.landingLine.end.x}
                    y2={layout.landingLine.end.y}
                    stroke={strokeColor}
                    strokeWidth="1"
                    className="pointer-events-none"
                  />
                )}
                <polygon
                  points={`${layout.arrow1.tip.x},${layout.arrow1.tip.y} ${layout.arrow1.wing1.x},${layout.arrow1.wing1.y} ${layout.arrow1.wing2.x},${layout.arrow1.wing2.y}`}
                  fill={strokeColor}
                  className="pointer-events-none"
                />
                <polygon
                  points={`${layout.arrow2.tip.x},${layout.arrow2.tip.y} ${layout.arrow2.wing1.x},${layout.arrow2.wing1.y} ${layout.arrow2.wing2.x},${layout.arrow2.wing2.y}`}
                  fill={strokeColor}
                  className="pointer-events-none"
                />
                <g
                  transform={`translate(${layout.textCenter.x}, ${layout.textCenter.y}) rotate(${(layout.textRotation * 180) / Math.PI})`}
                  onPointerDown={(e) => {
                    if (e.button === 0) {
                      e.stopPropagation();
                      onStartDragDimensionText?.(dim, e);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onEditDimension(dim);
                  }}
                  style={{ cursor: 'move', pointerEvents: 'all' }}
                  className="cad-dim-text group"
                >
                  <rect
                    x={-rectWidth / 2}
                    y={-rectHeight / 2}
                    width={rectWidth}
                    height={rectHeight}
                    rx="4"
                    fill="#1e293b"
                    stroke={strokeColor}
                    strokeWidth="1"
                    opacity="0.95"
                    className="hover:stroke-cyan-400 transition-colors"
                  />
                  <text
                    x={0}
                    y={0}
                    fill={textColor}
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
          } else if (dim.type === 'radial') {
            const center = dim.points[0];
            const edge = dim.points[1] || { x: center.x + 10, y: center.y };
            const physicalRadius = Math.hypot(edge.x - center.x, edge.y - center.y);

            const sCenter = worldToScreen(center);
            const sRadius = physicalRadius * Math.hypot(worldToScreen({ x: 1, y: 0 }).x - worldToScreen({ x: 0, y: 0 }).x, worldToScreen({ x: 1, y: 0 }).y - worldToScreen({ x: 0, y: 0 }).y);
            let sText = worldToScreen(dim.textPosition);

            const isDiameter = !!(dim as any).isDiameter;

            let textStr = isDiameter
              ? `Ø ${(physicalRadius * 2).toFixed(1)} mm`
              : `R ${physicalRadius.toFixed(1)} mm`;
            if (isReference) textStr = `(${textStr})`;

            let layout = calculateRadialDimensionLayout(
              sCenter,
              physicalRadius * (sRadius / physicalRadius),
              sText,
              isDiameter,
              7.0, // 箭頭長度
              Math.PI / 6, // 箭頭夾角 (30度)
              10.0 // 折線長度
            );

            const charCount = textStr.length;
            const rectWidth = charCount * 7.5 + 12;
            const rectHeight = 18;
            const collisionRadius = Math.hypot(rectWidth / 2, rectHeight / 2) * 0.8;

            let attempts = 0;
            while (attempts < 8 && layout) {
              if (!checkOverlap({ x: layout.textCenter.x, y: layout.textCenter.y, r: collisionRadius })) break;
              sText.y -= 22; // shift vertically
              layout = calculateRadialDimensionLayout(sCenter, physicalRadius * (sRadius / physicalRadius), sText, isDiameter, 7.0, Math.PI / 6, 10.0);
              attempts++;
            }

            if (!layout) return null;
            occupiedCircles.push({ x: layout.textCenter.x, y: layout.textCenter.y, r: collisionRadius });

            const polylinePoints = layout.leaderPoints
              .map((p) => `${p.x},${p.y}`)
              .join(' ');

            return (
              <g key={dim.id} id={`dimension-radial-${dim.id}`}>
                <polyline
                  points={polylinePoints}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth="1"
                  className="pointer-events-none"
                />
                {layout.landingLine && (
                  <line
                    x1={layout.landingLine.start.x}
                    y1={layout.landingLine.start.y}
                    x2={layout.landingLine.end.x}
                    y2={layout.landingLine.end.y}
                    stroke={strokeColor}
                    strokeWidth="1"
                    className="pointer-events-none"
                  />
                )}
                {layout.arrow1 && (
                  <polygon
                    points={`${layout.arrow1.tip.x},${layout.arrow1.tip.y} ${layout.arrow1.wing1.x},${layout.arrow1.wing1.y} ${layout.arrow1.wing2.x},${layout.arrow1.wing2.y}`}
                    fill={strokeColor}
                    className="pointer-events-none"
                  />
                )}
                {layout.arrow2 && (
                  <polygon
                    points={`${layout.arrow2.tip.x},${layout.arrow2.tip.y} ${layout.arrow2.wing1.x},${layout.arrow2.wing1.y} ${layout.arrow2.wing2.x},${layout.arrow2.wing2.y}`}
                    fill={strokeColor}
                    className="pointer-events-none"
                  />
                )}
                <g
                  transform={`translate(${layout.textCenter.x}, ${layout.textCenter.y}) rotate(${(layout.textRotation * 180) / Math.PI})`}
                  onPointerDown={(e) => {
                    if (e.button === 0) {
                      e.stopPropagation();
                      onStartDragDimensionText?.(dim, e);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onEditDimension(dim);
                  }}
                  style={{ cursor: 'move', pointerEvents: 'all' }}
                  className="cad-dim-text group"
                >
                  <rect
                    x={-rectWidth / 2}
                    y={-rectHeight / 2}
                    width={rectWidth}
                    height={rectHeight}
                    rx="4"
                    fill="#1e293b"
                    stroke={strokeColor}
                    strokeWidth="1"
                    opacity="0.95"
                    className="hover:stroke-cyan-400 transition-colors"
                  />
                  <text
                    x={0}
                    y={0}
                    fill={textColor}
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
          } else if (dim.type === 'angular') {
            if (dim.points.length < 4) return null;
            let line1 = { start: dim.points[0], end: dim.points[1], type: 'line' as const, id: '', layerId: '', visible: true, locked: false };
            let line2 = { start: dim.points[2], end: dim.points[3], type: 'line' as const, id: '', layerId: '', visible: true, locked: false };
            
            if (dim.entityIds && dim.entityIds.length === 2) {
               const ent1 = entities.find(e => e.id === dim.entityIds![0]);
               const ent2 = entities.find(e => e.id === dim.entityIds![1]);
               if (ent1 && ent1.type === 'line') line1 = ent1;
               if (ent2 && ent2.type === 'line') line2 = ent2;
            }

            const sLine1 = { ...line1, start: worldToScreen(line1.start), end: worldToScreen(line1.end) };
            const sLine2 = { ...line2, start: worldToScreen(line2.start), end: worldToScreen(line2.end) };
            let sText = worldToScreen(dim.textPosition);

            let layout = calculateAngularDimensionLayout(sLine1, sLine2, sText);
            
            if (layout) {
              let textStr = `${layout.angleDeg.toFixed(1)}°`;
              if (isReference) textStr = `(${textStr})`;

              const charCount = textStr.length;
              const rectWidth = charCount * 7.5 + 12;
              const rectHeight = 18;
              const collisionRadius = Math.hypot(rectWidth / 2, rectHeight / 2) * 0.8;

              let attempts = 0;
              while (attempts < 8 && layout) {
                if (!checkOverlap({ x: layout.textCenter.x, y: layout.textCenter.y, r: collisionRadius })) break;
                // shift radially
                sText.x += Math.sin(layout.textRotation) * 22;
                sText.y -= Math.cos(layout.textRotation) * 22;
                layout = calculateAngularDimensionLayout(sLine1, sLine2, sText);
                attempts++;
              }

              if (!layout) return null;
              occupiedCircles.push({ x: layout.textCenter.x, y: layout.textCenter.y, r: collisionRadius });

              return (
                <g key={dim.id} id={`dimension-angular-${dim.id}`}>
                  <path d={layout.arcPath} fill="none" stroke={strokeColor} strokeWidth="1" className="pointer-events-none" />
                  <polygon points={`${layout.arrow1.tip.x},${layout.arrow1.tip.y} ${layout.arrow1.wing1.x},${layout.arrow1.wing1.y} ${layout.arrow1.wing2.x},${layout.arrow1.wing2.y}`} fill={strokeColor} className="pointer-events-none" />
                  <polygon points={`${layout.arrow2.tip.x},${layout.arrow2.tip.y} ${layout.arrow2.wing1.x},${layout.arrow2.wing1.y} ${layout.arrow2.wing2.x},${layout.arrow2.wing2.y}`} fill={strokeColor} className="pointer-events-none" />
                  <g
                    transform={`translate(${layout.textCenter.x}, ${layout.textCenter.y}) rotate(${(layout.textRotation * 180) / Math.PI})`}
                    onPointerDown={(e) => {
                      if (e.button === 0) {
                        e.stopPropagation();
                        onStartDragDimensionText?.(dim, e);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      onEditDimension(dim);
                    }}
                    style={{ cursor: 'move', pointerEvents: 'all' }}
                    className="cad-dim-text group"
                  >
                    <rect x={-rectWidth / 2} y={-rectHeight / 2} width={rectWidth} height={rectHeight} rx="4" fill="#1e293b" stroke={strokeColor} strokeWidth="1" opacity="0.95" className="hover:stroke-cyan-400 transition-colors" />
                    <text x={0} y={0} fill={textColor} fontSize="11" fontFamily="monospace" fontWeight="bold" textAnchor="middle" dominantBaseline="central">
                      {textStr}
                    </text>
                  </g>
                </g>
              );
            }
          }
        } catch (err) {
          console.error(`Error rendering dimension ${dim.id}:`, err);
        }
        return null;
      })}
    </g>
  );
};
