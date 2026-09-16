import type {
  TopoReference,
  TopoSubShapeType,
  GeometrySignature,
  TopologyMap,
  TopoResolutionResult,
  Vector3D,
} from './PersistentTopology.types';

/**
 * 計算三維空間歐氏距離
 */
export function distVec3(a: Vector3D, b: Vector3D): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * 計算三維向量內積
 */
export function dotVec3(a: Vector3D, b: Vector3D): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * 計算三維向量模長
 */
export function lenVec3(a: Vector3D): number {
  return Math.hypot(a.x, a.y, a.z);
}

/**
 * 計算幾何簽章相似度評分（總分 0.0 ~ 1.0）
 */
export function computeSignatureSimilarity(
  target: GeometrySignature,
  candidate: GeometrySignature,
  subShapeType: TopoSubShapeType
): number {
  // 1. 質心鄰近度（Centroid Proximity，權重 0.40）
  const maxTolerance = 50.0; // mm
  const d = distVec3(target.centroid, candidate.centroid);
  const scoreCentroid = Math.max(0, 1 - d / maxTolerance);

  // 2. 度量比例相似度（Measure Consistency，權重 0.25）
  let scoreMeasure = 1.0;
  const mTarget = target.measure;
  const mCandidate = candidate.measure;
  if (mTarget > 1e-6 || mCandidate > 1e-6) {
    const maxM = Math.max(mTarget, mCandidate);
    const minM = Math.min(mTarget, mCandidate);
    scoreMeasure = maxM > 0 ? minM / maxM : 1.0;
  }

  // 3. 方向/法向一致性（Direction Alignment，權重 0.25）
  let scoreDir = 1.0;
  if (subShapeType === 'FACE') {
    if (target.normal && candidate.normal) {
      const lenT = lenVec3(target.normal);
      const lenC = lenVec3(candidate.normal);
      if (lenT > 1e-6 && lenC > 1e-6) {
        const dot = dotVec3(target.normal, candidate.normal) / (lenT * lenC);
        scoreDir = Math.abs(dot); // 0° 或 180° 皆為 1.0
      } else {
        scoreDir = 0.5;
      }
    } else {
      scoreDir = 0.5;
    }
  } else if (subShapeType === 'EDGE') {
    if (target.direction && candidate.direction) {
      const lenT = lenVec3(target.direction);
      const lenC = lenVec3(candidate.direction);
      if (lenT > 1e-6 && lenC > 1e-6) {
        const dot = dotVec3(target.direction, candidate.direction) / (lenT * lenC);
        scoreDir = Math.abs(dot);
      } else {
        scoreDir = 0.5;
      }
    } else {
      scoreDir = 0.5;
    }
  } else {
    scoreDir = 1.0;
  }

  // 4. 幾何拓撲類型匹配（Type Match，權重 0.10）
  let scoreType = 1.0;
  if (subShapeType === 'FACE') {
    if (target.surfaceType && candidate.surfaceType) {
      scoreType = target.surfaceType === candidate.surfaceType ? 1.0 : 0.0;
    }
  } else if (subShapeType === 'EDGE') {
    if (target.curveType && candidate.curveType) {
      scoreType = target.curveType === candidate.curveType ? 1.0 : 0.0;
    }
  }

  const confidence =
    scoreCentroid * 0.40 +
    scoreMeasure * 0.25 +
    scoreDir * 0.25 +
    scoreType * 0.10;

  return Math.max(0, Math.min(1, confidence));
}

/**
 * 解析單一拓撲參照體，將其對應至當前 B-Rep 拓撲地圖中的子形狀索引
 */
export function resolveTopoReference(
  targetRef: TopoReference,
  currentTopologyMap: TopologyMap,
  minConfidenceThreshold: number = 0.65
): TopoResolutionResult {
  let pool: TopoReference[] = [];
  if (targetRef.subShapeType === 'FACE') {
    pool = currentTopologyMap.faces;
  } else if (targetRef.subShapeType === 'EDGE') {
    pool = currentTopologyMap.edges;
  } else if (targetRef.subShapeType === 'VERTEX') {
    pool = currentTopologyMap.vertices;
  } else {
    pool = [...currentTopologyMap.faces, ...currentTopologyMap.edges, ...currentTopologyMap.vertices];
  }

  if (!pool || pool.length === 0) {
    return {
      targetRef,
      resolvedIndex: -1,
      confidence: 0,
      status: 'lost',
      message: 'Topology candidate pool is empty.',
    };
  }

  // 第一階段：精確 ID 匹配 (Exact Match)
  const exactIndex = pool.findIndex((c) => c.persistentId === targetRef.persistentId);
  if (exactIndex !== -1) {
    return {
      targetRef,
      resolvedIndex: exactIndex,
      confidence: 1.0,
      status: 'exact',
    };
  }

  // 第二階段：啟發式幾何特徵評分 (Heuristic Scored Match)
  const scoredCandidates = pool.map((candidate, index) => {
    const score = computeSignatureSimilarity(targetRef.signature, candidate.signature, targetRef.subShapeType);
    return { index, candidate, score };
  });

  scoredCandidates.sort((a, b) => b.score - a.score);

  const top1 = scoredCandidates[0];
  const top2 = scoredCandidates[1];

  if (!top1 || top1.score < minConfidenceThreshold) {
    return {
      targetRef,
      resolvedIndex: top1 ? top1.index : -1,
      confidence: top1 ? top1.score : 0,
      status: 'lost',
      message: 'All candidates fell below the confidence threshold.',
    };
  }

  if (top1.score >= 0.95) {
    return {
      targetRef,
      resolvedIndex: top1.index,
      confidence: top1.score,
      status: 'matched',
    };
  }

  if (top2 && top1.score - top2.score <= 0.15 && top2.score >= minConfidenceThreshold) {
    return {
      targetRef,
      resolvedIndex: top1.index,
      confidence: top1.score,
      status: 'ambiguous',
      message: `Ambiguous match: top score (${top1.score.toFixed(2)}) is close to second score (${top2.score.toFixed(2)}).`,
    };
  }

  return {
    targetRef,
    resolvedIndex: top1.index,
    confidence: top1.score,
    status: 'matched',
  };
}

/**
 * 批次解析多個拓撲參照體
 */
export function resolveBatchTopoReferences(
  targetRefs: TopoReference[],
  currentTopologyMap: TopologyMap
): TopoResolutionResult[] {
  return targetRefs.map((ref) => resolveTopoReference(ref, currentTopologyMap));
}
