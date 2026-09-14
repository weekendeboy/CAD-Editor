import { Point2D } from '../../types/cad';
import { calculateRayIntersection, Ray2D } from './GeometryMath';

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
   * Evaluates object tracking alignments (orthogonal or polar) with existing tracking anchors and base point.
   * Performs pairwise ray intersection solving across all active guides first, then falls back to single-ray candidate matching.
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

    // Collect all active guide lines (rays) from all active origins
    interface ActiveGuide {
      anchor: Point2D;
      isBasePoint: boolean;
      angleDeg: number;
      rad: number;
      type: 'horizontal' | 'vertical' | 'polar';
      ray: Ray2D;
    }

    const activeGuides: ActiveGuide[] = [];

    for (const origin of origins) {
      for (const angleDeg of targetAngles) {
        const rad = (angleDeg * Math.PI) / 180;
        activeGuides.push({
          anchor: origin.point,
          isBasePoint: origin.isBasePoint,
          angleDeg,
          rad,
          type: getGuideLineType(angleDeg),
          ray: {
            origin: origin.point,
            angle: rad,
          },
        });
      }
    }

    // 1. Pairwise Intersection Evaluation (兩兩射線求交)
    interface IntersectionCandidate {
      guide1: ActiveGuide;
      guide2: ActiveGuide;
      intersectionPoint: Point2D;
      distToMouse: number;
    }

    const intersectionCandidates: IntersectionCandidate[] = [];

    for (let i = 0; i < activeGuides.length; i++) {
      for (let j = i + 1; j < activeGuides.length; j++) {
        const g1 = activeGuides[i];
        const g2 = activeGuides[j];

        // Skip rays originating from the exact same anchor point
        if (getDistance(g1.anchor, g2.anchor) < 1e-4) {
          continue;
        }

        // Calculate ray intersection using calculateRayIntersection
        const interPt = calculateRayIntersection(g1.ray, g2.ray);
        if (!interPt) {
          continue; // Parallel or collinear rays
        }

        // Verify that the intersection point projects forward along both rays
        const v1 = { x: Math.cos(g1.rad), y: Math.sin(g1.rad) };
        const v2 = { x: Math.cos(g2.rad), y: Math.sin(g2.rad) };

        const t1 = (interPt.x - g1.anchor.x) * v1.x + (interPt.y - g1.anchor.y) * v1.y;
        const t2 = (interPt.x - g2.anchor.x) * v2.x + (interPt.y - g2.anchor.y) * v2.y;

        // Rays project forward
        if (t1 < -1e-3 || t2 < -1e-3) {
          continue;
        }

        const distToMouse = getDistance(mouseWorld, interPt);

        if (distToMouse <= tolerance) {
          intersectionCandidates.push({
            guide1: g1,
            guide2: g2,
            intersectionPoint: interPt,
            distToMouse,
          });
        }
      }
    }

    // Priority 1: Force Snap to Intersection if mouse is within tolerance of any virtual intersection
    if (intersectionCandidates.length > 0) {
      intersectionCandidates.sort((a, b) => a.distToMouse - b.distToMouse);
      const bestInter = intersectionCandidates[0];

      result.point = bestInter.intersectionPoint;

      // Return BOTH guide lines that form this intersection
      result.guideLines.push({
        anchor: bestInter.guide1.anchor,
        targetPoint: bestInter.intersectionPoint,
        angleDeg: bestInter.guide1.angleDeg,
        type: bestInter.guide1.type,
      });
      result.guideLines.push({
        anchor: bestInter.guide2.anchor,
        targetPoint: bestInter.intersectionPoint,
        angleDeg: bestInter.guide2.angleDeg,
        type: bestInter.guide2.type,
      });

      return result;
    }

    // Priority 2: Fallback strategy - Single ray distance evaluation
    interface SingleRayCandidate {
      guide: ActiveGuide;
      perpDist: number;
      projDist: number;
      targetPoint: Point2D;
    }

    const singleRayCandidates: SingleRayCandidate[] = [];

    for (const guide of activeGuides) {
      const dx = mouseWorld.x - guide.anchor.x;
      const dy = mouseWorld.y - guide.anchor.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 1e-3) {
        continue;
      }

      const cosAngle = Math.cos(guide.rad);
      const sinAngle = Math.sin(guide.rad);

      const projDist = dx * cosAngle + dy * sinAngle;
      if (projDist <= 0) {
        continue;
      }

      const perpDist = Math.abs(dx * sinAngle - dy * cosAngle);

      const cursorAngleDeg = normalizeAngle((Math.atan2(dy, dx) * 180) / Math.PI);
      let angleDiff = Math.abs(cursorAngleDeg - guide.angleDeg);
      if (angleDiff > 180) angleDiff = 360 - angleDiff;

      if (perpDist <= tolerance && angleDiff <= 5.0) {
        const targetPoint: Point2D = {
          x: guide.anchor.x + projDist * cosAngle,
          y: guide.anchor.y + projDist * sinAngle,
        };

        singleRayCandidates.push({
          guide,
          perpDist,
          projDist,
          targetPoint,
        });
      }
    }

    if (singleRayCandidates.length > 0) {
      // Prioritize non-basePoint rays if available, or sort by smallest perpDist
      const otrackCandidates = singleRayCandidates.filter((r) => !r.guide.isBasePoint);
      const candidatesToUse = otrackCandidates.length > 0 ? otrackCandidates : singleRayCandidates;

      candidatesToUse.sort((a, b) => a.perpDist - b.perpDist);
      const bestRay = candidatesToUse[0];

      result.point = bestRay.targetPoint;
      result.guideLines.push({
        anchor: bestRay.guide.anchor,
        targetPoint: bestRay.targetPoint,
        angleDeg: bestRay.guide.angleDeg,
        type: bestRay.guide.type,
      });

      return result;
    }

    return result;
  }
}

