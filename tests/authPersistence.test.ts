import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  CHROME_141,
  CHROME_142,
  freshImport,
  installBrowserEnv,
  legacyObfuscate,
  SAVED_AUTH,
  setUserAgent,
  uninstallBrowserEnv,
} from './helpers/browserEnv';

type EncryptionModule = typeof import('../src/utils/encryption');
const loadEncryption = () => freshImport<EncryptionModule>('../src/utils/encryption.ts');

describe('saved login survives browser updates', () => {
  beforeEach(() => installBrowserEnv(CHROME_141));
  afterEach(() => uninstallBrowserEnv());

  test('a value saved on one Chrome version reads back after Chrome updates', async () => {
    const before = await loadEncryption();
    const saved = before.obfuscateData(SAVED_AUTH);

    setUserAgent(CHROME_142);
    const after = await loadEncryption();

    expect(after.deobfuscateData(saved)).toBe(SAVED_AUTH);
  });

  test('a value saved by an earlier release is still read, then rewritten so updates cannot break it', async () => {
    const { obfuscatedStorage } = await import('../src/services/storage/secureStorage');
    localStorage.setItem('cli-proxy-auth', legacyObfuscate(SAVED_AUTH, CHROME_141));

    expect(obfuscatedStorage.getItem('cli-proxy-auth')).toEqual(JSON.parse(SAVED_AUTH));

    setUserAgent(CHROME_142);
    const after = await loadEncryption();
    expect(after.deobfuscateData(localStorage.getItem('cli-proxy-auth') as string)).toBe(
      SAVED_AUTH
    );
  });
});
