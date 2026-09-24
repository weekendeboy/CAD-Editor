import type {
  TopoReference,
  TopoSubShapeType,
  GeometrySignature,
  TopologyMap,
  TopoResolutionResult,
  Vector3D,
  TopologyResolutionMode,
  TopoResolutionOptions,
} from './PersistentTopology.types';

export type { TopologyResolutionMode, TopoResolutionOptions };

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
  // 採用平滑衰減函數避免硬截斷飽和歸零造成同分歧義
  const d = distVec3(target.centroid, candidate.centroid);
  const scoreCentroid = 1 / (1 + d / 50.0);

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
 * 支援兩種模式：
 * - 'STRICT' (預設): 嚴格驗證 generation 與 persistentId，generation 不符即回傳 stale_generation，persistentId 不符回傳 unresolved
 * - 'EVOLVE': 允許舊世代幾何參照演化至新世代 (targetGeneration < currentGeneration)，在保持來源 Feature Identity (Provenance) 下進行 Signature 演化匹配
 */
export function resolveTopoReference(
  targetRef: TopoReference,
  currentTopologyMap: TopologyMap,
  options?: TopoResolutionOptions
): TopoResolutionResult {
  const mode: TopologyResolutionMode = options?.resolutionMode ?? 'STRICT';
  const mapGeneration = (currentTopologyMap as any).generation ?? 1;
  const targetGeneration = targetRef.generation;

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
  if (mode === 'STRICT') {
    if (targetGeneration !== undefined && targetGeneration !== mapGeneration) {
      console.warn(
        `[TNP GENERATION BLOCK]\n` +
        `mode: STRICT\n` +
        `targetGeneration: ${targetGeneration}\n` +
        `currentGeneration: ${mapGeneration}\n` +
        `status: stale_generation`
      );
      return {
        status: 'stale_generation',
        targetRef,
        candidates: [],
        kind: targetRef.subShapeType,
        generation: mapGeneration,
        message: `Generation mismatch: reference generation is ${targetGeneration}, but map generation is ${mapGeneration}.`,
      };
    }
  } else if (mode === 'EVOLVE') {
    if (targetGeneration !== undefined && targetGeneration !== mapGeneration) {
      if (targetGeneration > mapGeneration) {
        console.warn(
          `[TNP GENERATION BLOCK]\n` +
          `mode: EVOLVE\n` +
          `targetGeneration: ${targetGeneration}\n` +
          `currentGeneration: ${mapGeneration}\n` +
          `status: stale_generation`
        );
        return {
          status: 'stale_generation',
          targetRef,
          candidates: [],
          kind: targetRef.subShapeType,
          generation: mapGeneration,
          message: `Cannot resolve future generation: reference generation is ${targetGeneration}, but map generation is ${mapGeneration}.`,
        };
      }
      console.log(
        `[TNP GENERATION EVOLUTION]\n` +
        `mode: EVOLVE\n` +
        `targetGeneration: ${targetGeneration}\n` +
        `currentGeneration: ${mapGeneration}\n` +
        `provenanceFeatureId: ${targetRef.featureId}`
      );
    }
  }

  // 3. lookup persistentId and verify kind
  // Cross-subshape check: if targetRef.persistentId exists in another pool, it is a cross-kind mismatch
  if (targetRef.subShapeType === 'EDGE' && currentTopologyMap.faces?.some(f => f.persistentId === targetRef.persistentId)) {
    return {
      status: 'unresolved',
      targetRef,
      candidates: [],
      kind: targetRef.subShapeType,
      generation: mapGeneration,
      message: `persistentId ${targetRef.persistentId} belongs to a FACE, not an EDGE.`,
    };
  }
  if (targetRef.subShapeType === 'FACE' && currentTopologyMap.edges?.some(e => e.persistentId === targetRef.persistentId)) {
    return {
      status: 'unresolved',
      targetRef,
      candidates: [],
      kind: targetRef.subShapeType,
      generation: mapGeneration,
      message: `persistentId ${targetRef.persistentId} belongs to an EDGE, not a FACE.`,
    };
  }

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
    if (mode === 'EVOLVE' && targetGeneration !== undefined && targetGeneration < mapGeneration) {
      console.log(`[TNP EVOLUTION FAILED]\nreason: Topology candidate pool is empty.`);
    }
    return {
      status: 'unresolved',
      targetRef,
      candidates: [],
      kind: targetRef.subShapeType,
      generation: mapGeneration,
      message: 'Topology candidate pool is empty.',
    };
  }

  // --- 優先級 1: PersistentId Exact Match ---
  let exactCandidates = pool
    .map((candidate, index) => ({ candidate, index }))
    .filter(item => item.candidate.persistentId === targetRef.persistentId);

  if (exactCandidates.length === 0 && targetRef.persistentId && targetRef.persistentId.includes('_c_')) {
    const sigHash = targetRef.persistentId.slice(targetRef.persistentId.indexOf('_c_'));
    exactCandidates = pool
      .map((candidate, index) => ({ candidate, index }))
      .filter(item => item.candidate.featureId === targetRef.featureId && item.candidate.persistentId.endsWith(sigHash));
  }

  if (exactCandidates.length > 0) {
    // 驗證幾何簽章吻合度（嚴格閾值 0.95）
    const validCandidates = exactCandidates.filter(item => {
      const score = computeSignatureSimilarity(targetRef.signature, item.candidate.signature, targetRef.subShapeType);
      return score >= 0.95;
    });

    if (validCandidates.length === 0) {
      if (mode === 'EVOLVE' && targetGeneration !== undefined && targetGeneration < mapGeneration) {
        console.log(`[TNP EVOLUTION FAILED]\nreason: Candidate found by persistentId, but signature mismatched.`);
      }
      return {
        status: 'signature_mismatch',
        targetRef,
        candidates: exactCandidates.map(c => c.candidate),
        kind: targetRef.subShapeType,
        generation: mapGeneration,
        message: `Candidates found by persistentId, but signature mismatched.`,
      };
    }

    if (validCandidates.length >= 1) {
      if (mode === 'EVOLVE' && targetGeneration !== undefined && targetGeneration < mapGeneration) {
        console.log(
          `[TNP EVOLUTION RESOLVED]\n` +
          `sourceFeatureId: ${validCandidates[0].candidate.featureId}\n` +
          `fromGeneration: ${targetGeneration}\n` +
          `toGeneration: ${mapGeneration}\n` +
          `resolvedPersistentId: ${validCandidates[0].candidate.persistentId}\n` +
          `score: 1.0`
        );
      }
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
  }

  // STRICT Mode: 若無精確 persistentId 吻合，嚴禁進入 Signature Fallback，直接回傳 unresolved
  if (mode === 'STRICT') {
    return {
      status: 'unresolved',
      targetRef,
      candidates: [],
      kind: targetRef.subShapeType,
      generation: mapGeneration,
      message: `Persistent ID ${targetRef.persistentId} not found in topology map.`,
    };
  }

  // --- EVOLVE Mode: Signature Evolution Fallback ---
  // 注意：此為 experimental evolution fallback，非全域 Topological Naming Policy。
  console.log(
    `[TNP PERSISTENT MISS]\n` +
    `targetPersistentId: ${targetRef.persistentId}\n` +
    `targetFeatureId: ${targetRef.featureId}\n` +
    `candidateCount: ${pool.length}\n` +
    `signatureFallback: true`
  );

  // Provenance 驗證 (必須一致)：
  // 1. subShapeType (已由 pool 限制)
  // 2. bodyId 相同
  // 3. featureId 相同 (嚴格禁止跨 featureId 誤對應)
  let fallbackPool = pool
    .map((candidate, index) => ({ candidate, index }))
    .filter(item => {
      if (targetRef.bodyId && item.candidate.bodyId !== targetRef.bodyId) {
        return false;
      }
      if (!targetRef.featureId || item.candidate.featureId !== targetRef.featureId) {
        return false;
      }
      return true;
    });

  if (fallbackPool.length === 0) {
    console.log(
      `[TNP EVOLUTION FAILED]\n` +
      `reason: Provenance mismatch: No candidate found matching featureId ${targetRef.featureId} and bodyId ${targetRef.bodyId}`
    );
    return {
      status: 'unresolved',
      targetRef,
      candidates: [],
      kind: targetRef.subShapeType,
      generation: mapGeneration,
      message: `Signature evolution failed: No candidate found matching provenance featureId ${targetRef.featureId} for persistentId ${targetRef.persistentId}.`,
    };
  }

  // --- 優先級 2: Semantic / Parametric Provenance Resolution ---
  // 當 targetRef 包含語意來源 (provenance) 時，優先依據拓撲語意路徑進行精確解析，
  // 完全避免依賴座標距離或啟發式閾值。
  if (targetRef.provenance) {
    const targetProv = targetRef.provenance;
    const targetFeatId = targetProv.sourceFeatureId || targetRef.featureId;

    const semanticCandidates = fallbackPool.filter(item => {
      const candProv = item.candidate.provenance;
      if (!candProv) return false;

      const candFeatId = candProv.sourceFeatureId || item.candidate.featureId;
      if (candFeatId !== targetFeatId) return false;

      // 比對草圖與 Profile（若皆有指定）
      if (targetProv.sourceSketchId && candProv.sourceSketchId && targetProv.sourceSketchId !== candProv.sourceSketchId) {
        return false;
      }
      if (targetProv.sourceProfileId && candProv.sourceProfileId && targetProv.sourceProfileId !== candProv.sourceProfileId) {
        return false;
      }

      // 1. 若有明確 sourceTopologyPath，比對路徑
      if (targetProv.sourceTopologyPath && candProv.sourceTopologyPath) {
        return targetProv.sourceTopologyPath === candProv.sourceTopologyPath;
      }

      // 2. 若有 sourceSemanticRole 與 sourceVertexIndex / sourceSegmentIndex，進行結構比對
      if (targetProv.sourceSemanticRole && candProv.sourceSemanticRole) {
        if (targetProv.sourceSemanticRole !== candProv.sourceSemanticRole) return false;

        if (targetProv.sourceVertexIndex !== undefined && candProv.sourceVertexIndex !== undefined) {
          return targetProv.sourceVertexIndex === candProv.sourceVertexIndex;
        }
        if (targetProv.sourceSegmentIndex !== undefined && candProv.sourceSegmentIndex !== undefined) {
          return targetProv.sourceSegmentIndex === candProv.sourceSegmentIndex;
        }
      }

      return false;
    });

    // 幾何本質約束驗證 (防止退化或錯誤型態)
    const validSemantic = semanticCandidates.filter(item => {
      const tSig = targetRef.signature;
      const cSig = item.candidate.signature;
      if (!tSig || !cSig) return true;
      if (tSig.curveType && cSig.curveType && tSig.curveType !== cSig.curveType) return false;
      if (tSig.surfaceType && cSig.surfaceType && tSig.surfaceType !== cSig.surfaceType) return false;
      if (targetRef.subShapeType === 'EDGE' && tSig.direction && cSig.direction) {
        const lenT = Math.hypot(tSig.direction.x, tSig.direction.y, tSig.direction.z);
        const lenC = Math.hypot(cSig.direction.x, cSig.direction.y, cSig.direction.z);
        if (lenT > 1e-6 && lenC > 1e-6) {
          const dot = (tSig.direction.x * cSig.direction.x + tSig.direction.y * cSig.direction.y + tSig.direction.z * cSig.direction.z) / (lenT * lenC);
          if (Math.abs(dot) < 0.5) return false;
        }
      }
      return true;
    });

    if (validSemantic.length === 1) {
      console.log(
        `[TNP SEMANTIC EVOLUTION]\n` +
        `targetGeneration: ${targetGeneration ?? 1}\n` +
        `currentGeneration: ${mapGeneration}\n` +
        `sourceFeatureId: ${validSemantic[0].candidate.featureId}\n` +
        `sourceSketchId: ${validSemantic[0].candidate.provenance?.sourceSketchId ?? 'undefined'}\n` +
        `sourceProfileId: ${validSemantic[0].candidate.provenance?.sourceProfileId ?? 'undefined'}\n` +
        `targetPersistentId: ${targetRef.persistentId}\n` +
        `resolvedPersistentId: ${validSemantic[0].candidate.persistentId}\n` +
        `targetSemanticPath: ${targetProv.sourceTopologyPath ?? 'unknown'}\n` +
        `resolvedSemanticPath: ${validSemantic[0].candidate.provenance?.sourceTopologyPath ?? 'unknown'}\n` +
        `resolutionStatus: resolved`
      );
      return {
        status: 'resolved',
        targetRef,
        candidates: validSemantic.map(c => c.candidate),
        resolvedPersistentId: validSemantic[0].candidate.persistentId,
        resolvedIndex: validSemantic[0].index,
        kind: targetRef.subShapeType,
        generation: mapGeneration,
      };
    } else if (validSemantic.length > 1) {
      console.log(
        `[TNP SEMANTIC AMBIGUOUS]\n` +
        `candidates: ${validSemantic.length}\n` +
        `semanticPath: ${targetProv.sourceTopologyPath ?? targetProv.sourceSemanticRole ?? 'unknown'}`
      );
      return {
        status: 'ambiguous',
        targetRef,
        candidates: validSemantic.map(c => c.candidate),
        kind: targetRef.subShapeType,
        generation: mapGeneration,
        message: `Ambiguous semantic provenance candidates (${validSemantic.length}) found for persistentId ${targetRef.persistentId}.`,
      };
    }
  }

  // --- 優先級 4: Geometry Signature Evolution Fallback ---

  // 4. 幾何本質約束 (Geometry constraints):
  // 防止不同類型或正交方向的邊被誤解析
  fallbackPool = fallbackPool.filter(item => {
    const tSig = targetRef.signature;
    const cSig = item.candidate.signature;
    if (!tSig || !cSig) return true;

    // curveType 必須吻合 (例如 line 不可對應到 circle)
    if (tSig.curveType && cSig.curveType && tSig.curveType !== cSig.curveType) {
      return false;
    }
    // surfaceType 必須吻合 (例如 plane 不可對應到 cylinder)
    if (tSig.surfaceType && cSig.surfaceType && tSig.surfaceType !== cSig.surfaceType) {
      return false;
    }
    // EDGE 方向若皆存在，夾角不得正交 (alignment 必須 >= 0.5)
    if (targetRef.subShapeType === 'EDGE' && tSig.direction && cSig.direction) {
      const lenT = Math.hypot(tSig.direction.x, tSig.direction.y, tSig.direction.z);
      const lenC = Math.hypot(cSig.direction.x, cSig.direction.y, cSig.direction.z);
      if (lenT > 1e-6 && lenC > 1e-6) {
        const dot = (tSig.direction.x * cSig.direction.x + tSig.direction.y * cSig.direction.y + tSig.direction.z * cSig.direction.z) / (lenT * lenC);
        if (Math.abs(dot) < 0.5) {
          return false;
        }
      }
    }
    // measure 若皆大於 0，比例差距不得超過 2 倍
    if (tSig.measure > 1e-6 && cSig.measure > 1e-6) {
      const minM = Math.min(tSig.measure, cSig.measure);
      const maxM = Math.max(tSig.measure, cSig.measure);
      if (minM / maxM < 0.5) {
        return false;
      }
    }
    return true;
  });

  if (fallbackPool.length === 0) {
    console.log(
      `[TNP EVOLUTION FAILED]\n` +
      `reason: Geometric constraint mismatch for persistentId ${targetRef.persistentId}`
    );
    return {
      status: 'unresolved',
      targetRef,
      candidates: [],
      kind: targetRef.subShapeType,
      generation: mapGeneration,
      message: `Signature evolution failed: No candidate found matching geometric constraints for persistentId ${targetRef.persistentId}.`,
    };
  }

  // 評估幾何簽章相似度
  const scoredCandidates = fallbackPool.map(item => {
    const score = computeSignatureSimilarity(
      targetRef.signature,
      item.candidate.signature,
      targetRef.subShapeType
    );
    return {
      candidate: item.candidate,
      index: item.index,
      score,
    };
  });

  // 由高到低排序
  scoredCandidates.sort((a, b) => b.score - a.score);

  const bestScore = scoredCandidates.length > 0 ? scoredCandidates[0].score : 0;
  const bestCandidatePersistentId = scoredCandidates.length > 0 ? scoredCandidates[0].candidate.persistentId : 'none';

  console.log(
    `[TNP SIGNATURE FALLBACK]\n` +
    `targetFeatureId: ${targetRef.featureId}\n` +
    `candidateCount: ${scoredCandidates.length}\n` +
    `bestScore: ${bestScore}\n` +
    `bestCandidatePersistentId: ${bestCandidatePersistentId}`
  );

  // 門檻值：0.58 / 0.05。
  // 注意：此 0.58 / 0.05 門檻僅為 experimental evolution fallback 的暫時條件，
  // 並非全域拓撲命名政策 (Topological Naming Policy)。
  const EXPERIMENTAL_EVOLUTION_THRESHOLD = 0.58;
  const EXPERIMENTAL_EVOLUTION_DELTA = 0.05;

  const passingCandidates = scoredCandidates.filter(c => c.score >= EXPERIMENTAL_EVOLUTION_THRESHOLD);

  if (passingCandidates.length === 0) {
    console.log(
      `[TNP EVOLUTION FAILED]\n` +
      `reason: No candidate met signature threshold (${EXPERIMENTAL_EVOLUTION_THRESHOLD})`
    );
    return {
      status: 'unresolved',
      targetRef,
      candidates: [],
      kind: targetRef.subShapeType,
      generation: mapGeneration,
      message: `Signature evolution failed: no candidate matched signature for persistentId ${targetRef.persistentId}.`,
    };
  }

  if (passingCandidates.length === 1) {
    const best = passingCandidates[0];
    console.log(
      `[TNP EVOLUTION RESOLVED]\n` +
      `sourceFeatureId: ${best.candidate.featureId}\n` +
      `fromGeneration: ${targetGeneration ?? 1}\n` +
      `toGeneration: ${mapGeneration}\n` +
      `resolvedPersistentId: ${best.candidate.persistentId}\n` +
      `score: ${best.score}`
    );
    return {
      status: 'resolved',
      targetRef,
      candidates: [best.candidate],
      resolvedPersistentId: best.candidate.persistentId,
      resolvedIndex: best.index,
      kind: targetRef.subShapeType,
      generation: mapGeneration,
    };
  }

  // passingCandidates.length > 1
  // 檢查最佳候選與次佳候選的差距
  const top1 = passingCandidates[0];
  const top2 = passingCandidates[1];
  const delta = top1.score - top2.score;

  // 若兩位候選為幾何等價之直線（例如圓柱邊界 seam edges），其所代表之旋轉軸絕對相同，無幾何歧義
  const isEquivalentLines =
    targetRef.subShapeType === 'EDGE' &&
    top1.candidate.signature.curveType === 'line' &&
    top2.candidate.signature.curveType === 'line' &&
    top1.candidate.signature.direction &&
    top2.candidate.signature.direction &&
    Math.abs(dotVec3(top1.candidate.signature.direction, top2.candidate.signature.direction)) > 0.98;

  // 若差距小於 0.05 且非等價直線，代表有多個幾何相異候選高度相似，拒絕猜測，回傳 ambiguous
  if (delta < EXPERIMENTAL_EVOLUTION_DELTA && !isEquivalentLines) {
    console.log(
      `[TNP EVOLUTION FAILED]\n` +
      `reason: Ambiguous candidates (best: ${top1.score}, second: ${top2.score}, delta: ${delta.toFixed(4)})`
    );
    return {
      status: 'ambiguous',
      targetRef,
      candidates: passingCandidates.map(c => c.candidate),
      kind: targetRef.subShapeType,
      generation: mapGeneration,
      message: `Multiple candidates with close signature scores found for persistentId ${targetRef.persistentId}.`,
    };
  }

  // 差距 >= 0.05，且 top1 明確勝出
  console.log(
    `[TNP EVOLUTION RESOLVED]\n` +
    `sourceFeatureId: ${top1.candidate.featureId}\n` +
    `fromGeneration: ${targetGeneration ?? 1}\n` +
    `toGeneration: ${mapGeneration}\n` +
    `resolvedPersistentId: ${top1.candidate.persistentId}\n` +
    `score: ${top1.score}`
  );
  return {
    status: 'resolved',
    targetRef,
    candidates: [top1.candidate],
    resolvedPersistentId: top1.candidate.persistentId,
    resolvedIndex: top1.index,
    kind: targetRef.subShapeType,
    generation: mapGeneration,
  };
}

/**
 * 批次解析多個拓撲參照體
 */
export function resolveBatchTopoReferences(
  targetRefs: TopoReference[],
  currentTopologyMap: TopologyMap,
  options?: TopoResolutionOptions
): TopoResolutionResult[] {
  return targetRefs.map((ref) => resolveTopoReference(ref, currentTopologyMap, options));
}
