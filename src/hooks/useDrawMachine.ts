import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useCADStore } from '../store/cadStore';
import { Point2D, LineEntity, CircleEntity, ArcEntity, PolylineEntity, SketchFeature, CADEntity2D } from '../types/cad';
import { DrawSession, createInitialDrawSession } from '../types/sketchInteraction';
import { findSnapPoint, SnapResult } from '../core/2d/SnapManager';
import { calculate3PointArc, calculatePolygonVertices } from '../core/2d/GeometryMath';
import { isAngleOnArc, normalizeAngle, findAllIntersections } from '../core/2d/IntersectionEngine';
import { calculateExtend } from '../core/2d/ExtendManager';
import { calculateOffsetEntity } from '../core/2d/OffsetEngine';
import { calculateTangentArcSegment, getSegmentEndTangent } from '../core/2d/PolylineMath';
import { calculateMirror } from '../core/2d/MirrorEngine';
import { PolarTrackingResult, calculatePolarTracking, PolarExtensionIntersection, findPolarExtensionIntersection, getNormalizedPolarAngles } from '../core/2d/PolarTracking';
import { OTrackManager, TrackAnchor, TrackGuideLine } from '../core/2d/ObjectTracking';
import { determineLinearDimType } from '../core/2d/DimensionEngine';
import { getBestTangentPoint } from '../core/2d/TangentEngine';

function getDistanceToLineSegment(p: Point2D, sStart: Point2D, sEnd: Point2D): number {
  const vx = sEnd.x - sStart.x;
  const vy = sEnd.y - sStart.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-10) {
    return Math.hypot(p.x - sStart.x, p.y - sStart.y);
  }
  const dx = p.x - sStart.x;
  const dy = p.y - sStart.y;
  const t = Math.max(0, Math.min(1, (dx * vx + dy * vy) / lenSq));
  const projX = sStart.x + t * vx;
  const projY = sStart.y + t * vy;
  return Math.hypot(p.x - projX, p.y - projY);
}

function getDistanceToArcSegment(
  p: Point2D,
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number
): number {
  const thetaP = Math.atan2(p.y - center.y, p.x - center.x);
  if (isAngleOnArc(thetaP, startAngle, endAngle)) {
    const distToCenter = Math.hypot(p.x - center.x, p.y - center.y);
    return Math.abs(distToCenter - radius);
  } else {
    const pStart = {
      x: center.x + radius * Math.cos(startAngle),
      y: center.y + radius * Math.sin(startAngle),
    };
    const pEnd = {
      x: center.x + radius * Math.cos(endAngle),
      y: center.y + radius * Math.sin(endAngle),
    };
    const dStart = Math.hypot(p.x - pStart.x, p.y - pStart.y);
    const dEnd = Math.hypot(p.x - pEnd.x, p.y - pEnd.y);
    return Math.min(dStart, dEnd);
  }
}

function getDistanceToEntity(p: Point2D, entity: CADEntity2D): number {
  if (entity.type === 'line') {
    return getDistanceToLineSegment(p, entity.start, entity.end);
  } else if (entity.type === 'arc') {
    return getDistanceToArcSegment(p, entity.center, entity.radius, entity.startAngle, entity.endAngle);
  } else if (entity.type === 'circle') {
    const distToCenter = Math.hypot(p.x - entity.center.x, p.y - entity.center.y);
    return Math.abs(distToCenter - entity.radius);
  }
  return Infinity;
}

function getTrimPreviewSegment(
  target: CADEntity2D,
  clickPoint: Point2D,
  allEntities: CADEntity2D[]
): CADEntity2D | null {
  if (target.type !== 'line' && target.type !== 'arc' && target.type !== 'circle') {
    return null;
  }

  const allIntersections = findAllIntersections(allEntities);
  const params: number[] = [];
  for (const res of allIntersections) {
    if (res.entityAId === target.id) {
      params.push(res.paramA);
    } else if (res.entityBId === target.id) {
      params.push(res.paramB);
    }
  }

  if (params.length === 0) {
    return null;
  }

  const deduplicate = (arr: number[], tolerance: number = 1e-5): number[] => {
    const res: number[] = [];
    for (const val of arr) {
      if (!res.some((existing) => Math.abs(existing - val) < tolerance)) {
        res.push(val);
      }
    }
    return res;
  };

  if (target.type === 'line') {
    const tValues = deduplicate([...params, 0, 1].map((t) => Math.max(0, Math.min(1, t))));
    tValues.sort((a, b) => a - b);

    const subsegments: { start: Point2D; end: Point2D; dist: number }[] = [];
    for (let i = 0; i < tValues.length - 1; i++) {
      const tStart = tValues[i];
      const tEnd = tValues[i + 1];
      if (tEnd - tStart < 1e-5) continue;

      const pStart = {
        x: target.start.x + tStart * (target.end.x - target.start.x),
        y: target.start.y + tStart * (target.end.y - target.start.y),
      };
      const pEnd = {
        x: target.start.x + tEnd * (target.end.x - target.start.x),
        y: target.start.y + tEnd * (target.end.y - target.start.y),
      };

      const dist = getDistanceToLineSegment(clickPoint, pStart, pEnd);
      subsegments.push({ start: pStart, end: pEnd, dist });
    }

    if (subsegments.length === 0) return null;

    let minIdx = 0;
    let minDist = subsegments[0].dist;
    for (let i = 1; i < subsegments.length; i++) {
      if (subsegments[i].dist < minDist) {
        minDist = subsegments[i].dist;
        minIdx = i;
      }
    }

    const sub = subsegments[minIdx];
    return {
      ...target,
      id: `trim-preview-${target.id}`,
      type: 'line',
      start: sub.start,
      end: sub.end,
    } as LineEntity;
  } else if (target.type === 'arc') {
    const startAngle = target.startAngle;
    const endAngle = target.endAngle;
    const totalSweep = normalizeAngle(endAngle - startAngle);

    const relativeSweeps: number[] = [];
    for (const p of params) {
      const sweep = normalizeAngle(p - startAngle);
      if (sweep <= totalSweep + 1e-5) {
        relativeSweeps.push(Math.min(totalSweep, Math.max(0, sweep)));
      }
    }

    const sValues = deduplicate([...relativeSweeps, 0, totalSweep]);
    sValues.sort((a, b) => a - b);

    const subarcs: { startAngle: number; endAngle: number; dist: number }[] = [];
    for (let i = 0; i < sValues.length - 1; i++) {
      const sStart = sValues[i];
      const sEnd = sValues[i + 1];
      if (sEnd - sStart < 1e-5) continue;

      const subStartAngle = normalizeAngle(startAngle + sStart);
      const subEndAngle = normalizeAngle(startAngle + sEnd);
      const dist = getDistanceToArcSegment(clickPoint, target.center, target.radius, subStartAngle, subEndAngle);

      subarcs.push({ startAngle: subStartAngle, endAngle: subEndAngle, dist });
    }

    if (subarcs.length === 0) return null;

    let minIdx = 0;
    let minDist = subarcs[0].dist;
    for (let i = 1; i < subarcs.length; i++) {
      if (subarcs[i].dist < minDist) {
        minDist = subarcs[i].dist;
        minIdx = i;
      }
    }

    const sub = subarcs[minIdx];
    return {
      ...target,
      id: `trim-preview-${target.id}`,
      type: 'arc',
      center: target.center,
      radius: target.radius,
      startAngle: sub.startAngle,
      endAngle: sub.endAngle,
    } as ArcEntity;
  } else if (target.type === 'circle') {
    const sortedAngles = deduplicate(params);
    sortedAngles.sort((a, b) => a - b);

    if (sortedAngles.length < 2) {
      return null;
    }

    const theta0 = sortedAngles[0];
    const theta1 = sortedAngles[1];

    let diffA = theta1 - theta0;
    while (diffA < 0) diffA += 2 * Math.PI;
    const midA = normalizeAngle(theta0 + diffA / 2);
    const midPointA = {
      x: target.center.x + target.radius * Math.cos(midA),
      y: target.center.y + target.radius * Math.sin(midA),
    };
    const distA = Math.hypot(clickPoint.x - midPointA.x, clickPoint.y - midPointA.y);

    let diffB = (theta0 + 2 * Math.PI) - theta1;
    while (diffB < 0) diffB += 2 * Math.PI;
    const midB = normalizeAngle(theta1 + diffB / 2);
    const midPointB = {
      x: target.center.x + target.radius * Math.cos(midB),
      y: target.center.y + target.radius * Math.sin(midB),
    };
    const distB = Math.hypot(clickPoint.x - midPointB.x, clickPoint.y - midPointB.y);

    if (distA < distB) {
      return {
        ...target,
        id: `trim-preview-${target.id}`,
        type: 'arc',
        center: target.center,
        radius: target.radius,
        startAngle: theta0,
        endAngle: theta1,
      } as ArcEntity;
    } else {
      return {
        ...target,
        id: `trim-preview-${target.id}`,
        type: 'arc',
        center: target.center,
        radius: target.radius,
        startAngle: theta1,
        endAngle: theta0,
      } as ArcEntity;
    }
  }

  return null;
}

