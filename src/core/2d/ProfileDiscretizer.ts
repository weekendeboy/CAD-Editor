import { Point2D, ProfileSegment, SketchProfile } from '../../types/cad';

export interface DiscretizedProfile {
  outerLoop: Point2D[];
  innerLoops: Point2D[][];
}

/**
 * 將 ProfileSegment 序列（包含直線與圓弧）沿幾何走勢自適應採樣為高精度離散頂點環。
 * 完美還原圓弧曲線特徵，解決 3D 預覽因直線弦退化導致與 OpenCASCADE 生成實體不一致的幾何缺陷。
 *
 * @param segments 輪廓段邊界幾何
 * @param fallbackLoop 若 segments 不存在時的回退多邊形頂點
 * @param angularResolutionDeg 圓弧採樣角度解析度（預設約 6 度）
 */
export function discretizeProfileLoop(
  segments?: ProfileSegment[],
  fallbackLoop?: Point2D[],
  angularResolutionDeg: number = 6
): Point2D[] {
  if (!segments || segments.length === 0) {
    return fallbackLoop ? fallbackLoop.map((p) => ({ ...p })) : [];
  }

  const result: Point2D[] = [];
  const maxStepRad = (angularResolutionDeg * Math.PI) / 180;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (seg.type === 'line' || !seg.center || seg.radius === undefined || seg.radius <= 1e-6) {
      // 直線段：推入起點（終點由下一段起點或環閉合處理）
      result.push({ x: seg.start.x, y: seg.start.y });
    } else if (seg.type === 'arc') {
      const center = seg.center;
      const radius = seg.radius;
      // SVG sweep-flag 1 表示正向（角度增加），0 表示負向（角度減少）
      const sweepPos = seg.sweepFlag === 1;

      // 嚴格依據 seg.start 與 seg.end 計算起始與結束角，消弭浮點累積偏差
      const sa = Math.atan2(seg.start.y - center.y, seg.start.x - center.x);
      const ea = Math.atan2(seg.end.y - center.y, seg.end.x - center.x);

      let sweep = sweepPos ? (ea - sa) : (sa - ea);
      while (sweep < -1e-6) {
        sweep += 2 * Math.PI;
      }
      while (sweep >= 2 * Math.PI - 1e-6) {
        sweep -= 2 * Math.PI;
      }

      if (sweep < 1e-5) {
        if (seg.isLargeArc) {
          sweep = 2 * Math.PI;
        } else {
          result.push({ x: seg.start.x, y: seg.start.y });
          continue;
        }
      }

      // 自適應採樣：最少 8 段，最多 48 段
      const numSteps = Math.max(8, Math.min(48, Math.ceil(sweep / maxStepRad)));

      for (let step = 0; step < numSteps; step++) {
        const t = step / numSteps;
        const currentAngle = sweepPos ? (sa + t * sweep) : (sa - t * sweep);
        result.push({
          x: center.x + radius * Math.cos(currentAngle),
          y: center.y + radius * Math.sin(currentAngle),
        });
      }
    }
  }

  return result;
}

/**
 * 將整個 SketchProfile（外環與內孔）完整離散化為高密度幾何環
 */
export function discretizeSketchProfile(
  profile: SketchProfile,
  angularResolutionDeg: number = 6
): DiscretizedProfile {
  const outerLoop = discretizeProfileLoop(
    profile.segments,
    profile.outerLoop,
    angularResolutionDeg
  );

  const innerLoops: Point2D[][] = [];
  if (profile.innerSegments && profile.innerSegments.length > 0) {
    profile.innerSegments.forEach((innerSegs, idx) => {
      const fallback = profile.innerLoops ? profile.innerLoops[idx] : undefined;
      const holeLoop = discretizeProfileLoop(innerSegs, fallback, angularResolutionDeg);
      if (holeLoop.length >= 3) {
        innerLoops.push(holeLoop);
      }
    });
  } else if (profile.innerLoops && profile.innerLoops.length > 0) {
    profile.innerLoops.forEach((hole) => {
      if (hole.length >= 3) {
        innerLoops.push(hole.map((p) => ({ ...p })));
      }
    });
  }

  return {
    outerLoop,
    innerLoops,
  };
}
