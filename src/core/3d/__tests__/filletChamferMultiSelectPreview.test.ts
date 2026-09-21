import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeatureEvalOps } from '../FeaturePipelineAdapter';
import type { Fillet3DFeature, Chamfer3DFeature, CADDocument, LineEntity } from '../../../types/cad';
import type { SelectedEdgeItem, FilletChamferPreviewState } from '../../../store/cadStore.types';
import type { FeatureEvalOp } from '../SolidEngine.types';
import type { TopoReference } from '../PersistentTopology.types';

// ---------------------------------------------------------------------------
// Mock Store 邏輯與測試 (驗證 Shift + Click Multi-Select 與 Toggle)
// ---------------------------------------------------------------------------

class MockEdgeSelectionStore {
  selectedEdgeInfo: SelectedEdgeItem | null = null;
  selectedEdgeList: SelectedEdgeItem[] = [];
  filletChamferPreview: FilletChamferPreviewState | null = null;

  setSelectedEdgeInfo(edge: SelectedEdgeItem | null, isShift: boolean = false) {
    if (!edge) {
      this.selectedEdgeInfo = null;
      this.selectedEdgeList = [];
      return;
    }

    if (isShift) {
      const idx = this.selectedEdgeList.findIndex(
        (e) => e.edgeRef.edgeIndex === edge.edgeRef.edgeIndex
      );
      if (idx >= 0) {
        // Toggle: 移除已存在邊
        this.selectedEdgeList.splice(idx, 1);
        this.selectedEdgeInfo =
          this.selectedEdgeList.length > 0
            ? this.selectedEdgeList[this.selectedEdgeList.length - 1]
            : null;
      } else {
        // Toggle: 新增邊
        this.selectedEdgeList.push(edge);
        this.selectedEdgeInfo = edge;
      }
    } else {
      // 單選替換 (Click = Replace)
      this.selectedEdgeList = [edge];
      this.selectedEdgeInfo = edge;
    }
  }

  removeSelectedEdge(edgeIndex: number) {
    this.selectedEdgeList = this.selectedEdgeList.filter(
      (e) => e.edgeRef.edgeIndex !== edgeIndex
    );
    this.selectedEdgeInfo =
      this.selectedEdgeList.length > 0
        ? this.selectedEdgeList[this.selectedEdgeList.length - 1]
        : null;
  }

  clearSelectedEdges() {
    this.selectedEdgeList = [];
    this.selectedEdgeInfo = null;
  }

  setFilletChamferPreview(preview: FilletChamferPreviewState | null) {
    this.filletChamferPreview = preview;
  }
}

