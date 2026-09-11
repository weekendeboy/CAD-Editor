import { Point2D } from '../../types/cad';

export interface TrackAnchor {
  id: string;
  point: Point2D;
  timestamp: number;
}

export interface TrackGuideLine {
  anchor: Point2D;
  targetPoint: Point2D;
  angleDeg: number;
  type: 'horizontal' | 'vertical' | 'polar';
}

export interface OTrackResult {
  point: Point2D;
  guideLines: TrackGuideLine[];
}

function getDistance(p1: Point2D, p2: Point2D): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Normalizes an angle in degrees to [0, 360)
 */
function normalizeAngle(deg: number): number {
  let a = deg % 360;
  if (a < 0) a += 360;
  if (Math.abs(a - 360) < 1e-6) a = 0;
  return a;
}

/**
 * Categorizes an angle as horizontal, vertical, or general polar angle.
 */
function getGuideLineType(angleDeg: number): 'horizontal' | 'vertical' | 'polar' {
  const norm = normalizeAngle(angleDeg);
  if (Math.abs(norm - 0) < 1e-4 || Math.abs(norm - 180) < 1e-4) {
    return 'horizontal';
  }
  if (Math.abs(norm - 90) < 1e-4 || Math.abs(norm - 270) < 1e-4) {
    return 'vertical';
  }
  return 'polar';
}

export class OTrackManager {
  public anchors: TrackAnchor[] = [];
  private hoveringSnapPoint: Point2D | null = null;
  private hoverStartTime: number | null = null;
  private hasTriggeredCurrentHover = false;

  /**
   * Updates the hover state based on the current snap point under the mouse.
   * If hovering over a point for more than 500ms, it is toggled as an anchor.
   */
  public updateHover(currentSnapPoint: Point2D | null, currentTime: number): void {
    if (!currentSnapPoint) {
      this.hoveringSnapPoint = null;
      this.hoverStartTime = null;
      this.hasTriggeredCurrentHover = false;
      return;
    }

    // Check if we are still hovering near the same point (with 1e-4 tolerance in world units)
    if (
      !this.hoveringSnapPoint ||
      getDistance(currentSnapPoint, this.hoveringSnapPoint) > 1e-4
    ) {
      this.hoveringSnapPoint = currentSnapPoint;
      this.hoverStartTime = currentTime;
      this.hasTriggeredCurrentHover = false;
      return;
    }

    // If we've hovered for > 500ms and haven't triggered yet
    if (
      !this.hasTriggeredCurrentHover &&
      this.hoverStartTime !== null &&
      currentTime - this.hoverStartTime >= 500
    ) {
      this.hasTriggeredCurrentHover = true;

      // Find if we already have an anchor near this hovering point
      const existingIndex = this.anchors.findIndex(
        (a) => getDistance(a.point, currentSnapPoint) < 1e-4
      );

      if (existingIndex !== -1) {
        // Toggle off: Remove existing anchor
        this.anchors.splice(existingIndex, 1);
      } else {
        // Toggle on: Add new anchor. Max 2 anchors.
        if (this.anchors.length >= 2) {
          // Remove the oldest to make room
          this.anchors.shift();
        }
        this.anchors.push({
          id: Math.random().toString(36).substring(2, 9),
          point: currentSnapPoint,
          timestamp: currentTime,
        });
      }
    }
  }

  /**
   * Resets all anchors and state.
   */
  public reset(): void {
    this.anchors = [];
    this.hoveringSnapPoint = null;
    this.hoverStartTime = null;
    this.hasTriggeredCurrentHover = false;
  }

