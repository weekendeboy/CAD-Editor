import React, { useState, useRef, useEffect } from 'react';
import { CADFeature, FeatureType } from '../types/cad';
import {
  Pencil,
  Box,
  MinusSquare,
  RotateCw,
  SquareStack,
  CornerDownRight,
  SquareSlash,
  AlertTriangle,
  Eye,
  EyeOff,
  Pause,
  Play,
  Trash2,
  Edit3,
} from 'lucide-react';

export interface FeatureTreeItemProps {
  feature: CADFeature;
  isSelected: boolean;
  isPastRollback: boolean; // 是否位於回退棒下方（置灰不可用）
  onSelect: (id: string) => void;
  onToggleSuppress: (id: string) => void;
  onToggleVisibility: (id: string) => void;
  onRename: (id: string, newName: string) => void;
  onDelete: (id: string) => void;
}

/**
 * 特徵圖示對應表
 * SKETCH: Pencil
 * EXTRUDE: Box
 * CUT_EXTRUDE: MinusSquare
 * REVOLVE: RotateCw
 * DATUM_PLANE: SquareStack
 * FILLET_3D: CornerDownRight
 * CHAMFER_3D: SquareSlash
 */
function renderFeatureIcon(type: FeatureType, className: string = 'w-4 h-4') {
  switch (type) {
    case 'SKETCH':
      return <Pencil className={className} />;
    case 'EXTRUDE':
      return <Box className={className} />;
    case 'CUT_EXTRUDE':
      return <MinusSquare className={className} />;
    case 'REVOLVE':
      return <RotateCw className={className} />;
    case 'DATUM_PLANE':
      return <SquareStack className={className} />;
    case 'FILLET_3D':
      return <CornerDownRight className={className} />;
    case 'CHAMFER_3D':
      return <SquareSlash className={className} />;
    default:
      return <Box className={className} />;
  }
}

