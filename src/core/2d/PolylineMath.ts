import { Point2D, ArcEntity, LineEntity } from '../../types/cad';

export interface PolylineSegmentArcResult {
  center: Point2D;
  radius: number;
  startAngle: number;
  endAngle: number;
  isStartPointMatchingPStart: boolean;
}

/**
 * Calculates a transition arc segment starting at `pStart` and ending at `pEnd`
 * that is tangent to `incomingTangentDir` at `pStart`.
 *
 * The center C lies on the normal line to `incomingTangentDir` at `pStart`,
 * and is equidistant to `pStart` and `pEnd` (lying on their perpendicular bisector).
 *
 * @param pStart The starting point of the transition arc
 * @param incomingTangentDir The forward tangent vector of the previous segment at pStart
 * @param pEnd The current cursor point/end point of the transition arc
 */
export function calculateTangentArcSegment(
  pStart: Point2D,
  incomingTangentDir: Point2D,
  pEnd: Point2D
): PolylineSegmentArcResult | null {
  // 1. Normalize tangent vector to ensure length is 1
  const lenT = Math.hypot(incomingTangentDir.x, incomingTangentDir.y);
  if (lenT < 1e-8) {
    return null;
  }
  const t_x = incomingTangentDir.x / lenT;
  const t_y = incomingTangentDir.y / lenT;

  // 2. Define the normal vector N perpendicular to T.
  // We choose N = (-t_y, t_x).
  const N = { x: -t_y, y: t_x };

  // 3. Define the vector V from pStart to pEnd
  const V = { x: pEnd.x - pStart.x, y: pEnd.y - pStart.y };
  const lenV2 = V.x * V.x + V.y * V.y;

  // Prevent degenerate cases where pStart and pEnd are collinear/coincident
  if (lenV2 < 1e-8) {
    return null;
  }

  // 4. Calculate dot product of V and N
  const dotVN = V.x * N.x + V.y * N.y;
  if (Math.abs(dotVN) < 1e-8) {
    // If dot product is zero, pEnd lies on the tangent line itself.
    // Transition arc degenerates to a straight line (infinite radius).
    return null;
  }

  // 5. Solve for lambda, which determines the distance and direction to center C along N:
  // C = pStart + lambda * N
  const lambda = lenV2 / (2 * dotVN);

  // Center coordinates
  const cx = pStart.x + lambda * N.x;
  const cy = pStart.y + lambda * N.y;
  const center: Point2D = { x: cx, y: cy };

  // Radius is the absolute value of lambda
  const radius = Math.abs(lambda);
  if (radius < 1e-4) {
    return null;
  }

  // 6. Calculate angles
  const thetaStart = Math.atan2(pStart.y - cy, pStart.x - cx);
  const thetaEnd = Math.atan2(pEnd.y - cy, pEnd.x - cx);

  // Normalize angles to the range [0, 2π)
  const normalize = (angle: number): number => {
    let res = angle % (2 * Math.PI);
    if (res < 0) res += 2 * Math.PI;
    return res;
  };

  const aStart = normalize(thetaStart);
  const aEnd = normalize(thetaEnd);

  // If lambda > 0, the tangent vector T represents CCW direction around center C.
  // Thus, the arc should be traversed from pStart to pEnd CCW.
  // If lambda < 0, the tangent vector T represents CW direction around center C.
  // Thus, the arc should be traversed from pStart to pEnd CW, which is represented
  // in CCW-only CAD systems as traversing from pEnd to pStart CCW.
  let startAngle: number;
  let endAngle: number;
  let isStartPointMatchingPStart: boolean;

  if (lambda > 0) {
    startAngle = aStart;
    endAngle = aEnd;
    isStartPointMatchingPStart = true;
  } else {
    startAngle = aEnd;
    endAngle = aStart;
    isStartPointMatchingPStart = false;
  }

  return {
    center,
    radius,
    startAngle,
    endAngle,
    isStartPointMatchingPStart,
  };
}

/**
 * Calculates the forward unit tangent vector at the endpoint of the given line or arc entity,
 * so that it can be used to construct a tangent transition arc for the next segment.
 *
 * @param seg The line or arc entity
 * @param isCCW Whether the segment's physical trajectory was CCW (for arc transitions)
 */
export function getSegmentEndTangent(seg: LineEntity | ArcEntity, isCCW: boolean = true): Point2D {
  if (seg.type === 'line') {
    const dx = seg.end.x - seg.start.x;
    const dy = seg.end.y - seg.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-8) {
      // Default fallback if line is degenerate
      return { x: 1, y: 0 };
    }
    return { x: dx / len, y: dy / len };
  } else if (seg.type === 'arc') {
    // Standard CAD arc sweeps CCW from startAngle to endAngle.
    // Therefore, if the path is CCW, the forward unit tangent at endAngle is:
    // T(theta) = (-sin(theta), cos(theta)) where theta = endAngle.
    // If the path is CW, the forward unit tangent at startAngle is:
    // T(theta) = (sin(theta), -cos(theta)) where theta = startAngle.
    if (isCCW) {
      const theta = seg.endAngle;
      return {
        x: -Math.sin(theta),
        y: Math.cos(theta),
      };
    } else {
      const theta = seg.startAngle;
      return {
        x: Math.sin(theta),
        y: -Math.cos(theta),
      };
    }
  }

  // Fallback for any unexpected types
  return { x: 1, y: 0 };
}
