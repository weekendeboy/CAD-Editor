import {
  CADEntity2D,
  CircleEntity,
  Constraint,
  Point2D,
  SketchProfile,
  ProfileSegment,
} from '../../types/cad';
import { PlanarGraph, GraphEdge } from './TopologyGraph';
import { isPointInsideProfileLoop } from './GeometryMath';

/**
 * Computes the signed area of a 2D polygon using the Shoelace formula.
 * - Positive area (> 0): Counter-Clockwise (CCW) orientation.
 * - Negative area (< 0): Clockwise (CW) orientation.
 */
export function calculateSignedArea(points: Point2D[]): number {
  const n = points.length;
  if (n < 3) return 0;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const current = points[i];
    const next = points[(i + 1) % n];
    sum += current.x * next.y - next.x * current.y;
  }
  return sum / 2;
}

/**
 * 內部暫存候選環資料結構 (Candidate Loop)
 */
interface CandidateLoop {
  id: string;
  points: Point2D[];
  segments: ProfileSegment[];
  area: number;
  bbox: { minX: number; maxX: number; minY: number; maxY: number };
  representativePoint: Point2D;
}

/**
 * 計算輪廓環的精確 2D Bounding Box（考量直線與圓弧極值點）
 */
function computeLoopBoundingBox(
  points: Point2D[],
  segments?: ProfileSegment[]
): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const update = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  for (const pt of points) {
    update(pt.x, pt.y);
  }

  if (segments) {
    const norm = (a: number) => {
      let r = a % (2 * Math.PI);
      if (r < 0) r += 2 * Math.PI;
      return r;
    };

    for (const seg of segments) {
      update(seg.start.x, seg.start.y);
      update(seg.end.x, seg.end.y);

      if (seg.type === 'arc' && seg.center && seg.radius !== undefined) {
        const { center, radius } = seg;
        // 4 個方位極值點 (0, π/2, π, 3π/2)
        const extrema = [
          { pt: { x: center.x + radius, y: center.y }, angle: 0 },
          { pt: { x: center.x, y: center.y + radius }, angle: Math.PI / 2 },
          { pt: { x: center.x - radius, y: center.y }, angle: Math.PI },
          { pt: { x: center.x, y: center.y - radius }, angle: (3 * Math.PI) / 2 },
        ];

        const startAngle = Math.atan2(seg.start.y - center.y, seg.start.x - center.x);
        const endAngle = Math.atan2(seg.end.y - center.y, seg.end.x - center.x);
        const aStart = norm(startAngle);
        const aEnd = norm(endAngle);
        const isCW = seg.sweepFlag === 1;

        for (const ext of extrema) {
          const aExt = norm(ext.angle);
          let onArc = false;
          if (isCW) {
            let sweep = norm(aStart - aEnd);
            if (sweep < 1e-7) sweep = 2 * Math.PI;
            const diff = norm(aStart - aExt);
            if (diff >= -1e-7 && diff <= sweep + 1e-7) onArc = true;
          } else {
            let sweep = norm(aEnd - aStart);
            if (sweep < 1e-7) sweep = 2 * Math.PI;
            const diff = norm(aExt - aStart);
            if (diff >= -1e-7 && diff <= sweep + 1e-7) onArc = true;
          }
          if (onArc) {
            update(ext.pt.x, ext.pt.y);
          }
        }
      }
    }
  }

  if (minX === Infinity) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }
  return { minX, maxX, minY, maxY };
}

/**
 * 尋找候選環的內部代表測試點 (Interior Representative Point)
 * 1. 圓形直接取圓心。
 * 2. 多邊形/混合環取質心；若質心不在環內（凹多邊形），取 BBox 內有效採樣點，確保代表點必在環內。
 */
