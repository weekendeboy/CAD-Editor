import test from 'node:test';
import assert from 'node:assert';
import type {
  MeshSubshapeMapping,
  RuntimeBRepEdgeRef,
  RuntimeBRepFaceRef,
  RuntimeBRepVertexRef,
} from '../MeshSubshapeMapping.types';
import {
  resolveMeshEdgeToEdge,
  createMeshSelection,
} from '../MeshSubshapeResolver';
import {
  sampleArcPoints,
  generateArcHitboxSegments,
  isPointNearEdge,
} from '../ArcGeometryHelper';

function approxEqual(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) < eps;
}

// 建立包含直線與圓弧邊線的測試映射
function createMockLineAndArcMapping(): MeshSubshapeMapping {
  const brepEdges: RuntimeBRepEdgeRef[] = [
    // Edge 0: 直線邊線 (0,0,0) -> (100,0,0)
    {
      bodyId: 'main-body',
      edgeIndex: 0,
      runtimeId: 'brep_edge_main-body_0',
      curveType: 'line',
      length: 100,
      startPoint: { x: 0, y: 0, z: 0 },
      endPoint: { x: 100, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 0,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'line',
        length: 100,
        bodyId: 'main-body',
        generation: 1,
      },
    },
    // Edge 1: XY 平面 90 度圓弧邊線 (中心 (50, 50, 0), 半徑 50)
    // 起點 (100, 50, 0), 終點 (50, 100, 0)
    {
      bodyId: 'main-body',
      edgeIndex: 1,
      runtimeId: 'brep_edge_main-body_1',
      curveType: 'circle',
      length: 78.5398, // 50 * pi / 2
      direction: { x: 0, y: 1, z: 0 },
      startPoint: { x: 100, y: 50, z: 0 },
      endPoint: { x: 50, y: 100, z: 0 },
      center: { x: 50, y: 50, z: 0 },
      radius: 50,
      normal: { x: 0, y: 0, z: 1 },
      startAngle: 0,
      endAngle: Math.PI / 2,
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 1,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'circle',
        length: 78.5398,
        bodyId: 'main-body',
        generation: 1,
      },
    },
    // Edge 2: XZ 平面圓弧 (中心 (0, 50, 0), 半徑 25, 法向 (0, 1, 0))
    {
      bodyId: 'main-body',
      edgeIndex: 2,
      runtimeId: 'brep_edge_main-body_2',
      curveType: 'circle',
      length: 39.2699,
      startPoint: { x: 25, y: 50, z: 0 },
      endPoint: { x: 0, y: 50, z: 25 },
      center: { x: 0, y: 50, z: 0 },
      radius: 25,
      normal: { x: 0, y: 1, z: 0 },
      startAngle: 0,
      endAngle: Math.PI / 2,
      topoRef: {
        kind: 'EDGE',
        edgeIndex: 2,
        featureId: 'extrude-1',
        historyOpIndex: 0,
        curveType: 'circle',
        length: 39.2699,
        bodyId: 'main-body',
        generation: 1,
      },
    },
  ];

  return {
    bodyId: 'main-body',
    generation: 1,
    faces: [],
    edges: brepEdges,
    vertices: [],
    triangleToFaceIndex: [],
    faceTriangleRanges: [],
    edgeSegmentRanges: [
      { edgeIndex: 0, startSegment: 0, segmentCount: 1 },
      { edgeIndex: 1, startSegment: 1, segmentCount: 32 },
      { edgeIndex: 2, startSegment: 33, segmentCount: 32 },
    ],
    meshEdgeToBRepEdgeIndex: [0, ...Array(32).fill(1), ...Array(32).fill(2)],
    meshVertexToBRepVertexIndex: [],
  };
}

test('Test 1: Line Edge selection regression', () => {
  const mapping = createMockLineAndArcMapping();
  const lineEdge = mapping.edges[0];

  // 1. 直線取樣回傳起訖兩點
  const points = sampleArcPoints(lineEdge, 32);
  assert.strictEqual(points.length, 2, '直線邊線應只有起訖 2 點');
  assert.deepStrictEqual(points[0], { x: 0, y: 0, z: 0 });
  assert.deepStrictEqual(points[1], { x: 100, y: 0, z: 0 });

  // 2. 生成 1 段 Hitbox 圓柱
  const segments = generateArcHitboxSegments(points);
  assert.strictEqual(segments.length, 1);
  assert.ok(approxEqual(segments[0].length, 100));
  assert.ok(approxEqual(segments[0].mid.x, 50));

  // 3. 點選直線中間 (50, 0, 0)
  const hitResult = isPointNearEdge({ x: 50, y: 0, z: 0 }, lineEdge, 6);
  assert.strictEqual(hitResult.isNear, true);

  // 4. 解析為 kind = edge
  const resolved = resolveMeshEdgeToEdge(mapping, 0);
  assert.strictEqual(resolved.status, 'exact');
  assert.strictEqual(resolved.edgeRef?.runtimeId, 'brep_edge_main-body_0');

  const selection = createMeshSelection(mapping, { kind: 'edge', meshEdgeIndex: 0 });
  assert.ok(selection);
  assert.strictEqual(selection.kind, 'edge');
});

