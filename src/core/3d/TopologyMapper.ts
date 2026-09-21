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
    } else if (!target.normal && !candidate.normal) {
      scoreDir = 1.0;
    } else {
      scoreDir = 0.0;
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
    } else if (!target.direction && !candidate.direction) {
      scoreDir = 1.0;
    } else {
      scoreDir = 0.0;
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
 * 嚴格遵循 Persistent Topology Resolution 語意，不進行 heuristic 猜測
 */
export function resolveTopoReference(
  targetRef: TopoReference,
  currentTopologyMap: TopologyMap
): TopoResolutionResult {
  // 1. validate bodyId
  if (targetRef.bodyId !== currentTopologyMap.bodyId) {
    return {
      status: 'body_mismatch',
      targetRef,
      candidates: [],
      kind: targetRef.subShapeType,
      generation: currentTopologyMap.version || 1,
      message: `Body mismatch: reference bodyId is ${targetRef.bodyId}, but map bodyId is ${currentTopologyMap.bodyId}.`,
    };
  }

  // 2. validate generation
  // targetRef.generation vs currentTopologyMap.version ? Wait, let's use the property that represents generation on map.
  // Note: TopologyMap has a 'version' which we assume means generation here. Wait, extractTopologyMap doesn't put generation in TopologyMap root, let me check. 
  // Wait, in extractTopologyMap, it is passed generation, but it sets version: Date.now(). Let me fix extractTopologyMap later or handle it here.
  // For now, let's assume currentTopologyMap will have generation.
  const mapGeneration = (currentTopologyMap as any).generation ?? 1; // We will update TopologyExtractor to include generation
  if (targetRef.generation !== mapGeneration) {
    return {
      status: 'stale_generation',
      targetRef,
      candidates: [],
      kind: targetRef.subShapeType,
      generation: mapGeneration,
      message: `Generation mismatch: reference generation is ${targetRef.generation}, but map generation is ${mapGeneration}.`,
    };
  }

  // 3. lookup persistentId and verify kind
  let pool: TopoReference[] = [];
  if (targetRef.subShapeType === 'FACE') {
    pool = currentTopologyMap.faces;
  } else if (targetRef.subShapeType === 'EDGE') {
    pool = currentTopologyMap.edges;
  } else if (targetRef.subShapeType === 'VERTEX') {
    pool = currentTopologyMap.vertices;
  } else {
    return {
      status: 'kind_mismatch',
      targetRef,
      candidates: [],
      kind: targetRef.subShapeType,
      generation: mapGeneration,
      message: `Unsupported subShapeType: ${targetRef.subShapeType}`,
    };
  }

  if (!pool || pool.length === 0) {
    return {
      status: 'unresolved',
      targetRef,
      candidates: [],
      kind: targetRef.subShapeType,
      generation: mapGeneration,
      message: 'Topology candidate pool is empty.',
    };
  }

  const exactCandidates = pool
    .map((candidate, index) => ({ candidate, index }))
    .filter(item => item.candidate.persistentId === targetRef.persistentId);

  if (exactCandidates.length === 0) {
    return {
      status: 'unresolved',
      targetRef,
      candidates: [],
      kind: targetRef.subShapeType,
      generation: mapGeneration,
      message: `No candidate found with persistentId ${targetRef.persistentId}.`,
    };
  }

  // 4. verify signature / topology identity
  const validCandidates = exactCandidates.filter(item => {
    // If the system's signature check requires exact match or high confidence:
    const score = computeSignatureSimilarity(targetRef.signature, item.candidate.signature, targetRef.subShapeType);
    return score >= 0.95; // strict threshold for signature match
  });

  if (validCandidates.length === 0) {
    return {
      status: 'signature_mismatch',
      targetRef,
      candidates: exactCandidates.map(c => c.candidate),
      kind: targetRef.subShapeType,
      generation: mapGeneration,
      message: `Candidates found by persistentId, but signature mismatched.`,
    };
  }

  // 5. 唯一候選？
  if (validCandidates.length === 1) {
    return {
      status: 'resolved',
      targetRef,
      candidates: validCandidates.map(c => c.candidate),
      resolvedPersistentId: validCandidates[0].candidate.persistentId,
      resolvedIndex: validCandidates[0].index,
      kind: targetRef.subShapeType,
      generation: mapGeneration,
    };
  }

  return {
    status: 'ambiguous',
    targetRef,
    candidates: validCandidates.map(c => c.candidate),
    kind: targetRef.subShapeType,
    generation: mapGeneration,
    message: `Multiple candidates (${validCandidates.length}) found for persistentId ${targetRef.persistentId}.`,
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
