import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useCADStore } from '../store/cadStore';
import { Fillet3DFeature, Chamfer3DFeature, Shell3DFeature, DatumFrontPlane } from '../types/cad';
import { solidEngine } from '../core/3d/SolidEngine';
import { FeatureEvalOp, RuntimeBRepFaceRef } from '../core/3d/SolidEngine.types';
import { TopoReference } from '../core/3d/PersistentTopology.types';
import { SelectedEdgeItem } from '../store/cadStore.types';
import { useDraggableModal } from '../hooks/useDraggableModal';
import {
  X,
  CornerDownRight,
  SquareSlash,
  Box,
  Layers,
  Sliders,
  Check,
  Info,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  MousePointerClick,
  Trash2,
} from 'lucide-react';

export interface FilletChamferShellModalProps {
  isOpen: boolean;
  mode: 'FILLET_3D' | 'CHAMFER_3D' | 'SHELL_3D';
  featureId?: string;
  onClose: () => void;
}

/**
 * 共享的 3D 邊線選取與條件篩選元件 (Fillet 與 Chamfer 100% 統一共享)
 */
interface UnifiedEdgePickerProps {
  themeColor: 'emerald' | 'indigo';
  selectedEdgeList: SelectedEdgeItem[];
  edgeSelectionMode: 'all' | 'vertical' | 'horizontal';
  onSelectionModeChange: (mode: 'all' | 'vertical' | 'horizontal') => void;
  onRemoveEdge: (edgeIndex: number) => void;
  onClearEdges: () => void;
}

