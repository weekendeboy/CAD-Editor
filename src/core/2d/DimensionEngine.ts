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
 * @param arrowLength 箭頭長度（預設為 6.0）
 * @param arrowAngle 箭頭夾角弧度（預設為 30 度 = Math.PI / 6）
 * @param gap 尺寸引導線與標註點的間距（預設為 2.0）
 * @param extend 尺寸引導線超出標註主線的長度（預設為 4.0）
 */
export function calculateLinearDimensionLayout(
  p1: Point2D,
  p2: Point2D,
  textPos: Point2D,
  isAligned: boolean,
  arrowLength: number = 6.0,
  arrowAngle: number = Math.PI / 6,
  gap: number = 2.0,
  extend: number = 4.0
): LinearDimensionLayout {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  
  let proj1: Point2D;
  let proj2: Point2D;
  let normalUnit: Point2D;
  let value: number;

  if (isAligned) {
    // 1. 對齊標註 (Aligned Dimension)
    // 測量線方向與兩標註點連線方向一致
    const length = Math.hypot(dx, dy);
    const dir = length > 1e-6 ? { x: dx / length, y: dy / length } : { x: 1, y: 0 };
    
    // 計算 textPos 到 p1-p2 直線的投射與偏置
    const v = { x: textPos.x - p1.x, y: textPos.y - p1.y };
    const t = v.x * dir.x + v.y * dir.y;
    const projOnLine = { x: p1.x + dir.x * t, y: p1.y + dir.y * t };
    
    const vToText = { x: textPos.x - projOnLine.x, y: textPos.y - projOnLine.y };
    const distToText = Math.hypot(vToText.x, vToText.y);
    
    if (distToText > 1e-6) {
      normalUnit = { x: vToText.x / distToText, y: vToText.y / distToText };
    } else {
      normalUnit = { x: -dir.y, y: dir.x };
    }
    
    proj1 = { x: p1.x + normalUnit.x * distToText, y: p1.y + normalUnit.y * distToText };
    proj2 = { x: p2.x + normalUnit.x * distToText, y: p2.y + normalUnit.y * distToText };
    value = length;
  } else {
    // 2. 非對齊標註（水平或垂直標註）
    // 依據文字位置相對中點的偏移，自動判定是要進行水平標註或是垂直標註
    const pm = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const isHorizontal = Math.abs(textPos.y - pm.y) >= Math.abs(textPos.x - pm.x);

    if (isHorizontal) {
      // 水平標註 (Horizontal Dimension) - 尺寸主線為水平線
      const dyText = textPos.y - p1.y;
      normalUnit = { x: 0, y: dyText >= 0 ? 1 : -1 };
      
      proj1 = { x: p1.x, y: textPos.y };
      proj2 = { x: p2.x, y: textPos.y };
      value = Math.abs(dx);
    } else {
      // 垂直標註 (Vertical Dimension) - 尺寸主線為垂直線
      const dxText = textPos.x - p1.x;
      normalUnit = { x: dxText >= 0 ? 1 : -1, y: 0 };
      
      proj1 = { x: textPos.x, y: p1.y };
      proj2 = { x: textPos.x, y: p2.y };
      value = Math.abs(dy);
    }
  }

  // 3. 計算引導線 (Extension Lines) 起終點
  // 起點與原點保持 gap 間距，終點超出尺寸主線面 extend 長度
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

  // 5. 尺寸文字旋轉角度與中心位置
  const textCenter = textPos;
  const textCenterDefault = { x: (proj1.x + proj2.x) / 2, y: (proj1.y + proj2.y) / 2 };
  const textRotation = normalizeTextAngle(Math.atan2(dirDim.y, dirDim.x));

  return {
    extension1,
    extension2,
    dimensionLine: { start: proj1, end: proj2 },
    textCenter,
    textCenterDefault,
    textRotation,
    arrow1,
    arrow2,
    value
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
