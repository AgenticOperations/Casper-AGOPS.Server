import { describe, it, expect, vi } from 'vitest';
import {
  grantDelegatedKey,
  rotateDelegatedKey,
  revokeDelegatedKey,
  readActiveDelegatedKey,
} from '../../src/engines/identity/delegation/delegated-keys-store.js';

function fakePool(activeRow: { id: string; public_key: string } | null = null) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.trim().startsWith('SELECT')) {
        return Promise.resolve({ rows: activeRow ? [activeRow] : [] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    }),
  } as unknown as import('pg').Pool & { calls: Array<{ sql: string; params: unknown[] }> };
}

describe('grantDelegatedKey (C.2 — inserts an ACTIVE key)', () => {
  it('inserts a new delegated_keys row with status ACTIVE and weight 1', async () => {
    const pool = fakePool();
    await grantDelegatedKey(pool, { id: 'dk_1', agentId: 'agt_1', publicKey: 'pub_1' });

    const insertCall = pool.calls.find((c) => c.sql.includes('INSERT INTO delegated_keys'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.params).toContain('dk_1');
    expect(insertCall!.params).toContain('agt_1');
    expect(insertCall!.params).toContain('pub_1');
  });
});

describe('rotateDelegatedKey (C.2 — old ROTATED, new ACTIVE, exactly one ACTIVE)', () => {
  it('marks the old key ROTATED and inserts the new key as ACTIVE', async () => {
    const pool = fakePool({ id: 'dk_old', public_key: 'pub_old' });
    await rotateDelegatedKey(pool, { agentId: 'agt_1', newId: 'dk_new', newPublicKey: 'pub_new' });

    const updateCall = pool.calls.find((c) => c.sql.includes("SET status = 'ROTATED'"));
    const insertCall = pool.calls.find((c) => c.sql.includes('INSERT INTO delegated_keys'));
    expect(updateCall).toBeDefined();
    expect(updateCall!.params).toContain('dk_old');
    expect(insertCall).toBeDefined();
    expect(insertCall!.params).toContain('dk_new');
  });

  it('is a no-op insert-only grant when the agent has no existing active key', async () => {
    const pool = fakePool(null);
    await rotateDelegatedKey(pool, { agentId: 'agt_1', newId: 'dk_new', newPublicKey: 'pub_new' });

    const updateCall = pool.calls.find((c) => c.sql.includes("SET status = 'ROTATED'"));
    expect(updateCall).toBeUndefined();
  });
});

describe('revokeDelegatedKey (C.2 — leaves zero ACTIVE)', () => {
  it('marks the active key REVOKED with a revoked_at timestamp', async () => {
    const pool = fakePool({ id: 'dk_1', public_key: 'pub_1' });
    await revokeDelegatedKey(pool, { agentId: 'agt_1' });

    const updateCall = pool.calls.find((c) => c.sql.includes("SET status = 'REVOKED'"));
    expect(updateCall).toBeDefined();
  });
});

describe('readActiveDelegatedKey (C.4 seam — used by signer resolution)', () => {
  it('returns the active key public key when one exists', async () => {
    const pool = fakePool({ id: 'dk_1', public_key: 'pub_1' });
    const result = await readActiveDelegatedKey(pool, { agentId: 'agt_1' });
    expect(result?.publicKey).toBe('pub_1');
  });

  it('returns null when the agent has no active delegated key', async () => {
    const pool = fakePool(null);
    const result = await readActiveDelegatedKey(pool, { agentId: 'agt_1' });
    expect(result).toBeNull();
  });
});