test('Test 2: Circular Arc Edge candidate geometry', () => {
  const mapping = createMockLineAndArcMapping();
  const arcEdge = mapping.edges[1];

  const points = sampleArcPoints(arcEdge, 32);
  assert.strictEqual(points.length, 33, '32 段圓弧取樣應產生 33 個點');

  // 起點與終點精準符合
  assert.ok(approxEqual(points[0].x, 100) && approxEqual(points[0].y, 50) && approxEqual(points[0].z, 0));
  assert.ok(approxEqual(points[32].x, 50) && approxEqual(points[32].y, 100) && approxEqual(points[32].z, 0));

  // 中間 Apex 點 (index 16) 角度為 45 度: 50 + 50*cos(45°) ≈ 85.3553, 50 + 50*sin(45°) ≈ 85.3553
  const midPoint = points[16];
  const expectedApexX = 50 + 50 * Math.cos(Math.PI / 4);
  const expectedApexY = 50 + 50 * Math.sin(Math.PI / 4);
  assert.ok(
    approxEqual(midPoint.x, expectedApexX, 0.1),
    `Apex X ${midPoint.x} should match ${expectedApexX}`
  );
  assert.ok(
    approxEqual(midPoint.y, expectedApexY, 0.1),
    `Apex Y ${midPoint.y} should match ${expectedApexY}`
  );
});

test('Test 3: Arc candidate points lie on the actual circle', () => {
  const mapping = createMockLineAndArcMapping();
  const arcEdge = mapping.edges[1];
  const points = sampleArcPoints(arcEdge, 32);

  const C = arcEdge.center!;
  const R = arcEdge.radius!;

  for (const pt of points) {
    const distToCenter = Math.hypot(pt.x - C.x, pt.y - C.y, pt.z - C.z);
    assert.ok(
      approxEqual(distToCenter, R, 0.01),
      `Point (${pt.x}, ${pt.y}, ${pt.z}) distance to center ${distToCenter} should equal radius ${R}`
    );
    // 共面於 Z = 0
    assert.ok(approxEqual(pt.z, 0, 1e-4), 'XY 平面圓弧 Z 座標必須為 0');
  }
});

test('Test 4: Arc Hitbox covers the entire curve', () => {
  const mapping = createMockLineAndArcMapping();
  const arcEdge = mapping.edges[1];
  const points = sampleArcPoints(arcEdge, 32);
  const segments = generateArcHitboxSegments(points);

  assert.strictEqual(segments.length, 32, '32 段取樣應生成 32 段 Hitbox 圓柱');

  let totalLength = 0;
  for (const seg of segments) {
    assert.ok(seg.length > 0);
    totalLength += seg.length;
  }

  // 32 段折線總長應極接近真實圓弧長度 (50 * pi / 2 ≈ 78.5398)
  assert.ok(
    approxEqual(totalLength, 78.5398, 0.5),
    `Total polyline length ${totalLength} should approximate true arc length 78.5398`
  );
});

test('Test 5: Arc selection resolves to: kind = edge', () => {
  const mapping = createMockLineAndArcMapping();
  // 在 meshEdgeToBRepEdgeIndex 中，索引 1~32 都對應到 Edge 1
  const resolved = resolveMeshEdgeToEdge(mapping, 5);
  assert.strictEqual(resolved.status, 'exact');
  assert.strictEqual(resolved.edgeRef?.edgeIndex, 1);
  assert.strictEqual(resolved.edgeRef?.curveType, 'circle');

  const selection = createMeshSelection(mapping, { kind: 'edge', meshEdgeIndex: 5 });
  assert.ok(selection);
  assert.strictEqual(selection.kind, 'edge');
  assert.strictEqual(selection.edgeRef?.edgeIndex, 1);
});

test('Test 6: Arc selection preserves correct TopoReference', () => {
  const mapping = createMockLineAndArcMapping();
  const resolved = resolveMeshEdgeToEdge(mapping, 10);
  assert.ok(resolved.edgeRef);
  assert.ok(resolved.edgeRef.topoRef);
  assert.strictEqual(resolved.edgeRef.topoRef.kind, 'EDGE');
  assert.strictEqual(resolved.edgeRef.topoRef.curveType, 'circle');
  assert.strictEqual(resolved.edgeRef.topoRef.edgeIndex, 1);
});

test('Test 7: Arc on XY plane', () => {
  const xyArc: RuntimeBRepEdgeRef = {
    bodyId: 'main-body',
    edgeIndex: 3,
    runtimeId: 'brep_edge_main-body_3',
    curveType: 'circle',
    center: { x: 0, y: 0, z: 10 },
    radius: 20,
    normal: { x: 0, y: 0, z: 1 },
    startAngle: 0,
    endAngle: Math.PI, // 半圓弧
  };

  const points = sampleArcPoints(xyArc, 32);
  assert.strictEqual(points.length, 33);
  for (const pt of points) {
    assert.ok(approxEqual(pt.z, 10, 1e-4), '所有點 Z 座標必須為 10');
    assert.ok(approxEqual(Math.hypot(pt.x, pt.y), 20, 0.01), '距離原點 (0,0) 必須為 20');
  }
});

