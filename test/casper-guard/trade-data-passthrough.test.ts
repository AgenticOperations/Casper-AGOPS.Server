import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { buildCasperGuardDeps } from '../../src/config/casper-guard.js';
import {
  CSPR_TRADE_READ_ONLY_TOOLS,
  isCsprTradeReadOnlyTool,
  callCsprTradeReadOnly,
} from '../../src/lib/casper/cspr-trade.js';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://agentops:agentops@localhost:5432/agentops',
  REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.arc-testnet.example',
  ARC_CHAIN_ID: '5042002',
  ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
};

const SELF_HOSTED_TESTNET = 'https://casper-agops-trademcp-production.up.railway.app/mcp';
const PUBLIC_MAINNET = 'https://mcp.cspr.trade/mcp';

/*
 * The allowlist is the security boundary between "an agent can read the market" and "an agent can
 * assemble and broadcast a swap without a Guard decision". These tests pin that boundary.
 */
describe('CSPR.trade read-only allowlist', () => {
  it('permits market-data reads', () => {
    for (const tool of ['get_tokens', 'get_pairs', 'get_quote', 'estimate_price_impact']) {
      expect(isCsprTradeReadOnlyTool(tool)).toBe(true);
    }
  });

  it('EXCLUDES every fund-moving tool the venue exposes', () => {
    // Reaching any of these directly would bypass authorize_action — no spend cap, no service
    // scope, no velocity limit, no hold. They must never be reachable through the passthrough.
    for (const tool of [
      'build_swap',
      'build_approve_token',
      'build_add_liquidity',
      'build_remove_liquidity',
      'submit_transaction',
    ]) {
      expect(isCsprTradeReadOnlyTool(tool)).toBe(false);
      expect(CSPR_TRADE_READ_ONLY_TOOLS as readonly string[]).not.toContain(tool);
    }
  });

  it('rejects a non-allowlisted tool before any network call is made', async () => {
    // An unreachable URL proves the rejection happens at the boundary, not after dialling out:
    // if the allowlist were bypassed this would fail with a fetch error instead.
    await expect(
      callCsprTradeReadOnly('http://127.0.0.1:1/mcp', 'submit_transaction', {}),
    ).rejects.toThrow(/cspr_trade_tool_not_permitted: submit_transaction/);
  });

  it('rejects an unknown tool name', async () => {
    await expect(
      callCsprTradeReadOnly('http://127.0.0.1:1/mcp', 'definitely_not_a_tool', {}),
    ).rejects.toThrow(/cspr_trade_tool_not_permitted/);
  });
});

describe('trade data venue URLs by network', () => {
  it('exposes both venues for reads even when only testnet can EXECUTE', () => {
    // Execution is testnet-only here (no mainnet signer, mainnet not in CASPER_GUARD_NETWORKS),
    // but mainnet market data is still readable — reading a quote moves no funds.
    const deps = buildCasperGuardDeps(
      loadEnv({
        ...BASE_ENV,
        CSPR_TRADE_MCP_URL: SELF_HOSTED_TESTNET,
        CSPR_TRADE_MAINNET_MCP_URL: PUBLIC_MAINNET,
      } as NodeJS.ProcessEnv),
    );
    expect(deps.tradeDataUrls?.['casper:casper-test']).toBe(SELF_HOSTED_TESTNET);
    expect(deps.tradeDataUrls?.['casper:casper']).toBe(PUBLIC_MAINNET);
    // Execution slot for mainnet is absent — reads and execution are genuinely decoupled.
    expect(deps.byNetwork?.['casper:casper']).toBeUndefined();
  });

  it('omits a venue that is not configured', () => {
    const deps = buildCasperGuardDeps(
      loadEnv({ ...BASE_ENV, CSPR_TRADE_MCP_URL: SELF_HOSTED_TESTNET } as NodeJS.ProcessEnv),
    );
    expect(deps.tradeDataUrls?.['casper:casper-test']).toBe(SELF_HOSTED_TESTNET);
    expect(deps.tradeDataUrls?.['casper:casper']).toBeUndefined();
  });

  it('leaves the x402 paid services untouched', () => {
    // The demo x402 services are a separate product surface from the trade venue passthrough.
    const deps = buildCasperGuardDeps(loadEnv(BASE_ENV as NodeJS.ProcessEnv));
    expect(deps.tradeDataUrls).toBeUndefined();
    expect(deps.mcpUrl).toBeDefined();
  });
});
