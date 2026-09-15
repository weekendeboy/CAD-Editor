import { Point2D, BoundingBox2D, CADEntity2D } from '../../types/cad';

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

/**
 * 計算給定 2D 圖元集合的最小包圍盒 (Bounding Box)
 */
export function computeEntitiesBoundingBox(entities: CADEntity2D[]): BoundingBox2D {
  if (!entities || entities.length === 0) {
    return { min: { x: -100, y: -100 }, max: { x: 100, y: 100 } };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const updateMinMax = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  for (const entity of entities) {
    if (entity.type === 'line') {
      updateMinMax(entity.start.x, entity.start.y);
      updateMinMax(entity.end.x, entity.end.y);
    } else if (entity.type === 'circle') {
      updateMinMax(entity.center.x - entity.radius, entity.center.y - entity.radius);
      updateMinMax(entity.center.x + entity.radius, entity.center.y + entity.radius);
    } else if (entity.type === 'arc') {
      updateMinMax(entity.center.x - entity.radius, entity.center.y - entity.radius);
      updateMinMax(entity.center.x + entity.radius, entity.center.y + entity.radius);
    } else if (entity.type === 'polyline') {
      for (const pt of entity.points) {
        updateMinMax(pt.x, pt.y);
      }
    } else if (entity.type === 'insert') {
      updateMinMax(entity.position.x, entity.position.y);
    }
  }

  if (minX === Infinity || minY === Infinity || maxX === -Infinity || maxY === -Infinity) {
    return { min: { x: -100, y: -100 }, max: { x: 100, y: 100 } };
  }

  // 若尺寸過小或為單點，提供最小邊界確保縮放舒適
  if (maxX - minX < 10) {
    const midX = (minX + maxX) / 2;
    minX = midX - 25;
    maxX = midX + 25;
  }
  if (maxY - minY < 10) {
    const midY = (minY + maxY) / 2;
    minY = midY - 25;
    maxY = midY + 25;
  }

  return {
    min: { x: minX, y: minY },
    max: { x: maxX, y: maxY },
  };
}
