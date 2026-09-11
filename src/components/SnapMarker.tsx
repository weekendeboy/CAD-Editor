import React from 'react';
import { Point2D } from '../types/cad';
import { SnapResult, SnapType } from '../core/2d/SnapManager';

interface SnapMarkerProps {
  snap: SnapResult | null;
  worldToScreen: (pt: Point2D) => Point2D;
}

export const SnapMarker: React.FC<SnapMarkerProps> = ({ snap, worldToScreen }) => {
  if (!snap) return null;

  const screenPt = worldToScreen(snap.point);

  const renderMarkerShape = (type: SnapType) => {
    switch (type) {
      case 'endpoint':
        return <rect x="-5" y="-5" width="10" height="10" />;
      case 'midpoint':
        return <polygon points="0,-6 -6,5 6,5" />;
      case 'center':
        return <circle cx="0" cy="0" r="5" />;
      case 'quadrant':
        return <polygon points="0,-6 6,0 0,6 -6,0" />;
      case 'intersection':
        return <path d="M -5 -5 L 5 5 M 5 -5 L -5 5" />;
      case 'perpendicular':
        return <path d="M -5 5 L -5 -2 L 2 -2" />;
      case 'tangent':
        return (
          <>
            <circle cx="0" cy="2" r="4" />
            <line x1="-5" y1="-3" x2="5" y2="-3" />
          </>
        );
      case 'extension':
        return <path d="M -5 0 L 5 0 M -2 -2 L 2 2" strokeDasharray="2,2" />;
      case 'parallel':
        return <path d="M -4 4 L 1 -4 M 0 4 L 5 -4" />;
      default:
        return null;
    }
  };

  const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1);

  return (
    <g transform={`translate(${screenPt.x}, ${screenPt.y})`}>
      <g stroke="#22c55e" strokeWidth="2" fill="none">
        {renderMarkerShape(snap.type)}
      </g>
      <text
        x="8"
        y="8"
        fill="#22c55e"
        fontSize="12"
        fontFamily="monospace"
        pointerEvents="none"
      >
        {capitalize(snap.type)}
      </text>
    </g>
  );
};
