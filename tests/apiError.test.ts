import { describe, expect, test } from 'bun:test';
import { isRetryableConnectionError, parseApiErrorResponse } from '../src/services/api/apiError';

describe('Management API error parsing', () => {
  test('prefers the human-readable message and preserves the API error code', () => {
    const result = parseApiErrorResponse(
      {
        error: 'plugin_install_failed',
        message: 'download plugin archive: 404 Not Found',
      },
      'Request failed with status code 502'
    );

    expect(result).toEqual({
      message: 'download plugin archive: 404 Not Found',
      apiCode: 'plugin_install_failed',
    });
  });

  test('falls back to a string error used by legacy endpoints', () => {
    expect(parseApiErrorResponse({ error: 'invalid body' }, 'Bad Request')).toEqual({
      message: 'invalid body',
      apiCode: 'invalid body',
    });
  });

  test('supports nested error messages and codes', () => {
    expect(
      parseApiErrorResponse(
        { error: { code: 'invalid_config', message: 'plugins-dir is invalid' } },
        'Bad Request'
      )
    ).toEqual({
      message: 'plugins-dir is invalid',
      apiCode: 'invalid_config',
    });
  });

  test('uses a text response body before the transport fallback', () => {
    expect(parseApiErrorResponse('upstream unavailable', 'Network Error')).toEqual({
      message: 'upstream unavailable',
    });
  });

  test('uses the transport message for an unknown response shape', () => {
    expect(parseApiErrorResponse({ error: null }, 'Network Error')).toEqual({
      message: 'Network Error',
      apiCode: undefined,
    });
  });
});

describe('which connection failures are worth retrying', () => {
  test.each([
    ['no answer (network error)', { code: 'ERR_NETWORK' }, true],
    ['request timed out', { code: 'ECONNABORTED' }, true],
    ['request timed out (clarified)', { code: 'ETIMEDOUT' }, true],
    ['HTTP 408', { status: 408 }, true],
    ['HTTP 429', { status: 429 }, true],
    ['HTTP 499, just below server errors', { status: 499 }, false],
    ['HTTP 500', { status: 500 }, true],
    ['HTTP 503', { status: 503 }, true],
    ['HTTP 401 rejected key', { status: 401 }, false],
    ['HTTP 403 forbidden', { status: 403 }, false],
    ['HTTP 404 wrong address', { status: 404 }, false],
    ['a client bug', new TypeError('x is undefined'), false],
    ['a certificate error', { code: 'ERR_CERT_AUTHORITY_INVALID' }, false],
    ['nothing at all', undefined, false],
  ])('%s', (_label, error, retryable) => {
    expect(isRetryableConnectionError(error)).toBe(retryable);
  });
});