test('Test 8: Arc on another 3D plane (XZ Plane)', () => {
  const mapping = createMockLineAndArcMapping();
  const xzArc = mapping.edges[2];

  const points = sampleArcPoints(xzArc, 32);
  assert.strictEqual(points.length, 33);

  for (const pt of points) {
    assert.ok(approxEqual(pt.y, 50, 1e-4), 'XZ 平面上的圓弧 Y 座標必須恆為 50');
    const distToCenter = Math.hypot(pt.x - 0, pt.z - 0);
    assert.ok(approxEqual(distToCenter, 25, 0.01), '距離中心點 (0, 50, 0) 必須為 25');
  }
});

test('Test 9: Reverse Arc direction', () => {
  const reverseArc: RuntimeBRepEdgeRef = {
    bodyId: 'main-body',
    edgeIndex: 4,
    runtimeId: 'brep_edge_main-body_4',
    curveType: 'circle',
    center: { x: 0, y: 0, z: 0 },
    radius: 30,
    normal: { x: 0, y: 0, z: 1 },
    startAngle: Math.PI,
    endAngle: 0, // 反向旋轉
  };

  const points = sampleArcPoints(reverseArc, 32);
  assert.strictEqual(points.length, 33);
  // 起點為 (-30, 0, 0)
  assert.ok(approxEqual(points[0].x, -30, 0.01));
  assert.ok(approxEqual(points[0].y, 0, 0.01));
  // 終點為 (30, 0, 0)
  assert.ok(approxEqual(points[32].x, 30, 0.01));
  assert.ok(approxEqual(points[32].y, 0, 0.01));
});

test('Test 10: Line + Arc 同時存在時互不干擾', () => {
  const mapping = createMockLineAndArcMapping();

  // 選取直線 (meshEdgeIndex 0)
  const lineSel = createMeshSelection(mapping, { kind: 'edge', meshEdgeIndex: 0 });
  assert.ok(lineSel);
  assert.strictEqual(lineSel.kind, 'edge');
  assert.strictEqual(lineSel.edgeRef?.curveType, 'line');
  assert.strictEqual(lineSel.edgeRef?.edgeIndex, 0);

  // 選取圓弧 (meshEdgeIndex 15)
  const arcSel = createMeshSelection(mapping, { kind: 'edge', meshEdgeIndex: 15 });
  assert.ok(arcSel);
  assert.strictEqual(arcSel.kind, 'edge');
  assert.strictEqual(arcSel.edgeRef?.curveType, 'circle');
  assert.strictEqual(arcSel.edgeRef?.edgeIndex, 1);

  // 再次確認直線不受影響
  const lineSelAgain = createMeshSelection(mapping, { kind: 'edge', meshEdgeIndex: 0 });
  assert.strictEqual(lineSelAgain?.edgeRef?.edgeIndex, 0);
});

test('Test 11 (Special): Arc Midpoint / Apex Click Hit Test', () => {
  const mapping = createMockLineAndArcMapping();
  const arcEdge = mapping.edges[1];

  // 圓弧 Apex 座標: (50 + 50*cos(45°), 50 + 50*sin(45°), 0) ≈ (85.3553, 85.3553, 0)
  const apexPoint = {
    x: 50 + 50 * Math.cos(Math.PI / 4),
    y: 50 + 50 * Math.sin(Math.PI / 4),
    z: 0,
  };

  // 弦 (Chord) 中點座標: ((100+50)/2, (50+100)/2, 0) = (75, 75, 0)
  // 若使用舊 chord hitbox，Apex 與 chord 距離為 sqrt((85.3553-75)^2 + (85.3553-75)^2) ≈ 14.64mm > 6mm tolerance!
  const chordMidPoint = { x: 75, y: 75, z: 0 };
  const distApexToChord = Math.hypot(apexPoint.x - chordMidPoint.x, apexPoint.y - chordMidPoint.y);
  assert.ok(
    distApexToChord > 14.0,
    `Chord distance ${distApexToChord} confirms Apex is far from chord`
  );

  // 在真實圓弧 Hitbox 下，點擊 Apex 必須成功命中！
  const apexHit = isPointNearEdge(apexPoint, arcEdge, 6);
  assert.strictEqual(apexHit.isNear, true, '使用者點擊圓弧頂點 (Apex) 必須精準命中 Hitbox');
  assert.ok(apexHit.minDistance < 0.2, `Apex 距離取樣段落必須小於 0.2mm (實測 ${apexHit.minDistance})`);

  // 點擊圓弧上任意中間點 (例如 30 度處)
  const pointAt30Deg = {
    x: 50 + 50 * Math.cos(Math.PI / 6),
    y: 50 + 50 * Math.sin(Math.PI / 6),
    z: 0,
  };
  const hit30 = isPointNearEdge(pointAt30Deg, arcEdge, 6);
  assert.strictEqual(hit30.isNear, true, '使用者點擊 30 度弧線本體必須精準命中');
  assert.ok(hit30.minDistance < 0.2);
});
