/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ICurve2D, Point2D, Vector2D } from './ICurve2D';
import { bulgeToArc } from '../BulgeMath';

/**
 * 2D 參數化圓弧 / 圓 (Arc / Circle Segment)
 * 參數化方程式：
 * θ(t) = startAngle + t * sweepAngle, t ∈ [0, 1]
 * r(t) = (center.x + radius * cos(θ(t)), center.y + radius * sin(θ(t)))
 *
 * 註：sweepAngle > 0 為逆時針 (CCW)，sweepAngle < 0 為順時針 (CW)。
 */
export class ArcSegment2D implements ICurve2D {
  readonly type: 'arc' | 'circle';
  readonly center: Point2D;
  readonly radius: number;
  readonly startAngle: number; // 弧度 (Radians)
  readonly sweepAngle: number; // 掃掠角 (Radians, 包含正負旋轉方向)

  constructor(
    center: Point2D,
    radius: number,
    startAngle: number,
    sweepAngle: number,
    type: 'arc' | 'circle' = 'arc'
  ) {
    this.center = { x: center.x, y: center.y };
    this.radius = Math.abs(radius);
    this.startAngle = startAngle;
    this.sweepAngle = sweepAngle;
    this.type = type;
  }

  /** 取得掃掠終止角 (startAngle + sweepAngle) */
  get endAngle(): number {
    return this.startAngle + this.sweepAngle;
  }

  /** 判定是否為順時針旋轉 */
  get isClockwise(): boolean {
    return this.sweepAngle < 0;
  }

  /** 取得圓弧長度 (弧長 = |sweepAngle| * R) */
  length(): number {
    return Math.abs(this.sweepAngle) * this.radius;
  }

  /** 給定參數 t (0~1)，計算曲線上對應的座標點 */
  pointAt(t: number): Point2D {
    const theta = this.startAngle + t * this.sweepAngle;
    return {
      x: this.center.x + this.radius * Math.cos(theta),
      y: this.center.y + this.radius * Math.sin(theta),
    };
  }

  /** 給定參數 t (0~1)，計算沿著 t 增加方向前進的單位切線向量 */
  tangentAt(t: number): Vector2D {
    if (this.radius < 1e-12 || Math.abs(this.sweepAngle) < 1e-12) {
      return { x: 0, y: 0 };
    }
    const theta = this.startAngle + t * this.sweepAngle;
    const dir = this.sweepAngle >= 0 ? 1 : -1;
    // dr/dt = sweepAngle * R * (-sin(θ), cos(θ))
    // 單位切線 = sign(sweepAngle) * (-sin(θ), cos(θ))
    return {
      x: -dir * Math.sin(theta),
      y: dir * Math.cos(theta),
    };
  }

  /** 取得起點 (t=0) */
  getStartPoint(): Point2D {
    return this.pointAt(0);
  }

  /** 取得終點 (t=1) */
  getEndPoint(): Point2D {
    return this.pointAt(1);
  }

  /** 取得中點 (t=0.5) */
  getMidPoint(): Point2D {
    return this.pointAt(0.5);
  }

  /**
   * 判斷目標角度 theta 是否落在本弧的掃掠範圍內
   */
  isAngleOnArc(theta: number, tolerance: number = 1e-5): boolean {
    const sweepMag = Math.abs(this.sweepAngle);
    if (sweepMag >= 2 * Math.PI - tolerance) {
      return true;
    }

    if (this.sweepAngle >= 0) {
      // CCW
      let diff = theta - this.startAngle;
      while (diff < 0) diff += 2 * Math.PI;
      while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;
      return diff <= sweepMag + tolerance || (2 * Math.PI - diff) <= tolerance;
    } else {
      // CW
      let diff = this.startAngle - theta;
      while (diff < 0) diff += 2 * Math.PI;
      while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;
      return diff <= sweepMag + tolerance || (2 * Math.PI - diff) <= tolerance;
    }
  }

  /**
   * 計算本弧的精確外接矩形 (Bounding Box)
   */
  getBoundingBox(): { minX: number; maxX: number; minY: number; maxY: number } {
    const pStart = this.getStartPoint();
    const pEnd = this.getEndPoint();
    let minX = Math.min(pStart.x, pEnd.x);
    let maxX = Math.max(pStart.x, pEnd.x);
    let minY = Math.min(pStart.y, pEnd.y);
    let maxY = Math.max(pStart.y, pEnd.y);

    const testAngles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
    for (const angle of testAngles) {
      if (this.isAngleOnArc(angle)) {
        const px = this.center.x + this.radius * Math.cos(angle);
        const py = this.center.y + this.radius * Math.sin(angle);
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
      }
    }
    return { minX, maxX, minY, maxY };
  }

  /**
   * 由兩頂點與 Bulge 凸度值建立 ArcSegment2D
   * @param p1 起點
   * @param p2 終點
   * @param bulge 凸度值 b = tan(θ/4)
   * @param tolerance 幾何容差
   */
  static fromBulge(
    p1: Point2D,
    p2: Point2D,
    bulge: number,
    tolerance: number = 1e-8
  ): ArcSegment2D | null {
    const arcDef = bulgeToArc(p1, p2, bulge, tolerance);
    if (!arcDef) {
      return null;
    }
    const sweep = arcDef.isClockwise ? -arcDef.sweepAngle : arcDef.sweepAngle;
    return new ArcSegment2D(arcDef.center, arcDef.radius, arcDef.startAngle, sweep, 'arc');
  }

  /**
   * 由圓心、半徑與起訖角建立 ArcSegment2D (依據明確的 isClockwise 旗標，絕不猜測方向)
   */
  static fromCenterAngles(
    center: Point2D,
    radius: number,
    startAngle: number,
    endAngle: number,
    isClockwise: boolean = false
  ): ArcSegment2D {
    if (Math.abs(endAngle - startAngle) >= 2 * Math.PI - 1e-7) {
      return new ArcSegment2D(
        center,
        radius,
        startAngle,
        isClockwise ? -2 * Math.PI : 2 * Math.PI,
        'arc'
      );
    }

    if (!isClockwise) {
      // CCW 掃掠
      let sweep = endAngle - startAngle;
      while (sweep < 0) sweep += 2 * Math.PI;
      while (sweep >= 2 * Math.PI) sweep -= 2 * Math.PI;
      if (sweep <= 1e-9) sweep = 2 * Math.PI;
      return new ArcSegment2D(center, radius, startAngle, sweep, 'arc');
    } else {
      // CW 掃掠
      let sweep = startAngle - endAngle;
      while (sweep < 0) sweep += 2 * Math.PI;
      while (sweep >= 2 * Math.PI) sweep -= 2 * Math.PI;
      if (sweep <= 1e-9) sweep = 2 * Math.PI;
      return new ArcSegment2D(center, radius, startAngle, -sweep, 'arc');
    }
  }

  /**
   * 從 ArcEntity 物件直接建構規範化 ArcSegment2D
   */
  static fromArcEntity(arc: {
    center: Point2D;
    radius: number;
    startAngle: number;
    endAngle: number;
    clockwise?: boolean;
  }): ArcSegment2D {
    return ArcSegment2D.fromCenterAngles(
      arc.center,
      arc.radius,
      arc.startAngle,
      arc.endAngle,
      Boolean(arc.clockwise)
    );
  }
}
