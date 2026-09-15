import React, { useState } from 'react';
import { FileDown, Loader2 } from 'lucide-react';
import { useCADStore } from '../store/cadStore';
import { triggerFileExport, has3DSolidFeatures } from '../lib/export3D';

interface ToolbarProps {
  onExportSTEP?: () => void;
  onExportSTL?: () => void;
}

export const Toolbar: React.FC<ToolbarProps> = () => {
  const [exportingFormat, setExportingFormat] = useState<'STEP' | 'STL' | null>(null);
  const featureTree = useCADStore((state) => state.document.featureTree);
  const rollbackIndex = useCADStore((state) => state.document.rollbackIndex);
  const planes = useCADStore((state) => state.document.planes);
  const title = useCADStore((state) => state.document.title) || 'cad_model';

  const handleExport = async (format: 'STEP' | 'STL') => {
    if (!has3DSolidFeatures(featureTree)) {
      alert('Failed to export. Make sure to generate a 3D solid first.');
      return;
    }

    setExportingFormat(format);
    try {
      await triggerFileExport(format, featureTree, rollbackIndex, planes, title);
    } catch (err) {
      console.error(`Export ${format} failed`, err);
    } finally {
      setExportingFormat(null);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={exportingFormat !== null}
        onClick={() => handleExport('STEP')}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-purple-900/60 hover:bg-purple-800 text-purple-200 border border-purple-500/40 hover:border-purple-400 transition-all shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        title="匯出 3D 參數化 STEP 實體模型"
        id="btn-export-step"
      >
        {exportingFormat === 'STEP' ? (
          <>
            <Loader2 size={15} className="animate-spin text-purple-300" />
            <span>正在生成 STEP 檔案...</span>
          </>
        ) : (
          <>
            <FileDown size={15} className="text-purple-400" />
            <span>Export STEP</span>
          </>
        )}
      </button>

      <button
        type="button"
        disabled={exportingFormat !== null}
        onClick={() => handleExport('STL')}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-pink-900/60 hover:bg-pink-800 text-pink-200 border border-pink-500/40 hover:border-pink-400 transition-all shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        title="匯出 3D 三角網格 STL 模型"
        id="btn-export-stl"
      >
        {exportingFormat === 'STL' ? (
          <>
            <Loader2 size={15} className="animate-spin text-pink-300" />
            <span>正在生成 STL 檔案...</span>
          </>
        ) : (
          <>
            <FileDown size={15} className="text-pink-400" />
            <span>Export STL</span>
          </>
        )}
      </button>
    </div>
  );
};

export default Toolbar;
