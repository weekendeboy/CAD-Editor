import { solidEngine } from '../core/3d/SolidEngine';

/**
 * 檢查特徵樹中是否包含 3D 實體特徵 (EXTRUDE, CUT_EXTRUDE, REVOLVE, REVOLVE_CUT, SWEEP, LOFT 等)
 */
export function has3DSolidFeatures(featureTree: any[]): boolean {
  if (!featureTree || featureTree.length === 0) return false;
  return featureTree.some((f) => {
    if (!f || f.suppressed) return false;
    return (
      f.type === 'EXTRUDE' ||
      f.type === 'CUT_EXTRUDE' ||
      f.type === 'REVOLVE' ||
      f.type === 'REVOLVE_CUT' ||
      f.type === 'SWEEP' ||
      f.type === 'LOFT' ||
      f.type === 'LINEAR_PATTERN' ||
      f.type === 'CIRCULAR_PATTERN' ||
      f.type === 'MIRROR_3D'
    );
  });
}

/**
 * 透過 WebWorker 發送 EXPORT_MODEL 訊息生成 STEP / STL 檔案並自動觸發瀏覽器下載
 */
export async function triggerFileExport(
  format: 'STEP' | 'STL',
  featureTree: any[],
  rollbackIndex?: number,
  planes?: Record<string, any>,
  modelName: string = 'cad_model'
): Promise<void> {
  if (!has3DSolidFeatures(featureTree)) {
    alert('Failed to export. Make sure to generate a 3D solid first.');
    return;
  }

  try {
    const resultData = await solidEngine.exportModel(
      format,
      featureTree,
      rollbackIndex ?? featureTree.length,
      planes ?? {}
    );

    let blob: Blob;
    let extension: string;

    if (format === 'STEP') {
      extension = 'step';
      if (typeof resultData === 'string') {
        blob = new Blob([resultData], { type: 'model/step' });
      } else {
        blob = new Blob([resultData as ArrayBuffer], { type: 'model/step' });
      }
    } else {
      extension = 'stl';
      blob = new Blob([resultData as ArrayBuffer], { type: 'model/stl' });
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${modelName || 'cad_model'}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err: any) {
    console.error(`Export ${format} error:`, err);
    alert(`Failed to export ${format}: ${err.message || 'Unknown error'}`);
    throw err;
  }
}
