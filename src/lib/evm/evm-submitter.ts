import type { CasperGuardNetwork } from '../../engines/casper-guard/types.js';

/** Injectable EVM native ETH transfer submitter. */
export interface NativeEvmTransferSubmitter {
  submitTransfer(input: {
    to: `0x${string}`;
    amountWei: bigint;
  }): Promise<{ txHash: string }>;
}

// Maps our network identifiers to viem chain IDs.
const NETWORK_CHAIN_ID: Partial<Record<CasperGuardNetwork, number>> = {
  'evm:sepolia': 11155111,
  'evm:base-sepolia': 84532,
};

export function createNativeEvmTransferSubmitter(cfg: {
  network: CasperGuardNetwork;
  privateKey: `0x${string}`;
  rpcUrl?: string;
}): NativeEvmTransferSubmitter {
  return {
    async submitTransfer({ to, amountWei }) {
      // Deferred import keeps casper-only paths free of viem at module load time.
      const { createWalletClient, createPublicClient, http } = await import('viem');
      const { privateKeyToAccount } = await import('viem/accounts');
      const chains = await import('viem/chains');

      const chainId = NETWORK_CHAIN_ID[cfg.network];
      if (!chainId) throw new Error(`evm_network_not_supported: ${cfg.network}`);

      // Pick the viem chain object by chain ID.
      const chain = Object.values(chains).find(
        (c): c is (typeof chains)[keyof typeof chains] =>
          typeof c === 'object' && c !== null && 'id' in c && (c as { id: number }).id === chainId,
      );
      if (!chain) throw new Error(`evm_chain_not_found: ${cfg.network}`);

      const account = privateKeyToAccount(cfg.privateKey);
      const transport = http(cfg.rpcUrl);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const walletClient = createWalletClient({ account, chain: chain as any, transport });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const publicClient = createPublicClient({ chain: chain as any, transport });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hash: `0x${string}` = await (walletClient as any).sendTransaction({ account, to, value: amountWei });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (publicClient as any).waitForTransactionReceipt({ hash });
      return { txHash: hash };
    },
  };
}
