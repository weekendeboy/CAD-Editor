import { Point2D } from '../../types/cad';

export interface TrackAnchor {
  id: string;
  point: Point2D;
  timestamp: number;
}

export interface TrackGuideLine {
  anchor: Point2D;
  targetPoint: Point2D;
  type: 'horizontal' | 'vertical';
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
   * Evaluates horizontal and vertical alignments with existing tracking anchors.
   * If mouse is aligned, snaps the point to the alignment axis and provides the tracking guidelines.
   */
  public evaluateTracking(mouseWorld: Point2D, tolerance: number): OTrackResult {
    const result: OTrackResult = {
      point: { ...mouseWorld },
      guideLines: [],
    };

    if (this.anchors.length === 0) {
      return result;
    }

    // Find horizontal and vertical alignment candidates
    const horizontalAlphas: { anchor: Point2D; dist: number }[] = [];
    const verticalAlphas: { anchor: Point2D; dist: number }[] = [];

    for (const anchor of this.anchors) {
      const dy = Math.abs(mouseWorld.y - anchor.point.y);
      const dx = Math.abs(mouseWorld.x - anchor.point.x);

      // We do not want to snap if mouse is extremely close to the anchor itself (usually handled by OSNAP)
      if (getDistance(mouseWorld, anchor.point) < 1e-3) {
        continue;
      }

      if (dy < tolerance) {
        horizontalAlphas.push({ anchor: anchor.point, dist: dy });
      }
      if (dx < tolerance) {
        verticalAlphas.push({ anchor: anchor.point, dist: dx });
      }
    }

    // Sort by proximity
    horizontalAlphas.sort((a, b) => a.dist - b.dist);
    verticalAlphas.sort((a, b) => a.dist - b.dist);

    // 1. Check for Intersection alignment (one horizontal anchor alignment AND one vertical anchor alignment)
    if (horizontalAlphas.length > 0 && verticalAlphas.length > 0) {
      const horizAnchor = horizontalAlphas[0].anchor;
      const vertAnchor = verticalAlphas[0].anchor;

      // The intersection point is X from vertical anchor, Y from horizontal anchor
      const intersectionPt = { x: vertAnchor.x, y: horizAnchor.y };

      // Snap the cursor directly to the intersection point
      result.point = intersectionPt;
      result.guideLines.push({
        anchor: horizAnchor,
        targetPoint: intersectionPt,
        type: 'horizontal',
      });
      result.guideLines.push({
        anchor: vertAnchor,
        targetPoint: intersectionPt,
        type: 'vertical',
      });

      return result;
    }

    // 2. Check for single horizontal alignment
    if (horizontalAlphas.length > 0) {
      const best = horizontalAlphas[0].anchor;
      result.point.y = best.y;
      result.guideLines.push({
        anchor: best,
        targetPoint: { ...result.point },
        type: 'horizontal',
      });
      return result;
    }

    // 3. Check for single vertical alignment
    if (verticalAlphas.length > 0) {
      const best = verticalAlphas[0].anchor;
      result.point.x = best.x;
      result.guideLines.push({
        anchor: best,
        targetPoint: { ...result.point },
        type: 'vertical',
      });
      return result;
    }

    return result;
  }
}
