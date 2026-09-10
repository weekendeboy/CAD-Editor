import { CADEntity2D, Constraint, Point2D } from '../../types/cad';

export interface GraphNode {
  id: string;
  point: Point2D;
  outgoingEdgeIds: string[];
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  entityId: string;
  angle: number;
  curveType?: 'line' | 'arc';
  arcData?: {
    center: Point2D;
    radius: number;
    startAngle: number;
    endAngle: number;
    isReversed?: boolean;
  };
}

export class PlanarGraph {
  public nodes: Map<string, GraphNode> = new Map();
  public edges: Map<string, GraphEdge> = new Map();

  public nextNodeId: number = 1;
  public nextEdgeId: number = 1;

  /**
   * Adds a node at the specified coordinates.
   * If a node already exists within the tolerance distance (default 1e-3), returns the existing node.
   */
  public addNode(point: Point2D, tolerance: number = 1e-3, customId?: string): GraphNode {
    if (customId && this.nodes.has(customId)) {
      return this.nodes.get(customId)!;
    }

    const tolSq = tolerance * tolerance;

    for (const node of this.nodes.values()) {
      const dx = node.point.x - point.x;
      const dy = node.point.y - point.y;
      if (dx * dx + dy * dy <= tolSq) {
        return node;
      }
    }

    const id = customId || `node_${this.nextNodeId++}`;
    const newNode: GraphNode = {
      id,
      point: { x: point.x, y: point.y },
      outgoingEdgeIds: [],
    };

    this.nodes.set(id, newNode);
    return newNode;
  }

  /**
   * Adds bidirectional directed edges between p1 and p2 for an undirected segment.
   * Computes the exact polar angle (Math.atan2(dy, dx)) for each directed edge.
   */
  public addBiDirectionalEdge(
    p1: Point2D,
    p2: Point2D,
    entityId: string,
    tolerance: number = 1e-3,
    node1Id?: string,
    node2Id?: string
  ): void {
    const node1 = node1Id && this.nodes.has(node1Id) ? this.nodes.get(node1Id)! : this.addNode(p1, tolerance, node1Id);
    const node2 = node2Id && this.nodes.has(node2Id) ? this.nodes.get(node2Id)! : this.addNode(p2, tolerance, node2Id);

    // Degenerate line segment within tolerance
    if (node1.id === node2.id) {
      return;
    }

    // Forward edge: node1 -> node2
    const dx12 = node2.point.x - node1.point.x;
    const dy12 = node2.point.y - node1.point.y;
    const angle12 = Math.atan2(dy12, dx12);
    const edge12Id = `edge_${this.nextEdgeId++}`;

    const edge12: GraphEdge = {
      id: edge12Id,
      fromNodeId: node1.id,
      toNodeId: node2.id,
      entityId,
      angle: angle12,
      curveType: 'line',
    };

    this.edges.set(edge12Id, edge12);
    node1.outgoingEdgeIds.push(edge12Id);

    // Backward edge: node2 -> node1
    const dx21 = node1.point.x - node2.point.x;
    const dy21 = node1.point.y - node2.point.y;
    const angle21 = Math.atan2(dy21, dx21);
    const edge21Id = `edge_${this.nextEdgeId++}`;

    const edge21: GraphEdge = {
      id: edge21Id,
      fromNodeId: node2.id,
      toNodeId: node1.id,
      entityId,
      angle: angle21,
      curveType: 'line',
    };

    this.edges.set(edge21Id, edge21);
    node2.outgoingEdgeIds.push(edge21Id);
  }

