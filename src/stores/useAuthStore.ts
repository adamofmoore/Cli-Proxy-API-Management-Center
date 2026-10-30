/**
 * 认证状态管理
 * 从原项目 src/modules/login.js 和 src/core/connection.js 迁移
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  AuthState,
  LoginCredentials,
  ConnectionStatus,
  RestoreOutcome,
} from '@/types';
import {
  LEGACY_AUTH_STORAGE_KEYS,
  STORAGE_KEY_AUTH,
  STORAGE_KEY_AUTH_SESSION,
} from '@/utils/constants';
import { obfuscatedSessionStorage, obfuscatedStorage } from '@/services/storage/secureStorage';
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
  updateServerVersion: (version: string | null, buildDate?: string | null) => void;
  updateServerPluginSupport: (supportsPlugin: boolean) => void;
}

type SavedSession = Required<LoginCredentials>;

let restoreSessionPromise: Promise<RestoreOutcome> | null = null;
// Bumped by every login and logout, so an attempt that was overtaken never commits its result.
let loginGeneration = 0;

const supersededLogin = () => {
  const error = new Error('Sign-in was superseded by a newer attempt');
  error.name = 'LoginSupersededError';
  return error;
};

/**
 * Releases before the auth store kept the session in loose keys and gated auto-login on
 * `isLoggedIn`; logging out cleared only the flag. Read them once, then remove them.
 */
const takeLegacySession = (): SavedSession | null => {
  obfuscatedStorage.migratePlaintextKeys(['apiBase', 'apiUrl', 'managementKey']);
  const wasLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
  const base =
    obfuscatedStorage.getItem<string>('apiBase') ||
    obfuscatedStorage.getItem<string>('apiUrl', { encrypt: true });
  const key = obfuscatedStorage.getItem<string>('managementKey');
  LEGACY_AUTH_STORAGE_KEYS.forEach((name) => localStorage.removeItem(name));
  if (!wasLoggedIn || typeof key !== 'string' || !key) return null;
  return {
    apiBase: normalizeApiBase(base || detectApiBaseFromLocation()),
    managementKey: key,
    rememberPassword: true,
  };
};

/**
 * The session to restore, newest owner first: this tab, then the remembered sign-in, then a
 * legacy one. Address, key and remember choice always come from one source; mixing them
 * could send one server's key to another, or remember a key the user chose not to.
 */
const resolveSavedSession = (state: AuthState): SavedSession | null => {
  const legacy = takeLegacySession();
  const tab = obfuscatedSessionStorage.getItem<Partial<SavedSession>>(STORAGE_KEY_AUTH_SESSION);
  if (tab?.apiBase && tab.managementKey) {
    return {
      apiBase: normalizeApiBase(tab.apiBase),
      managementKey: tab.managementKey,
      rememberPassword: tab.rememberPassword === true,
    };
  }
  if (state.managementKey) {
    return {
      apiBase: normalizeApiBase(state.apiBase || detectApiBaseFromLocation()),
      managementKey: state.managementKey,
      rememberPassword: state.rememberPassword,
    };
  }
  return legacy;
};

const keepSessionForTab = (session: SavedSession) => {
  try {
    obfuscatedSessionStorage.setItem(STORAGE_KEY_AUTH_SESSION, session);
  } catch (error) {
    // Costs only staying signed in across a reload; the sign-in itself succeeded.
    console.warn('Could not keep the session for this tab:', error);
  }
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
            const session = resolveSavedSession(get());
            if (!session) return { status: 'none' };
            set(session);
            await get().login(session);
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

          keepSessionForTab({ apiBase, managementKey, rememberPassword });
          // 登录成功
          set({
            isAuthenticated: true,
            apiBase,
            managementKey,
            rememberPassword,
            connectionStatus: 'connected',
          });
        } catch (error: unknown) {
          if (generation === loginGeneration) set({ connectionStatus: 'error' });
          throw error;
        }
      },

      // 登出
      logout: () => {
        restoreSessionPromise = null;
        loginGeneration += 1;
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
