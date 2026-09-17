/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CADEntity2D, ConstraintType } from '../../types/cad';

/**
 * 驗證是否可對選取的圖元套用「水平 (Horizontal)」約束
 */
export function canApplyHorizontal(
  selectedEntities: CADEntity2D[] = [],
  hasOriginSelected: boolean = false
): boolean {
  return canApplyHorizontalVertical(selectedEntities, hasOriginSelected);
}

/**
 * 驗證是否可對選取的圖元套用「垂直 (Vertical)」約束
 */
export function canApplyVertical(
  selectedEntities: CADEntity2D[] = [],
  hasOriginSelected: boolean = false
): boolean {
  return canApplyHorizontalVertical(selectedEntities, hasOriginSelected);
}

/**
 * 水平/垂直共用判定邏輯：
 * 1. 選取 1 條直線
 * 2. 選取 1 個圖元 + 虛擬原點 (Origin)
 * 3. 選取 2 個圓形或圓弧 (對齊圓心)
 * 4. 選取 1 條直線 + 1 個圓形/圓弧 (對齊端點與圓心)
 */
export function canApplyHorizontalVertical(
  selectedEntities: CADEntity2D[] = [],
  hasOriginSelected: boolean = false
): boolean {
  const totalSelectedCount = selectedEntities.length + (hasOriginSelected ? 1 : 0);
  if (totalSelectedCount === 1) {
    return selectedEntities[0]?.type === 'line';
  }
  if (totalSelectedCount === 2) {
    if (hasOriginSelected && selectedEntities.length === 1) {
      return true;
    }
    if (selectedEntities.length === 2) {
      const allCurves = selectedEntities.every(
        (e) => e.type === 'circle' || e.type === 'arc'
      );
      if (allCurves) return true;

      const hasCurve = selectedEntities.some(
        (e) => e.type === 'circle' || e.type === 'arc'
      );
      const hasLine = selectedEntities.some((e) => e.type === 'line');
      if (hasCurve && hasLine) return true;
    }
  }
  return false;
}

/**
 * 驗證是否可套用「重合 / 同心 (Coincident / Concentric)」約束：
 * 總選取數量為 2（包含 2 個幾何圖元，或 1 個幾何圖元 + 虛擬原點）
 */
export function canApplyCoincident(
  selectedEntities: CADEntity2D[] = [],
  hasOriginSelected: boolean = false
): boolean {
  const totalSelectedCount = selectedEntities.length + (hasOriginSelected ? 1 : 0);
  if (totalSelectedCount !== 2) return false;
  return hasOriginSelected ? selectedEntities.length === 1 : selectedEntities.length === 2;
}

/**
 * 驗證是否選取了兩條直線 (用於平行、垂直、等長)
 */
export function isBothLines(
  selectedEntities: CADEntity2D[] = [],
  hasOriginSelected: boolean = false
): boolean {
  const totalSelectedCount = selectedEntities.length + (hasOriginSelected ? 1 : 0);
  return (
    totalSelectedCount === 2 &&
    !hasOriginSelected &&
    selectedEntities.length === 2 &&
    selectedEntities.every((e) => e.type === 'line')
  );
}

/**
 * 驗證是否可套用「平行 (Parallel)」約束
 */
export function canApplyParallel(
  selectedEntities: CADEntity2D[] = [],
  hasOriginSelected: boolean = false
): boolean {
  return isBothLines(selectedEntities, hasOriginSelected);
}

/**
 * 驗證是否可套用「垂直 (Perpendicular)」約束
 */
export function canApplyPerpendicular(
  selectedEntities: CADEntity2D[] = [],
  hasOriginSelected: boolean = false
): boolean {
  return isBothLines(selectedEntities, hasOriginSelected);
}

/**
 * 驗證是否可套用「等長 (Equal Length)」約束
 */
export function canApplyEqualLength(
  selectedEntities: CADEntity2D[] = [],
  hasOriginSelected: boolean = false
): boolean {
  return isBothLines(selectedEntities, hasOriginSelected);
}

/**
 * 驗證是否可套用「相切 (Tangent)」約束：
 * 總選取數量為 2 且不包含原點：
 * 1. 1 條直線 + 1 個圓/圓弧
 * 2. 2 個圓/圓弧
 */
export function canApplyTangent(
  selectedEntities: CADEntity2D[] = [],
  hasOriginSelected: boolean = false
): boolean {
  const totalSelectedCount = selectedEntities.length + (hasOriginSelected ? 1 : 0);
  if (totalSelectedCount !== 2 || hasOriginSelected || selectedEntities.length !== 2) {
    return false;
  }

  const isLineAndCurve =
    (selectedEntities[0].type === 'line' &&
      (selectedEntities[1].type === 'circle' || selectedEntities[1].type === 'arc')) ||
    ((selectedEntities[0].type === 'circle' || selectedEntities[0].type === 'arc') &&
      selectedEntities[1].type === 'line');

  const isBothCurves =
    (selectedEntities[0].type === 'circle' || selectedEntities[0].type === 'arc') &&
    (selectedEntities[1].type === 'circle' || selectedEntities[1].type === 'arc');

  return isLineAndCurve || isBothCurves;
}

