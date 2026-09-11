import { Point2D, CADEntity2D } from '../../types/cad';
import { TrackAnchor } from './ObjectTracking';

export interface PolarTrackingResult {
  snappedPoint: Point2D;
  rayStart: Point2D;
  rayEnd: Point2D;
  angleDeg: number;
}

export interface PolarExtensionIntersection {
  point: Point2D;
  polarAngleDeg: number;
  entityId: string;
  extensionRay: { start: Point2D; end: Point2D };
}

// 取得所有極軸目標角度集合 (去重並規格化至 [0, 360))
export function getNormalizedPolarAngles(stepAngleDeg: number, customAngles: number[]): number[] {
  const angles: number[] = [];
  if (stepAngleDeg > 0 && Number.isFinite(stepAngleDeg)) {
    for (let k = 0; k * stepAngleDeg < 360 - 1e-9; k++) {
      angles.push(k * stepAngleDeg);
    }
  }
  const allAngles = [...angles, ...customAngles];
  const normalized = allAngles.map((a) => ((a % 360) + 360) % 360);
  const unique: number[] = [];
  const seen = new Set<string>();
  for (const a of normalized) {
    const key = a.toFixed(4);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(a);
    }
  }
  return unique;
}

export function calculatePolarTracking(
  basePoint: Point2D,
  currentCursor: Point2D,
  stepAngleDeg: number = 45,
  customAngles: number[] = [],
  angleToleranceDeg: number = 2.5
): PolarTrackingResult | null {
  const dx = currentCursor.x - basePoint.x;
  const dy = currentCursor.y - basePoint.y;
  const R = Math.hypot(dx, dy);
  if (R < 1e-4) return null;

  const targetAngles = getNormalizedPolarAngles(stepAngleDeg, customAngles);
  if (targetAngles.length === 0) return null;

  let angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angleDeg < 0) angleDeg += 360;

  let minDiff = Infinity;
  let bestAngle = 0;
  for (const target of targetAngles) {
    let diff = Math.abs(angleDeg - target);
    if (diff > 180) diff = 360 - diff;
    if (diff < minDiff) {
      minDiff = diff;
      bestAngle = target;
    }
  }

  if (minDiff < angleToleranceDeg) {
    const snapRad = (bestAngle * Math.PI) / 180;
    const cosSnap = Math.cos(snapRad);
    const sinSnap = Math.sin(snapRad);
    const deltaRad = (minDiff * Math.PI) / 180;
    const projDist = R * Math.cos(deltaRad);
    const snappedPoint: Point2D = {
      x: basePoint.x + projDist * cosSnap,
      y: basePoint.y + projDist * sinSnap,
    };
    return {
      snappedPoint,
      rayStart: basePoint,
      rayEnd: {
        x: basePoint.x + 50000 * cosSnap,
        y: basePoint.y + 50000 * sinSnap,
      },
      angleDeg: bestAngle,
    };
  }
  return null;
}

// 尋找極軸射線與圖元延伸線之精確交點
export function findPolarExtensionIntersection(
  basePoint: Point2D,
  mouseWorld: Point2D,
  entities: CADEntity2D[],
  otrackAnchors: TrackAnchor[],
  stepAngleDeg: number,
  customAngles: number[],
  scale: number,
  thresholdPx: number = 30
): PolarExtensionIntersection | null {
  const targetAngles = getNormalizedPolarAngles(stepAngleDeg, customAngles);
  if (targetAngles.length === 0) return null;

  interface Segment { start: Point2D; end: Point2D; ux: number; uy: number; isInfinite: boolean; entityId: string; }
  const segments: Segment[] = [];

  // 1. 加入實體線段與多段線
  for (const entity of entities) {
    if (entity.visible === false) continue;
    if (entity.type === 'line') {
      const vx = entity.end.x - entity.start.x, vy = entity.end.y - entity.start.y;
      const len = Math.hypot(vx, vy);
      if (len > 1e-6) segments.push({ start: entity.start, end: entity.end, ux: vx/len, uy: vy/len, isInfinite: false, entityId: entity.id });
    } else if (entity.type === 'polyline' && entity.points && entity.points.length > 1) {
      for (let i = 0; i < entity.points.length - 1; i++) {
        const vx = entity.points[i+1].x - entity.points[i].x, vy = entity.points[i+1].y - entity.points[i].y;
        const len = Math.hypot(vx, vy);
        if (len > 1e-6) segments.push({ start: entity.points[i], end: entity.points[i+1], ux: vx/len, uy: vy/len, isInfinite: false, entityId: entity.id });
      }
      if (entity.closed) {
        const vx = entity.points[0].x - entity.points[entity.points.length - 1].x, vy = entity.points[0].y - entity.points[entity.points.length - 1].y;
        const len = Math.hypot(vx, vy);
        if (len > 1e-6) segments.push({ start: entity.points[entity.points.length - 1], end: entity.points[0], ux: vx/len, uy: vy/len, isInfinite: false, entityId: entity.id });
      }
    }
  }

  // 2. 加入 OTrack 十字追蹤線（視為無限延伸線）
  for (const anchor of otrackAnchors) {
    segments.push({ start: anchor.point, end: anchor.point, ux: 1, uy: 0, isInfinite: true, entityId: anchor.id });
    segments.push({ start: anchor.point, end: anchor.point, ux: 0, uy: 1, isInfinite: true, entityId: anchor.id });
  }

  const thresholdWorld = thresholdPx / scale;
  let bestResult: PolarExtensionIntersection | null = null;
  let minDistance = thresholdWorld;

  for (const seg of segments) {
    for (const angle of targetAngles) {
      const thetaRad = (angle * Math.PI) / 180;
      const cosTheta = Math.cos(thetaRad), sinTheta = Math.sin(thetaRad);
      const det = seg.ux * sinTheta - seg.uy * cosTheta;
      if (Math.abs(det) < 1e-4) continue; // 平行

      const wx = seg.start.x - basePoint.x, wy = seg.start.y - basePoint.y;
      const t = (wy * seg.ux - wx * seg.uy) / det;
      if (t < 1e-3) continue; // 必須在極軸射線正方向

      const P = { x: basePoint.x + t * cosTheta, y: basePoint.y + t * sinTheta };
      const distMouseToP = Math.hypot(mouseWorld.x - P.x, mouseWorld.y - P.y);

      if (distMouseToP < minDistance) {
        minDistance = distMouseToP;
        let extStart = seg.start;
        if (!seg.isInfinite) {
           const dA = Math.hypot(P.x - seg.start.x, P.y - seg.start.y);
           const dB = Math.hypot(P.x - seg.end.x, P.y - seg.end.y);
           extStart = dA < dB ? seg.start : seg.end;
        }
        bestResult = { point: P, polarAngleDeg: angle, entityId: seg.entityId, extensionRay: { start: extStart, end: P } };
      }
    }
  }
  return bestResult;
}