export const FeatureTreeItem: React.FC<FeatureTreeItemProps> = ({
  feature,
  isSelected,
  isPastRollback,
  onSelect,
  onToggleSuppress,
  onToggleVisibility,
  onRename,
  onDelete,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editingName, setEditingName] = useState(feature.name);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [showErrorTooltip, setShowErrorTooltip] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isVisible = feature.visible !== false;
  const isSuppressed = feature.suppressed === true;
  const hasError = Boolean(feature.error);

  // 當 feature.name 在外部改變時更新編輯狀態
  useEffect(() => {
    setEditingName(feature.name);
  }, [feature.name]);

  // 進入行內編輯模式時自動聚焦並全選文字
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // 點擊外部關閉右鍵選單
  useEffect(() => {
    if (!showContextMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowContextMenu(false);
      }
    };

    window.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showContextMenu]);

  // 更名提交
  const handleCommitRename = () => {
    const trimmed = editingName.trim();
    if (trimmed && trimmed !== feature.name) {
      onRename(feature.id, trimmed);
    } else {
      setEditingName(feature.name);
    }
    setIsEditing(false);
  };

  // 鍵盤處理 (Enter 提交, Esc 取消)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCommitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditingName(feature.name);
      setIsEditing(false);
    }
  };

  // 雙擊開啟編輯
  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isPastRollback) return;
    setIsEditing(true);
  };

  // 右鍵選單觸發
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect(feature.id);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };

  // 節點單擊選擇
  const handleNodeClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isEditing) return;
    onSelect(feature.id);
  };

  return (
    <div className="relative select-none font-sans">
      {/* 特徵節點主要容器 */}
      <div
        onClick={handleNodeClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        className={`group flex items-center justify-between px-2.5 py-1.5 my-0.5 rounded border transition-all cursor-pointer ${
          /* 置灰不可用 (SolidWorks 回退凍結態) */
          isPastRollback
            ? 'opacity-40 bg-neutral-900/40 border-neutral-800/50 grayscale cursor-not-allowed text-neutral-500'
            : isSelected
            ? 'bg-sky-950/80 border-sky-500/80 text-sky-100 shadow-sm'
            : 'bg-neutral-900/80 border-neutral-800/80 hover:bg-neutral-800 hover:border-neutral-700 text-neutral-200'
        }`}
      >
        {/* 左側：特徵圖示與名稱 */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* 特徵圖示 */}
          <span
            className={`shrink-0 transition-colors ${
              isPastRollback
                ? 'text-neutral-600'
                : isSuppressed
                ? 'text-neutral-500 opacity-50'
                : isSelected
                ? 'text-sky-400'
                : 'text-amber-400/90 group-hover:text-amber-300'
            }`}
          >
            {renderFeatureIcon(feature.type)}
          </span>

          {/* 特徵名稱（包含刪除線與行內編輯） */}
          <div className="min-w-0 flex-1">
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={handleCommitRename}
                onKeyDown={handleKeyDown}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                className="w-full bg-neutral-950 text-sky-300 border border-sky-500 rounded px-1.5 py-0.5 text-xs font-mono font-medium focus:outline-none focus:ring-1 focus:ring-sky-400"
              />
            ) : (
              <span
                className={`block truncate text-xs font-mono font-medium leading-tight ${
                  isSuppressed ? 'line-through opacity-50 text-neutral-400' : ''
                } ${
                  isPastRollback
                    ? 'text-neutral-500'
                    : isSelected
                    ? 'text-sky-100'
                    : 'text-neutral-200 group-hover:text-white'
                }`}
                title={feature.name}
              >
                {feature.name}
              </span>
            )}
          </div>
        </div>

        {/* 右側：警告圖示與快捷開關按鈕 */}
        <div className="flex items-center gap-1 shrink-0 ml-2">
          {/* 重算錯誤/警告訊息圖示 + Tooltip */}
          {hasError && (
            <div
              className="relative flex items-center"
              onMouseEnter={() => setShowErrorTooltip(true)}
              onMouseLeave={() => setShowErrorTooltip(false)}
            >
              <AlertTriangle className="w-3.5 h-3.5 text-red-500 animate-pulse shrink-0 cursor-help" />
              {showErrorTooltip && (
                <div className="absolute right-0 bottom-full mb-1.5 w-52 bg-red-950 border border-red-500/80 text-red-100 text-[11px] font-mono p-2 rounded shadow-xl z-50 pointer-events-none animate-in fade-in zoom-in-95 duration-100">
                  <div className="font-bold text-red-400 mb-0.5 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 text-red-400 shrink-0" />
                    <span>特徵計算異常</span>
                  </div>
                  <p className="text-red-200/90 leading-normal break-words">{feature.error}</p>
                </div>
              )}
            </div>
          )}

          {/* 懸停快捷小按鈕：抑制開關 & 可見度開關 */}
          <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
            {/* 抑制開關 (Pause / Play 圖示) */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!isPastRollback) onToggleSuppress(feature.id);
              }}
              disabled={isPastRollback}
              className={`p-1 rounded transition-colors ${
                isSuppressed
                  ? 'text-amber-400 hover:bg-amber-950/50'
                  : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
              } disabled:pointer-events-none`}
              title={isSuppressed ? '取消抑制 (Unsuppress)' : '抑制特徵 (Suppress)'}
            >
              {isSuppressed ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
            </button>

            {/* 可見度開關 (Eye / EyeOff 圖示) */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!isPastRollback) onToggleVisibility(feature.id);
              }}
              disabled={isPastRollback}
              className={`p-1 rounded transition-colors ${
                isVisible
                  ? 'text-sky-400 hover:bg-sky-950/50'
                  : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800'
              } disabled:pointer-events-none`}
              title={isVisible ? '隱藏特徵' : '顯示特徵'}
            >
              {isVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
            </button>
          </div>
        </div>
      </div>

      {/* 右鍵快顯選單 (Context Menu) */}
      {showContextMenu && (
        <div
          ref={menuRef}
          style={{ top: `${contextMenuPos.y}px`, left: `${contextMenuPos.x}px` }}
          className="fixed z-50 w-44 bg-neutral-900 border border-neutral-700 rounded-md shadow-2xl py-1 text-xs text-neutral-200 divide-y divide-neutral-800/80 animate-in fade-in zoom-in-95 duration-100"
        >
          {/* 標頭 */}
          <div className="px-3 py-1.5 text-[10px] font-mono font-semibold text-sky-400 bg-neutral-950/60 truncate">
            {feature.name}
          </div>

          {/* 選項列表 */}
          <div className="py-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowContextMenu(false);
                if (!isPastRollback) onToggleSuppress(feature.id);
              }}
              disabled={isPastRollback}
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-neutral-800 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {isSuppressed ? (
                <>
                  <Play className="w-3.5 h-3.5 text-amber-400" />
                  <span>取消抑制 (Unsuppress)</span>
                </>
              ) : (
                <>
                  <Pause className="w-3.5 h-3.5 text-neutral-400" />
                  <span>抑制特徵 (Suppress)</span>
                </>
              )}
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowContextMenu(false);
                if (!isPastRollback) onToggleVisibility(feature.id);
              }}
              disabled={isPastRollback}
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-neutral-800 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {isVisible ? (
                <>
                  <EyeOff className="w-3.5 h-3.5 text-neutral-400" />
                  <span>隱藏 (Hide)</span>
                </>
              ) : (
                <>
                  <Eye className="w-3.5 h-3.5 text-sky-400" />
                  <span>顯示 (Show)</span>
                </>
              )}
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowContextMenu(false);
                if (!isPastRollback) setIsEditing(true);
              }}
              disabled={isPastRollback}
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-neutral-800 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Edit3 className="w-3.5 h-3.5 text-sky-400" />
              <span>重新命名 (Rename)</span>
            </button>
          </div>

          <div className="py-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowContextMenu(false);
                if (!isPastRollback) onDelete(feature.id);
              }}
              disabled={isPastRollback}
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-red-950/60 text-red-400 hover:text-red-300 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>刪除特徵 (Delete)</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
