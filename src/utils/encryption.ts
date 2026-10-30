/**
 * 本地存储混淆工具函数（可逆）
 * 从原项目 src/utils/secure-storage.js 迁移
 *
 * IMPORTANT: 这不是安全边界。浏览器端长期持久化的密钥仍应视为可被读取。
 */

// v1 keyed the bytes to the user-agent, so every browser update made saved values unreadable.
// v2 keys them to the host alone; v1 is still read so existing values can be migrated.
const ENC_PREFIX = 'enc::v2::';
const LEGACY_ENC_PREFIX = 'enc::v1::';
const SECRET_SALT = 'cli-proxy-api-webui::secure-storage';

let cachedKeyBytes: Uint8Array | null = null;

function encodeText(text: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(text);
}

function decodeText(bytes: Uint8Array): string {
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}

function getKeyBytes(): Uint8Array {
  if (cachedKeyBytes) return cachedKeyBytes;

  try {
    cachedKeyBytes = encodeText(`${SECRET_SALT}|${window.location.host}`);
  } catch (error) {
    console.warn('Obfuscation fallback to simple key:', error);
    cachedKeyBytes = encodeText(SECRET_SALT);
  }

  return cachedKeyBytes;
}

function getLegacyKeyBytes(): Uint8Array {
  try {
    return encodeText(`${SECRET_SALT}|${window.location.host}|${navigator.userAgent}`);
  } catch {
    return encodeText(SECRET_SALT);
  }
}

function xorBytes(data: Uint8Array, keyBytes: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = data[i] ^ keyBytes[i % keyBytes.length];
  }
  return result;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 加密数据
 */
export function obfuscateData(value: string): string {
  if (!value) return value;

  try {
    const keyBytes = getKeyBytes();
    const encrypted = xorBytes(encodeText(value), keyBytes);
    return `${ENC_PREFIX}${toBase64(encrypted)}`;
  } catch (error) {
    console.warn('Obfuscation failed, fallback to plaintext:', error);
    return value;
  }
}

/**
 * 解密数据
 */
export function deobfuscateData(payload: string): string {
  const prefix = payload?.startsWith(ENC_PREFIX)
    ? ENC_PREFIX
    : payload?.startsWith(LEGACY_ENC_PREFIX)
      ? LEGACY_ENC_PREFIX
      : null;
  if (!prefix) {
    return payload;
  }

  try {
    const encrypted = fromBase64(payload.slice(prefix.length));
    const keyBytes = prefix === ENC_PREFIX ? getKeyBytes() : getLegacyKeyBytes();
    return decodeText(xorBytes(encrypted, keyBytes));
  } catch (error) {
    console.warn('Deobfuscation failed, return as-is:', error);
    return payload;
  }
}

/**
 * 检查是否已加密
 */
export function isObfuscated(value: string): boolean {
  return value?.startsWith(ENC_PREFIX) || isLegacyObfuscated(value);
}

/**
 * Whether the value uses the user-agent-keyed v1 format, which a browser update can make unreadable.
 */
export function isLegacyObfuscated(value: string): boolean {
  return value?.startsWith(LEGACY_ENC_PREFIX) || false;
}
