import {
  SolidTaskRequest,
  SolidTaskResponse,
  MeshResult,
  ExtrudeProfileResponseData,
  FeatureEvalOp,
} from './SolidEngine.types';
import type { SketchProfile } from '../../types/cad';

class SolidEngine {
  private worker: Worker | null = null;
  private resolvers: Map<string, { resolve: (val: any) => void; reject: (err: any) => void }> = new Map();
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.worker = new Worker(new URL('./SolidWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = (err) => {
      console.error('SolidWorker error:', err);
    };
  }

  private handleMessage(e: MessageEvent<SolidTaskResponse>) {
    const res = e.data;
    if (!res || !res.taskId) return;

    const task = this.resolvers.get(res.taskId);
    if (task) {
      if (res.success) {
        task.resolve(res.data);
      } else {
        task.reject(new Error(res.error || 'SolidWorker task execution failed'));
      }
      this.resolvers.delete(res.taskId);
    }
  }

  private dispatch<T>(type: SolidTaskRequest['type'], payload?: any, transfer?: Transferable[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const taskId = crypto.randomUUID();
      this.resolvers.set(taskId, { resolve, reject });

      const req: SolidTaskRequest = {
        taskId,
        type,
        payload: { ...payload, taskId },
      };

      if (this.worker) {
        if (transfer && transfer.length > 0) {
          this.worker.postMessage(req, transfer);
        } else {
          this.worker.postMessage(req);
        }
      } else {
        this.resolvers.delete(taskId);
        reject(new Error('Worker is not initialized'));
      }
    });
  }

  public async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        // Fetch the WASM binary on the main thread to ensure proper cookie handling and origin context
        const response = await fetch('/occ/opencascade.wasm.wasm');
        if (!response.ok) {
          throw new Error(`Failed to fetch WASM binary: ${response.status} ${response.statusText}`);
        }
        const wasmBuffer = await response.arrayBuffer();

        await this.dispatch<void>('INIT', { wasmBuffer }, [wasmBuffer]);
      })();
    }
    return this.initPromise;
  }

  public async extrudeProfiles(profiles: SketchProfile[], depth: number): Promise<MeshResult> {
    await this.init();
    return this.dispatch<MeshResult>('EXTRUDE_PROFILES', { profiles, depth });
  }

  public async evaluateFeatureTree(operations: FeatureEvalOp[]): Promise<MeshResult> {
    await this.init();
    return this.dispatch<MeshResult>('EVALUATE_FEATURE_TREE', { operations });
  }

  public async extrudeProfile(profile: SketchProfile, depth: number): Promise<ExtrudeProfileResponseData> {
    return this.extrudeProfiles([profile], depth);
  }

  public async exportSTEP(unit: 'mm' | 'inch' = 'mm'): Promise<string> {
    await this.init();
    return this.dispatch<string>('EXPORT_STEP', { unit });
  }

  public async exportSTL(): Promise<Uint8Array> {
    await this.init();
    return this.dispatch<Uint8Array>('EXPORT_STL');
  }
}

export const solidEngine = new SolidEngine();
