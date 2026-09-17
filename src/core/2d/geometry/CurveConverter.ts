/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CADEntity2D } from '../../../types/cad';
import { ICurve2D } from './ICurve2D';
import { LineSegment2D } from './LineSegment2D';
import { ArcSegment2D } from './ArcSegment2D';
import { bulgeToArc } from '../BulgeMath';

/**
 * 將 CADEntity2D 轉換為標準的參數化幾何曲線清單 (ICurve2D[])
 * @param entity 圖元 (Line, Arc, Circle, Polyline 等)
 * @returns 參數化曲線陣列
 */
export function convertEntityToCurves(entity: CADEntity2D): ICurve2D[] {
  if (!entity) {
    return [];
  }

  switch (entity.type) {
    case 'line': {
      return [new LineSegment2D(entity.start, entity.end)];
    }

    case 'arc': {
      let sweep = entity.endAngle - entity.startAngle;
      while (sweep <= 0) {
        sweep += 2 * Math.PI;
      }
      return [new ArcSegment2D(entity.center, entity.radius, entity.startAngle, sweep, 'arc')];
    }

    case 'circle': {
      return [new ArcSegment2D(entity.center, entity.radius, 0, 2 * Math.PI, 'circle')];
    }

    case 'polyline': {
      const curves: ICurve2D[] = [];
      const points = entity.points;
      if (!points || points.length < 2) {
        return [];
      }

      const segmentCount = entity.closed ? points.length : points.length - 1;
      for (let i = 0; i < segmentCount; i++) {
        const p1 = points[i];
        const p2 = entity.closed && i === points.length - 1 ? points[0] : points[i + 1];
        const bulge = entity.bulges?.[i] ?? 0;

        if (Math.abs(bulge) < 1e-8) {
          curves.push(new LineSegment2D(p1, p2));
        } else {
          const arcDef = bulgeToArc(p1, p2, bulge);
          if (arcDef) {
            const sweep = arcDef.isClockwise ? -arcDef.sweepAngle : arcDef.sweepAngle;
            curves.push(new ArcSegment2D(arcDef.center, arcDef.radius, arcDef.startAngle, sweep, 'arc'));
          } else {
            // 退化情況下回退為直線段
            curves.push(new LineSegment2D(p1, p2));
          }
        }
      }

      return curves;
    }

    case 'insert':
    default:
      return [];
  }
}

/**
 * 將多個 CADEntity2D 批次轉換為平面曲線清單
 * @param entities CADEntity2D 陣列
 */
export function convertEntitiesToCurves(entities: CADEntity2D[]): ICurve2D[] {
  const result: ICurve2D[] = [];
  for (const entity of entities) {
    const curves = convertEntityToCurves(entity);
    for (const c of curves) {
      result.push(c);
    }
  }
  return result;
}
