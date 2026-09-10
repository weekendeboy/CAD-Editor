import { Point2D, BoundingBox2D } from '../../types/cad';

export class ViewportTransform {
  public pan: Point2D;
  public scale: number;

  constructor(pan: Point2D = { x: 0, y: 0 }, scale: number = 1.0) {
    this.pan = pan;
    this.scale = scale;
  }

  /**
   * 將世界座標轉換為螢幕座標
   * CAD 座標系 Y 軸朝上，螢幕/SVG 座標系 Y 軸朝下
   */
  public worldToScreen(worldPt: Point2D): Point2D {
    return {
      x: this.pan.x + worldPt.x * this.scale,
      y: this.pan.y - worldPt.y * this.scale,
    };
  }

  /**
   * 將螢幕座標轉換為世界座標
   * CAD 座標系 Y 軸朝上，螢幕/SVG 座標系 Y 軸朝下
   */
  public screenToWorld(screenPt: Point2D): Point2D {
    return {
      x: (screenPt.x - this.pan.x) / this.scale,
      y: (this.pan.y - screenPt.y) / this.scale,
    };
  }

  /**
   * 以指定游標為中心的縮放計算
   */
  public static calculateZoomPan(
    mousePos: Point2D,
    currentPan: Point2D,
    oldScale: number,
    newScale: number
  ): Point2D {
    const worldX = (mousePos.x - currentPan.x) / oldScale;
    const worldY = (currentPan.y - mousePos.y) / oldScale;

    return {
      x: mousePos.x - worldX * newScale,
      y: mousePos.y + worldY * newScale,
    };
  }

  /**
   * 包覆包圍盒自動置中縮放 (Zoom to Extents)
   */
  public static getZoomExtents(
    bbox: BoundingBox2D,
    viewWidth: number,
    viewHeight: number,
    padding: number = 0
  ): { pan: Point2D; scale: number } {
    const minX = bbox.min.x;
    const minY = bbox.min.y;
    const maxX = bbox.max.x;
    const maxY = bbox.max.y;

    const width = maxX - minX;
    const height = maxY - minY;

    if (width <= 0 || height <= 0 || viewWidth <= padding * 2 || viewHeight <= padding * 2) {
      return { pan: { x: viewWidth / 2, y: viewHeight / 2 }, scale: 1 };
    }

    const availWidth = viewWidth - padding * 2;
    const availHeight = viewHeight - padding * 2;

    const scaleX = availWidth / width;
    const scaleY = availHeight / height;
    const scale = Math.min(scaleX, scaleY);

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const pan = {
      x: viewWidth / 2 - centerX * scale,
      y: viewHeight / 2 + centerY * scale,
    };

    return { pan, scale };
  }
}
