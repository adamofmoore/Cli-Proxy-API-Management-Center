import { beforeEach, describe, expect, test } from 'bun:test';
import type { Config } from '../src/types';
import { useConfigStore } from '../src/stores/useConfigStore';
import {
  CHROME_141,
  CHROME_142,
  freshImport,
  installBrowserEnv,
  legacyObfuscate,
  SAVED_AUTH,
} from './helpers/browserEnv';

type AuthModule = typeof import('../src/stores/useAuthStore');
type AuthStore = AuthModule['useAuthStore'];

// Each call is a page reload: a fresh store that hydrates from whatever storage survived.
const reloadPage = async (): Promise<AuthStore> =>
  (await freshImport<AuthModule>('../src/stores/useAuthStore.ts')).useAuthStore;

let configRequests = 0;
const proxyAnswers = (respond: () => Promise<Config>) => {
  useConfigStore.setState({
    fetchConfig: async () => {
      configRequests += 1;
      return respond();
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

const signIn = (store: AuthStore, rememberPassword: boolean) =>
  store.getState().login({ apiBase: 'http://localhost:8317', managementKey: 'sk-live', rememberPassword });

describe('restoring a sign-in', () => {
  beforeEach(() => {
    installBrowserEnv(CHROME_141);
    configRequests = 0;
    proxyUp();
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
    expect(localStorage.getItem('cli-proxy-auth')).not.toContain('sk-live');
  });

  test('without remember-password, a new tab is signed out', async () => {
    await signIn(await reloadPage(), false);

    sessionStorage.clear();
    const store = await reloadPage();
    expect(await store.getState().restoreSession()).toEqual({ status: 'none' });
  });

  test('signing out also forgets the tab copy', async () => {
    const first = await reloadPage();
    await signIn(first, false);
    first.getState().logout();

    const store = await reloadPage();
    expect(await store.getState().restoreSession()).toEqual({ status: 'none' });
  });

  test('a reload while the proxy restarts keeps the key, and the next attempt gets back in', async () => {
    await signIn(await reloadPage(), true);
    const store = await reloadPage();

    proxyRestarting();
    const failed = await store.getState().restoreSession();
    expect(failed).toMatchObject({ status: 'failed', retryable: true });
    expect(store.getState().managementKey).toBe('sk-live');

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

  test('already signed in: visiting the login page does not sign in again', async () => {
    const store = await reloadPage();
    await signIn(store, true);
    configRequests = 0;

    expect(await store.getState().restoreSession()).toEqual({ status: 'restored' });
    expect(configRequests).toBe(0);
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