function findInteriorRepresentativePoint(
  points: Point2D[],
  segments: ProfileSegment[],
  bbox: { minX: number; maxX: number; minY: number; maxY: number }
): Point2D {
  // 1. 若為標準獨立圓（由 2 個半圓弧組成），圓心即為最理想之內部代表點
  if (
    segments.length === 2 &&
    segments[0].type === 'arc' &&
    segments[1].type === 'arc' &&
    segments[0].center
  ) {
    const center = segments[0].center;
    if (isPointInsideProfileLoop(center, points, segments)) {
      return center;
    }
  }

  // 2. 多邊形質心 (Polygon Centroid)
  const n = points.length;
  if (n >= 3) {
    let cx = 0;
    let cy = 0;
    let signedArea = 0;
    for (let i = 0; i < n; i++) {
      const p0 = points[i];
      const p1 = points[(i + 1) % n];
      const cross = p0.x * p1.y - p1.x * p0.y;
      signedArea += cross;
      cx += (p0.x + p1.x) * cross;
      cy += (p0.y + p1.y) * cross;
    }
    signedArea *= 0.5;
    if (Math.abs(signedArea) > 1e-6) {
      cx /= 6 * signedArea;
      cy /= 6 * signedArea;
      const centroid = { x: cx, y: cy };
      if (isPointInsideProfileLoop(centroid, points, segments)) {
        return centroid;
      }
    }
  }

  // 3. 測試 Bounding Box 中心點
  const bboxCenter = {
    x: (bbox.minX + bbox.maxX) / 2,
    y: (bbox.minY + bbox.maxY) / 2,
  };
  if (isPointInsideProfileLoop(bboxCenter, points, segments)) {
    return bboxCenter;
  }

  // 4. 沿各邊段中點向內法向微位移取樣
  if (n >= 2) {
    for (let i = 0; i < n; i++) {
      const p0 = points[i];
      const p1 = points[(i + 1) % n];
      const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-4) {
        // CCW 環的內法向量為 (-dy/len, dx/len)
        const nx = -dy / len;
        const ny = dx / len;
        for (const step of [1e-3, 1e-2, 0.1, 0.5, 1.0]) {
          const testPt = { x: mid.x + nx * step, y: mid.y + ny * step };
          if (isPointInsideProfileLoop(testPt, points, segments)) {
            return testPt;
          }
          const testPtRev = { x: mid.x - nx * step, y: mid.y - ny * step };
          if (isPointInsideProfileLoop(testPtRev, points, segments)) {
            return testPtRev;
          }
        }
      }
    }
  }

  // 5. Bounding Box 內部網格採樣 (Grid Scan)，適用於任意複雜凹多邊形與環形
  const stepX = (bbox.maxX - bbox.minX) / 10;
  const stepY = (bbox.maxY - bbox.minY) / 10;
  if (stepX > 1e-5 && stepY > 1e-5) {
    for (let ix = 1; ix < 10; ix++) {
      for (let iy = 1; iy < 10; iy++) {
        const testPt = {
          x: bbox.minX + ix * stepX,
          y: bbox.minY + iy * stepY,
        };
        if (isPointInsideProfileLoop(testPt, points, segments)) {
          return testPt;
        }
      }
    }
  }

  if (points.length > 0) {
    return {
      x: points[0].x * 0.99 + bboxCenter.x * 0.01,
      y: points[0].y * 0.99 + bboxCenter.y * 0.01,
    };
  }

  return bboxCenter;
}

/**
 * 拓撲引擎封閉環與巢狀孔洞識別 (Topology Profile & Hole Detection)
 *
 * 流程規格：
 * 1. 依賴引入：引入 isPointInsideProfileLoop (來自 GeometryMath)，維持 PlanarGraph 結構。
 * 2. 收集候選環：包含 PlanarGraph 最左轉向法提取出的閉環 (計算代數面積 totalArea，剔除外表面雜訊) 與所有非建構線 CircleEntity 閉環。計算 AABB Bounding Box。
 * 3. 代表點選取：圓形直接取圓心；多邊形/混合環取質心，若質心不在環內則取 BBox 內有效採樣點，確保代表點必在環內。
 * 4. 包含樹精篩與深度判定：
 *    - 兩兩比對候選環 A 與 B (A ≠ B)：
 *      * 初篩：若 B.bbox 未在 A.bbox 內則跳過。
 *      * 精篩：若 isPointInsideProfileLoop(B.representativePoint, A.points, A.segments) 為 true，則 A 包含 B，B 的深度 depth + 1。
 *    - 實體與孔洞歸屬：
 *      * depth % 2 === 0 (偶數)：實體表面輪廓，升格為獨立 SketchProfile。
 *      * depth % 2 === 1 (奇數)：掏空孔洞，塞入其直接父級 (depth-1) 實體面的 innerLoops 與 innerSegments 中。
 * 5. 淨面積計算：profile.area = Math.max(0, outerArea - sum(innerHolesArea))。
 */