  /**
   * Evaluates object tracking alignments (orthogonal or polar) with existing tracking anchors.
   * If mouse is aligned with rays from anchors (or basePoint), snaps the point to the alignment ray or intersection.
   *
   * @param mouseWorld Current mouse position in world coordinates
   * @param tolerance Alignment snap tolerance in world units
   * @param polarAngles Optional array of target polar angles (e.g. [0, 45, 90, 135, ...]).
   * @param basePoint Optional current drawing start point to allow 2-ray intersections with drawing origin.
   */
  public evaluateTracking(
    mouseWorld: Point2D,
    tolerance: number,
    polarAngles?: number[],
    basePoint?: Point2D
  ): OTrackResult {
    const result: OTrackResult = {
      point: { ...mouseWorld },
      guideLines: [],
    };

    interface TrackingOrigin {
      point: Point2D;
      isBasePoint: boolean;
    }

    const origins: TrackingOrigin[] = this.anchors.map((a) => ({
      point: a.point,
      isBasePoint: false,
    }));

    if (basePoint) {
      const alreadyInAnchors = origins.some(
        (o) => getDistance(o.point, basePoint) < 1e-4
      );
      if (!alreadyInAnchors) {
        origins.push({ point: basePoint, isBasePoint: true });
      }
    }

    if (origins.length === 0) {
      return result;
    }

    // Determine target tracking angles
    const rawAngles =
      polarAngles && polarAngles.length > 0
        ? polarAngles
        : [0, 90, 180, 270];

    const targetAngles: number[] = [];
    const seen = new Set<string>();
    for (const a of rawAngles) {
      const norm = normalizeAngle(a);
      const key = norm.toFixed(4);
      if (!seen.has(key)) {
        seen.add(key);
        targetAngles.push(norm);
      }
    }

    // 1. Collect single ray candidates
    interface RayCandidate {
      anchor: Point2D;
      isBasePoint: boolean;
      angleDeg: number;
      rad: number;
      perpDist: number;
      projDist: number;
      targetPoint: Point2D;
    }

    const rayCandidates: RayCandidate[] = [];

    for (const origin of origins) {
      const dx = mouseWorld.x - origin.point.x;
      const dy = mouseWorld.y - origin.point.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 1e-3) {
        continue;
      }

      const cursorAngleDeg = normalizeAngle((Math.atan2(dy, dx) * 180) / Math.PI);

      for (const angleDeg of targetAngles) {
        const rad = (angleDeg * Math.PI) / 180;
        const cosAngle = Math.cos(rad);
        const sinAngle = Math.sin(rad);

        const projDist = dx * cosAngle + dy * sinAngle;
        if (projDist <= 0) {
          continue;
        }

        const perpDist = Math.abs(dx * sinAngle - dy * cosAngle);

        let angleDiff = Math.abs(cursorAngleDeg - angleDeg);
        if (angleDiff > 180) angleDiff = 360 - angleDiff;

        if (perpDist <= tolerance && angleDiff <= 5.0) {
          const targetPoint: Point2D = {
            x: origin.point.x + projDist * cosAngle,
            y: origin.point.y + projDist * sinAngle,
          };

          rayCandidates.push({
            anchor: origin.point,
            isBasePoint: origin.isBasePoint,
            angleDeg,
            rad,
            perpDist,
            projDist,
            targetPoint,
          });
        }
      }
    }

    // 2. Check for 2-Ray Intersection candidates between distinct origins
    interface IntersectionCandidate {
      anchor1: Point2D;
      isBase1: boolean;
      angle1: number;
      anchor2: Point2D;
      isBase2: boolean;
      angle2: number;
      intersectionPoint: Point2D;
      distToMouse: number;
    }

    const intersectionCandidates: IntersectionCandidate[] = [];

    if (origins.length >= 2) {
      for (let i = 0; i < origins.length; i++) {
        for (let j = i + 1; j < origins.length; j++) {
          const o1 = origins[i];
          const o2 = origins[j];

          for (const angle1 of targetAngles) {
            const rad1 = (angle1 * Math.PI) / 180;
            const cos1 = Math.cos(rad1);
            const sin1 = Math.sin(rad1);

            for (const angle2 of targetAngles) {
              const rad2 = (angle2 * Math.PI) / 180;
              const cos2 = Math.cos(rad2);
              const sin2 = Math.sin(rad2);

              const det = cos1 * sin2 - sin1 * cos2;
              if (Math.abs(det) < 1e-4) {
                continue; // Parallel
              }

              const Dx = o2.point.x - o1.point.x;
              const Dy = o2.point.y - o1.point.y;

              const t1 = (Dy * cos2 - Dx * sin2) / det;
              const t2 = (Dy * cos1 - Dx * sin1) / det;

              if (t1 <= 1e-4 || t2 <= 1e-4) {
                continue; // Must project forward
              }

              const interPt: Point2D = {
                x: o1.point.x + t1 * cos1,
                y: o1.point.y + t1 * sin1,
              };

              const distToMouse = getDistance(mouseWorld, interPt);

              if (distToMouse <= tolerance * 1.8) {
                intersectionCandidates.push({
                  anchor1: o1.point,
                  isBase1: o1.isBasePoint,
                  angle1,
                  anchor2: o2.point,
                  isBase2: o2.isBasePoint,
                  angle2,
                  intersectionPoint: interPt,
                  distToMouse,
                });
              }
            }
          }
        }
      }
    }

    // Priority 1: Best 2-ray intersection
    if (intersectionCandidates.length > 0) {
      intersectionCandidates.sort((a, b) => a.distToMouse - b.distToMouse);
      const bestInter = intersectionCandidates[0];

      result.point = bestInter.intersectionPoint;
      result.guideLines.push({
        anchor: bestInter.anchor1,
        targetPoint: bestInter.intersectionPoint,
        angleDeg: bestInter.angle1,
        type: getGuideLineType(bestInter.angle1),
      });
      result.guideLines.push({
        anchor: bestInter.anchor2,
        targetPoint: bestInter.intersectionPoint,
        angleDeg: bestInter.angle2,
        type: getGuideLineType(bestInter.angle2),
      });

      return result;
    }

    // Priority 2: Best single-ray tracking candidate from OTrack anchors
    const otrackRayCandidates = rayCandidates.filter((r) => !r.isBasePoint);
    if (otrackRayCandidates.length > 0) {
      otrackRayCandidates.sort((a, b) => a.perpDist - b.perpDist);
      const bestRay = otrackRayCandidates[0];

      result.point = bestRay.targetPoint;
      result.guideLines.push({
        anchor: bestRay.anchor,
        targetPoint: bestRay.targetPoint,
        angleDeg: bestRay.angleDeg,
        type: getGuideLineType(bestRay.angleDeg),
      });

      return result;
    }

    return result;
  }
}
