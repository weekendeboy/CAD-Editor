import {
  CADEntity2D,
  LineEntity,
  CircleEntity,
  ArcEntity,
  PolylineEntity,
  CADLayer,
  Point2D,
} from '../../types/cad';
import { aciToHex, rgbToHex } from './DxfColorMap';
import { decomposePolylineToEntities } from '../2d/PolylineUtils';
import { autoStitchEntities, StitchResult } from '../2d/AutoStitch';

export interface DxfParseOptions {
  targetUnits?: 'mm' | 'inch';  // 目標期望單位（預設 'mm'）
  customScaleFactor?: number;   // 手動指定等比縮放係數（若提供則覆蓋自動單位計算）
  decomposePolylines?: boolean; // 是否拆解多段線為獨立 Line/Arc（預設 false）
  flattenBlocks?: boolean;       // 是否平坦化圖塊（預設 true）
  defaultLayerColor?: string;    // 預設圖層顏色
  maxBlockNestingDepth?: number; // 圖塊嵌套上限（預設 8）
  autoStitch?: boolean;          // 是否啟用端點容差縫合（預設 true）
  stitchTolerance?: number;      // 縫合容差（預設 1e-3）
}

export interface ParsedDxfResult {
  units: 'mm' | 'inch';
  entities: CADEntity2D[];
  layers: Record<string, CADLayer>;
  warnings: string[];
  stitchStats?: {
    mergedPointsCount: number;
    removedEntitiesCount: number;
  };
}

interface DxfGroupToken {
  code: number;
  value: string;
  lineNum: number;
}

/**
 * 2D 仿射變換矩陣 (2D Affine Transformation Matrix)
 * 矩陣表示: [a c tx; b d ty; 0 0 1]
 * 轉換公式: x' = a*x + c*y + tx, y' = b*x + d*y + ty
 */
interface AffineMatrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

/**
 * 建立單位矩陣 (Identity Matrix)
 */
function createIdentityMatrix(): AffineMatrix2D {
  return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
}

/**
 * 根據圖塊基準點、插入點、縮放係數與旋轉角度建立 INSERT 2D 仿射變換矩陣
 * 轉換順序：(P - BasePoint) -> 縮放 (Scale) -> 旋轉 (Rotation) -> 平移 (InsertionPoint)
 */
function createInsertMatrix(
  insX: number,
  insY: number,
  scaleX: number,
  scaleY: number,
  rotationDeg: number,
  bx: number = 0,
  by: number = 0
): AffineMatrix2D {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const a = scaleX * cos;
  const b = scaleX * sin;
  const c = -scaleY * sin;
  const d = scaleY * cos;

  const tx = insX - (a * bx + c * by);
  const ty = insY - (b * bx + d * by);

  return { a, b, c, d, tx, ty };
}

/**
 * 矩陣相乘 (Composite Affine Matrix): M_composite = mOuter * mInner
 */
function multiplyAffine(mOuter: AffineMatrix2D, mInner: AffineMatrix2D): AffineMatrix2D {
  return {
    a: mOuter.a * mInner.a + mOuter.c * mInner.b,
    b: mOuter.b * mInner.a + mOuter.d * mInner.b,
    c: mOuter.a * mInner.c + mOuter.c * mInner.d,
    d: mOuter.b * mInner.c + mOuter.d * mInner.d,
    tx: mOuter.a * mInner.tx + mOuter.c * mInner.ty + mOuter.tx,
    ty: mOuter.b * mInner.tx + mOuter.d * mInner.ty + mOuter.ty,
  };
}

/**
 * 套用 2D 仿射變換矩陣至點 P(x, y)
 */
function transformPoint(m: AffineMatrix2D, p: Point2D): Point2D {
  return {
    x: m.a * p.x + m.c * p.y + m.tx,
    y: m.b * p.x + m.d * p.y + m.ty,
  };
}

/**
 * 將弧度角規格化至 [0, 2π) 範圍
 */
function normalizeAngle(rad: number): number {
  if (!Number.isFinite(rad)) {
    return 0;
  }
  const TWO_PI = Math.PI * 2;
  let a = rad % TWO_PI;
  if (a < 0) {
    a += TWO_PI;
  }
  if (Math.abs(a - TWO_PI) < 1e-12) {
    a = 0;
  }
  return a;
}

/**
 * 判斷圖層名稱是否為建構線或非列印輔助圖層
 */
function isConstructionLayer(layerName: string): boolean {
  if (!layerName) return false;
  const upper = layerName.toUpperCase();
  return upper === 'CONSTRUCTION' || upper === 'DEFPOINTS';
}

/**
 * 依據 AutoCAD $INSUNITS 群組碼 (代碼 70) 與目標期望單位計算等比縮放倍率
 *
 * $INSUNITS 代碼 70:
 * 0 = Unspecified
 * 1 = Inches
 * 2 = Feet
 * 4 = Millimeters
 * 5 = Centimeters
 * 6 = Meters
 */
export function calculateScaleFactor(
  insunitsCode: number,
  targetUnits: 'mm' | 'inch' = 'mm',
  customScaleFactor?: number
): number {
  if (
    customScaleFactor !== undefined &&
    Number.isFinite(customScaleFactor) &&
    customScaleFactor > 0
  ) {
    return customScaleFactor;
  }

  if (targetUnits === 'inch') {
    switch (insunitsCode) {
      case 1: // Inches
        return 1.0;
      case 2: // Feet
        return 12.0;
      case 4: // Millimeters
        return 1 / 25.4;
      case 5: // Centimeters
        return 10 / 25.4;
      case 6: // Meters
        return 1000 / 25.4;
      default: // 0 or Unspecified or others
        return 1.0;
    }
  } else {
    // targetUnits === 'mm'
    switch (insunitsCode) {
      case 1: // Inches
        return 25.4;
      case 2: // Feet
        return 304.8;
      case 4: // Millimeters
        return 1.0;
      case 5: // Centimeters
        return 10.0;
      case 6: // Meters
        return 1000.0;
      default: // 0 or Unspecified or others
        return 1.0;
    }
  }
}

