import { CADEntity2D, Constraint, Point2D, SketchProfile, ProfileSegment } from '../../types/cad';
import { PlanarGraph, GraphEdge } from './TopologyGraph';

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
 * Identifies and constructs closed planar sketch profiles from CAD entities.
 *
 * Algorithm Overview:
 * 1. Constructs a planar directed graph from CAD entities and coincident constraints.
 * 2. Merges connected vertices within 1e-3 tolerance or coincident constraints.
 * 3. Sorts outgoing edges of each node by polar angle ascending (CCW order).
 * 4. Traverses faces using the Left-most Turn rule (next CW edge relative to incoming reverse edge).
 * 5. Calculates signed area using the Shoelace formula.
 * 6. Returns all valid CCW loops (area > 0) as SketchProfile objects.
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

  // 1. Build directed planar graph from CAD entities with constraint & tolerance support
  const graph = PlanarGraph.buildFromEntities(entities, constraints, tol);

  // 2. Sort outgoing edges for each node by angle ascending
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
  const profiles: SketchProfile[] = [];
  let profileCounter = 1;

  // 3. Traverse all directed edges to find closed faces
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

      // Find the reverse edge pointing back from toNode to currentEdge.fromNodeId
      let reverseIndex = outgoing.findIndex((edgeId) => {
        const edge = graph.edges.get(edgeId);
        return (
          edge !== undefined &&
          edge.toNodeId === currentEdge!.fromNodeId &&
          edge.entityId === currentEdge!.entityId
        );
      });

      // Secondary match by node id if entityId didn't match directly
      if (reverseIndex === -1) {
        reverseIndex = outgoing.findIndex((edgeId) => {
          const edge = graph.edges.get(edgeId);
          return edge !== undefined && edge.toNodeId === currentEdge!.fromNodeId;
        });
      }

      // Angular fallback if topological edge is not immediately identified
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

        // Left-most Turn: Select the edge immediately preceding the reverse edge in CCW order
        // (which is the next clockwise edge from the incoming direction ray)
        let nextEdgeIndex = (reverseIndex - 1 + numOutgoing) % numOutgoing;
        let nextEdgeId = outgoing[nextEdgeIndex];
        let nextEdge = graph.edges.get(nextEdgeId);

        // 嚴格禁止挑選到「剛走過的那條實體邊的反向邊」（排除相同實體的折返邊）
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

    // Mark traversed edges as visited to prevent redundant processing
    for (const edge of loopEdges) {
      visitedEdgeIds.add(edge.id);
    }

    // Check if the loop successfully closed back to the start edge with at least 2 vertices
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

          // Calculate Circular Segment Area: A_seg = 0.5 * R^2 * (diffAngle - sin(diffAngle))
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

      // Filter loops with absolute total area >= 1e-3
      if (Math.abs(totalArea) >= 1e-3) {
        // Area > 0 (CCW) designates an outer planar profile
        if (totalArea > 0) {
          profiles.push({
            id: `profile_${profileCounter++}`,
            outerLoop: loopPoints,
            segments: loopSegments,
            innerLoops: [],
            area: Math.abs(totalArea),
            isClockwise: false,
          });
        }
      }
    }
  }

  return profiles;
}
