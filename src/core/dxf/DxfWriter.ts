import { SketchFeature, CADLayer } from '../../types/cad';

export interface DxfExportOptions {
  units?: 'mm' | 'inch';
  layers?: Record<string, CADLayer>;
  includeConstruction?: boolean;
  constructionLayerName?: string;
  precision?: number;
}

export interface DxfValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 驗證 DXF 結構是否符合 AutoCAD AC1015 / R2000 標準規範
 */
export function validateDxfStructure(dxfContent: string): DxfValidationResult {
  const errors: string[] = [];

  // 1. 檢查所有必需的 SECTION
  const requiredSections = ['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS'];
  for (const sec of requiredSections) {
    const secRegex = new RegExp(`0\\r?\\nSECTION\\r?\\n2\\r?\\n${sec}\\r?\\n`, 'm');
    if (!secRegex.test(dxfContent)) {
      errors.push(`缺少必需的 Section: ${sec}`);
    }
  }

  // 2. 檢查 TABLES 內必需的 9 組符號表
  const requiredTables = [
    'VPORT',
    'LTYPE',
    'LAYER',
    'STYLE',
    'VIEW',
    'UCS',
    'APPID',
    'DIMSTYLE',
    'BLOCK_RECORD',
  ];
  for (const tab of requiredTables) {
    const tabRegex = new RegExp(`0\\r?\\nTABLE\\r?\\n2\\r?\\n${tab}\\r?\\n`, 'm');
    if (!tabRegex.test(dxfContent)) {
      errors.push(`TABLES 中缺少必需的 SymbolTable: ${tab}`);
    }
  }

  // 3. 檢查 LTYPE 表中必需的默認線型 (ByBlock, ByLayer, Continuous)
  const requiredLtypes = ['ByBlock', 'ByLayer', 'Continuous'];
  for (const lt of requiredLtypes) {
    const ltRegex = new RegExp(`0\\r?\\nLTYPE\\r?\\n[\\s\\S]*?2\\r?\\n${lt}\\r?\\n`, 'i');
    if (!ltRegex.test(dxfContent)) {
      errors.push(`LTYPE 表中缺少必需的預設線型: ${lt}`);
    }
  }

  // 4. 檢查 LAYER 表中必需的 0 圖層
  if (!/0\r?\nLAYER\r?\n[\s\S]*?2\r?\n0\r?\n/.test(dxfContent)) {
    errors.push('LAYER 表中缺少必需的預設圖層: 0');
  }

  // 5. 檢查 BLOCK_RECORD 與 BLOCKS 必需的空間
  if (!/2\r?\n\*Model_Space\r?\n/.test(dxfContent)) {
    errors.push('缺少必需的 Model_Space 區塊');
  }
  if (!/2\r?\n\*Paper_Space\r?\n/.test(dxfContent)) {
    errors.push('缺少必需的 Paper_Space 區塊');
  }

  // 6. 檢查檔案結尾 EOF
  if (!/0\r?\nEOF\r?\n?$/.test(dxfContent.trim())) {
    errors.push('缺少檔案結尾標記: 0\\nEOF');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function exportSketchToDxf(
  sketch: SketchFeature,
  options?: DxfExportOptions
): string {
  let out = '';
  const append = (code: number, value: string | number) => {
    out += `${code}\n${value}\n`;
  };

  // AC1015 Handle 管理器
  let handleCounter = 16;
  const nextHandle = () => (handleCounter++).toString(16).toUpperCase();

  // TABLES Handles
  const hVportTab = nextHandle();
  const hLtypeTab = nextHandle();
  const hLayerTab = nextHandle();
  const hStyleTab = nextHandle();
  const hViewTab = nextHandle();
  const hUcsTab = nextHandle();
  const hAppidTab = nextHandle();
  const hDimstyleTab = nextHandle();
  const hBlockRecordTab = nextHandle();

  // BLOCK_RECORD Handles
  const hBrcModel = nextHandle();
  const hBrcPaper = nextHandle();
  const hBrcPaper0 = nextHandle();

  // Root Dictionary Handle
  const hRootDict = nextHandle();

  // ==========================================
  // 1. HEADER 區段
  // ==========================================
  append(0, 'SECTION');
  append(2, 'HEADER');
  append(9, '$ACADVER');
  append(1, 'AC1015');
  append(9, '$HANDSEED');
  append(5, 'FFFF'); // 檔案末端替換為實際最大 Handle
  append(9, '$INSUNITS');
  append(70, options?.units === 'inch' ? 1 : 4);
  append(9, '$MEASUREMENT');
  append(70, options?.units === 'inch' ? 0 : 1);
  append(0, 'ENDSEC');

  // ==========================================
  // 2. CLASSES 區段 (AC1015+ 必備)
  // ==========================================
  append(0, 'SECTION');
  append(2, 'CLASSES');
  append(0, 'ENDSEC');

  // ==========================================
  // 3. TABLES 區段 (9 大標準表)
  // ==========================================
  append(0, 'SECTION');
  append(2, 'TABLES');

  // --- 3.1 VPORT 表 ---
  append(0, 'TABLE');
  append(2, 'VPORT');
  append(5, hVportTab);
  append(330, '0');
  append(100, 'AcDbSymbolTable');
  append(70, 1);
  const hVportRec = nextHandle();
  append(0, 'VPORT');
  append(5, hVportRec);
  append(330, hVportTab);
  append(100, 'AcDbSymbolTableRecord');
  append(100, 'AcDbViewportTableRecord');
  append(2, '*ACTIVE');
  append(70, 0);
  append(10, 0.0); append(20, 0.0);
  append(11, 1.0); append(21, 1.0);
  append(12, 0.0); append(22, 0.0);
  append(13, 0.0); append(23, 0.0);
  append(14, 1.0); append(24, 1.0);
  append(15, 0.0); append(25, 0.0);
  append(0, 'ENDTAB');

  // --- 3.2 LTYPE 表 (ByBlock, ByLayer, Continuous, DASHED) ---
  append(0, 'TABLE');
  append(2, 'LTYPE');
  append(5, hLtypeTab);
  append(330, '0');
  append(100, 'AcDbSymbolTable');
  append(70, 4);

  // ByBlock
  const hLtypeByBlock = nextHandle();
  append(0, 'LTYPE');
  append(5, hLtypeByBlock);
  append(330, hLtypeTab);
  append(100, 'AcDbSymbolTableRecord');
  append(100, 'AcDbLinetypeTableRecord');
  append(2, 'ByBlock');
  append(70, 0);
  append(3, '');
  append(72, 65);
  append(73, 0);
  append(40, 0.0);

  // ByLayer
  const hLtypeByLayer = nextHandle();
  append(0, 'LTYPE');
  append(5, hLtypeByLayer);
  append(330, hLtypeTab);
  append(100, 'AcDbSymbolTableRecord');
  append(100, 'AcDbLinetypeTableRecord');
  append(2, 'ByLayer');
  append(70, 0);
  append(3, '');
  append(72, 65);
  append(73, 0);
  append(40, 0.0);

  // Continuous
  const hLtypeCont = nextHandle();
  append(0, 'LTYPE');
  append(5, hLtypeCont);
  append(330, hLtypeTab);
  append(100, 'AcDbSymbolTableRecord');
  append(100, 'AcDbLinetypeTableRecord');
  append(2, 'Continuous');
  append(70, 0);
  append(3, 'Solid line');
  append(72, 65);
  append(73, 0);
  append(40, 0.0);

  // DASHED
  const hLtypeDash = nextHandle();
  append(0, 'LTYPE');
  append(5, hLtypeDash);
  append(330, hLtypeTab);
  append(100, 'AcDbSymbolTableRecord');
  append(100, 'AcDbLinetypeTableRecord');
  append(2, 'DASHED');
  append(70, 0);
  append(3, 'Dashed line __ __ __');
  append(72, 65);
  append(73, 2);
  append(40, 9.525);
  append(49, 6.35);
  append(74, 0);
  append(49, -3.175);
  append(74, 0);
  append(0, 'ENDTAB');

  // --- 3.3 LAYER 表 ---
  append(0, 'TABLE');
  append(2, 'LAYER');
  append(5, hLayerTab);
  append(330, '0');
  append(100, 'AcDbSymbolTable');
  append(70, 2);

  const hLayer0 = nextHandle();
  append(0, 'LAYER');
  append(5, hLayer0);
  append(330, hLayerTab);
  append(100, 'AcDbSymbolTableRecord');
  append(100, 'AcDbLayerTableRecord');
  append(2, '0');
  append(70, 0);
  append(62, 7);
  append(6, 'Continuous');
  append(370, -3);
  append(390, hRootDict);

  const constLayerName = options?.constructionLayerName || 'CONSTRUCTION';
  const hLayerConst = nextHandle();
  append(0, 'LAYER');
  append(5, hLayerConst);
  append(330, hLayerTab);
  append(100, 'AcDbSymbolTableRecord');
  append(100, 'AcDbLayerTableRecord');
  append(2, constLayerName);
  append(70, 0);
  append(62, 6);
  append(6, 'DASHED');
  append(290, 0); // Non-plotting
  append(370, -3);
  append(390, hRootDict);
  append(0, 'ENDTAB');

  // --- 3.4 STYLE 表 ---
  append(0, 'TABLE');
  append(2, 'STYLE');
  append(5, hStyleTab);
  append(330, '0');
  append(100, 'AcDbSymbolTable');
  append(70, 1);
  const hStyle = nextHandle();
  append(0, 'STYLE');
  append(5, hStyle);
  append(330, hStyleTab);
  append(100, 'AcDbSymbolTableRecord');
  append(100, 'AcDbTextStyleTableRecord');
  append(2, 'Standard');
  append(70, 0);
  append(40, 0.0);
  append(41, 1.0);
  append(50, 0.0);
  append(71, 0);
  append(42, 2.5);
  append(3, 'txt');
  append(4, '');
  append(0, 'ENDTAB');

  // --- 3.5 VIEW 表 ---
  append(0, 'TABLE');
  append(2, 'VIEW');
  append(5, hViewTab);
  append(330, '0');
  append(100, 'AcDbSymbolTable');
  append(70, 0);
  append(0, 'ENDTAB');

  // --- 3.6 UCS 表 ---
  append(0, 'TABLE');
  append(2, 'UCS');
  append(5, hUcsTab);
  append(330, '0');
  append(100, 'AcDbSymbolTable');
  append(70, 0);
  append(0, 'ENDTAB');

  // --- 3.7 APPID 表 ---
  append(0, 'TABLE');
  append(2, 'APPID');
  append(5, hAppidTab);
  append(330, '0');
  append(100, 'AcDbSymbolTable');
  append(70, 1);
  const hAppid = nextHandle();
  append(0, 'APPID');
  append(5, hAppid);
  append(330, hAppidTab);
  append(100, 'AcDbSymbolTableRecord');
  append(100, 'AcDbRegAppTableRecord');
  append(2, 'ACAD');
  append(70, 0);
  append(0, 'ENDTAB');

  // --- 3.8 DIMSTYLE 表 ---
  append(0, 'TABLE');
  append(2, 'DIMSTYLE');
  append(5, hDimstyleTab);
  append(330, '0');
  append(100, 'AcDbSymbolTable');
  append(70, 1);
  append(100, 'AcDbDimStyleTable');
  const hDimstyle = nextHandle();
  append(0, 'DIMSTYLE');
  append(105, hDimstyle);
  append(330, hDimstyleTab);
  append(100, 'AcDbSymbolTableRecord');
  append(100, 'AcDbDimStyleTableRecord');
  append(2, 'Standard');
  append(70, 0);
  append(0, 'ENDTAB');

  // --- 3.9 BLOCK_RECORD 表 ---
  append(0, 'TABLE');
  append(2, 'BLOCK_RECORD');
  append(5, hBlockRecordTab);
  append(330, '0');
  append(100, 'AcDbSymbolTable');
  append(70, 3);

  append(0, 'BLOCK_RECORD');
  append(5, hBrcModel);
  append(330, hBlockRecordTab);
  append(100, 'AcDbSymbolTableRecord');
  append(100, 'AcDbBlockTableRecord');
  append(2, '*Model_Space');

  append(0, 'BLOCK_RECORD');
  append(5, hBrcPaper);
  append(330, hBlockRecordTab);
  append(100, 'AcDbSymbolTableRecord');
  append(100, 'AcDbBlockTableRecord');
  append(2, '*Paper_Space');

  append(0, 'BLOCK_RECORD');
  append(5, hBrcPaper0);
  append(330, hBlockRecordTab);
  append(100, 'AcDbSymbolTableRecord');
  append(100, 'AcDbBlockTableRecord');
  append(2, '*Paper_Space0');

  append(0, 'ENDTAB');
  append(0, 'ENDSEC');

  // ==========================================
  // 4. BLOCKS 區段
  // ==========================================
  append(0, 'SECTION');
  append(2, 'BLOCKS');

  // *Model_Space Block
  const hBlkModel = nextHandle();
  append(0, 'BLOCK');
  append(5, hBlkModel);
  append(330, hBrcModel);
  append(100, 'AcDbEntity');
  append(8, '0');
  append(100, 'AcDbBlockBegin');
  append(2, '*Model_Space');
  append(70, 0);
  append(10, 0.0); append(20, 0.0); append(30, 0.0);
  append(3, '*Model_Space');
  append(1, '');
  const hEndBlkModel = nextHandle();
  append(0, 'ENDBLK');
  append(5, hEndBlkModel);
  append(330, hBrcModel);
  append(100, 'AcDbEntity');
  append(8, '0');
  append(100, 'AcDbBlockEnd');

  // *Paper_Space Block
  const hBlkPaper = nextHandle();
  append(0, 'BLOCK');
  append(5, hBlkPaper);
  append(330, hBrcPaper);
  append(100, 'AcDbEntity');
  append(8, '0');
  append(100, 'AcDbBlockBegin');
  append(2, '*Paper_Space');
  append(70, 0);
  append(10, 0.0); append(20, 0.0); append(30, 0.0);
  append(3, '*Paper_Space');
  append(1, '');
  const hEndBlkPaper = nextHandle();
  append(0, 'ENDBLK');
  append(5, hEndBlkPaper);
  append(330, hBrcPaper);
  append(100, 'AcDbEntity');
  append(8, '0');
  append(100, 'AcDbBlockEnd');

  // *Paper_Space0 Block
  const hBlkPaper0 = nextHandle();
  append(0, 'BLOCK');
  append(5, hBlkPaper0);
  append(330, hBrcPaper0);
  append(100, 'AcDbEntity');
  append(8, '0');
  append(100, 'AcDbBlockBegin');
  append(2, '*Paper_Space0');
  append(70, 0);
  append(10, 0.0); append(20, 0.0); append(30, 0.0);
  append(3, '*Paper_Space0');
  append(1, '');
  const hEndBlkPaper0 = nextHandle();
  append(0, 'ENDBLK');
  append(5, hEndBlkPaper0);
  append(330, hBrcPaper0);
  append(100, 'AcDbEntity');
  append(8, '0');
  append(100, 'AcDbBlockEnd');

  append(0, 'ENDSEC');

  // ==========================================
  // 5. ENTITIES 區段
  // ==========================================
  append(0, 'SECTION');
  append(2, 'ENTITIES');

  const includeConst = options?.includeConstruction !== false;

  for (const ent of sketch.entities) {
    if (!includeConst && ent.isConstruction) continue;

    const layerName = ent.isConstruction ? constLayerName : (ent.layerId || '0');
    const ltype = ent.isConstruction ? 'DASHED' : 'Continuous';

    const writeCommon = (type: string, subclass: string) => {
      append(0, type);
      append(5, nextHandle());
      append(330, hBrcModel);
      append(100, 'AcDbEntity');
      append(8, layerName);
      append(6, ltype);
      append(100, subclass);
    };

    if (ent.type === 'line') {
      writeCommon('LINE', 'AcDbLine');
      append(10, ent.start.x); append(20, ent.start.y); append(30, 0.0);
      append(11, ent.end.x); append(21, ent.end.y); append(31, 0.0);
    } else if (ent.type === 'circle') {
      writeCommon('CIRCLE', 'AcDbCircle');
      append(10, ent.center.x); append(20, ent.center.y); append(30, 0.0);
      append(40, ent.radius);
    } else if (ent.type === 'arc') {
      writeCommon('ARC', 'AcDbCircle');
      append(10, ent.center.x); append(20, ent.center.y); append(30, 0.0);
      append(40, ent.radius);
      append(100, 'AcDbArc');
      const startDeg = (ent.startAngle * 180.0) / Math.PI;
      const endDeg = (ent.endAngle * 180.0) / Math.PI;
      append(50, startDeg);
      append(51, endDeg);
    } else if (ent.type === 'polyline') {
      writeCommon('LWPOLYLINE', 'AcDbPolyline');
      append(90, ent.points.length);
      append(70, ent.closed ? 1 : 0);
      for (let i = 0; i < ent.points.length; i++) {
        append(10, ent.points[i].x);
        append(20, ent.points[i].y);
        if (ent.bulges && ent.bulges[i]) {
          append(42, ent.bulges[i]);
        }
      }
    }
  }

  append(0, 'ENDSEC');

  // ==========================================
  // 6. OBJECTS 區段 (AC1015+ 必備 Root Dictionary)
  // ==========================================
  append(0, 'SECTION');
  append(2, 'OBJECTS');
  append(0, 'DICTIONARY');
  append(5, hRootDict);
  append(330, '0');
  append(100, 'AcDbDictionary');
  append(281, 1);
  append(0, 'ENDSEC');

  // ==========================================
  // 7. EOF 檔案結尾
  // ==========================================
  append(0, 'EOF');

  // 替換 HANDSEED 為下一個可用 Handle
  out = out.replace('FFFF', nextHandle());

  // 執行結構校驗
  const validation = validateDxfStructure(out);
  if (!validation.valid) {
    console.error('DXF 導出校驗失敗:', validation.errors);
    throw new Error(`DXF 導出校驗失敗:\n${validation.errors.join('\n')}`);
  }

  return out;
}

export function downloadDxfFile(dxfContent: string, filename: string = 'sketch.dxf'): void {
  const blob = new Blob([dxfContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

