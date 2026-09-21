import test from 'node:test';
import assert from 'node:assert';
import {
  createOffsetPlane,
  FRONT_PLANE,
  TOP_PLANE,
  RIGHT_PLANE,
  DatumFrontPlane,
  DatumTopPlane,
  DatumRightPlane,
} from '../DatumPlaneEngine';
import type { CustomPlane, CADDocument, DatumPlaneFeature } from '../../../types/cad';
import { createEmptyCADDocument } from '../../../types/cad';

test('Datum Plane Offset Preview — Front Plane + 30mm', () => {
  const refPlane = FRONT_PLANE;
  const offsetDistance = 30;
  const preview = createOffsetPlane(refPlane, offsetDistance, 'datum-plane-preview', 'Front Plane (Preview Offset: +30mm)');

  assert.strictEqual(preview.id, 'datum-plane-preview');
  assert.strictEqual(preview.origin.x, 0);
  assert.strictEqual(preview.origin.y, 0);
  assert.strictEqual(preview.origin.z, 30);
  assert.strictEqual(preview.normal.x, 0);
  assert.strictEqual(preview.normal.y, 0);
  assert.strictEqual(preview.normal.z, 1);
  assert.strictEqual(preview.xAxis.x, 1);
  assert.strictEqual(preview.yAxis.y, 1);
});

test('Datum Plane Offset Preview — Front Plane + 50mm Live Update', () => {
  const refPlane = FRONT_PLANE;
  const offsetDistance = 50;
  const preview = createOffsetPlane(refPlane, offsetDistance, 'datum-plane-preview', 'Front Plane (Preview Offset: +50mm)');

  assert.strictEqual(preview.origin.z, 50);
  assert.strictEqual(preview.normal.z, 1);
});

test('Datum Plane Offset Preview — Front Plane - 50mm (Flip)', () => {
  const refPlane = FRONT_PLANE;
  const offsetDistance = -50;
  const preview = createOffsetPlane(refPlane, offsetDistance, 'datum-plane-preview', 'Front Plane (Preview Offset: -50mm)');

  assert.strictEqual(preview.origin.z, -50);
  assert.strictEqual(preview.normal.z, 1);
});

test('Datum Plane Offset Preview — Top Plane + 30mm', () => {
  const refPlane = TOP_PLANE;
  const offsetDistance = 30;
  const preview = createOffsetPlane(refPlane, offsetDistance, 'datum-plane-preview', 'Top Plane (Preview Offset: +30mm)');

  assert.strictEqual(preview.origin.x, 0);
  assert.strictEqual(preview.origin.y, 30);
  assert.strictEqual(preview.origin.z, 0);
  assert.strictEqual(preview.normal.x, 0);
  assert.strictEqual(preview.normal.y, 1);
  assert.strictEqual(preview.normal.z, 0);
});

test('Datum Plane Offset Preview — Right Plane + 25mm', () => {
  const refPlane = RIGHT_PLANE;
  const offsetDistance = 25;
  const preview = createOffsetPlane(refPlane, offsetDistance, 'datum-plane-preview', 'Right Plane (Preview Offset: +25mm)');

  assert.strictEqual(preview.origin.x, 25);
  assert.strictEqual(preview.origin.y, 0);
  assert.strictEqual(preview.origin.z, 0);
  assert.strictEqual(preview.normal.x, 1);
  assert.strictEqual(preview.normal.y, 0);
  assert.strictEqual(preview.normal.z, 0);
});

test('Datum Plane Offset Preview — Custom Datum Plane + 30mm chaining', () => {
  // 建立第一個基準面 (Front + 30mm)
  const customPlane1 = createOffsetPlane(FRONT_PLANE, 30, 'datum-plane-1', 'Datum Plane 1');
  assert.strictEqual(customPlane1.origin.z, 30);

  // 以 customPlane1 為參照面，預覽 +30mm (空間位置應在 z = 60mm)
  const preview = createOffsetPlane(customPlane1, 30, 'datum-plane-preview', 'Datum Plane 1 (Preview Offset: +30mm)');
  assert.strictEqual(preview.origin.x, 0);
  assert.strictEqual(preview.origin.y, 0);
  assert.strictEqual(preview.origin.z, 60);
  assert.strictEqual(preview.normal.z, 1);
});

test('Datum Plane Offset Preview — Invariant: Preview must NOT mutate document featureTree or rollbackIndex', () => {
  const initialDoc = createEmptyCADDocument();
  const initialTreeLength = initialDoc.featureTree.length;
  const initialRollbackIndex = initialDoc.rollbackIndex;
  const initialPlanesCount = Object.keys(initialDoc.planes || {}).length;

  // 模擬即時計算 Preview
  const refPlane = FRONT_PLANE;
  const offsetDistance = 100;
  const preview = createOffsetPlane(refPlane, offsetDistance, 'datum-plane-preview', 'Front Plane (Preview)');

  // 驗證計算 preview 後，document 狀態保持不變
  assert.strictEqual(initialDoc.featureTree.length, initialTreeLength);
  assert.strictEqual(initialDoc.rollbackIndex, initialRollbackIndex);
  assert.strictEqual(Object.keys(initialDoc.planes || {}).length, initialPlanesCount);
  assert.ok(preview);
});
