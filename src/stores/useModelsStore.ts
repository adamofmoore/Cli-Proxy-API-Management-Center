/**
 * 模型列表状态管理（带缓存）
 */

import { create } from 'zustand';
import { modelsApi } from '@/services/api/models';
import { CACHE_EXPIRY_MS } from '@/utils/constants';
import type { ModelInfo } from '@/utils/models';

interface ModelsCache {
  data: ModelInfo[];
  timestamp: number;
  apiBase: string;
  apiKey: string;
}

interface ModelsState {
  models: ModelInfo[];
  loading: boolean;
  error: string | null;
  cache: ModelsCache | null;

  fetchModels: (apiBase: string, apiKey?: string, forceRefresh?: boolean) => Promise<ModelInfo[]>;
  clearCache: () => void;
  isCacheValid: (apiBase: string, apiKey?: string) => boolean;
}

let modelsRequestToken = 0;

export const useModelsStore = create<ModelsState>((set, get) => ({
  models: [],
  loading: false,
  error: null,
  cache: null,

  fetchModels: async (apiBase, apiKey, forceRefresh = false) => {
    const { cache, isCacheValid } = get();
    const apiKeyScope = apiKey?.trim() || '';

    // 检查缓存
    if (!forceRefresh && isCacheValid(apiBase, apiKeyScope) && cache) {
      set({ models: cache.data, error: null });
      return cache.data;
    }

    const requestId = (modelsRequestToken += 1);
    set({ loading: true, error: null });

    try {
      const list = await modelsApi.fetchModels(apiBase, apiKeyScope || undefined);

      // 请求期间连接已切换/登出或已有更新的请求，忽略旧结果，避免覆盖当前会话的状态
      if (requestId !== modelsRequestToken) {
        return list;
      }

      const now = Date.now();

      set({
        models: list,
        loading: false,
        cache: { data: list, timestamp: now, apiBase, apiKey: apiKeyScope },
      });

      return list;
    } catch (error: unknown) {
      if (requestId !== modelsRequestToken) {
        throw error;
      }

      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Failed to fetch models';
      set({
        error: message,
        loading: false,
        models: [],
      });
      throw error;
    }
  },

  clearCache: () => {
    // 让 in-flight 的旧请求失效；它们不会再提交，因此由这里结束 loading
    modelsRequestToken += 1;
    set({ cache: null, models: [], loading: false, error: null });
  },

  isCacheValid: (apiBase, apiKey) => {
    const { cache } = get();
    if (!cache) return false;
    if (cache.apiBase !== apiBase) return false;
    const apiKeyScope = apiKey?.trim() || '';
    if ((cache.apiKey || '') !== apiKeyScope) return false;
    return Date.now() - cache.timestamp < CACHE_EXPIRY_MS;
  },
}));
