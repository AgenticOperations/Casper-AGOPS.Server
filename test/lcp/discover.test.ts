import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { lcpDiscover } from '../../src/lib/lcp/discover.js';

function makeFetch(responses: Record<string, { status: number; body: string | object }>): typeof fetch {
  return async (input: string | URL | Request) => {
    // Narrow before stringifying: `Request` has no meaningful toString() and would yield
    // '[object Object]', silently missing every keyed response.
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const entry = responses[url];
    if (!entry) throw new Error(`unexpected_fetch_url: ${url}`);
    const body = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      json: async () => JSON.parse(body) as unknown,
      text: async () => body,
    } as Response;
  };
}

describe('lcpDiscover', () => {
  it('returns ok=false on network error', async () => {
    const result = await lcpDiscover('https://example.com/api', {
      fetchFn: async () => { throw new Error('network_down'); },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('fetch_failed');
  });

  it('returns ok=false on non-200 response', async () => {
    const result = await lcpDiscover('https://example.com/api', {
      fetchFn: makeFetch({ 'https://example.com/.well-known/legal-context.json': { status: 404, body: '' } }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('fetch_failed');
  });

  it('returns ok=false on parse error (missing terms field)', async () => {
    const result = await lcpDiscover('https://example.com/api', {
      fetchFn: makeFetch({
        'https://example.com/.well-known/legal-context.json': {
          status: 200,
          body: { notTerms: 'something' },
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('parse_error');
  });

  it('returns trustLevel=1, hashVerified=false when no atrHash', async () => {
    const result = await lcpDiscover('https://example.com/api', {
      fetchFn: makeFetch({
        'https://example.com/.well-known/legal-context.json': {
          status: 200,
          body: { terms: 'https://example.com/terms.md', acceptanceRequired: false },
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.trustLevel).toBe(1);
      expect(result.context.hashVerified).toBe(false);
      expect(result.context.atrHash).toBeNull();
    }
  });

  it('returns acceptanceRequired=true when merchant sets it', async () => {
    const result = await lcpDiscover('https://vendor.example/resource', {
      fetchFn: makeFetch({
        'https://vendor.example/.well-known/legal-context.json': {
          status: 200,
          body: { terms: 'https://vendor.example/terms.md', acceptanceRequired: true },
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.acceptanceRequired).toBe(true);
  });

  it('verifies atrHash and returns hashVerified=true on match', async () => {
    const termsContent = 'These are the terms of service v3.';
    const hash = `sha256:${createHash('sha256').update(termsContent).digest('hex')}`;
    const result = await lcpDiscover('https://vendor.example/api', {
      fetchFn: makeFetch({
        'https://vendor.example/.well-known/legal-context.json': {
          status: 200,
          body: { terms: 'https://vendor.example/terms.md', atrHash: hash, acceptanceRequired: true },
        },
        'https://vendor.example/terms.md': { status: 200, body: termsContent },
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.hashVerified).toBe(true);
      expect(result.context.atrHash).toBe(hash);
      expect(result.context.trustLevel).toBe(2);
    }
  });

  it('returns hash_mismatch when atrHash does not match terms content', async () => {
    const result = await lcpDiscover('https://vendor.example/api', {
      fetchFn: makeFetch({
        'https://vendor.example/.well-known/legal-context.json': {
          status: 200,
          body: {
            terms: 'https://vendor.example/terms.md',
            atrHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          },
        },
        'https://vendor.example/terms.md': { status: 200, body: 'Different content.' },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('hash_mismatch');
  });

  it('handles invalid resourceId gracefully', async () => {
    const result = await lcpDiscover('not-a-url', {
      fetchFn: async () => { throw new Error('should_not_be_called'); },
    });
    expect(result.ok).toBe(false);
  });
});