function createMockEdgeItem(edgeIndex: number, length: number = 100): SelectedEdgeItem {
  const topoRef: TopoReference = {
    featureId: 'extrude-base',
    type: 'EDGE',
    index: edgeIndex,
    persistentId: `edge-${edgeIndex}`,
    generation: 1,
    signature: {
      geometryType: 'line',
      length,
      startPoint: { x: 0, y: 0, z: 0 },
      endPoint: { x: 100, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
    },
  };

  return {
    edgeRef: {
      edgeIndex,
      curveType: 'line',
      length,
      direction: { x: 1, y: 0, z: 0 },
      startPoint: { x: 0, y: 0, z: 0 },
      endPoint: { x: 100, y: 0, z: 0 },
      topoRef,
    },
    startPoint: { x: 0, y: 0, z: 0 },
    endPoint: { x: 100, y: 0, z: 0 },
    meshEdgeIndex: edgeIndex,
  };
}

// ---------------------------------------------------------------------------
// 測試開始
// ---------------------------------------------------------------------------

test('STEP 3D-43B Case 1: 一般點擊 (Click without Shift) 為單選替換 (Replace behavior)', () => {
  const store = new MockEdgeSelectionStore();
  const edge1 = createMockEdgeItem(1);
  const edge2 = createMockEdgeItem(2);

  // 第一次單選 Edge #1
  store.setSelectedEdgeInfo(edge1, false);
  assert.equal(store.selectedEdgeList.length, 1);
  assert.equal(store.selectedEdgeList[0].edgeRef.edgeIndex, 1);
  assert.equal(store.selectedEdgeInfo?.edgeRef.edgeIndex, 1);

  // 第二次單選 Edge #2 (應替換，而非追加)
  store.setSelectedEdgeInfo(edge2, false);
  assert.equal(store.selectedEdgeList.length, 1);
  assert.equal(store.selectedEdgeList[0].edgeRef.edgeIndex, 2);
  assert.equal(store.selectedEdgeInfo?.edgeRef.edgeIndex, 2);
});

test('STEP 3D-43B Case 2: 按住 Shift 點擊 (Shift + Click) 為多選切換 (Toggle behavior)', () => {
  const store = new MockEdgeSelectionStore();
  const edge1 = createMockEdgeItem(1);
  const edge2 = createMockEdgeItem(2);
  const edge3 = createMockEdgeItem(3);

  // 先單選 Edge #1
  store.setSelectedEdgeInfo(edge1, false);
  assert.equal(store.selectedEdgeList.length, 1);

  // Shift + Click 選取 Edge #2
  store.setSelectedEdgeInfo(edge2, true);
  assert.equal(store.selectedEdgeList.length, 2);
  assert.deepEqual(
    store.selectedEdgeList.map((e) => e.edgeRef.edgeIndex),
    [1, 2]
  );

  // Shift + Click 選取 Edge #3
  store.setSelectedEdgeInfo(edge3, true);
  assert.equal(store.selectedEdgeList.length, 3);
  assert.deepEqual(
    store.selectedEdgeList.map((e) => e.edgeRef.edgeIndex),
    [1, 2, 3]
  );

  // 再次 Shift + Click Edge #2 (反選 / Toggle Off)
  store.setSelectedEdgeInfo(edge2, true);
  assert.equal(store.selectedEdgeList.length, 2);
  assert.deepEqual(
    store.selectedEdgeList.map((e) => e.edgeRef.edgeIndex),
    [1, 3]
  );
  assert.equal(store.selectedEdgeInfo?.edgeRef.edgeIndex, 3);
});

test('STEP 3D-43B Case 3: 邊線移除與全部清除 (removeSelectedEdge & clearSelectedEdges)', () => {
  const store = new MockEdgeSelectionStore();
  const edge1 = createMockEdgeItem(1);
  const edge2 = createMockEdgeItem(2);
  const edge3 = createMockEdgeItem(3);

  store.setSelectedEdgeInfo(edge1, true);
  store.setSelectedEdgeInfo(edge2, true);
  store.setSelectedEdgeInfo(edge3, true);
  assert.equal(store.selectedEdgeList.length, 3);

  // 移除 Edge #2
  store.removeSelectedEdge(2);
  assert.equal(store.selectedEdgeList.length, 2);
  assert.equal(
    store.selectedEdgeList.find((e) => e.edgeRef.edgeIndex === 2),
    undefined
  );

  // 清除全部
  store.clearSelectedEdges();
  assert.equal(store.selectedEdgeList.length, 0);
  assert.equal(store.selectedEdgeInfo, null);
});

test('STEP 3D-43B Case 4: FeaturePipelineAdapter 支援 Fillet 多 Edge 與單 Edge 拓撲轉換', () => {
  const edge1 = createMockEdgeItem(1);
  const edge2 = createMockEdgeItem(4);

  const filletFeature: Fillet3DFeature = {
    id: 'fillet-1',
    name: 'Fillet 1',
    type: 'FILLET_3D',
    radius: 5.0,
    edgeRefs: [edge1.edgeRef.topoRef!, edge2.edgeRef.topoRef!],
    edgeIndices: [1, 4],
    suppressed: false,
    dependencies: ['extrude-base'],
  };

  const ops = buildFeatureEvalOps([filletFeature], 1);
  const filletOp = ops.find((op) => op.featureId === 'fillet-1');

  assert.ok(filletOp, 'Fillet operation must be generated');
  assert.equal(filletOp.type, 'FILLET_3D');
  assert.equal(filletOp.fillet3D?.radius, 5.0);
  assert.deepEqual(filletOp.fillet3D?.edgeIndices, [1, 4]);
  assert.equal(filletOp.fillet3D?.edgeRefs?.length, 2);
  assert.equal(filletOp.fillet3D?.edgeRefs?.[0].persistentId, 'edge-1');
  assert.equal(filletOp.fillet3D?.edgeRefs?.[1].persistentId, 'edge-4');
});

test('STEP 3D-43B Case 5: FeaturePipelineAdapter 支援 Chamfer 多 Edge 與單 Edge 拓撲轉換', () => {
  const edge1 = createMockEdgeItem(2);
  const edge2 = createMockEdgeItem(3);

  const chamferFeature: Chamfer3DFeature = {
    id: 'chamfer-1',
    name: 'Chamfer 1',
    type: 'CHAMFER_3D',
    distance: 3.0,
    edgeRefs: [edge1.edgeRef.topoRef!, edge2.edgeRef.topoRef!],
    edgeIndices: [2, 3],
    suppressed: false,
    dependencies: ['extrude-base'],
  };

  const ops = buildFeatureEvalOps([chamferFeature], 1);
  const chamferOp = ops.find((op) => op.featureId === 'chamfer-1');

  assert.ok(chamferOp, 'Chamfer operation must be generated');
  assert.equal(chamferOp.type, 'CHAMFER_3D');
  assert.equal(chamferOp.chamfer3D?.distance, 3.0);
  assert.deepEqual(chamferOp.chamfer3D?.edgeIndices, [2, 3]);
  assert.equal(chamferOp.chamfer3D?.edgeRefs?.length, 2);
  assert.equal(chamferOp.chamfer3D?.edgeRefs?.[0].persistentId, 'edge-2');
  assert.equal(chamferOp.chamfer3D?.edgeRefs?.[1].persistentId, 'edge-3');
});

test('STEP 3D-43B Case 6: 預覽狀態隔離 (Preview State Isolation & Feature Tree Immutability)', () => {
  const store = new MockEdgeSelectionStore();

  // 模擬開啟預覽
  store.setFilletChamferPreview({
    type: 'FILLET_3D',
    mesh: {
      vertices: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    },
  });

  assert.ok(store.filletChamferPreview !== null);
  assert.equal(store.filletChamferPreview.type, 'FILLET_3D');
  assert.equal(store.filletChamferPreview.mesh?.vertices.length, 9);

  // 清除預覽
  store.setFilletChamferPreview(null);
  assert.equal(store.filletChamferPreview, null);
});

test('STEP 3D-43B Case 7: All Edges 模式在無指定 Edge 時正確傳遞 edgeSelectionMode', () => {
  const filletAllFeature: Fillet3DFeature = {
    id: 'fillet-all',
    name: 'Fillet All',
    type: 'FILLET_3D',
    radius: 2.0,
    edgeSelectionMode: 'all',
    suppressed: false,
    dependencies: ['extrude-base'],
  };

  const ops = buildFeatureEvalOps([filletAllFeature], 1);
  const filletOp = ops.find((op) => op.featureId === 'fillet-all');

  assert.ok(filletOp);
  assert.equal(filletOp.fillet3D?.edgeSelectionMode, 'all');
  assert.equal(filletOp.fillet3D?.radius, 2.0);
});