/**
 * 幾何無損等比縮放運算
 * - 針對所有圖元執行座標換算
 * - 角度 (startAngle/endAngle) 與凸度 (bulges) 為無因次純量，保持不變
 */
function applyUnitScaling(entities: CADEntity2D[], scaleFactor: number): CADEntity2D[] {
  if (Math.abs(scaleFactor - 1.0) <= 1e-6) {
    return entities;
  }

  return entities.map((ent) => {
    switch (ent.type) {
      case 'line':
        return {
          ...ent,
          start: { x: ent.start.x * scaleFactor, y: ent.start.y * scaleFactor },
          end: { x: ent.end.x * scaleFactor, y: ent.end.y * scaleFactor },
        };
      case 'circle':
        return {
          ...ent,
          center: { x: ent.center.x * scaleFactor, y: ent.center.y * scaleFactor },
          radius: ent.radius * scaleFactor,
        };
      case 'arc':
        return {
          ...ent,
          center: { x: ent.center.x * scaleFactor, y: ent.center.y * scaleFactor },
          radius: ent.radius * scaleFactor,
        };
      case 'polyline':
        return {
          ...ent,
          points: ent.points.map((p) => ({
            x: p.x * scaleFactor,
            y: p.y * scaleFactor,
          })),
        };
      default:
        return ent;
    }
  });
}

// 內部原始圖元定義 (Raw DXF Entities)
export interface RawDxfLine {
  type: 'LINE';
  start: Point2D;
  end: Point2D;
  layer: string;
  color?: string;
  colorIsByBlock?: boolean;
}

export interface RawDxfCircle {
  type: 'CIRCLE';
  center: Point2D;
  radius: number;
  layer: string;
  color?: string;
  colorIsByBlock?: boolean;
}

export interface RawDxfArc {
  type: 'ARC';
  center: Point2D;
  radius: number;
  startDeg: number;
  endDeg: number;
  layer: string;
  color?: string;
  colorIsByBlock?: boolean;
}

export interface RawDxfPolyline {
  type: 'LWPOLYLINE' | 'POLYLINE';
  points: Point2D[];
  bulges?: number[];
  closed: boolean;
  layer: string;
  color?: string;
  colorIsByBlock?: boolean;
}

export interface RawDxfInsert {
  type: 'INSERT';
  blockName: string;
  insertionPoint: Point2D;
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
  layer: string;
  color?: string;
  colorIsByBlock?: boolean;
}

export type RawBlockEntity =
  | RawDxfLine
  | RawDxfCircle
  | RawDxfArc
  | RawDxfPolyline
  | RawDxfInsert;

export interface DxfBlockDefinition {
  name: string;
  basePoint: Point2D;
  entities: RawBlockEntity[];
}

let entityCounter = 0;

/**
 * 產生唯一圖元識別碼 (ID)
 */
function generateEntityId(prefix: string): string {
  entityCounter++;
  const rand = Math.random().toString(36).substring(2, 7);
  return `${prefix}-${entityCounter}-${rand}`;
}

/**
 * 解析 TrueColor (群組碼 420, 24-bit RGB) 或 ACI (群組碼 62)
 */
function extractEntityColor(entityTokens: DxfGroupToken[]): {
  colorHex?: string;
  colorIsByBlock: boolean;
} {
  let colorHex: string | undefined = undefined;
  let colorIsByBlock = false;

  for (const et of entityTokens) {
    if (et.code === 420) {
      const intVal = parseInt(et.value, 10);
      if (Number.isFinite(intVal) && intVal >= 0) {
        const r = (intVal >> 16) & 0xff;
        const g = (intVal >> 8) & 0xff;
        const b = intVal & 0xff;
        colorHex = rgbToHex({ r, g, b });
      }
    } else if (et.code === 62 && !colorHex) {
      const aci = parseInt(et.value, 10);
      if (Number.isFinite(aci)) {
        if (aci === 0) {
          colorIsByBlock = true;
        } else if (aci !== 256) {
          colorHex = aciToHex(Math.abs(aci));
        }
      }
    }
  }

  return { colorHex, colorIsByBlock };
}

/**
 * 從 DXF 群組碼 tokens 集中解析單一原始圖元
 * 雜訊過濾：自動忽略 Handle(5)、Subclass(100)、Soft Pointer(330)、Hard Ownership(360)、102 字典組與 XDATA 等 AutoCAD 2019 特殊欄位
 */
