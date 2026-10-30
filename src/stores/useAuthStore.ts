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
  /** `stillWanted` is asked once the proxy answers; false abandons the sign-in as superseded. */
  login: (credentials: LoginCredentials, stillWanted?: () => boolean) => Promise<void>;
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
// Set while a logout or a clear writes the save from a page that is no longer signed in.
let savingSignedOut = false;
const saveSignedOut = (write: () => void) => {
  savingSignedOut = true;
  try {
    write();
  } finally {
    savingSignedOut = false;
  }
};

// Every field any release has persisted, with its type. A browser update can garble an old
// enc::v1 save into JSON that still parses; a renamed field or a wrong type is how that shows.
const SAVED_AUTH_FIELDS: Record<string, (value: unknown) => boolean> = {
  apiBase: (value) => typeof value === 'string' && (!value || /^https?:\/\//i.test(value)),
  managementKey: (value) => typeof value === 'string',
  rememberPassword: (value) => typeof value === 'boolean',
  serverVersion: (value) => value === null || typeof value === 'string',
  serverBuildDate: (value) => value === null || typeof value === 'string',
  // Saved by v1.15-v1.19 ('unknown' | 'cpa' | 'home'); read and ignored since.
  serverRuntimeKind: (value) => typeof value === 'string',
};

export const isSavedAuth = (data: unknown): boolean => {
  if (!data || typeof data !== 'object') return false;
  const { state, version, ...rest } = data as Record<string, unknown>;
  if (Object.keys(rest).length || typeof version !== 'number') return false;
  if (!state || typeof state !== 'object') return false;
  return Object.entries(state).every(
    ([field, value]) =>
      Object.prototype.hasOwnProperty.call(SAVED_AUTH_FIELDS, field) &&
      SAVED_AUTH_FIELDS[field](value)
  );
};

// The sign-in every tab shares, as saved: a restore reads it again before committing.
const readSavedSignIn = () => {
  const saved = obfuscatedStorage.getItem<unknown>(STORAGE_KEY_AUTH);
  const state = isSavedAuth(saved) ? (saved as { state: Record<string, unknown> }).state : {};
  return JSON.stringify([localStorage.getItem('isLoggedIn'), state.apiBase, state.managementKey]);
};

const supersededLogin = () => {
  const error = new Error('Sign-in was superseded by a newer attempt');
  error.name = 'LoginSupersededError';
  return error;
};

const isSuperseded = (error: unknown) =>
  error instanceof Error && error.name === 'LoginSupersededError';

// Nothing signs in with the credentials in flight: drop them, and the /config answer they got.
const dropConnection = () => {
  loginGeneration += 1;
  useConfigStore.getState().clearCache();
  apiClient.disconnect();
  useAuthStore.setState({ connectionStatus: 'disconnected' });
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

        let attempt: Promise<RestoreOutcome> | null = null;
        attempt = (async (): Promise<RestoreOutcome> => {
          try {
            // A second pass restores what another tab saved while the first waited on the proxy.
            for (let pass = 0; ; pass += 1) {
              // Another tab may have signed in with a new key, or logged out, since this page loaded.
              await useAuthStore.persist.rehydrate();
              if (restoreSessionPromise !== attempt) throw supersededLogin();
              const savedSignIn = readSavedSignIn();
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

              try {
                await get().login(
                  {
                    apiBase: resolvedBase,
                    managementKey: resolvedKey,
                    rememberPassword: resolvedRememberPassword,
                  },
                  // Another tab may log out, or sign in elsewhere, while the proxy answers.
                  () => readSavedSignIn() === savedSignIn
                );
                return { status: 'restored' };
              } catch (error) {
                const saveChanged =
                  restoreSessionPromise === attempt && readSavedSignIn() !== savedSignIn;
                if (pass > 0 || !saveChanged) throw error;
              }
            }
          } catch (error) {
            // Cancelled, logged out, or overtaken: there is no sign-in left to report on.
            if (isSuperseded(error)) return { status: 'none' };
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
        // Signed in already: the restore succeeded, and there is nothing left to cancel.
        if (!restoreSessionPromise || get().isAuthenticated) return;
        restoreSessionPromise = null;
        dropConnection();
      },

      clearLoginData: () => {
        get().logout();
        saveSignedOut(() => set({ apiBase: '', rememberPassword: false }));
      },

      // 登录
      login: async (credentials, stillWanted = () => true) => {
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
          if (!stillWanted()) {
            dropConnection();
            throw supersededLogin();
          }

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
        saveSignedOut(() =>
          set({
            isAuthenticated: false,
            managementKey: '',
            serverVersion: null,
            serverBuildDate: null,
            supportsPlugin: false,
            connectionStatus: 'disconnected',
          })
        );
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
          // A save this browser cannot read, or reads back garbled: start signed out.
          return isSavedAuth(data) ? JSON.stringify(data) : null;
        },
        setItem: (name, value) => {
          // A page that is not signed in holds only what it last read, and another tab may have
          // saved since: only a sign-in, a logout and a clear write the save every tab shares.
          if (!useAuthStore.getState().isAuthenticated && !savingSignedOut) return;
          obfuscatedStorage.setItem(name, JSON.parse(value));
        },
        removeItem: (name) => {
          obfuscatedStorage.removeItem(name);
        },
      })),
      // A save is taken whole: a field it leaves out (a key another tab chose not to remember)
      // must not survive from this page. Safe to reset, since a signed-in page never rehydrates.
      merge: (saved, current) => ({
        ...current,
        apiBase: '',
        managementKey: '',
        rememberPassword: false,
        serverVersion: null,
        serverBuildDate: null,
        ...(saved as Partial<AuthStoreState>),
      }),
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
