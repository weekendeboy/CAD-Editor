/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ICurve2D, Point2D, Vector2D } from './ICurve2D';

/**
 * 2D 參數化直線段 (Line Segment)
 * 參數化方程式：r(t) = (1 - t) * start + t * end, t ∈ [0, 1]
 */
export class LineSegment2D implements ICurve2D {
  readonly type = 'line' as const;
  readonly start: Point2D;
  readonly end: Point2D;

  constructor(start: Point2D, end: Point2D) {
    this.start = { x: start.x, y: start.y };
    this.end = { x: end.x, y: end.y };
  }

  /** 取得線段長度 */
  length(): number {
    return Math.hypot(this.end.x - this.start.x, this.end.y - this.start.y);
  }

  /** 給定參數 t (0~1)，計算曲線上對應的座標點 */
  pointAt(t: number): Point2D {
    return {
      x: this.start.x + t * (this.end.x - this.start.x),
      y: this.start.y + t * (this.end.y - this.start.y),
    };
  }

  /** 給定參數 t (0~1)，計算線段上的單位切線向量 (指向 end) */
  tangentAt(_t: number): Vector2D {
    const dx = this.end.x - this.start.x;
    const dy = this.end.y - this.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) {
      return { x: 0, y: 0 };
    }
    return {
      x: dx / len,
      y: dy / len,
    };
  }

  /** 取得起點 (t=0) */
  getStartPoint(): Point2D {
    return { x: this.start.x, y: this.start.y };
  }

  /** 取得終點 (t=1) */
  getEndPoint(): Point2D {
    return { x: this.end.x, y: this.end.y };
  }
}
