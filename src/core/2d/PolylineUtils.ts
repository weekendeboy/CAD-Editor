import {
  Point2D,
  PolylineEntity,
  LineEntity,
  ArcEntity,
  ProfileSegment,
} from '../../types/cad';
import { bulgeToArc, bulgeToArcEntity } from './BulgeMath';

/**
 * 將多段線 (PolylineEntity) 精確拆解為輪廓線段陣列 (ProfileSegment[])。
 * - 若頂點數少於 2，回傳空陣列 []。
 * - 若段凸度 (bulge) 為 0 或未定義，產生 type='line' 的 ProfileSegment。
 * - 若段凸度非 0，透過 bulgeToArc 計算圓弧參數，生成 type='arc' 的 ProfileSegment
 *   （包含 start, end, center, radius, startAngle, endAngle, isLargeArc, sweepFlag）。
 *
 * @param polyline 多段線實體
 * @returns 輪廓線段陣列 ProfileSegment[]
 */
export function polylineEntityToSegments(polyline: PolylineEntity): ProfileSegment[] {
  if (!polyline || !polyline.points || polyline.points.length < 2) {
    return [];
  }

  const pts = polyline.points;
  const numSegments = polyline.closed ? pts.length : pts.length - 1;
  const segments: ProfileSegment[] = [];

  for (let i = 0; i < numSegments; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    const bulge = polyline.bulges?.[i] ?? 0;

    if (Math.abs(bulge) < 1e-8) {
      segments.push({
        type: 'line',
        start: { x: p1.x, y: p1.y },
        end: { x: p2.x, y: p2.y },
      });
    } else {
      const arcDef = bulgeToArc(p1, p2, bulge);
      if (!arcDef) {
        segments.push({
          type: 'line',
          start: { x: p1.x, y: p1.y },
          end: { x: p2.x, y: p2.y },
        });
      } else {
        const isLargeArc = Math.abs(bulge) > 1;
        const sweepFlag = bulge > 0 ? 0 : 1;

        segments.push({
          type: 'arc',
          start: { x: p1.x, y: p1.y },
          end: { x: p2.x, y: p2.y },
          center: arcDef.center,
          radius: arcDef.radius,
          startAngle: arcDef.startAngle,
          endAngle: arcDef.endAngle,
          isLargeArc,
          sweepFlag,
        });
      }
    }
  }

  return segments;
}

/**
 * 將帶凸度的多段線 (PolylineEntity) 打散為獨立的 LineEntity 與 ArcEntity 陣列。
 * - 繼承原多段線的 layerId, visible, locked, color, lineWidth, isConstruction, state 等屬性。
 * - 若頂點數少於 2，回傳空陣列 []。
 *
 * @param polyline 多段線實體
 * @returns 打散後的 (LineEntity | ArcEntity)[] 陣列
 */
export function decomposePolylineToEntities(
  polyline: PolylineEntity
): (LineEntity | ArcEntity)[] {
  if (!polyline || !polyline.points || polyline.points.length < 2) {
    return [];
  }

  const pts = polyline.points;
  const numSegments = polyline.closed ? pts.length : pts.length - 1;
  const entities: (LineEntity | ArcEntity)[] = [];

  for (let i = 0; i < numSegments; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    const bulge = polyline.bulges?.[i] ?? 0;
    const segId = `${polyline.id}-seg-${i}`;

    const commonProps = {
      layerId: polyline.layerId,
      visible: polyline.visible,
      locked: polyline.locked,
      color: polyline.color,
      lineWidth: polyline.lineWidth,
      isConstruction: polyline.isConstruction,
      state: polyline.state,
    };

    if (Math.abs(bulge) < 1e-8) {
      const lineEntity: LineEntity = {
        id: segId,
        type: 'line',
        ...commonProps,
        start: { x: p1.x, y: p1.y },
        end: { x: p2.x, y: p2.y },
      };
      entities.push(lineEntity);
    } else {
      const arcEntity = bulgeToArcEntity(p1, p2, bulge, {
        id: segId,
        ...commonProps,
      });

      if (arcEntity) {
        entities.push(arcEntity);
      } else {
        // 若幾何退化，降級為直線 Entity
        const lineEntity: LineEntity = {
          id: segId,
          type: 'line',
          ...commonProps,
          start: { x: p1.x, y: p1.y },
          end: { x: p2.x, y: p2.y },
        };
        entities.push(lineEntity);
      }
    }
  }

  return entities;
}

/**
 * 根據 PolylineEntity 產出 SVG <path d="..." /> 繪圖指令字串。
 * - 直線使用 'L x y' 指令。
 * - 圓弧段使用 SVG 原生 'A rx ry 0 largeArcFlag sweepFlag x y' 指令。
 * - 若 polyline.closed === true，於尾端加上 'Z'。
 * - 若頂點數少於 2，回傳空字串 ""。
 *
 * @param polyline 待繪製的多段線實體
 * @param worldToScreen 世界座標轉換為螢幕座標之函數
 * @param scale 世界對螢幕之縮放比例
 * @returns SVG path 的 d 屬性字串
 */
export function getPolylineSvgPathData(
  polyline: PolylineEntity,
  worldToScreen: (p: Point2D) => Point2D,
  scale: number
): string {
  if (!polyline || !polyline.points || polyline.points.length < 2) {
    return '';
  }

  const pts = polyline.points;
  const startPtScreen = worldToScreen(pts[0]);
  let pathData = `M ${startPtScreen.x} ${startPtScreen.y}`;

  const numSegments = polyline.closed ? pts.length : pts.length - 1;

  for (let i = 0; i < numSegments; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    const bulge = polyline.bulges?.[i] ?? 0;
    const endPtScreen = worldToScreen(p2);

    if (Math.abs(bulge) < 1e-8) {
      pathData += ` L ${endPtScreen.x} ${endPtScreen.y}`;
    } else {
      const arcDef = bulgeToArc(p1, p2, bulge);
      if (!arcDef) {
        pathData += ` L ${endPtScreen.x} ${endPtScreen.y}`;
      } else {
        const screenRadius = arcDef.radius * scale;
        const largeArcFlag = Math.abs(bulge) > 1 ? 1 : 0;
        const sweepFlag = bulge > 0 ? 0 : 1;

        pathData += ` A ${screenRadius} ${screenRadius} 0 ${largeArcFlag} ${sweepFlag} ${endPtScreen.x} ${endPtScreen.y}`;
      }
    }
  }

  if (polyline.closed) {
    pathData += ' Z';
  }

  return pathData;
}

/**
 * 計算 PolylineEntity 的總長度（包含直線段與凸度圓弧段長度）。
 *
 * @param polyline 多段線實體
 * @returns 幾何總長度
 */
export function getPolylineLength(polyline: PolylineEntity): number {
  if (!polyline || !polyline.points || polyline.points.length < 2) {
    return 0;
  }

  const pts = polyline.points;
  const numSegments = polyline.closed ? pts.length : pts.length - 1;
  let totalLength = 0;

  for (let i = 0; i < numSegments; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    const bulge = polyline.bulges?.[i] ?? 0;

    const chordLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (Math.abs(bulge) < 1e-8) {
      totalLength += chordLen;
    } else {
      const arcDef = bulgeToArc(p1, p2, bulge);
      if (arcDef) {
        totalLength += arcDef.radius * arcDef.sweepAngle;
      } else {
        totalLength += chordLen;
      }
    }
  }

  return totalLength;
}
