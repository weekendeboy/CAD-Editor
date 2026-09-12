import { SolidTaskRequest, SolidTaskResponse, ExtrudeProfileResponseData } from './SolidEngine.types';
import type { SketchProfile } from '../../types/cad';

class SolidEngine {
  private worker: Worker | null = null;
  private pendingTasks: Map<string, { resolve: (val: any) => void; reject: (err: any) => void }> = new Map();
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.worker = new Worker(new URL('./SolidWorker.ts', import.meta.url));
    this.worker.onmessage = this.handleMessage.bind(this);
  }

  private handleMessage(e: MessageEvent<SolidTaskResponse>) {
    const res = e.data;
    const task = this.pendingTasks.get(res.taskId);
    if (task) {
      if (res.success) {
        task.resolve(res.data);
      } else {
        task.reject(new Error(res.error));
      }
      this.pendingTasks.delete(res.taskId);
    }
  }

  private dispatch<T>(type: SolidTaskRequest['type'], payload?: any, transfer?: Transferable[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const taskId = crypto.randomUUID();
      this.pendingTasks.set(taskId, { resolve, reject });
      
      const req: SolidTaskRequest = { taskId, type, payload };
      if (this.worker) {
          if (transfer) {
              this.worker.postMessage(req, transfer);
          } else {
              this.worker.postMessage(req);
          }
      } else {
          reject(new Error('Worker is not initialized'));
      }
    });
  }

  public async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.dispatch<void>('INIT');
    }
    return this.initPromise;
  }

  public async extrudeProfile(profile: SketchProfile, depth: number): Promise<ExtrudeProfileResponseData> {
    await this.init();
    return this.dispatch<ExtrudeProfileResponseData>('EXTRUDE_PROFILE', { profile, depth });
  }

  public async exportSTEP(): Promise<string> {
    await this.init();
    return this.dispatch<string>('EXPORT_STEP');
  }

  public async exportSTL(): Promise<Uint8Array> {
    await this.init();
    return this.dispatch<Uint8Array>('EXPORT_STL');
  }
}

export const solidEngine = new SolidEngine();
