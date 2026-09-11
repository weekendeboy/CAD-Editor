import { Point2D, LineEntity, CircleEntity, ArcEntity, Dimension } from '../../types/cad';

/**
 * 旋轉點：將指定的點圍繞旋轉中心旋轉指定的弧度。
 *
 * @param pt 待旋轉的點
 * @param center 旋轉中心
 * @param angle 旋轉角度 (弧度)
 */
function rotatePoint(pt: Point2D, center: Point2D, angle: number): Point2D {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = pt.x - center.x;
  const dy = pt.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/**
 * 標準化文字方向角度：
 * 確保標註文字的旋轉角度始終介於 [-Math.PI/2, Math.PI/2] 之間，
 * 使得文字永遠維持由左至右或由下至上的方向，便於工程圖紙閱讀。
 *
 * @param angle 原始角度 (弧度)
 */
function normalizeTextAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  if (a > Math.PI / 2) {
    a -= Math.PI;
  } else if (a < -Math.PI / 2) {
    a += Math.PI;
  }
  return a;
}

export interface Arrowhead {
  tip: Point2D;
  wing1: Point2D;
  wing2: Point2D;
}

export interface ExtensionLine {
  start: Point2D;
  end: Point2D;
}

export interface LinearDimensionLayout {
  extension1: ExtensionLine;
  extension2: ExtensionLine;
  dimensionLine: { start: Point2D; end: Point2D };
  textCenter: Point2D;
  textCenterDefault: Point2D;
  textRotation: number;
  arrow1: Arrowhead;
  arrow2: Arrowhead;
  value: number;
  hasDogLeg?: boolean;
  leaderPoints?: Point2D[];
  landingLine?: { start: Point2D; end: Point2D } | null;
}

export interface RadialDimensionLayout {
  leaderPoints: Point2D[];
  arrow1: Arrowhead;
  arrow2: Arrowhead | null;
  landingLine: { start: Point2D; end: Point2D } | null;
  textCenter: Point2D;
  textRotation: number;
  value: number;
}

/**
 * 計算線性尺寸標註（對齊或水平/垂直）的幾何佈局。
 * 所有運算均為無副作用的純函數。
 *
 * @param p1 標註起點
 * @param p2 標註終點
 * @param textPos 標註文字放置的世界座標位置
 * @param isAligned 是否為對齊標註 (true = 對齊標註, false = 水平/垂直標註)
 * @param arrowLength 箭頭長度（預設為 7.0）
 * @param arrowAngle 箭頭夾角弧度（預設為 30 度 = Math.PI / 6）
 * @param gap 尺寸引導線與標註點的間距（預設為 3.0）
 * @param extend 尺寸引導線超出標註主線的長度（預設為 4.0）
 * @param landingLength 折角引線水平段長度（預設為 10.0）
 */
export function determineLinearDimType(p1: Point2D, p2: Point2D, cursor: Point2D): 'horizontal' | 'vertical' | 'aligned' {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-10) return 'aligned';
  
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  const vX = cursor.x - midX;
  const vY = cursor.y - midY;
  
  const dirX = dx / len;
  const dirY = dy / len;
  const perpX = -dirY;
  const perpY = dirX;
  
  const dotPerp = Math.abs(vX * perpX + vY * perpY);
  const dotDir = Math.abs(vX * dirX + vY * dirY);

  const isAligned = dotPerp > dotDir * 2.5;
  if (isAligned) return 'aligned';
  
  if (Math.abs(vY) > Math.abs(vX)) {
    return 'horizontal';
  } else {
    return 'vertical';
  }
}

