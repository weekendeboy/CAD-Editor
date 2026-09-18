import {
  CADEntity2D,
  LineEntity,
  CircleEntity,
  ArcEntity,
  PolylineEntity,
  InsertEntity,
  CADLayer,
  CADBlockDefinition,
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
  blocks?: Record<string, CADBlockDefinition>;
  warnings: string[];
  stitchStats?: {
    mergedPointsCount: number;
    removedEntitiesCount: number;
  };
}

export interface DxfGroupToken {
  code: number;
  value: string;
  lineNum: number;
}

/**
 * 2D 仿射變換矩陣 (2D Affine Transformation Matrix)
 * 矩陣結構:
 * [ x' ]   [ a  c  tx ] [ x ]
 * [ y' ] = [ b  d  ty ] [ y ]
 * [ 1  ]   [ 0  0  1  ] [ 1 ]
 *
 * 變換公式:
 * x' = a * x + c * y + tx
 * y' = b * x + d * y + ty
 */
export interface AffineMatrix2D {
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
export function createIdentityMatrix(): AffineMatrix2D {
  return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
}

/**
 * 根據圖塊基準點、插入點、縮放係數與旋轉角度建立 INSERT 2D 仿射變換矩陣
 * 幾何變換順序：(P - BasePoint) -> 局部縮放 (Scale) -> 旋轉 (Rotation) -> 平移至插入座標 (InsertionPoint)
 *
 * 數學推導：
 * x' = scaleX * cos(θ) * (x - bx) - scaleY * sin(θ) * (y - by) + insX
 * y' = scaleX * sin(θ) * (x - bx) + scaleY * cos(θ) * (y - by) + insY
 */
export function createInsertMatrix(
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
 * 複合矩陣相乘: M_composite = mOuter * mInner
 */
export function multiplyAffine(mOuter: AffineMatrix2D, mInner: AffineMatrix2D): AffineMatrix2D {
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
export function transformPoint(m: AffineMatrix2D, p: Point2D): Point2D {
  return {
    x: m.a * p.x + m.c * p.y + m.tx,
    y: m.b * p.x + m.d * p.y + m.ty,
  };
}

/**
 * 將弧度角規格化至 [0, 2π) 範圍
 */
export function normalizeAngle(rad: number): number {
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
 * 判斷圖層名稱是否為建構線或輔助不列印圖層
 */
export function isConstructionLayer(layerName: string): boolean {
  if (!layerName) return false;
  const upper = layerName.trim().toUpperCase();
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
      default: // 0 or Unspecified
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
      default: // 0 or Unspecified
        return 1.0;
    }
  }
}

/**
 * 幾何無損等比縮放運算
 * - 針對所有圖元執行頂點與圓心座標換算
 * - 角度與凸度為無因次純量，保持不變
 */
export function applyUnitScaling(entities: CADEntity2D[], scaleFactor: number): CADEntity2D[] {
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
      case 'insert':
        return {
          ...ent,
          position: {
            x: ent.position.x * scaleFactor,
            y: ent.position.y * scaleFactor,
          },
        };
      default:
        return ent;
    }
  });
}

// 原始 DXF 圖元規格介面 (Raw DXF Entity Structures)
export interface RawDxfLine {
  type: 'LINE';
  start: Point2D;
  end: Point2D;
  layer: string;
  color?: string;
  colorIsByBlock?: boolean;
  lineType?: string;
  lineWidth?: number;
}

export interface RawDxfCircle {
  type: 'CIRCLE';
  center: Point2D;
  radius: number;
  layer: string;
  color?: string;
  colorIsByBlock?: boolean;
  lineType?: string;
  lineWidth?: number;
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
  lineType?: string;
  lineWidth?: number;
}