function parseRawEntityFromTokens(
  tokens: DxfGroupToken[],
  startIndex: number
): { entity?: RawBlockEntity; warning?: string; nextTokenIdx: number } {
  let tokenIdx = startIndex;
  const startToken = tokens[tokenIdx];
  const entityType = startToken.value.toUpperCase();

  // 1. 處理 POLYLINE (舊式 3D/2D POLYLINE + VERTEX + SEQEND)
  if (entityType === 'POLYLINE') {
    tokenIdx++; // 消耗 0 -> POLYLINE
    let layer = '0';
    let colorHex: string | undefined = undefined;
    let colorIsByBlock = false;
    let isClosed = false;

    while (tokenIdx < tokens.length && tokens[tokenIdx].code !== 0) {
      const pt = tokens[tokenIdx];
      if (pt.code === 8) {
        layer = pt.value || '0';
      } else if (pt.code === 420) {
        const intVal = parseInt(pt.value, 10);
        if (Number.isFinite(intVal) && intVal >= 0) {
          const r = (intVal >> 16) & 0xff;
          const g = (intVal >> 8) & 0xff;
          const b = intVal & 0xff;
          colorHex = rgbToHex({ r, g, b });
        }
      } else if (pt.code === 62 && !colorHex) {
        const aci = parseInt(pt.value, 10);
        if (Number.isFinite(aci)) {
          if (aci === 0) {
            colorIsByBlock = true;
          } else if (aci !== 256) {
            colorHex = aciToHex(Math.abs(aci));
          }
        }
      } else if (pt.code === 70) {
        const flags = parseInt(pt.value, 10);
        if (Number.isFinite(flags) && (flags & 1) !== 0) {
          isClosed = true;
        }
      }
      tokenIdx++;
    }

    const points: Point2D[] = [];
    const bulges: number[] = [];

    while (tokenIdx < tokens.length) {
      const nextTok = tokens[tokenIdx];
      if (nextTok.code !== 0) {
        tokenIdx++;
        continue;
      }

      const subType = nextTok.value.toUpperCase();
      if (subType === 'VERTEX') {
        tokenIdx++; // 消耗 0 -> VERTEX
        let vx: number | undefined = undefined;
        let vy: number | undefined = undefined;
        let vBulge = 0;

        while (tokenIdx < tokens.length && tokens[tokenIdx].code !== 0) {
          const vt = tokens[tokenIdx];
          if (vt.code === 10) vx = parseFloat(vt.value);
          else if (vt.code === 20) vy = parseFloat(vt.value);
          else if (vt.code === 42) {
            const b = parseFloat(vt.value);
            if (Number.isFinite(b)) vBulge = b;
          }
          tokenIdx++;
        }

        if (vx !== undefined && Number.isFinite(vx) && vy !== undefined && Number.isFinite(vy)) {
          points.push({ x: vx, y: vy });
          bulges.push(vBulge);
        }
      } else if (subType === 'SEQEND') {
        tokenIdx++; // 消耗 0 -> SEQEND
        while (tokenIdx < tokens.length && tokens[tokenIdx].code !== 0) {
          tokenIdx++;
        }
        break;
      } else {
        break;
      }
    }

    if (points.length >= 2) {
      const hasBulges = bulges.some((b) => Math.abs(b) > 1e-8);
      return {
        entity: {
          type: 'POLYLINE',
          points,
          bulges: hasBulges ? bulges : undefined,
          closed: isClosed,
          layer,
          color: colorHex,
          colorIsByBlock,
        },
        nextTokenIdx: tokenIdx,
      };
    }
    return {
      warning: `Line ${startToken.lineNum}: POLYLINE with fewer than 2 valid vertices skipped.`,
      nextTokenIdx: tokenIdx,
    };
  }

  // 2. 收集標準單區塊圖元群組碼 (LINE, CIRCLE, ARC, LWPOLYLINE, INSERT, ELLIPSE, SPLINE 等)
  const entityTokens: DxfGroupToken[] = [startToken];
  tokenIdx++;
  while (tokenIdx < tokens.length && tokens[tokenIdx].code !== 0) {
    entityTokens.push(tokens[tokenIdx]);
    tokenIdx++;
  }

  let layer = '0';
  for (const et of entityTokens) {
    if (et.code === 8) {
      layer = et.value || '0';
      break;
    }
  }

  const { colorHex, colorIsByBlock } = extractEntityColor(entityTokens);

  // A. LINE 圖元解析
  if (entityType === 'LINE') {
    let x1: number | undefined;
    let y1: number | undefined;
    let x2: number | undefined;
    let y2: number | undefined;

    for (const et of entityTokens) {
      if (et.code === 10) x1 = parseFloat(et.value);
      else if (et.code === 20) y1 = parseFloat(et.value);
      else if (et.code === 11) x2 = parseFloat(et.value);
      else if (et.code === 21) y2 = parseFloat(et.value);
    }

    if (
      x1 !== undefined &&
      Number.isFinite(x1) &&
      y1 !== undefined &&
      Number.isFinite(y1) &&
      x2 !== undefined &&
      Number.isFinite(x2) &&
      y2 !== undefined &&
      Number.isFinite(y2)
    ) {
      return {
        entity: {
          type: 'LINE',
          start: { x: x1, y: y1 },
          end: { x: x2, y: y2 },
          layer,
          color: colorHex,
          colorIsByBlock,
        },
        nextTokenIdx: tokenIdx,
      };
    }
    return {
      warning: `Line ${startToken.lineNum}: Incomplete or invalid LINE coordinates skipped.`,
      nextTokenIdx: tokenIdx,
    };
  }

  // B. CIRCLE 圖元解析
  if (entityType === 'CIRCLE') {
    let cx: number | undefined;
    let cy: number | undefined;
    let r: number | undefined;

    for (const et of entityTokens) {
      if (et.code === 10) cx = parseFloat(et.value);
      else if (et.code === 20) cy = parseFloat(et.value);
      else if (et.code === 40) r = parseFloat(et.value);
    }

    if (
      cx !== undefined &&
      Number.isFinite(cx) &&
      cy !== undefined &&
      Number.isFinite(cy) &&
      r !== undefined &&
      Number.isFinite(r) &&
      r > 0
    ) {
      return {
        entity: {
          type: 'CIRCLE',
          center: { x: cx, y: cy },
          radius: r,
          layer,
          color: colorHex,
          colorIsByBlock,
        },
        nextTokenIdx: tokenIdx,
      };
    }
    return {
      warning: `Line ${startToken.lineNum}: Incomplete or invalid CIRCLE definition skipped.`,
      nextTokenIdx: tokenIdx,
    };
  }

  // C. ARC 圖元解析
  if (entityType === 'ARC') {
    let cx: number | undefined;
    let cy: number | undefined;
    let r: number | undefined;
    let startDeg: number | undefined;
    let endDeg: number | undefined;

    for (const et of entityTokens) {
      if (et.code === 10) cx = parseFloat(et.value);
      else if (et.code === 20) cy = parseFloat(et.value);
      else if (et.code === 40) r = parseFloat(et.value);
      else if (et.code === 50) startDeg = parseFloat(et.value);
      else if (et.code === 51) endDeg = parseFloat(et.value);
    }

    if (
      cx !== undefined &&
      Number.isFinite(cx) &&
      cy !== undefined &&
      Number.isFinite(cy) &&
      r !== undefined &&
      Number.isFinite(r) &&
      r > 0 &&
      startDeg !== undefined &&
      Number.isFinite(startDeg) &&
      endDeg !== undefined &&
      Number.isFinite(endDeg)
    ) {
      return {
        entity: {
          type: 'ARC',
          center: { x: cx, y: cy },
          radius: r,
          startDeg,
          endDeg,
          layer,
          color: colorHex,
          colorIsByBlock,
        },
        nextTokenIdx: tokenIdx,
      };
    }
    return {
      warning: `Line ${startToken.lineNum}: Incomplete or invalid ARC definition skipped.`,
      nextTokenIdx: tokenIdx,
    };
  }

  // D. LWPOLYLINE 穩健狀態機解析
  if (entityType === 'LWPOLYLINE') {
    let isClosed = false;
    const vertices: { x: number; y: number; bulge: number }[] = [];
    let currentVertex: { x?: number; y?: number; bulge: number } | null = null;

    for (const et of entityTokens) {
      if (et.code === 70) {
        const flags = parseInt(et.value, 10);
        if (Number.isFinite(flags) && (flags & 1) !== 0) {
          isClosed = true;
        }
      } else if (et.code === 10) {
        // 若前面已有完整頂點資料，先提交上一頂點
        if (
          currentVertex !== null &&
          currentVertex.x !== undefined &&
          currentVertex.y !== undefined &&
          Number.isFinite(currentVertex.x) &&
          Number.isFinite(currentVertex.y)
        ) {
          vertices.push({
            x: currentVertex.x,
            y: currentVertex.y,
            bulge: currentVertex.bulge || 0,
          });
          currentVertex = { x: parseFloat(et.value), y: undefined, bulge: 0 };
        } else if (currentVertex !== null) {
          currentVertex.x = parseFloat(et.value);
        } else {
          currentVertex = { x: parseFloat(et.value), y: undefined, bulge: 0 };
        }
      } else if (et.code === 20) {
        if (currentVertex === null) {
          currentVertex = { x: undefined, y: parseFloat(et.value), bulge: 0 };
        } else {
          currentVertex.y = parseFloat(et.value);
        }
      } else if (et.code === 42) {
        const b = parseFloat(et.value);
        if (Number.isFinite(b) && currentVertex !== null) {
          currentVertex.bulge = b;
        }
      }
      // 忽略 90(頂點數), 43(寬度), 38(高程), 39(厚度), 100(Subclass), 5(Handle), 330(Pointer) 等雜訊
    }

    // 提交最後一個頂點
    if (
      currentVertex !== null &&
      currentVertex.x !== undefined &&
      currentVertex.y !== undefined &&
      Number.isFinite(currentVertex.x) &&
      Number.isFinite(currentVertex.y)
    ) {
      vertices.push({
        x: currentVertex.x,
        y: currentVertex.y,
        bulge: currentVertex.bulge || 0,
      });
    }

    if (vertices.length >= 2) {
      const points: Point2D[] = vertices.map((v) => ({ x: v.x, y: v.y }));
      const bulges: number[] = vertices.map((v) => v.bulge);
      const hasBulges = bulges.some((b) => Math.abs(b) > 1e-8);

      return {
        entity: {
          type: 'LWPOLYLINE',
          points,
          bulges: hasBulges ? bulges : undefined,
          closed: isClosed,
          layer,
          color: colorHex,
          colorIsByBlock,
        },
        nextTokenIdx: tokenIdx,
      };
    }
    return {
      warning: `Line ${startToken.lineNum}: LWPOLYLINE with fewer than 2 vertices skipped.`,
      nextTokenIdx: tokenIdx,
    };
  }

  // E. INSERT 圖塊引用解析
  if (entityType === 'INSERT') {
    let blockName = '';
    let insX = 0;
    let insY = 0;
    let scaleX = 1.0;
    let scaleY = 1.0;
    let rotationDeg = 0.0;

    for (const et of entityTokens) {
      if (et.code === 2) blockName = et.value;
      else if (et.code === 10) insX = parseFloat(et.value) || 0;
      else if (et.code === 20) insY = parseFloat(et.value) || 0;
      else if (et.code === 41) scaleX = parseFloat(et.value);
      else if (et.code === 42) scaleY = parseFloat(et.value);
      else if (et.code === 50) rotationDeg = parseFloat(et.value) || 0;
    }

    if (!Number.isFinite(scaleX)) scaleX = 1.0;
    if (!Number.isFinite(scaleY)) scaleY = 1.0;
    if (!Number.isFinite(insX)) insX = 0;
    if (!Number.isFinite(insY)) insY = 0;
    if (!Number.isFinite(rotationDeg)) rotationDeg = 0;

    if (blockName) {
      return {
        entity: {
          type: 'INSERT',
          blockName,
          insertionPoint: { x: insX, y: insY },
          scaleX,
          scaleY,
          rotationDeg,
          layer,
          color: colorHex,
          colorIsByBlock,
        },
        nextTokenIdx: tokenIdx,
      };
    }
    return {
      warning: `Line ${startToken.lineNum}: INSERT missing block name (Group Code 2) skipped.`,
      nextTokenIdx: tokenIdx,
    };
  }

  // F. ELLIPSE 支援轉換 (AutoCAD 2019 橢圓與橢圓弧)
  if (entityType === 'ELLIPSE') {
    let cx = 0;
    let cy = 0;
    let mx = 1;
    let my = 0;
    let ratio = 1.0;
    let startParam = 0;
    let endParam = Math.PI * 2;

    for (const et of entityTokens) {
      if (et.code === 10) cx = parseFloat(et.value) || 0;
      else if (et.code === 20) cy = parseFloat(et.value) || 0;
      else if (et.code === 11) mx = parseFloat(et.value) || 1;
      else if (et.code === 21) my = parseFloat(et.value) || 0;
      else if (et.code === 40) ratio = parseFloat(et.value) || 1.0;
      else if (et.code === 41) startParam = parseFloat(et.value) || 0;
      else if (et.code === 42) endParam = parseFloat(et.value) || Math.PI * 2;
    }

    const majorLen = Math.hypot(mx, my);
    if (majorLen > 1e-6 && ratio > 1e-6) {
      // 若為正圓且全周長
      if (Math.abs(ratio - 1.0) < 1e-4 && Math.abs(endParam - startParam - Math.PI * 2) < 1e-4) {
        return {
          entity: {
            type: 'CIRCLE',
            center: { x: cx, y: cy },
            radius: majorLen,
            layer,
            color: colorHex,
            colorIsByBlock,
          },
          nextTokenIdx: tokenIdx,
        };
      }

      // 非正圓橢圓：離散化為高精度 LWPOLYLINE 多段線
      const phi = Math.atan2(my, mx);
      const minorLen = majorLen * ratio;
      let sweep = endParam - startParam;
      if (sweep <= 0) sweep += Math.PI * 2;
      const numSegments = Math.max(16, Math.min(72, Math.ceil((sweep / (Math.PI * 2)) * 64)));

      const points: Point2D[] = [];
      for (let i = 0; i <= numSegments; i++) {
        const t = startParam + (sweep * i) / numSegments;
        const cosT = Math.cos(t);
        const sinT = Math.sin(t);
        const px = cx + majorLen * cosT * Math.cos(phi) - minorLen * sinT * Math.sin(phi);
        const py = cy + majorLen * cosT * Math.sin(phi) + minorLen * sinT * Math.cos(phi);
        points.push({ x: px, y: py });
      }

      const isClosed = Math.abs(sweep - Math.PI * 2) < 1e-4;
      return {
        entity: {
          type: 'LWPOLYLINE',
          points,
          closed: isClosed,
          layer,
          color: colorHex,
          colorIsByBlock,
        },
        nextTokenIdx: tokenIdx,
      };
    }
  }

  // G. SPLINE 支援轉換
  if (entityType === 'SPLINE') {
    const fitPoints: Point2D[] = [];
    const controlPoints: Point2D[] = [];
    let isClosed = false;

    let fx: number | undefined;
    let fy: number | undefined;
    let cx: number | undefined;
    let cy: number | undefined;

    for (const et of entityTokens) {
      if (et.code === 70) {
        const flags = parseInt(et.value, 10);
        if (Number.isFinite(flags) && (flags & 1) !== 0) isClosed = true;
      } else if (et.code === 11) {
        if (fx !== undefined && fy !== undefined) {
          fitPoints.push({ x: fx, y: fy });
          fy = undefined;
        }
        fx = parseFloat(et.value);
      } else if (et.code === 21) {
        fy = parseFloat(et.value);
      } else if (et.code === 10) {
        if (cx !== undefined && cy !== undefined) {
          controlPoints.push({ x: cx, y: cy });
          cy = undefined;
        }
        cx = parseFloat(et.value);
      } else if (et.code === 20) {
        cy = parseFloat(et.value);
      }
    }

    if (fx !== undefined && fy !== undefined) fitPoints.push({ x: fx, y: fy });
    if (cx !== undefined && cy !== undefined) controlPoints.push({ x: cx, y: cy });

    const selectedPoints = fitPoints.length >= 2 ? fitPoints : controlPoints;
    if (selectedPoints.length >= 2) {
      return {
        entity: {
          type: 'LWPOLYLINE',
          points: selectedPoints,
          closed: isClosed,
          layer,
          color: colorHex,
          colorIsByBlock,
        },
        nextTokenIdx: tokenIdx,
      };
    }
  }

  return {
    warning: `Line ${startToken.lineNum}: Non-geometric or unsupported DXF entity "${entityType}" safely skipped.`,
    nextTokenIdx: tokenIdx,
  };
}