export function findClosedProfiles(
  entities: CADEntity2D[],
  constraintsOrTolerance?: Constraint[] | number,
  tolerance: number = 1e-3
): SketchProfile[] {
  let constraints: Constraint[] = [];
  let tol = tolerance;

  if (Array.isArray(constraintsOrTolerance)) {
    constraints = constraintsOrTolerance;
  } else if (typeof constraintsOrTolerance === 'number') {
    tol = constraintsOrTolerance;
  }

  // 1. 構建有向平面拓撲圖 (Planar Graph)
  const graph = PlanarGraph.buildFromEntities(entities, constraints, tol);

  // 2. 對每個節點的出邊按角度由小到大排序
  for (const node of graph.nodes.values()) {
    node.outgoingEdgeIds.sort((edgeIdA, edgeIdB) => {
      const edgeA = graph.edges.get(edgeIdA);
      const edgeB = graph.edges.get(edgeIdB);
      const angleA = edgeA !== undefined ? edgeA.angle : 0;
      const angleB = edgeB !== undefined ? edgeB.angle : 0;
      return angleA - angleB;
    });
  }

  const visitedEdgeIds = new Set<string>();
  const rawCandidateLoops: CandidateLoop[] = [];
  let loopCounter = 1;

  // 3. 收集 CircleEntity 獨立圓形轉換之閉環 (非建構線 CircleEntity 閉環)
  const circles = entities.filter(
    (e): e is CircleEntity => e.type === 'circle' && e.visible !== false && !e.isConstruction
  );

  for (const circle of circles) {
    const p0 = { x: circle.center.x + circle.radius, y: circle.center.y };
    const p1 = { x: circle.center.x - circle.radius, y: circle.center.y };
    const circleSegments: ProfileSegment[] = [
      {
        type: 'arc',
        start: p0,
        end: p1,
        center: { ...circle.center },
        radius: circle.radius,
        startAngle: 0,
        endAngle: Math.PI,
        isLargeArc: false,
        sweepFlag: 0,
      },
      {
        type: 'arc',
        start: p1,
        end: p0,
        center: { ...circle.center },
        radius: circle.radius,
        startAngle: Math.PI,
        endAngle: 2 * Math.PI,
        isLargeArc: false,
        sweepFlag: 0,
      },
    ];

    const circlePoints = [p0, p1];
    const circleBBox = {
      minX: circle.center.x - circle.radius,
      maxX: circle.center.x + circle.radius,
      minY: circle.center.y - circle.radius,
      maxY: circle.center.y + circle.radius,
    };

    rawCandidateLoops.push({
      id: `raw_loop_${loopCounter++}`,
      points: circlePoints,
      segments: circleSegments,
      area: Math.PI * circle.radius * circle.radius,
      bbox: circleBBox,
      representativePoint: { ...circle.center },
    });
  }

  // 4. 最左轉向法 (Left-most Turn) 遍歷提取有界 CCW 面
  for (const [startEdgeId, startEdge] of graph.edges) {
    if (visitedEdgeIds.has(startEdgeId)) {
      continue;
    }

    const loopEdges: GraphEdge[] = [];
    const loopPoints: Point2D[] = [];
    let currentEdge: GraphEdge | undefined = startEdge;
    const localVisited = new Set<string>();

    while (currentEdge && !localVisited.has(currentEdge.id)) {
      localVisited.add(currentEdge.id);
      loopEdges.push(currentEdge);

      const fromNode = graph.nodes.get(currentEdge.fromNodeId);
      if (fromNode) {
        loopPoints.push({ x: fromNode.point.x, y: fromNode.point.y });
      }

      const toNode = graph.nodes.get(currentEdge.toNodeId);
      if (!toNode || toNode.outgoingEdgeIds.length === 0) {
        break;
      }

      const outgoing = toNode.outgoingEdgeIds;
      const numOutgoing = outgoing.length;

      // 尋找由 toNode 回指至 fromNode 的反向邊
      let reverseIndex = outgoing.findIndex((edgeId) => {
        const edge = graph.edges.get(edgeId);
        return (
          edge !== undefined &&
          edge.toNodeId === currentEdge!.fromNodeId &&
          edge.entityId === currentEdge!.entityId
        );
      });

      if (reverseIndex === -1) {
        reverseIndex = outgoing.findIndex((edgeId) => {
          const edge = graph.edges.get(edgeId);
          return edge !== undefined && edge.toNodeId === currentEdge!.fromNodeId;
        });
      }

      if (reverseIndex === -1) {
        const revAngle = Math.atan2(
          (fromNode ? fromNode.point.y : 0) - toNode.point.y,
          (fromNode ? fromNode.point.x : 0) - toNode.point.x
        );
        let minDiff = Infinity;
        outgoing.forEach((edgeId, idx) => {
          const edge = graph.edges.get(edgeId);
          if (edge) {
            let diff = Math.abs(edge.angle - revAngle);
            if (diff > Math.PI) diff = 2 * Math.PI - diff;
            if (diff < minDiff) {
              minDiff = diff;
              reverseIndex = idx;
            }
          }
        });
      }

      if (numOutgoing === 2) {
        const edge0 = graph.edges.get(outgoing[0]);
        const edge1 = graph.edges.get(outgoing[1]);
        if (edge0 && edge1) {
          if (edge0.entityId === currentEdge.entityId) {
            currentEdge = edge1;
          } else {
            currentEdge = edge0;
          }
        } else {
          break;
        }
      } else {
        if (reverseIndex === -1) {
          break;
        }

        let nextEdgeIndex = (reverseIndex - 1 + numOutgoing) % numOutgoing;
        let nextEdgeId = outgoing[nextEdgeIndex];
        let nextEdge = graph.edges.get(nextEdgeId);

        // 嚴格禁止挑選到同實體的折返邊
        if (nextEdge && nextEdge.entityId === currentEdge.entityId) {
          nextEdgeIndex = (nextEdgeIndex - 1 + numOutgoing) % numOutgoing;
          nextEdgeId = outgoing[nextEdgeIndex];
          nextEdge = graph.edges.get(nextEdgeId);
        }

        currentEdge = nextEdge;
      }

      if (currentEdge && currentEdge.id === startEdgeId) {
        break;
      }
    }

    // 標記已遍歷邊
    for (const edge of loopEdges) {
      visitedEdgeIds.add(edge.id);
    }

    if (
      loopEdges.length >= 2 &&
      currentEdge !== undefined &&
      currentEdge.id === startEdgeId
    ) {
      const polyArea = calculateSignedArea(loopPoints);
      const loopSegments: ProfileSegment[] = [];
      let totalArea = polyArea;

      for (const edge of loopEdges) {
        const fromNode = graph.nodes.get(edge.fromNodeId);
        const toNode = graph.nodes.get(edge.toNodeId);
        if (!fromNode || !toNode) continue;

        const startPoint = { x: fromNode.point.x, y: fromNode.point.y };
        const endPoint = { x: toNode.point.x, y: toNode.point.y };

        if (edge.curveType === 'arc' && edge.arcData) {
          const { center, radius, startAngle, endAngle, isReversed = false } = edge.arcData;

          let diffAngle = endAngle - startAngle;
          while (diffAngle < 0) {
            diffAngle += 2 * Math.PI;
          }
          while (diffAngle >= 2 * Math.PI) {
            diffAngle -= 2 * Math.PI;
          }

          const isLargeArc = diffAngle > Math.PI;
          const sweepFlag = isReversed ? 1 : 0;

          const segment: ProfileSegment = {
            type: 'arc',
            start: startPoint,
            end: endPoint,
            center: { ...center },
            radius,
            startAngle: isReversed ? endAngle : startAngle,
            endAngle: isReversed ? startAngle : endAngle,
            isLargeArc,
            sweepFlag,
          };
          loopSegments.push(segment);

          // 圓弧弓形面積調整：A_seg = 0.5 * R^2 * (diffAngle - sin(diffAngle))
          const A_seg = 0.5 * radius * radius * (diffAngle - Math.sin(diffAngle));
          if (isReversed) {
            totalArea -= A_seg;
          } else {
            totalArea += A_seg;
          }
        } else {
          loopSegments.push({
            type: 'line',
            start: startPoint,
            end: endPoint,
          });
        }
      }

      // 有界內部面代數面積 > 1e-3（過濾無界外表面與退化環）
      if (totalArea > 1e-3) {
        const loopBBox = computeLoopBoundingBox(loopPoints, loopSegments);
        const representativePoint = findInteriorRepresentativePoint(
          loopPoints,
          loopSegments,
          loopBBox
        );

        rawCandidateLoops.push({
          id: `raw_loop_${loopCounter++}`,
          points: loopPoints,
          segments: loopSegments,
          area: totalArea,
          bbox: loopBBox,
          representativePoint,
        });
      }
    }
  }

  if (rawCandidateLoops.length === 0) {
    return [];
  }

  // 5. 包含樹精篩 (Containment Tree Construction)
  const N = rawCandidateLoops.length;
  // parents[j] 記錄所有包含環 j 的父環索引 (即 A 包含 B => A 即 parents[B] 中的一員)
  const parents: number[][] = Array.from({ length: N }, () => []);

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) continue;

      const loopA = rawCandidateLoops[i];
      const loopB = rawCandidateLoops[j];

      // 第一階段：代數面積與 Bounding Box 初篩 (AABB Reject Test)
      if (loopA.area <= loopB.area + 1e-4) {
        continue;
      }

      const eps = 1e-4;
      const isInsideBBox =
        loopB.bbox.minX >= loopA.bbox.minX - eps &&
        loopB.bbox.maxX <= loopA.bbox.maxX + eps &&
        loopB.bbox.minY >= loopA.bbox.minY - eps &&
        loopB.bbox.maxY <= loopA.bbox.maxY + eps;

      if (!isInsideBBox) {
        continue;
      }

      // 第二階段：使用代表點進行 Ray-Casting 精確包含測試 isPointInsideProfileLoop(B.代表點, A.points, A.segments)
      const inside = isPointInsideProfileLoop(
        loopB.representativePoint,
        loopA.points,
        loopA.segments
      );

      if (inside) {
        parents[j].push(i);
      }
    }
  }

  // 6. 深度奇偶判定 (Containment Depth Calculation)
  // depth[j] 為環 j 的巢狀深度
  const depth: number[] = parents.map((p) => p.length);

  let profileCounter = 1;
  const outerProfileMap = new Map<number, SketchProfile>();

  // 偶數深度 (depth % 2 === 0)：實體外表面 (Outer Loop / Island)，升格為獨立 SketchProfile
  for (let i = 0; i < N; i++) {
    if (depth[i] % 2 === 0) {
      const loop = rawCandidateLoops[i];
      outerProfileMap.set(i, {
        id: `profile_${profileCounter++}`,
        outerLoop: loop.points,
        segments: loop.segments,
        innerLoops: [],
        innerSegments: [],
        area: loop.area,
        isClockwise: false,
      });
    }
  }

  // 奇數深度 (depth % 2 === 1)：掏空孔洞 (Inner Loop / Hole)，將其推入直接父級 (depth-1) 實體面的 innerLoops 與 innerSegments 中
  for (let j = 0; j < N; j++) {
    if (depth[j] % 2 === 1) {
      const holeLoop = rawCandidateLoops[j];
      const directParentCandidates = parents[j].filter(
        (pIdx) => depth[pIdx] === depth[j] - 1
      );

      // 若有多個候選父環，選擇面積最小的直接包覆者
      let directParentIdx = directParentCandidates[0];
      for (let k = 1; k < directParentCandidates.length; k++) {
        const cIdx = directParentCandidates[k];
        if (rawCandidateLoops[cIdx].area < rawCandidateLoops[directParentIdx].area) {
          directParentIdx = cIdx;
        }
      }

      if (directParentIdx !== undefined && outerProfileMap.has(directParentIdx)) {
        const parentProfile = outerProfileMap.get(directParentIdx)!;
        parentProfile.innerLoops.push(holeLoop.points);
        if (!parentProfile.innerSegments) {
          parentProfile.innerSegments = [];
        }
        parentProfile.innerSegments.push(holeLoop.segments);
        // 淨面積計算：實體面 area = 扣除所有隸屬內孔後的面積
        parentProfile.area -= holeLoop.area;
      }
    }
  }

  // 7. 輸出最終 Profiles 清單，確保淨面積非負
  const finalProfiles: SketchProfile[] = [];
  for (const profile of outerProfileMap.values()) {
    profile.area = Math.max(0, profile.area);
    finalProfiles.push(profile);
  }

  return finalProfiles;
}
