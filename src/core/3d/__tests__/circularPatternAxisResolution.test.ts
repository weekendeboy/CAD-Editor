import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTopologyMap,
} from '../TopologyExtractor';
import { resolveTopoReference } from '../TopologyMapper';
import { resolveAxisFromEdgeRef } from '../SolidWorker';
import type {
  TopoReference,
  TopologyMap,
} from '../PersistentTopology.types';

// Mock OCC edge creator
function createMockLineEdge(
  p1: { x: number; y: number; z: number },
  p2: { x: number; y: number; z: number },
  id: string = 'mock-edge',
  hashCode?: number,
  provenance?: any
) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dz = p2.z - p1.z;
  const len = Math.hypot(dx, dy, dz);
  const dir = len > 1e-6 ? { x: dx / len, y: dy / len, z: dz / len } : { x: 0, y: 0, z: 1 };
  const hCode = hashCode ?? (Math.floor(Math.abs(p1.x * 100 + p1.y * 10 + p1.z)) + 1001);

  return {
    _type: 'TopoDS_Edge',
    id,
    start: p1,
    end: p2,
    p1,
    p2,
    dx,
    dy,
    dz,
    length: len,
    direction: dir,
    curveType: 'line',
    provenance,
    IsNull: () => false,
    HashCode: () => hCode,
    HashCode_1: () => hCode,
    delete: () => {},
  };
}

function createMockOCCForEdges(edges: any[]) {
  class MockGProps {
    private mass = 0;
    private centroid = { x: 0, y: 0, z: 0 };
    SetMass(m: number) { this.mass = m; }
    SetCentroid(c: { x: number; y: number; z: number }) { this.centroid = c; }
    Mass() { return this.mass; }
    CentreOfMass() {
      const c = this.centroid;
      return {
        X: () => c.x,
        Y: () => c.y,
        Z: () => c.z,
        delete: () => {},
      };
    }
    delete() {}
  }

  return {
    TopAbs_ShapeEnum: {
      TopAbs_SOLID: 0,
      TopAbs_SHELL: 1,
      TopAbs_FACE: 4,
      TopAbs_WIRE: 5,
      TopAbs_EDGE: 6,
      TopAbs_VERTEX: 7,
      TopAbs_SHAPE: 8,
    },
    GeomAbs_CurveType: {
      GeomAbs_Line: 0,
      GeomAbs_Circle: 1,
    },
    TopExp_Explorer_2: class {
      private idx = 0;
      private list: any[];
      constructor(shape: any, type: number) {
        if (type === 6 /* TopAbs_EDGE */) {
          this.list = edges;
        } else {
          this.list = [];
        }
      }
      More() {
        return this.idx < this.list.length;
      }
      Current() {
        return this.list[this.idx];
      }
      Next() {
        this.idx++;
      }
      delete() {}
    },
    BRep_Tool: {
      Degenerated: () => false,
      Pnt: (v: any) => ({
        X: () => v.x,
        Y: () => v.y,
        Z: () => v.z,
        delete: () => {},
      }),
    },
    GProp_GProps_1: MockGProps,
    GProp_GProps: MockGProps,
    BRepGProp: {
      LinearProperties: (edge: any, gprops: any) => {
        gprops.SetMass(edge.length || 100);
        const midX = (edge.start.x + edge.end.x) / 2;
        const midY = (edge.start.y + edge.end.y) / 2;
        const midZ = (edge.start.z + edge.end.z) / 2;
        gprops.SetCentroid({ x: midX, y: midY, z: midZ });
      },
      SurfaceProperties: (face: any, gprops: any) => {},
      VolumeProperties: (shape: any, gprops: any) => {},
    },
    Bnd_Box_1: class {
      CornerMin() {
        return { X: () => 0, Y: () => 0, Z: () => 0, delete: () => {} };
      }
      CornerMax() {
        return { X: () => 100, Y: () => 100, Z: () => 100, delete: () => {} };
      }
      delete() {}
    },
    Bnd_Box: class {
      CornerMin() {
        return { X: () => 0, Y: () => 0, Z: () => 0, delete: () => {} };
      }
      CornerMax() {
        return { X: () => 100, Y: () => 100, Z: () => 100, delete: () => {} };
      }
      delete() {}
    },
    BRepBndLib: {
      Add: () => {},
      Add_1: () => {},
    },
    BRepAdaptor_Curve_2: class {
      private edge: any;
      constructor(edge: any) {
        this.edge = edge;
      }
      GetType() {
        return 0; // GeomAbs_Line
      }
      Line() {
        const edge = this.edge;
        return {
          Location: () => ({
            X: () => edge.p1.x,
            Y: () => edge.p1.y,
            Z: () => edge.p1.z,
            delete: () => {},
          }),
          Direction: () => ({
            X: () => edge.direction.x,
            Y: () => edge.direction.y,
            Z: () => edge.direction.z,
            delete: () => {},
          }),
          delete: () => {},
        };
      }
      delete() {}
    },
    TopoDS: {
      Edge_1: (s: any) => s,
      Face_1: (s: any) => s,
      Vertex_1: (s: any) => s,
    },
  };
}