/**
 * 將單一 RawBlockEntity 套用 2D 仿射變換並展平為系統 CADEntity2D 實體
 */
function flattenBlockEntity(
  rawEnt: RawBlockEntity,
  m: AffineMatrix2D,
  parentLayer: string,
  parentColor: string | undefined,
  depth: number,
  visitedBlocks: Set<string>,
  options: DxfParseOptions,
  warnings: string[],
  layers: Record<string, CADLayer>,
  blocks: Record<string, DxfBlockDefinition>,
  outEntities: CADEntity2D[]
): void {
  const defaultLayerColor = options.defaultLayerColor || '#FFFFFF';

  // 解析圖層與顏色繼承關係
  const resolvedLayer = !rawEnt.layer || rawEnt.layer === '0' ? parentLayer : rawEnt.layer;

  const resolvedColor = rawEnt.colorIsByBlock
    ? parentColor
    : rawEnt.color !== undefined
    ? rawEnt.color
    : parentColor;

  // 動態註冊圖層 (若尚未存在)
  if (!layers[resolvedLayer]) {
    layers[resolvedLayer] = {
      id: resolvedLayer,
      name: resolvedLayer,
      visible: true,
      locked: false,
      color: resolvedColor || defaultLayerColor,
    };
  }

  const isConstruction = isConstructionLayer(resolvedLayer);

  // 處理 INSERT 巢狀圖塊展開
  if (rawEnt.type === 'INSERT') {
    if (options.flattenBlocks !== false) {
      flattenInsert(
        rawEnt,
        m,
        resolvedLayer,
        resolvedColor,
        depth,
        visitedBlocks,
        options,
        warnings,
        layers,
        blocks,
        outEntities
      );
    }
    return;
  }

  // 1. LINE 仿射變換
  if (rawEnt.type === 'LINE') {
    const startTrans = transformPoint(m, rawEnt.start);
    const endTrans = transformPoint(m, rawEnt.end);

    const lineEntity: LineEntity = {
      id: generateEntityId('line'),
      type: 'line',
      start: startTrans,
      end: endTrans,
      layerId: resolvedLayer,
      visible: true,
      locked: false,
      ...(resolvedColor ? { color: resolvedColor } : {}),
      ...(isConstruction ? { isConstruction: true } : {}),
    };
    outEntities.push(lineEntity);
    return;
  }

  // 2. CIRCLE 仿射變換
  if (rawEnt.type === 'CIRCLE') {
    const centerTrans = transformPoint(m, rawEnt.center);
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);

    let radiusTrans = rawEnt.radius * sx;
    if (Math.abs(sx - sy) >= 1e-5) {
      radiusTrans = rawEnt.radius * Math.sqrt(sx * sy);
      warnings.push(
        `Non-uniform scaling (scaleX=${sx.toFixed(4)}, scaleY=${sy.toFixed(4)}) applied to CIRCLE; approximated using geometric mean radius.`
      );
    }

    const circleEntity: CircleEntity = {
      id: generateEntityId('circle'),
      type: 'circle',
      center: centerTrans,
      radius: radiusTrans,
      layerId: resolvedLayer,
      visible: true,
      locked: false,
      ...(resolvedColor ? { color: resolvedColor } : {}),
      ...(isConstruction ? { isConstruction: true } : {}),
    };
    outEntities.push(circleEntity);
    return;
  }

  // 3. ARC 仿射變換
  if (rawEnt.type === 'ARC') {
    const centerTrans = transformPoint(m, rawEnt.center);
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);

    let radiusTrans = rawEnt.radius * sx;
    if (Math.abs(sx - sy) >= 1e-5) {
      radiusTrans = rawEnt.radius * Math.sqrt(sx * sy);
      warnings.push(
        `Non-uniform scaling (scaleX=${sx.toFixed(4)}, scaleY=${sy.toFixed(4)}) applied to ARC; approximated using geometric mean radius.`
      );
    }

    const startRad = (rawEnt.startDeg * Math.PI) / 180;
    const endRad = (rawEnt.endDeg * Math.PI) / 180;

    const pStartLocal = {
      x: rawEnt.center.x + rawEnt.radius * Math.cos(startRad),
      y: rawEnt.center.y + rawEnt.radius * Math.sin(startRad),
    };
    const pEndLocal = {
      x: rawEnt.center.x + rawEnt.radius * Math.cos(endRad),
      y: rawEnt.center.y + rawEnt.radius * Math.sin(endRad),
    };

    const pStartTrans = transformPoint(m, pStartLocal);
    const pEndTrans = transformPoint(m, pEndLocal);

    let newStartAngle = normalizeAngle(
      Math.atan2(pStartTrans.y - centerTrans.y, pStartTrans.x - centerTrans.x)
    );
    let newEndAngle = normalizeAngle(
      Math.atan2(pEndTrans.y - centerTrans.y, pEndTrans.x - centerTrans.x)
    );

    // 鏡像翻轉處理 (Reflection Check)
    const det = m.a * m.d - m.b * m.c;
    if (det < 0) {
      const temp = newStartAngle;
      newStartAngle = newEndAngle;
      newEndAngle = temp;
    }

    const arcEntity: ArcEntity = {
      id: generateEntityId('arc'),
      type: 'arc',
      center: centerTrans,
      radius: radiusTrans,
      startAngle: newStartAngle,
      endAngle: newEndAngle,
      layerId: resolvedLayer,
      visible: true,
      locked: false,
      ...(resolvedColor ? { color: resolvedColor } : {}),
      ...(isConstruction ? { isConstruction: true } : {}),
    };
    outEntities.push(arcEntity);
    return;
  }

  // 4. LWPOLYLINE / POLYLINE 仿射變換
  if (rawEnt.type === 'LWPOLYLINE' || rawEnt.type === 'POLYLINE') {
    const transformedPoints = rawEnt.points.map((pt) => transformPoint(m, pt));
    const det = m.a * m.d - m.b * m.c;

    const transformedBulges = rawEnt.bulges
      ? rawEnt.bulges.map((b) => (det < 0 ? -b : b))
      : undefined;

    const hasNonZeroBulges = transformedBulges
      ? transformedBulges.some((b) => Math.abs(b) > 1e-8)
      : false;

    const polylineEntity: PolylineEntity = {
      id: generateEntityId('polyline'),
      type: 'polyline',
      points: transformedPoints,
      bulges: hasNonZeroBulges ? transformedBulges : undefined,
      closed: rawEnt.closed,
      layerId: resolvedLayer,
      visible: true,
      locked: false,
      ...(resolvedColor ? { color: resolvedColor } : {}),
      ...(isConstruction ? { isConstruction: true } : {}),
    };

    if (options.decomposePolylines) {
      const decomposed = decomposePolylineToEntities(polylineEntity);
      outEntities.push(...decomposed);
    } else {
      outEntities.push(polylineEntity);
    }
    return;
  }
}

