/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export class WorkerOCCAssetResolver {
  private baseUrl: string;

  constructor(providedBaseUrl?: string) {
    this.baseUrl = WorkerOCCAssetResolver.resolveBaseUrl(providedBaseUrl);
  }

  public static resolveBaseUrl(providedBaseUrl?: string): string {
    if (providedBaseUrl && typeof providedBaseUrl === 'string' && providedBaseUrl.trim() !== '') {
      let url = providedBaseUrl.trim();
      if (!url.endsWith('/')) {
        url += '/';
      }
      return url;
    }

    let origin = '';
    if (typeof self !== 'undefined' && self.location && self.location.origin) {
      origin = self.location.origin;
    } else if (typeof window !== 'undefined' && window.location && window.location.origin) {
      origin = window.location.origin;
    }

    if (origin) {
      return `${origin}/occ/`;
    }
    return '/occ/';
  }

  public getOccBaseUrl(): string {
    let url = this.baseUrl;
    if (!url.endsWith('/')) {
      url += '/';
    }
    if (!url.endsWith('/occ/')) {
      url = url.endsWith('/occ') ? `${url}/` : `${url}occ/`;
    }
    return url;
  }

  public getJsUrl(): string {
    return `${this.getOccBaseUrl()}opencascade.wasm.js`;
  }

  public getWasmUrl(): string {
    return `${this.getOccBaseUrl()}opencascade.wasm.wasm`;
  }

  public getManifestUrl(): string {
    return `${this.getOccBaseUrl()}manifest.json`;
  }

  public getChunkUrl(partName: string): string {
    const cleanPart = partName.replace(/^\/+/, '');
    return `${this.getOccBaseUrl()}${cleanPart}`;
  }
}