export function calculateLinearDimensionLayout(
  p1: Point2D,
  p2: Point2D,
  textPos: Point2D,
  isAligned: boolean | 'aligned' | 'horizontal' | 'vertical',
  arrowLength: number = 7.0,
  arrowAngle: number = Math.PI / 6,
  gap: number = 3.0,
  extend: number = 4.0,
  landingLength: number = 10.0
): LinearDimensionLayout {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  
  let proj1: Point2D;
  let proj2: Point2D;
  let normalUnit: Point2D;
  let value: number;
  let textCenterDefault: Point2D;
  let textCenter: Point2D;
  let textRotation: number;
  let hasDogLeg = false;
  let leaderPoints: Point2D[] | undefined = undefined;
  let landingLine: { start: Point2D; end: Point2D } | null = null;

  const mode = isAligned === true ? 'aligned' 
             : isAligned === false ? 'auto' 
             : isAligned;

  if (mode === 'aligned') {
    // 1. 對齊標註 (Aligned Dimension)
    const length = Math.hypot(dx, dy);
    const dir = length > 1e-6 ? { x: dx / length, y: dy / length } : { x: 1, y: 0 };
    const perp = { x: -dir.y, y: dir.x };
    
    // 計算 textPos 到 p1-p2 直線的投射與偏置
    const v = { x: textPos.x - p1.x, y: textPos.y - p1.y };
    const t = v.x * dir.x + v.y * dir.y;
    const signedDist = v.x * perp.x + v.y * perp.y;
    const distToText = Math.abs(signedDist);
    
    if (distToText > 1e-6) {
      normalUnit = { x: perp.x * Math.sign(signedDist), y: perp.y * Math.sign(signedDist) };
    } else {
      normalUnit = perp;
    }
    
    proj1 = { x: p1.x + normalUnit.x * distToText, y: p1.y + normalUnit.y * distToText };
    proj2 = { x: p2.x + normalUnit.x * distToText, y: p2.y + normalUnit.y * distToText };
    value = length;
    textCenterDefault = { x: (proj1.x + proj2.x) / 2, y: (proj1.y + proj2.y) / 2 };

    // 判定是否需要折角引線 (Dog-leg leader)
    // 當文字偏離在兩端延伸線之外 (t < -4 或 t > length + 4)
    if (t < -4 || t > length + 4) {
      hasDogLeg = true;
      const anchor = t < -4 ? proj1 : proj2;
      const landingDir = (textPos.x - anchor.x) >= 0 ? 1 : -1;
      const landingEnd = { x: textPos.x + landingDir * landingLength, y: textPos.y };
      leaderPoints = [anchor, textPos];
      landingLine = { start: textPos, end: landingEnd };
      textCenter = {
        x: textPos.x + landingDir * (landingLength / 2),
        y: textPos.y + (landingDir >= 0 ? 0 : 0)
      };
      textRotation = 0.0;
    } else {
      textCenter = textPos;
      textRotation = normalizeTextAngle(Math.atan2(dir.y, dir.x));
    }
  } else {
    // 2. 非對齊標註（水平或垂直標註）
    let isHorizontal = false;
    if (mode === 'horizontal') {
      isHorizontal = true;
    } else if (mode === 'vertical') {
      isHorizontal = false;
    } else {
      const pm = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      isHorizontal = Math.abs(textPos.y - pm.y) >= Math.abs(textPos.x - pm.x);
    }

    if (isHorizontal) {
      // 水平標註 (Horizontal Dimension) - 尺寸主線為水平線
      const dyText = textPos.y - p1.y;
      normalUnit = { x: 0, y: dyText >= 0 ? 1 : -1 };
      
      proj1 = { x: p1.x, y: textPos.y };
      proj2 = { x: p2.x, y: textPos.y };
      value = Math.abs(dx);
      textCenterDefault = { x: (p1.x + p2.x) / 2, y: textPos.y };

      const minX = Math.min(p1.x, p2.x);
      const maxX = Math.max(p1.x, p2.x);

      // 判定是否超出水平範圍
      if (textPos.x < minX - 4) {
        hasDogLeg = true;
        const anchor = { x: minX, y: textPos.y };
        const landingEnd = { x: textPos.x - landingLength, y: textPos.y };
        leaderPoints = [anchor, textPos];
        landingLine = { start: textPos, end: landingEnd };
        textCenter = {
          x: textPos.x - landingLength / 2,
          y: textPos.y
        };
        textRotation = 0.0;
      } else if (textPos.x > maxX + 4) {
        hasDogLeg = true;
        const anchor = { x: maxX, y: textPos.y };
        const landingEnd = { x: textPos.x + landingLength, y: textPos.y };
        leaderPoints = [anchor, textPos];
        landingLine = { start: textPos, end: landingEnd };
        textCenter = {
          x: textPos.x + landingLength / 2,
          y: textPos.y
        };
        textRotation = 0.0;
      } else {
        textCenter = textPos;
        textRotation = 0.0;
      }
    } else {
      // 垂直標註 (Vertical Dimension) - 尺寸主線為垂直線
      const dxText = textPos.x - p1.x;
      normalUnit = { x: dxText >= 0 ? 1 : -1, y: 0 };
      
      proj1 = { x: textPos.x, y: p1.y };
      proj2 = { x: textPos.x, y: p2.y };
      value = Math.abs(dy);
      textCenterDefault = { x: textPos.x, y: (p1.y + p2.y) / 2 };

      const minY = Math.min(p1.y, p2.y);
      const maxY = Math.max(p1.y, p2.y);

      // 判定是否超出垂直範圍
      if (textPos.y < minY - 4 || textPos.y > maxY + 4) {
        hasDogLeg = true;
        const anchor = { x: textPos.x, y: textPos.y < minY - 4 ? minY : maxY };
        const landingDir = (textPos.x - anchor.x) >= 0 ? 1 : -1;
        const landingEnd = { x: textPos.x + landingDir * landingLength, y: textPos.y };
        leaderPoints = [anchor, textPos];
        landingLine = { start: textPos, end: landingEnd };
        textCenter = {
          x: textPos.x + landingDir * (landingLength / 2),
          y: textPos.y
        };
        textRotation = 0.0;
      } else {
        textCenter = textPos;
        textRotation = normalizeTextAngle(Math.PI / 2);
      }
    }
  }

  // 3. 計算引導線 (Extension Lines) 起終點
  const extension1: ExtensionLine = {
    start: { x: p1.x + normalUnit.x * gap, y: p1.y + normalUnit.y * gap },
    end: { x: proj1.x + normalUnit.x * extend, y: proj1.y + normalUnit.y * extend }
  };

  const extension2: ExtensionLine = {
    start: { x: p2.x + normalUnit.x * gap, y: p2.y + normalUnit.y * gap },
    end: { x: proj2.x + normalUnit.x * extend, y: proj2.y + normalUnit.y * extend }
  };

  // 4. 尺寸主線端點與箭頭計算
  const dDim = { x: proj2.x - proj1.x, y: proj2.y - proj1.y };
  const lenDim = Math.hypot(dDim.x, dDim.y);
  const dirDim = lenDim > 1e-6 ? { x: dDim.x / lenDim, y: dDim.y / lenDim } : { x: 1, y: 0 };

  // 箭頭 1 (朝向 proj1)
  const base1 = { x: proj1.x + dirDim.x * arrowLength, y: proj1.y + dirDim.y * arrowLength };
  const arrow1: Arrowhead = {
    tip: proj1,
    wing1: rotatePoint(base1, proj1, arrowAngle),
    wing2: rotatePoint(base1, proj1, -arrowAngle)
  };

  // 箭頭 2 (朝向 proj2)
  const base2 = { x: proj2.x - dirDim.x * arrowLength, y: proj2.y - dirDim.y * arrowLength };
  const arrow2: Arrowhead = {
    tip: proj2,
    wing1: rotatePoint(base2, proj2, arrowAngle),
    wing2: rotatePoint(base2, proj2, -arrowAngle)
  };

  return {
    extension1,
    extension2,
    dimensionLine: { start: proj1, end: proj2 },
    textCenter,
    textCenterDefault,
    textRotation,
    arrow1,
    arrow2,
    value,
    hasDogLeg,
    leaderPoints,
    landingLine
  };
}

