import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Config } from '../src/types';
import { useConfigStore } from '../src/stores/useConfigStore';
import { apiClient } from '../src/services/api/client';
import { obfuscatedStorage } from '../src/services/storage/secureStorage';
import {
  CHROME_141,
  CHROME_142,
  freshImport,
  installBrowserEnv,
  legacyObfuscate,
  SAVED_AUTH,
  uninstallBrowserEnv,
} from './helpers/browserEnv';

type AuthModule = typeof import('../src/stores/useAuthStore');
type AuthStore = AuthModule['useAuthStore'];

const SERVER_A = 'http://server-a:8317';

// Each call is a page reload (or another tab): a fresh store hydrated from shared storage.
const reloadPage = async (): Promise<AuthStore> =>
  (await freshImport<AuthModule>('../src/stores/useAuthStore.ts')).useAuthStore;

const originalFetchConfig = useConfigStore.getState().fetchConfig;
let configRequests: string[] = [];
// The key the API client sends: whatever the latest login configured, read when the request starts.
const sentKey = () => (apiClient as unknown as { managementKey: string }).managementKey;
const proxyAnswers = (respond: (key: string) => Promise<Config>) => {
  useConfigStore.setState({
    fetchConfig: () => {
      const key = sentKey();
      configRequests.push(key);
      return respond(key);
    },
  });
};
const proxyUp = () => proxyAnswers(async () => ({}) as Config);
const proxyRestarting = () =>
  proxyAnswers(async () => {
    throw Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
  });
// What the real client does on a 401: announce it (the store logs out), then reject.
const proxyRejectsKey = () =>
  proxyAnswers(async () => {
    window.dispatchEvent(new Event('unauthorized'));
    throw Object.assign(new Error('invalid management key'), { status: 401 });
  });

const signIn = (store: AuthStore, rememberPassword: boolean, key = 'sk-a') =>
  store.getState().login({ apiBase: SERVER_A, managementKey: key, rememberPassword });

const savedState = () =>
  obfuscatedStorage.getItem<{ state: Record<string, unknown> }>('cli-proxy-auth')?.state ?? {};

describe('restoring a sign-in', () => {
  beforeEach(() => {
    installBrowserEnv(CHROME_141);
    configRequests = [];
    proxyUp();
  });
  afterEach(() => {
    useConfigStore.setState({ fetchConfig: originalFetchConfig });
    uninstallBrowserEnv();
  });

  test('a remembered sign-in is restored after a reload', async () => {
    await signIn(await reloadPage(), true);

    const store = await reloadPage();
    expect(await store.getState().restoreSession()).toEqual({ status: 'restored' });
    expect(store.getState().isAuthenticated).toBe(true);
    expect(configRequests.at(-1)).toBe('sk-a');
  });

  test('without remember-password, nothing is saved and a reload signs out', async () => {
    await signIn(await reloadPage(), false);
    expect(savedState().managementKey).toBeUndefined();

    const store = await reloadPage();
    expect(await store.getState().restoreSession()).toEqual({ status: 'none' });
  });

  test('logging out in one tab is not undone by another tab that still holds the key', async () => {
    const otherTab = await reloadPage();
    await signIn(otherTab, true);
    const thisTab = await reloadPage();
    await thisTab.getState().restoreSession();

    thisTab.getState().logout();
    // The other tab is still signed in, and any update rewrites its state, key included.
    otherTab.getState().updateServerVersion('v8.0.23');
    expect(savedState().managementKey).toBe('sk-a');

    const newTab = await reloadPage();
    expect(await newTab.getState().restoreSession()).toEqual({ status: 'none' });
  });

  test('a key saved without a sign-in (as an older release migrated it) does not sign in', async () => {
    obfuscatedStorage.setItem('cli-proxy-auth', {
      state: { apiBase: SERVER_A, managementKey: 'sk-a', rememberPassword: true },
      version: 0,
    });

    const store = await reloadPage();
    expect(await store.getState().restoreSession()).toEqual({ status: 'none' });
    expect(configRequests).toEqual([]);
  });

  test('a reload while the proxy restarts keeps the key, and the next attempt gets back in', async () => {
    await signIn(await reloadPage(), true);
    const store = await reloadPage();

    proxyRestarting();
    expect(await store.getState().restoreSession()).toMatchObject({
      status: 'failed',
      retryable: true,
    });
    expect(store.getState().managementKey).toBe('sk-a');

    proxyUp();
    expect(await store.getState().restoreSession()).toEqual({ status: 'restored' });
  });

  test('a rejected key signs out, is not retried, and keeps the server address for the form', async () => {
    await signIn(await reloadPage(), true);
    const store = await reloadPage();

    proxyRejectsKey();
    expect(await store.getState().restoreSession()).toMatchObject({
      status: 'failed',
      retryable: false,
    });
    expect(store.getState().managementKey).toBe('');
    expect(store.getState().apiBase).toBe(SERVER_A);
    expect(localStorage.getItem('isLoggedIn')).toBeNull();
  });

  test('storage that throws ends in a failure, not a restore that never settles', async () => {
    await signIn(await reloadPage(), true);
    const store = await reloadPage();
    localStorage.getItem = () => {
      throw new DOMException('denied', 'SecurityError');
    };

    expect(await store.getState().restoreSession()).toMatchObject({
      status: 'failed',
      retryable: false,
    });
  });

  test('already signed in: visiting the login page does not sign in again', async () => {
    const store = await reloadPage();
    await signIn(store, true);
    configRequests = [];

    expect(await store.getState().restoreSession()).toEqual({ status: 'restored' });
    expect(configRequests).toEqual([]);
  });

  test('a restore cancelled while the proxy is still answering does not sign in', async () => {
    await signIn(await reloadPage(), true);
    const store = await reloadPage();
    let answer: () => void = () => {};
    proxyAnswers(() => new Promise<Config>((resolve) => (answer = () => resolve({} as Config))));

    const restoring = store.getState().restoreSession();
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.getState().cancelRestore();
    answer();

    expect(await restoring).toMatchObject({ status: 'failed', retryable: false });
    expect(store.getState().isAuthenticated).toBe(false);
  });

  test('a sign-in overtaken by a newer one never commits its credentials', async () => {
    const store = await reloadPage();
    let answerOld: () => void = () => {};
    proxyAnswers(
      (key) =>
        new Promise<Config>((resolve) => {
          if (key === 'sk-old') answerOld = () => resolve({} as Config);
          else resolve({} as Config);
        })
    );

    const overtaken = signIn(store, true, 'sk-old');
    await signIn(store, true, 'sk-new');
    expect(configRequests).toEqual(['sk-old', 'sk-new']);
    answerOld();

    await expect(overtaken).rejects.toMatchObject({ name: 'LoginSupersededError' });
    expect(store.getState().managementKey).toBe('sk-new');
    expect(savedState().managementKey).toBe('sk-new');
  });

  test('a saved sign-in this browser cannot read starts signed out, not with scrambled state', async () => {
    localStorage.setItem('cli-proxy-auth', legacyObfuscate(SAVED_AUTH, CHROME_142));
    localStorage.setItem('isLoggedIn', 'true');

    const store = await reloadPage();
    const state = store.getState() as unknown as Record<string, unknown>;
    expect(state.managementKey).toBe('');
    expect(Object.keys(state)).not.toContain('0');
    expect(await store.getState().restoreSession()).toEqual({ status: 'none' });
  });
});
