import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Config } from '../src/types';
import { useConfigStore } from '../src/stores/useConfigStore';
import { obfuscatedSessionStorage, obfuscatedStorage } from '../src/services/storage/secureStorage';
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
const SERVER_B = 'http://server-b:8317';

// Each call is a page reload: a fresh store that hydrates from whatever storage survived.
const reloadPage = async (): Promise<AuthStore> =>
  (await freshImport<AuthModule>('../src/stores/useAuthStore.ts')).useAuthStore;

const originalFetchConfig = useConfigStore.getState().fetchConfig;
let configRequests: string[] = [];
const proxyAnswers = (respond: (key: string) => Promise<Config>) => {
  useConfigStore.setState({
    fetchConfig: async () => {
      // The key the API client would send: the one the latest login configured.
      const { apiClient } = await import('../src/services/api/client');
      const key = (apiClient as unknown as { managementKey: string }).managementKey;
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
const proxyRejectsKey = () =>
  proxyAnswers(async () => {
    throw Object.assign(new Error('invalid management key'), { status: 401 });
  });

const signIn = (store: AuthStore, rememberPassword: boolean, apiBase = SERVER_A, key = 'sk-a') =>
  store.getState().login({ apiBase, managementKey: key, rememberPassword });

const rememberedState = () =>
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
  });

  test('without remember-password, a reload in the same tab stays signed in', async () => {
    await signIn(await reloadPage(), false);

    const store = await reloadPage();
    expect(await store.getState().restoreSession()).toEqual({ status: 'restored' });
    expect(rememberedState().managementKey).toBeUndefined();
  });

  test('without remember-password, the key is never remembered, even across failed restores', async () => {
    await signIn(await reloadPage(), false);
    const store = await reloadPage();

    proxyRestarting();
    await store.getState().restoreSession();
    proxyUp();
    expect(await store.getState().restoreSession()).toEqual({ status: 'restored' });

    expect(rememberedState().managementKey).toBeUndefined();
    expect(rememberedState().rememberPassword).toBe(false);
  });

  test('without remember-password, a fresh browser session is signed out', async () => {
    await signIn(await reloadPage(), false);

    sessionStorage.clear();
    const store = await reloadPage();
    expect(await store.getState().restoreSession()).toEqual({ status: 'none' });
  });

  test("a tab never sends its key to the server another tab signed into", async () => {
    // Tab 1 signs into A; tab 2 (same browser, its own tab storage) signs into B. Neither remembers.
    await signIn(await reloadPage(), false, SERVER_A, 'sk-a');
    const tab1Session = sessionStorage.getItem('cli-proxy-auth-session');
    sessionStorage.clear();
    await signIn(await reloadPage(), false, SERVER_B, 'sk-b');

    // Tab 1 reloads: the shared storage now names B.
    sessionStorage.clear();
    sessionStorage.setItem('cli-proxy-auth-session', tab1Session as string);
    const store = await reloadPage();
    configRequests = [];
    expect(await store.getState().restoreSession()).toEqual({ status: 'restored' });
    expect(store.getState().apiBase).toBe(SERVER_A);
    expect(configRequests).toEqual(['sk-a']);
  });

  test('signing out forgets the key but keeps the server address for the login form', async () => {
    const first = await reloadPage();
    await signIn(first, false);
    first.getState().logout();
    expect(first.getState().apiBase).toBe(SERVER_A);

    const store = await reloadPage();
    expect(await store.getState().restoreSession()).toEqual({ status: 'none' });
  });

  test('a reload while the proxy restarts keeps the key, and the next attempt gets back in', async () => {
    await signIn(await reloadPage(), true);
    const store = await reloadPage();

    proxyRestarting();
    const failed = await store.getState().restoreSession();
    expect(failed).toMatchObject({ status: 'failed', retryable: true });
    expect(store.getState().managementKey).toBe('sk-a');

    proxyUp();
    expect(await store.getState().restoreSession()).toEqual({ status: 'restored' });
  });

  test('a rejected key is not worth retrying', async () => {
    await signIn(await reloadPage(), true);
    const store = await reloadPage();

    proxyRejectsKey();
    expect(await store.getState().restoreSession()).toMatchObject({
      status: 'failed',
      retryable: false,
    });
  });

  test('storage that throws ends in a failure, not a restore that never settles', async () => {
    await signIn(await reloadPage(), false);
    const store = await reloadPage();
    sessionStorage.getItem = () => {
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
    let answerFirst: () => void = () => {};
    proxyAnswers(
      (key) =>
        new Promise<Config>((resolve) => {
          if (key === 'sk-old') answerFirst = () => resolve({} as Config);
          else resolve({} as Config);
        })
    );

    const overtaken = signIn(store, false, SERVER_A, 'sk-old');
    await signIn(store, false, SERVER_A, 'sk-new');
    answerFirst();

    await expect(overtaken).rejects.toMatchObject({ name: 'LoginSupersededError' });
    expect(store.getState().managementKey).toBe('sk-new');
    expect(obfuscatedSessionStorage.getItem<{ managementKey: string }>('cli-proxy-auth-session'))
      .toMatchObject({ managementKey: 'sk-new' });
  });

  test('a key from before the auth store is not used after its owner logged out', async () => {
    localStorage.setItem('managementKey', JSON.stringify('sk-legacy'));
    localStorage.setItem('apiBase', JSON.stringify(SERVER_A));

    const store = await reloadPage();
    expect(await store.getState().restoreSession()).toEqual({ status: 'none' });
    expect(localStorage.getItem('managementKey')).toBeNull();
  });

  test('a key from before the auth store still signs in a user who never logged out', async () => {
    localStorage.setItem('managementKey', JSON.stringify('sk-legacy'));
    localStorage.setItem('apiBase', JSON.stringify(SERVER_A));
    localStorage.setItem('isLoggedIn', 'true');

    const store = await reloadPage();
    expect(await store.getState().restoreSession()).toEqual({ status: 'restored' });
    expect(configRequests).toEqual(['sk-legacy']);
    expect(localStorage.getItem('isLoggedIn')).toBeNull();
  });

  test('a saved sign-in this browser cannot read starts signed out, not with scrambled state', async () => {
    localStorage.setItem('cli-proxy-auth', legacyObfuscate(SAVED_AUTH, CHROME_142));

    const store = await reloadPage();
    const state = store.getState() as unknown as Record<string, unknown>;
    expect(state.managementKey).toBe('');
    expect(Object.keys(state)).not.toContain('0');
    expect(await store.getState().restoreSession()).toEqual({ status: 'none' });
  });
});
