import type {
  MeshSubshapeMapping,
  RuntimeBRepFaceRef,
  RuntimeBRepEdgeRef,
  RuntimeBRepVertexRef,
  FaceResolutionResult,
  EdgeResolutionResult,
  VertexResolutionResult,
  MeshSelection,
} from './MeshSubshapeMapping.types';

/**
 * 將使用者點擊或選取的三角面 (Triangle Index) 解析為對應的 Runtime B-Rep Face。
 * 
 * 核心準則：
 * 1. 嚴禁猜測！若無精確映射或越界，回傳 unresolved 與 null。
 * 2. 嚴格比對 generation：若要求期望 generation 且不符合，回傳 generation_mismatch。
 */
export function resolveTriangleToFace(
  mapping: MeshSubshapeMapping,
  triangleIndex: number,
  expectedGeneration?: number
): FaceResolutionResult {
  if (!mapping) {
    return {
      status: 'unresolved',
      triangleIndex,
      faceRef: null,
      message: 'Mapping is null or undefined.',
    };
  }

  // 1. Generation 邊界檢查
  if (typeof expectedGeneration === 'number' && mapping.generation !== expectedGeneration) {
    return {
      status: 'generation_mismatch',
      triangleIndex,
      faceRef: null,
      message: `Generation mismatch: mapping generation is ${mapping.generation}, but expected ${expectedGeneration}.`,
    };
  }

  // 2. 索引邊界檢查
  const lut = mapping.triangleToFaceIndex;
  if (!lut || triangleIndex < 0 || triangleIndex >= lut.length) {
    return {
      status: 'unresolved',
      triangleIndex,
      faceRef: null,
      message: `Triangle index ${triangleIndex} is out of bounds (total triangles in mapping: ${lut ? lut.length : 0}).`,
    };
  }

  const faceIdx = lut[triangleIndex];
  if (faceIdx < 0 || faceIdx >= mapping.faces.length) {
    return {
      status: 'unresolved',
      triangleIndex,
      faceRef: null,
      message: `Triangle ${triangleIndex} maps to invalid or unmapped face index ${faceIdx}.`,
    };
  }

  const faceRef = mapping.faces[faceIdx];
  if (!faceRef) {
    return {
      status: 'unresolved',
      triangleIndex,
      faceRef: null,
      message: `B-Rep Face at index ${faceIdx} does not exist in mapping faces array.`,
    };
  }

  return {
    status: 'exact',
    triangleIndex,
    faceRef,
  };
}

/**
 * 將網格邊線段索引 (Mesh Edge Segment Index) 解析為對應的 Runtime B-Rep Edge。
 */
export function resolveMeshEdgeToEdge(
  mapping: MeshSubshapeMapping,
  meshEdgeIndex: number,
  expectedGeneration?: number
): EdgeResolutionResult {
  if (!mapping) {
    return {
      status: 'unresolved',
      meshEdgeIndex,
      edgeRef: null,
      message: 'Mapping is null or undefined.',
    };
  }

  if (typeof expectedGeneration === 'number' && mapping.generation !== expectedGeneration) {
    return {
      status: 'generation_mismatch',
      meshEdgeIndex,
      edgeRef: null,
      message: `Generation mismatch: mapping generation is ${mapping.generation}, but expected ${expectedGeneration}.`,
    };
  }

  const lut = mapping.meshEdgeToBRepEdgeIndex;
  if (!lut || meshEdgeIndex < 0 || meshEdgeIndex >= lut.length) {
    return {
      status: 'unresolved',
      meshEdgeIndex,
      edgeRef: null,
      message: `Mesh edge index ${meshEdgeIndex} is out of bounds (total segments in mapping: ${lut ? lut.length : 0}).`,
    };
  }

  const edgeIdx = lut[meshEdgeIndex];
  if (edgeIdx < 0 || edgeIdx >= mapping.edges.length) {
    return {
      status: 'unresolved',
      meshEdgeIndex,
      edgeRef: null,
      message: `Mesh edge ${meshEdgeIndex} maps to invalid or unmapped B-Rep edge index ${edgeIdx}.`,
    };
  }

  const edgeRef = mapping.edges[edgeIdx];
  if (!edgeRef) {
    return {
      status: 'unresolved',
      meshEdgeIndex,
      edgeRef: null,
      message: `B-Rep Edge at index ${edgeIdx} does not exist in mapping edges array.`,
    };
  }

  return {
    status: 'exact',
    meshEdgeIndex,
    edgeRef,
  };
}

