import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { modelsApi } from '../src/services/api/models';
import { useModelsStore } from '../src/stores/useModelsStore';
import type { ModelInfo } from '../src/utils/models';

type FetchModels = typeof modelsApi.fetchModels;

interface PendingFetch {
  resolve: (models: ModelInfo[]) => void;
  reject: (error: unknown) => void;
}

const originalFetchModels = modelsApi.fetchModels;
let pending: PendingFetch[] = [];

const stubFetchModels = () => {
  modelsApi.fetchModels = ((): Promise<ModelInfo[]> =>
    new Promise<ModelInfo[]>((resolve, reject) => {
      pending.push({ resolve, reject });
    })) as FetchModels;
};

const accountAModels: ModelInfo[] = [{ name: 'account-a-model' }];
const accountBModels: ModelInfo[] = [{ name: 'account-b-model' }];

describe('models cache session isolation', () => {
  beforeEach(() => {
    pending = [];
    stubFetchModels();
    useModelsStore.getState().clearCache();
    useModelsStore.setState({ loading: false, error: null });
  });

  afterEach(() => {
    modelsApi.fetchModels = originalFetchModels;
  });

  test('a fetch that resolves after the cache is cleared does not commit models or cache', async () => {
    const request = useModelsStore.getState().fetchModels('http://account-a.example', 'key-a');
    expect(useModelsStore.getState().loading).toBe(true);

    useModelsStore.getState().clearCache();
    pending[0].resolve(accountAModels);

    await expect(request).resolves.toEqual(accountAModels);
    const state = useModelsStore.getState();
    expect(state.models).toEqual([]);
    expect(state.cache).toBeNull();
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
  });

  test('a fetch that rejects after the cache is cleared does not set error state', async () => {
    const request = useModelsStore.getState().fetchModels('http://account-a.example', 'key-a');

    useModelsStore.getState().clearCache();
    const failure = new Error('account A /v1/models failed');
    pending[0].reject(failure);

    await expect(request).rejects.toBe(failure);
    const state = useModelsStore.getState();
    expect(state.models).toEqual([]);
    expect(state.cache).toBeNull();
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
  });

  test('a stale fetch does not overwrite or end loading for the next connection', async () => {
    const accountA = useModelsStore.getState().fetchModels('http://account-a.example', 'key-a');
    useModelsStore.getState().clearCache();
    const accountB = useModelsStore.getState().fetchModels('http://account-b.example', 'key-b');

    pending[0].resolve(accountAModels);
    await accountA;
    expect(useModelsStore.getState().models).toEqual([]);
    expect(useModelsStore.getState().cache).toBeNull();
    expect(useModelsStore.getState().loading).toBe(true);

    pending[1].resolve(accountBModels);
    await expect(accountB).resolves.toEqual(accountBModels);
    const state = useModelsStore.getState();
    expect(state.models).toEqual(accountBModels);
    expect(state.cache?.data).toEqual(accountBModels);
    expect(state.cache?.apiBase).toBe('http://account-b.example');
    expect(state.cache?.apiKey).toBe('key-b');
    expect(state.loading).toBe(false);
  });

  test('an older overlapping fetch does not overwrite a newer one that already committed', async () => {
    const older = useModelsStore.getState().fetchModels('http://account-a.example', 'key-a');
    const newer = useModelsStore.getState().fetchModels('http://account-a.example', 'key-a', true);
    const refreshedModels: ModelInfo[] = [{ name: 'refreshed-model' }];

    pending[1].resolve(refreshedModels);
    await expect(newer).resolves.toEqual(refreshedModels);
    pending[0].resolve(accountAModels);
    await expect(older).resolves.toEqual(accountAModels);

    const state = useModelsStore.getState();
    expect(state.models).toEqual(refreshedModels);
    expect(state.cache?.data).toEqual(refreshedModels);
    expect(state.loading).toBe(false);
  });

  test('a current fetch commits models and cache', async () => {
    const request = useModelsStore.getState().fetchModels('http://account-a.example', ' key-a ');
    pending[0].resolve(accountAModels);

    await expect(request).resolves.toEqual(accountAModels);
    const state = useModelsStore.getState();
    expect(state.models).toEqual(accountAModels);
    expect(state.cache?.data).toEqual(accountAModels);
    expect(state.cache?.apiBase).toBe('http://account-a.example');
    expect(state.cache?.apiKey).toBe('key-a');
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(useModelsStore.getState().isCacheValid('http://account-a.example', 'key-a')).toBe(true);
  });

  test('a current fetch that rejects sets error state and rethrows', async () => {
    const request = useModelsStore.getState().fetchModels('http://account-a.example', 'key-a');
    const failure = new Error('/v1/models failed');
    pending[0].reject(failure);

    await expect(request).rejects.toBe(failure);
    const state = useModelsStore.getState();
    expect(state.error).toBe('/v1/models failed');
    expect(state.models).toEqual([]);
    expect(state.loading).toBe(false);
  });
});
