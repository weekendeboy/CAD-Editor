/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SolidTaskRequest,
  SolidTaskResponse,
  MeshResult,
  ExtrudeProfileResponseData,
  FeatureEvalOp,
  KernelResult,
} from './SolidEngine.types';
import type { SketchProfile } from '../../types/cad';
import { buildFeatureEvalOps } from './FeaturePipelineAdapter';
import SolidWorker from './SolidWorker.ts?worker';

export class SolidEngine {
  private worker: Worker | null = null;
  private resolvers: Map<string, { resolve: (val: any) => void; reject: (err: any) => void }> = new Map();
  private initPromise: Promise<void> | null = null;
  
  // 【P3 架構修復】重算事務版號 (Regen Transaction Revision)
  // 用於精準攔截並丟棄過期的 Worker 非同步回傳結果，防止 Race Condition (時間旅行)
  private currentRegenRevision: number = 0;

  constructor() {
    // Lazy worker creation to prevent module evaluation crashes in constrained environments
  }

  private getWorker(): Worker | null {
    if (!this.worker && typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      try {
        this.worker = new SolidWorker();
        this.worker.onmessage = this.handleMessage.bind(this);
        this.worker.onerror = (err) => {
          console.error('SolidWorker error:', err);
        };
      } catch (err) {
        console.error('Failed to initialize SolidWorker:', err);
        this.worker = null;
      }
    }
    return this.worker;
  }

  private handleMessage(e: MessageEvent<SolidTaskResponse>) {
    const res = e.data;
    if (!res || !res.taskId) return;

    const task = this.resolvers.get(res.taskId);
    if (task) {
      if (res.success) {
        const resultVal = res.data?.kernelResult !== undefined ? res.data.kernelResult : res.data;
        task.resolve(resultVal);
      } else {
        task.reject(new Error(res.error || 'SolidWorker task execution failed'));
      }
      this.resolvers.delete(res.taskId);
    }
  }

  private dispatch<T>(type: SolidTaskRequest['type'], payload?: any, transfer?: Transferable[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const worker = this.getWorker();
      if (!worker) {
        return reject(new Error('Worker is not available or failed to initialize'));
      }

      const taskId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      this.resolvers.set(taskId, { resolve, reject });

      const req: SolidTaskRequest = {
        taskId,
        type,
        payload: { ...payload, taskId },
      };

      try {
        if (transfer && transfer.length > 0) {
          worker.postMessage(req, transfer);
        } else {
          worker.postMessage(req);
        }
      } catch (postErr) {
        this.resolvers.delete(taskId);
        reject(postErr);
      }
    });
  }

  public async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        // Fetch the WASM binary on the main thread to ensure proper cookie handling and origin context.
        // We load chunked parts (<20MB each) to strictly conform to Cloud Run's 32MB HTTP response limit.
        const getOccBaseUrl = (): string => {
          if (typeof window !== 'undefined' && window.location) {
            const base = (import.meta as any).env?.BASE_URL || '/';
            try {
              return new URL('occ/', new URL(base, window.location.href)).href;
            } catch {
              return '/occ/';
            }
          }
          return '/occ/';
        };

        const occBaseUrl = getOccBaseUrl();
        let wasmBuffer: ArrayBuffer | null = null;

        // Step 1: Try chunked loading via manifest or standard chunks
        try {
          let partNames = [
            'opencascade.wasm.part0.bin',
            'opencascade.wasm.part1.bin',
            'opencascade.wasm.part2.bin',
            'opencascade.wasm.part3.bin',
          ];

          try {
            const manifestRes = await fetch(`${occBaseUrl}manifest.json`);
            if (manifestRes.ok) {
              const manifest = await manifestRes.json();
              if (Array.isArray(manifest.parts) && manifest.parts.length > 0) {
                partNames = manifest.parts;
              }
            }
          } catch {
            // Fallback to default partNames if manifest fails
          }

          const buffers = await Promise.all(
            partNames.map(async (partName) => {
              const res = await fetch(`${occBaseUrl}${partName}`);
              if (!res.ok) {
                throw new Error(`Failed to fetch chunk ${partName}: ${res.status} ${res.statusText}`);
              }
              return res.arrayBuffer();
            })
          );

          const totalSize = buffers.reduce((acc, b) => acc + b.byteLength, 0);
          const combined = new Uint8Array(totalSize);
          let offset = 0;
          for (const buf of buffers) {
            combined.set(new Uint8Array(buf), offset);
            offset += buf.byteLength;
          }
          wasmBuffer = combined.buffer;
        } catch (chunkErr) {
          console.warn('Chunked WASM load failed, attempting monolithic fallback:', chunkErr);
          // Step 2: Fallback to monolithic wasm fetch (served with gzip stream by Vite middleware)
          const response = await fetch(`${occBaseUrl}opencascade.wasm.wasm`);
          if (!response.ok) {
            throw new Error(`Failed to fetch WASM binary: ${response.status} ${response.statusText}`);
          }
          wasmBuffer = await response.arrayBuffer();
        }

        if (!wasmBuffer || wasmBuffer.byteLength === 0) {
          throw new Error('Failed to load valid OpenCASCADE WASM binary buffer');
        }

        await this.dispatch<void>('INIT', { wasmBuffer, occBaseUrl }, [wasmBuffer]);
      })();
    }
    return this.initPromise;
  }

  public async extrudeProfiles(profiles: SketchProfile[], depth: number): Promise<MeshResult> {
    await this.init();
    return this.dispatch<MeshResult>('EXTRUDE_PROFILES', { profiles, depth });
  }

  public async evaluateFeatureTree(operations: FeatureEvalOp[], dirtyFromIndex?: number, isPureRollback?: boolean): Promise<KernelResult> {
    await this.init();

    // 【P3 核心】發送任務前，遞增事務版本號並綁定到此作用域
    this.currentRegenRevision++;
    const myRevision = this.currentRegenRevision;

    const result = await this.dispatch<KernelResult>('EVALUATE_FEATURE_TREE', { operations, dirtyFromIndex, isPureRollback });

    // 【P3 核心】Worker 回傳後，檢查是否在運算期間有新的任務被觸發
    if (this.currentRegenRevision !== myRevision) {
      const err = new Error('RegenJobCancelled');
      err.name = 'AbortError';
      throw err; // 拋出異常，讓 Store 直接放棄處理這份過期資料
    }

    return result;
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

  public async exportModel(
    format: 'STEP' | 'STL',
    featureTree?: any[],
    rollbackIndex?: number,
    planes?: Record<string, any>,
    unit: 'mm' | 'inch' = 'mm'
  ): Promise<Uint8Array | ArrayBuffer | string> {
    await this.init();
    let operations: FeatureEvalOp[] | undefined = undefined;
    if (featureTree && featureTree.length > 0) {
      operations = buildFeatureEvalOps(featureTree, rollbackIndex ?? featureTree.length, planes ?? {});
    }
    return this.dispatch<Uint8Array | ArrayBuffer | string>('EXPORT_MODEL', {
      format,
      operations,
      unit,
    });
  }
}

export const solidEngine = new SolidEngine();