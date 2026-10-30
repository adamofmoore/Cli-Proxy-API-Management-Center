import type { ApiError } from '@/types';
import { isRecord } from '@/utils/helpers';

export interface ParsedApiErrorResponse {
  message: string;
  apiCode?: string;
}

const readString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/**
 * Parse the Management API's error envelope.
 *
 * Newer endpoints use `error` as a stable machine-readable code and `message`
 * as the human-readable detail. Older endpoints may put the only useful text
 * directly in `error`, so that remains a fallback.
 */
export const parseApiErrorResponse = (
  responseData: unknown,
  fallbackMessage: string
): ParsedApiErrorResponse => {
  if (!isRecord(responseData)) {
    return {
      message: readString(responseData) || readString(fallbackMessage) || 'Request failed',
    };
  }

  const errorValue = responseData.error;
  const errorRecord = isRecord(errorValue) ? errorValue : null;
  const stringError = readString(errorValue);
  const apiCode = stringError || readString(errorRecord?.code) || undefined;
  const message =
    readString(responseData.message) ||
    readString(errorRecord?.message) ||
    stringError ||
    readString(fallbackMessage) ||
    'Request failed';

  return { message, apiCode };
};

// Axios codes for a request that never got an answer: the server is down, restarting or slow.
const UNANSWERED_REQUEST_CODES = new Set(['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT']);

/**
 * Whether the same request may succeed shortly: no answer, a timeout, rate limiting, or a
 * server-side failure. A rejected key, a wrong address (404) or a client bug is not.
 */
export const isRetryableConnectionError = (error: unknown): boolean => {
  const { status, code } = (error ?? {}) as Partial<ApiError>;
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500;
  return typeof code === 'string' && UNANSWERED_REQUEST_CODES.has(code);
};
