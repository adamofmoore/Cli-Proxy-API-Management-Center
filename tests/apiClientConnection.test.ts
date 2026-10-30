import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AxiosError, type AxiosAdapter, type AxiosResponse } from 'axios';
import { apiClient } from '../src/services/api/client';
import { installBrowserEnv, uninstallBrowserEnv } from './helpers/browserEnv';

/** An adapter whose single response the test releases by hand, once the request is on the wire. */
function heldResponse(status: number, headers: Record<string, string> = {}) {
  let answer: () => void = () => {};
  let markSent: () => void = () => {};
  const sent = new Promise<void>((resolve) => (markSent = resolve));
  const adapter: AxiosAdapter = (config) =>
    new Promise((resolve, reject) => {
      answer = () => {
        const response = { data: {}, status, statusText: '', headers, config } as AxiosResponse;
        if (status < 400) resolve(response);
        else reject(new AxiosError(`status ${status}`, 'ERR_BAD_REQUEST', config, null, response));
      };
      markSent();
    });
  return { adapter, sent, release: () => answer() };
}

const recordEvents = (name: string) => {
  const seen: Event[] = [];
  window.addEventListener(name, (event) => seen.push(event));
  return seen;
};

describe('responses from an earlier connection', () => {
  beforeEach(() => {
    installBrowserEnv();
    apiClient.setConfig({ apiBase: 'http://server-a:8317', managementKey: 'sk-a' });
  });
  afterEach(() => uninstallBrowserEnv());

  test('a 401 on the current connection signs out', async () => {
    const unauthorized = recordEvents('unauthorized');
    const held = heldResponse(401);
    const request = apiClient.get('/config', { adapter: held.adapter });
    await held.sent;

    held.release();
    await request.catch(() => {});
    expect(unauthorized.length).toBe(1);
  });

  test('a late 401 to a request from before a new sign-in does not sign the new one out', async () => {
    const unauthorized = recordEvents('unauthorized');
    const held = heldResponse(401);
    const request = apiClient.get('/config', { adapter: held.adapter });
    await held.sent;

    apiClient.setConfig({ apiBase: 'http://server-b:8317', managementKey: 'sk-b' });
    held.release();

    await expect(request).rejects.toMatchObject({ status: 401 });
    expect(unauthorized.length).toBe(0);
  });

  test("the current server's version and plugin support are announced", async () => {
    const versions = recordEvents('server-version-update');
    const plugins = recordEvents('server-plugin-support-update');
    const held = heldResponse(200, { 'x-cpa-version': 'v8.0.23', 'x-cpa-support-plugin': 'true' });
    const request = apiClient.get('/config', { adapter: held.adapter });
    await held.sent;

    held.release();
    await request;
    expect(versions.length).toBe(1);
    expect(plugins.length).toBe(1);
  });

  test('a late 401 after logging out does not fire another sign-out', async () => {
    const unauthorized = recordEvents('unauthorized');
    const held = heldResponse(401);
    const request = apiClient.get('/config', { adapter: held.adapter });
    await held.sent;

    apiClient.disconnect();
    held.release();

    await expect(request).rejects.toMatchObject({ status: 401 });
    expect(unauthorized.length).toBe(0);
  });

  test("a late answer from the previous server does not relabel the new server's version", async () => {
    const versions = recordEvents('server-version-update');
    const plugins = recordEvents('server-plugin-support-update');
    const held = heldResponse(200, {
      'x-cpa-version': 'v1.0.0-old',
      'x-cpa-support-plugin': 'true',
    });
    const request = apiClient.get('/config', { adapter: held.adapter });
    await held.sent;

    apiClient.setConfig({ apiBase: 'http://server-b:8317', managementKey: 'sk-b' });
    held.release();

    await request;
    expect(versions.length).toBe(0);
    expect(plugins.length).toBe(0);
  });
});
