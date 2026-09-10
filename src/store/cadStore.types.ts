import { CADDocument, CADEntity2D, Constraint, Point2D } from '../types/cad';

export interface CADState {
  document: CADDocument;
  
  viewMode: '2D' | '3D';
  currentTool: 'SELECT' | 'LINE' | 'RECTANGLE' | 'CIRCLE' | 'ARC' | 'ARC_3P' | 'ARC_CENTER' | 'POLYLINE' | 'PAN' | 'DIMENSION' | 'TRIM' | 'FILLET';
  activeSketchId: string | null;
  selectedEntityIds: string[];
  selectedFeatureId: string | null;
  osnapEnabled: boolean;

  undoStack: CADDocument[];
  redoStack: CADDocument[];

  setViewMode: (mode: '2D' | '3D') => void;
  setTool: (tool: 'SELECT' | 'LINE' | 'RECTANGLE' | 'CIRCLE' | 'ARC' | 'ARC_3P' | 'ARC_CENTER' | 'POLYLINE' | 'PAN' | 'DIMENSION' | 'TRIM' | 'FILLET') => void;
  setActiveSketch: (sketchId: string | null) => void;
  selectEntity: (id: string) => void;
  clearSelection: () => void;
  addEntity: (entity: CADEntity2D) => void;
  removeEntity: (id: string) => void;
  updateEntity: (id: string, updates: Partial<CADEntity2D>) => void;
  toggleConstruction: (entityId: string) => void;
  addConstraint: (constraint: Constraint) => void;
  addDimension: (dimension: any, constraint: Constraint) => void;
  removeConstraint: (constraintId: string) => void;
  updateConstraintValue: (constraintId: string, value: number) => void;
  trimEntity: (entityId: string, clickPoint: Point2D) => void;
  applyFillet: (lineId1: string, lineId2: string, radius: number) => void;
  toggleOsnap: () => void;
  resetDocument: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}
