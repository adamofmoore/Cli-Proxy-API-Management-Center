import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Config } from '../src/types';
import { useConfigStore } from '../src/stores/useConfigStore';
import { apiClient } from '../src/services/api/client';
import { obfuscatedStorage } from '../src/services/storage/secureStorage';
import { configApi } from '../src/services/api/config';
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

  test('a key an older release kept outside the save restores, and is saved once it signs in', async () => {
    obfuscatedStorage.setItem('apiBase', SERVER_A);
    obfuscatedStorage.setItem('managementKey', 'sk-a');
    localStorage.setItem('isLoggedIn', 'true');

    const store = await reloadPage();
    expect(await store.getState().restoreSession()).toEqual({ status: 'restored' });
    expect(configRequests).toEqual(['sk-a']);
    expect(savedState()).toMatchObject({ apiBase: SERVER_A, managementKey: 'sk-a' });
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

    expect(await restoring).toEqual({ status: 'none' });
    expect(store.getState().isAuthenticated).toBe(false);
    expect(store.getState().connectionStatus).toBe('disconnected');
  });

  test('a restore cancelled before it has read the save does not sign in', async () => {
    await signIn(await reloadPage(), true);
    const store = await reloadPage();
    configRequests = [];

    const restoring = store.getState().restoreSession();
    store.getState().cancelRestore();

    expect(await restoring).toEqual({ status: 'none' });
    expect(store.getState().isAuthenticated).toBe(false);
    expect(configRequests).toEqual([]);
  });

  test('cancelling a restore drops its key from the client and its /config answer', async () => {
    await signIn(await reloadPage(), true);
    const store = await reloadPage();
    useConfigStore.setState({ fetchConfig: originalFetchConfig, config: null });
    const originalGetConfig = configApi.getConfig;
    let answer: () => void = () => {};
    configApi.getConfig = () => {
      configRequests.push(sentKey());
      return new Promise<Config>((resolve) => (answer = () => resolve({ debug: true } as Config)));
    };
    configRequests = [];
    try {
      const restoring = store.getState().restoreSession();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(configRequests).toEqual(['sk-a']);

      store.getState().cancelRestore();
      expect(sentKey()).toBe('');
      answer();
      await restoring;

      expect(useConfigStore.getState().config).toBeNull();
    } finally {
      configApi.getConfig = originalGetConfig;
    }
  });

  test('cancelling once the restore has signed in leaves that sign-in alone', async () => {
    await signIn(await reloadPage(), true);
    const store = await reloadPage();
    // Cancel at the first moment the store reports signed in, before restoreSession settles.
    const unsubscribe = store.subscribe((state) => {
      if (state.isAuthenticated) store.getState().cancelRestore();
    });

    expect(await store.getState().restoreSession()).toEqual({ status: 'restored' });
    unsubscribe();
    expect(store.getState().isAuthenticated).toBe(true);
    expect(sentKey()).toBe('sk-a');
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

  test("a second sign-in sends its own /config request instead of joining the first one's", async () => {
    // The real fetchConfig, which merges concurrent requests; only the network call is faked.
    useConfigStore.setState({ fetchConfig: originalFetchConfig });
    const originalGetConfig = configApi.getConfig;
    const answers = new Map<string, () => void>();
    configApi.getConfig = () => {
      const key = sentKey();
      configRequests.push(key);
      return new Promise<Config>((resolve) =>
        answers.set(key, () => resolve({ debug: key === 'sk-new' } as Config))
      );
    };
    try {
      const store = await reloadPage();
      const overtaken = signIn(store, true, 'sk-old');
      const current = signIn(store, true, 'sk-new');

      expect(configRequests).toEqual(['sk-old', 'sk-new']);
      answers.get('sk-new')?.();
      await current;
      answers.get('sk-old')?.();
      await expect(overtaken).rejects.toMatchObject({ name: 'LoginSupersededError' });
      expect(useConfigStore.getState().config).toMatchObject({ debug: true });
    } finally {
      configApi.getConfig = originalGetConfig;
    }
  });

  test('logging out drops the key from the API client, not only from the store', async () => {
    const store = await reloadPage();
    await signIn(store, true);

    store.getState().logout();
    expect(sentKey()).toBe('');
  });

  test('clearing login data forgets the server address and the remember choice too', async () => {
    const store = await reloadPage();
    await signIn(store, true);

    store.getState().clearLoginData();

    expect(store.getState()).toMatchObject({
      isAuthenticated: false,
      managementKey: '',
      apiBase: '',
      rememberPassword: false,
    });
  });

  test.each([
    ['a field name garbled', { serverBuilgDate: '2026-10-20T12:00:00Z' }],
    ['a value of the wrong type', { rememberPassword: 'true' }],
    ['a garbled address', { apiBase: 'hptp://server-a:8317' }],
    ['a key of the wrong type', { managementKey: 42 }],
    ['a server version of the wrong type', { serverVersion: 8 }],
    ['a build date of the wrong type', { serverBuildDate: false }],
    ['a field name garbled into a built-in one', { hasOwnProperty: 'apiBase' }],
  ])(
    'a save that parses but is garbled (%s, as an old save can read after a browser update) starts signed out',
    async (_label, damage) => {
      obfuscatedStorage.setItem('cli-proxy-auth', {
        state: { apiBase: SERVER_A, managementKey: 'sk-a', rememberPassword: true, ...damage },
        version: 0,
      });
      localStorage.setItem('isLoggedIn', 'true');

      const store = await reloadPage();
      expect(store.getState().managementKey).toBe('');
      expect(await store.getState().restoreSession()).toEqual({ status: 'none' });
      expect(configRequests).toEqual([]);
    }
  );

  test.each([
    [
      'before rememberPassword (v1.0-v1.14)',
      { apiBase: SERVER_A, managementKey: 'sk-a', serverVersion: null, serverBuildDate: null },
    ],
    [
      'with serverRuntimeKind (v1.15-v1.19)',
      {
        apiBase: SERVER_A,
        managementKey: 'sk-a',
        rememberPassword: true,
        serverVersion: 'v7.2.142',
        serverBuildDate: null,
        serverRuntimeKind: 'cpa',
      },
    ],
  ])('a save from an older release is still accepted: %s', async (_label, state) => {
    obfuscatedStorage.setItem('cli-proxy-auth', { state, version: 0 });
    localStorage.setItem('isLoggedIn', 'true');

    const store = await reloadPage();
    expect(await store.getState().restoreSession()).toEqual({ status: 'restored' });
  });

  test('everything this release saves passes the check that a save is readable', async () => {
    const { useAuthStore, isSavedAuth } = await freshImport<AuthModule>(
      '../src/stores/useAuthStore.ts'
    );
    const { partialize } = useAuthStore.persist.getOptions();
    const signedIn = {
      ...useAuthStore.getState(),
      apiBase: SERVER_A,
      managementKey: 'sk-a',
      rememberPassword: true,
      serverVersion: 'v8.0.23',
      serverBuildDate: '2026-10-20T12:00:00Z',
    };

    expect(isSavedAuth({ state: partialize?.(signedIn), version: 0 })).toBe(true);
  });

  test('a retry uses the key another tab signed in with since this page loaded', async () => {
    await signIn(await reloadPage(), true, 'sk-a');
    const thisTab = await reloadPage();
    proxyRestarting();
    await thisTab.getState().restoreSession();

    proxyUp();
    await signIn(await reloadPage(), true, 'sk-b');
    configRequests = [];

    expect(await thisTab.getState().restoreSession()).toEqual({ status: 'restored' });
    expect(configRequests).toEqual(['sk-b']);
  });

  test('a retry does not sign back in after another tab logged out', async () => {
    await signIn(await reloadPage(), true);
    const thisTab = await reloadPage();
    proxyRestarting();
    await thisTab.getState().restoreSession();

    const otherTab = await reloadPage();
    await otherTab.getState().restoreSession();
    otherTab.getState().logout();
    proxyUp();
    configRequests = [];

    expect(await thisTab.getState().restoreSession()).toEqual({ status: 'none' });
    expect(configRequests).toEqual([]);
  });

  test.each([
    ['signed in without remember-password', (tab: AuthStore) => signIn(tab, false, 'sk-b')],
    ['cleared the login data', async (tab: AuthStore) => tab.getState().clearLoginData()],
  ])(
    "a retry after another tab %s does not keep or save this page's old key",
    async (_label, otherTabAction) => {
      await signIn(await reloadPage(), true);
      const thisTab = await reloadPage();
      proxyRestarting();
      await thisTab.getState().restoreSession();

      proxyUp();
      const otherTab = await reloadPage();
      await otherTab.getState().restoreSession();
      await otherTabAction(otherTab);

      expect(await thisTab.getState().restoreSession()).toEqual({ status: 'none' });
      // Nor keeps it to offer in the login form.
      expect(thisTab.getState().managementKey).toBe('');
      expect(savedState().managementKey ?? '').toBe('');
      expect(savedState().rememberPassword).toBe(false);
    }
  );

  test('a logout in another tab while the proxy is answering is not undone', async () => {
    await signIn(await reloadPage(), true);
    const thisTab = await reloadPage();
    let answer: () => void = () => {};
    proxyAnswers(() => new Promise<Config>((resolve) => (answer = () => resolve({} as Config))));
    const restoring = thisTab.getState().restoreSession();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const otherTab = await reloadPage();
    otherTab.getState().logout();
    answer();

    expect(await restoring).toEqual({ status: 'none' });
    expect(thisTab.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem('isLoggedIn')).toBeNull();
    expect(savedState().managementKey).toBe('');
  });

  test('a sign-in in another tab while the proxy is answering is restored instead', async () => {
    await signIn(await reloadPage(), true, 'sk-a');
    const thisTab = await reloadPage();
    let answerFirst: () => void = () => {};
    proxyAnswers((key) =>
      key === 'sk-a'
        ? new Promise<Config>((resolve) => (answerFirst = () => resolve({} as Config)))
        : Promise.resolve({} as Config)
    );
    configRequests = [];
    const restoring = thisTab.getState().restoreSession();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await signIn(await reloadPage(), true, 'sk-b');
    answerFirst();

    expect(await restoring).toEqual({ status: 'restored' });
    expect(configRequests).toEqual(['sk-a', 'sk-b', 'sk-b']);
    expect(thisTab.getState().managementKey).toBe('sk-b');
    expect(savedState().managementKey).toBe('sk-b');
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
