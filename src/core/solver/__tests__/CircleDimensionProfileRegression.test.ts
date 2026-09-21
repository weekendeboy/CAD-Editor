import { describe, it, expect, beforeEach } from 'vitest';
import { CircleEntity, Constraint, SketchDimension, SketchFeature, DatumFrontPlane } from '../../../types/cad';
import { applyConstraintsToSketch } from '../../../store/sketchMutators';
import { useCADStore } from '../../../store/cadStore';

describe('CircleDimensionProfileRegression Tests', () => {
  beforeEach(() => {
    useCADStore.setState((state) => ({
      ...state,
      activeSketchId: null,
      sketchSession: {
        isActive: false,
        sketchId: null,
        draftEntities: [],
        draftConstraints: [],
        draftDimensions: [],
        draftProfiles: [],
        isDirty: false,
        undoStack: [],
        redoStack: [],
        workPlane: DatumFrontPlane,
      },
      document: {
        ...state.document,
        featureTree: [],
      },
      selectedEntityIds: [],
    }));
  });

  it('Core Logic: applyConstraintsToSketch should update both circle entity radius and profile geometry', () => {
    const c1: CircleEntity = {
      id: 'circle-1',
      type: 'circle',
      layerId: '0',
      visible: true,
      locked: false,
      center: { x: 0, y: 0 },
      radius: 50,
    };

    const con1: Constraint = {
      id: 'con-r50',
      type: 'radius',
      entityIds: ['circle-1'],
      value: 50,
      targetVal: 50,
    };

    const sketch: SketchFeature = {
      id: 'sketch-1',
      name: 'Sketch 1',
      type: 'SKETCH',
      plane: DatumFrontPlane,
      dependencies: [],
      suppressed: false,
      entities: [c1],
      constraints: [con1],
      dimensions: [],
      profiles: [],
      solverState: 'UnderDefined',
    };

    applyConstraintsToSketch(sketch);

    expect(sketch.entities[0].type).toBe('circle');
    expect((sketch.entities[0] as CircleEntity).radius).toBeCloseTo(50, 5);
    expect(sketch.profiles.length).toBe(1);
    expect(sketch.profiles[0].segments?.[0]?.radius).toBeCloseTo(50, 5);
    expect(sketch.profiles[0].area).toBeCloseTo(Math.PI * 50 * 50, 2);

    // Modify constraint: 50 -> 100
    sketch.constraints = [
      {
        ...con1,
        value: 100,
        targetVal: 100,
      },
    ];

    applyConstraintsToSketch(sketch);

    const updatedCircle = sketch.entities[0] as CircleEntity;
    expect(updatedCircle.radius).toBeCloseTo(100, 5);
    expect(sketch.profiles.length).toBe(1);
    const updatedProfile = sketch.profiles[0];
    expect(updatedProfile.segments?.[0]?.radius).toBeCloseTo(100, 5);
    expect(updatedProfile.segments?.[1]?.radius).toBeCloseTo(100, 5);
    expect(updatedProfile.area).toBeCloseTo(Math.PI * 100 * 100, 2);
  });

  it('Session Integration Test: updateDimensionValue updates draftProfiles in active sketch session', () => {
    const c1: CircleEntity = {
      id: 'circle-session-1',
      type: 'circle',
      layerId: '0',
      visible: true,
      locked: false,
      center: { x: 0, y: 0 },
      radius: 50,
    };

    const dim1: SketchDimension = {
      id: 'dim-r50',
      type: 'radial',
      isDiameter: false,
      entityIds: ['circle-session-1'],
      value: 50,
      text: 'R50',
      points: [{ x: 0, y: 0 }, { x: 50, y: 0 }],
      textPosition: { x: 25, y: 20 },
    };

    const initialSketch: SketchFeature = {
      id: 'sketch-session-test',
      name: 'Sketch Session',
      type: 'SKETCH',
      plane: DatumFrontPlane,
      dependencies: [],
      suppressed: false,
      entities: [c1],
      constraints: [],
      dimensions: [dim1],
      profiles: [],
      solverState: 'UnderDefined',
    };

    applyConstraintsToSketch(initialSketch);

    useCADStore.setState((state) => ({
      ...state,
      activeSketchId: 'sketch-session-test',
      sketchSession: {
        isActive: true,
        sketchId: 'sketch-session-test',
        draftEntities: initialSketch.entities,
        draftConstraints: initialSketch.constraints,
        draftDimensions: [dim1],
        draftProfiles: initialSketch.profiles,
        isDirty: false,
        undoStack: [],
        redoStack: [],
        workPlane: DatumFrontPlane,
      },
    }));

    // Verify initial state
    const initialSession = useCADStore.getState().sketchSession;
    expect((initialSession.draftEntities[0] as CircleEntity).radius).toBeCloseTo(50, 5);
    expect(initialSession.draftProfiles[0].segments?.[0]?.radius).toBeCloseTo(50, 5);

    // Test 1: Modify 50 -> 100
    useCADStore.getState().updateDimensionValue('dim-r50', 100);

    const sessionAfter100 = useCADStore.getState().sketchSession;
    const circleAfter100 = sessionAfter100.draftEntities[0] as CircleEntity;
    expect(circleAfter100.radius).toBeCloseTo(100, 5);
    expect(sessionAfter100.draftProfiles.length).toBe(1);
    expect(sessionAfter100.draftProfiles[0].segments?.[0]?.radius).toBeCloseTo(100, 5);
    expect(sessionAfter100.draftProfiles[0].segments?.[1]?.radius).toBeCloseTo(100, 5);
    expect(sessionAfter100.draftProfiles[0].area).toBeCloseTo(Math.PI * 100 * 100, 2);

    // Consistency check: EntityRenderer radius === ProfileRenderer profile radius
    expect(circleAfter100.radius).toBeCloseTo(sessionAfter100.draftProfiles[0].segments![0].radius!, 5);

    // Test 2: Modify 100 -> 30
    useCADStore.getState().updateDimensionValue('dim-r50', 30);

    const sessionAfter30 = useCADStore.getState().sketchSession;
    const circleAfter30 = sessionAfter30.draftEntities[0] as CircleEntity;
    expect(circleAfter30.radius).toBeCloseTo(30, 5);
    expect(sessionAfter30.draftProfiles[0].segments?.[0]?.radius).toBeCloseTo(30, 5);
    expect(sessionAfter30.draftProfiles[0].area).toBeCloseTo(Math.PI * 30 * 30, 2);
    expect(circleAfter30.radius).toBeCloseTo(sessionAfter30.draftProfiles[0].segments![0].radius!, 5);
  });

  it('Session Integration Test: Diameter dimension (D100 -> D200) immediately updates entity and profile radius to 100', () => {
    const c1: CircleEntity = {
      id: 'circle-diam-1',
      type: 'circle',
      layerId: '0',
      visible: true,
      locked: false,
      center: { x: 0, y: 0 },
      radius: 50,
    };

    const dimDiam: SketchDimension = {
      id: 'dim-d100',
      type: 'radial',
      isDiameter: true,
      entityIds: ['circle-diam-1'],
      value: 100,
      text: 'Ø100',
      points: [{ x: 0, y: 0 }, { x: 50, y: 0 }],
      textPosition: { x: 25, y: 20 },
    };

    const initialSketch: SketchFeature = {
      id: 'sketch-diam-test',
      name: 'Sketch Diam',
      type: 'SKETCH',
      plane: DatumFrontPlane,
      dependencies: [],
      suppressed: false,
      entities: [c1],
      constraints: [],
      dimensions: [dimDiam],
      profiles: [],
      solverState: 'UnderDefined',
    };

    applyConstraintsToSketch(initialSketch);

    useCADStore.setState((state) => ({
      ...state,
      activeSketchId: 'sketch-diam-test',
      sketchSession: {
        isActive: true,
        sketchId: 'sketch-diam-test',
        draftEntities: initialSketch.entities,
        draftConstraints: initialSketch.constraints,
        draftDimensions: [dimDiam],
        draftProfiles: initialSketch.profiles,
        isDirty: false,
        undoStack: [],
        redoStack: [],
        workPlane: DatumFrontPlane,
      },
    }));

    // Modify diameter from 100 -> 200
    useCADStore.getState().updateDimensionValue('dim-d100', 200);

    const sessionState = useCADStore.getState().sketchSession;
    const circle = sessionState.draftEntities[0] as CircleEntity;
    expect(circle.radius).toBeCloseTo(100, 5); // Radius = Diameter / 2 = 100
    expect(sessionState.draftProfiles.length).toBe(1);
    expect(sessionState.draftProfiles[0].segments?.[0]?.radius).toBeCloseTo(100, 5);
    expect(sessionState.draftProfiles[0].area).toBeCloseTo(Math.PI * 100 * 100, 2);
  });

  it('Non-session Integration Test: updateDimensionValue updates sketch feature profiles in document', () => {
    const c1: CircleEntity = {
      id: 'circle-nonsession-1',
      type: 'circle',
      layerId: '0',
      visible: true,
      locked: false,
      center: { x: 0, y: 0 },
      radius: 50,
    };

    const dim1: SketchDimension = {
      id: 'dim-nonsession-r50',
      type: 'radial',
      isDiameter: false,
      entityIds: ['circle-nonsession-1'],
      value: 50,
      text: 'R50',
      points: [{ x: 0, y: 0 }, { x: 50, y: 0 }],
      textPosition: { x: 25, y: 20 },
    };

    const initialSketch: SketchFeature = {
      id: 'sketch-nonsession-test',
      name: 'Sketch NonSession',
      type: 'SKETCH',
      plane: DatumFrontPlane,
      dependencies: [],
      suppressed: false,
      entities: [c1],
      constraints: [],
      dimensions: [dim1],
      profiles: [],
      solverState: 'UnderDefined',
    };

    applyConstraintsToSketch(initialSketch);

    useCADStore.setState((state) => ({
      ...state,
      activeSketchId: 'sketch-nonsession-test',
      sketchSession: {
        isActive: false,
        sketchId: null,
        draftEntities: [],
        draftConstraints: [],
        draftDimensions: [],
        draftProfiles: [],
        isDirty: false,
        undoStack: [],
        redoStack: [],
        workPlane: DatumFrontPlane,
      },
      document: {
        ...state.document,
        featureTree: [initialSketch],
      },
    }));

    // Modify dimension: 50 -> 100
    useCADStore.getState().updateDimensionValue('dim-nonsession-r50', 100);

    const docState = useCADStore.getState().document;
    const updatedSketch = docState.featureTree.find(
      (f) => f.id === 'sketch-nonsession-test'
    ) as SketchFeature;

    expect(updatedSketch).toBeDefined();
    const updatedCircle = updatedSketch.entities[0] as CircleEntity;
    expect(updatedCircle.radius).toBeCloseTo(100, 5);
    expect(updatedSketch.profiles.length).toBe(1);
    expect(updatedSketch.profiles[0].segments?.[0]?.radius).toBeCloseTo(100, 5);
    expect(updatedSketch.profiles[0].area).toBeCloseTo(Math.PI * 100 * 100, 2);
  });
});
