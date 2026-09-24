import JSZip from 'jszip';

const PROJECT_FILES = [
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'index.html',
  'metadata.json',
  '.env.example',
  'src/main.tsx',
  'src/App.tsx',
  'src/index.css',
  'src/vite-env.d.ts',
  'src/types/cad.ts',
  'src/store/cadStore.ts',
  'src/store/cadStore.types.ts',
  'src/store/sketchMutators.ts',
  'src/lib/export3D.ts',
  'src/lib/exportProjectZip.ts',
  'src/core/3d/SolidEngine.ts',
  'src/core/3d/SolidEngine.types.ts',
  'src/core/3d/SolidWorker.ts',
  'src/core/3d/WorkerOCCAssetResolver.ts',
  'src/core/3d/FeaturePipelineAdapter.ts',
  'src/core/3d/TopologyExtractor.ts',
  'src/core/3d/FeatureEvaluationCache.ts',
  'src/core/2d/TopologyEngine.ts',
  'src/core/2d/GeometryMath.ts',
  'src/core/2d/SnapManager.ts',
  'src/core/2d/TrimManager.ts',
  'src/core/2d/FilletManager.ts',
  'src/core/2d/ChamferManager.ts',
  'src/core/2d/DimensionEngine.ts',
  'src/core/solver/NumericalConstraintSolver.ts',
  'src/components/Toolbar.tsx',
  'src/components/CAD3DCanvas.tsx',
  'src/components/CADSketchCanvas.tsx',
  'src/components/FeatureTreePanel.tsx',
  'src/components/ExtrudeFeatureModal.tsx',
  'src/components/RevolveFeatureModal.tsx',
  'src/components/FilletChamferShellModal.tsx',
  'src/components/SweepLoftModal.tsx',
  'src/components/PatternMirrorModal.tsx',
  'src/components/DatumPlaneModal.tsx',
  'src/components/LayerManagerModal.tsx',
  'src/components/OsnapSettingsModal.tsx',
  'src/hooks/useCadShortcuts.ts',
  'src/hooks/useDrawMachine.ts',
  'src/hooks/useViewport.ts',
  'scripts/prepare-occ.cjs'
];

export async function exportProjectAsZip(): Promise<void> {
  const zip = new JSZip();

  let successCount = 0;
  for (const filePath of PROJECT_FILES) {
    try {
      const res = await fetch(`/${filePath}`);
      if (res.ok) {
        const text = await res.text();
        zip.file(filePath, text);
        successCount++;
      }
    } catch (err) {
      console.warn(`Failed to fetch ${filePath} for ZIP export:`, err);
    }
  }

  if (successCount === 0) {
    throw new Error('Failed to package project files.');
  }

  const content = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cad_param_project.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
