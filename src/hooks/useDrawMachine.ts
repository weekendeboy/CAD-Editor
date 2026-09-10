import { useState, useCallback, useEffect } from 'react';
import { useCADStore } from '../store/cadStore';
import { Point2D, LineEntity, CircleEntity, ArcEntity, SketchFeature, CADEntity2D } from '../types/cad';
import { DrawSession, createInitialDrawSession } from '../types/sketchInteraction';
import { findSnapPoint, SnapResult } from '../core/2d/SnapManager';
import { calculate3PointArc } from '../core/2d/GeometryMath';
import { isAngleOnArc, normalizeAngle, findAllIntersections } from '../core/2d/IntersectionEngine';

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

    // 區間 A: startAngle = theta0, endAngle = theta1
    // 區間 B: startAngle = theta1, endAngle = theta0

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
      // 點擊落在區間 A，預覽顯示即將刪除的區間 A
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
      // 點擊落在區間 B，預覽顯示即將刪除的區間 B
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
  const addEntity = useCADStore((state) => state.addEntity);
  const addConstraint = useCADStore((state) => state.addConstraint);
  const addDimension = useCADStore((state) => state.addDimension);
  const trimEntity = useCADStore((state) => state.trimEntity);
  const applyFillet = useCADStore((state) => state.applyFillet);

  const [drawSession, setDrawSession] = useState<DrawSession>(createInitialDrawSession());
  const [currentSnap, setCurrentSnap] = useState<SnapResult | null>(null);
  const [startSnap, setStartSnap] = useState<SnapResult | null>(null);
  const [trimPreviewEntity, setTrimPreviewEntity] = useState<CADEntity2D | null>(null);
  const [firstEntityId, setFirstEntityId] = useState<string | null>(null);
  const [lastEntityId, setLastEntityId] = useState<string | null>(null);
  const [snapCenter, setSnapCenter] = useState<SnapResult | null>(null);
  const [snapP1, setSnapP1] = useState<SnapResult | null>(null);
  const [snapP2, setSnapP2] = useState<SnapResult | null>(null);

  // Dimension tool state
  const [dimSnap1, setDimSnap1] = useState<SnapResult | null>(null);
  const [dimSnap2, setDimSnap2] = useState<SnapResult | null>(null);
  const [dimSelectedLineId, setDimSelectedLineId] = useState<string | null>(null);
  const [dimSelectedCircleOrArc, setDimSelectedCircleOrArc] = useState<CircleEntity | ArcEntity | null>(null);

  // Fillet state
  const [filletFirstLineId, setFilletFirstLineId] = useState<string | null>(null);
  const [filletRadius, setFilletRadius] = useState<number>(10);

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
    setFirstEntityId(null);
    setLastEntityId(null);
    setSnapCenter(null);
    setSnapP1(null);
    setSnapP2(null);
    setTrimPreviewEntity(null);
    setDimSnap1(null);
    setDimSnap2(null);
    setDimSelectedLineId(null);
    setDimSelectedCircleOrArc(null);
    setStartSnap(null);
    setFilletFirstLineId(null);
  }, []);

  // 當工具切換時，將 lastEntityId 與 firstEntityId 徹底重置，並取消繪圖操作
  useEffect(() => {
    cancelDrawing();
  }, [currentTool, cancelDrawing]);

  // 監聽 Escape 鍵，按下時自動調用 cancelDrawing() 清除暫態
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelDrawing();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [cancelDrawing]);

  const handlePointerMove = useCallback(
    (worldPt: Point2D, scale: number = 1.0) => {
      let snap: SnapResult | null = null;
      if (osnapEnabled) {
        snap = findSnapPoint(worldPt, currentEntities, scale);
      }
      setCurrentSnap(snap);

      const finalPt = snap ? snap.point : worldPt;

      setDrawSession((prev) => {
        if (!prev.isDrawing) return prev;

        let cursor = finalPt;
        let inferredConstraint: 'horizontal' | 'vertical' | null = null;

        if (currentTool === 'LINE' && prev.startPoint) {
          const dx = finalPt.x - prev.startPoint.x;
          const dy = finalPt.y - prev.startPoint.y;
          const thetaRad = Math.atan2(dy, dx);
          const thetaDeg = thetaRad * (180 / Math.PI);

          if (Math.abs(thetaDeg) < 2.5 || Math.abs(Math.abs(thetaDeg) - 180) < 2.5) {
            cursor = { x: finalPt.x, y: prev.startPoint.y };
            inferredConstraint = 'horizontal';
          } else if (Math.abs(Math.abs(thetaDeg) - 90) < 2.5) {
            cursor = { x: prev.startPoint.x, y: finalPt.y };
            inferredConstraint = 'vertical';
          }
        }

        return {
          ...prev,
          currentCursor: cursor,
          inferredConstraint,
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
      } else {
        setTrimPreviewEntity(null);
      }
    },
    [osnapEnabled, currentEntities, currentTool]
  );

  const handleCanvasClick = useCallback(
    (worldPt: Point2D, scale: number = 1.0) => {
      if (!activeSketchId) return;

      const clickPt = currentSnap ? currentSnap.point : worldPt;

      if (currentTool === 'LINE') {
        if (!drawSession.isDrawing) {
          setDrawSession({
            isDrawing: true,
            startPoint: clickPt,
            currentCursor: clickPt,
            step: 1,
          });
          setStartSnap(currentSnap);
        } else if (drawSession.startPoint) {
          let actualEndPt = clickPt;
          if (drawSession.inferredConstraint === 'horizontal') {
            actualEndPt = { x: clickPt.x, y: drawSession.startPoint.y };
          } else if (drawSession.inferredConstraint === 'vertical') {
            actualEndPt = { x: drawSession.startPoint.x, y: clickPt.y };
          }

          const dx = actualEndPt.x - drawSession.startPoint.x;
          const dy = actualEndPt.y - drawSession.startPoint.y;
          const distance = Math.hypot(dx, dy);

          if (distance > 0.5) {
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

            // 若存在 inferredConstraint，自動調用 addConstraint 注入對應的約束！
            if (drawSession.inferredConstraint) {
              addConstraint({
                id: crypto.randomUUID(),
                type: drawSession.inferredConstraint,
                entityIds: [newLine.id],
              });
            }

            // 檢查起點：若 startSnap 存在且其 entityId !== newLine.id，自動建立重合約束
            if (startSnap && startSnap.entityId !== newLine.id) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newLine.id, startSnap.entityId],
                pointIndices: [0, startSnap.pointIndex ?? 0],
              });
            }

            // 檢查終點：若當前點擊處的 currentSnap 存在且其 entityId !== newLine.id
            if (currentSnap && currentSnap.entityId !== newLine.id) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newLine.id, currentSnap.entityId],
                pointIndices: [1, currentSnap.pointIndex ?? 0],
              });
            }

            // 判斷是否命中第一條線段起點或兩點極近形成閉合
            const firstLine = currentEntities.find((e) => e.id === firstEntityId) as LineEntity | undefined;
            const isNearFirstStart =
              firstLine && firstLine.type === 'line'
                ? Math.hypot(actualEndPt.x - firstLine.start.x, actualEndPt.y - firstLine.start.y) < 0.5
                : false;

            const isClosing = Boolean(
              firstEntityId && (
                (currentSnap && currentSnap.entityId === firstEntityId) ||
                isNearFirstStart
              )
            );

            if (!lastEntityId) {
              // 第一段線段生成時：記錄 firstEntityId 與 lastEntityId
              setFirstEntityId(newLine.id);
              setLastEntityId(newLine.id);
            } else {
              // 連續繪製後續線段時：建立與上一段的重合約束 (lastEntityId 終點 index 1, newLine 起點 index 0)
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [lastEntityId, newLine.id],
                pointIndices: [1, 0],
              });
              setLastEntityId(newLine.id);
            }

            // 當閉合點擊時：建立首尾閉合約束 (newLine 終點 index 1, firstEntityId 起點 index 0) 並安全結束
            if (isClosing && firstEntityId) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newLine.id, firstEntityId],
                pointIndices: [1, 0],
              });
              cancelDrawing();
              return;
            }
          }

          // 連續畫線：將當前點作為下一次的起點
          setDrawSession({
            isDrawing: true,
            startPoint: actualEndPt,
            currentCursor: actualEndPt,
            step: 1,
            inferredConstraint: null,
          });
          setStartSnap(currentSnap);
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

          // 圓形畫完直接結束
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

            // 生成 4 條 LineEntity：頂、底、左、右邊
            // 頂邊 (Top Edge): (maxX, maxY) -> (minX, maxY)
            const topLine: LineEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'line',
              start: { x: maxX, y: maxY },
              end: { x: minX, y: maxY },
            };

            // 底邊 (Bottom Edge): (minX, minY) -> (maxX, minY)
            const bottomLine: LineEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'line',
              start: { x: minX, y: minY },
              end: { x: maxX, y: minY },
            };

            // 左邊 (Left Edge): (minX, maxY) -> (minX, minY)
            const leftLine: LineEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'line',
              start: { x: minX, y: maxY },
              end: { x: minX, y: minY },
            };

            // 右邊 (Right Edge): (maxX, minY) -> (maxX, maxY)
            const rightLine: LineEntity = {
              id: crypto.randomUUID(),
              layerId: 'layer-0',
              visible: true,
              locked: false,
              type: 'line',
              start: { x: maxX, y: minY },
              end: { x: maxX, y: maxY },
            };

            // 調用 addEntity 寫入草圖
            addEntity(bottomLine);
            addEntity(rightLine);
            addEntity(topLine);
            addEntity(leftLine);

            // 自動為相鄰頂點注入 4 個 coincident 重合約束（首尾相連封閉）
            // 1. 底邊終點 -> 右邊起點
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [bottomLine.id, rightLine.id],
              pointIndices: [1, 0],
            });
            // 2. 右邊終點 -> 頂邊起點
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [rightLine.id, topLine.id],
              pointIndices: [1, 0],
            });
            // 3. 頂邊終點 -> 左邊起點
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [topLine.id, leftLine.id],
              pointIndices: [1, 0],
            });
            // 4. 左邊終點 -> 底邊起點
            addConstraint({
              id: crypto.randomUUID(),
              type: 'coincident',
              entityIds: [leftLine.id, bottomLine.id],
              pointIndices: [1, 0],
            });

            // 自動注入 2 個 horizontal 約束（上下邊）
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

            // 自動注入 2 個 vertical 約束（左右邊）
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

          // 呼叫 cancelDrawing() 結束工作階段
          cancelDrawing();
        }
      } else if (currentTool === 'ARC_3P' || currentTool === 'ARC') {
        if (!drawSession.isDrawing || drawSession.step === 0) {
          // 第 1 點定起點
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
          // 第 2 點定終點
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
          // 第 3 點定弧上通過點，完成後產生 ArcEntity
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

            // 若起點或終點有鎖點吸附，自動注入 coincident 重合約束
            // 計算 newArc 的起點 (startAngle) 與終點 (endAngle) 座標
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

            if (snapP1) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newArc.id, snapP1.entityId],
                pointIndices: [p1Index, snapP1.pointIndex ?? 0],
              });
            }

            if (snapP2) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newArc.id, snapP2.entityId],
                pointIndices: [p2Index, snapP2.pointIndex ?? 0],
              });
            }
          }

          // 呼叫 cancelDrawing() 結束工作階段
          cancelDrawing();
        }
      } else if (currentTool === 'ARC_CENTER') {
        if (!drawSession.isDrawing || drawSession.step === 0) {
          // 點擊第 1 點：設定圓心 C
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
          // 點擊第 2 點：設定半徑與起始角度 P_start（R=dist(C,P_start)，startAngle=atan2(dy,dx)）
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
          // 點擊第 3 點：鎖定終止角度 endAngle，生成 ArcEntity 並寫入狀態
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

            // 若圓心有鎖點吸附，自動建立 coincident 約束 (pointIndex 2 為圓心)
            if (snapCenter) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newArc.id, snapCenter.entityId],
                pointIndices: [2, snapCenter.pointIndex ?? 0],
              });
            }

            // 若起點有鎖點吸附，自動建立 coincident 約束 (pointIndex 0 為起點)
            if (snapP1) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newArc.id, snapP1.entityId],
                pointIndices: [0, snapP1.pointIndex ?? 0],
              });
            }

            // 若終點有鎖點吸附，自動建立 coincident 約束 (pointIndex 1 為終點)
            if (currentSnap) {
              addConstraint({
                id: crypto.randomUUID(),
                type: 'coincident',
                entityIds: [newArc.id, currentSnap.entityId],
                pointIndices: [1, currentSnap.pointIndex ?? 0],
              });
            }
          }

          // 呼叫 cancelDrawing() 結束工作階段
          cancelDrawing();
        }
      } else if (currentTool === 'DIMENSION') {
        if (!drawSession.isDrawing || drawSession.step === 0) {
          // 第 1 次點擊：
          // 1. 檢查是否點擊在端點 (endpoint snap)
          if (currentSnap && currentSnap.type === 'endpoint') {
            setDimSnap1(currentSnap);
            setDrawSession({
              isDrawing: true,
              startPoint: currentSnap.point,
              currentCursor: clickPt,
              step: 1, // 進入步驟 1：等待點擊第二個端點
            });
          } else {
            // 2. 檢查是否點擊在單一圖元 (Line, Circle, Arc) 上
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
                  step: 2, // 進入引線放置階段
                });
              } else if (closestEntity.type === 'line') {
                setDimSelectedLineId(closestEntity.id);
                setDrawSession({
                  isDrawing: true,
                  startPoint: closestEntity.start,
                  secondPoint: closestEntity.end,
                  currentCursor: clickPt,
                  step: 2, // 直接進入步驟 2：等待游標移動並進行第三次點擊 (鎖定 textPosition)
                });
              }
            }
          }
        } else if (drawSession.step === 1 && drawSession.startPoint) {
          // 第二次點擊 (端點模式下)：
          if (currentSnap && currentSnap.type === 'endpoint') {
            setDimSnap2(currentSnap);
          } else {
            setDimSnap2(null);
          }
          setDrawSession((prev) => ({
            ...prev,
            secondPoint: clickPt,
            currentCursor: clickPt,
            step: 2, // 進入步驟 2：等待游標移動並進行第三次點擊 (鎖定 textPosition)
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
            // 第三次點擊 (單線模式下為第二次點擊)：
            // 鎖定 textPosition，正式建立 Dimension 物件與對應的驅動約束，並寫入 Zustand
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

            const newDimension = {
              id: dimensionId,
              type: 'linear' as const,
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
        }
      } else if (currentTool === 'TRIM') {
        if (trimPreviewEntity) {
          const hitEntityId = trimPreviewEntity.id.replace('trim-preview-', '');
          trimEntity(hitEntityId, clickPt);
        } else {
          // Fallback search
          let closestEntity: CADEntity2D | null = null;
          let minDistance = 5.0; // generous world units
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
          if (entity.type === 'line') {
            const dist = getDistanceToEntity(clickPt, entity);
            if (dist < minDistance) {
              minDistance = dist;
              closestEntity = entity;
            }
          }
        }

        if (closestEntity && closestEntity.type === 'line') {
          if (!filletFirstLineId) {
            setFilletFirstLineId(closestEntity.id);
            setDrawSession({
              isDrawing: true,
              startPoint: null,
              currentCursor: null,
              step: 1,
            });
          } else if (closestEntity.id !== filletFirstLineId) {
            applyFillet(filletFirstLineId, closestEntity.id, filletRadius);
            cancelDrawing();
          }
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
      dimSnap1,
      dimSnap2,
      dimSelectedLineId,
      dimSelectedCircleOrArc,
      addDimension,
      startSnap,
      applyFillet,
      filletFirstLineId,
      filletRadius,
    ]
  );

  return {
    drawSession,
    currentSnap,
    trimPreviewEntity,
    dimSelectedCircleOrArc,
    filletFirstLineId,
    filletRadius,
    setFilletRadius,
    handlePointerMove,
    handleCanvasClick,
    cancelDrawing,
  };
}

