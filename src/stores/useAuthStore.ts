/**
 * 认证状态管理
 * 从原项目 src/modules/login.js 和 src/core/connection.js 迁移
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AuthState, LoginCredentials, ConnectionStatus, RestoreOutcome } from '@/types';
import { STORAGE_KEY_AUTH } from '@/utils/constants';
import { obfuscatedStorage } from '@/services/storage/secureStorage';
import { apiClient } from '@/services/api/client';
import { isRetryableConnectionError } from '@/services/api/apiError';
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
  /** Makes a restore in flight fail as superseded instead of signing in. */
  cancelRestore: () => void;
  /** Logs out and forgets the server address and remember-password choice as well. */
  clearLoginData: () => void;
  updateServerVersion: (version: string | null, buildDate?: string | null) => void;
  updateServerPluginSupport: (supportsPlugin: boolean) => void;
}

let restoreSessionPromise: Promise<RestoreOutcome> | null = null;
// Bumped by every login, logout and cancelled restore, so an attempt that was overtaken never
// commits its result.
let loginGeneration = 0;

const supersededLogin = () => {
  const error = new Error('Sign-in was superseded by a newer attempt');
  error.name = 'LoginSupersededError';
  return error;
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

        const attempt: Promise<RestoreOutcome> = (async (): Promise<RestoreOutcome> => {
          try {
            obfuscatedStorage.migratePlaintextKeys(['apiBase', 'apiUrl', 'managementKey']);

            // Logout (in any tab) clears this flag, so a key another tab still holds, or one an
            // older release copied in without signing in, never signs this page in by itself.
            const wasLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
            const legacyBase =
              obfuscatedStorage.getItem<string>('apiBase') ||
              obfuscatedStorage.getItem<string>('apiUrl', { encrypt: true });
            const legacyKey = obfuscatedStorage.getItem<string>('managementKey');

            const { apiBase, managementKey, rememberPassword } = get();
            const resolvedBase = normalizeApiBase(
              apiBase || legacyBase || detectApiBaseFromLocation()
            );
            const resolvedKey = managementKey || legacyKey || '';
            const resolvedRememberPassword =
              rememberPassword || Boolean(managementKey) || Boolean(legacyKey);

            set({
              apiBase: resolvedBase,
              managementKey: resolvedKey,
              rememberPassword: resolvedRememberPassword,
            });

            if (!wasLoggedIn || !resolvedBase || !resolvedKey) {
              return { status: 'none' };
            }

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
          if (restoreSessionPromise === attempt) restoreSessionPromise = null;
        });

        restoreSessionPromise = attempt;
        return attempt;
      },

      cancelRestore: () => {
        if (!restoreSessionPromise) return;
        restoreSessionPromise = null;
        loginGeneration += 1;
        useConfigStore.getState().clearCache();
        apiClient.disconnect();
        set({ connectionStatus: 'disconnected' });
      },

      clearLoginData: () => {
        get().logout();
        set({ apiBase: '', rememberPassword: false });
      },

      // 登录
      login: async (credentials) => {
        const apiBase = normalizeApiBase(credentials.apiBase);
        const managementKey = credentials.managementKey.trim();
        const rememberPassword = credentials.rememberPassword ?? get().rememberPassword ?? false;
        const generation = (loginGeneration += 1);

        try {
          set({
            connectionStatus: 'connecting',
            serverVersion: null,
            serverBuildDate: null,
            supportsPlugin: false,
          });
          // New credentials: a /config request already in flight was sent with the old ones.
          useConfigStore.getState().clearCache();
          useModelsStore.getState().clearCache();
          useQuotaStore.getState().clearQuotaCache();

          // 配置 API 客户端
          apiClient.setConfig({
            apiBase,
            managementKey,
          });

          // 测试连接 - 获取配置
          await useConfigStore.getState().fetchConfig(true);
          if (generation !== loginGeneration) throw supersededLogin();

          // 登录成功
          set({
            isAuthenticated: true,
            apiBase,
            managementKey,
            rememberPassword,
            connectionStatus: 'connected',
          });
          if (rememberPassword) {
            localStorage.setItem('isLoggedIn', 'true');
          } else {
            localStorage.removeItem('isLoggedIn');
          }
        } catch (error: unknown) {
          if (generation === loginGeneration) set({ connectionStatus: 'error' });
          throw error;
        }
      },

      // 登出
      logout: () => {
        restoreSessionPromise = null;
        loginGeneration += 1;
        apiClient.disconnect();
        useConfigStore.getState().clearCache();
        useModelsStore.getState().clearCache();
        useQuotaStore.getState().clearQuotaCache();
        // The server address stays: it is not a secret, and the login form offers it again.
        set({
          isAuthenticated: false,
          managementKey: '',
          serverVersion: null,
          serverBuildDate: null,
          supportsPlugin: false,
          connectionStatus: 'disconnected',
        });
        localStorage.removeItem('isLoggedIn');
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
