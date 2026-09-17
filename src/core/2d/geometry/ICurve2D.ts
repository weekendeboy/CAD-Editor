/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Point2D {
  x: number;
  y: number;
}

export interface Vector2D {
  x: number;
  y: number;
}

/**
 * 統一 2D 參數化幾何曲線介面 (Parametric Curve 2D)
 * 參數 t 範圍為 [0, 1]：
 * - t = 0 對應曲線起點
 * - t = 1 對應曲線終點
 */
export interface ICurve2D {
  readonly type: 'line' | 'arc' | 'circle';

  /** 取得曲線總長度 (Arc Length) */
  length(): number;

  /** 給定參數 t (0 ~ 1)，計算曲線上對應的座標點 */
  pointAt(t: number): Point2D;

  /** 給定參數 t (0 ~ 1)，計算曲線在該點的單位切線向量 (沿著 t 增加的方向) */
  tangentAt(t: number): Vector2D;

  /** 取得起點 (t = 0) */
  getStartPoint(): Point2D;

  /** 取得終點 (t = 1) */
  getEndPoint(): Point2D;
}