export interface RawDxfPolyline {
  type: 'LWPOLYLINE' | 'POLYLINE';
  points: Point2D[];
  bulges?: number[];
  closed: boolean;
  layer: string;
  color?: string;
  colorIsByBlock?: boolean;
  lineType?: string;
  lineWidth?: number;
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
  lineType?: string;
  lineWidth?: number;
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
 * 產生唯一圖元識別碼
 */
export function generateEntityId(prefix: string): string {
  entityCounter++;
  const rand = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${entityCounter}-${rand}`;
}

/**
 * 記憶體友善型 DXF 流式字彙掃描器 (Zero-Heavy-Allocation Stream Tokenizer)
 * 透過索引掃描行換行符號 (\n)，避免全檔 split 產生的巨量字串陣列負載。
 */
export class DxfStreamTokenizer {
  private content: string;
  private pos: number = 0;
  private len: number;
  private currentLine: number = 0;

  constructor(content: string) {
    // 移除 UTF-8 BOM 標記
    this.content = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    this.len = this.content.length;
  }

  private readLine(): string | null {
    if (this.pos >= this.len) return null;
    let nextNl = this.content.indexOf('\n', this.pos);
    let line: string;
    if (nextNl === -1) {
      line = this.content.substring(this.pos);
      this.pos = this.len;
    } else {
      line = this.content.substring(this.pos, nextNl);
      this.pos = nextNl + 1;
    }
    this.currentLine++;
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    return line;
  }

  public tokenizeAll(warnings: string[]): DxfGroupToken[] {
    const tokens: DxfGroupToken[] = [];
    while (this.pos < this.len) {
      const codeLine = this.readLine();
      if (codeLine === null) break;
      const trimmedCode = codeLine.trim();
      if (trimmedCode.length === 0) continue;

      const code = parseInt(trimmedCode, 10);
      if (isNaN(code)) {
        warnings.push(`Line ${this.currentLine}: Invalid non-numeric group code "${trimmedCode}" ignored.`);
        continue;
      }

      const valLine = this.readLine();
      if (valLine === null) {
        warnings.push(`Line ${this.currentLine}: Unexpected EOF, missing value for group code ${code}.`);
        break;
      }

      // 略過 Group Code 999 註解行
      if (code === 999) {
        continue;
      }

      tokens.push({
        code,
        value: valLine.trim(),
        lineNum: this.currentLine - 1,
      });
    }
    return tokens;
  }
}

/**
 * 解析 TrueColor (群組碼 420, 24-bit RGB) 或 ACI (群組碼 62)
 */
export function extractEntityColor(entityTokens: DxfGroupToken[]): {
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
 * 解析線型 (群組碼 6)
 */
export function extractEntityLineType(entityTokens: DxfGroupToken[]): string | undefined {
  for (const et of entityTokens) {
    if (et.code === 6) {
      return et.value.trim();
    }
  }
  return undefined;
}

/**
 * 解析線寬 (群組碼 370，單位 1/100 mm)
 */
export function extractEntityLineWidth(entityTokens: DxfGroupToken[]): number | undefined {
  for (const et of entityTokens) {
    if (et.code === 370) {
      const val = parseInt(et.value, 10);
      if (Number.isFinite(val) && val > 0) {
        return val / 100;
      }
    }
  }
  return undefined;
}

/**
 * 從 DXF 群組碼 token 集中解析單一原始圖元
 * 容錯過濾：忽略 AutoCAD 2019+ 之 Handle(5)、Subclass(100)、Pointer(330)、Hard Ownership(360) 與 XDATA 雜訊
 */
export function parseRawEntityFromTokens(
  tokens: DxfGroupToken[],
  startIndex: number
): { entity?: RawBlockEntity; warning?: string; nextTokenIdx: number } {
  let tokenIdx = startIndex;
  const startToken = tokens[tokenIdx];
  const entityType = startToken.value.toUpperCase();

  // 1. 處理舊式複合多段線 (POLYLINE + 頂點序列 VERTEX + SEQEND)
  if (entityType === 'POLYLINE') {
    tokenIdx++; // 消耗 0 -> POLYLINE
    let layer = '0';
    let colorHex: string | undefined = undefined;
    let colorIsByBlock = false;
    let isClosed = false;
    let lineType: string | undefined = undefined;
    let lineWidth: number | undefined = undefined;

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
      } else if (pt.code === 6) {
        lineType = pt.value.trim();
      } else if (pt.code === 370) {
        const val = parseInt(pt.value, 10);
        if (Number.isFinite(val) && val > 0) lineWidth = val / 100;
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
          lineType,
          lineWidth,
        },
        nextTokenIdx: tokenIdx,
      };
    }
    return {
      warning: `Line ${startToken.lineNum}: POLYLINE with fewer than 2 valid vertices skipped.`,
      nextTokenIdx: tokenIdx,
    };
  }

  // 2. 收集標準單實體群組碼 (LINE, CIRCLE, ARC, LWPOLYLINE, INSERT, ELLIPSE, SPLINE)
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
  const lineType = extractEntityLineType(entityTokens);
  const lineWidth = extractEntityLineWidth(entityTokens);

  // A. LINE 圖元
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
          lineType,
          lineWidth,
        },
        nextTokenIdx: tokenIdx,
      };
    }
    return {
      warning: `Line ${startToken.lineNum}: Incomplete LINE coordinate definition skipped.`,
      nextTokenIdx: tokenIdx,
    };
  }

  // B. CIRCLE 圖元
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
          lineType,
          lineWidth,
        },
        nextTokenIdx: tokenIdx,
      };
    }
    return {
      warning: `Line ${startToken.lineNum}: Incomplete or non-positive CIRCLE definition skipped.`,
      nextTokenIdx: tokenIdx,
    };
  }

  // C. ARC 圖元
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
          lineType,
          lineWidth,
        },
        nextTokenIdx: tokenIdx,
      };
    }
    return {
      warning: `Line ${startToken.lineNum}: Incomplete or invalid ARC definition skipped.`,
      nextTokenIdx: tokenIdx,
    };
  }

  // D. LWPOLYLINE 輕量多段線
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
    }

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
          lineType,
          lineWidth,
        },
        nextTokenIdx: tokenIdx,
      };
    }
    return {
      warning: `Line ${startToken.lineNum}: LWPOLYLINE with fewer than 2 valid vertices skipped.`,
      nextTokenIdx: tokenIdx,
    };
  }

  // E. INSERT 圖塊參照
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
          lineType,
          lineWidth,
        },
        nextTokenIdx: tokenIdx,
      };
    }
    return {
      warning: `Line ${startToken.lineNum}: INSERT missing block name (Group Code 2) skipped.`,
      nextTokenIdx: tokenIdx,
    };
  }

  // F. ELLIPSE 橢圓圖元支援轉換
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
      if (Math.abs(ratio - 1.0) < 1e-4 && Math.abs(endParam - startParam - Math.PI * 2) < 1e-4) {
        return {
          entity: {
            type: 'CIRCLE',
            center: { x: cx, y: cy },
            radius: majorLen,
            layer,
            color: colorHex,
            colorIsByBlock,
            lineType,
            lineWidth,
          },
          nextTokenIdx: tokenIdx,
        };
      }

      // 橢圓離散化為高精度 LWPOLYLINE 多段線
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
          lineType,
          lineWidth,
        },
        nextTokenIdx: tokenIdx,
      };
    }
  }

  // G. SPLINE 雲狀線支援轉換
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
          lineType,
          lineWidth,
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
 *
 * 【色彩與圖層穿透規則】：
 * 1. 圖層穿透：若圖元位於圖層 '0'，動態繼承外層 INSERT 指定之圖層 parentLayer；否則保留自身圖層。
 * 2. 色彩穿透：
 *    - ByBlock (群組碼 62=0 或 colorIsByBlock)：繼承 INSERT 的色彩 parentColor（若未指定則繼承 parentLayer 顏色）。
 *    - ByLayer (群組碼 62=256 或未指定)：繼承該圖元圖層 (resolvedLayer) 之顏色。
 *    - 實體自定義色彩 (ACI 1~255 或 TrueColor)：完整保留該圖元色彩。
 */
export function flattenBlockEntity(
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

  // 1. 圖層解析
  const resolvedLayer = !rawEnt.layer || rawEnt.layer === '0' ? parentLayer : rawEnt.layer;

  // 動態註冊未在 TABLES 中定義之圖層
  if (!layers[resolvedLayer]) {
    const isConst = isConstructionLayer(resolvedLayer);
    layers[resolvedLayer] = {
      id: resolvedLayer,
      name: resolvedLayer,
      visible: true,
      locked: false,
      color: resolvedLayer === '0' ? defaultLayerColor : (isConst ? '#FF00FF' : defaultLayerColor),
      aciColor: isConst ? 6 : 7,
      lineType: isConst ? 'DASHED' : 'CONTINUOUS',
      lineWidth: 0.25,
      isPlot: !isConst && resolvedLayer.toUpperCase() !== 'DEFPOINTS',
    };
  }

  // 2. 色彩穿透解析
  let resolvedColor: string | undefined;
  if (rawEnt.colorIsByBlock) {
    resolvedColor = parentColor || layers[parentLayer]?.color || layers[resolvedLayer]?.color || defaultLayerColor;
  } else if (rawEnt.color !== undefined) {
    resolvedColor = rawEnt.color;
  } else {
    resolvedColor = layers[resolvedLayer]?.color || defaultLayerColor;
  }

  const isConstruction = isConstructionLayer(resolvedLayer);
  const resolvedLineType = rawEnt.lineType || layers[resolvedLayer]?.lineType || 'CONTINUOUS';
  const resolvedLineWidth = rawEnt.lineWidth !== undefined ? rawEnt.lineWidth : layers[resolvedLayer]?.lineWidth;

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
    } else {
      const insPoint = transformPoint(m, rawEnt.insertionPoint);
      const sx = Math.hypot(m.a, m.b) * rawEnt.scaleX;
      const sy = Math.hypot(m.c, m.d) * rawEnt.scaleY;
      const rot = normalizeAngle((rawEnt.rotationDeg * Math.PI) / 180 + Math.atan2(m.b, m.a));

      const insertEntity: InsertEntity = {
        id: generateEntityId('insert'),
        type: 'insert',
        blockName: rawEnt.blockName,
        position: insPoint,
        scale: { x: sx, y: sy },
        rotation: rot,
        layerId: resolvedLayer,
        visible: true,
        locked: false,
        color: resolvedColor,
        lineType: resolvedLineType,
        lineWidth: resolvedLineWidth,
        ...(isConstruction ? { isConstruction: true } : {}),
      };
      outEntities.push(insertEntity);
    }
    return;
  }

  // 1. LINE 圖元
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
      color: resolvedColor,
      lineType: resolvedLineType,
      lineWidth: resolvedLineWidth,
      ...(isConstruction ? { isConstruction: true } : {}),
    };
    outEntities.push(lineEntity);
    return;
  }

  // 2. CIRCLE 圖元
  if (rawEnt.type === 'CIRCLE') {
    const centerTrans = transformPoint(m, rawEnt.center);
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);

    let radiusTrans = rawEnt.radius * sx;
    if (Math.abs(sx - sy) >= 1e-5) {
      radiusTrans = rawEnt.radius * Math.sqrt(sx * sy);
      warnings.push(
        `Non-uniform scaling (scaleX=${sx.toFixed(4)}, scaleY=${sy.toFixed(4)}) applied to CIRCLE; approximated with geometric mean radius.`
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
      color: resolvedColor,
      lineType: resolvedLineType,
      lineWidth: resolvedLineWidth,
      ...(isConstruction ? { isConstruction: true } : {}),
    };
    outEntities.push(circleEntity);
    return;
  }

  // 3. ARC 圖元
  if (rawEnt.type === 'ARC') {
    const centerTrans = transformPoint(m, rawEnt.center);
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);

    let radiusTrans = rawEnt.radius * sx;
    if (Math.abs(sx - sy) >= 1e-5) {
      radiusTrans = rawEnt.radius * Math.sqrt(sx * sy);
      warnings.push(
        `Non-uniform scaling (scaleX=${sx.toFixed(4)}, scaleY=${sy.toFixed(4)}) applied to ARC; approximated with geometric mean radius.`
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

    // 鏡射反轉 (det < 0) 處理：若行列式小於 0 則為順時針弧 (clockwise = true)
    const det = m.a * m.d - m.b * m.c;
    const isClockwise = det < 0;

    const arcEntity: ArcEntity = {
      id: generateEntityId('arc'),
      type: 'arc',
      center: centerTrans,
      radius: radiusTrans,
      startAngle: newStartAngle,
      endAngle: newEndAngle,
      clockwise: isClockwise,
      layerId: resolvedLayer,
      visible: true,
      locked: false,
      color: resolvedColor,
      lineType: resolvedLineType,
      lineWidth: resolvedLineWidth,
      ...(isConstruction ? { isConstruction: true } : {}),
    };
    outEntities.push(arcEntity);
    return;
  }

  // 4. LWPOLYLINE / POLYLINE 圖元
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
      color: resolvedColor,
      lineType: resolvedLineType,
      lineWidth: resolvedLineWidth,
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
 * 展平 INSERT 圖塊參照 (Flatten Block Reference)
 *
 * 【防護機制】：
 * 1. visitedBlocks 追蹤集合防止 A -> B -> A 循環巢狀圖塊死鎖。
 * 2. 嚴格限制最大遞迴深度（預設 8 層），超過時安全終止。
 * 3. 依序複合仿射變換矩陣：[縮放 -> 旋轉 -> 平移]。
 */
export function flattenInsert(
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
      `Maximum block nesting depth (${maxDepth}) reached for block "${rawInsert.blockName}", skipping nested insertion to prevent recursion deadlock.`
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
    warnings.push(`Circular block reference detected for block "${blockDef.name}", skipped to avoid infinite recursion.`);
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
  const effectiveColor = rawInsert.colorIsByBlock
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
 * 解析標準 ASCII DXF 檔案文字，完整執行 TABLES 圖層表提取、BLOCKS 圖塊提取、INSERT 仿射展開、單位縮放與 Auto-Stitch 拓撲縫合
 *
 * @param dxfContent DXF 純文字內容
 * @param options 解析設定選項
 * @returns 解析結果 (單位, 展開縮放與縫合後的圖元陣列, 圖層字典, 圖塊字典, 警告訊息清單, Auto-Stitch 統計資料)
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
      aciColor: 7,
      lineType: 'CONTINUOUS',
      lineWidth: 0.25,
      isPlot: true,
    },
  };

  let insunitsCode = 0; // 0 = 未指定

  if (!dxfContent || typeof dxfContent !== 'string' || dxfContent.trim().length === 0) {
    return {
      units: targetUnits,
      entities: [],
      layers,
      blocks: {},
      warnings: ['DXF content is empty or invalid.'],
    };
  }

  // 1. 流式 Group Code 掃描器 (防止大檔案記憶體暴增)
  const tokenizer = new DxfStreamTokenizer(dxfContent);
  const tokens = tokenizer.tokenizeAll(warnings);

  if (tokens.length === 0) {
    return {
      units: targetUnits,
      entities: [],
      layers,
      blocks: {},
      warnings: ['No valid DXF group code tokens found in content.'],
    };
  }

  // 2. 區段狀態機與圖層/圖塊收集器
  const dxfBlocks: Record<string, DxfBlockDefinition> = {};
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

    // EOF 結束判斷
    if (token.code === 0 && token.value.toUpperCase() === 'EOF') {
      break;
    }

    // A. 解析 HEADER 區段 (讀取單位代碼 $INSUNITS)
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

    // B. 解析 TABLES 區段 (精準解析 LAYER 表)
    if (currentSection === 'TABLES') {
      if (token.code === 0 && token.value.toUpperCase() === 'LAYER') {
        tokenIdx++;
        let layerName = '';
        let aciColor = 7;
        let colorHex: string | undefined = undefined;
        let lineTypeName = 'CONTINUOUS';
        let isPlot = true;
        let isVisible = true;
        let isLocked = false;
        let lineWidth = 0.25;

        while (tokenIdx < tokens.length && tokens[tokenIdx].code !== 0) {
          const subToken = tokens[tokenIdx];
          if (subToken.code === 2) {
            layerName = subToken.value.trim();
          } else if (subToken.code === 420) {
            const intVal = parseInt(subToken.value, 10);
            if (Number.isFinite(intVal) && intVal >= 0) {
              const r = (intVal >> 16) & 0xff;
              const g = (intVal >> 8) & 0xff;
              const b = intVal & 0xff;
              colorHex = rgbToHex({ r, g, b });
            }
          } else if (subToken.code === 62) {
            const rawAci = parseInt(subToken.value, 10);
            if (Number.isFinite(rawAci)) {
              if (rawAci < 0) {
                isVisible = false; // 負值代表圖層被關閉 (Off)
              }
              const absAci = Math.abs(rawAci);
              aciColor = absAci;
              if (!colorHex && absAci !== 0 && absAci !== 256) {
                colorHex = aciToHex(absAci);
              }
            }
          } else if (subToken.code === 6) {
            lineTypeName = subToken.value.trim();
          } else if (subToken.code === 290) {
            const pVal = parseInt(subToken.value, 10);
            isPlot = pVal !== 0;
          } else if (subToken.code === 70) {
            const flags = parseInt(subToken.value, 10);
            if (Number.isFinite(flags)) {
              if ((flags & 1) !== 0) isVisible = false; // 凍結 (Frozen)
              if ((flags & 4) !== 0) isLocked = true;   // 鎖定 (Locked)
            }
          } else if (subToken.code === 370) {
            const lw = parseInt(subToken.value, 10);
            if (Number.isFinite(lw) && lw > 0) {
              lineWidth = lw / 100;
            }
          }
          tokenIdx++;
        }

        if (layerName) {
          const isConst = isConstructionLayer(layerName);
          let mappedLineType: 'CONTINUOUS' | 'DASHED' | 'CENTER' = 'CONTINUOUS';
          const upperLT = lineTypeName.toUpperCase();
          if (upperLT.includes('DASH') || upperLT.includes('HIDDEN')) {
            mappedLineType = 'DASHED';
          } else if (upperLT.includes('CENTER')) {
            mappedLineType = 'CENTER';
          }
          if (isConst) {
            mappedLineType = 'DASHED';
          }

          const resolvedLayerColor = colorHex || (isConst ? '#FF00FF' : defaultLayerColor);
          const resolvedIsPlot = isConst || layerName.toUpperCase() === 'DEFPOINTS' ? false : isPlot;

          layers[layerName] = {
            id: layerName,
            name: layerName,
            visible: isVisible,
            locked: isLocked,
            color: resolvedLayerColor,
            aciColor: isConst ? 6 : aciColor,
            lineType: mappedLineType,
            lineWidth,
            isPlot: resolvedIsPlot,
          };
        }
        continue;
      }
      tokenIdx++;
      continue;
    }

    // C. 解析 BLOCKS 區段 (提取 BLOCK ... ENDBLK)
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
            blockName = bt.value.trim();
          } else if (bt.code === 3 && !blockName) {
            blockName = bt.value.trim();
          } else if (bt.code === 10) {
            bx = parseFloat(bt.value) || 0;
          } else if (bt.code === 20) {
            by = parseFloat(bt.value) || 0;
          }
          tokenIdx++;
        }

        const blockEntities: RawBlockEntity[] = [];

        // 收集 BLOCK 內部的所有原型實體直至 0 -> ENDBLK
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
            break;
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
          dxfBlocks[blockName] = blockDef;
          dxfBlocks[blockName.toUpperCase()] = blockDef;
          dxfBlocks[blockName.toLowerCase()] = blockDef;
        }
        continue;
      }
      tokenIdx++;
      continue;
    }

    // D. 解析 ENTITIES 區段 (或無區段宣告之通用幾何圖元)
    if (currentSection === 'ENTITIES' || currentSection === 'NONE') {
      if (token.code === 0) {
        const entityType = token.value.toUpperCase();

        // 忽略非圖元結構控制標記
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
            dxfBlocks,
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

  // 3. 彙整輸出 CADBlockDefinition 快取字典
  const parsedBlocks: Record<string, CADBlockDefinition> = {};
  for (const [name, def] of Object.entries(dxfBlocks)) {
    // 避免重複寫入大小寫別名
    if (parsedBlocks[def.name]) continue;

    const cadBlockEntities: CADEntity2D[] = [];
    for (const rawEnt of def.entities) {
      flattenBlockEntity(
        rawEnt,
        createIdentityMatrix(),
        '0',
        undefined,
        0,
        new Set(),
        { ...options, flattenBlocks: false },
        warnings,
        layers,
        dxfBlocks,
        cadBlockEntities
      );
    }

    parsedBlocks[def.name] = {
      id: `block-${def.name}`,
      name: def.name,
      basePoint: { ...def.basePoint },
      entities: cadBlockEntities,
    };
  }

  // 4. 單位自適應等比縮放運算 (Unit Scaling Matrix)
  const scaleFactor = calculateScaleFactor(insunitsCode, targetUnits, customScaleFactor);
  let scaledEntities = rawEntities;

  if (Math.abs(scaleFactor - 1.0) > 1e-6) {
    scaledEntities = applyUnitScaling(rawEntities, scaleFactor);

    // 同步縮放快取圖塊之原型圖元與基準點
    for (const [name, blk] of Object.entries(parsedBlocks)) {
      parsedBlocks[name] = {
        ...blk,
        basePoint: { x: blk.basePoint.x * scaleFactor, y: blk.basePoint.y * scaleFactor },
        entities: applyUnitScaling(blk.entities, scaleFactor),
      };
    }

    warnings.push(
      `Applied unit scaling matrix with factor ${scaleFactor} (source $INSUNITS: ${insunitsCode}, target: ${targetUnits}).`
    );
  }

  // 5. 拓撲後處理：Auto-Stitch 端點容差縫合
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
    blocks: parsedBlocks,
    warnings,
    ...(stitchStats ? { stitchStats } : {}),
  };
}
