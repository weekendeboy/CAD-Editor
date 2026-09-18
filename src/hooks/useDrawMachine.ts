import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useCADStore } from '../store/cadStore';
import { Point2D, LineEntity, CircleEntity, ArcEntity, PolylineEntity, SketchFeature, CADEntity2D, Constraint, ConstraintType } from '../types/cad';
import { DrawSession, createInitialDrawSession } from '../types/sketchInteraction';
import { findSnapPoint, SnapResult } from '../core/2d/SnapManager';
import { calculate3PointArc, calculatePolygonVertices, calculateTTRCircle, calculate3TCircle } from '../core/2d/GeometryMath';
import { isAngleOnArc, normalizeAngle, findAllIntersections } from '../core/2d/IntersectionEngine';
import { calculateExtend } from '../core/2d/ExtendManager';
import { calculateOffsetEntity, calculateOffsetChain } from '../core/2d/OffsetEngine';
import { calculateTangentArcSegment, getSegmentEndTangent } from '../core/2d/PolylineMath';
import { calculateMirror } from '../core/2d/MirrorEngine';
import { PolarTrackingResult, calculatePolarTracking, PolarExtensionIntersection, findPolarExtensionIntersection, getNormalizedPolarAngles } from '../core/2d/PolarTracking';
import { OTrackManager, TrackAnchor, TrackGuideLine } from '../core/2d/ObjectTracking';
import { determineLinearDimType } from '../core/2d/DimensionEngine';
import { getBestTangentPoint } from '../core/2d/TangentEngine';
import { arcToBulge, endpointsToBulge } from '../core/2d/BulgeMath';
import { getTrimPreviewSegment } from '../core/2d/TrimManager';

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
  endAngle: number,
  clockwise: boolean = false
): number {
  const thetaP = Math.atan2(p.y - center.y, p.x - center.x);
  if (isAngleOnArc(thetaP, startAngle, endAngle, clockwise)) {
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
    return getDistanceToArcSegment(p, entity.center, entity.radius, entity.startAngle, entity.endAngle, entity.clockwise);
  } else if (entity.type === 'circle') {
    const distToCenter = Math.hypot(p.x - entity.center.x, p.y - entity.center.y);
    return Math.abs(distToCenter - entity.radius);
  } else if (entity.type === 'polyline' && entity.points && entity.points.length >= 2) {
    let minDist = Infinity;
    const pts = entity.points;
    const count = entity.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % pts.length];
      const d = getDistanceToLineSegment(p, p1, p2);
      if (d < minDist) minDist = d;
    }
    return minDist;
  }
  return Infinity;
}