/**
 * 展平 INSERT 圖塊引用 (Flatten Block Reference)
 */
function flattenInsert(
  rawInsert: RawDxfInsert,
  parentMatrix: AffineMatrix2D,
  parentLayer: string,
  parentColor: string | undefined,
  depth: number,
  visitedBlocks: Set<string>,
  options: DxfParseOptions,
  warnings: string[],
  layers: Record<string, CADLayer>,
  blocks: Record<string, DxfBlockDefinition>,
  outEntities: CADEntity2D[]
): void {
  const maxDepth = options.maxBlockNestingDepth ?? 8;

  if (depth >= maxDepth) {
    warnings.push(
      `Maximum block nesting depth (${maxDepth}) reached for block "${rawInsert.blockName}", skipping nested insertion.`
    );
    return;
  }

  const blockNameKey = rawInsert.blockName;
  const blockDef =
    blocks[blockNameKey] ||
    blocks[blockNameKey.toUpperCase()] ||
    blocks[blockNameKey.toLowerCase()];

  if (!blockDef) {
    warnings.push(`Block "${rawInsert.blockName}" referenced by INSERT not found in DXF BLOCKS section.`);
    return;
  }

  const normalizedName = blockDef.name.toUpperCase();
  if (visitedBlocks.has(normalizedName)) {
    warnings.push(`Circular block reference detected for block "${blockDef.name}", skipped.`);
    return;
  }

  const mInsert = createInsertMatrix(
    rawInsert.insertionPoint.x,
    rawInsert.insertionPoint.y,
    rawInsert.scaleX,
    rawInsert.scaleY,
    rawInsert.rotationDeg,
    blockDef.basePoint.x,
    blockDef.basePoint.y
  );
  const mComposite = multiplyAffine(parentMatrix, mInsert);

  const effectiveLayer =
    rawInsert.layer && rawInsert.layer !== '0' ? rawInsert.layer : parentLayer;
  const effectiveColor =
    rawInsert.colorIsByBlock
      ? parentColor
      : rawInsert.color !== undefined
      ? rawInsert.color
      : parentColor;

  const newVisited = new Set(visitedBlocks);
  newVisited.add(normalizedName);

  for (const childEntity of blockDef.entities) {
    flattenBlockEntity(
      childEntity,
      mComposite,
      effectiveLayer,
      effectiveColor,
      depth + 1,
      newVisited,
      options,
      warnings,
      layers,
      blocks,
      outEntities
    );
  }
}

