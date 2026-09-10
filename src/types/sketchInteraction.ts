import { Point2D } from './cad';

export interface DrawSession {
  isDrawing: boolean;
  startPoint: Point2D | null;
  secondPoint?: Point2D | null;
  currentCursor: Point2D | null;
  step: number;
  polylinePoints?: Point2D[];
  inferredConstraint?: 'horizontal' | 'vertical' | null;
}

export type PreviewEntity =
  | { type: 'preview-line'; start: Point2D; end: Point2D }
  | { type: 'preview-circle'; center: Point2D; radius: number }
  | { type: 'preview-polyline'; points: Point2D[] };

export const createInitialDrawSession = (): DrawSession => ({
  isDrawing: false,
  startPoint: null,
  secondPoint: null,
  currentCursor: null,
  step: 0,
  polylinePoints: [],
});
