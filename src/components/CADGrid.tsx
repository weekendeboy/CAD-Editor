import React, { useMemo } from 'react';
import { Point2D } from '../types/cad';

export interface CADGridProps {
  pan: Point2D;
  scale: number;
  width: number;
  height: number;
  screenToWorld: (pt: Point2D) => Point2D;
}

export const CADGrid: React.FC<CADGridProps> = ({
  pan,
  scale,
  width,
  height,
  screenToWorld,
}) => {
  // 安全檢查
  if (width <= 0 || height <= 0 || scale <= 0) return null;

  const { minorPath, majorPath, axisPath, minorSpacing, majorSpacing } = useMemo(() => {
    // 1. 計算自適應網格間距
    const minPixels = 15; // 螢幕上最小的次網格間距(px)
    const targetWorld = minPixels / scale;
    const mag = Math.pow(10, Math.floor(Math.log10(targetWorld)));
    const residual = targetWorld / mag;

    let minor = mag;
    if (residual <= 1.5) minor = mag;
    else if (residual <= 3.5) minor = 2 * mag;
    else if (residual <= 7.5) minor = 5 * mag;
    else minor = 10 * mag;

    const major = minor * 5;

    // 2. 計算目前視窗可見的世界坐標邊界
    const tl = screenToWorld({ x: 0, y: 0 }); // 螢幕左上 -> 世界 (最小X, 最大Y)
    const br = screenToWorld({ x: width, y: height }); // 螢幕右下 -> 世界 (最大X, 最小Y)

    const minX = tl.x;
    const maxX = br.x;
    const minY = br.y;
    const maxY = tl.y;

    // 3. 計算迴圈的起始與結束點 (對齊 minor)
    const startX = Math.floor(minX / minor) * minor;
    const endX = Math.ceil(maxX / minor) * minor;
    const startY = Math.floor(minY / minor) * minor;
    const endY = Math.ceil(maxY / minor) * minor;

    let minPathD = '';
    let majPathD = '';
    let axPathD = '';

    // 4. 產生垂直線 (X 軸各點)
    for (let x = startX; x <= endX + minor / 10; x += minor) {
      // 避免浮點數誤差
      const cleanX = Math.round(x / minor) * minor;
      const screenX = pan.x + cleanX * scale;
      
      const isAxis = Math.abs(cleanX) < 1e-8;
      const isMajor = Math.round(Math.abs(cleanX) / minor) % 5 === 0;

      const lineCmd = `M ${screenX} 0 L ${screenX} ${height} `;
      
      if (isAxis) {
        axPathD += lineCmd;
      } else if (isMajor) {
        majPathD += lineCmd;
      } else {
        minPathD += lineCmd;
      }
    }

    // 5. 產生水平線 (Y 軸各點)
    for (let y = startY; y <= endY + minor / 10; y += minor) {
      const cleanY = Math.round(y / minor) * minor;
      const screenY = pan.y - cleanY * scale; // Y軸朝上，螢幕Y朝下

      const isAxis = Math.abs(cleanY) < 1e-8;
      const isMajor = Math.round(Math.abs(cleanY) / minor) % 5 === 0;

      const lineCmd = `M 0 ${screenY} L ${width} ${screenY} `;
      
      if (isAxis) {
        axPathD += lineCmd;
      } else if (isMajor) {
        majPathD += lineCmd;
      } else {
        minPathD += lineCmd;
      }
    }

    return {
      minorPath: minPathD,
      majorPath: majPathD,
      axisPath: axPathD,
      minorSpacing: minor,
      majorSpacing: major,
    };
  }, [pan, scale, width, height, screenToWorld]);

  const arrowLength = 50;

  return (
    <svg
      width={width}
      height={height}
      style={{
        backgroundColor: '#1E1E1E', // AutoCAD 暗色風格背景
        position: 'absolute',
        top: 0,
        left: 0,
        zIndex: 0,
        pointerEvents: 'none', // 讓下方的滑鼠事件穿透（雖然它在最底層）
      }}
    >
      {/* 渲染網格線 */}
      <path d={minorPath} stroke="#2C2C2C" strokeWidth="1" fill="none" />
      <path d={majorPath} stroke="#3A3A3A" strokeWidth="1" fill="none" />
      <path d={axisPath} stroke="#555555" strokeWidth="1.5" fill="none" />

      {/* 原點座標指示 (UCS Icon) */}
      <g transform={`translate(${pan.x}, ${pan.y})`}>
        {/* 原點方塊 */}
        <rect
          x="-4"
          y="-4"
          width="8"
          height="8"
          fill="none"
          stroke="white"
          strokeWidth="1.5"
        />

        {/* X 軸正向箭頭 (紅色) */}
        <line
          x1="0"
          y1="0"
          x2={arrowLength}
          y2="0"
          stroke="#EF4444"
          strokeWidth="2.5"
        />
        <polygon
          points={`${arrowLength}, -4 ${arrowLength + 10}, 0 ${arrowLength}, 4`}
          fill="#EF4444"
        />
        <text
          x={arrowLength + 14}
          y="4"
          fill="#EF4444"
          fontSize="14"
          fontFamily="monospace"
          fontWeight="bold"
        >
          X
        </text>

        {/* Y 軸正向箭頭 (綠色) - 由於螢幕座標 Y 朝下，CAD Y 朝上，此箭頭指向畫面負 Y (上方) */}
        <line
          x1="0"
          y1="0"
          x2="0"
          y2={-arrowLength}
          stroke="#22C55E"
          strokeWidth="2.5"
        />
        <polygon
          points={`-4, ${-arrowLength} 0, ${-arrowLength - 10} 4, ${-arrowLength}`}
          fill="#22C55E"
        />
        <text
          x="-14"
          y={-arrowLength - 12}
          fill="#22C55E"
          fontSize="14"
          fontFamily="monospace"
          fontWeight="bold"
        >
          Y
        </text>
      </g>
    </svg>
  );
};