/**
 * 解析標準 ASCII DXF 內容文字，完成【AutoCAD $INSUNITS 單位解析、BLOCKS 平坦化展開、單位等比縮放與 Auto-Stitch 容差縫合】
 *
 * 解析流水線 (Pipeline Order):
 * [Tokenizer 逐行掃描 + 註解與雜訊過濾]
 *   ↓
 * [BLOCKS 定義收集 + ENTITIES 幾何提取]
 *   ↓
 * [INSERT 圖塊 2D 仿射展開 (flattenBlocks)]
 *   ↓
 * [單位自適應等比縮放 (Unit Scaling Matrix)]
 *   ↓
 * [空間容差端點縫合 (autoStitchEntities)]
 *   ↓
 * [輸出 ParsedDxfResult（units 強制標記為 targetUnits）]
 *
 * @param dxfContent DXF 純文字內容
 * @param options 解析設定選項
 * @returns 解析結果 (單位, 展開縮放與縫合後的圖元陣列, 圖層字典, 警告訊息清單, Auto-Stitch 統計資料)
 */
export function parseDxfContent(
  dxfContent: string,
  options: DxfParseOptions = {}
): ParsedDxfResult {
  entityCounter = 0;
  const warnings: string[] = [];
  const rawEntities: CADEntity2D[] = [];

  const targetUnits: 'mm' | 'inch' = options.targetUnits ?? 'mm';
  const customScaleFactor = options.customScaleFactor;
  const defaultLayerColor = options.defaultLayerColor || '#FFFFFF';

  const layers: Record<string, CADLayer> = {
    '0': {
      id: '0',
      name: '0',
      visible: true,
      locked: false,
      color: defaultLayerColor,
    },
  };

  let insunitsCode = 0; // 0 = Unspecified

  if (!dxfContent || typeof dxfContent !== 'string' || dxfContent.trim().length === 0) {
    return {
      units: targetUnits,
      entities: [],
      layers,
      warnings: ['DXF content is empty or invalid.'],
    };
  }

  // 1. Stream Group Code Tokenizer (群組碼詞法分析器)
  const cleanContent = dxfContent.replace(/^\uFEFF/, '');
  const lines = cleanContent.split(/\r?\n/);
  const tokens: DxfGroupToken[] = [];

  let lineIdx = 0;
  while (lineIdx < lines.length) {
    const rawCodeLine = lines[lineIdx].trim();
    lineIdx++;

    if (rawCodeLine === '') {
      continue;
    }

    const code = parseInt(rawCodeLine, 10);
    if (isNaN(code)) {
      warnings.push(`Line ${lineIdx}: Invalid non-numeric group code "${rawCodeLine}" skipped.`);
      continue;
    }

    if (lineIdx >= lines.length) {
      warnings.push(`Line ${lineIdx}: Unexpected EOF, missing value for group code ${code}.`);
      break;
    }

    const value = lines[lineIdx].trim();
    lineIdx++;

    // 忽略 Group Code 999 註解
    if (code === 999) {
      continue;
    }

    tokens.push({
      code,
      value,
      lineNum: lineIdx - 1,
    });
  }

  if (tokens.length === 0) {
    return {
      units: targetUnits,
      entities: [],
      layers,
      warnings: ['No valid DXF group code tokens found.'],
    };
  }

  // 2. Section State Machine and Blocks/Entities Collector
  const blocks: Record<string, DxfBlockDefinition> = {};
  let currentSection = 'NONE';
  let tokenIdx = 0;

  while (tokenIdx < tokens.length) {
    const token = tokens[tokenIdx];

    // SECTION 判斷
    if (token.code === 0 && token.value.toUpperCase() === 'SECTION') {
      tokenIdx++;
      if (tokenIdx < tokens.length && tokens[tokenIdx].code === 2) {
        currentSection = tokens[tokenIdx].value.toUpperCase();
        tokenIdx++;
      } else {
        currentSection = 'UNKNOWN';
      }
      continue;
    }

    // ENDSEC 判斷
    if (token.code === 0 && token.value.toUpperCase() === 'ENDSEC') {
      currentSection = 'NONE';
      tokenIdx++;
      continue;
    }

    // EOF 判斷
    if (token.code === 0 && token.value.toUpperCase() === 'EOF') {
      break;
    }

    // A. 解析 HEADER 區段 (單位判斷 $INSUNITS)
    if (currentSection === 'HEADER') {
      if (token.code === 9 && token.value.toUpperCase() === '$INSUNITS') {
        tokenIdx++;
        while (tokenIdx < tokens.length && tokens[tokenIdx].code !== 0 && tokens[tokenIdx].code !== 9) {
          if (tokens[tokenIdx].code === 70) {
            const parsedVal = parseInt(tokens[tokenIdx].value, 10);
            if (Number.isFinite(parsedVal)) {
              insunitsCode = parsedVal;
            }
            break;
          }
          tokenIdx++;
        }
        continue;
      }
      tokenIdx++;
      continue;
    }

    // B. 解析 TABLES 區段 (LAYER 表與顏色)
    if (currentSection === 'TABLES') {
      if (token.code === 0 && token.value.toUpperCase() === 'LAYER') {
        tokenIdx++;
        let layerName = '';
        let layerColorHex: string | undefined = undefined;

        while (tokenIdx < tokens.length && tokens[tokenIdx].code !== 0) {
          const subToken = tokens[tokenIdx];
          if (subToken.code === 2) {
            layerName = subToken.value;
          } else if (subToken.code === 420) {
            const intVal = parseInt(subToken.value, 10);
            if (Number.isFinite(intVal) && intVal >= 0) {
              const r = (intVal >> 16) & 0xff;
              const g = (intVal >> 8) & 0xff;
              const b = intVal & 0xff;
              layerColorHex = rgbToHex({ r, g, b });
            }
          } else if (subToken.code === 62 && !layerColorHex) {
            const aci = Math.abs(parseInt(subToken.value, 10));
            if (!isNaN(aci) && aci !== 256 && aci !== 0) {
              layerColorHex = aciToHex(aci);
            }
          }
          tokenIdx++;
        }

        if (layerName) {
          if (!layers[layerName]) {
            layers[layerName] = {
              id: layerName,
              name: layerName,
              visible: true,
              locked: false,
              color: layerColorHex || defaultLayerColor,
            };
          } else if (layerColorHex) {
            layers[layerName].color = layerColorHex;
          }
        }
        continue;
      }
      tokenIdx++;
      continue;
    }

    // C. 解析 BLOCKS 區段 (收集圖塊定義: BLOCK ... ENDBLK)
    if (currentSection === 'BLOCKS' || (token.code === 0 && token.value.toUpperCase() === 'BLOCK')) {
      if (token.code === 0 && token.value.toUpperCase() === 'BLOCK') {
        tokenIdx++; // 消耗 0 -> BLOCK
        let blockName = '';
        let bx = 0;
        let by = 0;

        // 讀取 BLOCK 表頭屬性
        while (tokenIdx < tokens.length && tokens[tokenIdx].code !== 0) {
          const bt = tokens[tokenIdx];
          if (bt.code === 2) {
            blockName = bt.value;
          } else if (bt.code === 10) {
            bx = parseFloat(bt.value) || 0;
          } else if (bt.code === 20) {
            by = parseFloat(bt.value) || 0;
          }
          tokenIdx++;
        }

        const blockEntities: RawBlockEntity[] = [];

        // 收集 BLOCK 內包含的基礎圖元，直至 0 -> ENDBLK
        while (tokenIdx < tokens.length) {
          const subTok = tokens[tokenIdx];
          if (subTok.code !== 0) {
            tokenIdx++;
            continue;
          }

          const subType = subTok.value.toUpperCase();
          if (subType === 'ENDBLK') {
            tokenIdx++; // 消耗 0 -> ENDBLK
            while (tokenIdx < tokens.length && tokens[tokenIdx].code !== 0) {
              tokenIdx++;
            }
            break; // 結束當前圖塊收集
          }

          const rawRes = parseRawEntityFromTokens(tokens, tokenIdx);
          if (rawRes.entity) {
            blockEntities.push(rawRes.entity);
          } else if (rawRes.warning) {
            warnings.push(rawRes.warning);
          }
          tokenIdx = rawRes.nextTokenIdx;
        }

        if (blockName) {
          const blockDef: DxfBlockDefinition = {
            name: blockName,
            basePoint: { x: bx, y: by },
            entities: blockEntities,
          };
          blocks[blockName] = blockDef;
          blocks[blockName.toUpperCase()] = blockDef;
          blocks[blockName.toLowerCase()] = blockDef;
        }
        continue;
      }
      tokenIdx++;
      continue;
    }

    // D. 解析 ENTITIES 區段 (或未聲明 section 時之預設圖元)
    if (currentSection === 'ENTITIES' || currentSection === 'NONE') {
      if (token.code === 0) {
        const entityType = token.value.toUpperCase();

        // 跳過結構標記
        if (
          entityType === 'SECTION' ||
          entityType === 'ENDSEC' ||
          entityType === 'TABLE' ||
          entityType === 'ENDTAB' ||
          entityType === 'BLOCK' ||
          entityType === 'ENDBLK' ||
          entityType === 'EOF'
        ) {
          tokenIdx++;
          continue;
        }

        const rawRes = parseRawEntityFromTokens(tokens, tokenIdx);
        if (rawRes.entity) {
          flattenBlockEntity(
            rawRes.entity,
            createIdentityMatrix(),
            '0',
            undefined,
            0,
            new Set(),
            options,
            warnings,
            layers,
            blocks,
            rawEntities
          );
        }
        if (rawRes.warning) {
          warnings.push(rawRes.warning);
        }
        tokenIdx = rawRes.nextTokenIdx;
        continue;
      }
    }

    tokenIdx++;
  }

  // 3. 單位自適應等比縮放 (Unit Scaling Matrix)
  const scaleFactor = calculateScaleFactor(insunitsCode, targetUnits, customScaleFactor);
  let scaledEntities = rawEntities;

  if (Math.abs(scaleFactor - 1.0) > 1e-6) {
    scaledEntities = applyUnitScaling(rawEntities, scaleFactor);
    warnings.push(
      `Applied unit scaling matrix with factor ${scaleFactor} (source $INSUNITS: ${insunitsCode}, target: ${targetUnits}).`
    );
  }

  // 4. Post-processing: Auto-Stitch Topology Repair (端點容差縫合)
  const autoStitch = options.autoStitch !== false;
  const stitchTolerance = options.stitchTolerance ?? 1e-3;

  let finalEntities: CADEntity2D[] = scaledEntities;
  let stitchStats: { mergedPointsCount: number; removedEntitiesCount: number } | undefined = undefined;

  if (autoStitch && scaledEntities.length > 0) {
    const stitchResult: StitchResult = autoStitchEntities(scaledEntities, {
      tolerance: stitchTolerance,
      removeDegenerate: true,
    });

    finalEntities = stitchResult.entities;
    stitchStats = {
      mergedPointsCount: stitchResult.mergedPointsCount,
      removedEntitiesCount: stitchResult.removedEntitiesCount,
    };

    if (stitchResult.mergedPointsCount > 0) {
      warnings.push(
        `Auto-stitched ${stitchResult.mergedPointsCount} endpoints within ${stitchTolerance}${targetUnits} tolerance.`
      );
    }

    if (stitchResult.removedEntitiesCount > 0) {
      warnings.push(
        `Removed ${stitchResult.removedEntitiesCount} degenerate zero-length entities.`
      );
    }
  }

  return {
    units: targetUnits,
    entities: finalEntities,
    layers,
    warnings,
    ...(stitchStats ? { stitchStats } : {}),
  };
}