/**
 * 將網格頂點索引 (Mesh Vertex Index) 解析為對應的 Runtime B-Rep Vertex。
 * 注意：內部三角化節點不是 B-Rep 頂點，回傳 unresolved (非例外，亦不猜測)。
 */
export function resolveMeshVertexToVertex(
  mapping: MeshSubshapeMapping,
  meshVertexIndex: number,
  expectedGeneration?: number
): VertexResolutionResult {
  if (!mapping) {
    return {
      status: 'unresolved',
      meshVertexIndex,
      vertexRef: null,
      message: 'Mapping is null or undefined.',
    };
  }

  if (typeof expectedGeneration === 'number' && mapping.generation !== expectedGeneration) {
    return {
      status: 'generation_mismatch',
      meshVertexIndex,
      vertexRef: null,
      message: `Generation mismatch: mapping generation is ${mapping.generation}, but expected ${expectedGeneration}.`,
    };
  }

  const lut = mapping.meshVertexToBRepVertexIndex;
  if (!lut || meshVertexIndex < 0 || meshVertexIndex >= lut.length) {
    return {
      status: 'unresolved',
      meshVertexIndex,
      vertexRef: null,
      message: `Mesh vertex index ${meshVertexIndex} is out of bounds (total vertices in mapping: ${lut ? lut.length : 0}).`,
    };
  }

  const vertexIdx = lut[meshVertexIndex];
  if (vertexIdx < 0) {
    return {
      status: 'unresolved',
      meshVertexIndex,
      vertexRef: null,
      message: `Mesh vertex ${meshVertexIndex} is an internal tessellation node and does not correspond to any B-Rep vertex.`,
    };
  }

  if (vertexIdx >= mapping.vertices.length) {
    return {
      status: 'unresolved',
      meshVertexIndex,
      vertexRef: null,
      message: `Mesh vertex ${meshVertexIndex} maps to out-of-range vertex index ${vertexIdx}.`,
    };
  }

  const vertexRef = mapping.vertices[vertexIdx];
  if (!vertexRef) {
    return {
      status: 'unresolved',
      meshVertexIndex,
      vertexRef: null,
      message: `B-Rep Vertex at index ${vertexIdx} does not exist in mapping vertices array.`,
    };
  }

  return {
    status: 'exact',
    meshVertexIndex,
    vertexRef,
  };
}

/**
 * 建立 3D MeshSelection 物件
 */
export function createMeshSelection(
  mapping: MeshSubshapeMapping,
  selection:
    | { kind: 'face'; triangleIndex: number }
    | { kind: 'edge'; meshEdgeIndex: number }
    | { kind: 'vertex'; meshVertexIndex: number },
  expectedGeneration?: number
): MeshSelection | null {
  if (selection.kind === 'face') {
    const res = resolveTriangleToFace(mapping, selection.triangleIndex, expectedGeneration);
    if (res.status === 'exact' && res.faceRef) {
      return {
        kind: 'face',
        triangleIndex: selection.triangleIndex,
        faceRef: res.faceRef,
        generation: mapping.generation,
      };
    }
    return null;
  }

  if (selection.kind === 'edge') {
    const res = resolveMeshEdgeToEdge(mapping, selection.meshEdgeIndex, expectedGeneration);
    if (res.status === 'exact' && res.edgeRef) {
      return {
        kind: 'edge',
        meshEdgeIndex: selection.meshEdgeIndex,
        edgeRef: res.edgeRef,
        generation: mapping.generation,
      };
    }
    return null;
  }

  if (selection.kind === 'vertex') {
    const res = resolveMeshVertexToVertex(mapping, selection.meshVertexIndex, expectedGeneration);
    if (res.status === 'exact' && res.vertexRef) {
      return {
        kind: 'vertex',
        meshVertexIndex: selection.meshVertexIndex,
        vertexRef: res.vertexRef,
        generation: mapping.generation,
      };
    }
    return null;
  }

  return null;
}
