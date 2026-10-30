/**
 * 认证状态管理
 * 从原项目 src/modules/login.js 和 src/core/connection.js 迁移
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  ApiError,
  AuthState,
  LoginCredentials,
  ConnectionStatus,
  RestoreOutcome,
} from '@/types';
import { STORAGE_KEY_AUTH, STORAGE_KEY_AUTH_SESSION } from '@/utils/constants';
import { obfuscatedSessionStorage, obfuscatedStorage } from '@/services/storage/secureStorage';
import { apiClient } from '@/services/api/client';
import { useConfigStore } from './useConfigStore';
import { useModelsStore } from './useModelsStore';
import { useQuotaStore } from './useQuotaStore';
import { detectApiBaseFromLocation, normalizeApiBase } from '@/utils/connection';

interface AuthStoreState extends AuthState {
  connectionStatus: ConnectionStatus;

  // 操作
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => void;
  restoreSession: () => Promise<RestoreOutcome>;
  updateServerVersion: (version: string | null, buildDate?: string | null) => void;
  updateServerPluginSupport: (supportsPlugin: boolean) => void;
}

type TabSession = { apiBase?: string; managementKey?: string };

const LEGACY_SESSION_KEYS = ['isLoggedIn', 'apiBase', 'apiUrl', 'managementKey'];

let restoreSessionPromise: Promise<RestoreOutcome> | null = null;

/** No response, a timeout, or a server-side failure: the proxy may be restarting. */
export const isRetryableConnectionError = (error: unknown): boolean => {
  const status = (error as Partial<ApiError> | null)?.status;
  if (typeof status !== 'number') return true;
  return status === 408 || status === 429 || status >= 500;
};

export const useAuthStore = create<AuthStoreState>()(
  persist(
    (set, get) => ({
      // 初始状态
      isAuthenticated: false,
      apiBase: '',
      managementKey: '',
      rememberPassword: false,
      serverVersion: null,
      serverBuildDate: null,
      supportsPlugin: false,
      connectionStatus: 'disconnected',

      // 恢复会话并自动登录
      restoreSession: () => {
        if (get().isAuthenticated) return Promise.resolve({ status: 'restored' });
        if (restoreSessionPromise) return restoreSessionPromise;

        restoreSessionPromise = (async (): Promise<RestoreOutcome> => {
          obfuscatedStorage.migratePlaintextKeys(['apiBase', 'apiUrl', 'managementKey']);

          const legacyBase =
            obfuscatedStorage.getItem<string>('apiBase') ||
            obfuscatedStorage.getItem<string>('apiUrl', { encrypt: true });
          const legacyKey = obfuscatedStorage.getItem<string>('managementKey');
          // Pre-store releases kept the session in these keys; once read, the store owns it.
          LEGACY_SESSION_KEYS.forEach((key) => localStorage.removeItem(key));
          const tabSession = obfuscatedSessionStorage.getItem<TabSession>(STORAGE_KEY_AUTH_SESSION);

          const { apiBase, managementKey, rememberPassword } = get();
          const resolvedBase = normalizeApiBase(
            apiBase || tabSession?.apiBase || legacyBase || detectApiBaseFromLocation()
          );
          const resolvedKey = managementKey || tabSession?.managementKey || legacyKey || '';
          const resolvedRememberPassword =
            rememberPassword || Boolean(managementKey) || Boolean(legacyKey);

          set({
            apiBase: resolvedBase,
            managementKey: resolvedKey,
            rememberPassword: resolvedRememberPassword,
          });
          apiClient.setConfig({ apiBase: resolvedBase, managementKey: resolvedKey });

          if (!resolvedBase || !resolvedKey) {
            return { status: 'none' };
          }

          try {
            await get().login({
              apiBase: resolvedBase,
              managementKey: resolvedKey,
              rememberPassword: resolvedRememberPassword,
            });
            return { status: 'restored' };
          } catch (error) {
            console.warn('Auto login failed:', error);
            return { status: 'failed', retryable: isRetryableConnectionError(error), error };
          }
        })().finally(() => {
          // Single-flight only: a later caller (a retry, another route) must try again.
          restoreSessionPromise = null;
        });

        return restoreSessionPromise;
      },

      // 登录
      login: async (credentials) => {
        const apiBase = normalizeApiBase(credentials.apiBase);
        const managementKey = credentials.managementKey.trim();
        const rememberPassword = credentials.rememberPassword ?? get().rememberPassword ?? false;

        try {
          set({
            connectionStatus: 'connecting',
            serverVersion: null,
            serverBuildDate: null,
            supportsPlugin: false,
          });
          useModelsStore.getState().clearCache();
          useQuotaStore.getState().clearQuotaCache();

          // 配置 API 客户端
          apiClient.setConfig({
            apiBase,
            managementKey,
          });

          // 测试连接 - 获取配置
          await useConfigStore.getState().fetchConfig(true);

          // 登录成功
          set({
            isAuthenticated: true,
            apiBase,
            managementKey,
            rememberPassword,
            connectionStatus: 'connected',
          });
          obfuscatedSessionStorage.setItem(STORAGE_KEY_AUTH_SESSION, { apiBase, managementKey });
        } catch (error: unknown) {
          set({ connectionStatus: 'error' });
          throw error;
        }
      },

      // 登出
      logout: () => {
        restoreSessionPromise = null;
        useConfigStore.getState().clearCache();
        useModelsStore.getState().clearCache();
        useQuotaStore.getState().clearQuotaCache();
        set({
          isAuthenticated: false,
          apiBase: '',
          managementKey: '',
          serverVersion: null,
          serverBuildDate: null,
          supportsPlugin: false,
          connectionStatus: 'disconnected',
        });
        obfuscatedSessionStorage.removeItem(STORAGE_KEY_AUTH_SESSION);
      },

      // 更新服务器版本
      updateServerVersion: (version, buildDate) => {
        set({
          serverVersion: version || null,
          serverBuildDate: buildDate || null,
        });
      },

      updateServerPluginSupport: (supportsPlugin) => {
        set({ supportsPlugin });
      },
    }),
    {
      name: STORAGE_KEY_AUTH,
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          const data = obfuscatedStorage.getItem<unknown>(name);
          // Anything but an object is a save this browser can no longer read: start signed out.
          return data && typeof data === 'object' ? JSON.stringify(data) : null;
        },
        setItem: (name, value) => {
          obfuscatedStorage.setItem(name, JSON.parse(value));
        },
        removeItem: (name) => {
          obfuscatedStorage.removeItem(name);
        },
      })),
      partialize: (state) => ({
        apiBase: state.apiBase,
        ...(state.rememberPassword ? { managementKey: state.managementKey } : {}),
        rememberPassword: state.rememberPassword,
        serverVersion: state.serverVersion,
        serverBuildDate: state.serverBuildDate,
      }),
    }
  )
);

// 监听全局未授权事件
if (typeof window !== 'undefined') {
  window.addEventListener('unauthorized', () => {
    useAuthStore.getState().logout();
  });

  window.addEventListener('server-version-update', ((e: CustomEvent) => {
    const detail = e.detail || {};
    useAuthStore.getState().updateServerVersion(detail.version || null, detail.buildDate || null);
  }) as EventListener);

  window.addEventListener('server-plugin-support-update', ((e: CustomEvent) => {
    useAuthStore.getState().updateServerPluginSupport(e.detail?.supportsPlugin === true);
  }) as EventListener);
}
