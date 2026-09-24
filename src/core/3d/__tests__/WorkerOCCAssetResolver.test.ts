import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerOCCAssetResolver } from '../WorkerOCCAssetResolver';

describe('WorkerOCCAssetResolver', () => {
  it('should correctly resolve URLs with explicit provided occBaseUrl ending with slash', () => {
    const resolver = new WorkerOCCAssetResolver('http://localhost:3000/occ/');
    assert.strictEqual(resolver.getOccBaseUrl(), 'http://localhost:3000/occ/');
    assert.strictEqual(resolver.getJsUrl(), 'http://localhost:3000/occ/opencascade.wasm.js');
    assert.strictEqual(resolver.getWasmUrl(), 'http://localhost:3000/occ/opencascade.wasm.wasm');
    assert.strictEqual(resolver.getManifestUrl(), 'http://localhost:3000/occ/manifest.json');
    assert.strictEqual(resolver.getChunkUrl('opencascade.wasm.part0.bin'), 'http://localhost:3000/occ/opencascade.wasm.part0.bin');
  });

  it('should correctly normalize provided base URL missing trailing slash or /occ/', () => {
    const resolver1 = new WorkerOCCAssetResolver('http://localhost:3000');
    assert.strictEqual(resolver1.getOccBaseUrl(), 'http://localhost:3000/occ/');
    assert.strictEqual(resolver1.getJsUrl(), 'http://localhost:3000/occ/opencascade.wasm.js');

    const resolver2 = new WorkerOCCAssetResolver('http://localhost:3000/occ');
    assert.strictEqual(resolver2.getOccBaseUrl(), 'http://localhost:3000/occ/');
    assert.strictEqual(resolver2.getJsUrl(), 'http://localhost:3000/occ/opencascade.wasm.js');
  });

  it('should fall back safely when no baseUrl is provided', () => {
    const resolver = new WorkerOCCAssetResolver();
    assert.ok(resolver.getOccBaseUrl().includes('/occ/'));
    assert.ok(resolver.getJsUrl().includes('/occ/opencascade.wasm.js'));
  });
});
