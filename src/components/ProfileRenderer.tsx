import React, { useState } from 'react';
import { Point2D, SketchProfile, ProfileSegment } from '../types/cad';

export interface ProfileRendererProps {
  profiles: SketchProfile[];
  worldToScreen: (pt: Point2D) => Point2D;
}

/**
 * Converts a polygon loop (list of world points) into an SVG path subpath string ('M x y L x y ... Z').
 */
function loopToSvgPath(points: Point2D[], worldToScreen: (pt: Point2D) => Point2D): string {
  if (points.length === 0) return '';
  const first = worldToScreen(points[0]);
  let pathStr = `M ${first.x} ${first.y}`;

  for (let i = 1; i < points.length; i++) {
    const pt = worldToScreen(points[i]);
    pathStr += ` L ${pt.x} ${pt.y}`;
  }

  pathStr += ' Z';
  return pathStr;
}

/**
 * Converts a segment list (consisting of lines and arcs) into an SVG path subpath string.
 */
function segmentsToSvgPath(
  segments: ProfileSegment[],
  worldToScreen: (pt: Point2D) => Point2D
): string {
  if (!segments || segments.length === 0) return '';

  const p0 = worldToScreen({ x: 0, y: 0 });
  const p1 = worldToScreen({ x: 1, y: 0 });
  const scale = Math.sqrt((p1.x - p0.x) * (p1.x - p0.x) + (p1.y - p0.y) * (p1.y - p0.y));

  const startPt = worldToScreen(segments[0].start);
  let pathStr = `M ${startPt.x} ${startPt.y}`;

  for (const seg of segments) {
    const screenTo = worldToScreen(seg.end);
    if (seg.type === 'arc' && seg.radius !== undefined) {
      const rScreen = seg.radius * scale;
      const largeArc = seg.isLargeArc ? 1 : 0;
      const sweep = seg.sweepFlag ?? 0;
      pathStr += ` A ${rScreen} ${rScreen} 0 ${largeArc} ${sweep} ${screenTo.x} ${screenTo.y}`;
    } else {
      pathStr += ` L ${screenTo.x} ${screenTo.y}`;
    }
  }

  pathStr += ' Z';
  return pathStr;
}

export const ProfileRenderer: React.FC<ProfileRendererProps> = ({
  profiles,
  worldToScreen,
}) => {
  const [hoveredProfileId, setHoveredProfileId] = useState<string | null>(null);

  if (!profiles || profiles.length === 0) {
    return null;
  }

  return (
    <g id="sketch-profiles-layer" className="sketch-profiles">
      {profiles.map((profile) => {
        // Build the combined path (outer loop + inner loops)
        let d = '';
        if (profile.segments && profile.segments.length > 0) {
          d = segmentsToSvgPath(profile.segments, worldToScreen);
        } else {
          d = loopToSvgPath(profile.outerLoop, worldToScreen);
        }

        if (profile.innerLoops && profile.innerLoops.length > 0) {
          for (let i = 0; i < profile.innerLoops.length; i++) {
            const innerLoop = profile.innerLoops[i];
            const innerSegs = (profile as any).innerSegments?.[i];
            if (innerSegs && innerSegs.length > 0) {
              d += ' ' + segmentsToSvgPath(innerSegs, worldToScreen);
            } else {
              d += ' ' + loopToSvgPath(innerLoop, worldToScreen);
            }
          }
        }

        const isHovered = hoveredProfileId === profile.id;

        return (
          <path
            key={profile.id}
            id={`profile-${profile.id}`}
            d={d}
            fill={isHovered ? 'rgba(56, 189, 248, 0.35)' : 'rgba(56, 189, 248, 0.18)'}
            stroke="none"
            fillRule="evenodd"
            className="transition-colors duration-150 cursor-pointer"
            style={{ pointerEvents: 'auto' }}
            onMouseEnter={() => setHoveredProfileId(profile.id)}
            onMouseLeave={() => setHoveredProfileId(null)}
          />
        );
      })}
    </g>
  );
};