/**
 * 驗證是否可套用「等半徑 (Equal Radius)」約束：
 * 總選取數量為 2 且為 2 個圓形或圓弧
 */
export function canApplyEqualRadius(
  selectedEntities: CADEntity2D[] = [],
  hasOriginSelected: boolean = false
): boolean {
  const totalSelectedCount = selectedEntities.length + (hasOriginSelected ? 1 : 0);
  if (totalSelectedCount !== 2 || hasOriginSelected || selectedEntities.length !== 2) {
    return false;
  }
  return selectedEntities.every((e) => e.type === 'circle' || e.type === 'arc');
}

/**
 * 驗證是否可套用「固定 (Fix)」約束：
 * 剛好選取 1 個幾何圖元且不包含原點
 */
export function canApplyFix(
  selectedEntities: CADEntity2D[] = [],
  hasOriginSelected: boolean = false
): boolean {
  const totalSelectedCount = selectedEntities.length + (hasOriginSelected ? 1 : 0);
  return totalSelectedCount === 1 && !hasOriginSelected && selectedEntities.length === 1;
}

/**
 * 根據約束類型，檢查當前選取的圖元組合是否合法
 */
export function canApplyConstraint(
  type: ConstraintType,
  selectedEntities: CADEntity2D[] = [],
  hasOriginSelected: boolean = false
): boolean {
  switch (type) {
    case 'horizontal':
      return canApplyHorizontal(selectedEntities, hasOriginSelected);
    case 'vertical':
      return canApplyVertical(selectedEntities, hasOriginSelected);
    case 'coincident':
      return canApplyCoincident(selectedEntities, hasOriginSelected);
    case 'parallel':
      return canApplyParallel(selectedEntities, hasOriginSelected);
    case 'perpendicular':
      return canApplyPerpendicular(selectedEntities, hasOriginSelected);
    case 'equal_length':
      return canApplyEqualLength(selectedEntities, hasOriginSelected);
    case 'tangent':
      return canApplyTangent(selectedEntities, hasOriginSelected);
    case 'equal_radius':
      return canApplyEqualRadius(selectedEntities, hasOriginSelected);
    case 'fix':
      return canApplyFix(selectedEntities, hasOriginSelected);
    default:
      return false;
  }
}

/**
 * 根據目前選取的圖元與原點狀態，計算並回傳所有允許套用的約束類型清單
 */
export function getAvailableConstraints(
  selectedEntities: CADEntity2D[] = [],
  hasOriginSelected: boolean = false
): ConstraintType[] {
  const available: ConstraintType[] = [];

  if (canApplyHorizontal(selectedEntities, hasOriginSelected)) {
    available.push('horizontal');
  }
  if (canApplyVertical(selectedEntities, hasOriginSelected)) {
    available.push('vertical');
  }
  if (canApplyCoincident(selectedEntities, hasOriginSelected)) {
    available.push('coincident');
  }
  if (canApplyFix(selectedEntities, hasOriginSelected)) {
    available.push('fix');
  }
  if (canApplyParallel(selectedEntities, hasOriginSelected)) {
    available.push('parallel');
  }
  if (canApplyPerpendicular(selectedEntities, hasOriginSelected)) {
    available.push('perpendicular');
  }
  if (canApplyEqualLength(selectedEntities, hasOriginSelected)) {
    available.push('equal_length');
  }
  if (canApplyTangent(selectedEntities, hasOriginSelected)) {
    available.push('tangent');
  }
  if (canApplyEqualRadius(selectedEntities, hasOriginSelected)) {
    available.push('equal_radius');
  }

  return available;
}

/**
 * 物件導向封裝 (ConstraintValidator Class)
 */
export class ConstraintValidator {
  static canApply(
    type: ConstraintType,
    selectedEntities: CADEntity2D[],
    hasOriginSelected: boolean = false
  ): boolean {
    return canApplyConstraint(type, selectedEntities, hasOriginSelected);
  }

  static getAvailable(
    selectedEntities: CADEntity2D[],
    hasOriginSelected: boolean = false
  ): ConstraintType[] {
    return getAvailableConstraints(selectedEntities, hasOriginSelected);
  }

  static canApplyHorizontalVertical(
    selectedEntities: CADEntity2D[],
    hasOriginSelected: boolean = false
  ): boolean {
    return canApplyHorizontalVertical(selectedEntities, hasOriginSelected);
  }

  static isBothLines(
    selectedEntities: CADEntity2D[],
    hasOriginSelected: boolean = false
  ): boolean {
    return isBothLines(selectedEntities, hasOriginSelected);
  }
}
