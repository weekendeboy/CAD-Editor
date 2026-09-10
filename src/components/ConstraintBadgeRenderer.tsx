import React, { useState } from 'react';
import { useCADStore } from '../store/cadStore';
import { Constraint, CADEntity2D, Point2D } from '../types/cad';

interface ConstraintBadgeRendererProps {
  constraints: Constraint[];
  entities: CADEntity2D[];
  worldToScreen: (point: Point2D) => Point2D;
}

// Extracted point logic identical to solver for geometric correctness
function getEntityPoint(entity: CADEntity2D, pointIndex: number = 0): Point2D | null {
  if (entity.type === 'line') {
    return pointIndex === 1 ? entity.end : entity.start;
  }
  if (entity.type === 'arc') {
    if (pointIndex === 0) {
      return {
        x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
        y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
      };
    }
    if (pointIndex === 1) {
      return {
        x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
        y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
      };
    }
    return entity.center;
  }
  if (entity.type === 'circle') {
    return entity.center;
  }
  if (entity.type === 'polyline') {
    return entity.points[pointIndex] || entity.points[0] || null;
  }
  return null;
}

// Calculate generic center for fallback anchor positioning
function getEntityCenter(entity: CADEntity2D): Point2D | null {
  if (entity.type === 'line') {
    return {
      x: (entity.start.x + entity.end.x) / 2,
      y: (entity.start.y + entity.end.y) / 2,
    };
  }
  if (entity.type === 'circle') {
    return entity.center;
  }
  if (entity.type === 'arc') {
    const midAngle = (entity.startAngle + entity.endAngle) / 2;
    return {
      x: entity.center.x + entity.radius * Math.cos(midAngle),
      y: entity.center.y + entity.radius * Math.sin(midAngle),
    };
  }
  if (entity.type === 'polyline') {
    if (entity.points.length === 0) return null;
    const sum = entity.points.reduce(
      (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
      { x: 0, y: 0 }
    );
    return {
      x: sum.x / entity.points.length,
      y: sum.y / entity.points.length,
    };
  }
  return null;
}

// Compute anchor center for a constraint based on all its associated entities and points
function getConstraintCenter(
  constraint: Constraint,
  entities: CADEntity2D[]
): Point2D | null {
  const pts: Point2D[] = [];

  constraint.entityIds.forEach((entityId, i) => {
    const entity = entities.find((e) => e.id === entityId);
    if (!entity) return;

    const ptIdx = constraint.pointIndices?.[i];
    if (ptIdx !== undefined && ptIdx !== null) {
      const pt = getEntityPoint(entity, ptIdx);
      if (pt) {
        pts.push(pt);
        return;
      }
    }

    const center = getEntityCenter(entity);
    if (center) {
      pts.push(center);
    }
  });

  if (pts.length === 0) return null;

  const sum = pts.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
    { x: 0, y: 0 }
  );
  return { x: sum.x / pts.length, y: sum.y / pts.length };
}

export const ConstraintBadgeRenderer: React.FC<ConstraintBadgeRendererProps> = ({
  constraints,
  entities,
  worldToScreen,
}) => {
  const { removeConstraint } = useCADStore();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Supported constraints for visual badge rendering
  const allowedTypes = [
    'horizontal',
    'vertical',
    'tangent',
    'parallel',
    'perpendicular',
    'coincident',
  ];

  const filteredConstraints = constraints.filter((c) => allowedTypes.includes(c.type));

  const getConstraintSymbol = (type: string): string => {
    switch (type) {
      case 'horizontal': return '—';
      case 'vertical': return '|';
      case 'tangent': return 'tan';
      case 'parallel': return '∥';
      case 'perpendicular': return '⊥';
      case 'coincident': return '+';
      default: return '';
    }
  };

  const getConstraintTitle = (type: string): string => {
    switch (type) {
      case 'horizontal': return 'Horizontal';
      case 'vertical': return 'Vertical';
      case 'tangent': return 'Tangent';
      case 'parallel': return 'Parallel';
      case 'perpendicular': return 'Perpendicular';
      case 'coincident': return 'Coincident';
      default: return 'Constraint';
    }
  };

  // Keep track of badge coordinates to prevent overlapping
  const slotMap: Record<string, number> = {};

  return (
    <g className="select-none" style={{ pointerEvents: 'all' }}>
      {filteredConstraints.map((constraint) => {
        const centerPt = getConstraintCenter(constraint, entities);
        if (!centerPt) return null;

        const rawScreenPt = worldToScreen(centerPt);
        
        // Base anchor slightly offset upwards in screen space (Y is downward in SVG)
        let targetX = rawScreenPt.x;
        let targetY = rawScreenPt.y - 18;

        // Formulate overlap detection key rounded to a grid segment (approx 20px)
        const gridX = Math.round(targetX / 18);
        const gridY = Math.round(targetY / 18);
        const key = `${gridX},${gridY}`;

        if (slotMap[key] === undefined) {
          slotMap[key] = 0;
        } else {
          slotMap[key] += 1;
          // Stagger badges horizontally if they share the exact same location
          targetX += slotMap[key] * 24;
        }

        const symbol = getConstraintSymbol(constraint.type);
        const isHovered = hoveredId === constraint.id;
        
        // Dynamic capsule width depending on label length (e.g. 'tan' vs '-')
        const width = symbol.length > 1 ? 32 : 18;
        const height = 18;
        
        // Rect offset centered around targetX, targetY
        const rx = targetX - width / 2;
        const ry = targetY - height / 2;

        return (
          <g
            key={constraint.id}
            onMouseEnter={() => setHoveredId(constraint.id)}
            onMouseLeave={() => setHoveredId(null)}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              removeConstraint(constraint.id);
            }}
            onContextMenu={(e) => {
              e.stopPropagation();
              e.preventDefault();
              removeConstraint(constraint.id);
            }}
            className="cursor-pointer"
          >
            {/* Soft backdrop blur & capsule border */}
            <rect
              x={rx}
              y={ry}
              width={width}
              height={height}
              rx="4"
              ry="4"
              fill={isHovered ? '#312e81' : '#1e1b4b'}
              fillOpacity={isHovered ? '0.95' : '0.8'}
              stroke={isHovered ? '#818cf8' : '#6366f1'}
              strokeWidth={isHovered ? '1.8' : '1.2'}
              style={{ transition: 'all 0.15s ease-in-out' }}
            />
            {/* Symbol Text */}
            <text
              x={targetX}
              y={targetY + 1}
              textAnchor="middle"
              alignmentBaseline="middle"
              fontSize="10"
              fontWeight="bold"
              fontFamily="monospace"
              fill={isHovered ? '#ffffff' : '#a5b4fc'}
              style={{ transition: 'all 0.15s ease-in-out' }}
            >
              {symbol}
            </text>

            {/* Premium Micro Tooltip on Hover */}
            {isHovered && (
              <g transform={`translate(${targetX}, ${targetY - 14})`}>
                <rect
                  x="-55"
                  y="-18"
                  width="110"
                  height="16"
                  rx="3"
                  fill="#09090b"
                  fillOpacity="0.95"
                  stroke="#3f3f46"
                  strokeWidth="1"
                />
                <text
                  x="0"
                  y="-8"
                  textAnchor="middle"
                  alignmentBaseline="middle"
                  fontSize="8"
                  fill="#e4e4e7"
                  fontFamily="sans-serif"
                >
                  {getConstraintTitle(constraint.type)} (Click to Delete)
                </text>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
};
