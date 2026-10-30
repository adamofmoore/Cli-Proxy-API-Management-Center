class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.has(key) ? (this.values.get(key) as string) : null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
}

export const BROWSER_HOST = 'localhost:8317';
export const CHROME_141 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export const CHROME_142 = CHROME_141.replace('Chrome/141', 'Chrome/142');

// The format every release before this one wrote: the key bytes included the user-agent.
export const legacyObfuscate = (value: string, userAgent: string) => {
  const key = new TextEncoder().encode(
    `cli-proxy-api-webui::secure-storage|${BROWSER_HOST}|${userAgent}`
  );
  const bytes = new TextEncoder().encode(value).map((b, i) => b ^ key[i % key.length]);
  return `enc::v1::${btoa(String.fromCharCode(...bytes))}`;
};

// Shaped like the real persisted auth state: long enough to reach the user-agent's key bytes.
export const SAVED_AUTH = JSON.stringify({
  state: {
    apiBase: 'http://localhost:8317',
    managementKey: 'sk-live-0123456789abcdef0123456789abcdef',
    rememberPassword: true,
    serverVersion: 'v8.0.23',
    serverBuildDate: '2026-10-20T12:00:00Z',
  },
  version: 0,
});

const g = globalThis as unknown as Record<string, unknown>;
const INSTALLED_GLOBALS = ['localStorage', 'window'] as const;
let saved: { globals: Map<string, PropertyDescriptor | undefined>; userAgent?: PropertyDescriptor } | null =
  null;

/** Installs the browser globals the auth stores read, with empty storage. Undo with `uninstallBrowserEnv`. */
export function installBrowserEnv(userAgent = CHROME_141) {
  if (!saved) {
    saved = {
      globals: new Map(INSTALLED_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(g, name)])),
      userAgent: Object.getOwnPropertyDescriptor(globalThis.navigator, 'userAgent'),
    };
  }
  const events = new EventTarget();
  g.localStorage = new MemoryStorage();
  g.window = {
    location: { protocol: 'http:', hostname: 'localhost', port: '8317', host: BROWSER_HOST },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  setUserAgent(userAgent);
}

/** Puts back whatever globals existed before `installBrowserEnv`. */
export function uninstallBrowserEnv() {
  if (!saved) return;
  for (const [name, descriptor] of saved.globals) {
    if (descriptor) Object.defineProperty(g, name, descriptor);
    else delete g[name];
  }
  if (saved.userAgent) Object.defineProperty(globalThis.navigator, 'userAgent', saved.userAgent);
  else delete (globalThis.navigator as unknown as Record<string, unknown>).userAgent;
  saved = null;
}

export function setUserAgent(userAgent: string) {
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    configurable: true,
    get: () => userAgent,
  });
}

let reloadCount = 0;

/**
 * A fresh copy of a module, as a page reload would evaluate it. Its own imports stay shared.
 * `path` is relative to the tests directory.
 */
export function freshImport<T>(path: string): Promise<T> {
  reloadCount += 1;
  const file = new URL(path, new URL('../', import.meta.url)).pathname;
  return import(`${file}?reload=${reloadCount}`) as Promise<T>;
}