/**
 * 計算徑向尺寸標註（直徑或半徑）的幾何佈局。
 * 所有運算均為無副作用的純函數。
 *
 * @param center 圓/弧的心
 * @param radius 圓/弧的半徑
 * @param textPos 標註文字放置的世界座標位置
 * @param isDiameter 是否標註直徑 (true = 直徑標註, false = 半徑標註)
 * @param arrowLength 箭頭長度（預設為 6.0）
 * @param arrowAngle 箭頭夾角弧度（預設為 30 度 = Math.PI / 6）
 * @param landingLength 標註文字外的水平折線長度（預設為 8.0）
 */
export function calculateRadialDimensionLayout(
  center: Point2D,
  radius: number,
  textPos: Point2D,
  isDiameter: boolean,
  arrowLength: number = 6.0,
  arrowAngle: number = Math.PI / 6,
  landingLength: number = 8.0
): RadialDimensionLayout {
  const dx = textPos.x - center.x;
  const dy = textPos.y - center.y;
  const dist = Math.hypot(dx, dy);
  
  // 計算指向文字方向的單位向量
  const dir = dist > 1e-6 ? { x: dx / dist, y: dy / dist } : { x: 1, y: 0 };

  // 圓/弧邊界上位於 textPos 同向的點 (pFar) 與反向的點 (pNear)
  const pFar = { x: center.x + dir.x * radius, y: center.y + dir.y * radius };
  const pNear = { x: center.x - dir.x * radius, y: center.y - dir.y * radius };

  // 1. 箭頭計算
  // 箭頭 1 (朝向 pFar)
  const base1 = { x: pFar.x - dir.x * arrowLength, y: pFar.y - dir.y * arrowLength };
  const arrow1: Arrowhead = {
    tip: pFar,
    wing1: rotatePoint(base1, pFar, arrowAngle),
    wing2: rotatePoint(base1, pFar, -arrowAngle)
  };

  // 箭頭 2 (朝向 pNear，僅在直徑標註時存在)
  let arrow2: Arrowhead | null = null;
  if (isDiameter) {
    const base2 = { x: pNear.x + dir.x * arrowLength, y: pNear.y + dir.y * arrowLength };
    arrow2 = {
      tip: pNear,
      wing1: rotatePoint(base2, pNear, arrowAngle),
      wing2: rotatePoint(base2, pNear, -arrowAngle)
    };
  }

  // 2. 引線頂點 (Leader Line Points)
  // 若 textPos 位於圓外，引線應從圓邊界 (pFar) 延伸至 textPos。
  // 半徑標註引線預設起點為 center；直徑標註引線預設起點為 pNear。
  const leaderPoints: Point2D[] = [];
  if (isDiameter) {
    if (dist > radius) {
      leaderPoints.push(pNear, pFar, textPos);
    } else {
      leaderPoints.push(pNear, pFar);
    }
  } else {
    if (dist > radius) {
      leaderPoints.push(center, pFar, textPos);
    } else {
      leaderPoints.push(center, pFar);
    }
  }

  // 3. 水平折線引線 (Landing Dogleg Line)
  // 當 textPos 位於圓外部時，為讓標註文字水平對齊，新增一小段水平延伸折線。
  let landingLine: { start: Point2D; end: Point2D } | null = null;
  let textCenter: Point2D;
  let textRotation: number;

  if (dist > radius) {
    const landingDir = dir.x >= 0 ? 1 : -1;
    const landingEnd = { x: textPos.x + landingDir * landingLength, y: textPos.y };
    landingLine = { start: textPos, end: landingEnd };
    
    // 文字水平放置，中心點位於折線上部微偏處
    textCenter = {
      x: textPos.x + landingDir * (landingLength / 2),
      y: textPos.y + 2.0 // 微調向上偏移以避免壓線
    };
    textRotation = 0.0;
  } else {
    // 位於內部時，文字傾斜角度與引線方向相同
    textCenter = textPos;
    textRotation = normalizeTextAngle(Math.atan2(dir.y, dir.x));
  }

  return {
    leaderPoints,
    arrow1,
    arrow2,
    landingLine,
    textCenter,
    textRotation,
    value: isDiameter ? radius * 2 : radius
  };
}