test('P-05 STEP 02: TopologyMap Feature Identity Resolution for Circular Pattern', async (t) => {
  await t.test('Bug Reproduction: When using op.parentPatternFeatureId, persistentId namespace mismatches and resolution FAILS', () => {
    const baseFeatureId = 'extrude-base-101';
    const patternFeatureId = 'circular-pattern-202';

    // Edge on base at x=100 from (100, 0, 0) to (100, 0, 50)
    const mockEdge = createMockLineEdge({ x: 100, y: 0, z: 0 }, { x: 100, y: 0, z: 50 }, 'edge-outer');
    const occ = createMockOCCForEdges([mockEdge]);
    const mockSolid = { IsNull: () => false };

    // 1. Initial selection at Base Extrude creation:
    const baseTopoMap = extractTopologyMap(mockSolid, occ, baseFeatureId, 'main-body', 1);
    assert.equal(baseTopoMap.edges.length, 1);
    const targetRef = baseTopoMap.edges[0];

    assert.equal(targetRef.featureId, baseFeatureId);
    assert.ok(targetRef.persistentId.startsWith(`topo_EDGE_${baseFeatureId}_`));

    // 2. OLD BEHAVIOR: Pattern extracted topology map using op.parentPatternFeatureId
    const oldPatternTopoMap = extractTopologyMap(mockSolid, occ, patternFeatureId, 'main-body', 2);
    assert.ok(oldPatternTopoMap.edges[0].persistentId.startsWith(`topo_EDGE_${patternFeatureId}_`));

    // Trying to resolve targetRef against oldPatternTopoMap FAILS:
    const oldResolved = resolveAxisFromEdgeRef(targetRef, oldPatternTopoMap, occ, mockSolid);
    assert.equal(oldResolved, null, 'Old behavior should fail to resolve axis due to featureId mismatch in persistentId');
  });

  await t.test('Case A: Initial Resolution using axisEdgeRef.featureId succeeds', () => {
    const baseFeatureId = 'extrude-base-101';
    const patternFeatureId = 'circular-pattern-202';

    // Edge on Base at x=100
    const mockEdge = createMockLineEdge({ x: 100, y: 0, z: 0 }, { x: 100, y: 0, z: 50 }, 'edge-outer');
    const occ = createMockOCCForEdges([mockEdge]);
    const mockSolid = { IsNull: () => false };

    // Target reference created on Base
    const baseTopoMap = extractTopologyMap(mockSolid, occ, baseFeatureId, 'main-body', 1);
    const axisEdgeRef: TopoReference = baseTopoMap.edges[0];

    // STEP 02 FIX: Resolve topologyMapFeatureId from axisEdgeRef.featureId
    const axisRefFeatureId = axisEdgeRef.featureId;
    const topologyMapFeatureId = axisRefFeatureId ?? patternFeatureId;

    assert.equal(topologyMapFeatureId, baseFeatureId);
    assert.notEqual(topologyMapFeatureId, patternFeatureId);

    // Extract current topologyMap with correct featureId
    const currentTopoMap = extractTopologyMap(mockSolid, occ, topologyMapFeatureId, 'main-body', 1);

    // Resolve axis
    const resolved = resolveAxisFromEdgeRef(axisEdgeRef, currentTopoMap, occ, mockSolid, { resolutionMode: 'EVOLVE' });
    assert.ok(resolved !== null, 'Axis must be resolved successfully');
    assert.equal(resolved?.isValid, true);
    assert.equal(resolved?.origin.x, 100);
    assert.equal(resolved?.origin.y, 0);
  });

  await t.test('Case B: Modify Boss (Base unchanged) - Axis Edge resolves successfully', () => {
    const baseFeatureId = 'extrude-base-101';
    const patternFeatureId = 'circular-pattern-202';

    // Edge on Base at x=100 is UNCHANGED when Boss height changes
    const mockEdge = createMockLineEdge({ x: 100, y: 0, z: 0 }, { x: 100, y: 0, z: 50 }, 'edge-outer');
    const occ = createMockOCCForEdges([mockEdge]);
    const mockSolid = { IsNull: () => false };

    const baseTopoMap = extractTopologyMap(mockSolid, occ, baseFeatureId, 'main-body', 1);
    const axisEdgeRef: TopoReference = baseTopoMap.edges[0];

    // Current solid after Boss height modification:
    // Base geometry has not changed.
    const axisRefFeatureId = axisEdgeRef.featureId;
    const topologyMapFeatureId = axisRefFeatureId ?? patternFeatureId;
    const currentTopoMap = extractTopologyMap(mockSolid, occ, topologyMapFeatureId, 'main-body', 2);

    const resolved = resolveAxisFromEdgeRef(axisEdgeRef, currentTopoMap, occ, mockSolid, { resolutionMode: 'EVOLVE' });
    assert.ok(resolved !== null, 'Case B: Axis must resolve when Boss changes');
    assert.equal(resolved?.isValid, true);
    assert.equal(resolved?.origin.x, 100);
  });

  await t.test('Case C: Modify Base (100 -> 150) - Diagnostic on Candidate Mismatch', () => {
    const baseFeatureId = 'extrude-base-101';
    const patternFeatureId = 'circular-pattern-202';

    // Original edge at x=100
    const originalEdge = createMockLineEdge({ x: 100, y: 0, z: 0 }, { x: 100, y: 0, z: 50 }, 'edge-outer');
    const occOriginal = createMockOCCForEdges([originalEdge]);
    const originalSolid = { IsNull: () => false };

    const originalTopoMap = extractTopologyMap(originalSolid, occOriginal, baseFeatureId, 'main-body', 1);
    const targetRef: TopoReference = originalTopoMap.edges[0];

    // When Base is resized to 150, the edge moves to x=150:
    const resizedEdge = createMockLineEdge({ x: 150, y: 0, z: 0 }, { x: 150, y: 0, z: 50 }, 'edge-outer');
    const occResized = createMockOCCForEdges([resizedEdge]);
    const resizedSolid = { IsNull: () => false };

    // With our STEP 02 fix, topologyMapFeatureId is baseFeatureId:
    const axisRefFeatureId = targetRef.featureId;
    const topologyMapFeatureId = axisRefFeatureId ?? patternFeatureId;

    assert.equal(topologyMapFeatureId, baseFeatureId);

    const resizedTopoMap = extractTopologyMap(resizedSolid, occResized, topologyMapFeatureId, 'main-body', 1);
    const candidateRef = resizedTopoMap.edges[0];

    // Diagnostic logging
    console.log('[Case C Diagnostic]');
    console.log('targetRef.persistentId:', targetRef.persistentId);
    console.log('candidate persistentId:', candidateRef.persistentId);
    console.log('axisReferenceFeatureId:', axisRefFeatureId);
    console.log('topologyMapFeatureId:', topologyMapFeatureId);

    // Verify target origin / centroid is 100
    assert.equal(targetRef.signature.centroid.x, 100, 'target origin.x must be 100');

    // STEP 03 / STEP 03.6: PersistentId exact match fails due to geometry change,
    // but Signature Fallback succeeds with EVOLVE mode without heuristic guessing:
    const resolution = resolveTopoReference(targetRef, resizedTopoMap, { resolutionMode: 'EVOLVE' });
    assert.equal(resolution.status, 'resolved', 'Signature fallback must resolve edge when geometry changes');
    assert.equal(resolution.resolvedPersistentId, candidateRef.persistentId);

    // Issue 1 Contract: Without explicit EVOLVE, default mode is STRICT, so resolveAxisFromEdgeRef returns null
    const strictResolvedByDefault = resolveAxisFromEdgeRef(targetRef, resizedTopoMap, occResized, resizedSolid);
    assert.equal(strictResolvedByDefault, null, 'Default mode must be STRICT and reject changed persistentId');

    // Caller must explicitly pass EVOLVE mode:
    const resolved = resolveAxisFromEdgeRef(targetRef, resizedTopoMap, occResized, resizedSolid, { resolutionMode: 'EVOLVE' });
    assert.ok(resolved !== null, 'resolveAxisFromEdgeRef must resolve axis via explicit EVOLVE');
    assert.equal(resolved?.isValid, true);
    assert.equal(resolved?.origin.x, 150);
    assert.equal(resolved?.origin.y, 0);
  });

  await t.test('P-05 STEP 03.8 Contract Hardening - Issue 2: EVOLVE mode 禁止 edgeIndex fallback', async (sub) => {
    const baseFeatureId = 'extrude-base-101';

    // Edge 0: at x = 150 (length 50, vertical direction 0,0,1)
    const edge0 = createMockLineEdge({ x: 150, y: 0, z: 0 }, { x: 150, y: 0, z: 50 }, 'edge-0');
    // Edge 1: at x = 500 (length 50, horizontal direction 1,0,0), a valid edge in topologyMap
    const edge1 = createMockLineEdge({ x: 500, y: 0, z: 0 }, { x: 550, y: 0, z: 0 }, 'edge-1');
    const occ = createMockOCCForEdges([edge0, edge1]);
    const mockSolid = { IsNull: () => false };

    const topoMap = extractTopologyMap(mockSolid, occ, baseFeatureId, 'main-body', 2);
    assert.equal(topoMap.edges.length, 2);

    await sub.test('Test A: EVOLVE - persistentId fail, signature fail, edgeIndex points to another valid edge -> unresolved', () => {
      // Create a targetRef whose persistentId and signature do NOT match any edge in topoMap
      // (different featureId and orthogonal direction)
      const failedRef: TopoReference = {
        persistentId: 'topo_EDGE_different-feat_999',
        featureId: 'different-feat',
        bodyId: 'main-body',
        subShapeType: 'EDGE',
        generation: 1,
        signature: {
          centroid: { x: 999, y: 999, z: 999 },
          boundingBox: { min: { x: 990, y: 990, z: 990 }, max: { x: 1000, y: 1000, z: 1000 } },
          measure: 50,
          direction: { x: 0, y: 1, z: 0 }, // orthogonal to (0,0,1)
          curveType: 'line',
        },
      };

      // edgeRef points edgeIndex to valid edge 1 (x = 500)
      const edgeRefWithFallback = {
        topoRef: failedRef,
        edgeIndex: 1,
      };

      // In EVOLVE mode: MUST NOT use edgeIndex fallback -> unresolved (returns null)
      const resolvedEvolve = resolveAxisFromEdgeRef(edgeRefWithFallback, topoMap, occ, mockSolid, { resolutionMode: 'EVOLVE' });
      assert.equal(resolvedEvolve, null, 'EVOLVE mode must return null and not fallback to edgeIndex');

      // In STRICT mode: retains existing behavior (falls back to edgeIndex if present)
      const resolvedStrict = resolveAxisFromEdgeRef(edgeRefWithFallback, topoMap, occ, mockSolid, { resolutionMode: 'STRICT' });
      assert.ok(resolvedStrict !== null, 'STRICT mode retains existing contract behavior');
      assert.equal(resolvedStrict?.origin.x, 500);
    });

    await sub.test('Test B: EVOLVE - persistentId fail, signature success, edgeIndex points to another Edge -> resolved = signature candidate', () => {
      // Create a targetRef from generation 1 whose geometry evolved to edge 0 (x = 150)
      // but its edgeIndex points to edge 1 (x = 500)
      const originalEdge = createMockLineEdge({ x: 100, y: 0, z: 0 }, { x: 100, y: 0, z: 50 }, 'edge-orig');
      const occOrig = createMockOCCForEdges([originalEdge]);
      const origTopoMap = extractTopologyMap(mockSolid, occOrig, baseFeatureId, 'main-body', 1);
      const evolvingRef = origTopoMap.edges[0]; // persistentId is at x=100, matches edge0 (x=150) via signature

      const edgeRefWithDivergentIndex = {
        topoRef: evolvingRef,
        edgeIndex: 1, // edge 1 is at x = 500
      };

      // In EVOLVE mode: MUST resolve to signature candidate (edge 0 at x = 150), NOT edgeIndex (edge 1 at x = 500)
      const resolved = resolveAxisFromEdgeRef(edgeRefWithDivergentIndex, topoMap, occ, mockSolid, { resolutionMode: 'EVOLVE' });
      assert.ok(resolved !== null, 'EVOLVE mode must resolve via signature');
      assert.equal(resolved?.origin.x, 150, 'resolved axis origin must be signature candidate at x=150, NOT edgeIndex candidate at x=500');
    });
  });

  await t.test('P-05 STEP 03.10: Semantic Provenance Reference Evolution', async (sub) => {
    const baseFeatureId = 'extrude-base-101';
    const patternFeatureId = 'circular-pattern-202';

    await sub.test('Case A: Base 100 -> 150 Semantic Provenance Evolution (Right-Bottom Vertical Edge)', () => {
      // 1. Initial State: Base = 100 x 100 x 20
      // 4 vertical edges at the 4 corners:
      // v0: (0, 0)
      // v1: (100, 0) -> "右下角的垂直 Edge"
      // v2: (100, 100)
      // v3: (0, 100)
      const originalEdges = [
        createMockLineEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 20 }, 'edge-v0', 101, {
          sourceFeatureId: baseFeatureId,
          sourceSemanticRole: 'lateral_edge',
          sourceVertexIndex: 0,
          sourceTopologyPath: 'extrude:lateral_edge:v_0',
        }),
        createMockLineEdge({ x: 100, y: 0, z: 0 }, { x: 100, y: 0, z: 20 }, 'edge-v1', 102, {
          sourceFeatureId: baseFeatureId,
          sourceSemanticRole: 'lateral_edge',
          sourceVertexIndex: 1,
          sourceTopologyPath: 'extrude:lateral_edge:v_1',
        }),
        createMockLineEdge({ x: 100, y: 100, z: 0 }, { x: 100, y: 100, z: 20 }, 'edge-v2', 103, {
          sourceFeatureId: baseFeatureId,
          sourceSemanticRole: 'lateral_edge',
          sourceVertexIndex: 2,
          sourceTopologyPath: 'extrude:lateral_edge:v_2',
        }),
        createMockLineEdge({ x: 0, y: 100, z: 0 }, { x: 0, y: 100, z: 20 }, 'edge-v3', 104, {
          sourceFeatureId: baseFeatureId,
          sourceSemanticRole: 'lateral_edge',
          sourceVertexIndex: 3,
          sourceTopologyPath: 'extrude:lateral_edge:v_3',
        }),
      ];

      const occOriginal = createMockOCCForEdges(originalEdges);
      const originalSolid = { IsNull: () => false };
      const originalTopoMap = extractTopologyMap(originalSolid, occOriginal, baseFeatureId, 'main-body', 1);

      // User selects "右下角的垂直 Edge" (v1 at x=100, y=0)
      const targetRef = originalTopoMap.edges[1];
      assert.equal(targetRef.signature.centroid.x, 100);
      assert.equal(targetRef.signature.centroid.y, 0);
      assert.equal(targetRef.provenance?.sourceTopologyPath, 'extrude:lateral_edge:v_1');

      // 2. Base is modified: 100 -> 150
      // 4 vertical edges now at:
      // v0: (0, 0)
      // v1: (150, 0) -> "右下角的垂直 Edge"
      // v2: (150, 100)
      // v3: (0, 100)
      const resizedEdges = [
        createMockLineEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 20 }, 'edge-v0', 201, {
          sourceFeatureId: baseFeatureId,
          sourceSemanticRole: 'lateral_edge',
          sourceVertexIndex: 0,
          sourceTopologyPath: 'extrude:lateral_edge:v_0',
        }),
        createMockLineEdge({ x: 150, y: 0, z: 0 }, { x: 150, y: 0, z: 20 }, 'edge-v1', 202, {
          sourceFeatureId: baseFeatureId,
          sourceSemanticRole: 'lateral_edge',
          sourceVertexIndex: 1,
          sourceTopologyPath: 'extrude:lateral_edge:v_1',
        }),
        createMockLineEdge({ x: 150, y: 100, z: 0 }, { x: 150, y: 100, z: 20 }, 'edge-v2', 203, {
          sourceFeatureId: baseFeatureId,
          sourceSemanticRole: 'lateral_edge',
          sourceVertexIndex: 2,
          sourceTopologyPath: 'extrude:lateral_edge:v_2',
        }),
        createMockLineEdge({ x: 0, y: 100, z: 0 }, { x: 0, y: 100, z: 20 }, 'edge-v3', 204, {
          sourceFeatureId: baseFeatureId,
          sourceSemanticRole: 'lateral_edge',
          sourceVertexIndex: 3,
          sourceTopologyPath: 'extrude:lateral_edge:v_3',
        }),
      ];

      const occResized = createMockOCCForEdges(resizedEdges);
      const resizedSolid = { IsNull: () => false };
      const resizedTopoMap = extractTopologyMap(resizedSolid, occResized, baseFeatureId, 'main-body', 2);

      // Replay resolution:
      const resolution = resolveTopoReference(targetRef, resizedTopoMap, { resolutionMode: 'EVOLVE' });
      assert.equal(resolution.status, 'resolved', 'Semantic provenance resolution must succeed');
      assert.equal(resolution.resolvedPersistentId, resizedTopoMap.edges[1].persistentId);
      assert.notEqual(resolution.targetRef.persistentId, resolution.resolvedPersistentId, 'Target persistentId is old, resolvedPersistentId is new');

      // Axis resolution via SolidWorker:
      const resolvedAxis = resolveAxisFromEdgeRef(targetRef, resizedTopoMap, occResized, resizedSolid, { resolutionMode: 'EVOLVE' });
      assert.ok(resolvedAxis !== null, 'Axis must resolve via EVOLVE');
      assert.equal(resolvedAxis?.isValid, true);
      assert.equal(resolvedAxis?.origin.x, 150, 'Resolved axis origin.x must be 150 (not 100 or guessing)');
      assert.equal(resolvedAxis?.origin.y, 0);
      assert.equal(resolvedAxis?.origin.z, 0);
    });

    await sub.test('Case B: True Symmetric Ambiguity Preserved (No semantic provenance can distinguish)', () => {
      // Model with two symmetric vertical edges that cannot be distinguished by provenance or signature:
      const symmetricEdges = [
        createMockLineEdge({ x: 150, y: 0, z: 0 }, { x: 150, y: 0, z: 20 }, 'edge-sym-1', 301),
        createMockLineEdge({ x: -150, y: 0, z: 0 }, { x: -150, y: 0, z: 20 }, 'edge-sym-2', 302),
      ];

      const occ = createMockOCCForEdges(symmetricEdges);
      const solid = { IsNull: () => false };
      const topoMap = extractTopologyMap(solid, occ, baseFeatureId, 'main-body', 2);

      // Target reference with no unique provenance, placed symmetrically at x=0
      const ambiguousTargetRef: TopoReference = {
        persistentId: 'topo_EDGE_extrude-base-101_target_old',
        featureId: baseFeatureId,
        bodyId: 'main-body',
        subShapeType: 'EDGE',
        generation: 1,
        signature: {
          centroid: { x: 0, y: 0, z: 10 },
          boundingBox: { min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: 20 } },
          measure: 20,
          direction: { x: 0, y: 0, z: 1 },
          curveType: 'line',
        },
      };

      const resolution = resolveTopoReference(ambiguousTargetRef, topoMap, { resolutionMode: 'EVOLVE' });
      assert.equal(resolution.status, 'ambiguous', 'Symmetric candidate edges with no distinguishing provenance must be ambiguous');

      // resolveAxisFromEdgeRef returns null, and evaluation throws error
      const resolvedAxis = resolveAxisFromEdgeRef(ambiguousTargetRef, topoMap, occ, solid, { resolutionMode: 'EVOLVE' });
      assert.equal(resolvedAxis, null, 'Ambiguous resolution must return null axis to prevent committing corrupted state');
    });

    await sub.test('Case C: Strict Mode Invariance (Fillet/Chamfer/Shell contract preserved)', () => {
      // Create an edge in generation 1
      const edgeGen1 = createMockLineEdge({ x: 100, y: 0, z: 0 }, { x: 100, y: 0, z: 20 }, 'edge-1', 401, {
        sourceFeatureId: baseFeatureId,
        sourceSemanticRole: 'lateral_edge',
        sourceVertexIndex: 1,
        sourceTopologyPath: 'extrude:lateral_edge:v_1',
      });
      const occ1 = createMockOCCForEdges([edgeGen1]);
      const solid1 = { IsNull: () => false };
      const topoMapGen1 = extractTopologyMap(solid1, occ1, baseFeatureId, 'main-body', 1);
      const targetRef = topoMapGen1.edges[0];

      // In generation 2: geometry changed
      const edgeGen2 = createMockLineEdge({ x: 150, y: 0, z: 0 }, { x: 150, y: 0, z: 20 }, 'edge-1', 402, {
        sourceFeatureId: baseFeatureId,
        sourceSemanticRole: 'lateral_edge',
        sourceVertexIndex: 1,
        sourceTopologyPath: 'extrude:lateral_edge:v_1',
      });
      const occ2 = createMockOCCForEdges([edgeGen2]);
      const solid2 = { IsNull: () => false };
      const topoMapGen2 = extractTopologyMap(solid2, occ2, baseFeatureId, 'main-body', 2);

      // In STRICT mode: generation mismatch MUST return stale_generation
      const strictRes = resolveTopoReference(targetRef, topoMapGen2, { resolutionMode: 'STRICT' });
      assert.equal(strictRes.status, 'stale_generation', 'STRICT mode must reject generation mismatch');

      // In STRICT mode with same generation but missing persistentId: MUST return unresolved
      const topoMapSameGen = extractTopologyMap(solid2, occ2, baseFeatureId, 'main-body', 1);
      const strictMiss = resolveTopoReference(targetRef, topoMapSameGen, { resolutionMode: 'STRICT' });
      assert.equal(strictMiss.status, 'unresolved', 'STRICT mode must return unresolved on persistentId miss without fallback');
    });

    await sub.test('Case D: FeatureTopologyContext Automatic Inference End-to-End', () => {
      // 1. Base 100 x 100 x 20 with 2D profile context
      const contextGen1 = {
        featureId: baseFeatureId,
        featureType: 'EXTRUDE',
        sketchId: 'sketch-base',
        depth: 20,
        direction: 'normal',
        plane: {
          origin: { x: 0, y: 0, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
        },
        profile: {
          id: 'profile-base',
          outerLoop: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
            { x: 0, y: 100 },
          ],
        },
      };

      // Edges without pre-assigned provenance:
      const edgesGen1 = [
        createMockLineEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 20 }, 'edge-v0', 501),
        createMockLineEdge({ x: 100, y: 0, z: 0 }, { x: 100, y: 0, z: 20 }, 'edge-v1', 502),
        createMockLineEdge({ x: 100, y: 100, z: 0 }, { x: 100, y: 100, z: 20 }, 'edge-v2', 503),
        createMockLineEdge({ x: 0, y: 100, z: 0 }, { x: 0, y: 100, z: 20 }, 'edge-v3', 504),
      ];

      const occGen1 = createMockOCCForEdges(edgesGen1);
      const solidGen1 = { IsNull: () => false };
      const topoMapGen1 = extractTopologyMap(solidGen1, occGen1, baseFeatureId, 'main-body', 1, contextGen1);

      // Verify that edge-v1 automatically received provenance for lateral_edge:v_1:
      const targetEdgeRef = topoMapGen1.edges[1];
      assert.equal(targetEdgeRef.provenance?.sourceTopologyPath, 'extrude:lateral_edge:v_1');
      assert.equal(targetEdgeRef.provenance?.sourceVertexIndex, 1);

      // 2. Base 150 x 100 x 20 with resized 2D profile context
      const contextGen2 = {
        ...contextGen1,
        profile: {
          id: 'profile-base',
          outerLoop: [
            { x: 0, y: 0 },
            { x: 150, y: 0 },
            { x: 150, y: 100 },
            { x: 0, y: 100 },
          ],
        },
      };

      const edgesGen2 = [
        createMockLineEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 20 }, 'edge-v0', 601),
        createMockLineEdge({ x: 150, y: 0, z: 0 }, { x: 150, y: 0, z: 20 }, 'edge-v1', 602),
        createMockLineEdge({ x: 150, y: 100, z: 0 }, { x: 150, y: 100, z: 20 }, 'edge-v2', 603),
        createMockLineEdge({ x: 0, y: 100, z: 0 }, { x: 0, y: 100, z: 20 }, 'edge-v3', 604),
      ];

      const occGen2 = createMockOCCForEdges(edgesGen2);
      const solidGen2 = { IsNull: () => false };
      const topoMapGen2 = extractTopologyMap(solidGen2, occGen2, baseFeatureId, 'main-body', 2, contextGen2);

      // Verify that edge-v1 at x=150 automatically received provenance for lateral_edge:v_1:
      const candidateEdgeRef = topoMapGen2.edges[1];
      assert.equal(candidateEdgeRef.provenance?.sourceTopologyPath, 'extrude:lateral_edge:v_1');
      assert.equal(candidateEdgeRef.provenance?.sourceVertexIndex, 1);

      // Resolve:
      const resolvedAxis = resolveAxisFromEdgeRef(targetEdgeRef, topoMapGen2, occGen2, solidGen2, { resolutionMode: 'EVOLVE' });
      assert.ok(resolvedAxis !== null);
      assert.equal(resolvedAxis?.origin.x, 150);
      assert.equal(resolvedAxis?.origin.y, 0);
      assert.equal(resolvedAxis?.origin.z, 0);
    });
  });
});