  /**
   * Adds bidirectional directed edges for an arc entity.
   */
  public addBiDirectionalArcEdge(
    center: Point2D,
    radius: number,
    startAngle: number,
    endAngle: number,
    entityId: string,
    tolerance: number = 1e-3,
    node1Id?: string,
    node2Id?: string
  ): void {
    const startPt: Point2D = {
      x: center.x + radius * Math.cos(startAngle),
      y: center.y + radius * Math.sin(startAngle),
    };
    const endPt: Point2D = {
      x: center.x + radius * Math.cos(endAngle),
      y: center.y + radius * Math.sin(endAngle),
    };

    const node1 = node1Id && this.nodes.has(node1Id) ? this.nodes.get(node1Id)! : this.addNode(startPt, tolerance, node1Id);
    const node2 = node2Id && this.nodes.has(node2Id) ? this.nodes.get(node2Id)! : this.addNode(endPt, tolerance, node2Id);

    if (node1.id === node2.id) {
      return;
    }

    const dx12 = node2.point.x - node1.point.x;
    const dy12 = node2.point.y - node1.point.y;
    const angle12 = Math.atan2(dy12, dx12);
    const edge12Id = `edge_${this.nextEdgeId++}`;

    const edge12: GraphEdge = {
      id: edge12Id,
      fromNodeId: node1.id,
      toNodeId: node2.id,
      entityId,
      angle: angle12,
      curveType: 'arc',
      arcData: {
        center: { ...center },
        radius,
        startAngle,
        endAngle,
        isReversed: false,
      },
    };

    this.edges.set(edge12Id, edge12);
    node1.outgoingEdgeIds.push(edge12Id);

    const dx21 = node1.point.x - node2.point.x;
    const dy21 = node1.point.y - node2.point.y;
    const angle21 = Math.atan2(dy21, dx21);
    const edge21Id = `edge_${this.nextEdgeId++}`;

    const edge21: GraphEdge = {
      id: edge21Id,
      fromNodeId: node2.id,
      toNodeId: node1.id,
      entityId,
      angle: angle21,
      curveType: 'arc',
      arcData: {
        center: { ...center },
        radius,
        startAngle,
        endAngle,
        isReversed: true,
      },
    };

    this.edges.set(edge21Id, edge21);
    node2.outgoingEdgeIds.push(edge21Id);
  }