export function useDrawMachine() {
  const currentTool = useCADStore((state) => state.currentTool);
  const activeSketchId = useCADStore((state) => state.activeSketchId);
  const document = useCADStore((state) => state.document);
  const osnapEnabled = useCADStore((state) => state.osnapEnabled);
  const osnapSettings = useCADStore((state) => state.osnapSettings);
  const orthoEnabled = useCADStore((state) => state.orthoEnabled);
  const addEntity = useCADStore((state) => state.addEntity);
  const addConstraint = useCADStore((state) => state.addConstraint);
  const addDimension = useCADStore((state) => state.addDimension);
  const updateDimensionPosition = useCADStore((state) => state.updateDimensionPosition);
  const updateDimensionPositionLive = useCADStore((state) => state.updateDimensionPositionLive);
  const trimEntity = useCADStore((state) => state.trimEntity);
  const extendEntity = useCADStore((state) => state.extendEntity);
  const applyFillet = useCADStore((state) => state.applyFillet);
  const applyChamfer = useCADStore((state) => state.applyChamfer);
  const storeChamferDistance = useCADStore((state) => state.chamferDistance);
  const storeSetChamferDistance = useCADStore((state) => state.setChamferDistance);
  const offsetEntity = useCADStore((state) => state.offsetEntity);
  const mirrorEntities = useCADStore((state) => state.mirrorEntities);
  const moveEntities = useCADStore((state) => state.moveEntities);
  const copyEntities = useCADStore((state) => state.copyEntities);
  const scaleEntities = useCADStore((state) => state.scaleEntities);
  const rotateEntities = useCADStore((state) => state.rotateEntities);
  const circularArrayEntities = useCADStore((state) => state.circularArrayEntities);
  const rectArrayEntities = useCADStore((state) => state.rectArrayEntities);
  const rectArrayCols = useCADStore((state) => state.rectArrayCols);
  const rectArrayRows = useCADStore((state) => state.rectArrayRows);
  const rectArrayColSpacing = useCADStore((state) => state.rectArrayColSpacing);
  const rectArrayRowSpacing = useCADStore((state) => state.rectArrayRowSpacing);
  const polarTrackingEnabled = useCADStore((state) => state.polarTrackingEnabled);
  const polarAngleStep = useCADStore((state) => state.polarAngleStep);
  const customPolarAngles = useCADStore((state) => state.customPolarAngles);

  const [drawSession, setDrawSession] = useState<DrawSession>(createInitialDrawSession());
  const [currentSnap, setCurrentSnap] = useState<SnapResult | null>(null);
  const [startSnap, setStartSnap] = useState<SnapResult | null>(null);
  const [trimPreviewEntity, setTrimPreviewEntity] = useState<CADEntity2D | null>(null);
  const [extendPreview, setExtendPreview] = useState<{ originalEntityId: string; previewEntity: CADEntity2D } | null>(null);
  const [firstEntityId, setFirstEntityId] = useState<string | null>(null);
  const [lastEntityId, setLastEntityId] = useState<string | null>(null);
  const [snapCenter, setSnapCenter] = useState<SnapResult | null>(null);
  const [snapP1, setSnapP1] = useState<SnapResult | null>(null);
  const [snapP2, setSnapP2] = useState<SnapResult | null>(null);

  // Deferred tangent state for LINE tool
  const [deferredTangent, setDeferredTangent] = useState<{
    entityId: string;
    center: Point2D;
    radius: number;
    initialPick: Point2D;
    isArc: boolean;
    startAngle?: number;
    endAngle?: number;
  } | null>(null);

  // Dimension tool state
  const [dimSnap1, setDimSnap1] = useState<SnapResult | null>(null);
  const [dimSnap2, setDimSnap2] = useState<SnapResult | null>(null);
  const [dimSelectedLineId, setDimSelectedLineId] = useState<string | null>(null);
  const [dimSelectedLineId2, setDimSelectedLineId2] = useState<string | null>(null);
  const [dimSelectedCircleOrArc, setDimSelectedCircleOrArc] = useState<CircleEntity | ArcEntity | null>(null);
  const [draggingDimInfo, setDraggingDimInfo] = useState<{
    dimId: string;
    initialTextPos: Point2D;
    startWorldPt: Point2D;
  } | null>(null);

  const startDragDimensionText = useCallback((dimId: string, initialTextPos: Point2D, worldPt: Point2D) => {
    setDraggingDimInfo({
      dimId,
      initialTextPos,
      startWorldPt: worldPt,
    });
  }, []);

  const updateDragDimensionText = useCallback((worldPt: Point2D) => {
    if (!draggingDimInfo) return;
    const dx = worldPt.x - draggingDimInfo.startWorldPt.x;
    const dy = worldPt.y - draggingDimInfo.startWorldPt.y;
    const newPos = {
      x: draggingDimInfo.initialTextPos.x + dx,
      y: draggingDimInfo.initialTextPos.y + dy,
    };
    updateDimensionPositionLive(draggingDimInfo.dimId, newPos);
  }, [draggingDimInfo, updateDimensionPositionLive]);

  const endDragDimensionText = useCallback((finalWorldPt?: Point2D) => {
    if (!draggingDimInfo) return;
    if (finalWorldPt) {
      const dx = finalWorldPt.x - draggingDimInfo.startWorldPt.x;
      const dy = finalWorldPt.y - draggingDimInfo.startWorldPt.y;
      const newPos = {
        x: draggingDimInfo.initialTextPos.x + dx,
        y: draggingDimInfo.initialTextPos.y + dy,
      };
      updateDimensionPosition(draggingDimInfo.dimId, newPos);
    }
    setDraggingDimInfo(null);
  }, [draggingDimInfo, updateDimensionPosition]);

  // Fillet state
  const [filletFirstEntityId, setFilletFirstEntityId] = useState<string | null>(null);
  const [filletRadius, setFilletRadius] = useState<number>(10);

  // Chamfer state
  const [chamferFirstEntityId, setChamferFirstEntityId] = useState<string | null>(null);
  const [chamferDistanceLocal, setChamferDistanceLocal] = useState<number>(10);
  const chamferDistance = storeChamferDistance ?? chamferDistanceLocal;
  const setChamferDistance = useCallback((dist: number) => {
    setChamferDistanceLocal(dist);
    storeSetChamferDistance?.(dist);
  }, [storeSetChamferDistance]);

  // Offset state
  const [offsetTargetId, setOffsetTargetId] = useState<string | null>(null);
  const [offsetDistance, setOffsetDistance] = useState<number>(10);
  const [offsetPreviewEntity, setOffsetPreviewEntity] = useState<CADEntity2D | null>(null);

  // Mirror state
  const [mirrorStep, setMirrorStep] = useState<'PICK_SOURCE' | 'PICK_AXIS'>('PICK_SOURCE');
  const [mirrorSourceIds, setMirrorSourceIds] = useState<string[]>([]);
  const [mirrorPreviewEntities, setMirrorPreviewEntities] = useState<CADEntity2D[] | null>(null);

  // Move / Copy state
  const [moveStep, setMoveStep] = useState<'PICK_OBJECTS' | 'PICK_BASE' | 'PICK_TARGET'>('PICK_OBJECTS');
  const [moveSourceIds, setMoveSourceIds] = useState<string[]>([]);
  const [moveBasePoint, setMoveBasePoint] = useState<Point2D | null>(null);
  const [movePreviewEntities, setMovePreviewEntities] = useState<CADEntity2D[] | null>(null);

  // Scale state
  const [scaleStep, setScaleStep] = useState<'PICK_OBJECTS' | 'PICK_BASE' | 'PICK_FACTOR'>('PICK_OBJECTS');
  const [scaleSourceIds, setScaleSourceIds] = useState<string[]>([]);
  const [scaleBasePoint, setScaleBasePoint] = useState<Point2D | null>(null);
  const [scaleRefDist, setScaleRefDist] = useState<number>(100);
  const [scalePreviewEntities, setScalePreviewEntities] = useState<CADEntity2D[] | null>(null);
  const [currentScaleFactor, setCurrentScaleFactor] = useState<number>(1.0);

  // Rotate state
  const [rotateStep, setRotateStep] = useState<'PICK_OBJECTS' | 'PICK_BASE' | 'PICK_ANGLE'>('PICK_OBJECTS');
  const [rotateSourceIds, setRotateSourceIds] = useState<string[]>([]);
  const [rotateBasePoint, setRotateBasePoint] = useState<Point2D | null>(null);
  const [rotatePreviewEntities, setRotatePreviewEntities] = useState<CADEntity2D[] | null>(null);
  const [currentRotateAngleDeg, setCurrentRotateAngleDeg] = useState<number>(0);

  // Circular Array state
  const [arrayStep, setArrayStep] = useState<'PICK_OBJECTS' | 'PICK_CENTER'>('PICK_OBJECTS');
  const [arraySourceIds, setArraySourceIds] = useState<string[]>([]);
  const [arrayCenterPoint, setArrayCenterPoint] = useState<Point2D | null>(null);
  const [arrayPreviewEntities, setArrayPreviewEntities] = useState<CADEntity2D[] | null>(null);

  // Rectangular Array state
  const [rectArraySourceIds, setRectArraySourceIds] = useState<string[]>([]);

  // Polyline internal states
  const [polylineMode, setPolylineMode] = useState<'LINE' | 'ARC'>('LINE');
  const [polySegments, setPolySegments] = useState<Array<{ entityId: string; endPt: Point2D; type: 'line' | 'arc' }>>([]);
  const [lastTangentDir, setLastTangentDir] = useState<Point2D | null>(null);
  const [polylineWarning, setPolylineWarning] = useState<string | null>(null);

  // Polar tracking state
  const [polarTracking, setPolarTracking] = useState<PolarTrackingResult | null>(null);
  const [polarExtensionIntersection, setPolarExtensionIntersection] = useState<PolarExtensionIntersection | null>(null);

  // OTrack states and manager instance
  const otrackManagerRef = useRef<OTrackManager | null>(null);
  if (!otrackManagerRef.current) {
    otrackManagerRef.current = new OTrackManager();
  }
  const [otrackAnchors, setOtrackAnchors] = useState<TrackAnchor[]>([]);
  const [otrackGuideLines, setOtrackGuideLines] = useState<TrackGuideLine[]>([]);

  // 取得目前草圖內的 entities
  let currentEntities: CADEntity2D[] = [];
  if (activeSketchId) {
    const sketch = document.featureTree.find(
      (f) => f.id === activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;
    if (sketch) {
      currentEntities = sketch.entities;
    }
  }

  const cancelDrawing = useCallback(() => {
    setDrawSession(createInitialDrawSession());
    setCurrentSnap(null);
    setDeferredTangent(null);
    setFirstEntityId(null);
    setLastEntityId(null);
    setSnapCenter(null);
    setSnapP1(null);
    setSnapP2(null);
    setTrimPreviewEntity(null);
    setDimSnap1(null);
    setDimSnap2(null);
    setDimSelectedLineId(null);
    setDimSelectedLineId2(null);
    setDimSelectedCircleOrArc(null);
    setDraggingDimInfo(null);
    setStartSnap(null);
    setFilletFirstEntityId(null);
    setChamferFirstEntityId(null);
    setExtendPreview(null);
    setOffsetTargetId(null);
    setOffsetPreviewEntity(null);

    // Polyline states reset
    setPolylineMode('LINE');
    setPolySegments([]);
    setLastTangentDir(null);
    setPolylineWarning(null);

    // Reset mirror states
    setMirrorStep('PICK_SOURCE');
    setMirrorSourceIds([]);
    setMirrorPreviewEntities(null);

    // Reset move / copy states
    setMoveStep('PICK_OBJECTS');
    setMoveSourceIds([]);
    setMoveBasePoint(null);
    setMovePreviewEntities(null);

    // Reset scale states
    setScaleStep('PICK_OBJECTS');
    setScaleSourceIds([]);
    setScaleBasePoint(null);
    setScaleRefDist(100);
    setScalePreviewEntities(null);
    setCurrentScaleFactor(1.0);

    // Reset rotate states
    setRotateStep('PICK_OBJECTS');
    setRotateSourceIds([]);
    setRotateBasePoint(null);
    setRotatePreviewEntities(null);
    setCurrentRotateAngleDeg(0);

    // Reset circular array states
    setArrayStep('PICK_OBJECTS');
    setArraySourceIds([]);
    setArrayCenterPoint(null);
    setArrayPreviewEntities(null);

    // Reset rectangular array states
    setRectArraySourceIds([]);

    // Reset polar tracking
    setPolarTracking(null);
    setPolarExtensionIntersection(null);

    // Reset OTrack states
    otrackManagerRef.current?.reset();
    setOtrackAnchors([]);
    setOtrackGuideLines([]);
  }, []);

  // Toggling Polyline mode with smooth degradation logic
  const togglePolylineMode = useCallback(() => {
    setPolylineMode((prev) => {
      if (prev === 'LINE') {
        if (!lastTangentDir || polySegments.length === 0) {
          setPolylineWarning("需要至少一段實體以推導相切方向");
          setTimeout(() => setPolylineWarning(null), 3000);
          return 'LINE'; // Force keep LINE to sustain straight ray preview and prevent crash
        }
        setPolylineWarning(null);
        return 'ARC';
      } else {
        setPolylineWarning(null);
        return 'LINE';
      }
    });
  }, [lastTangentDir, polySegments.length]);

  // 當工具切換時，將狀態徹底重置，並特別為鏡射工具初始化選取
  useEffect(() => {
    cancelDrawing();
    if (currentTool === 'MIRROR') {
      const initialSelection = useCADStore.getState().selectedEntityIds;
      if (initialSelection && initialSelection.length > 0) {
        // 若先前選取的圖元中恰好只有一條直線，不要自動跳入 PICK_AXIS，避免將該直線誤當作唯一來源圖元。
        const isSingleLine =
          initialSelection.length === 1 &&
          currentEntities.find((e) => e.id === initialSelection[0])?.type === 'line';

        if (isSingleLine) {
          setMirrorSourceIds(initialSelection);
          setMirrorStep('PICK_SOURCE'); // Stay at PICK_SOURCE so they can select more or clear
        } else {
          setMirrorSourceIds(initialSelection);
          setMirrorStep('PICK_AXIS');
        }
      } else {
        setMirrorStep('PICK_SOURCE');
        setMirrorSourceIds([]);
      }
      setMirrorPreviewEntities(null);
    } else if (currentTool === 'MOVE' || currentTool === 'COPY') {
      const initialSelection = useCADStore.getState().selectedEntityIds;
      if (initialSelection && initialSelection.length > 0) {
        setMoveSourceIds(initialSelection);
        setMoveStep('PICK_BASE');
      } else {
        setMoveSourceIds([]);
        setMoveStep('PICK_OBJECTS');
      }
      setMoveBasePoint(null);
      setMovePreviewEntities(null);
    } else if (currentTool === 'SCALE') {
      const initialSelection = useCADStore.getState().selectedEntityIds;
      if (initialSelection && initialSelection.length > 0) {
        setScaleSourceIds(initialSelection);
        setScaleStep('PICK_BASE');
      } else {
        setScaleSourceIds([]);
        setScaleStep('PICK_OBJECTS');
      }
      setScaleBasePoint(null);
      setScaleRefDist(100);
      setScalePreviewEntities(null);
      setCurrentScaleFactor(1.0);
    } else if (currentTool === 'ROTATE') {
      const initialSelection = useCADStore.getState().selectedEntityIds;
      if (initialSelection && initialSelection.length > 0) {
        setRotateSourceIds(initialSelection);
        setRotateStep('PICK_BASE');
      } else {
        setRotateSourceIds([]);
        setRotateStep('PICK_OBJECTS');
      }
      setRotateBasePoint(null);
      setRotatePreviewEntities(null);
      setCurrentRotateAngleDeg(0);
    } else if (currentTool === 'CIRCULAR_ARRAY') {
      const initialSelection = useCADStore.getState().selectedEntityIds;
      if (initialSelection && initialSelection.length > 0) {
        setArraySourceIds(initialSelection);
        setArrayStep('PICK_CENTER');
      } else {
        setArraySourceIds([]);
        setArrayStep('PICK_OBJECTS');
      }
      setArrayCenterPoint(null);
      setArrayPreviewEntities(null);
    } else if (currentTool === 'RECT_ARRAY') {
      const initialSelection = useCADStore.getState().selectedEntityIds;
      if (initialSelection && initialSelection.length > 0) {
        setRectArraySourceIds(initialSelection);
      } else {
        setRectArraySourceIds([]);
      }
    }
  }, [currentTool, cancelDrawing]);

  // 執行矩形陣列生成：讀取來源圖元與 Store 參數並套用變異
  const executeRectArray = useCallback(() => {
    if (rectArraySourceIds.length === 0) return;
    const {
      rectArrayCols: cols,
      rectArrayRows: rows,
      rectArrayColSpacing: colSpacing,
      rectArrayRowSpacing: rowSpacing,
      rectArrayEntities: applyRectArray,
    } = useCADStore.getState();
    applyRectArray(rectArraySourceIds, cols, rows, colSpacing, rowSpacing);
    cancelDrawing();
  }, [rectArraySourceIds, cancelDrawing]);

  // 監聽鍵盤按鍵：Escape 清除暫態，M 切換 POLYLINE 模式，Enter 確認鏡射、移動複製或縮放/旋轉/陣列來源選取
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      if (e.key === 'Escape') {
        cancelDrawing();
      } else if ((e.key === 'm' || e.key === 'M') && currentTool === 'POLYLINE') {
        togglePolylineMode();
      } else if (e.key === 'Enter' && currentTool === 'MIRROR') {
        if (mirrorStep === 'PICK_SOURCE') {
          setMirrorStep('PICK_AXIS');
        }
      } else if (e.key === 'Enter' && (currentTool === 'MOVE' || currentTool === 'COPY')) {
        if (moveStep === 'PICK_OBJECTS' && moveSourceIds.length > 0) {
          setMoveStep('PICK_BASE');
        }
      } else if (e.key === 'Enter' && currentTool === 'SCALE') {
        if (scaleStep === 'PICK_OBJECTS' && scaleSourceIds.length > 0) {
          setScaleStep('PICK_BASE');
        }
      } else if (e.key === 'Enter' && currentTool === 'ROTATE') {
        if (rotateStep === 'PICK_OBJECTS' && rotateSourceIds.length > 0) {
          setRotateStep('PICK_BASE');
        }
      } else if (e.key === 'Enter' && currentTool === 'CIRCULAR_ARRAY') {
        if (arrayStep === 'PICK_OBJECTS' && arraySourceIds.length > 0) {
          setArrayStep('PICK_CENTER');
        }
      } else if (e.key === 'Enter' && currentTool === 'RECT_ARRAY') {
        if (rectArraySourceIds.length > 0) {
          executeRectArray();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    cancelDrawing,
    togglePolylineMode,
    currentTool,
    mirrorStep,
    moveStep,
    moveSourceIds.length,
    scaleStep,
    scaleSourceIds.length,
    rotateStep,
    rotateSourceIds.length,
    arrayStep,
    arraySourceIds.length,
    rectArraySourceIds.length,
    executeRectArray,
  ]);

  // 監聽來自 useCadShortcuts 的 polyline keypress 事件
  useEffect(() => {
    const handlePolylineKeyPress = (e: Event) => {
      const customEvent = e as CustomEvent<{ key: string }>;
      if (!drawSession.isDrawing || currentTool !== 'POLYLINE') return;

      if (customEvent.detail.key === 'a') {
        if (!lastTangentDir || polySegments.length === 0) {
          setPolylineWarning("需要至少一段實體以推導相切方向");
          setTimeout(() => setPolylineWarning(null), 3000);
          // Keep it as LINE, do not transition to ARC to prevent crashes
        } else {
          setPolylineMode('ARC');
          setPolylineWarning(null);
        }
        customEvent.preventDefault();
      } else if (customEvent.detail.key === 'l') {
        setPolylineMode('LINE');
        setPolylineWarning(null);
        customEvent.preventDefault();
      }
    };

    window.addEventListener('cad-polyline-keypress', handlePolylineKeyPress);
    return () => {
      window.removeEventListener('cad-polyline-keypress', handlePolylineKeyPress);
    };
  }, [drawSession.isDrawing, currentTool, lastTangentDir, polySegments.length]);

  // OTrack hover timer: manages when hover triggers anchor addition/removal
  const snapKey = currentSnap
    ? `${currentSnap.entityId}-${currentSnap.type}-${currentSnap.point.x}-${currentSnap.point.y}`
    : 'none';

  useEffect(() => {
    if (!currentSnap) {
      otrackManagerRef.current?.updateHover(null, Date.now());
      setOtrackAnchors([...(otrackManagerRef.current?.anchors || [])]);
      return;
    }

    const snapPt = currentSnap.point;
    otrackManagerRef.current?.updateHover(snapPt, Date.now());
    setOtrackAnchors([...(otrackManagerRef.current?.anchors || [])]);

    const timer = setTimeout(() => {
      const now = Date.now();
      otrackManagerRef.current?.updateHover(snapPt, now);
      setOtrackAnchors([...(otrackManagerRef.current?.anchors || [])]);
    }, 510);

    return () => clearTimeout(timer);
  }, [snapKey]);

  const resolveEffectiveCursor = useCallback(
    (worldPt: Point2D, scale: number = 1.0) => {
      let snap: SnapResult | null = null;
      let resolvedPt = worldPt;
      let inferredConstraint: 'horizontal' | 'vertical' | null = null;
      let activePolar: PolarTrackingResult | null = null;
      let activeGuideLines: TrackGuideLine[] = [];
      let polarExt: PolarExtensionIntersection | null = null;

      // 1. Check double intersection: Polar Tracking & Entity Extension line (Highest priority!)
      let activePolarExt: PolarExtensionIntersection | null = null;
      if (
        drawSession.isDrawing &&
        drawSession.startPoint &&
        !orthoEnabled &&
        polarTrackingEnabled
      ) {
        activePolarExt = findPolarExtensionIntersection(
          drawSession.startPoint,
          worldPt,
          currentEntities,
          otrackManagerRef.current?.anchors || [], // 傳入 OTrack
          polarAngleStep,
          customPolarAngles,
          scale,
          28
        );
      }

      // 如果命中了極軸與延伸線交點！
      if (activePolarExt) {
        resolvedPt = activePolarExt.point;
        activePolar = {
          snappedPoint: activePolarExt.point,
          rayStart: drawSession.startPoint!,
          rayEnd: {
            x: drawSession.startPoint!.x + 50000 * Math.cos((activePolarExt.polarAngleDeg * Math.PI) / 180),
            y: drawSession.startPoint!.y + 50000 * Math.sin((activePolarExt.polarAngleDeg * Math.PI) / 180),
          },
          angleDeg: activePolarExt.polarAngleDeg,
        };
        snap = {
          point: activePolarExt.point,
          type: 'intersection',
          entityId: activePolarExt.entityId,
        };
        polarExt = activePolarExt;
      } else {
        // 2. 檢查 OSnap 實體鎖點
        if (osnapEnabled) {
          snap = findSnapPoint(
            worldPt,
            currentEntities,
            scale,
            15,
            drawSession.startPoint || undefined,
            osnapSettings
          );
        }

        if (snap) {
          resolvedPt = snap.point;
        } else {
          // 3. 檢查 OTrack 十字追蹤線：若 activeGuideLines.length > 0，則 resolvedPt = trackingPt
          let trackingPt = worldPt;
          if (otrackManagerRef.current) {
            const targetPolarAngles = polarTrackingEnabled
              ? getNormalizedPolarAngles(polarAngleStep, customPolarAngles)
              : undefined;
            const trackingRes = otrackManagerRef.current.evaluateTracking(
              worldPt,
              15 / scale,
              targetPolarAngles,
              drawSession.isDrawing && drawSession.startPoint ? drawSession.startPoint : undefined
            );
            trackingPt = trackingRes.point;
            activeGuideLines = trackingRes.guideLines;
          }

          if (activeGuideLines.length > 0) {
            resolvedPt = trackingPt;
            if (drawSession.isDrawing && drawSession.startPoint) {
              const baseGuideline = activeGuideLines.find(
                (gl) =>
                  Math.abs(gl.anchor.x - drawSession.startPoint!.x) < 1e-4 &&
                  Math.abs(gl.anchor.y - drawSession.startPoint!.y) < 1e-4
              );
              if (baseGuideline) {
                const rad = (baseGuideline.angleDeg * Math.PI) / 180;
                activePolar = {
                  snappedPoint: trackingPt,
                  rayStart: drawSession.startPoint,
                  rayEnd: {
                    x: drawSession.startPoint.x + 50000 * Math.cos(rad),
                    y: drawSession.startPoint.y + 50000 * Math.sin(rad),
                  },
                  angleDeg: baseGuideline.angleDeg,
                };
              }
            }
          } else if (orthoEnabled && drawSession.isDrawing && drawSession.startPoint) {
            // 4. 若上述皆未命中，才檢查 orthoEnabled（執行強制的正交 X/Y 鎖定）
            const dx = worldPt.x - drawSession.startPoint.x;
            const dy = worldPt.y - drawSession.startPoint.y;
            if (Math.abs(dx) >= Math.abs(dy)) {
              resolvedPt = { x: worldPt.x, y: drawSession.startPoint.y };
              inferredConstraint = 'horizontal';
            } else {
              resolvedPt = { x: drawSession.startPoint.x, y: worldPt.y };
              inferredConstraint = 'vertical';
            }
          } else if (drawSession.isDrawing && drawSession.startPoint && polarTrackingEnabled) {
            // 5. 接著檢查 polarTrackingEnabled
            activePolar = calculatePolarTracking(
              drawSession.startPoint,
              worldPt,
              polarAngleStep,
              customPolarAngles
            );
            if (activePolar) {
              resolvedPt = activePolar.snappedPoint;
            }
          } else {
            // 6. 最後執行 Auto-inference（2.5度水平垂直推導）
            if (
              drawSession.isDrawing &&
              drawSession.startPoint &&
              (currentTool === 'LINE' || (currentTool === 'POLYLINE' && polylineMode === 'LINE'))
            ) {
              const dx = worldPt.x - drawSession.startPoint.x;
              const dy = worldPt.y - drawSession.startPoint.y;
              const thetaRad = Math.atan2(dy, dx);
              const thetaDeg = thetaRad * (180 / Math.PI);

              if (Math.abs(thetaDeg) < 2.5 || Math.abs(Math.abs(thetaDeg) - 180) < 2.5) {
                resolvedPt = { x: worldPt.x, y: drawSession.startPoint.y };
                inferredConstraint = 'horizontal';
              } else if (Math.abs(Math.abs(thetaDeg) - 90) < 2.5) {
                resolvedPt = { x: drawSession.startPoint.x, y: worldPt.y };
                inferredConstraint = 'vertical';
              }
            }
          }
        }
      }

      // Snapping to first point of polyline (closing the loop)
      if (
        currentTool === 'POLYLINE' &&
        drawSession.isDrawing &&
        drawSession.startPoint &&
        polylineMode === 'LINE'
      ) {
        let polyStartPt: Point2D | null = null;
        if (firstEntityId) {
          const firstEntity = currentEntities.find((e) => e.id === firstEntityId);
          if (firstEntity) {
            if (firstEntity.type === 'line') {
              polyStartPt = firstEntity.start;
            } else if (firstEntity.type === 'arc') {
              polyStartPt = {
                x: firstEntity.center.x + firstEntity.radius * Math.cos(firstEntity.startAngle),
                y: firstEntity.center.y + firstEntity.radius * Math.sin(firstEntity.startAngle),
              };
            }
          }
        }
        if (!polyStartPt) {
          polyStartPt = drawSession.startPoint;
        }

        const snapDist = 15 / scale;
        if (polyStartPt) {
          const distToStart = Math.hypot(resolvedPt.x - polyStartPt.x, resolvedPt.y - polyStartPt.y);
          if (distToStart < snapDist) {
            resolvedPt = polyStartPt;
          }
        }
      }

      return {
        point: resolvedPt,
        snap,
        inferredConstraint,
        polarTracking: activePolar,
        otrackGuideLines: activeGuideLines,
        polarExtensionIntersection: polarExt,
      };
    },
    [
      osnapEnabled,
      osnapSettings,
      currentEntities,
      orthoEnabled,
      drawSession.isDrawing,
      drawSession.startPoint,
      currentTool,
      polylineMode,
      firstEntityId,
      polarTrackingEnabled,
      polarAngleStep,
      customPolarAngles,
    ]
  );

  const handlePointerMove = useCallback(
    (worldPt: Point2D, scale: number = 1.0) => {
      if (draggingDimInfo) {
        updateDragDimensionText(worldPt);
        return;
      }

      const res = resolveEffectiveCursor(worldPt, scale);

      setCurrentSnap(res.snap);
      setOtrackGuideLines(res.otrackGuideLines);
      setPolarTracking(res.polarTracking);
      setPolarExtensionIntersection(res.polarExtensionIntersection || null);

      setDrawSession((prev) => {
        if (!prev.isDrawing) return prev;
        let updatedStartPoint = prev.startPoint;
        if (deferredTangent && currentTool === 'LINE') {
          const tangentPt = getBestTangentPoint(
            worldPt,
            deferredTangent.center,
            deferredTangent.radius,
            deferredTangent.initialPick,
            deferredTangent.startAngle,
            deferredTangent.endAngle
          );
          updatedStartPoint = tangentPt;
        }
        return {
          ...prev,
          startPoint: updatedStartPoint,
          currentCursor: res.point,
          inferredConstraint: res.inferredConstraint,
        };
      });

      if (currentTool === 'TRIM') {
        const threshold = 15 / scale;
        let closestEntity: CADEntity2D | null = null;
        let minDistance = threshold;

        for (const entity of currentEntities) {
          if (entity.type === 'line' || entity.type === 'arc' || entity.type === 'circle') {
            const tolerance = entity.type === 'circle' ? 8 / scale : threshold;
            const dist = getDistanceToEntity(worldPt, entity);
            if (dist < tolerance && dist < minDistance) {
              minDistance = dist;
              closestEntity = entity;
            }
          }
        }

        if (closestEntity) {
          const previewSeg = getTrimPreviewSegment(closestEntity, worldPt, currentEntities);
          setTrimPreviewEntity(previewSeg);
        } else {
          setTrimPreviewEntity(null);
        }
      }

      if (currentTool === 'EXTEND') {
        const threshold = 15 / scale;
        let closestEntity: CADEntity2D | null = null;
        let minDistance = threshold;

        for (const entity of currentEntities) {
          if (entity.type === 'line' || entity.type === 'arc') {
            const dist = getDistanceToEntity(worldPt, entity);
            if (dist < minDistance) {
              minDistance = dist;
              closestEntity = entity;
            }
          }
        }

        if (closestEntity) {
          const extendResult = calculateExtend(closestEntity.id, worldPt, currentEntities);
          if (extendResult) {
            setExtendPreview({
              originalEntityId: closestEntity.id,
              previewEntity: extendResult,
            });
          } else {
            setExtendPreview(null);
          }
        } else {
          setExtendPreview(null);
        }
      }

      if (currentTool === 'OFFSET') {
        if (offsetTargetId) {
          const targetEntity = currentEntities.find((e) => e.id === offsetTargetId);
          if (targetEntity) {
            const preview = calculateOffsetEntity(targetEntity, {
              distance: offsetDistance,
              sidePoint: worldPt,
            });
            setOffsetPreviewEntity(preview ? preview.entity : null);
          } else {
            setOffsetPreviewEntity(null);
          }
        } else {
          setOffsetPreviewEntity(null);
        }
      } else {
        setOffsetPreviewEntity(null);
      }

      if (currentTool === 'MIRROR') {
        if (mirrorStep === 'PICK_AXIS' && mirrorSourceIds.length > 0) {
          const threshold = 15 / scale;
          let closestAxis: CADEntity2D | null = null;
          let minDistance = threshold;
          for (const entity of currentEntities) {
            if (entity.type === 'line') {
              const dist = getDistanceToEntity(worldPt, entity);
              if (dist < minDistance) {
                minDistance = dist;
                closestAxis = entity;
              }
            }
          }
          if (closestAxis && closestAxis.type === 'line') {
            // 自動排除自身鏡射重疊防呆
            const filteredSources = mirrorSourceIds.filter((id) => id !== closestAxis!.id);
            if (filteredSources.length > 0) {
              const result = calculateMirror(
                currentEntities.filter((e) => filteredSources.includes(e.id)),
                closestAxis
              );
              setMirrorPreviewEntities(result ? result.mirroredEntities : null);
            } else {
              setMirrorPreviewEntities(null);
            }
          } else {
            setMirrorPreviewEntities(null);
          }
        } else {
          setMirrorPreviewEntities(null);
        }
      } else {
        setMirrorPreviewEntities(null);
      }

      if (currentTool === 'MOVE' || currentTool === 'COPY') {
        if (moveStep === 'PICK_TARGET' && moveBasePoint && drawSession.isDrawing) {
          const dx = res.point.x - moveBasePoint.x;
          const dy = res.point.y - moveBasePoint.y;
          const sourceEntities = currentEntities.filter((e) => moveSourceIds.includes(e.id));
          const preview: CADEntity2D[] = sourceEntities.map((e) => {
            if (e.type === 'line') {
              return {
                ...e,
                id: `move-preview-${e.id}`,
                start: { x: e.start.x + dx, y: e.start.y + dy },
                end: { x: e.end.x + dx, y: e.end.y + dy },
              } as LineEntity;
            } else if (e.type === 'circle') {
              return {
                ...e,
                id: `move-preview-${e.id}`,
                center: { x: e.center.x + dx, y: e.center.y + dy },
              } as CircleEntity;
            } else if (e.type === 'arc') {
              return {
                ...e,
                id: `move-preview-${e.id}`,
                center: { x: e.center.x + dx, y: e.center.y + dy },
              } as ArcEntity;
            } else if (e.type === 'polyline') {
              return {
                ...e,
                id: `move-preview-${e.id}`,
                points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
              } as PolylineEntity;
            }
            return e;
          });
          setMovePreviewEntities(preview);
        } else {
          setMovePreviewEntities(null);
        }
      } else {
        setMovePreviewEntities(null);
      }

      if (currentTool === 'SCALE') {
        if (scaleStep === 'PICK_FACTOR' && scaleBasePoint && drawSession.isDrawing) {
          const curDist = Math.hypot(res.point.x - scaleBasePoint.x, res.point.y - scaleBasePoint.y);
          const factor = scaleRefDist > 1e-4 ? Math.max(0.01, curDist / scaleRefDist) : 1.0;
          setCurrentScaleFactor(factor);

          const sourceEntities = currentEntities.filter((e) => scaleSourceIds.includes(e.id));
          const preview: CADEntity2D[] = sourceEntities.map((e) => {
            if (e.type === 'line') {
              return {
                ...e,
                id: `scale-preview-${e.id}`,
                start: {
                  x: scaleBasePoint.x + (e.start.x - scaleBasePoint.x) * factor,
                  y: scaleBasePoint.y + (e.start.y - scaleBasePoint.y) * factor,
                },
                end: {
                  x: scaleBasePoint.x + (e.end.x - scaleBasePoint.x) * factor,
                  y: scaleBasePoint.y + (e.end.y - scaleBasePoint.y) * factor,
                },
              } as LineEntity;
            } else if (e.type === 'circle') {
              return {
                ...e,
                id: `scale-preview-${e.id}`,
                center: {
                  x: scaleBasePoint.x + (e.center.x - scaleBasePoint.x) * factor,
                  y: scaleBasePoint.y + (e.center.y - scaleBasePoint.y) * factor,
                },
                radius: Math.max(0.001, e.radius * factor),
              } as CircleEntity;
            } else if (e.type === 'arc') {
              return {
                ...e,
                id: `scale-preview-${e.id}`,
                center: {
                  x: scaleBasePoint.x + (e.center.x - scaleBasePoint.x) * factor,
                  y: scaleBasePoint.y + (e.center.y - scaleBasePoint.y) * factor,
                },
                radius: Math.max(0.001, e.radius * factor),
              } as ArcEntity;
            } else if (e.type === 'polyline') {
              return {
                ...e,
                id: `scale-preview-${e.id}`,
                points: e.points.map((p) => ({
                  x: scaleBasePoint.x + (p.x - scaleBasePoint.x) * factor,
                  y: scaleBasePoint.y + (p.y - scaleBasePoint.y) * factor,
                })),
              } as PolylineEntity;
            }
            return e;
          });
          setScalePreviewEntities(preview);
        } else {
          setScalePreviewEntities(null);
        }
      } else {
        setScalePreviewEntities(null);
      }

      if (currentTool === 'ROTATE') {
        if (rotateStep === 'PICK_ANGLE' && rotateBasePoint && drawSession.isDrawing) {
          const dx = res.point.x - rotateBasePoint.x;
          const dy = res.point.y - rotateBasePoint.y;
          const curDist = Math.hypot(dx, dy);
          const angleRad = curDist > 1e-6 ? Math.atan2(dy, dx) : 0;
          const angleDeg = (angleRad * 180) / Math.PI;
          setCurrentRotateAngleDeg(angleDeg);

          const cosT = Math.cos(angleRad);
          const sinT = Math.sin(angleRad);
          const sourceEntities = currentEntities.filter((e) => rotateSourceIds.includes(e.id));
          const preview: CADEntity2D[] = sourceEntities.map((e) => {
            if (e.type === 'line') {
              return {
                ...e,
                id: `rotate-preview-${e.id}`,
                start: {
                  x: (e.start.x - rotateBasePoint.x) * cosT - (e.start.y - rotateBasePoint.y) * sinT + rotateBasePoint.x,
                  y: (e.start.x - rotateBasePoint.x) * sinT + (e.start.y - rotateBasePoint.y) * cosT + rotateBasePoint.y,
                },
                end: {
                  x: (e.end.x - rotateBasePoint.x) * cosT - (e.end.y - rotateBasePoint.y) * sinT + rotateBasePoint.x,
                  y: (e.end.x - rotateBasePoint.x) * sinT + (e.end.y - rotateBasePoint.y) * cosT + rotateBasePoint.y,
                },
              } as LineEntity;
            } else if (e.type === 'circle') {
              return {
                ...e,
                id: `rotate-preview-${e.id}`,
                center: {
                  x: (e.center.x - rotateBasePoint.x) * cosT - (e.center.y - rotateBasePoint.y) * sinT + rotateBasePoint.x,
                  y: (e.center.x - rotateBasePoint.x) * sinT + (e.center.y - rotateBasePoint.y) * cosT + rotateBasePoint.y,
                },
              } as CircleEntity;
            } else if (e.type === 'arc') {
              return {
                ...e,
                id: `rotate-preview-${e.id}`,
                center: {
                  x: (e.center.x - rotateBasePoint.x) * cosT - (e.center.y - rotateBasePoint.y) * sinT + rotateBasePoint.x,
                  y: (e.center.x - rotateBasePoint.x) * sinT + (e.center.y - rotateBasePoint.y) * cosT + rotateBasePoint.y,
                },
                startAngle: normalizeAngle(e.startAngle + angleRad),
                endAngle: normalizeAngle(e.endAngle + angleRad),
              } as ArcEntity;
            } else if (e.type === 'polyline') {
              return {
                ...e,
                id: `rotate-preview-${e.id}`,
                points: e.points.map((p) => ({
                  x: (p.x - rotateBasePoint.x) * cosT - (p.y - rotateBasePoint.y) * sinT + rotateBasePoint.x,
                  y: (p.x - rotateBasePoint.x) * sinT + (p.y - rotateBasePoint.y) * cosT + rotateBasePoint.y,
                })),
              } as PolylineEntity;
            }
            return e;
          });
          setRotatePreviewEntities(preview);
        } else {
          setRotatePreviewEntities(null);
        }
      } else {
        setRotatePreviewEntities(null);
      }

      // Circular Array live preview around hovered center point
      if (currentTool === 'CIRCULAR_ARRAY') {
        if (arrayStep === 'PICK_CENTER' && arraySourceIds.length > 0) {
          const centerPt = res.point;
          const items = useCADStore.getState().arrayItems || 4;
          const fillAngleDeg = useCADStore.getState().arrayFillAngle ?? 360;
          const isFullCircle = Math.abs(Math.abs(fillAngleDeg) - 360) < 1e-4;
          const angleStepDeg = isFullCircle ? fillAngleDeg / items : (items > 1 ? fillAngleDeg / (items - 1) : 0);
          const angleStepRad = (angleStepDeg * Math.PI) / 180;

          const sourceEntities = currentEntities.filter((e) => arraySourceIds.includes(e.id));
          const previews: CADEntity2D[] = [];

          for (let i = 1; i < items; i++) {
            const rotRad = i * angleStepRad;
            const cosT = Math.cos(rotRad);
            const sinT = Math.sin(rotRad);

            for (const e of sourceEntities) {
              if (e.type === 'line') {
                previews.push({
                  ...e,
                  id: `array-preview-${i}-${e.id}`,
                  start: {
                    x: (e.start.x - centerPt.x) * cosT - (e.start.y - centerPt.y) * sinT + centerPt.x,
                    y: (e.start.x - centerPt.x) * sinT + (e.start.y - centerPt.y) * cosT + centerPt.y,
                  },
                  end: {
                    x: (e.end.x - centerPt.x) * cosT - (e.end.y - centerPt.y) * sinT + centerPt.x,
                    y: (e.end.x - centerPt.x) * sinT + (e.end.y - centerPt.y) * cosT + centerPt.y,
                  },
                } as LineEntity);
              } else if (e.type === 'circle') {
                previews.push({
                  ...e,
                  id: `array-preview-${i}-${e.id}`,
                  center: {
                    x: (e.center.x - centerPt.x) * cosT - (e.center.y - centerPt.y) * sinT + centerPt.x,
                    y: (e.center.x - centerPt.x) * sinT + (e.center.y - centerPt.y) * cosT + centerPt.y,
                  },
                } as CircleEntity);
              } else if (e.type === 'arc') {
                previews.push({
                  ...e,
                  id: `array-preview-${i}-${e.id}`,
                  center: {
                    x: (e.center.x - centerPt.x) * cosT - (e.center.y - centerPt.y) * sinT + centerPt.x,
                    y: (e.center.x - centerPt.x) * sinT + (e.center.y - centerPt.y) * cosT + centerPt.y,
                  },
                  startAngle: normalizeAngle(e.startAngle + rotRad),
                  endAngle: normalizeAngle(e.endAngle + rotRad),
                } as ArcEntity);
              } else if (e.type === 'polyline') {
                previews.push({
                  ...e,
                  id: `array-preview-${i}-${e.id}`,
                  points: e.points.map((p) => ({
                    x: (p.x - centerPt.x) * cosT - (p.y - centerPt.y) * sinT + centerPt.x,
                    y: (p.x - centerPt.x) * sinT + (p.y - centerPt.y) * cosT + centerPt.y,
                  })),
                } as PolylineEntity);
              }
            }
          }
          setArrayPreviewEntities(previews);
        } else {
          setArrayPreviewEntities(null);
        }
      } else {
        setArrayPreviewEntities(null);
      }
    },
    [
      resolveEffectiveCursor,
      currentTool,
      currentEntities,
      offsetTargetId,
      offsetDistance,
      mirrorStep,
      mirrorSourceIds,
      moveStep,
      moveSourceIds,
      moveBasePoint,
      scaleStep,
      scaleSourceIds,
      scaleBasePoint,
      scaleRefDist,
      rotateStep,
      rotateSourceIds,
      rotateBasePoint,
      arrayStep,
      arraySourceIds,
      drawSession.isDrawing,
      deferredTangent,
    ]
  );

  const handleCanvasClick = useCallback(
    (worldPt: Point2D, scale: number = 1.0) => {
      if (!activeSketchId) return;

      const res = resolveEffectiveCursor(worldPt, scale);
      const clickPt = res.point;

      if (currentTool === 'LINE') {
        if (!drawSession.isDrawing) {
          if (res.snap && res.snap.type === 'tangent') {
            const targetEntity = currentEntities.find((e) => e.id === res.snap!.entityId);
            if (targetEntity && (targetEntity.type === 'circle' || targetEntity.type === 'arc')) {
              const isArc = targetEntity.type === 'arc';
              setDeferredTangent({
                entityId: targetEntity.id,
                center: targetEntity.center,
                radius: targetEntity.radius,
                initialPick: res.snap.point,
                isArc,
                startAngle: isArc ? targetEntity.startAngle : undefined,
                endAngle: isArc ? targetEntity.endAngle : undefined,
              });
            }
          }
          setDrawSession({
            isDrawing: true,
            startPoint: clickPt,
            currentCursor: clickPt,
            step: 1,
          });
          setStartSnap(res.snap);
        } else if (drawSession.startPoint) {
          const actualEndPt = clickPt;

          const newLine: LineEntity = {
            id: crypto.randomUUID(),
            layerId: 'layer-0',
            visible: true,
            locked: false,
            type: 'line',
            start: drawSession.startPoint,
            end: actualEndPt,
          };

          addEntity(newLine);

          if (deferredTangent) {
            addConstraint({
              id: crypto.randomUUID(),
              type: 'tangent',
              entityIds: [newLine.id, deferredTangent.entityId],
              pointIndices: [0],
            });
            setDeferredTangent(null);
          }

          if (startSnap && startSnap.entityId !== newLine.id && (startSnap.type === 'endpoint' || startSnap.type === 'center') && startSnap.pointIndex !== undefined) {
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [newLine.id, startSnap.entityId],
              pointIndices: [0, startSnap.pointIndex],
            });
          }

          if (res.snap && res.snap.entityId !== newLine.id && (res.snap.type === 'endpoint' || res.snap.type === 'center') && res.snap.pointIndex !== undefined) {
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [newLine.id, res.snap.entityId],
              pointIndices: [1, res.snap.pointIndex],
            });
          }

          if (res.inferredConstraint) {
            addConstraint({
              id: crypto.randomUUID(),
              type: res.inferredConstraint,
              entityIds: [newLine.id],
            });
          }

          setDrawSession({
            isDrawing: true,
            startPoint: actualEndPt,
            currentCursor: actualEndPt,
            step: 1,
            inferredConstraint: null,
          });
          setStartSnap(res.snap);
        }
      } else if (currentTool === 'POLYLINE') {
        if (!drawSession.isDrawing) {
          setDrawSession({
            isDrawing: true,
            startPoint: clickPt,
            currentCursor: clickPt,
            step: 1,
          });
          setStartSnap(res.snap);
          setPolySegments([]);
          setLastTangentDir(null);
          setPolylineWarning(null);
        } else if (drawSession.startPoint) {
          let actualEndPt = clickPt;
          let arcData = null;

          // Determine start point of the first segment to check for closing
          let polyStartPt: Point2D | null = null;
          if (firstEntityId) {
            const firstEntity = currentEntities.find((e) => e.id === firstEntityId);
            if (firstEntity) {
              if (firstEntity.type === 'line') {
                polyStartPt = firstEntity.start;
              } else if (firstEntity.type === 'arc') {
                polyStartPt = {
                  x: firstEntity.center.x + firstEntity.radius * Math.cos(firstEntity.startAngle),
                  y: firstEntity.center.y + firstEntity.radius * Math.sin(firstEntity.startAngle),
                };
              }
            }
          }
          if (!polyStartPt) {
            polyStartPt = drawSession.startPoint;
          }

          const isNearFirstStart =
            polyStartPt
              ? Math.hypot(clickPt.x - polyStartPt.x, clickPt.y - polyStartPt.y) < 0.5
              : false;

          const isClosing = Boolean(
            firstEntityId && (
              (res.snap && res.snap.entityId === firstEntityId && res.snap.pointIndex === 0) ||
              isNearFirstStart
            )
          );

          if (isClosing && polyStartPt) {
            actualEndPt = polyStartPt;
            if (polylineMode === 'ARC' && lastTangentDir) {
              arcData = calculateTangentArcSegment(drawSession.startPoint, lastTangentDir, polyStartPt);
            } else {
              arcData = null;
            }
          } else {
            if (polylineMode === 'LINE') {
              actualEndPt = clickPt;
            } else if (polylineMode === 'ARC' && lastTangentDir) {
              arcData = calculateTangentArcSegment(drawSession.startPoint, lastTangentDir, clickPt);
            }
          }

          let newEntityId = '';

          if (polylineMode === 'ARC' && arcData) {
            const newArc: ArcEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'arc',
              center: arcData.center,
              radius: arcData.radius,
              startAngle: arcData.startAngle,
              endAngle: arcData.endAngle,
            };
            addEntity(newArc);
            newEntityId = newArc.id;

            const newTangent = getSegmentEndTangent(newArc, arcData.isStartPointMatchingPStart);
            setLastTangentDir(newTangent);
            setPolySegments((prev) => [...prev, { entityId: newArc.id, endPt: actualEndPt, type: 'arc' }]);
          } else {
            // Default to LINE
            const newLine: LineEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'line',
              start: drawSession.startPoint,
              end: actualEndPt,
            };
            addEntity(newLine);
            newEntityId = newLine.id;

            const newTangent = getSegmentEndTangent(newLine);
            setLastTangentDir(newTangent);
            setPolySegments((prev) => [...prev, { entityId: newLine.id, endPt: actualEndPt, type: 'line' }]);

            if (res.inferredConstraint) {
              addConstraint({
                id: crypto.randomUUID(),
                type: res.inferredConstraint,
                entityIds: [newLine.id],
              });
            }
          }

          // Continuity & constraints integration
          if (!lastEntityId) {
            setFirstEntityId(newEntityId);
            setLastEntityId(newEntityId);

            if (startSnap && startSnap.entityId !== newEntityId && (startSnap.type === 'endpoint' || startSnap.type === 'center') && startSnap.pointIndex !== undefined) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newEntityId, startSnap.entityId],
                pointIndices: [0, startSnap.pointIndex],
              });
            }
          } else {
            // Find physical starting point index of the new segment
            let newStartIndex = 0;
            if (polylineMode === 'ARC' && arcData) {
              newStartIndex = arcData.isStartPointMatchingPStart ? 0 : 1;
            }

            // Find physical ending point index of previous segment
            let lastEndIndex = 1;
            const lastEntity = currentEntities.find((e) => e.id === lastEntityId);
            if (lastEntity) {
              if (lastEntity.type === 'line') {
                lastEndIndex = 1;
              } else if (lastEntity.type === 'arc') {
                const startPt = {
                  x: lastEntity.center.x + lastEntity.radius * Math.cos(lastEntity.startAngle),
                  y: lastEntity.center.y + lastEntity.radius * Math.sin(lastEntity.startAngle),
                };
                const endPt = {
                  x: lastEntity.center.x + lastEntity.radius * Math.cos(lastEntity.endAngle),
                  y: lastEntity.center.y + lastEntity.radius * Math.sin(lastEntity.endAngle),
                };
                const dStart = Math.hypot(drawSession.startPoint.x - startPt.x, drawSession.startPoint.y - startPt.y);
                const dEnd = Math.hypot(drawSession.startPoint.x - endPt.x, drawSession.startPoint.y - endPt.y);
                lastEndIndex = dStart < dEnd ? 0 : 1;
              }
            }

            // Coincident constraint for continuous segments
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [lastEntityId, newEntityId],
              pointIndices: [lastEndIndex, newStartIndex],
            });

            // "若剛畫的是圓弧且與上一段相接，同時注入 tangent 約束"
            if (polylineMode === 'ARC' && arcData) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'tangent',
                entityIds: [lastEntityId, newEntityId],
                pointIndices: [lastEndIndex, newStartIndex],
              });
            }

            setLastEntityId(newEntityId);
          }

          if (res.snap && res.snap.entityId !== newEntityId && !isClosing && (res.snap.type === 'endpoint' || res.snap.type === 'center') && res.snap.pointIndex !== undefined) {
            let newEndIndex = 1;
            if (polylineMode === 'ARC' && arcData) {
              newEndIndex = arcData.isStartPointMatchingPStart ? 1 : 0;
            }
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [newEntityId, res.snap.entityId],
              pointIndices: [newEndIndex, res.snap.pointIndex],
            });
          }

          if (isClosing && firstEntityId) {
            let newEndIndex = 1;
            if (polylineMode === 'ARC' && arcData) {
              newEndIndex = arcData.isStartPointMatchingPStart ? 1 : 0;
            }
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [newEntityId, firstEntityId],
              pointIndices: [newEndIndex, 0],
            });
            cancelDrawing();
            return;
          }

          setDrawSession({
            isDrawing: true,
            startPoint: actualEndPt,
            currentCursor: actualEndPt,
            step: 1,
            inferredConstraint: null,
          });
          setStartSnap(res.snap);
        }
      } else if (currentTool === 'CIRCLE') {
        if (!drawSession.isDrawing) {
          setDrawSession({
            isDrawing: true,
            startPoint: clickPt,
            currentCursor: clickPt,
            step: 1,
          });
        } else if (drawSession.startPoint) {
          const dx = clickPt.x - drawSession.startPoint.x;
          const dy = clickPt.y - drawSession.startPoint.y;
          const radius = Math.hypot(dx, dy);

          if (radius > 0.5) {
            const newCircle: CircleEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'circle',
              center: drawSession.startPoint,
              radius: radius,
            };
            addEntity(newCircle);
          }

          cancelDrawing();
        }
      } else if (currentTool === 'RECTANGLE') {
        if (!drawSession.isDrawing) {
          setDrawSession({
            isDrawing: true,
            startPoint: clickPt,
            currentCursor: clickPt,
            step: 1,
          });
        } else if (drawSession.startPoint) {
          const p1 = drawSession.startPoint;
          const p2 = clickPt;
          const width = Math.abs(p2.x - p1.x);
          const height = Math.abs(p2.y - p1.y);

          if (width > 0.5 && height > 0.5) {
            const minX = Math.min(p1.x, p2.x);
            const maxX = Math.max(p1.x, p2.x);
            const minY = Math.min(p1.y, p2.y);
            const maxY = Math.max(p1.y, p2.y);

            const topLine: LineEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'line',
              start: { x: maxX, y: maxY },
              end: { x: minX, y: maxY },
            };

            const bottomLine: LineEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'line',
              start: { x: minX, y: minY },
              end: { x: maxX, y: minY },
            };

            const leftLine: LineEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'line',
              start: { x: minX, y: maxY },
              end: { x: minX, y: minY },
            };

            const rightLine: LineEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'line',
              start: { x: maxX, y: minY },
              end: { x: maxX, y: maxY },
            };

            addEntity(bottomLine);
            addEntity(rightLine);
            addEntity(topLine);
            addEntity(leftLine);

            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [bottomLine.id, rightLine.id],
              pointIndices: [1, 0],
            });
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [rightLine.id, topLine.id],
              pointIndices: [1, 0],
            });
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [topLine.id, leftLine.id],
              pointIndices: [1, 0],
            });
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [leftLine.id, bottomLine.id],
              pointIndices: [1, 0],
            });

            addConstraint({
              id: crypto.randomUUID(),
              type: 'horizontal',
              entityIds: [topLine.id],
            });
            addConstraint({
              id: crypto.randomUUID(),
              type: 'horizontal',
              entityIds: [bottomLine.id],
            });

            addConstraint({
              id: crypto.randomUUID(),
              type: 'vertical',
              entityIds: [leftLine.id],
            });
            addConstraint({
              id: crypto.randomUUID(),
              type: 'vertical',
              entityIds: [rightLine.id],
            });
          }

          cancelDrawing();
        }
      } else if (currentTool === 'POLYGON') {
        if (!drawSession.isDrawing) {
          setDrawSession({
            isDrawing: true,
            startPoint: clickPt,
            currentCursor: clickPt,
            step: 1,
            inferredConstraint: null,
          });
          setStartSnap(res.snap);
        } else if (drawSession.startPoint) {
          const sides = useCADStore.getState().polygonSides || 5;
          const method = useCADStore.getState().polygonMethod || 'inscribed';
          const vertices = calculatePolygonVertices(drawSession.startPoint, clickPt, sides, method);
          const dist = Math.hypot(clickPt.x - drawSession.startPoint.x, clickPt.y - drawSession.startPoint.y);

          if (dist > 0.01) {
            const newPolygon: PolylineEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'polyline',
              points: vertices,
              closed: true,
            };
            addEntity(newPolygon);
          }

          cancelDrawing();
        }
      } else if (currentTool === 'ARC_3P' || currentTool === 'ARC') {
        if (!drawSession.isDrawing || drawSession.step === 0) {
          setDrawSession({
            isDrawing: true,
            startPoint: clickPt,
            secondPoint: null,
            currentCursor: clickPt,
            step: 1,
          });
          setSnapP1(currentSnap ? { ...currentSnap } : null);
          setSnapP2(null);
        } else if (drawSession.step === 1 && drawSession.startPoint) {
          const p1 = drawSession.startPoint;
          const dist = Math.hypot(clickPt.x - p1.x, clickPt.y - p1.y);
          if (dist > 0.5) {
            setDrawSession((prev) => ({
              ...prev,
              secondPoint: clickPt,
              currentCursor: clickPt,
              step: 2,
            }));
            setSnapP2(currentSnap ? { ...currentSnap } : null);
          }
        } else if (drawSession.step === 2 && drawSession.startPoint && drawSession.secondPoint) {
          const p1 = drawSession.startPoint;
          const p2 = drawSession.secondPoint;
          const p3 = clickPt;

          const arcData = calculate3PointArc(p1, p2, p3);
          if (arcData && arcData.radius > 0.5) {
            const newArc: ArcEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'arc',
              center: arcData.center,
              radius: arcData.radius,
              startAngle: arcData.startAngle,
              endAngle: arcData.endAngle,
            };

            addEntity(newArc);

            const arcStart = {
              x: newArc.center.x + newArc.radius * Math.cos(newArc.startAngle),
              y: newArc.center.y + newArc.radius * Math.sin(newArc.startAngle),
            };
            const arcEnd = {
              x: newArc.center.x + newArc.radius * Math.cos(newArc.endAngle),
              y: newArc.center.y + newArc.radius * Math.sin(newArc.endAngle),
            };

            const dStartP1 = Math.hypot(arcStart.x - p1.x, arcStart.y - p1.y);
            const dEndP1 = Math.hypot(arcEnd.x - p1.x, arcEnd.y - p1.y);
            const p1Index = dStartP1 <= dEndP1 ? 0 : 1;
            const p2Index = p1Index === 0 ? 1 : 0;

            if (snapP1 && (snapP1.type === 'endpoint' || snapP1.type === 'center') && snapP1.pointIndex !== undefined) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newArc.id, snapP1.entityId],
                pointIndices: [p1Index, snapP1.pointIndex],
              });
            }

            if (snapP2 && (snapP2.type === 'endpoint' || snapP2.type === 'center') && snapP2.pointIndex !== undefined) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newArc.id, snapP2.entityId],
                pointIndices: [p2Index, snapP2.pointIndex],
              });
            }
          }

          cancelDrawing();
        }
      } else if (currentTool === 'ARC_CENTER') {
        if (!drawSession.isDrawing || drawSession.step === 0) {
          setDrawSession({
            isDrawing: true,
            startPoint: clickPt,
            secondPoint: null,
            currentCursor: clickPt,
            step: 1,
          });
          setSnapCenter(currentSnap ? { ...currentSnap } : null);
          setSnapP1(null);
          setSnapP2(null);
        } else if (drawSession.step === 1 && drawSession.startPoint) {
          const C = drawSession.startPoint;
          const dist = Math.hypot(clickPt.x - C.x, clickPt.y - C.y);
          if (dist > 0.5) {
            setDrawSession((prev) => ({
              ...prev,
              secondPoint: clickPt,
              currentCursor: clickPt,
              step: 2,
            }));
            setSnapP1(currentSnap ? { ...currentSnap } : null);
          }
        } else if (drawSession.step === 2 && drawSession.startPoint && drawSession.secondPoint) {
          const C = drawSession.startPoint;
          const P_start = drawSession.secondPoint;
          const radius = Math.hypot(P_start.x - C.x, P_start.y - C.y);

          if (radius > 0.5) {
            const startAngle = Math.atan2(P_start.y - C.y, P_start.x - C.x);
            const endAngle = Math.atan2(clickPt.y - C.y, clickPt.x - C.x);

            const newArc: ArcEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'arc',
              center: C,
              radius: radius,
              startAngle: startAngle,
              endAngle: endAngle,
            };

            addEntity(newArc);

            if (snapCenter) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newArc.id, snapCenter.entityId],
                pointIndices: [2, snapCenter.pointIndex ?? 0],
              });
            }

            if (snapP1) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newArc.id, snapP1.entityId],
                pointIndices: [0, snapP1.pointIndex ?? 0],
              });
            }

            if (currentSnap) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newArc.id, currentSnap.entityId],
                pointIndices: [1, currentSnap.pointIndex ?? 0],
              });
            }
          }

          cancelDrawing();
        }
      } else if (currentTool === 'DIMENSION') {
        if (!drawSession.isDrawing || drawSession.step === 0) {
          const isValidDimSnap = currentSnap && ['endpoint', 'midpoint', 'center', 'intersection'].includes(currentSnap.type);
          if (isValidDimSnap) {
            setDimSnap1(currentSnap);
            setDrawSession({
              isDrawing: true,
              startPoint: currentSnap.point,
              currentCursor: clickPt,
              step: 1,
            });
          } else {
            const threshold = 15 / scale;
            let closestEntity: CADEntity2D | null = null;
            let minDistance = threshold;

            for (const entity of currentEntities) {
              if (entity.type === 'line' || entity.type === 'circle' || entity.type === 'arc') {
                const dist = getDistanceToEntity(clickPt, entity);
                if (dist < minDistance) {
                  minDistance = dist;
                  closestEntity = entity;
                }
              }
            }

            if (closestEntity) {
              if (closestEntity.type === 'circle' || closestEntity.type === 'arc') {
                const center = closestEntity.center;
                const r = closestEntity.radius;
                const dx = clickPt.x - center.x;
                const dy = clickPt.y - center.y;
                const dist = Math.hypot(dx, dy);
                const borderPt = dist > 1e-10 
                   ? { x: center.x + (dx / dist) * r, y: center.y + (dy / dist) * r }
                   : { x: center.x + r, y: center.y };

                setDimSelectedCircleOrArc(closestEntity);
                setDrawSession({
                  isDrawing: true,
                  startPoint: center,
                  secondPoint: borderPt,
                  currentCursor: clickPt,
                  step: 2,
                });
              } else if (closestEntity.type === 'line') {
                setDimSelectedLineId(closestEntity.id);
                setDrawSession({
                  isDrawing: true,
                  startPoint: closestEntity.start,
                  secondPoint: closestEntity.end,
                  currentCursor: clickPt,
                  step: 2,
                });
              }
            }
          }
        } else if (drawSession.step === 1 && drawSession.startPoint) {
          const isValidDimSnap = currentSnap && ['endpoint', 'midpoint', 'center', 'intersection'].includes(currentSnap.type);
          if (isValidDimSnap) {
            setDimSnap2(currentSnap);
          } else {
            setDimSnap2(null);
          }
          setDrawSession((prev) => ({
            ...prev,
            secondPoint: clickPt,
            currentCursor: clickPt,
            step: 2,
          }));
        } else if (drawSession.step === 2 && drawSession.startPoint && drawSession.secondPoint) {
          if (dimSelectedCircleOrArc) {
            const dimTarget = dimSelectedCircleOrArc;
            const constraintId = crypto.randomUUID();
            const newDimension = {
              id: crypto.randomUUID(),
              type: 'radial' as const,
              points: [dimTarget.center, drawSession.secondPoint],
              textPosition: clickPt,
              constraintId: constraintId,
              isDiameter: dimTarget.type === 'circle',
            };
            const newConstraint = {
              id: constraintId,
              type: 'distance' as const,
              entityIds: [dimTarget.id],
              value: dimTarget.radius,
            };
            addDimension(newDimension, newConstraint);
            cancelDrawing();
          } else {
            if (dimSelectedLineId) {
              const threshold = 15 / scale;
              let closestEntity: CADEntity2D | null = null;
              let minDistance = threshold;
              for (const entity of currentEntities) {
                if (entity.type === 'line' && entity.id !== dimSelectedLineId) {
                  const dist = getDistanceToEntity(clickPt, entity);
                  if (dist < minDistance) {
                    minDistance = dist;
                    closestEntity = entity;
                  }
                }
              }

              if (closestEntity) {
                setDimSelectedLineId2(closestEntity.id);
                setDrawSession((prev) => ({
                  ...prev,
                  step: 3,
                }));
                return;
              }
            }

            const p1 = drawSession.startPoint;
            const p2 = drawSession.secondPoint;
            const textPosition = clickPt;
            const physicalLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);

            const dimensionId = crypto.randomUUID();
            const constraintId = crypto.randomUUID();

            let entityIds: string[] | undefined = undefined;
            if (dimSelectedLineId) {
              entityIds = [dimSelectedLineId];
            } else if (dimSnap1 && dimSnap2) {
              entityIds = [dimSnap1.entityId, dimSnap2.entityId];
            }

            const dimType = determineLinearDimType(p1, p2, textPosition);

            const newDimension = {
              id: dimensionId,
              type: 'linear' as const,
              dimType: dimType,
              points: [p1, p2],
              textPosition: textPosition,
              constraintId: constraintId,
              entityIds: entityIds,
            };

            let newConstraint;
            if (dimSelectedLineId) {
              newConstraint = {
                id: constraintId,
                type: 'length' as const,
                entityIds: [dimSelectedLineId],
                value: physicalLen,
              };
            } else if (dimSnap1 && dimSnap2) {
              newConstraint = {
                id: constraintId,
                type: 'distance' as const,
                entityIds: [dimSnap1.entityId, dimSnap2.entityId],
                pointIndices: [dimSnap1.pointIndex ?? 0, dimSnap2.pointIndex ?? 0],
                value: physicalLen,
              };
            } else {
              newConstraint = {
                id: constraintId,
                type: 'distance' as const,
                entityIds: [],
                value: physicalLen,
              };
            }

            addDimension(newDimension, newConstraint);
            cancelDrawing();
          }
        } else if (drawSession.step === 3 && dimSelectedLineId && dimSelectedLineId2) {
          const line1 = currentEntities.find((e) => e.id === dimSelectedLineId) as LineEntity;
          const line2 = currentEntities.find((e) => e.id === dimSelectedLineId2) as LineEntity;

          if (line1 && line2) {
            const dimensionId = crypto.randomUUID();
            const constraintId = crypto.randomUUID();

            const newDimension = {
              id: dimensionId,
              type: 'angular' as const,
              points: [line1.start, line1.end, line2.start, line2.end],
              textPosition: clickPt,
              constraintId: constraintId,
              entityIds: [line1.id, line2.id],
            };

            const newConstraint = {
              id: constraintId,
              type: 'angle' as const,
              entityIds: [line1.id, line2.id],
            };

            addDimension(newDimension, newConstraint);
          }
          cancelDrawing();
        }
      } else if (currentTool === 'TRIM') {
        if (trimPreviewEntity) {
          const hitEntityId = trimPreviewEntity.id.replace('trim-preview-', '');
          trimEntity(hitEntityId, clickPt);
        } else {
          let closestEntity: CADEntity2D | null = null;
          let minDistance = 5.0;
          for (const entity of currentEntities) {
            if (entity.type === 'line' || entity.type === 'arc' || entity.type === 'circle') {
              const dist = getDistanceToEntity(clickPt, entity);
              if (dist < minDistance) {
                minDistance = dist;
                closestEntity = entity;
              }
            }
          }
          if (closestEntity) {
            trimEntity(closestEntity.id, clickPt);
          }
        }
      } else if (currentTool === 'FILLET') {
        const threshold = 15 / scale;
        let closestEntity: CADEntity2D | null = null;
        let minDistance = threshold;

        for (const entity of currentEntities) {
          if (entity.type === 'line' || entity.type === 'arc') {
            const dist = getDistanceToEntity(clickPt, entity);
            if (dist < minDistance) {
              minDistance = dist;
              closestEntity = entity;
            }
          }
        }

        if (closestEntity && (closestEntity.type === 'line' || closestEntity.type === 'arc')) {
          if (!filletFirstEntityId) {
            setFilletFirstEntityId(closestEntity.id);
            setDrawSession({
              isDrawing: true,
              startPoint: null,
              currentCursor: null,
              step: 1,
            });
          } else if (closestEntity.id !== filletFirstEntityId) {
            const firstEnt = currentEntities.find((e) => e.id === filletFirstEntityId);
            if (firstEnt) {
              const isFirstLineOrArc = firstEnt.type === 'line' || firstEnt.type === 'arc';
              const isSecondLineOrArc = closestEntity.type === 'line' || closestEntity.type === 'arc';
              const isArcArc = firstEnt.type === 'arc' && closestEntity.type === 'arc';
              if (isFirstLineOrArc && isSecondLineOrArc && !isArcArc) {
                applyFillet(filletFirstEntityId, closestEntity.id, filletRadius);
              }
            }
            cancelDrawing();
          }
        }
      } else if (currentTool === 'CHAMFER') {
        const threshold = 15 / scale;
        let closestEntity: CADEntity2D | null = null;
        let minDistance = threshold;

        for (const entity of currentEntities) {
          if (entity.type === 'line') {
            const dist = getDistanceToEntity(clickPt, entity);
            if (dist < minDistance) {
              minDistance = dist;
              closestEntity = entity;
            }
          }
        }

        if (closestEntity && closestEntity.type === 'line') {
          if (!chamferFirstEntityId) {
            setChamferFirstEntityId(closestEntity.id);
            setDrawSession({
              isDrawing: true,
              startPoint: null,
              currentCursor: null,
              step: 1,
            });
          } else if (closestEntity.id !== chamferFirstEntityId) {
            const firstEnt = currentEntities.find((e) => e.id === chamferFirstEntityId);
            if (firstEnt && firstEnt.type === 'line') {
              applyChamfer(chamferFirstEntityId, closestEntity.id, chamferDistance);
            }
            cancelDrawing();
          }
        }
      } else if (currentTool === 'EXTEND') {
        if (extendPreview) {
          extendEntity(extendPreview.originalEntityId, clickPt);
        } else {
          const threshold = 15 / scale;
          let closestEntity: CADEntity2D | null = null;
          let minDistance = threshold;
          for (const entity of currentEntities) {
            if (entity.type === 'line' || entity.type === 'arc') {
              const dist = getDistanceToEntity(clickPt, entity);
              if (dist < threshold && dist < minDistance) {
                minDistance = dist;
                closestEntity = entity;
              }
            }
          }
          if (closestEntity) {
            extendEntity(closestEntity.id, clickPt);
          }
        }
      } else if (currentTool === 'OFFSET') {
        if (!offsetTargetId) {
          const threshold = 15 / scale;
          let closestEntity: CADEntity2D | null = null;
          let minDistance = threshold;

          for (const entity of currentEntities) {
            if (entity.type === 'line' || entity.type === 'arc' || entity.type === 'circle') {
              const dist = getDistanceToEntity(clickPt, entity);
              if (dist < minDistance) {
                minDistance = dist;
                closestEntity = entity;
              }
            }
          }

          if (closestEntity) {
            setOffsetTargetId(closestEntity.id);
          }
        } else {
          offsetEntity(offsetTargetId, offsetDistance, worldPt);
          setOffsetTargetId(null);
          setOffsetPreviewEntity(null);
        }
      } else if (currentTool === 'MIRROR') {
        const threshold = 15 / scale;
        if (mirrorStep === 'PICK_SOURCE') {
          let closestEntity: CADEntity2D | null = null;
          let minDistance = threshold;
          for (const entity of currentEntities) {
            const dist = getDistanceToEntity(clickPt, entity);
            if (dist < minDistance) {
              minDistance = dist;
              closestEntity = entity;
            }
          }
          if (closestEntity) {
            setMirrorSourceIds((prev) => {
              if (prev.includes(closestEntity!.id)) {
                return prev.filter((id) => id !== closestEntity!.id);
              } else {
                return [...prev, closestEntity!.id];
              }
            });
          }
        } else if (mirrorStep === 'PICK_AXIS') {
          let closestAxis: CADEntity2D | null = null;
          let minDistance = threshold;
          for (const entity of currentEntities) {
            if (entity.type === 'line') {
              const dist = getDistanceToEntity(clickPt, entity);
              if (dist < minDistance) {
                minDistance = dist;
                closestAxis = entity;
              }
            }
          }
          if (closestAxis && closestAxis.type === 'line' && mirrorSourceIds.length > 0) {
            // 自動剔除對稱軸自身，防止自我鏡射產生重疊幽靈幾何
            const finalSources = mirrorSourceIds.filter((id) => id !== closestAxis!.id);
            if (finalSources.length > 0) {
              mirrorEntities(finalSources, closestAxis.id);
            }
            cancelDrawing();
          }
        }
      } else if (currentTool === 'MOVE' || currentTool === 'COPY') {
        const threshold = 15 / scale;
        if (moveStep === 'PICK_OBJECTS') {
          let closestEntity: CADEntity2D | null = null;
          let minDistance = threshold;
          for (const entity of currentEntities) {
            const dist = getDistanceToEntity(clickPt, entity);
            if (dist < minDistance) {
              minDistance = dist;
              closestEntity = entity;
            }
          }
          if (closestEntity) {
            setMoveSourceIds((prev) => {
              if (prev.includes(closestEntity!.id)) {
                return prev.filter((id) => id !== closestEntity!.id);
              } else {
                return [...prev, closestEntity!.id];
              }
            });
          }
        } else if (moveStep === 'PICK_BASE') {
          // 指定基準點 (Base Point)，支援 SnapManager 與極軸追蹤解析出的 clickPt
          setMoveBasePoint(clickPt);
          setMoveStep('PICK_TARGET');
          setDrawSession({
            isDrawing: true,
            startPoint: clickPt,
            currentCursor: clickPt,
            step: 1,
            inferredConstraint: null,
          });
          setStartSnap(res.snap);
        } else if (moveStep === 'PICK_TARGET') {
          // 指定目標點 (Target Point)
          if (moveBasePoint && moveSourceIds.length > 0) {
            if (currentTool === 'MOVE') {
              moveEntities(moveSourceIds, moveBasePoint, clickPt);
            } else if (currentTool === 'COPY') {
              copyEntities(moveSourceIds, moveBasePoint, clickPt);
            }
          }
          cancelDrawing();
        }
      } else if (currentTool === 'SCALE') {
        const threshold = 15 / scale;
        if (scaleStep === 'PICK_OBJECTS') {
          let closestEntity: CADEntity2D | null = null;
          let minDistance = threshold;
          for (const entity of currentEntities) {
            const dist = getDistanceToEntity(clickPt, entity);
            if (dist < minDistance) {
              minDistance = dist;
              closestEntity = entity;
            }
          }
          if (closestEntity) {
            setScaleSourceIds((prev) => {
              if (prev.includes(closestEntity!.id)) {
                return prev.filter((id) => id !== closestEntity!.id);
              } else {
                return [...prev, closestEntity!.id];
              }
            });
          }
        } else if (scaleStep === 'PICK_BASE') {
          // (2) 指定縮放基準點 (Base Point)
          setScaleBasePoint(clickPt);

          // 計算參考距離 scaleRefDist
          const selectedEntities = currentEntities.filter((e) => scaleSourceIds.includes(e.id));
          let maxDist = 0;
          for (const ent of selectedEntities) {
            if (ent.type === 'line') {
              maxDist = Math.max(maxDist, Math.hypot(ent.start.x - clickPt.x, ent.start.y - clickPt.y));
              maxDist = Math.max(maxDist, Math.hypot(ent.end.x - clickPt.x, ent.end.y - clickPt.y));
            } else if (ent.type === 'circle' || ent.type === 'arc') {
              maxDist = Math.max(maxDist, Math.hypot(ent.center.x - clickPt.x, ent.center.y - clickPt.y) + ent.radius);
            } else if (ent.type === 'polyline') {
              for (const pt of ent.points) {
                maxDist = Math.max(maxDist, Math.hypot(pt.x - clickPt.x, pt.y - clickPt.y));
              }
            }
          }
          const refDist = maxDist > 1e-3 ? maxDist : 50;
          setScaleRefDist(refDist);

          setScaleStep('PICK_FACTOR');
          setDrawSession({
            isDrawing: true,
            startPoint: clickPt,
            currentCursor: clickPt,
            step: 1,
            inferredConstraint: null,
          });
          setStartSnap(res.snap);
        } else if (scaleStep === 'PICK_FACTOR') {
          // (3) 透過點擊確認當前縮放比例
          if (scaleBasePoint && scaleSourceIds.length > 0) {
            const curDist = Math.hypot(clickPt.x - scaleBasePoint.x, clickPt.y - scaleBasePoint.y);
            const factor = scaleRefDist > 1e-4 ? Math.max(0.01, curDist / scaleRefDist) : 1.0;
            scaleEntities(scaleSourceIds, scaleBasePoint, factor);
          }
          cancelDrawing();
        }
      } else if (currentTool === 'ROTATE') {
        const threshold = 15 / scale;
        if (rotateStep === 'PICK_OBJECTS') {
          let closestEntity: CADEntity2D | null = null;
          let minDistance = threshold;
          for (const entity of currentEntities) {
            const dist = getDistanceToEntity(clickPt, entity);
            if (dist < minDistance) {
              minDistance = dist;
              closestEntity = entity;
            }
          }
          if (closestEntity) {
            setRotateSourceIds((prev) => {
              if (prev.includes(closestEntity!.id)) {
                return prev.filter((id) => id !== closestEntity!.id);
              } else {
                return [...prev, closestEntity!.id];
              }
            });
          }
        } else if (rotateStep === 'PICK_BASE') {
          // (2) 指定旋轉基準點 (Base Point)
          setRotateBasePoint(clickPt);
          setRotateStep('PICK_ANGLE');
          setDrawSession({
            isDrawing: true,
            startPoint: clickPt,
            currentCursor: clickPt,
            step: 1,
            inferredConstraint: null,
          });
          setStartSnap(res.snap);
          setCurrentRotateAngleDeg(0);
        } else if (rotateStep === 'PICK_ANGLE') {
          // (3) 透過點擊確認當前旋轉角度
          if (rotateBasePoint && rotateSourceIds.length > 0) {
            const dx = clickPt.x - rotateBasePoint.x;
            const dy = clickPt.y - rotateBasePoint.y;
            const curDist = Math.hypot(dx, dy);
            const angleRad = curDist > 1e-6 ? Math.atan2(dy, dx) : 0;
            rotateEntities(rotateSourceIds, rotateBasePoint, angleRad);
          }
          cancelDrawing();
        }
      } else if (currentTool === 'CIRCULAR_ARRAY') {
        const threshold = 15 / scale;
        if (arrayStep === 'PICK_OBJECTS') {
          let closestEntity: CADEntity2D | null = null;
          let minDistance = threshold;
          for (const entity of currentEntities) {
            const dist = getDistanceToEntity(clickPt, entity);
            if (dist < minDistance) {
              minDistance = dist;
              closestEntity = entity;
            }
          }
          if (closestEntity) {
            setArraySourceIds((prev) => {
              if (prev.includes(closestEntity!.id)) {
                return prev.filter((id) => id !== closestEntity!.id);
              } else {
                return [...prev, closestEntity!.id];
              }
            });
          }
        } else if (arrayStep === 'PICK_CENTER') {
          // (2) 點擊指定「陣列中心點 (Center Point)」
          // (3) 讀取 UI 設定的參數並觸發陣列生成
          if (arraySourceIds.length > 0) {
            const items = useCADStore.getState().arrayItems || 4;
            const fillAngle = useCADStore.getState().arrayFillAngle ?? 360;
            circularArrayEntities(arraySourceIds, clickPt, items, fillAngle);
          }
          cancelDrawing();
        }
      } else if (currentTool === 'RECT_ARRAY') {
        const threshold = 15 / scale;
        let closestEntity: CADEntity2D | null = null;
        let minDistance = threshold;
        for (const entity of currentEntities) {
          const dist = getDistanceToEntity(clickPt, entity);
          if (dist < minDistance) {
            minDistance = dist;
            closestEntity = entity;
          }
        }
        if (closestEntity) {
          setRectArraySourceIds((prev) => {
            if (prev.includes(closestEntity!.id)) {
              return prev.filter((id) => id !== closestEntity!.id);
            } else {
              return [...prev, closestEntity!.id];
            }
          });
        }
      }
    },
    [
      activeSketchId,
      currentSnap,
      currentTool,
      drawSession,
      currentEntities,
      firstEntityId,
      lastEntityId,
      snapCenter,
      snapP1,
      snapP2,
      addEntity,
      addConstraint,
      cancelDrawing,
      trimEntity,
      trimPreviewEntity,
      extendEntity,
      extendPreview,
      dimSnap1,
      dimSnap2,
      dimSelectedLineId,
      dimSelectedCircleOrArc,
      addDimension,
      startSnap,
      applyFillet,
      filletFirstEntityId,
      filletRadius,
      applyChamfer,
      chamferFirstEntityId,
      chamferDistance,
      offsetTargetId,
      offsetDistance,
      offsetEntity,
      polylineMode,
      polySegments,
      lastTangentDir,
      mirrorStep,
      mirrorSourceIds,
      mirrorEntities,
      moveStep,
      moveSourceIds,
      moveBasePoint,
      moveEntities,
      copyEntities,
      scaleStep,
      scaleSourceIds,
      scaleBasePoint,
      scaleRefDist,
      scaleEntities,
      rotateStep,
      rotateSourceIds,
      rotateBasePoint,
      rotateEntities,
      arrayStep,
      arraySourceIds,
      circularArrayEntities,
      rectArraySourceIds,
      polarTracking,
      otrackGuideLines,
      deferredTangent,
    ]
  );

  const submitExactLength = useCallback(
    (length: number): boolean => {
      if (!activeSketchId) return false;
      if (!drawSession.isDrawing || !drawSession.startPoint) return false;
      if (
        currentTool !== 'LINE' &&
        currentTool !== 'POLYLINE' &&
        currentTool !== 'CIRCLE' &&
        currentTool !== 'POLYGON' &&
        currentTool !== 'MOVE' &&
        currentTool !== 'COPY' &&
        currentTool !== 'SCALE' &&
        currentTool !== 'ROTATE'
      ) {
        return false;
      }

      if (currentTool === 'ROTATE') {
        if (rotateStep === 'PICK_ANGLE' && rotateBasePoint && rotateSourceIds.length > 0) {
          const angleRad = (length * Math.PI) / 180;
          rotateEntities(rotateSourceIds, rotateBasePoint, angleRad);
          cancelDrawing();
          return true;
        }
        return false;
      }

      if (length <= 0) return false;

      if (currentTool === 'SCALE') {
        if (scaleStep === 'PICK_FACTOR' && scaleBasePoint && scaleSourceIds.length > 0) {
          scaleEntities(scaleSourceIds, scaleBasePoint, length);
          cancelDrawing();
          return true;
        }
        return false;
      }

      if (currentTool === 'CIRCLE') {
        const newCircle: CircleEntity = {
          id: crypto.randomUUID(),
          layerId: 'layer-0',
          visible: true,
          locked: false,
          type: 'circle',
          center: drawSession.startPoint,
          radius: length,
        };
        addEntity(newCircle);
        cancelDrawing();
        return true;
      }

      const startPoint = drawSession.startPoint;
      const currentCursor = drawSession.currentCursor;
      let u = { x: 1, y: 0 };

      if (orthoEnabled) {
        const dx = currentCursor.x - startPoint.x;
        const dy = currentCursor.y - startPoint.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
          u = { x: dx >= 0 ? 1 : -1, y: 0 };
        } else {
          u = { x: 0, y: dy >= 0 ? 1 : -1 };
        }
      } else if (polarTracking) {
        const thetaRad = (polarTracking.angleDeg * Math.PI) / 180;
        u = { x: Math.cos(thetaRad), y: Math.sin(thetaRad) };
      } else {
        const dx = currentCursor.x - startPoint.x;
        const dy = currentCursor.y - startPoint.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 1e-10) {
          u = { x: dx / dist, y: dy / dist };
        } else {
          u = { x: 1, y: 0 };
        }
      }

      const exactEndPt = {
        x: startPoint.x + u.x * length,
        y: startPoint.y + u.y * length,
      };

      if (currentTool === 'POLYGON') {
        const sides = useCADStore.getState().polygonSides || 5;
        const method = useCADStore.getState().polygonMethod || 'inscribed';
        const vertices = calculatePolygonVertices(startPoint, exactEndPt, sides, method);
        const newPolygon: PolylineEntity = {
          id: crypto.randomUUID(),
          layerId: 'layer-0',
          visible: true,
          locked: false,
          type: 'polyline',
          points: vertices,
          closed: true,
        };
        addEntity(newPolygon);
        cancelDrawing();
        return true;
      }

      if (currentTool === 'MOVE' || currentTool === 'COPY') {
        if (moveBasePoint && moveSourceIds.length > 0) {
          const targetPt = exactEndPt;
          if (currentTool === 'MOVE') {
            moveEntities(moveSourceIds, moveBasePoint, targetPt);
          } else {
            copyEntities(moveSourceIds, moveBasePoint, targetPt);
          }
          cancelDrawing();
          return true;
        }
        return false;
      }

      if (currentTool === 'LINE') {
        const newLine: LineEntity = {
          id: crypto.randomUUID(),
          layerId: 'layer-0',
          visible: true,
          locked: false,
          type: 'line',
          start: startPoint,
          end: exactEndPt,
        };

        addEntity(newLine);

        if (startSnap && startSnap.entityId !== newLine.id && (startSnap.type === 'endpoint' || startSnap.type === 'center') && startSnap.pointIndex !== undefined) {
          addConstraint({
            id: crypto.randomUUID(),
            type: 'coincident',
            entityIds: [newLine.id, startSnap.entityId],
            pointIndices: [0, startSnap.pointIndex],
          });
        }

        let inferred: 'horizontal' | 'vertical' | null = null;
        if (Math.abs(u.y) < 1e-5) {
          inferred = 'horizontal';
        } else if (Math.abs(u.x) < 1e-5) {
          inferred = 'vertical';
        }

        if (inferred) {
          addConstraint({
            id: crypto.randomUUID(),
            type: inferred,
            entityIds: [newLine.id],
          });
        }

        setDrawSession({
          isDrawing: true,
          startPoint: exactEndPt,
          currentCursor: exactEndPt,
          step: 1,
          inferredConstraint: null,
        });
        setStartSnap(null);
      } else if (currentTool === 'POLYLINE') {
        const newEntityId = crypto.randomUUID();

        const newLine: LineEntity = {
          id: newEntityId,
          layerId: 'layer-0',
          visible: true,
          locked: false,
          type: 'line',
          start: startPoint,
          end: exactEndPt,
        };
        addEntity(newLine);

        const newTangent = getSegmentEndTangent(newLine);
        setLastTangentDir(newTangent);
        setPolySegments((prev) => [...prev, { entityId: newLine.id, endPt: exactEndPt, type: 'line' }]);

        let inferred: 'horizontal' | 'vertical' | null = null;
        if (Math.abs(u.y) < 1e-5) {
          inferred = 'horizontal';
        } else if (Math.abs(u.x) < 1e-5) {
          inferred = 'vertical';
        }

        if (inferred) {
          addConstraint({
            id: crypto.randomUUID(),
            type: inferred,
            entityIds: [newLine.id],
          });
        }

        if (!lastEntityId) {
          setFirstEntityId(newEntityId);
          setLastEntityId(newEntityId);

          if (startSnap && startSnap.entityId !== newEntityId && (startSnap.type === 'endpoint' || startSnap.type === 'center') && startSnap.pointIndex !== undefined) {
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [newEntityId, startSnap.entityId],
              pointIndices: [0, startSnap.pointIndex],
            });
          }
        } else {
          addConstraint({
            id: crypto.randomUUID(),
            type: 'coincident',
            entityIds: [lastEntityId, newEntityId],
            pointIndices: [1, 0],
          });
          setLastEntityId(newEntityId);
        }

        setDrawSession({
          isDrawing: true,
          startPoint: exactEndPt,
          currentCursor: exactEndPt,
          step: 1,
          inferredConstraint: null,
        });
        setStartSnap(null);
      }

      return true;
    },
    [
      activeSketchId,
      drawSession,
      currentTool,
      orthoEnabled,
      polarTracking,
      startSnap,
      lastEntityId,
      addEntity,
      addConstraint,
      cancelDrawing,
      setDrawSession,
      setStartSnap,
      setFirstEntityId,
      setLastEntityId,
      setPolySegments,
      setLastTangentDir,
      moveStep,
      moveSourceIds,
      moveBasePoint,
      moveEntities,
      copyEntities,
      scaleStep,
      scaleSourceIds,
      scaleBasePoint,
      scaleEntities,
      rotateStep,
      rotateSourceIds,
      rotateBasePoint,
      rotateEntities,
    ]
  );

  const submitScaleFactor = useCallback(
    (factor: number): boolean => {
      if (!activeSketchId) return false;
      if (factor <= 0) return false;
      if (scaleBasePoint && scaleSourceIds.length > 0) {
        scaleEntities(scaleSourceIds, scaleBasePoint, factor);
        cancelDrawing();
        return true;
      }
      return false;
    },
    [activeSketchId, scaleBasePoint, scaleSourceIds, scaleEntities, cancelDrawing]
  );

  const submitRotateAngle = useCallback(
    (angleDeg: number): boolean => {
      if (!activeSketchId) return false;
      if (rotateBasePoint && rotateSourceIds.length > 0) {
        const angleRad = (angleDeg * Math.PI) / 180;
        rotateEntities(rotateSourceIds, rotateBasePoint, angleRad);
        cancelDrawing();
        return true;
      }
      return false;
    },
    [activeSketchId, rotateBasePoint, rotateSourceIds, rotateEntities, cancelDrawing]
  );

  // Rectangular Array 即時動態分身預覽 (Reactively updates when UI inputs change)
  const rectArrayPreviewEntities = useMemo<CADEntity2D[] | null>(() => {
    if (currentTool !== 'RECT_ARRAY' || rectArraySourceIds.length === 0) {
      return null;
    }
    if (rectArrayCols < 1 || rectArrayRows < 1 || (rectArrayCols === 1 && rectArrayRows === 1)) {
      return null;
    }

    const sourceEntities = currentEntities.filter((e) => rectArraySourceIds.includes(e.id));
    if (sourceEntities.length === 0) return null;

    const previews: CADEntity2D[] = [];

    for (let i = 0; i < rectArrayCols; i++) {
      for (let j = 0; j < rectArrayRows; j++) {
        if (i === 0 && j === 0) continue;

        const dx = i * rectArrayColSpacing;
        const dy = j * rectArrayRowSpacing;

        for (const e of sourceEntities) {
          const previewId = `rect-array-preview-${i}-${j}-${e.id}`;

          if (e.type === 'line') {
            previews.push({
              ...e,
              id: previewId,
              start: { x: e.start.x + dx, y: e.start.y + dy },
              end: { x: e.end.x + dx, y: e.end.y + dy },
            } as LineEntity);
          } else if (e.type === 'circle') {
            previews.push({
              ...e,
              id: previewId,
              center: { x: e.center.x + dx, y: e.center.y + dy },
            } as CircleEntity);
          } else if (e.type === 'arc') {
            previews.push({
              ...e,
              id: previewId,
              center: { x: e.center.x + dx, y: e.center.y + dy },
            } as ArcEntity);
          } else if (e.type === 'polyline') {
            previews.push({
              ...e,
              id: previewId,
              points: e.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })),
            } as PolylineEntity);
          }
        }
      }
    }

    return previews;
  }, [
    currentTool,
    rectArraySourceIds,
    currentEntities,
    rectArrayCols,
    rectArrayRows,
    rectArrayColSpacing,
    rectArrayRowSpacing,
  ]);

  return {
    drawSession,
    currentSnap,
    trimPreviewEntity,
    extendPreview,
    dimSelectedCircleOrArc,
    dimSelectedLineId,
    dimSelectedLineId2,
    filletFirstEntityId,
    filletRadius,
    setFilletRadius,
    chamferFirstEntityId,
    chamferDistance,
    setChamferDistance,
    offsetTargetId,
    offsetDistance,
    setOffsetDistance,
    offsetPreviewEntity,
    handlePointerMove,
    handleCanvasClick,
    cancelDrawing,
    // Polyline exports
    polylineMode,
    togglePolylineMode,
    polySegments,
    lastTangentDir,
    polylineWarning,
    // Mirror exports
    mirrorStep,
    setMirrorStep,
    mirrorSourceIds,
    setMirrorSourceIds,
    mirrorPreviewEntities,
    // Move / Copy exports
    moveStep,
    setMoveStep,
    moveSourceIds,
    setMoveSourceIds,
    moveBasePoint,
    movePreviewEntities,
    // Scale exports
    scaleStep,
    setScaleStep,
    scaleSourceIds,
    setScaleSourceIds,
    scaleBasePoint,
    scalePreviewEntities,
    currentScaleFactor,
    submitScaleFactor,
    // Rotate exports
    rotateStep,
    setRotateStep,
    rotateSourceIds,
    setRotateSourceIds,
    rotateBasePoint,
    rotatePreviewEntities,
    currentRotateAngleDeg,
    submitRotateAngle,
    // Circular Array exports
    arrayStep,
    setArrayStep,
    arraySourceIds,
    setArraySourceIds,
    arrayCenterPoint,
    arrayPreviewEntities,
    // Rectangular Array exports
    rectArraySourceIds,
    setRectArraySourceIds,
    rectArrayPreviewEntities,
    executeRectArray,
    // Polar Tracking exports
    polarTracking,
    polarExtensionIntersection,
    // OTrack exports
    otrackAnchors,
    otrackGuideLines,
    deferredTangent,
    submitExactLength,
    // Dimension text drag exports
    isDraggingDimText: !!draggingDimInfo,
    draggingDimId: draggingDimInfo?.dimId ?? null,
    startDragDimensionText,
    updateDragDimensionText,
    endDragDimensionText,
  };
}
