import * as THREE from 'three';
import { Point2D, SketchProfile, ProfileSegment } from '../../types/cad';

function getPointsFromSegments(segments: ProfileSegment[]): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (const seg of segments) {
    if (seg.type === 'line') {
      pts.push(new THREE.Vector2(seg.start.x, seg.start.y));
    } else if (seg.type === 'arc' && seg.center && seg.radius !== undefined && seg.startAngle !== undefined && seg.endAngle !== undefined) {
      // Sample arc points to check orientation
      const clockwise = seg.sweepFlag === 0;
      const angleDiff = clockwise 
        ? ((seg.startAngle - seg.endAngle + Math.PI * 2) % (Math.PI * 2))
        : ((seg.endAngle - seg.startAngle + Math.PI * 2) % (Math.PI * 2));
      const steps = Math.max(5, Math.floor(angleDiff * 10));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = clockwise ? seg.startAngle - t * angleDiff : seg.startAngle + t * angleDiff;
        pts.push(new THREE.Vector2(
          seg.center.x + seg.radius * Math.cos(a),
          seg.center.y + seg.radius * Math.sin(a)
        ));
      }
    }
  }
  return pts;
}

function buildPathFromSegments(segments: ProfileSegment[], isHole: boolean): THREE.Path {
  const path = new THREE.Path();
  if (segments.length === 0) return path;

  // Check current winding order
  const pts = getPointsFromSegments(segments);
  const isCurrentlyCW = THREE.ShapeUtils.isClockWise(pts);
  
  // Outer shape must be CCW (isCurrentlyCW === false)
  // Hole must be CW (isCurrentlyCW === true)
  const needsReverse = isHole ? !isCurrentlyCW : isCurrentlyCW;

  let processedSegments = [...segments];
  if (needsReverse) {
    processedSegments.reverse();
    processedSegments = processedSegments.map(seg => {
      if (seg.type === 'line') {
        return { ...seg, start: seg.end, end: seg.start };
      } else {
        return { 
          ...seg, 
          start: seg.end, 
          end: seg.start, 
          startAngle: seg.endAngle, 
          endAngle: seg.startAngle,
          sweepFlag: seg.sweepFlag === 0 ? 1 : 0
        };
      }
    });
  }

  const firstSeg = processedSegments[0];
  path.moveTo(firstSeg.start.x, firstSeg.start.y);

  for (const seg of processedSegments) {
    // Always lineTo the start of the next segment to ensure continuity
    // (though segments should already be continuous)
    // path.lineTo(seg.start.x, seg.start.y);

    if (seg.type === 'line') {
      path.lineTo(seg.end.x, seg.end.y);
    } else if (seg.type === 'arc' && seg.center && seg.radius !== undefined && seg.startAngle !== undefined && seg.endAngle !== undefined) {
      const clockwise = seg.sweepFlag === 0;
      path.absarc(seg.center.x, seg.center.y, seg.radius, seg.startAngle, seg.endAngle, clockwise);
    }
  }

  return path;
}

export function createThreeShapeFromProfile(profile: SketchProfile): THREE.Shape {
  const shape = new THREE.Shape();
  
  if (profile.segments && profile.segments.length > 0) {
    const outerPath = buildPathFromSegments(profile.segments, false);
    // Copy outerPath to shape
    shape.curves = outerPath.curves;
    shape.currentPoint = outerPath.currentPoint;
  } else if (profile.outerLoop && profile.outerLoop.length > 0) {
    // Fallback to points if segments are not available
    const pts = profile.outerLoop.map(p => new THREE.Vector2(p.x, p.y));
    const isCW = THREE.ShapeUtils.isClockWise(pts);
    if (isCW) pts.reverse();
    
    shape.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      shape.lineTo(pts[i].x, pts[i].y);
    }
  }

  // Handle inner loops (holes)
  if (profile.innerSegments && profile.innerSegments.length > 0) {
    for (const innerSegs of profile.innerSegments) {
      const holePath = buildPathFromSegments(innerSegs, true);
      shape.holes.push(holePath);
    }
  } else if (profile.innerLoops && profile.innerLoops.length > 0) {
    // Fallback to points for inner loops
    for (const innerLoop of profile.innerLoops) {
      if (innerLoop.length === 0) continue;
      const pts = innerLoop.map(p => new THREE.Vector2(p.x, p.y));
      const isCW = THREE.ShapeUtils.isClockWise(pts);
      if (!isCW) pts.reverse(); // Holes must be CW
      
      const holePath = new THREE.Path();
      holePath.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        holePath.lineTo(pts[i].x, pts[i].y);
      }
      shape.holes.push(holePath);
    }
  }

  return shape;
}

export function createExtrudeGeometry(profile: SketchProfile, depth: number): THREE.ExtrudeGeometry {
  const shape = createThreeShapeFromProfile(profile);
  return new THREE.ExtrudeGeometry(shape, { 
    depth, 
    bevelEnabled: false, 
    curveSegments: 32 
  });
}