export interface AngularDimensionLayout {
  arcPath: string;
  arrow1: Arrowhead;
  arrow2: Arrowhead;
  textCenter: Point2D;
  textRotation: number;
  angleDeg: number;
}

/**
 * 計算角度尺寸標註的幾何佈局。
 * 
 * @param line1 第一條直線
 * @param line2 第二條直線
 * @param clickPos 滑鼠點選位置（決定所處象限與半徑）
 * @param arrowLength 箭頭長度
 * @param arrowAngle 箭頭角度
 */
export function calculateAngularDimensionLayout(
  line1: LineEntity,
  line2: LineEntity,
  clickPos: Point2D,
  arrowLength: number = 6.0,
  arrowAngle: number = Math.PI / 6
): AngularDimensionLayout | null {
  const p1 = line1.start;
  const p2 = line1.end;
  const p3 = line2.start;
  const p4 = line2.end;
  
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-8) return null; // 平行線無法標註角度
  
  // 計算交點 V
  const v1x = p3.x - p1.x;
  const v1y = p3.y - p1.y;
  const t1 = (v1x * d2y - v1y * d2x) / cross;
  const V = { x: p1.x + t1 * d1x, y: p1.y + t1 * d1y };
  
  // 決定 clickPos 所在的象限以選擇射線方向
  const ux = clickPos.x - V.x;
  const uy = clickPos.y - V.y;
  
  // u = c1 * d1 + c2 * d2
  const c1 = (ux * d2y - uy * d2x) / cross;
  const c2 = (d1x * uy - d1y * ux) / cross;
  
  const r1 = c1 >= 0 ? { x: d1x, y: d1y } : { x: -d1x, y: -d1y };
  const r2 = c2 >= 0 ? { x: d2x, y: d2y } : { x: -d2x, y: -d2y };
  
  const lenR1 = Math.hypot(r1.x, r1.y);
  const lenR2 = Math.hypot(r2.x, r2.y);
  
  const dir1 = { x: r1.x / lenR1, y: r1.y / lenR1 };
  const dir2 = { x: r2.x / lenR2, y: r2.y / lenR2 };
  
  const a1 = Math.atan2(dir1.y, dir1.x);
  const a2 = Math.atan2(dir2.y, dir2.x);
  
  let da = a2 - a1;
  while (da <= -Math.PI) da += 2 * Math.PI;
  while (da > Math.PI) da -= 2 * Math.PI;
  
  let startA: number;
  let endA: number;
  if (da > 0) {
    startA = a1;
    endA = a1 + da;
  } else {
    startA = a2;
    endA = a2 - da;
  }
  
  const R = Math.hypot(ux, uy);
  if (R < 1e-6) return null;
  
  const pStart = { x: V.x + R * Math.cos(startA), y: V.y + R * Math.sin(startA) };
  const pEnd = { x: V.x + R * Math.cos(endA), y: V.y + R * Math.sin(endA) };
  
  const arcPath = `M ${pStart.x} ${pStart.y} A ${R} ${R} 0 0 1 ${pEnd.x} ${pEnd.y}`;
  
  // 箭頭方向計算
  const dirArrow1 = startA - Math.PI / 2;
  const base1 = { 
    x: pStart.x - Math.cos(dirArrow1) * arrowLength, 
    y: pStart.y - Math.sin(dirArrow1) * arrowLength 
  };
  const arrow1: Arrowhead = {
    tip: pStart,
    wing1: rotatePoint(base1, pStart, arrowAngle),
    wing2: rotatePoint(base1, pStart, -arrowAngle)
  };
  
  const dirArrow2 = endA + Math.PI / 2;
  const base2 = { 
    x: pEnd.x - Math.cos(dirArrow2) * arrowLength, 
    y: pEnd.y - Math.sin(dirArrow2) * arrowLength 
  };
  const arrow2: Arrowhead = {
    tip: pEnd,
    wing1: rotatePoint(base2, pEnd, arrowAngle),
    wing2: rotatePoint(base2, pEnd, -arrowAngle)
  };
  
  const midA = (startA + endA) / 2;
  const textRadius = R + 4.0;
  const textCenter = { 
    x: V.x + textRadius * Math.cos(midA), 
    y: V.y + textRadius * Math.sin(midA) 
  };
  const textRotation = normalizeTextAngle(midA + Math.PI / 2);
  
  const angleDeg = (endA - startA) * 180 / Math.PI;
  
  return {
    arcPath,
    arrow1,
    arrow2,
    textCenter,
    textRotation,
    angleDeg
  };
}
