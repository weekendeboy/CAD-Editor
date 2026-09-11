import {
  CADDocument,
  SketchFeature,
  CADLayer,
  CADEntity2D,
  LineEntity,
  CircleEntity,
  ArcEntity,
  PolylineEntity,
} from '../../types/cad';
import { getLayerAci, getEntityAci } from './DxfColorMap';

export interface DxfExportOptions {
  units?: 'mm' | 'inch';
  layers?: Record<string, CADLayer>;
  includeConstruction?: boolean; // 預設 true；若設為 false 則徹底過濾輔助線（CAM 純切割路徑模式）
  constructionLayerName?: string; // 預設 'CONSTRUCTION'
  precision?: number; // 浮點數精度（預設 6）
}

/**
 * 數值格式化輔助函式，避免 NaN、Infinity 以及過度冗長的浮點數微小誤差
 */
function formatNum(val: number, isInt = false, precision = 6): string {
  if (typeof val !== 'number' || !Number.isFinite(val) || Number.isNaN(val)) {
    return isInt ? '0' : '0.0';
  }
  if (isInt) {
    return Math.round(val).toString();
  }
  if (Math.abs(val) < 1e-12) {
    return '0.0';
  }
  const factor = Math.pow(10, Math.max(0, Math.min(12, precision)));
  const rounded = Math.round(val * factor) / factor;
  if (Object.is(rounded, -0) || Math.abs(rounded) < 1e-12) {
    return '0.0';
  }
  return rounded.toString();
}

/**
 * 生成 DXF 群組碼與數值對應列（群組碼佔一行，數值佔下一行）
 */
function group(
  code: number,
  value: string | number,
  isInt = false,
  precision = 6
): string {
  let valStr: string;
  if (typeof value === 'number') {
    valStr = formatNum(value, isInt, precision);
  } else {
    valStr = value ?? '';
  }
  return `${code}\n${valStr}\n`;
}

/**
 * 弧度轉度數，並正規化至 [0, 360) 區間
 */
function radToDeg(rad: number): number {
  if (typeof rad !== 'number' || !Number.isFinite(rad) || Number.isNaN(rad)) {
    return 0;
  }
  let deg = (rad * 180) / Math.PI;
  deg = deg % 360;
  if (deg < 0) {
    deg += 360;
  }
  if (Object.is(deg, -0) || Math.abs(deg - 360) < 1e-9) {
    deg = 0;
  }
  return deg;
}

interface LayerDefinition {
  name: string;
  aci: number;
  linetype: string;
  plotFlag: number; // 1 = 可列印/繪圖, 0 = 不列印 (Non-plotting)
}

/**
 * 生成標準 ASCII DXF (AC1015 / R2000) 內容字串
 */