export function useDrawMachine() {
  const currentTool = useCADStore((state) => state.currentTool);
  const activeSketchId = useCADStore((state) => state.activeSketchId);
  const sketchSession = useCADStore((state) => state.sketchSession);
  const document = useCADStore((state) => state.document);
  const osnapEnabled = useCADStore((state) => state.osnapEnabled);
  const osnapSettings = useCADStore((state) => state.osnapSettings);
  const orthoEnabled = useCADStore((state) => state.orthoEnabled);
  const addEntity = useCADStore((state) => state.addEntity);
  const removeEntity = useCADStore((state) => state.removeEntity);
  const addConstraint = useCADStore((state) => state.addConstraint);
  const addDimension = useCADStore((state) => state.addDimension);
  const updateDimensionPosition = useCADStore((state) => state.updateDimensionPosition);
  const updateDimensionPositionLive = useCADStore((state) => state.updateDimensionPositionLive);
  const dragVertexStart = useCADStore((state) => state.dragVertexStart);
  const dragVertexLive = useCADStore((state) => state.dragVertexLive);
  const dragVertexCommit = useCADStore((state) => state.dragVertexCommit);
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
  const activeLayerId = useCADStore((state) => state.activeLayerId);
  const lastRadius = useCADStore((state) => state.lastRadius);
  const setLastRadius = useCADStore((state) => state.setLastRadius);
  const projectedEntities = useCADStore((state) => state.projectedEntities || []);

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

  // Drag vertex state
  const [dragVertexInfo, setDragVertexInfo] = useState<{
    entityId: string;
    pointIndex: number;
    startPos: Point2D;
  } | null>(null);

  const startDragVertex = useCallback((entityId: string, pointIndex: number, worldPt: Point2D) => {
    dragVertexStart();
    setDragVertexInfo({ entityId, pointIndex, startPos: worldPt });
  }, [dragVertexStart]);

  const updateDragVertex = useCallback((worldPt: Point2D) => {
    if (!dragVertexInfo) return;
    dragVertexLive(dragVertexInfo.entityId, dragVertexInfo.pointIndex, worldPt);
  }, [dragVertexInfo, dragVertexLive]);

  const endDragVertex = useCallback((worldPt?: Point2D) => {
    if (!dragVertexInfo) return;
    if (worldPt && (worldPt.x !== dragVertexInfo.startPos.x || worldPt.y !== dragVertexInfo.startPos.y)) {
       dragVertexCommit();
    } else {
       // If didn't move, just revert by calling undo? Or if dragVertexCommit just doesn't push undo state?
       // Actually, if it didn't move, we could just commit it, since it's the same.
       dragVertexCommit();
    }
    setDragVertexInfo(null);
  }, [dragVertexInfo, dragVertexCommit]);

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
  const [filletFirstPickPoint, setFilletFirstPickPoint] = useState<Point2D | null>(null);
  const [filletRadius, setFilletRadius] = useState<number>(10);

  // Chamfer state
  const [chamferFirstEntityId, setChamferFirstEntityId] = useState<string | null>(null);
  const [chamferFirstPickPoint, setChamferFirstPickPoint] = useState<Point2D | null>(null);
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
  const [mirrorStep, setMirrorStep] = useState<'PICK_SOURCE' | 'PICK_P1' | 'PICK_P2'>('PICK_SOURCE');
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

  // TTR Circle (相切、相切、半徑) state
  const [ttrFirstEntityId, setTtrFirstEntityId] = useState<string | null>(null);
  const [ttrFirstPickPoint, setTtrFirstPickPoint] = useState<Point2D | null>(null);
  const [ttrSecondEntityId, setTtrSecondEntityId] = useState<string | null>(null);
  const [ttrSecondPickPoint, setTtrSecondPickPoint] = useState<Point2D | null>(null);
  const [ttrRadius, setTtrRadius] = useState<number>(25);
  const [ttrStep, setTtrStep] = useState<'PICK_ENT1' | 'PICK_ENT2' | 'SPECIFY_RADIUS'>('PICK_ENT1');
  const [ttrPreviewCircle, setTtrPreviewCircle] = useState<CircleEntity | null>(null);
  const [ttrError, setTtrError] = useState<string | null>(null);

  // 3T Circle (三相切) state
  const [circle3TFirstEntityId, setCircle3TFirstEntityId] = useState<string | null>(null);
  const [circle3TFirstPickPoint, setCircle3TFirstPickPoint] = useState<Point2D | null>(null);
  const [circle3TSecondEntityId, setCircle3TSecondEntityId] = useState<string | null>(null);
  const [circle3TSecondPickPoint, setCircle3TSecondPickPoint] = useState<Point2D | null>(null);
  const [circle3TThirdEntityId, setCircle3TThirdEntityId] = useState<string | null>(null);
  const [circle3TThirdPickPoint, setCircle3TThirdPickPoint] = useState<Point2D | null>(null);
  const [circle3TStep, setCircle3TStep] = useState<'PICK_ENT1' | 'PICK_ENT2' | 'PICK_ENT3'>('PICK_ENT1');
  const [circle3TPreviewCircle, setCircle3TPreviewCircle] = useState<CircleEntity | null>(null);
  const [circle3TError, setCircle3TError] = useState<string | null>(null);

  // Polyline internal states
  const [polylineMode, setPolylineMode] = useState<'LINE' | 'ARC'>('LINE');
  const [polySegments, setPolySegments] = useState<Array<{ entityId: string; endPt: Point2D; type: 'line' | 'arc'; bulge?: number }>>([]);
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

  const storeClearOtrackAnchors = useCADStore((state) => state.clearOtrackAnchors);

  const clearOtrackAnchors = useCallback(() => {
    otrackManagerRef.current?.reset();
    setOtrackAnchors([]);
    setOtrackGuideLines([]);
    if (typeof storeClearOtrackAnchors === 'function') {
      storeClearOtrackAnchors();
    }
  }, [storeClearOtrackAnchors]);

  // AutoCAD 提示詞 / HUD 提示（記憶上一次半徑，例如 Radius <${lastRadius}>:）
  const hudPrompt = useMemo(() => {
    if (currentTool === 'CIRCLE' && drawSession.isDrawing && drawSession.startPoint) {
      return `Radius <${lastRadius}>:`;
    }
    if (
      (currentTool === 'ARC' || currentTool === 'ARC_CENTER' || currentTool === 'ARC_3P') &&
      drawSession.isDrawing &&
      drawSession.startPoint
    ) {
      return `Radius <${lastRadius}>:`;
    }
    if (currentTool === 'CIRCLE_TTR' && ttrStep === 'SPECIFY_RADIUS') {
      return `Radius <${lastRadius}>:`;
    }
    return null;
  }, [currentTool, drawSession.isDrawing, drawSession.startPoint, ttrStep, lastRadius]);

  // 當 CIRCLE 或 ARC 工具進入動態輸入 (HUD / DDE) 階段時，在 HUD / 命令列提示中加入預設值顯示（例如 Radius <${lastRadius}>:）
  useEffect(() => {
    if (!hudPrompt || typeof window === 'undefined') return;

    // 尋找繪圖 HUD 輸入框與狀態列元素，動態注入 AutoCAD 風格提示
    const hudInputs = window.document.querySelectorAll<HTMLInputElement>('input');
    hudInputs.forEach((input) => {
      if (
        input.className.includes('text-emerald-400') ||
        input.className.includes('font-mono') ||
        input.closest('.z-50')
      ) {
        input.placeholder = `<${lastRadius}>`;
        input.setAttribute('data-hud-prompt', hudPrompt);
        input.title = hudPrompt;
      }
    });

    const statusEl = window.document.querySelector('[data-command-line]');
    if (statusEl) {
      statusEl.textContent = hudPrompt;
    }
  }, [hudPrompt, lastRadius]);

  // 取得目前草圖內的 entities 與 constraints
  let currentEntities: CADEntity2D[] = [];
  let currentConstraints: Constraint[] = [];
  if (sketchSession.isActive && sketchSession.sketchId === activeSketchId) {
    currentEntities = sketchSession.draftEntities;
    currentConstraints = sketchSession.draftConstraints;
  } else if (activeSketchId) {
    const sketch = document.featureTree.find(
      (f) => f.id === activeSketchId && f.type === 'SKETCH'
    ) as SketchFeature | undefined;
    if (sketch) {
      currentEntities = sketch.entities;
      currentConstraints = sketch.constraints;
    }
  }

  // 包含草圖圖元與 3D 實體背景投影邊線（用於端點/中點鎖點與追蹤）
  const allSnappableEntities = useMemo(() => {
    return [...currentEntities, ...projectedEntities];
  }, [currentEntities, projectedEntities]);

  // 檢查是否為草圖內部真實存在的圖元（虛擬投影邊線不加入草圖內部幾何約束）
  const isRealSketchEntity = useCallback(
    (id?: string | null): boolean => {
      if (!id) return false;
      if (id.startsWith('virtual_') || id.startsWith('proj_ref_') || id === 'origin') return false;
      return currentEntities.some((e) => e.id === id);
    },
    [currentEntities]
  );

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
    setDragVertexInfo(null);
    setStartSnap(null);
    setFilletFirstEntityId(null);
    setFilletFirstPickPoint(null);
    setChamferFirstEntityId(null);
    setChamferFirstPickPoint(null);
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

    // Reset TTR circle states
    setTtrFirstEntityId(null);
    setTtrFirstPickPoint(null);
    setTtrSecondEntityId(null);
    setTtrSecondPickPoint(null);
    setTtrRadius(25);
    setTtrStep('PICK_ENT1');
    setTtrPreviewCircle(null);
    setTtrError(null);

    // Reset 3T circle states
    setCircle3TFirstEntityId(null);
    setCircle3TFirstPickPoint(null);
    setCircle3TSecondEntityId(null);
    setCircle3TSecondPickPoint(null);
    setCircle3TThirdEntityId(null);
    setCircle3TThirdPickPoint(null);
    setCircle3TStep('PICK_ENT1');
    setCircle3TPreviewCircle(null);
    setCircle3TError(null);

    // Reset polar tracking
    setPolarTracking(null);
    setPolarExtensionIntersection(null);

    // Reset OTrack states
    clearOtrackAnchors();
  }, [clearOtrackAnchors]);

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

  const finishPolyline = useCallback(
    (
      closed: boolean = false,
      overrideSegments?: Array<{ entityId: string; endPt: Point2D; type: 'line' | 'arc'; bulge?: number }>
    ) => {
      const segments = overrideSegments || drawSession.polySegments || polySegments;
      if (!segments || segments.length === 0) {
        cancelDrawing();
        return;
      }

      // 取得第 0 個段落對應的實體以找到起點
      const firstSeg = segments[0];
      const firstEntity = currentEntities.find((e) => e.id === firstSeg.entityId);
      let p0: Point2D | null = null;
      if (firstEntity) {
        if (firstEntity.type === 'line') {
          p0 = firstEntity.start;
        } else if (firstEntity.type === 'arc') {
          p0 = {
            x: firstEntity.center.x + firstEntity.radius * Math.cos(firstEntity.startAngle),
            y: firstEntity.center.y + firstEntity.radius * Math.sin(firstEntity.startAngle),
          };
        }
      }
      if (!p0) {
        p0 = drawSession.startPoint || segments[0].endPt;
      }

      // 收集頂點 points 陣列
      const points: Point2D[] = [p0];
      const lastSeg = segments[segments.length - 1];
      const lastEndIsStart = Math.hypot(lastSeg.endPt.x - p0.x, lastSeg.endPt.y - p0.y) < 1e-3;

      if (closed && lastEndIsStart && segments.length > 1) {
        // 已有繪製回起點的最後一個段落，只需收集到倒數第二個端點
        for (let i = 0; i < segments.length - 1; i++) {
          points.push(segments[i].endPt);
        }
      } else {
        // 一般開放多段線，或按下快速鍵 C 閉合（最後一個端點為新頂點）
        for (let i = 0; i < segments.length; i++) {
          points.push(segments[i].endPt);
        }
      }

      // 初始化 bulges 陣列 = new Array(points.length).fill(0)
      const bulges = new Array(points.length).fill(0);

      // 遍歷 segments 填入對應的凸度值
      segments.forEach((seg, index) => {
        if (index < bulges.length) {
          if (seg.bulge !== undefined) {
            bulges[index] = seg.bulge;
          } else if (seg.type === 'arc') {
            const arcEntity = currentEntities.find((e) => e.id === seg.entityId) as ArcEntity | undefined;
            if (arcEntity && arcEntity.type === 'arc') {
              let bulgeVal = arcToBulge(arcEntity);
              const pStart = index === 0 ? p0! : points[index];
              const arcStart = {
                x: arcEntity.center.x + arcEntity.radius * Math.cos(arcEntity.startAngle),
                y: arcEntity.center.y + arcEntity.radius * Math.sin(arcEntity.startAngle),
              };
              if (Math.hypot(pStart.x - arcStart.x, pStart.y - arcStart.y) > 1e-3) {
                bulgeVal = -bulgeVal;
              }
              bulges[index] = bulgeVal;
            }
          }
        }
      });

      // 將 bulges 寫入 PolylineEntity
      const polylineEntity: PolylineEntity = {
        id: crypto.randomUUID(),
        layerId: activeLayerId || '0',
        visible: true,
        locked: false,
        type: 'polyline',
        points,
        bulges,
        closed,
      };

      // 移除單一個案段落實體，將 PolylineEntity 寫入 Store
      segments.forEach((seg) => {
        removeEntity(seg.entityId);
      });

      addEntity(polylineEntity);
      cancelDrawing();
    },
    [drawSession, polySegments, currentEntities, removeEntity, addEntity, cancelDrawing, activeLayerId]
  );

  // 當工具切換時，將狀態徹底重置，並特別為鏡射工具初始化選取
  useEffect(() => {
    cancelDrawing();
    if (currentTool === 'MIRROR') {
      const initialSelection = useCADStore.getState().selectedEntityIds;
      if (initialSelection && initialSelection.length > 0) {
        setMirrorSourceIds(initialSelection);
        setMirrorStep('PICK_P1');
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

  // 監聽鍵盤按鍵：Escape 清除暫態，M 切換 POLYLINE 模式，Enter 確認鏡射、移動複製或縮放/旋轉/陣列來源選取或套用預設半徑
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      // 攔截鍵盤 Enter 事件：若在輸入框中且為圓形/圓弧工具且輸入為空或 0，套用 lastRadius
      if (isInput) {
        if (
          e.key === 'Enter' &&
          (currentTool === 'CIRCLE' ||
            currentTool === 'ARC' ||
            currentTool === 'ARC_CENTER' ||
            currentTool === 'ARC_3P' ||
            currentTool === 'CIRCLE_TTR') &&
          drawSession.isDrawing &&
          drawSession.startPoint
        ) {
          const inputEl = target as HTMLInputElement;
          const val = inputEl.value ? inputEl.value.trim() : '';
          const cleanVal = val.replace(/[^0-9.-]/g, '');
          const num = parseFloat(cleanVal);
          if (!val || val === '0' || isNaN(num) || num <= 0) {
            e.preventDefault();
            e.stopPropagation();
            const r = useCADStore.getState().lastRadius || 10;
            submitExactLength(r);
            inputEl.blur();
            return;
          }
        }
        return;
      }

      if (e.key === 'Escape') {
        cancelDrawing();
      } else if (e.key === 'Enter' && currentTool === 'CIRCLE' && drawSession.isDrawing && drawSession.startPoint) {
        // 直接按下 Enter 套用 lastRadius
        e.preventDefault();
        e.stopPropagation();
        const r = useCADStore.getState().lastRadius || 10;
        const newCircle: CircleEntity = {
          id: crypto.randomUUID(),
          layerId: activeLayerId || '0',
          visible: true,
          locked: false,
          type: 'circle',
          center: drawSession.startPoint,
          radius: r,
        };
        addEntity(newCircle);
        setLastRadius(r);
        cancelDrawing();
        return;
      } else if (
        e.key === 'Enter' &&
        (currentTool === 'ARC' || currentTool === 'ARC_CENTER' || currentTool === 'ARC_3P') &&
        drawSession.isDrawing &&
        drawSession.startPoint
      ) {
        // 直接按下 Enter 套用 lastRadius
        e.preventDefault();
        e.stopPropagation();
        const r = useCADStore.getState().lastRadius || 10;
        const center = drawSession.startPoint;
        let startAngle = 0;
        let endAngle = Math.PI;
        if (drawSession.secondPoint) {
          startAngle = Math.atan2(drawSession.secondPoint.y - center.y, drawSession.secondPoint.x - center.x);
          const cur = drawSession.currentCursor || drawSession.secondPoint;
          endAngle = Math.atan2(cur.y - center.y, cur.x - center.x);
          if (Math.abs(endAngle - startAngle) < 1e-4) {
            endAngle = startAngle + Math.PI / 2;
          }
        } else if (drawSession.currentCursor) {
          const dx = drawSession.currentCursor.x - center.x;
          const dy = drawSession.currentCursor.y - center.y;
          if (Math.hypot(dx, dy) > 1e-4) {
            startAngle = Math.atan2(dy, dx);
            endAngle = startAngle + Math.PI / 2;
          }
        }
        const newArc: ArcEntity = {
          id: crypto.randomUUID(),
          layerId: activeLayerId || '0',
          visible: true,
          locked: false,
          type: 'arc',
          center,
          radius: r,
          startAngle,
          endAngle,
          clockwise: Boolean(drawSession.arcClockwise),
        };
        addEntity(newArc);
        setLastRadius(r);
        cancelDrawing();
        return;
      } else if (e.key === 'Enter' && currentTool === 'CIRCLE_TTR' && ttrStep === 'SPECIFY_RADIUS') {
        e.preventDefault();
        e.stopPropagation();
        const r = useCADStore.getState().lastRadius || 10;
        if (ttrFirstEntityId && ttrSecondEntityId && ttrFirstPickPoint && ttrSecondPickPoint) {
          const ent1 = currentEntities.find((e) => e.id === ttrFirstEntityId);
          const ent2 = currentEntities.find((e) => e.id === ttrSecondEntityId);
          if (ent1 && ent2) {
            const circle = calculateTTRCircle(ent1, ent2, r, ttrFirstPickPoint, ttrSecondPickPoint);
            if (circle) {
              circle.layerId = activeLayerId || '0';
              addEntity(circle);
              setLastRadius(r);
              addConstraint({
                id: crypto.randomUUID(),
                type: 'tangent',
                entityIds: [circle.id, ent1.id],
              });
              addConstraint({
                id: crypto.randomUUID(),
                type: 'tangent',
                entityIds: [circle.id, ent2.id],
              });
              cancelDrawing();
              return;
            }
          }
        }
      } else if ((e.key === 'm' || e.key === 'M') && currentTool === 'POLYLINE') {
        togglePolylineMode();
      } else if (e.key === 'Enter' && currentTool === 'POLYLINE') {
        finishPolyline(false);
      } else if ((e.key === 'c' || e.key === 'C') && currentTool === 'POLYLINE' && drawSession.isDrawing) {
        if ((drawSession.polySegments?.length || polySegments.length) >= 2) {
          finishPolyline(true);
        }
      } else if (e.key === 'Enter' && currentTool === 'MIRROR') {
        if (mirrorStep === 'PICK_SOURCE' && mirrorSourceIds.length > 0) {
          setMirrorStep('PICK_P1');
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

    window.addEventListener('keydown', handleKeyDown, true);

    const handlePolylineKeypress = (e: Event) => {
      const customEvent = e as CustomEvent<{ key: string }>;
      if (customEvent.detail && (customEvent.detail.key === 'enter' || customEvent.detail.key === 'return')) {
        finishPolyline(false);
      }
    };
    window.addEventListener('cad-polyline-keypress', handlePolylineKeypress);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('cad-polyline-keypress', handlePolylineKeypress);
    };
  }, [
    cancelDrawing,
    togglePolylineMode,
    finishPolyline,
    currentTool,
    drawSession,
    activeLayerId,
    addEntity,
    setLastRadius,
    ttrStep,
    ttrFirstEntityId,
    ttrSecondEntityId,
    ttrFirstPickPoint,
    ttrSecondPickPoint,
    currentEntities,
    addConstraint,
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
      } else if (customEvent.detail.key === 'c') {
        if (polySegments.length >= 2) {
          finishPolyline(true);
          customEvent.preventDefault();
        }
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
      // 1. 獨立計算 OSnap 實體鎖點（支援草圖圖元與 3D 投影邊線/端點）
      const osnapResult = osnapEnabled
        ? findSnapPoint(
            worldPt,
            allSnappableEntities,
            scale,
            15,
            drawSession.startPoint || undefined,
            osnapSettings
          )
        : null;

      // 2. 獨立計算 OTrack / 極軸追蹤 / 延伸線交點 / 正交 / 自動推導
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
          allSnappableEntities,
          otrackManagerRef.current?.anchors || [],
          polarAngleStep,
          customPolarAngles,
          scale,
          28
        );
      }

      let otrackPt: Point2D | null = null;
      let otrackGuideLines: TrackGuideLine[] = [];
      let otrackPolar: PolarTrackingResult | null = null;
      let otrackSnap: SnapResult | null = null;

      if (otrackManagerRef.current) {
        const targetPolarAngles = polarTrackingEnabled
          ? getNormalizedPolarAngles(polarAngleStep, customPolarAngles)
          : undefined;
        const trackingRes = otrackManagerRef.current.evaluateTracking(
          worldPt,
          15 / scale,
          targetPolarAngles,
          drawSession.isDrawing && drawSession.startPoint ? drawSession.startPoint : undefined,
          allSnappableEntities
        );
        if (trackingRes.guideLines.length > 0) {
          otrackPt = trackingRes.point;
          otrackGuideLines = trackingRes.guideLines;
          if (trackingRes.snapType === 'intersection' || trackingRes.isIntersection) {
            otrackSnap = {
              point: trackingRes.point,
              type: 'intersection',
              entityId: trackingRes.entityId || 'otrack-intersection',
            };
          }
          if (drawSession.isDrawing && drawSession.startPoint) {
            const baseGuideline = otrackGuideLines.find(
              (gl) =>
                Math.abs(gl.anchor.x - drawSession.startPoint!.x) < 1e-4 &&
                Math.abs(gl.anchor.y - drawSession.startPoint!.y) < 1e-4
            );
            if (baseGuideline) {
              const rad = (baseGuideline.angleDeg * Math.PI) / 180;
              otrackPolar = {
                snappedPoint: trackingRes.point,
                rayStart: drawSession.startPoint,
                rayEnd: {
                  x: drawSession.startPoint.x + 50000 * Math.cos(rad),
                  y: drawSession.startPoint.y + 50000 * Math.sin(rad),
                },
                angleDeg: baseGuideline.angleDeg,
              };
            }
          }
        }
      }

      let orthoPt: Point2D | null = null;
      let orthoInferred: 'horizontal' | 'vertical' | null = null;
      if (orthoEnabled && drawSession.isDrawing && drawSession.startPoint) {
        const dx = worldPt.x - drawSession.startPoint.x;
        const dy = worldPt.y - drawSession.startPoint.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
          orthoPt = { x: worldPt.x, y: drawSession.startPoint.y };
          orthoInferred = 'horizontal';
        } else {
          orthoPt = { x: drawSession.startPoint.x, y: worldPt.y };
          orthoInferred = 'vertical';
        }
      }

      let activePolar: PolarTrackingResult | null = null;
      if (drawSession.isDrawing && drawSession.startPoint && polarTrackingEnabled && !orthoEnabled) {
        activePolar = calculatePolarTracking(
          drawSession.startPoint,
          worldPt,
          polarAngleStep,
          customPolarAngles
        );
      }

      let autoInferredPt: Point2D | null = null;
      let autoInferredConstraint: 'horizontal' | 'vertical' | null = null;
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
          autoInferredPt = { x: worldPt.x, y: drawSession.startPoint.y };
          autoInferredConstraint = 'horizontal';
        } else if (Math.abs(Math.abs(thetaDeg) - 90) < 2.5) {
          autoInferredPt = { x: drawSession.startPoint.x, y: worldPt.y };
          autoInferredConstraint = 'vertical';
        }
      }

      // 組合追蹤邏輯結果 (優先順序: activePolarExt > otrackGuideLines > orthoPt > activePolar > autoInferredPt)
      let trackPoint: Point2D | null = null;
      let trackGuideLines: TrackGuideLine[] = [];
      let trackPolar: PolarTrackingResult | null = null;
      let trackPolarExt: PolarExtensionIntersection | null = null;
      let trackInferredConstraint: 'horizontal' | 'vertical' | null = null;
      let trackSnap: SnapResult | null = null;

      if (activePolarExt) {
        trackPoint = activePolarExt.point;
        trackPolarExt = activePolarExt;
        trackPolar = {
          snappedPoint: activePolarExt.point,
          rayStart: drawSession.startPoint!,
          rayEnd: {
            x: drawSession.startPoint!.x + 50000 * Math.cos((activePolarExt.polarAngleDeg * Math.PI) / 180),
            y: drawSession.startPoint!.y + 50000 * Math.sin((activePolarExt.polarAngleDeg * Math.PI) / 180),
          },
          angleDeg: activePolarExt.polarAngleDeg,
        };
        trackSnap = {
          point: activePolarExt.point,
          type: 'intersection',
          entityId: activePolarExt.entityId,
        };
      } else if (otrackGuideLines.length > 0 && otrackPt) {
        trackPoint = otrackPt;
        trackGuideLines = otrackGuideLines;
        trackPolar = otrackPolar;
        trackSnap = otrackSnap;
      } else if (orthoPt) {
        trackPoint = orthoPt;
        trackInferredConstraint = orthoInferred;
      } else if (activePolar) {
        trackPoint = activePolar.snappedPoint;
        trackPolar = activePolar;
      } else if (autoInferredPt) {
        trackPoint = autoInferredPt;
        trackInferredConstraint = autoInferredConstraint;
      }

      // 3. 雙棲共存 Pipeline 決策機制 (Coexistence Pipeline)
      let finalPoint = worldPt;
      let finalSnap: SnapResult | null = null;
      let finalGuideLines: TrackGuideLine[] = [];
      let finalPolar: PolarTrackingResult | null = null;
      let finalPolarExt: PolarExtensionIntersection | null = null;
      let finalInferredConstraint: 'horizontal' | 'vertical' | null = null;

      const worldThreshold = 25 / scale;

      if (osnapResult && trackPoint) {
        const dist = Math.hypot(osnapResult.point.x - trackPoint.x, osnapResult.point.y - trackPoint.y);
        if (dist < worldThreshold) {
          // 距離極近：端點落在追蹤線上/點上！雙棲共存：
          // 以 osnapResult 為主（保留實體座標與 entityId 以利建立重合約束），「同時保留」追蹤導引線與極軸狀態供畫面渲染
          finalPoint = osnapResult.point;
          finalSnap = osnapResult;
          finalGuideLines = trackGuideLines;
          finalPolar = trackPolar;
          finalPolarExt = trackPolarExt;
          finalInferredConstraint = trackInferredConstraint;
        } else {
          // 距離較遠：實體鎖點磁吸力優先
          finalPoint = osnapResult.point;
          finalSnap = osnapResult;
          finalGuideLines = [];
          finalPolar = null;
          finalPolarExt = null;
          finalInferredConstraint = null;
        }
      } else if (osnapResult) {
        // 只有 OSnap 實體鎖點
        finalPoint = osnapResult.point;
        finalSnap = osnapResult;
        finalGuideLines = [];
        finalPolar = null;
        finalPolarExt = null;
        finalInferredConstraint = null;
      } else if (trackPoint) {
        // 只有 虛擬追蹤/極軸
        finalPoint = trackPoint;
        finalSnap = trackSnap;
        finalGuideLines = trackGuideLines;
        finalPolar = trackPolar;
        finalPolarExt = trackPolarExt;
        finalInferredConstraint = trackInferredConstraint;
      } else {
        finalPoint = worldPt;
        finalSnap = null;
        finalGuideLines = [];
        finalPolar = null;
        finalPolarExt = null;
        finalInferredConstraint = null;
      }

      // 多段線首點閉合鎖定
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
          const distToStart = Math.hypot(finalPoint.x - polyStartPt.x, finalPoint.y - polyStartPt.y);
          if (distToStart < snapDist) {
            finalPoint = polyStartPt;
          }
        }
      }

      return {
        point: finalPoint,
        snap: finalSnap,
        inferredConstraint: finalInferredConstraint,
        polarTracking: finalPolar,
        otrackGuideLines: finalGuideLines,
        polarExtensionIntersection: finalPolarExt,
      };
    },
    [
      osnapEnabled,
      osnapSettings,
      allSnappableEntities,
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
      
      if (dragVertexInfo) {
        updateDragVertex(res.point);
        // Also update snapping states so the UI shows the snap marker
        setCurrentSnap(res.snap);
        setOtrackGuideLines(res.otrackGuideLines);
        setPolarTracking(res.polarTracking);
        setPolarExtensionIntersection(res.polarExtensionIntersection || null);
        return;
      }

      setCurrentSnap(res.snap);
      setOtrackGuideLines(res.otrackGuideLines);
      setPolarTracking(res.polarTracking);
      setPolarExtensionIntersection(res.polarExtensionIntersection || null);

      setDrawSession((prev) => {
        if (!prev.isDrawing) {
          return {
            ...prev,
            currentCursor: res.point,
          };
        }
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
        let arcClockwise = prev.arcClockwise;
        let accumulatedAngle = prev.accumulatedAngle;
        let lastCursorAngle = prev.lastCursorAngle;

        if (currentTool === 'ARC_CENTER' && prev.step === 2 && prev.startPoint && prev.secondPoint) {
          const C = prev.startPoint;
          const currAngle = Math.atan2(res.point.y - C.y, res.point.x - C.x);
          const lastA = lastCursorAngle !== undefined ? lastCursorAngle : Math.atan2(prev.secondPoint.y - C.y, prev.secondPoint.x - C.x);
          let delta = currAngle - lastA;
          while (delta > Math.PI) delta -= 2 * Math.PI;
          while (delta <= -Math.PI) delta += 2 * Math.PI;
          if (Math.abs(delta) > 1e-4) {
            accumulatedAngle = (accumulatedAngle ?? 0) + delta;
            lastCursorAngle = currAngle;
            arcClockwise = accumulatedAngle < 0;
          }
        }

        return {
          ...prev,
          startPoint: updatedStartPoint,
          currentCursor: res.point,
          inferredConstraint: res.inferredConstraint,
          arcClockwise,
          accumulatedAngle,
          lastCursorAngle,
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
              previewEntity: extendResult.extendedEntity,
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
            const preview = calculateOffsetChain(
              targetEntity,
              {
                distance: offsetDistance,
                sidePoint: worldPt,
              },
              currentEntities,
              currentConstraints
            );
            setOffsetPreviewEntity(preview && preview.entities.length > 0 ? preview.entities[0] : null);
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
        if (mirrorStep === 'PICK_P2' && drawSession.isDrawing && drawSession.startPoint && mirrorSourceIds.length > 0) {
          const p1 = drawSession.startPoint;
          const p2 = res.point;
          const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          if (dist > 1e-4) {
            const sources = currentEntities.filter((e) => mirrorSourceIds.includes(e.id));
            const result = calculateMirror(sources, p1, p2);
            const previewEntities = result
              ? result.mirroredEntities.map((ent) => {
                  if (ent.type === 'polyline') {
                    return {
                      ...ent,
                      bulges: ent.bulges ? ent.bulges.map((b) => -b) : undefined,
                    } as PolylineEntity;
                  }
                  return ent;
                })
              : null;
            setMirrorPreviewEntities(previewEntities);
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
                bulges: e.bulges ? [...e.bulges] : undefined,
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
                bulges: e.bulges ? e.bulges.map((b) => (factor < 0 ? -b : b)) : undefined,
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
                bulges: e.bulges ? [...e.bulges] : undefined,
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

      // CIRCLE_TTR 即時動態切圓預覽
      if (currentTool === 'CIRCLE_TTR') {
        if (ttrStep === 'SPECIFY_RADIUS' && ttrFirstEntityId && ttrSecondEntityId && ttrFirstPickPoint && ttrSecondPickPoint) {
          const refPt = ttrSecondPickPoint;
          const liveRadius = Math.max(0.1, Math.hypot(res.point.x - refPt.x, res.point.y - refPt.y));
          const ent1 = currentEntities.find((e) => e.id === ttrFirstEntityId);
          const ent2 = currentEntities.find((e) => e.id === ttrSecondEntityId);
          if (ent1 && ent2) {
            const preview = calculateTTRCircle(ent1, ent2, liveRadius, ttrFirstPickPoint, ttrSecondPickPoint);
            setTtrPreviewCircle(preview);
          }
        } else {
          setTtrPreviewCircle(null);
        }
      } else if (currentTool === 'CIRCLE_3T') {
        // CIRCLE_3T 即時動態切圓預覽
        if (circle3TStep === 'PICK_ENT3' && circle3TFirstEntityId && circle3TSecondEntityId && circle3TFirstPickPoint && circle3TSecondPickPoint) {
          const threshold = 30 / scale;
          let hoveredEnt: CADEntity2D | null = null;
          let minD = threshold;
          for (const entity of currentEntities) {
            if (entity.type === 'line' || entity.type === 'arc' || entity.type === 'circle' || entity.type === 'polyline') {
              const dist = getDistanceToEntity(res.point, entity);
              if (dist < minD) {
                minD = dist;
                hoveredEnt = entity;
              }
            }
          }
          if (hoveredEnt) {
            const ent1 = currentEntities.find((e) => e.id === circle3TFirstEntityId);
            const ent2 = currentEntities.find((e) => e.id === circle3TSecondEntityId);
            if (ent1 && ent2) {
              const preview = calculate3TCircle(ent1, ent2, hoveredEnt, circle3TFirstPickPoint, circle3TSecondPickPoint, res.point);
              setCircle3TPreviewCircle(preview);
            }
          } else {
            setCircle3TPreviewCircle(null);
          }
        } else {
          setCircle3TPreviewCircle(null);
        }
      } else {
        setTtrPreviewCircle(null);
        setCircle3TPreviewCircle(null);
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
      ttrStep,
      ttrFirstEntityId,
      ttrSecondEntityId,
      ttrFirstPickPoint,
      ttrSecondPickPoint,
      circle3TStep,
      circle3TFirstEntityId,
      circle3TSecondEntityId,
      circle3TFirstPickPoint,
      circle3TSecondPickPoint,
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
            layerId: activeLayerId || '0',
            visible: true,
            locked: false,
            type: 'line',
            start: drawSession.startPoint,
            end: actualEndPt,
          };

          addEntity(newLine);

          if (lastEntityId) {
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [lastEntityId, newLine.id],
              pointIndices: [1, 0],
            });
          }
          setLastEntityId(newLine.id);

          if (deferredTangent) {
            addConstraint({
              id: crypto.randomUUID(),
              type: 'tangent',
              entityIds: [newLine.id, deferredTangent.entityId],
              pointIndices: [0],
            });
            setDeferredTangent(null);
          }

          if (startSnap && startSnap.entityId !== newLine.id && isRealSketchEntity(startSnap.entityId) && (startSnap.type === 'endpoint' || startSnap.type === 'center') && startSnap.pointIndex !== undefined) {
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [newLine.id, startSnap.entityId],
              pointIndices: [0, startSnap.pointIndex],
            });
          }

          if (res.snap && res.snap.entityId !== newLine.id && isRealSketchEntity(res.snap.entityId) && (res.snap.type === 'endpoint' || res.snap.type === 'center') && res.snap.pointIndex !== undefined) {
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

          const closeTolerance = Math.max(0.5, 15 / (scale || 1));
          const isNearFirstStart =
            polyStartPt
              ? Math.hypot(clickPt.x - polyStartPt.x, clickPt.y - polyStartPt.y) <= closeTolerance
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

          // 計算當前段落的凸度 b = tan(theta / 4)
          let calculatedBulge = 0;
          if (polylineMode === 'ARC' && arcData) {
            calculatedBulge = endpointsToBulge(
              drawSession.startPoint,
              actualEndPt,
              arcData.center,
              !arcData.isStartPointMatchingPStart
            );
          }

          let newEntityId = '';
          let newSegs: Array<{ entityId: string; endPt: Point2D; type: 'line' | 'arc'; bulge?: number }> = [];

          if (polylineMode === 'ARC' && arcData) {
            const newArc: ArcEntity = {
              id: crypto.randomUUID(),
              layerId: activeLayerId || '0',
              visible: true,
              locked: false,
              type: 'arc',
              center: arcData.center,
              radius: arcData.radius,
              startAngle: arcData.startAngle,
              endAngle: arcData.endAngle,
              clockwise: arcData.clockwise,
            };
            addEntity(newArc);
            setLastRadius(arcData.radius);
            newEntityId = newArc.id;

            const newTangent = getSegmentEndTangent(newArc, arcData.isStartPointMatchingPStart);
            setLastTangentDir(newTangent);
            newSegs = [
              ...polySegments,
              { entityId: newArc.id, endPt: actualEndPt, type: 'arc', bulge: calculatedBulge },
            ];
            setPolySegments(newSegs);
          } else {
            // Default to LINE
            const newLine: LineEntity = {
              id: crypto.randomUUID(),
              layerId: activeLayerId || '0',
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
            newSegs = [
              ...polySegments,
              { entityId: newLine.id, endPt: actualEndPt, type: 'line', bulge: 0 },
            ];
            setPolySegments(newSegs);

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

            if (startSnap && startSnap.entityId !== newEntityId && isRealSketchEntity(startSnap.entityId) && (startSnap.type === 'endpoint' || startSnap.type === 'center') && startSnap.pointIndex !== undefined) {
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

          if (res.snap && res.snap.entityId !== newEntityId && !isClosing && isRealSketchEntity(res.snap.entityId) && (res.snap.type === 'endpoint' || res.snap.type === 'center') && res.snap.pointIndex !== undefined) {
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
            finishPolyline(true, newSegs);
            return;
          }

          setDrawSession({
            isDrawing: true,
            startPoint: actualEndPt,
            currentCursor: actualEndPt,
            step: 1,
            inferredConstraint: null,
            polySegments: newSegs,
            bulges: newSegs.map((s) => s.bulge),
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
              layerId: activeLayerId || '0',
              visible: true,
              locked: false,
              type: 'circle',
              center: drawSession.startPoint,
              radius: radius,
            };
            addEntity(newCircle);
            setLastRadius(radius);
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
              layerId: activeLayerId || '0',
              visible: true,
              locked: false,
              type: 'line',
              start: { x: maxX, y: maxY },
              end: { x: minX, y: maxY },
            };

            const bottomLine: LineEntity = {
              id: crypto.randomUUID(),
              layerId: activeLayerId || '0',
              visible: true,
              locked: false,
              type: 'line',
              start: { x: minX, y: minY },
              end: { x: maxX, y: minY },
            };

            const leftLine: LineEntity = {
              id: crypto.randomUUID(),
              layerId: activeLayerId || '0',
              visible: true,
              locked: false,
              type: 'line',
              start: { x: minX, y: maxY },
              end: { x: minX, y: minY },
            };

            const rightLine: LineEntity = {
              id: crypto.randomUUID(),
              layerId: activeLayerId || '0',
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

          if (dist > 0.01 && vertices.length >= 3) {
            const n = vertices.length;
            const lines: LineEntity[] = [];

            // 1. 根據頂點陣列，生成 n 條獨立的 LineEntity，確保最後一條直線連接回第一條直線起點
            for (let i = 0; i < n; i++) {
              const startPt = vertices[i];
              const endPt = vertices[(i + 1) % n];
              const line: LineEntity = {
                id: crypto.randomUUID(),
                layerId: activeLayerId || '0',
                visible: true,
                locked: false,
                type: 'line',
                start: { ...startPt },
                end: { ...endPt },
              };
              lines.push(line);
              addEntity(line);
            }

            // 2. 自動注入相鄰端點重合約束 (Coincident): Line[i] 終點 (index 1) 與 Line[(i+1)%n] 起點 (index 0)
            for (let i = 0; i < n; i++) {
              const nextIdx = (i + 1) % n;
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [lines[i].id, lines[nextIdx].id],
                pointIndices: [1, 0],
              });
            }

            // 3. 建立等長約束 (Equal Length)，綁定所有邊長維持正多邊形特性
            for (let i = 0; i < n - 1; i++) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'equal_length',
                entityIds: [lines[i].id, lines[i + 1].id],
              });
            }
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
              layerId: activeLayerId || '0',
              visible: true,
              locked: false,
              type: 'arc',
              center: arcData.center,
              radius: arcData.radius,
              startAngle: arcData.startAngle,
              endAngle: arcData.endAngle,
              clockwise: arcData.clockwise,
            };

            addEntity(newArc);
            setLastRadius(arcData.radius);

            // Standardized Arc Point Indices: 0: Center, 1: Start (p1), 2: End (p2)
            const p1Index = 1;
            const p2Index = 2;

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
            const initAngle = Math.atan2(clickPt.y - C.y, clickPt.x - C.x);
            setDrawSession((prev) => ({
              ...prev,
              secondPoint: clickPt,
              currentCursor: clickPt,
              step: 2,
              arcClockwise: false,
              accumulatedAngle: 0,
              lastCursorAngle: initAngle,
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
            const isClockwise = Boolean(drawSession.arcClockwise);

            const newArc: ArcEntity = {
              id: crypto.randomUUID(),
              layerId: activeLayerId || '0',
              visible: true,
              locked: false,
              type: 'arc',
              center: C,
              radius: radius,
              startAngle: startAngle,
              endAngle: endAngle,
              clockwise: isClockwise,
            };

            addEntity(newArc);
            setLastRadius(radius);

            if (snapCenter) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newArc.id, snapCenter.entityId],
                pointIndices: [0, snapCenter.pointIndex ?? 0],
              });
            }

            if (snapP1) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newArc.id, snapP1.entityId],
                pointIndices: [1, snapP1.pointIndex ?? 0],
              });
            }

            if (currentSnap) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newArc.id, currentSnap.entityId],
                pointIndices: [2, currentSnap.pointIndex ?? 0],
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

            for (const entity of allSnappableEntities) {
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
              entityIds: [dimTarget.id],
            };
            const newConstraint = {
              id: constraintId,
              type: 'radius' as const,
              entityIds: [dimTarget.id],
              value: dimTarget.radius,
              targetVal: dimTarget.radius,
            };
            addDimension(newDimension, newConstraint);
            cancelDrawing();
          } else {
            if (dimSelectedLineId) {
              const threshold = 15 / scale;
              let closestEntity: CADEntity2D | null = null;
              let minDistance = threshold;
              for (const entity of allSnappableEntities) {
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
            
            let constraintType: ConstraintType = 'distance';
            if (dimType === 'horizontal') constraintType = 'distance_x';
            else if (dimType === 'vertical') constraintType = 'distance_y';

            const newDimension = {
              id: dimensionId,
              type: 'linear' as const,
              dimType: dimType,
              points: [p1, p2],
              textPosition: textPosition,
              constraintId: constraintId,
              entityIds: entityIds,
              pointIndices: dimSnap1 && dimSnap2 ? [dimSnap1.pointIndex ?? 0, dimSnap2.pointIndex ?? 0] : undefined,
            };

            let newConstraint;
            let cValue = physicalLen;
            if (constraintType === 'distance_x') cValue = Math.abs(p2.x - p1.x);
            else if (constraintType === 'distance_y') cValue = Math.abs(p2.y - p1.y);

            if (dimSelectedLineId) {
              newConstraint = {
                id: constraintId,
                type: constraintType === 'distance' ? 'length' : constraintType,
                entityIds: [dimSelectedLineId],
                value: cValue,
                targetVal: cValue,
              };
            } else if (dimSnap1 && dimSnap2) {
              newConstraint = {
                id: constraintId,
                type: constraintType,
                entityIds: [dimSnap1.entityId, dimSnap2.entityId],
                pointIndices: [dimSnap1.pointIndex ?? 0, dimSnap2.pointIndex ?? 0],
                value: cValue,
                targetVal: cValue,
              };
            } else {
              newConstraint = {
                id: constraintId,
                type: constraintType,
                entityIds: [],
                value: cValue,
                targetVal: cValue,
              };
            }

            addDimension(newDimension, newConstraint);
            cancelDrawing();
          }
        } else if (drawSession.step === 3 && dimSelectedLineId && dimSelectedLineId2) {
          const line1 = allSnappableEntities.find((e) => e.id === dimSelectedLineId) as LineEntity;
          const line2 = allSnappableEntities.find((e) => e.id === dimSelectedLineId2) as LineEntity;

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

            const d1x = line1.end.x - line1.start.x;
            const d1y = line1.end.y - line1.start.y;
            const d2x = line2.end.x - line2.start.x;
            const d2y = line2.end.y - line2.start.y;
            const dot = d1x * d2x + d1y * d2y;
            const len1 = Math.hypot(d1x, d1y);
            const len2 = Math.hypot(d2x, d2y);
            let angle = 0;
            if (len1 > 1e-6 && len2 > 1e-6) {
              const cosA = Math.max(-1, Math.min(1, dot / (len1 * len2)));
              angle = (Math.acos(cosA) * 180) / Math.PI;
            }

            const newConstraint = {
              id: constraintId,
              type: 'angle' as const,
              entityIds: [line1.id, line2.id],
              value: angle,
              targetVal: angle,
            };

            addDimension(newDimension, newConstraint);
          }
          cancelDrawing();
        }
      } else if (currentTool === 'TRIM') {
        if (trimPreviewEntity) {
          const hitEntityId = trimPreviewEntity.id.replace('trim-preview-', '');
          trimEntity(hitEntityId, worldPt);
        } else {
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
            trimEntity(closestEntity.id, worldPt);
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
            setFilletFirstPickPoint(clickPt);
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
              if (isFirstLineOrArc && isSecondLineOrArc) {
                applyFillet(filletFirstEntityId, closestEntity.id, filletFirstPickPoint || clickPt, clickPt, filletRadius);
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
            setChamferFirstPickPoint(clickPt);
            setDrawSession({
              isDrawing: true,
              startPoint: null,
              currentCursor: null,
              step: 1,
            });
          } else if (closestEntity.id !== chamferFirstEntityId) {
            const firstEnt = currentEntities.find((e) => e.id === chamferFirstEntityId);
            if (firstEnt && firstEnt.type === 'line') {
              applyChamfer(chamferFirstEntityId, closestEntity.id, chamferFirstPickPoint || clickPt, clickPt, chamferDistance);
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
            if (
              entity.type === 'line' ||
              entity.type === 'arc' ||
              entity.type === 'circle' ||
              entity.type === 'polyline'
            ) {
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
          offsetEntity(offsetTargetId, offsetDistance, clickPt);
          setOffsetTargetId(null);
          setOffsetPreviewEntity(null);
          cancelDrawing();
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
        } else if (mirrorStep === 'PICK_P1') {
          if (mirrorSourceIds.length > 0) {
            setMirrorStep('PICK_P2');
            setDrawSession({
              isDrawing: true,
              startPoint: clickPt,
              currentCursor: clickPt,
              step: 1,
              inferredConstraint: null,
            });
            setStartSnap(res.snap);
          }
        } else if (mirrorStep === 'PICK_P2') {
          const p1 = drawSession.startPoint;
          const p2 = clickPt;
          const dist = p1 ? Math.hypot(p2.x - p1.x, p2.y - p1.y) : 0;
          if (p1 && dist > 1e-4 && mirrorSourceIds.length > 0) {
            mirrorEntities(mirrorSourceIds, p1, p2);
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
      } else if (currentTool === 'CIRCLE_TTR') {
        const threshold = 20 / scale;
        let closestEntity: CADEntity2D | null = null;
        let minDistance = threshold;

        for (const entity of currentEntities) {
          if (entity.type === 'line' || entity.type === 'arc' || entity.type === 'circle' || entity.type === 'polyline') {
            const dist = getDistanceToEntity(clickPt, entity);
            if (dist < minDistance) {
              minDistance = dist;
              closestEntity = entity;
            }
          }
        }

        if (ttrStep === 'PICK_ENT1') {
          if (closestEntity) {
            setTtrFirstEntityId(closestEntity.id);
            setTtrFirstPickPoint(clickPt);
            setTtrStep('PICK_ENT2');
            setTtrError(null);
            setDrawSession({
              isDrawing: true,
              startPoint: clickPt,
              currentCursor: clickPt,
              step: 1,
            });
          }
        } else if (ttrStep === 'PICK_ENT2') {
          if (closestEntity) {
            setTtrSecondEntityId(closestEntity.id);
            setTtrSecondPickPoint(clickPt);
            setTtrStep('SPECIFY_RADIUS');
            setTtrError(null);
            setDrawSession({
              isDrawing: true,
              startPoint: clickPt,
              currentCursor: clickPt,
              step: 2,
            });
          }
        } else if (ttrStep === 'SPECIFY_RADIUS') {
          const refPt = ttrSecondPickPoint || ttrFirstPickPoint || clickPt;
          const userRadius = Math.hypot(clickPt.x - refPt.x, clickPt.y - refPt.y);
          const effectiveRadius = userRadius > 0.5 ? userRadius : ttrRadius;

          if (ttrFirstEntityId && ttrSecondEntityId && ttrFirstPickPoint && ttrSecondPickPoint) {
            const ent1 = currentEntities.find((e) => e.id === ttrFirstEntityId);
            const ent2 = currentEntities.find((e) => e.id === ttrSecondEntityId);
            if (ent1 && ent2) {
              const circle = calculateTTRCircle(ent1, ent2, effectiveRadius, ttrFirstPickPoint, ttrSecondPickPoint);
              if (circle) {
                circle.layerId = activeLayerId || '0';
                addEntity(circle);
                setLastRadius(effectiveRadius);
                addConstraint({
                  id: crypto.randomUUID(),
                  type: 'tangent',
                  entityIds: [circle.id, ent1.id],
                });
                addConstraint({
                  id: crypto.randomUUID(),
                  type: 'tangent',
                  entityIds: [circle.id, ent2.id],
                });
                cancelDrawing();
                return;
              } else {
                setTtrError('無法在此半徑下計算出相切圓，請調整半徑或點選位置');
              }
            }
          }
        }
      } else if (currentTool === 'CIRCLE_3T') {
        const threshold = 20 / scale;
        let closestEntity: CADEntity2D | null = null;
        let minDistance = threshold;

        for (const entity of currentEntities) {
          if (entity.type === 'line' || entity.type === 'arc' || entity.type === 'circle' || entity.type === 'polyline') {
            const dist = getDistanceToEntity(clickPt, entity);
            if (dist < minDistance) {
              minDistance = dist;
              closestEntity = entity;
            }
          }
        }

        if (circle3TStep === 'PICK_ENT1') {
          if (closestEntity) {
            setCircle3TFirstEntityId(closestEntity.id);
            setCircle3TFirstPickPoint(clickPt);
            setCircle3TStep('PICK_ENT2');
            setCircle3TError(null);
            setDrawSession({
              isDrawing: true,
              startPoint: clickPt,
              currentCursor: clickPt,
              step: 1,
            });
          }
        } else if (circle3TStep === 'PICK_ENT2') {
          if (closestEntity) {
            setCircle3TSecondEntityId(closestEntity.id);
            setCircle3TSecondPickPoint(clickPt);
            setCircle3TStep('PICK_ENT3');
            setCircle3TError(null);
            setDrawSession({
              isDrawing: true,
              startPoint: clickPt,
              currentCursor: clickPt,
              step: 2,
            });
          }
        } else if (circle3TStep === 'PICK_ENT3') {
          if (closestEntity) {
            const ent3 = closestEntity;
            const pickPt3 = clickPt;
            setCircle3TThirdEntityId(ent3.id);
            setCircle3TThirdPickPoint(pickPt3);

            if (circle3TFirstEntityId && circle3TSecondEntityId && circle3TFirstPickPoint && circle3TSecondPickPoint) {
              const ent1 = currentEntities.find((e) => e.id === circle3TFirstEntityId);
              const ent2 = currentEntities.find((e) => e.id === circle3TSecondEntityId);
              if (ent1 && ent2) {
                const circle = calculate3TCircle(
                  ent1,
                  ent2,
                  ent3,
                  circle3TFirstPickPoint,
                  circle3TSecondPickPoint,
                  pickPt3
                );
                if (circle) {
                  circle.layerId = activeLayerId || '0';
                  addEntity(circle);
                  setLastRadius(circle.radius);
                  addConstraint({
                    id: crypto.randomUUID(),
                    type: 'tangent',
                    entityIds: [circle.id, ent1.id],
                  });
                  addConstraint({
                    id: crypto.randomUUID(),
                    type: 'tangent',
                    entityIds: [circle.id, ent2.id],
                  });
                  addConstraint({
                    id: crypto.randomUUID(),
                    type: 'tangent',
                    entityIds: [circle.id, ent3.id],
                  });
                  cancelDrawing();
                  return;
                } else {
                  setCircle3TError('無法在此三個實體間計算出相切圓，請調整選取物件或點選位置');
                }
              }
            }
          }
        }
      }

      // 每次落筆點擊後清空 OTrack 追蹤錨點與延伸輔助線
      clearOtrackAnchors();
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
      clearOtrackAnchors,
      circle3TStep,
      circle3TFirstEntityId,
      circle3TSecondEntityId,
      circle3TFirstPickPoint,
      circle3TSecondPickPoint,
    ]
  );

  const submitExactLength = useCallback(
    (length?: number): boolean => {
      if (!activeSketchId) return false;
      if (!drawSession.isDrawing || !drawSession.startPoint) {
        if (
          currentTool === 'LINE' ||
          currentTool === 'POLYLINE' ||
          currentTool === 'CIRCLE' ||
          currentTool === 'RECTANGLE' ||
          currentTool === 'POLYGON' ||
          currentTool === 'ARC_3P' ||
          currentTool === 'ARC' ||
          currentTool === 'ARC_CENTER'
        ) {
          let anchor: Point2D | null = null;
          let angleRad: number | null = null;

          if (otrackGuideLines && otrackGuideLines.length > 0) {
            const guide = otrackGuideLines[0];
            anchor = guide.anchor;
            angleRad = (guide.angleDeg * Math.PI) / 180;
          } else if (polarTracking) {
            anchor = polarTracking.rayStart;
            angleRad = (polarTracking.angleDeg * Math.PI) / 180;
          }

          if (anchor && angleRad !== null && length !== undefined && length > 0) {
            const newStartPoint: Point2D = {
              x: anchor.x + length * Math.cos(angleRad),
              y: anchor.y + length * Math.sin(angleRad),
            };

            if (currentTool === 'POLYLINE') {
              setPolySegments([]);
              setLastTangentDir(null);
              setPolylineWarning(null);
              setFirstEntityId(null);
              setLastEntityId(null);
            }
            if (currentTool === 'ARC_3P' || currentTool === 'ARC') {
              setSnapP1(null);
              setSnapP2(null);
            }
            if (currentTool === 'ARC_CENTER') {
              setSnapCenter(null);
              setSnapP1(null);
              setSnapP2(null);
            }

            setStartSnap(null);
            setDrawSession({
              isDrawing: true,
              startPoint: newStartPoint,
              secondPoint: null,
              currentCursor: newStartPoint,
              step: 1,
              inferredConstraint: null,
            });

            clearOtrackAnchors();
            return true;
          }
        }
        return false;
      }
      if (
        currentTool !== 'LINE' &&
        currentTool !== 'POLYLINE' &&
        currentTool !== 'CIRCLE' &&
        currentTool !== 'CIRCLE_TTR' &&
        currentTool !== 'ARC' &&
        currentTool !== 'ARC_CENTER' &&
        currentTool !== 'ARC_3P' &&
        currentTool !== 'POLYGON' &&
        currentTool !== 'MOVE' &&
        currentTool !== 'COPY' &&
        currentTool !== 'SCALE' &&
        currentTool !== 'ROTATE'
      ) {
        return false;
      }

      if (currentTool === 'CIRCLE_TTR') {
        const radiusToUse =
          length !== undefined && !isNaN(length) && length > 0
            ? length
            : (useCADStore.getState().lastRadius || 10);
        if (ttrFirstEntityId && ttrSecondEntityId && ttrFirstPickPoint && ttrSecondPickPoint) {
          const ent1 = currentEntities.find((e) => e.id === ttrFirstEntityId);
          const ent2 = currentEntities.find((e) => e.id === ttrSecondEntityId);
          if (ent1 && ent2) {
            const circle = calculateTTRCircle(ent1, ent2, radiusToUse, ttrFirstPickPoint, ttrSecondPickPoint);
            if (circle) {
              circle.layerId = activeLayerId || '0';
              addEntity(circle);
              setLastRadius(radiusToUse);
              addConstraint({
                id: crypto.randomUUID(),
                type: 'tangent',
                entityIds: [circle.id, ent1.id],
              });
              addConstraint({
                id: crypto.randomUUID(),
                type: 'tangent',
                entityIds: [circle.id, ent2.id],
              });
              cancelDrawing();
              return true;
            } else {
              setTtrError(`無法以半徑 ${radiusToUse} 繪製相切圓`);
              return false;
            }
          }
        }
        return false;
      }

      if (currentTool === 'ROTATE') {
        if (rotateStep === 'PICK_ANGLE' && rotateBasePoint && rotateSourceIds.length > 0 && length !== undefined) {
          const angleRad = (length * Math.PI) / 180;
          rotateEntities(rotateSourceIds, rotateBasePoint, angleRad);
          cancelDrawing();
          return true;
        }
        return false;
      }

      if (currentTool === 'SCALE') {
        if (scaleStep === 'PICK_FACTOR' && scaleBasePoint && scaleSourceIds.length > 0 && length !== undefined && length > 0) {
          scaleEntities(scaleSourceIds, scaleBasePoint, length);
          cancelDrawing();
          return true;
        }
        return false;
      }

      if (currentTool === 'CIRCLE') {
        const radiusToUse =
          length !== undefined && !isNaN(length) && length > 0
            ? length
            : (useCADStore.getState().lastRadius || 10);
        const newCircle: CircleEntity = {
          id: crypto.randomUUID(),
          layerId: activeLayerId || '0',
          visible: true,
          locked: false,
          type: 'circle',
          center: drawSession.startPoint,
          radius: radiusToUse,
        };
        addEntity(newCircle);
        setLastRadius(radiusToUse);
        cancelDrawing();
        return true;
      }

      if (currentTool === 'ARC' || currentTool === 'ARC_CENTER' || currentTool === 'ARC_3P') {
        const radiusToUse =
          length !== undefined && !isNaN(length) && length > 0
            ? length
            : (useCADStore.getState().lastRadius || 10);
        const center = drawSession.startPoint;
        let startAngle = 0;
        let endAngle = Math.PI;
        if (drawSession.secondPoint) {
          startAngle = Math.atan2(drawSession.secondPoint.y - center.y, drawSession.secondPoint.x - center.x);
          const cur = drawSession.currentCursor || drawSession.secondPoint;
          endAngle = Math.atan2(cur.y - center.y, cur.x - center.x);
          if (Math.abs(endAngle - startAngle) < 1e-4) {
            endAngle = startAngle + Math.PI / 2;
          }
        } else if (drawSession.currentCursor) {
          const dx = drawSession.currentCursor.x - center.x;
          const dy = drawSession.currentCursor.y - center.y;
          if (Math.hypot(dx, dy) > 1e-4) {
            startAngle = Math.atan2(dy, dx);
            endAngle = startAngle + Math.PI / 2;
          }
        }
        const newArc: ArcEntity = {
          id: crypto.randomUUID(),
          layerId: activeLayerId || '0',
          visible: true,
          locked: false,
          type: 'arc',
          center,
          radius: radiusToUse,
          startAngle,
          endAngle,
          clockwise: Boolean(drawSession.arcClockwise),
        };
        addEntity(newArc);
        setLastRadius(radiusToUse);
        cancelDrawing();
        return true;
      }

      if (length === undefined || length <= 0) return false;

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

        if (vertices.length >= 3) {
          const n = vertices.length;
          const lines: LineEntity[] = [];

          // 1. 根據頂點陣列，生成 n 條獨立的 LineEntity，確保最後一條直線連接回第一條直線起點
          for (let i = 0; i < n; i++) {
            const startPt = vertices[i];
            const endPt = vertices[(i + 1) % n];
            const line: LineEntity = {
              id: crypto.randomUUID(),
              layerId: activeLayerId || '0',
              visible: true,
              locked: false,
              type: 'line',
              start: { ...startPt },
              end: { ...endPt },
            };
            lines.push(line);
            addEntity(line);
          }

          // 2. 自動注入相鄰端點重合約束 (Coincident): Line[i] 終點 (index 1) 與 Line[(i+1)%n] 起點 (index 0)
          for (let i = 0; i < n; i++) {
            const nextIdx = (i + 1) % n;
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [lines[i].id, lines[nextIdx].id],
              pointIndices: [1, 0],
            });
          }

          // 3. 建立等長約束 (Equal Length)，綁定所有邊長維持正多邊形特性
          for (let i = 0; i < n - 1; i++) {
            addConstraint({
              id: crypto.randomUUID(),
              type: 'equal_length',
              entityIds: [lines[i].id, lines[i + 1].id],
            });
          }
        }

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
          layerId: activeLayerId || '0',
          visible: true,
          locked: false,
          type: 'line',
          start: startPoint,
          end: exactEndPt,
        };

        addEntity(newLine);

        if (lastEntityId) {
          addConstraint({
            id: crypto.randomUUID(),
            type: 'coincident',
            entityIds: [lastEntityId, newLine.id],
            pointIndices: [1, 0],
          });
        }
        setLastEntityId(newLine.id);

        if (startSnap && startSnap.entityId !== newLine.id && isRealSketchEntity(startSnap.entityId) && (startSnap.type === 'endpoint' || startSnap.type === 'center') && startSnap.pointIndex !== undefined) {
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
          layerId: activeLayerId || '0',
          visible: true,
          locked: false,
          type: 'line',
          start: startPoint,
          end: exactEndPt,
        };
        addEntity(newLine);

        const newTangent = getSegmentEndTangent(newLine);
        setLastTangentDir(newTangent);
        const newSegs = [...polySegments, { entityId: newLine.id, endPt: exactEndPt, type: 'line' as const }];
        setPolySegments(newSegs);
        setDrawSession((prev) => ({
          ...prev,
          isDrawing: true,
          startPoint: exactEndPt,
          currentCursor: exactEndPt,
          step: 1,
          inferredConstraint: null,
          polySegments: newSegs,
        }));

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

          if (startSnap && startSnap.entityId !== newEntityId && isRealSketchEntity(startSnap.entityId) && (startSnap.type === 'endpoint' || startSnap.type === 'center') && startSnap.pointIndex !== undefined) {
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

      clearOtrackAnchors();
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
      clearOtrackAnchors,
      otrackGuideLines,
      setLastRadius,
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
    filletFirstPickPoint,
    filletRadius,
    setFilletRadius,
    chamferFirstEntityId,
    chamferFirstPickPoint,
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
    // TTR Circle exports
    ttrStep,
    setTtrStep,
    ttrFirstEntityId,
    ttrFirstPickPoint,
    ttrSecondEntityId,
    ttrSecondPickPoint,
    ttrRadius,
    setTtrRadius,
    ttrPreviewCircle,
    ttrError,
    // 3T Circle exports
    circle3TStep,
    setCircle3TStep,
    circle3TFirstEntityId,
    circle3TFirstPickPoint,
    circle3TSecondEntityId,
    circle3TSecondPickPoint,
    circle3TThirdEntityId,
    circle3TThirdPickPoint,
    circle3TPreviewCircle,
    circle3TError,
    // Polar Tracking exports
    polarTracking,
    polarExtensionIntersection,
    // OTrack exports
    clearOtrackAnchors,
    otrackAnchors,
    otrackGuideLines,
    deferredTangent,
    submitExactLength,
    // AutoCAD 記憶半徑與 HUD 提示
    lastRadius,
    setLastRadius,
    hudPrompt,
    commandPrompt: hudPrompt,
    radiusPrompt: hudPrompt,
    // Dimension text drag exports
    isDraggingDimText: !!draggingDimInfo,
    draggingDimId: draggingDimInfo?.dimId ?? null,
    startDragDimensionText,
    updateDragDimensionText,
    endDragDimensionText,
    // Drag vertex exports
    isDraggingVertex: !!dragVertexInfo,
    startDragVertex,
    endDragVertex,
  };
}
