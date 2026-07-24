/**
 * @agops-labs/sdk — MCP client helpers (F.3), for agent frameworks (LangChain/CrewAI) that consume
 * the AgentOps proxy as MCP tools rather than raw REST. Thin JSON-RPC 2.0 wrapper over the
 * `tools/list` and `tools/call` methods casper-guard/mcp.ts implements.
 */

export interface AgentOpsMcpClientConfig {
  /** Full URL to the MCP endpoint, e.g. https://host/v1/casper-guard/mcp. */
  url: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: { type: string; [key: string]: unknown };
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface AgentOpsMcpClient {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
}

let requestCounter = 0;

export function createAgentOpsMcpClient(config: AgentOpsMcpClientConfig): AgentOpsMcpClient {
  const fetchImpl = config.fetchImpl ?? fetch;

  async function call(method: 'tools/list' | 'tools/call', params?: Record<string, unknown>): Promise<unknown> {
    requestCounter += 1;
    const res = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `req-${requestCounter}`,
        method,
        ...(params ? { params } : {}),
      }),
    });
    const body = (await res.json()) as JsonRpcResponse;
    if (body.error) {
      throw new Error(body.error.message);
    }
    return body.result;
  }

  return {
    async listTools() {
      const result = (await call('tools/list')) as { tools: McpToolDescriptor[] };
      return result.tools;
    },

    async callTool<T>(name: string, args: Record<string, unknown>) {
      const result = (await call('tools/call', { name, arguments: args })) as { content: Array<{ type: string; text: string }> };
      return JSON.parse(result.content[0]!.text) as T;
    },
  };
}