const UnifiedEdgePicker: React.FC<UnifiedEdgePickerProps> = ({
  themeColor,
  selectedEdgeList,
  edgeSelectionMode,
  onSelectionModeChange,
  onRemoveEdge,
  onClearEdges,
}) => {
  const isEmerald = themeColor === 'emerald';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block font-semibold text-neutral-300">
          目標實體邊線 (Target Edges)
        </label>
        {selectedEdgeList.length > 0 && (
          <button
            type="button"
            onClick={onClearEdges}
            className="text-[10px] text-neutral-400 hover:text-red-400 flex items-center gap-1 transition-colors cursor-pointer"
            title="清除全部選取"
          >
            <Trash2 size={11} />
            <span>清除全部 ({selectedEdgeList.length})</span>
          </button>
        )}
      </div>

      {/* 已選取邊線列表 */}
      {selectedEdgeList.length > 0 ? (
        <div className="space-y-1.5">
          <div
            className={`p-2.5 rounded-lg border text-xs flex flex-col gap-2 ${
              isEmerald
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : 'bg-indigo-950/40 border-indigo-500/40 text-indigo-300'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 font-semibold text-white">
                <span
                  className={`w-2 h-2 rounded-full animate-pulse ${
                    isEmerald ? 'bg-emerald-400' : 'bg-indigo-400'
                  }`}
                />
                <span>已指定 {selectedEdgeList.length} 條 3D 邊線</span>
              </div>
              <span className="text-[10px] font-mono text-neutral-400">
                手動指定模式
              </span>
            </div>

            {/* 邊線膠囊列表 (支援水平滾動或換行) */}
            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto pr-1">
              {selectedEdgeList.map((item) => {
                const isArc = item.edgeRef.curveType === 'circle';
                return (
                  <div
                    key={item.edgeRef.edgeIndex}
                    className="flex items-center gap-1.5 px-2 py-1 bg-neutral-900/90 border border-neutral-700/80 rounded text-[11px] text-white font-mono shadow-sm group"
                  >
                    <span>#{item.edgeRef.edgeIndex}</span>
                    <span className="text-[9px] text-neutral-400">
                      {isArc ? 'Arc' : 'Line'}
                      {item.edgeRef.length ? ` (${item.edgeRef.length.toFixed(1)}mm)` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemoveEdge(item.edgeRef.edgeIndex)}
                      className="text-neutral-400 hover:text-red-400 p-0.5 rounded transition-colors cursor-pointer"
                      title="移除此邊線"
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="text-[10px] text-neutral-400 flex items-center gap-1 px-1">
            <MousePointerClick size={12} className="text-amber-400 shrink-0" />
            <span>提示：一般點擊為單選替換，按住 Shift + 點擊可多選或反選邊線。</span>
          </div>
        </div>
      ) : (
        <div className="p-2.5 rounded-lg bg-neutral-900/80 border border-neutral-800 text-[11px] text-neutral-400 space-y-1.5">
          <div className="flex items-center gap-2 text-neutral-300">
            <MousePointerClick size={14} className="text-sky-400 shrink-0" />
            <span className="font-semibold">尚未手動選取邊線</span>
          </div>
          <p className="text-[10px] text-neutral-400 leading-relaxed">
            可在 3D 視圖直接點選單一邊線（或 Shift + 點擊多選），或使用下方篩選規則自動套用模型邊線。
          </p>
        </div>
      )}

      {/* 邊界篩選模式 (當未手動選取時生效，亦可隨時切換) */}
      <div className="space-y-1 pt-1">
        <div className="flex items-center justify-between text-[11px] text-neutral-400">
          <span>規則篩選模式 (當無手動選取時生效)</span>
          {selectedEdgeList.length > 0 && (
            <span className="text-[10px] text-amber-400 font-medium">手動選取優先</span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {(['all', 'vertical', 'horizontal'] as const).map((sel) => {
            const isSelected = selectedEdgeList.length === 0 && edgeSelectionMode === sel;
            return (
              <button
                key={sel}
                type="button"
                onClick={() => onSelectionModeChange(sel)}
                className={`py-2 px-1 rounded-lg border flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
                  isSelected
                    ? isEmerald
                      ? 'bg-emerald-600/25 border-emerald-500 text-emerald-300 font-bold shadow-sm ring-1 ring-emerald-500/30'
                      : 'bg-indigo-600/25 border-indigo-500 text-indigo-300 font-bold shadow-sm ring-1 ring-indigo-500/30'
                    : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-850'
                }`}
              >
                <span className="text-xs uppercase">{sel}</span>
                <span className="text-[9px] text-neutral-500 font-sans">
                  {sel === 'all' ? '全部邊線' : sel === 'vertical' ? '僅垂直邊' : '僅水平邊'}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const FilletChamferShellModal: React.FC<FilletChamferShellModalProps> = ({
  isOpen,
  mode,
  featureId,
  onClose,
}) => {
  const {
    document,
    addFeature,
    updateFeature,
    setRollbackIndex,
    viewMode,
    setViewMode,
    selectedEdgeList,
    removeSelectedEdge,
    clearSelectedEdges,
    selectedFaceInfo,
    setSelectedFaceInfo,
    filletChamferPreview,
    setFilletChamferPreview,
  } = useCADStore();

  const targetFeature = useMemo(() => {
    if (!featureId || !document?.featureTree) return null;
    return document.featureTree.find((f) => f.id === featureId) || null;
  }, [featureId, document?.featureTree]);

  // 表單狀態
  const [featureName, setFeatureName] = useState('');
  const [isCalculatingPreview, setIsCalculatingPreview] = useState(false);

  // Fillet / Chamfer 共享與專屬狀態
  const [radius, setRadius] = useState<number>(10.0);
  const [distance, setDistance] = useState<number>(2.0);
  const [edgeSelectionMode, setEdgeSelectionMode] = useState<'all' | 'vertical' | 'horizontal'>('all');

  // Shell 專屬狀態
  const [thickness, setThickness] = useState<number>(1.5);
  const [direction, setDirection] = useState<'inside' | 'outside'>('inside');
  const [removedFaceRefs, setRemovedFaceRefs] = useState<RuntimeBRepFaceRef[]>([]);

  const prevIsOpenRef = useRef(false);
  const prevFeatureIdRef = useRef<string | undefined>(undefined);
  const prevModeRef = useRef<string | undefined>(undefined);
  const originalRollbackIndexRef = useRef<number | null>(null);

  const { position, dragHandleProps } = useDraggableModal({ defaultX: 280, defaultY: 70 });

  // 每次開啟、切換 mode 或 featureId 時自動初始化名稱與狀態（嚴禁在使用者操作期間因為 store/targetFeature 引用更新而重設狀態）
  useEffect(() => {
    const justOpened = isOpen && !prevIsOpenRef.current;
    const featureIdChanged = featureId !== prevFeatureIdRef.current;
    const modeChanged = mode !== prevModeRef.current;

    prevIsOpenRef.current = isOpen;
    prevFeatureIdRef.current = featureId;
    prevModeRef.current = mode;

    if (!isOpen) {
      setFilletChamferPreview(null);
      return;
    }

    // 僅在 Modal「剛開啟」或「featureId 切換」或「mode 切換」的瞬間執行 Hydration
    if (justOpened || featureIdChanged || modeChanged) {
      if (viewMode !== '3D') {
        setViewMode('3D');
      }

      const tree = document?.featureTree || [];

      if (mode === 'FILLET_3D') {
        if (targetFeature && targetFeature.type === 'FILLET_3D') {
          setFeatureName(targetFeature.name);
          setRadius(targetFeature.radius);
          setEdgeSelectionMode('all');
        } else {
          const count = tree.filter((f) => f.type === 'FILLET_3D').length + 1;
          setFeatureName(`Fillet${count}`);
          setRadius(10.0);
          setEdgeSelectionMode('all');
        }
      } else if (mode === 'CHAMFER_3D') {
        if (targetFeature && targetFeature.type === 'CHAMFER_3D') {
          setFeatureName(targetFeature.name);
          setDistance(targetFeature.distance);
          setEdgeSelectionMode('all');
        } else {
          const count = tree.filter((f) => f.type === 'CHAMFER_3D').length + 1;
          setFeatureName(`Chamfer${count}`);
          setDistance(2.0);
          setEdgeSelectionMode('all');
        }
      } else {
        if (targetFeature && targetFeature.type === 'SHELL_3D') {
          setFeatureName(targetFeature.name);
          setThickness(targetFeature.thickness);
          setDirection(targetFeature.direction || 'inside');
          if (targetFeature.removedFaceRefs && targetFeature.removedFaceRefs.length > 0) {
            const refs: RuntimeBRepFaceRef[] = targetFeature.removedFaceRefs.map((topo, idx) => {
              const faceIdx = targetFeature.faceIndices?.[idx] ?? idx;
              const bId = topo?.featureId || 'main-body';
              return {
                bodyId: bId,
                faceIndex: faceIdx,
                runtimeId: `brep_face_${bId}_${faceIdx}`,
                surfaceType: 'plane',
                topoRef: topo,
              };
            });
            setRemovedFaceRefs(refs);
          } else {
            setRemovedFaceRefs([]);
          }
        } else {
          const count = tree.filter((f) => f.type === 'SHELL_3D').length + 1;
          setFeatureName(`Shell${count}`);
          setThickness(1.5);
          setDirection('inside');
          setRemovedFaceRefs([]);
        }
      }
    }
  }, [
    isOpen,
    mode,
    featureId,
    targetFeature,
    document?.featureTree,
    viewMode,
    setViewMode,
    setFilletChamferPreview,
  ]);

  const rollbackTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 當進入特徵編輯模式時，自動將 3D 回退索引設定至目標特徵位置前，隔離編輯預覽
  useEffect(() => {
    if (!featureId) return;

    if (rollbackTimerRef.current) {
      clearTimeout(rollbackTimerRef.current);
      rollbackTimerRef.current = null;
    }

    // 1. 組件掛載/進入編輯時，退回歷史
    const currentState = useCADStore.getState();
    const tree = currentState.document.featureTree;
    const idx = tree.findIndex((f) => f.id === featureId);
    if (idx >= 0) {
      if (currentState.document.rollbackIndex !== idx) {
        currentState.setRollbackIndex(idx);
      }
    }

    // 2. 只有在組件真正卸載 (Unmount) 或 featureId 改變時，才恢復到樹的末端
    return () => {
      if (rollbackTimerRef.current) {
        clearTimeout(rollbackTimerRef.current);
      }
      rollbackTimerRef.current = setTimeout(() => {
        const state = useCADStore.getState();
        const treeLen = state.document.featureTree.length;
        if (state.document.rollbackIndex !== treeLen) {
          state.setRollbackIndex(treeLen);
        }
      }, 0);
    };
  }, [featureId]);

  // 當 3D 視圖選取面觸發 selectedFaceInfo 時實作 Toggle 機制
  useEffect(() => {
    if (isOpen && mode === 'SHELL_3D' && selectedFaceInfo?.faceRef) {
      const faceRef = selectedFaceInfo.faceRef;
      setRemovedFaceRefs((prev) => {
        const exists = prev.some(
          (f) =>
            f.faceIndex === faceRef.faceIndex ||
            (f.runtimeId && faceRef.runtimeId && f.runtimeId === faceRef.runtimeId) ||
            (f.topoRef?.persistentId &&
              faceRef.topoRef?.persistentId &&
              f.topoRef.persistentId === faceRef.topoRef.persistentId)
        );
        if (exists) {
          return prev.filter(
            (f) =>
              !(
                f.faceIndex === faceRef.faceIndex ||
                (f.runtimeId && faceRef.runtimeId && f.runtimeId === faceRef.runtimeId) ||
                (f.topoRef?.persistentId &&
                  faceRef.topoRef?.persistentId &&
                  f.topoRef.persistentId === faceRef.topoRef.persistentId)
              )
          );
        } else {
          return [...prev, faceRef];
        }
      });
      setSelectedFaceInfo(null);
    }
  }, [isOpen, mode, selectedFaceInfo, setSelectedFaceInfo]);

  // 關閉 Modal 時清除預覽並恢復歷史 Rollback 指針
  const handleClose = useCallback(() => {
    setFilletChamferPreview(null);
    onClose();
  }, [onClose, setFilletChamferPreview]);

  // 即時 3D Live Preview 計算 (Debounce 120ms，調用 SolidEngine 的 OCC 實體幾何運算)
  useEffect(() => {
    if (!isOpen) {
      setFilletChamferPreview(null);
      return;
    }

    const tree = document?.featureTree || [];
    if (tree.length === 0) {
      setFilletChamferPreview(null);
      return;
    }

    if (mode === 'SHELL_3D' && removedFaceRefs.length === 0) {
      setFilletChamferPreview(null);
      return;
    }

    let isCancelled = false;
    setIsCalculatingPreview(true);

    const timer = setTimeout(async () => {
      try {
        let op: FeatureEvalOp;

        if (mode === 'FILLET_3D') {
          const edgeRefs = selectedEdgeList.map((e) => e.edgeRef.topoRef).filter(Boolean) as TopoReference[];
          const edgeIndices = selectedEdgeList.map((e) => e.edgeRef.edgeIndex);
          op = {
            featureId: 'preview-fillet',
            type: 'FILLET_3D',
            operation: 'JOIN',
            profiles: [],
            plane: DatumFrontPlane,
            fillet3D: {
              radius: Math.max(0.1, radius),
              edgeSelectionMode: selectedEdgeList.length > 0 ? undefined : edgeSelectionMode,
              edgeRefs: edgeRefs.length > 0 ? edgeRefs : undefined,
              edgeIndices: edgeIndices.length > 0 ? edgeIndices : undefined,
            },
          };
        } else if (mode === 'CHAMFER_3D') {
          const edgeRefs = selectedEdgeList.map((e) => e.edgeRef.topoRef).filter(Boolean) as TopoReference[];
          const edgeIndices = selectedEdgeList.map((e) => e.edgeRef.edgeIndex);
          op = {
            featureId: 'preview-chamfer',
            type: 'CHAMFER_3D',
            operation: 'JOIN',
            profiles: [],
            plane: DatumFrontPlane,
            chamfer3D: {
              distance: Math.max(0.1, distance),
              edgeSelectionMode: selectedEdgeList.length > 0 ? undefined : edgeSelectionMode,
              edgeRefs: edgeRefs.length > 0 ? edgeRefs : undefined,
              edgeIndices: edgeIndices.length > 0 ? edgeIndices : undefined,
            },
          };
        } else {
          const faceTopoRefs = removedFaceRefs.map((f: any) => f?.topoRef || f).filter(Boolean);
          const faceIndices = removedFaceRefs
            .map((f: any) => f?.faceIndex)
            .filter((idx: any) => typeof idx === 'number');
          op = {
            featureId: 'preview-shell',
            type: 'SHELL_3D',
            operation: 'JOIN',
            profiles: [],
            plane: DatumFrontPlane,
            shell3D: {
              thickness: Math.max(0.1, thickness),
              direction,
              removedFaceRefs: faceTopoRefs,
              faceIndices,
            } as any,
          };
        }

        const meshResult = await solidEngine.previewOperation(op);
        if (!isCancelled) {
          setIsCalculatingPreview(false);
          setFilletChamferPreview({
            type: mode as any,
            mesh: meshResult,
          });
        }
      } catch (err: any) {
        if (!isCancelled) {
          setIsCalculatingPreview(false);
          setFilletChamferPreview({
            type: mode as any,
            mesh: null,
            error: err?.message || '預覽計算失敗',
          });
        }
      }
    }, 120);

    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [
    isOpen,
    mode,
    radius,
    distance,
    thickness,
    direction,
    removedFaceRefs,
    edgeSelectionMode,
    selectedEdgeList,
    document?.featureTree,
    setFilletChamferPreview,
  ]);

  if (!isOpen) return null;

  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();

    const name =
      featureName.trim() ||
      (mode === 'FILLET_3D' ? 'Fillet1' : mode === 'CHAMFER_3D' ? 'Chamfer1' : 'Shell1');
    const tree = document?.featureTree || [];

    const targetIdx = featureId ? tree.findIndex((f) => f.id === featureId) : -1;
    const priorTree = targetIdx >= 0 ? tree.slice(0, targetIdx) : tree;
    const parentFeat = priorTree.length > 0 ? priorTree[priorTree.length - 1] : undefined;
    const parentFeatId = parentFeat?.id;

    if (mode === 'FILLET_3D') {
      const edgeRefs = selectedEdgeList
        .map((e) => {
          const topo = e.edgeRef.topoRef;
          if (!topo) return null;
          if (featureId && topo.featureId === featureId) {
            return {
              ...topo,
              featureId: parentFeatId || tree[0]?.id || 'main-body',
            };
          }
          return topo;
        })
        .filter(Boolean) as TopoReference[];
      const edgeIndices = selectedEdgeList.map((e) => e.edgeRef.edgeIndex);
      let parentDep = edgeRefs[0]?.featureId || parentFeatId || (tree.length > 0 ? tree[tree.length - 1].id : undefined);
      if (parentDep === featureId) {
        parentDep = parentFeatId;
      }

      if (featureId) {
        updateFeature(featureId, {
          name,
          radius: Math.max(0.1, radius),
          edgeSelectionMode: selectedEdgeList.length > 0 ? undefined : edgeSelectionMode,
          edgeRefs,
          edgeIndices,
          dependencies: parentDep ? [parentDep] : [],
        } as Partial<Fillet3DFeature>);
      } else {
        const newFeature: Fillet3DFeature = {
          id: `fillet-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          name,
          type: 'FILLET_3D',
          radius: Math.max(0.1, radius),
          edgeSelectionMode: selectedEdgeList.length > 0 ? undefined : edgeSelectionMode,
          edgeRefs,
          edgeIndices,
          suppressed: false,
          dependencies: parentDep ? [parentDep] : [],
        };
        addFeature(newFeature);
      }
    } else if (mode === 'CHAMFER_3D') {
      const edgeRefs = selectedEdgeList
        .map((e) => {
          const topo = e.edgeRef.topoRef;
          if (!topo) return null;
          if (featureId && topo.featureId === featureId) {
            return {
              ...topo,
              featureId: parentFeatId || tree[0]?.id || 'main-body',
            };
          }
          return topo;
        })
        .filter(Boolean) as TopoReference[];
      const edgeIndices = selectedEdgeList.map((e) => e.edgeRef.edgeIndex);
      let parentDep = edgeRefs[0]?.featureId || parentFeatId || (tree.length > 0 ? tree[tree.length - 1].id : undefined);
      if (parentDep === featureId) {
        parentDep = parentFeatId;
      }

      if (featureId) {
        updateFeature(featureId, {
          name,
          distance: Math.max(0.1, distance),
          edgeSelectionMode: selectedEdgeList.length > 0 ? undefined : edgeSelectionMode,
          edgeRefs,
          edgeIndices,
          dependencies: parentDep ? [parentDep] : [],
        } as Partial<Chamfer3DFeature>);
      } else {
        const newFeature: Chamfer3DFeature = {
          id: `chamfer-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          name,
          type: 'CHAMFER_3D',
          distance: Math.max(0.1, distance),
          edgeSelectionMode: selectedEdgeList.length > 0 ? undefined : edgeSelectionMode,
          edgeRefs,
          edgeIndices,
          suppressed: false,
          dependencies: parentDep ? [parentDep] : [],
        };
        addFeature(newFeature);
      }
    } else if (mode === 'SHELL_3D') {
      const faceTopoRefs = removedFaceRefs
        .map((f) => {
          if (!f.topoRef) return null;
          let topo = f.topoRef;
          if (featureId && (topo.featureId === featureId || f.bodyId === featureId)) {
            topo = {
              ...topo,
              featureId: parentFeatId || tree[0]?.id || 'main-body',
            };
          }
          return topo;
        })
        .filter(Boolean) as TopoReference[];
      const faceIndices = removedFaceRefs.map((f) => f.faceIndex);
      let parentDep = faceTopoRefs[0]?.featureId || parentFeatId || (tree.length > 0 ? tree[tree.length - 1].id : undefined);
      if (parentDep === featureId) {
        parentDep = parentFeatId;
      }

      console.log(`[Shell Modal handleConfirm Diagnostic] Payload for SHELL_3D confirm:`, {
        isEditMode: !!featureId,
        featureId,
        name,
        thickness: Math.max(0.1, thickness),
        direction,
        parentFeatId,
        parentDep,
        faceIndices,
        removedFaceRefsCount: removedFaceRefs.length,
        faceTopoRefsCount: faceTopoRefs.length,
        faceTopoRefsDetails: faceTopoRefs.map((t) => ({
          persistentId: t.persistentId,
          featureId: t.featureId,
          generation: t.generation,
          subShapeType: t.subShapeType,
          normal: t.signature?.normal,
          centroid: t.signature?.centroid,
          measure: t.signature?.measure,
        })),
      });

      if (featureId) {
        updateFeature(featureId, {
          name,
          thickness: Math.max(0.1, thickness),
          direction,
          removedFaceRefs: faceTopoRefs,
          faceIndices,
          dependencies: parentDep ? [parentDep] : [],
        } as Partial<Shell3DFeature>);
      } else {
        const newFeature: Shell3DFeature = {
          id: `shell-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          name,
          type: 'SHELL_3D',
          thickness: Math.max(0.1, thickness),
          direction,
          removedFaceRefs: faceTopoRefs,
          faceIndices,
          suppressed: false,
          dependencies: parentDep ? [parentDep] : [],
        };
        addFeature(newFeature);
      }
    }

    setFilletChamferPreview(null);
    setViewMode('3D');
    onClose();
  };

  // 渲染專屬面板顏色與圖示
  const getHeaderStyle = () => {
    switch (mode) {
      case 'FILLET_3D':
        return {
          bgColor: 'bg-emerald-950/70 border-emerald-800/50',
          iconColor: 'bg-emerald-600/20 text-emerald-400 border-emerald-500/40',
          title: '3D 圓角 (Fillet 3D)',
          icon: <CornerDownRight size={18} />,
        };
      case 'CHAMFER_3D':
        return {
          bgColor: 'bg-indigo-950/70 border-indigo-800/50',
          iconColor: 'bg-indigo-600/20 text-indigo-400 border-indigo-500/40',
          title: '3D 倒角 (Chamfer 3D)',
          icon: <SquareSlash size={18} />,
        };
      case 'SHELL_3D':
        return {
          bgColor: 'bg-purple-950/70 border-purple-800/50',
          iconColor: 'bg-purple-600/20 text-purple-400 border-purple-500/40',
          title: '3D 薄殼 (Shell 3D)',
          icon: <Box size={18} />,
        };
    }
  };

  const header = getHeaderStyle();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 pointer-events-none">
      <div
        style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)`, position: 'fixed', top: 0, left: 0 }}
        className="w-96 max-h-[calc(100vh-5rem)] overflow-hidden flex flex-col bg-neutral-950/95 backdrop-blur-md border border-neutral-800 rounded-xl shadow-2xl text-neutral-200 select-none animate-in fade-in slide-in-from-left-4 duration-200 pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
        id="fillet-chamfer-shell-propertymanager"
      >
        {/* Modal 頂部 Header */}
        <div
          {...dragHandleProps}
          className={`h-12 px-4 border-b flex items-center justify-between shrink-0 font-sans cursor-move select-none ${header.bgColor}`}
        >
        <div className="flex items-center gap-2.5">
          <div className={`p-1.5 rounded-lg border shadow-sm ${header.iconColor}`}>
            {header.icon}
          </div>
          <div>
            <h3 className="text-sm font-bold tracking-wide text-white flex items-center gap-2">
              {header.title}
            </h3>
            <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
              <Sliders size={11} className="text-amber-400" />
              <span>實體拓撲重構修飾中</span>
            </div>
          </div>
        </div>
        <button
          onClick={handleClose}
          className="p-1 text-neutral-400 hover:text-white hover:bg-neutral-800/80 rounded-lg transition-colors cursor-pointer"
          title="關閉 (Esc)"
        >
          <X size={18} />
        </button>
      </div>

      {/* 3D 即時 Live Preview 狀態提示列 */}
      {(mode === 'FILLET_3D' || mode === 'CHAMFER_3D' || mode === 'SHELL_3D') && (
        <div className="px-4 py-1.5 bg-neutral-900/90 border-b border-neutral-800 flex items-center justify-between text-[11px]">
          <div className="flex items-center gap-1.5">
            {isCalculatingPreview ? (
              <>
                <Loader2 size={13} className="text-sky-400 animate-spin" />
                <span className="text-sky-300 font-mono">OCC 幾何運算中...</span>
              </>
            ) : filletChamferPreview?.mesh ? (
              <>
                <CheckCircle2
                  size={13}
                  className={
                    mode === 'FILLET_3D'
                      ? 'text-emerald-400'
                      : mode === 'CHAMFER_3D'
                      ? 'text-indigo-400'
                      : 'text-purple-400'
                  }
                />
                <span className="text-neutral-300 font-medium">3D 即時預覽已同步</span>
              </>
            ) : filletChamferPreview?.error ? (
              <>
                <AlertTriangle size={13} className="text-amber-400 shrink-0" />
                <span className="text-amber-300 truncate max-w-[200px]" title={filletChamferPreview.error}>
                  {filletChamferPreview.error}
                </span>
              </>
            ) : (
              <span className="text-neutral-500">等待輸入參數</span>
            )}
          </div>
          <span className="text-[10px] font-mono text-neutral-500">Live Preview</span>
        </div>
      )}

      {/* 表單內容主體 */}
      <form onSubmit={handleConfirm} noValidate className="p-4 space-y-4 font-sans text-xs overflow-y-auto">
        {/* 特徵名稱 */}
        <div className="space-y-1.5">
          <label className="block font-semibold text-neutral-300 flex items-center justify-between">
            <span>特徵名稱 (Feature Name)</span>
            <span className="text-[10px] font-mono text-neutral-500">Auto ID</span>
          </label>
          <input
            type="text"
            required
            value={featureName}
            onChange={(e) => setFeatureName(e.target.value)}
            className="w-full px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-blue-500/80 transition-colors text-xs"
            placeholder={mode === 'FILLET_3D' ? 'Fillet1' : mode === 'CHAMFER_3D' ? 'Chamfer1' : 'Shell1'}
          />
        </div>

        {/* 【3D 圓角專屬欄位（mode === 'FILLET_3D'）】 */}
        {mode === 'FILLET_3D' && (
          <>
            {/* 統一邊線選取器 */}
            <UnifiedEdgePicker
              themeColor="emerald"
              selectedEdgeList={selectedEdgeList}
              edgeSelectionMode={edgeSelectionMode}
              onSelectionModeChange={setEdgeSelectionMode}
              onRemoveEdge={removeSelectedEdge}
              onClearEdges={clearSelectedEdges}
            />

            {/* 圓角半徑 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between font-semibold text-neutral-300">
                <span className="flex items-center gap-1.5">
                  <CornerDownRight size={14} className="text-emerald-400" />
                  <span>圓角半徑 (Radius)</span>
                </span>
                <span className="text-emerald-400 font-mono font-bold text-sm">
                  {radius} <span className="text-xs text-neutral-400">mm</span>
                </span>
              </div>

              <div className="relative flex items-center gap-2">
                <input
                  type="number"
                  min={0.1}
                  step="any"
                  value={radius === 0 ? '' : radius}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      setRadius(val);
                    } else if (e.target.value === '') {
                      setRadius(0);
                    }
                  }}
                  onBlur={() => {
                    if (radius < 0.1) {
                      setRadius(2.0);
                    }
                  }}
                  className="w-28 px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono font-bold text-center focus:outline-none focus:border-emerald-500 transition-colors text-xs"
                />
                <input
                  type="range"
                  min={0.1}
                  max={50}
                  step="0.1"
                  value={radius}
                  onChange={(e) => setRadius(Number(e.target.value))}
                  className="flex-1 accent-emerald-500 cursor-pointer h-2 bg-neutral-800 rounded-lg"
                />
              </div>

              {/* 常用半徑快選膠囊 */}
              <div className="flex items-center gap-1.5 pt-1">
                {[1, 2, 5, 10, 20].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setRadius(val)}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                      radius === val
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 font-bold'
                        : 'bg-neutral-900 text-neutral-400 border-neutral-800 hover:text-white hover:border-neutral-700'
                    }`}
                  >
                    {val}mm
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* 【3D 倒角專屬欄位（mode === 'CHAMFER_3D'）】 */}
        {mode === 'CHAMFER_3D' && (
          <>
            {/* 統一邊線選取器 */}
            <UnifiedEdgePicker
              themeColor="indigo"
              selectedEdgeList={selectedEdgeList}
              edgeSelectionMode={edgeSelectionMode}
              onSelectionModeChange={setEdgeSelectionMode}
              onRemoveEdge={removeSelectedEdge}
              onClearEdges={clearSelectedEdges}
            />

            {/* 倒角距離 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between font-semibold text-neutral-300">
                <span className="flex items-center gap-1.5">
                  <SquareSlash size={14} className="text-indigo-400" />
                  <span>倒角距離 (Distance)</span>
                </span>
                <span className="text-indigo-400 font-mono font-bold text-sm">
                  {distance} <span className="text-xs text-neutral-400">mm</span>
                </span>
              </div>

              <div className="relative flex items-center gap-2">
                <input
                  type="number"
                  min={0.1}
                  step="any"
                  value={distance === 0 ? '' : distance}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      setDistance(val);
                    } else if (e.target.value === '') {
                      setDistance(0);
                    }
                  }}
                  onBlur={() => {
                    if (distance < 0.1) {
                      setDistance(2.0);
                    }
                  }}
                  className="w-28 px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono font-bold text-center focus:outline-none focus:border-indigo-500 transition-colors text-xs"
                />
                <input
                  type="range"
                  min={0.1}
                  max={50}
                  step="0.1"
                  value={distance}
                  onChange={(e) => setDistance(Number(e.target.value))}
                  className="flex-1 accent-indigo-500 cursor-pointer h-2 bg-neutral-800 rounded-lg"
                />
              </div>

              {/* 常用距離快選膠囊 */}
              <div className="flex items-center gap-1.5 pt-1">
                {[1, 2, 5, 10].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setDistance(val)}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                      distance === val
                        ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/50 font-bold'
                        : 'bg-neutral-900 text-neutral-400 border-neutral-800 hover:text-white hover:border-neutral-700'
                    }`}
                  >
                    {val}mm
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* 【3D 薄殼專屬欄位（mode === 'SHELL_3D'）】 */}
        {mode === 'SHELL_3D' && (
          <>
            {/* 移除表面選取器 (Target Open Faces) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="block font-semibold text-neutral-300">
                  移除表面 (Removed Open Faces)
                </label>
                {removedFaceRefs.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setRemovedFaceRefs([])}
                    className="text-[10px] text-neutral-400 hover:text-red-400 flex items-center gap-1 transition-colors cursor-pointer"
                    title="清除選取"
                  >
                    <Trash2 size={11} />
                    <span>清除全部 ({removedFaceRefs.length})</span>
                  </button>
                )}
              </div>

              {removedFaceRefs.length > 0 ? (
                <div className="p-2.5 rounded-lg border border-purple-500/40 bg-purple-950/40 text-purple-300 text-xs flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-semibold text-white">
                      <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                      <span>已指定 {removedFaceRefs.length} 個開口面</span>
                    </div>
                    <span className="text-[10px] font-mono text-neutral-400">
                      多選切換模式
                    </span>
                  </div>

                  {/* 面晶片/標籤清單 */}
                  <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto pr-1">
                    {removedFaceRefs.map((ref) => (
                      <div
                        key={ref.faceIndex}
                        className="flex items-center gap-1.5 px-2 py-1 bg-neutral-900/90 border border-neutral-700/80 rounded text-[11px] text-white font-mono shadow-sm group"
                      >
                        <span>Face #{ref.faceIndex}</span>
                        <span className="text-[9px] text-neutral-400">
                          {ref.surfaceType || 'plane'}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setRemovedFaceRefs((prev) =>
                              prev.filter((f) => f.faceIndex !== ref.faceIndex)
                            )
                          }
                          className="text-neutral-400 hover:text-red-400 p-0.5 rounded transition-colors cursor-pointer"
                          title="移除此面"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="p-2.5 rounded-lg bg-neutral-900/80 border border-neutral-800 text-[11px] text-neutral-400 space-y-1.5">
                  <div className="flex items-center gap-2 text-neutral-300">
                    <MousePointerClick size={14} className="text-purple-400 shrink-0" />
                    <span className="font-semibold">尚未選取移除表面</span>
                  </div>
                  <p className="text-[10px] text-neutral-400 leading-relaxed">
                    請於 3D 視圖中點選欲掏空的表面（點擊可切換選取/移除）。未選取時將預設為全封閉內部薄殼。
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between font-semibold text-neutral-300">
                <span className="flex items-center gap-1.5">
                  <Layers size={14} className="text-purple-400" />
                  <span>殼體厚度 (Thickness)</span>
                </span>
                <span className="text-purple-400 font-mono font-bold text-sm">
                  {thickness} <span className="text-xs text-neutral-400">mm</span>
                </span>
              </div>

              <div className="relative flex items-center gap-2">
                <input
                  type="number"
                  min={0.1}
                  step="any"
                  value={thickness === 0 ? '' : thickness}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      setThickness(val);
                    } else if (e.target.value === '') {
                      setThickness(0);
                    }
                  }}
                  onBlur={() => {
                    if (thickness < 0.1) {
                      setThickness(1.5);
                    }
                  }}
                  className="w-28 px-3 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white font-mono font-bold text-center focus:outline-none focus:border-purple-500 transition-colors text-xs"
                />
                <input
                  type="range"
                  min={0.1}
                  max={20}
                  step="0.1"
                  value={thickness}
                  onChange={(e) => setThickness(Number(e.target.value))}
                  className="flex-1 accent-purple-500 cursor-pointer h-2 bg-neutral-800 rounded-lg"
                />
              </div>
            </div>

            {/* 薄殼方向 */}
            <div className="space-y-1.5">
              <label className="block font-semibold text-neutral-300">
                薄殼方向 (Direction)
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDirection('inside')}
                  className={`py-2.5 px-2 rounded-lg border flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
                    direction === 'inside'
                      ? 'bg-purple-600/25 border-purple-500 text-purple-300 font-bold shadow-sm ring-1 ring-purple-500/30'
                      : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-850'
                  }`}
                >
                  <span className="text-xs font-semibold">向內掏空 (Inside)</span>
                  <span className="text-[10px] text-neutral-500">保留外部幾何</span>
                </button>

                <button
                  type="button"
                  onClick={() => setDirection('outside')}
                  className={`py-2.5 px-2 rounded-lg border flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
                    direction === 'outside'
                      ? 'bg-purple-600/25 border-purple-500 text-purple-300 font-bold shadow-sm ring-1 ring-purple-500/30'
                      : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-850'
                  }`}
                >
                  <span className="text-xs font-semibold">向外擴展 (Outside)</span>
                  <span className="text-[10px] text-neutral-500">擴展外部尺寸</span>
                </button>
              </div>
            </div>
          </>
        )}

        {/* 說明提示塊 */}
        <div className="p-2.5 bg-neutral-900/90 border border-neutral-800 rounded-lg flex items-start gap-2 text-[11px] text-neutral-400">
          <Info size={14} className="text-amber-400 shrink-0 mt-0.5" />
          <span>
            {mode === 'FILLET_3D' &&
              '3D 圓角將根據設定半徑，自動平滑重構模型所有指定或篩選合規之邊緣。'}
            {mode === 'CHAMFER_3D' &&
              '3D 倒角將根據設定距離，自動對所有指定或篩選合規之邊緣進行 45 度面切除。'}
            {mode === 'SHELL_3D' &&
              '3D 薄殼將自動計算模型最頂部的開放面，並以設定厚度將其餘壁面掏空。'}
          </span>
        </div>

        {/* 底部按鈕列 */}
        <div className="pt-2 flex items-center justify-end gap-2 border-t border-neutral-800">
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-1.5 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded-lg border border-neutral-800 font-semibold transition-colors text-xs cursor-pointer"
          >
            取消 (Esc)
          </button>
          <button
            type="submit"
            className={`px-4 py-1.5 rounded-lg font-bold flex items-center gap-1.5 shadow-lg transition-colors text-xs cursor-pointer ${
              mode === 'FILLET_3D'
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/20 active:scale-95'
                : mode === 'CHAMFER_3D'
                ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/20 active:scale-95'
                : 'bg-purple-600 hover:bg-purple-500 text-white shadow-purple-600/20 active:scale-95'
            }`}
          >
            <Check size={15} />
            <span>{featureId ? '確定更新' : '確定建立'}</span>
          </button>
        </div>
      </form>
    </div>
  </div>
  );
};

export default FilletChamferShellModal;