  /**
   * Static factory method to build a planar graph from CAD entities.
   * If coincident constraints exist, enforces shared GraphNodes.
   * Uses tolerance (default 1e-3) for spatial node clustering.
   */
  public static buildFromEntities(
    entities: CADEntity2D[],
    constraints: Constraint[] = [],
    tolerance: number = 1e-3
  ): PlanarGraph {
    const graph = new PlanarGraph();

    // 強制過濾掉 isConstruction === true 的圖元，確保輔助線絕不干擾 3D 封閉面識別與長出
    const validEntities = entities.filter(
      (e) => e.visible !== false && e.isConstruction !== true
    );
    const validEntityIds = new Set(validEntities.map((e) => e.id));
    const validConstraints = constraints.filter((c) =>
      c.entityIds.every((id) => validEntityIds.has(id))
    );

    // DSU (Union-Find) to merge coincident endpoints into the same cluster
    const parent = new Map<string, string>();
    const findRoot = (k: string): string => {
      if (!parent.has(k)) {
        parent.set(k, k);
        return k;
      }
      const p = parent.get(k)!;
      if (p === k) return k;
      const root = findRoot(p);
      parent.set(k, root);
      return root;
    };
    const union = (k1: string, k2: string) => {
      const r1 = findRoot(k1);
      const r2 = findRoot(k2);
      if (r1 !== r2) {
        parent.set(r2, r1);
      }
    };

    // 1. Process coincident constraints
    for (const c of validConstraints) {
      if (c.type === 'coincident') {
        if (c.entityIds.length >= 2) {
          const id1 = c.entityIds[0];
          const id2 = c.entityIds[1];
          const ptIdx1 = c.pointIndices?.[0] ?? 0;
          const ptIdx2 = c.pointIndices?.[1] ?? 0;
          union(`${id1}_${ptIdx1}`, `${id2}_${ptIdx2}`);
        } else if (c.entityIds.length === 1 && c.pointIndices && c.pointIndices.length >= 2) {
          const id1 = c.entityIds[0];
          union(`${id1}_${c.pointIndices[0]}`, `${id1}_${c.pointIndices[1]}`);
        }
      }
    }

    // 2. Node lookup map for clustered roots
    const clusterNodes = new Map<string, GraphNode>();

    const getNodeForEndpoint = (entityId: string, pointIndex: number, point: Point2D): GraphNode => {
      const key = `${entityId}_${pointIndex}`;
      const rootKey = findRoot(key);

      if (clusterNodes.has(rootKey)) {
        return clusterNodes.get(rootKey)!;
      }

      // If not yet assigned for this cluster root, add node with 1e-3 tolerance
      const node = graph.addNode(point, tolerance);
      clusterNodes.set(rootKey, node);
      return node;
    };

    for (const entity of validEntities) {
      if (entity.visible === false || entity.isConstruction === true) {
        continue;
      }

      if (entity.type === 'line') {
        const node1 = getNodeForEndpoint(entity.id, 0, entity.start);
        const node2 = getNodeForEndpoint(entity.id, 1, entity.end);

        if (node1.id === node2.id) {
          continue;
        }

        // Forward edge: node1 -> node2
        const dx12 = node2.point.x - node1.point.x;
        const dy12 = node2.point.y - node1.point.y;
        const angle12 = Math.atan2(dy12, dx12);
        const edge12Id = `edge_${graph.nextEdgeId++}`;

        const edge12: GraphEdge = {
          id: edge12Id,
          fromNodeId: node1.id,
          toNodeId: node2.id,
          entityId: entity.id,
          angle: angle12,
          curveType: 'line',
        };
        graph.edges.set(edge12Id, edge12);
        node1.outgoingEdgeIds.push(edge12Id);

        // Backward edge: node2 -> node1
        const dx21 = node1.point.x - node2.point.x;
        const dy21 = node1.point.y - node2.point.y;
        const angle21 = Math.atan2(dy21, dx21);
        const edge21Id = `edge_${graph.nextEdgeId++}`;

        const edge21: GraphEdge = {
          id: edge21Id,
          fromNodeId: node2.id,
          toNodeId: node1.id,
          entityId: entity.id,
          angle: angle21,
          curveType: 'line',
        };
        graph.edges.set(edge21Id, edge21);
        node2.outgoingEdgeIds.push(edge21Id);
      } else if (entity.type === 'arc') {
        const startPt = {
          x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
          y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
        };
        const endPt = {
          x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
          y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
        };
        const node1 = getNodeForEndpoint(entity.id, 0, startPt);
        const node2 = getNodeForEndpoint(entity.id, 1, endPt);

        if (node1.id === node2.id) {
          continue;
        }

        const dx12 = node2.point.x - node1.point.x;
        const dy12 = node2.point.y - node1.point.y;
        const angle12 = Math.atan2(dy12, dx12);
        const edge12Id = `edge_${graph.nextEdgeId++}`;

        const edge12: GraphEdge = {
          id: edge12Id,
          fromNodeId: node1.id,
          toNodeId: node2.id,
          entityId: entity.id,
          angle: angle12,
          curveType: 'arc',
          arcData: {
            center: { ...entity.center },
            radius: entity.radius,
            startAngle: entity.startAngle,
            endAngle: entity.endAngle,
            isReversed: false,
          },
        };
        graph.edges.set(edge12Id, edge12);
        node1.outgoingEdgeIds.push(edge12Id);

        const dx21 = node1.point.x - node2.point.x;
        const dy21 = node1.point.y - node2.point.y;
        const angle21 = Math.atan2(dy21, dx21);
        const edge21Id = `edge_${graph.nextEdgeId++}`;

        const edge21: GraphEdge = {
          id: edge21Id,
          fromNodeId: node2.id,
          toNodeId: node1.id,
          entityId: entity.id,
          angle: angle21,
          curveType: 'arc',
          arcData: {
            center: { ...entity.center },
            radius: entity.radius,
            startAngle: entity.startAngle,
            endAngle: entity.endAngle,
            isReversed: true,
          },
        };
        graph.edges.set(edge21Id, edge21);
        node2.outgoingEdgeIds.push(edge21Id);
      } else if (entity.type === 'polyline') {
        const points = entity.points;
        if (points.length >= 2) {
          const segmentsCount = entity.closed ? points.length : points.length - 1;
          for (let i = 0; i < segmentsCount; i++) {
            const p1 = points[i];
            const p2 = points[(i + 1) % points.length];
            const nextIdx = (i + 1) % points.length;
            const node1 = getNodeForEndpoint(entity.id, i, p1);
            const node2 = getNodeForEndpoint(entity.id, nextIdx, p2);

            if (node1.id === node2.id) {
              continue;
            }

            const dx12 = node2.point.x - node1.point.x;
            const dy12 = node2.point.y - node1.point.y;
            const angle12 = Math.atan2(dy12, dx12);
            const edge12Id = `edge_${graph.nextEdgeId++}`;

            const edge12: GraphEdge = {
              id: edge12Id,
              fromNodeId: node1.id,
              toNodeId: node2.id,
              entityId: entity.id,
              angle: angle12,
              curveType: 'line',
            };
            graph.edges.set(edge12Id, edge12);
            node1.outgoingEdgeIds.push(edge12Id);

            const dx21 = node1.point.x - node2.point.x;
            const dy21 = node1.point.y - node2.point.y;
            const angle21 = Math.atan2(dy21, dx21);
            const edge21Id = `edge_${graph.nextEdgeId++}`;

            const edge21: GraphEdge = {
              id: edge21Id,
              fromNodeId: node2.id,
              toNodeId: node1.id,
              entityId: entity.id,
              angle: angle21,
              curveType: 'line',
            };
            graph.edges.set(edge21Id, edge21);
            node2.outgoingEdgeIds.push(edge21Id);
          }
        }
      }
    }

    return graph;
  }
}