function generateDxfString(
  entities: CADEntity2D[],
  options?: DxfExportOptions
): string {
  const units = options?.units || 'mm';
  const precision = options?.precision ?? 6;
  const includeConstruction = options?.includeConstruction ?? true;
  const constructionLayerName =
    (options?.constructionLayerName || 'CONSTRUCTION').trim() || 'CONSTRUCTION';

  let dxf = '';

  // 1. HEADER 區段
  dxf += group(0, 'SECTION', false, precision);
  dxf += group(2, 'HEADER', false, precision);
  dxf += group(9, '$ACADVER', false, precision);
  dxf += group(1, 'AC1015', false, precision);
  dxf += group(9, '$INSUNITS', false, precision);
  dxf += group(70, units === 'inch' ? 1 : 4, true, precision);
  dxf += group(9, '$MEASUREMENT', false, precision);
  dxf += group(70, units === 'inch' ? 0 : 1, true, precision);
  dxf += group(0, 'ENDSEC', false, precision);

  // 2. TABLES 區段
  dxf += group(0, 'SECTION', false, precision);
  dxf += group(2, 'TABLES', false, precision);

  // VPORT 表
  dxf += group(0, 'TABLE', false, precision);
  dxf += group(2, 'VPORT', false, precision);
  dxf += group(70, 1, true, precision);
  dxf += group(0, 'VPORT', false, precision);
  dxf += group(2, '*ACTIVE', false, precision);
  dxf += group(10, 0.0, false, precision);
  dxf += group(20, 0.0, false, precision);
  dxf += group(11, 1.0, false, precision);
  dxf += group(21, 1.0, false, precision);
  dxf += group(12, 0.0, false, precision);
  dxf += group(22, 0.0, false, precision);
  dxf += group(13, 0.0, false, precision);
  dxf += group(23, 0.0, false, precision);
  dxf += group(14, 1.0, false, precision);
  dxf += group(24, 1.0, false, precision);
  dxf += group(15, 0.0, false, precision);
  dxf += group(25, 0.0, false, precision);
  dxf += group(70, 0, true, precision);
  dxf += group(0, 'ENDTAB', false, precision);

  // LTYPE 線型表擴充 (CONTINUOUS, DASHED, CENTER)
  dxf += group(0, 'TABLE', false, precision);
  dxf += group(2, 'LTYPE', false, precision);
  dxf += group(70, 3, true, precision);

  // 1. CONTINUOUS
  dxf += group(0, 'LTYPE', false, precision);
  dxf += group(2, 'CONTINUOUS', false, precision);
  dxf += group(70, 0, true, precision);
  dxf += group(3, 'Solid line', false, precision);
  dxf += group(72, 65, true, precision);
  dxf += group(73, 0, true, precision);
  dxf += group(40, 0.0, false, precision);

  // 2. DASHED
  dxf += group(0, 'LTYPE', false, precision);
  dxf += group(2, 'DASHED', false, precision);
  dxf += group(70, 0, true, precision);
  dxf += group(3, 'Dashed line __ __ __ __ __ __ __ __ __ __ __ __ __', false, precision);
  dxf += group(72, 65, true, precision);
  dxf += group(73, 2, true, precision);
  dxf += group(40, 9.525, false, precision);
  dxf += group(49, 6.35, false, precision);
  dxf += group(49, -3.175, false, precision);

  // 3. CENTER
  dxf += group(0, 'LTYPE', false, precision);
  dxf += group(2, 'CENTER', false, precision);
  dxf += group(70, 0, true, precision);
  dxf += group(3, 'Center line ____ _ ____ _ ____ _ ____ _ ____', false, precision);
  dxf += group(72, 65, true, precision);
  dxf += group(73, 4, true, precision);
  dxf += group(40, 22.225, false, precision);
  dxf += group(49, 12.7, false, precision);
  dxf += group(49, -3.175, false, precision);
  dxf += group(49, 3.175, false, precision);
  dxf += group(49, -3.175, false, precision);

  dxf += group(0, 'ENDTAB', false, precision);

  // LAYER 圖層表建立與維護
  const layerMap = new Map<string, LayerDefinition>();

  // 預設圖層 '0'
  layerMap.set('0', {
    name: '0',
    aci: 7,
    linetype: 'CONTINUOUS',
    plotFlag: 1,
  });

  // 載入傳入之 options.layers 字典中的所有圖層
  if (options?.layers) {
    for (const lId of Object.keys(options.layers)) {
      const layer = options.layers[lId];
      if (layer) {
        const layerName = layer.name ? layer.name.trim() : layer.id;
        if (layerName && !layerMap.has(layerName)) {
          layerMap.set(layerName, {
            name: layerName,
            aci: getLayerAci(layer.color),
            linetype: 'CONTINUOUS',
            plotFlag: 1,
          });
        }
      }
    }
  }

  // 自動補增 CONSTRUCTION 建構線專屬隔離圖層 (非繪圖 Non-plotting, Group 290 = 0)
  layerMap.set(constructionLayerName, {
    name: constructionLayerName,
    aci: 6, // 洋紅色 Magenta
    linetype: 'DASHED',
    plotFlag: 0, // Non-plotting 旗標，保護 CAM/雷射切割加工
  });

  // 寫入 AutoCAD 專屬標註參考圖層 DEFPOINTS (Non-plotting, Group 290 = 0)
  if (!layerMap.has('DEFPOINTS')) {
    layerMap.set('DEFPOINTS', {
      name: 'DEFPOINTS',
      aci: 7,
      linetype: 'CONTINUOUS',
      plotFlag: 0,
    });
  }

  dxf += group(0, 'TABLE', false, precision);
  dxf += group(2, 'LAYER', false, precision);
  dxf += group(70, layerMap.size, true, precision);

  for (const [, layerDef] of layerMap) {
    dxf += group(0, 'LAYER', false, precision);
    dxf += group(2, layerDef.name, false, precision);
    dxf += group(70, 0, true, precision);
    dxf += group(62, layerDef.aci, true, precision);
    dxf += group(6, layerDef.linetype, false, precision);
    dxf += group(290, layerDef.plotFlag, true, precision);
  }
  dxf += group(0, 'ENDTAB', false, precision);

  dxf += group(0, 'ENDSEC', false, precision);

  // 3. BLOCKS 區段
  dxf += group(0, 'SECTION', false, precision);
  dxf += group(2, 'BLOCKS', false, precision);
  dxf += group(0, 'ENDSEC', false, precision);

  // 4. ENTITIES 區段圖元分流
  dxf += group(0, 'SECTION', false, precision);
  dxf += group(2, 'ENTITIES', false, precision);

  for (const entity of entities) {
    if (!entity || entity.visible === false) {
      continue;
    }

    const isConstruction = Boolean(entity.isConstruction);

    // 依 includeConstruction 進行初篩 (CAM 純切割路徑模式)
    if (isConstruction && !includeConstruction) {
      continue;
    }

    let layerName = '0';
    let lineType = 'CONTINUOUS';
    let aci = 256; // ByLayer

    if (isConstruction) {
      layerName = constructionLayerName;
      lineType = 'DASHED';
      if (entity.color && entity.color.trim().toLowerCase() !== 'bylayer') {
        aci = getEntityAci(entity.color);
      } else {
        aci = 6; // 未特別自訂覆蓋色時設為 ACI 6 (Magenta)
      }
    } else {
      if (entity.layerId && options?.layers?.[entity.layerId]) {
        const l = options.layers[entity.layerId];
        layerName = l.name ? l.name.trim() : l.id;
      } else if (entity.layerId) {
        layerName = entity.layerId;
      }
      lineType = 'CONTINUOUS';
      if (entity.color && entity.color.trim().toLowerCase() !== 'bylayer') {
        aci = getEntityAci(entity.color);
      } else {
        aci = 256; // ByLayer
      }
    }

    switch (entity.type) {
      case 'line': {
        const line = entity as LineEntity;
        dxf += group(0, 'LINE', false, precision);
        dxf += group(8, layerName, false, precision);
        dxf += group(6, lineType, false, precision);
        if (aci !== 256) {
          dxf += group(62, aci, true, precision);
        }
        dxf += group(10, line.start.x, false, precision);
        dxf += group(20, line.start.y, false, precision);
        dxf += group(30, 0.0, false, precision);
        dxf += group(11, line.end.x, false, precision);
        dxf += group(21, line.end.y, false, precision);
        dxf += group(31, 0.0, false, precision);
        break;
      }
      case 'circle': {
        const circle = entity as CircleEntity;
        dxf += group(0, 'CIRCLE', false, precision);
        dxf += group(8, layerName, false, precision);
        dxf += group(6, lineType, false, precision);
        if (aci !== 256) {
          dxf += group(62, aci, true, precision);
        }
        dxf += group(10, circle.center.x, false, precision);
        dxf += group(20, circle.center.y, false, precision);
        dxf += group(30, 0.0, false, precision);
        dxf += group(40, circle.radius, false, precision);
        break;
      }
      case 'arc': {
        const arc = entity as ArcEntity;
        dxf += group(0, 'ARC', false, precision);
        dxf += group(8, layerName, false, precision);
        dxf += group(6, lineType, false, precision);
        if (aci !== 256) {
          dxf += group(62, aci, true, precision);
        }
        dxf += group(10, arc.center.x, false, precision);
        dxf += group(20, arc.center.y, false, precision);
        dxf += group(30, 0.0, false, precision);
        dxf += group(40, arc.radius, false, precision);
        dxf += group(50, radToDeg(arc.startAngle), false, precision);
        dxf += group(51, radToDeg(arc.endAngle), false, precision);
        break;
      }
      case 'polyline': {
        const poly = entity as PolylineEntity;
        dxf += group(0, 'LWPOLYLINE', false, precision);
        dxf += group(8, layerName, false, precision);
        dxf += group(6, lineType, false, precision);
        if (aci !== 256) {
          dxf += group(62, aci, true, precision);
        }
        const pts = poly.points || [];
        dxf += group(90, pts.length, true, precision);
        dxf += group(70, poly.closed ? 1 : 0, true, precision);

        for (let i = 0; i < pts.length; i++) {
          const pt = pts[i];
          dxf += group(10, pt.x, false, precision);
          dxf += group(20, pt.y, false, precision);
          if (poly.bulges && poly.bulges[i] !== undefined) {
            const bulge = poly.bulges[i];
            if (
              typeof bulge === 'number' &&
              Number.isFinite(bulge) &&
              Math.abs(bulge) > 1e-12
            ) {
              dxf += group(42, bulge, false, precision);
            }
          }
        }
        break;
      }
    }
  }

  dxf += group(0, 'ENDSEC', false, precision);

  // 5. 結尾
  dxf += group(0, 'EOF', false, precision);

  return dxf;
}

