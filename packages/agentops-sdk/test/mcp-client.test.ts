import { describe, it, expect, vi } from 'vitest';
import { createAgentOpsMcpClient } from '../src/mcp.js';

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => ({
    status,
    ok: status < 400,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const BASE_URL = 'https://agentops.example/v1/casper-guard/mcp';

describe('createAgentOpsMcpClient (F.3 — MCP client helpers)', () => {
  it('callTool sends a JSON-RPC tools/call envelope with the given name and arguments', async () => {
    const fetchImpl = fakeFetch({
      jsonrpc: '2.0',
      id: 'req-1',
      result: { content: [{ type: 'text', text: JSON.stringify({ outcome: 'ALLOW', decision_id: 'cgd_1' }) }] },
    });
    const client = createAgentOpsMcpClient({ url: BASE_URL, apiKey: 'ag_live_abc', fetchImpl });

    const result = await client.callTool('casper_guard_authorize_payment', {
      agent_id: 'agt_1',
      idempotency_key: 'idem_1',
      payment_required: {},
    });

    expect(result).toEqual({ outcome: 'ALLOW', decision_id: 'cgd_1' });
    const call = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe(BASE_URL);
    const payload = JSON.parse(call[1].body as string);
    expect(payload).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'casper_guard_authorize_payment',
        arguments: { agent_id: 'agt_1', idempotency_key: 'idem_1', payment_required: {} },
      },
    });
    expect((call[1].headers as Record<string, string>).authorization).toBe('Bearer ag_live_abc');
  });

  it('listTools sends a JSON-RPC tools/list envelope and returns the tool array', async () => {
    const fetchImpl = fakeFetch({
      jsonrpc: '2.0',
      id: 'req-2',
      result: { tools: [{ name: 'casper_guard_create_agent', inputSchema: { type: 'object' } }] },
    });
    const client = createAgentOpsMcpClient({ url: BASE_URL, apiKey: 'sk_live_abc', fetchImpl });

    const tools = await client.listTools();

    expect(tools).toEqual([{ name: 'casper_guard_create_agent', inputSchema: { type: 'object' } }]);
    const payload = JSON.parse((vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(payload.method).toBe('tools/list');
  });

  it('throws with the JSON-RPC error message when the server returns an error envelope', async () => {
    const fetchImpl = fakeFetch({ jsonrpc: '2.0', id: 'req-3', error: { code: -32000, message: 'casper_guard_signer_not_configured' } });
    const client = createAgentOpsMcpClient({ url: BASE_URL, apiKey: 'ag_live_abc', fetchImpl });

    await expect(client.callTool('casper_guard_authorize_payment', {})).rejects.toThrow('casper_guard_signer_not_configured');
  });
});