/**
 * 匯出單一草圖（SketchFeature）為標準 DXF 字串
 */
export function exportSketchToDxf(
  sketch: SketchFeature,
  options?: DxfExportOptions
): string {
  const entities = sketch?.entities || [];
  return generateDxfString(entities, options);
}

/**
 * 匯出整個 CADDocument（包含 activeSketch 或所有 SketchFeatures）為標準 DXF 字串
 */
export function exportDocumentToDxf(
  doc: CADDocument,
  options?: DxfExportOptions
): string {
  if (!doc) {
    return generateDxfString([], options);
  }

  const entities: CADEntity2D[] = [];
  if (Array.isArray(doc.featureTree)) {
    for (const feature of doc.featureTree) {
      if (
        feature.type === 'SKETCH' &&
        !feature.suppressed &&
        Array.isArray(feature.entities)
      ) {
        entities.push(...feature.entities);
      }
    }
  }

  const mergedOptions: DxfExportOptions = {
    units: options?.units || doc.units || 'mm',
    layers: options?.layers || doc.layers || {},
    includeConstruction: options?.includeConstruction,
    constructionLayerName: options?.constructionLayerName,
    precision: options?.precision,
  };

  return generateDxfString(entities, mergedOptions);
}

/**
 * 瀏覽器端觸發 DXF 檔案下載之輔助函式
 */
export function downloadDxfFile(
  dxfContent: string,
  filename: string = 'drawing.dxf'
): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const safeFilename =
    filename && filename.trim().length > 0 ? filename.trim() : 'drawing.dxf';
  const finalFilename = safeFilename.toLowerCase().endsWith('.dxf')
    ? safeFilename
    : `${safeFilename}.dxf`;

  const blob = new Blob([dxfContent], { type: 'application/dxf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = finalFilename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
