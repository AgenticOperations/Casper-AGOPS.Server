import { describe, it, expect, vi } from 'vitest';
import {
  buildCep18TransferArgs,
  buildWcsprDepositArgs,
  createLiveCep18CallSubmitter,
} from '../../src/lib/casper/cep18-token-client.js';

describe('cep18-token-client arg builders', () => {
  it('transfer args: recipient as account-hash Key, amount as U256', () => {
    const rec = buildCep18TransferArgs({
      recipientAccountHash: '001885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a',
      amountMotes: '3000000000',
    });
    // Assert the whole object rather than reaching into one union member: ClTypedArg is a union,
    // so `rec.recipient.kind` does not narrow on its own. Matching the full shape is also stricter —
    // it catches an unexpected extra field, which a per-property check would miss.
    expect(rec.recipient).toEqual({
      kind: 'account-hash-key',
      // 00 prefix stripped — Key.newKey("account-hash-…") wants the raw 64 hex.
      rawHash: '1885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a',
    });
    expect(rec.amount).toEqual({ clType: 'U256', value: '3000000000' });
  });

  it('deposit (wrap) args: amount as U512', () => {
    const rec = buildWcsprDepositArgs({ amountMotes: '5000000000' });
    expect(rec.amount).toEqual({ clType: 'U512', value: '5000000000' });
  });
});

describe('createLiveCep18CallSubmitter adapter', () => {
  // A fake sdk capturing the CLValue / Key builder calls and the ContractCallBuilder chain,
  // so we assert the descriptor → CLValue mapping without loading casper-js-sdk or hitting chain.
  function makeFakeSdk() {
    const calls = {
      newCLKey: [] as unknown[],
      newKey: [] as string[],
      newCLUInt256: [] as string[],
      newCLUInt512: [] as string[],
      fromMap: [] as Record<string, unknown>[],
      byPackageHash: [] as string[],
      entryPoint: [] as string[],
      payment: [] as number[],
      chainName: [] as string[],
      signed: 0,
      putTransaction: 0,
    };

    const chain = {
      entryPoint(name: string) {
        calls.entryPoint.push(name);
        return chain;
      },
      runtimeArgs() {
        return chain;
      },
      from() {
        return chain;
      },
      chainName(n: string) {
        calls.chainName.push(n);
        return chain;
      },
      payment(p: number) {
        calls.payment.push(p);
        return chain;
      },
      build() {
        return {
          sign() {
            calls.signed += 1;
          },
          hash: { toHex: () => 'deadbeeftxhash' },
        };
      },
    };

    const sdk = {
      RpcClient: class {
        async putTransaction() {
          calls.putTransaction += 1;
          return { transactionHash: { toHex: () => 'deadbeeftxhash' } };
        }
      },
      HttpHandler: class {},
      PrivateKey: {
        fromPem() {
          return { publicKey: {}, sign: () => new Uint8Array() };
        },
      },
      KeyAlgorithm: { ED25519: 1, SECP256K1: 2 },
      Args: {
        fromMap(map: Record<string, unknown>) {
          calls.fromMap.push(map);
          return { __args: map };
        },
      },
      CLValue: {
        newCLString: (v: string) => ({ clString: v }),
        newCLKey: (k: unknown) => {
          calls.newCLKey.push(k);
          return { clKey: k };
        },
        newCLUInt256: (v: string) => {
          calls.newCLUInt256.push(v);
          return { clU256: v };
        },
        newCLUInt512: (v: string) => {
          calls.newCLUInt512.push(v);
          return { clU512: v };
        },
      },
      Key: {
        newKey: (s: string) => {
          calls.newKey.push(s);
          return { key: s };
        },
      },
      ContractCallBuilder: class {
        byPackageHash(hash: string) {
          calls.byPackageHash.push(hash);
          return chain;
        }
      },
    };

    return { sdk, calls };
  }

  it('maps account-hash-key → newCLKey(newKey("account-hash-"+raw)), U256 → newCLUInt256, and signs + submits', async () => {
    const { sdk, calls } = makeFakeSdk();
    const readFileSync = vi.fn().mockReturnValue('PEM');

    const submitter = createLiveCep18CallSubmitter({
      rpcUrl: 'http://node',
      pemPath: '/key.pem',
      algorithm: 'ed25519',
      chainName: 'casper-test',
      importSdk: async () => sdk as never,
      readFileSync: readFileSync as never,
    });

    const args = buildCep18TransferArgs({
      recipientAccountHash: '001885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a',
      amountMotes: '3000000000',
    });

    const res = await submitter.call({
      packageHash: 'pkg123',
      entryPoint: 'transfer',
      args: { recipient: args.recipient, amount: args.amount },
      paymentMotes: 3_000_000_000,
    });

    expect(res.txHash).toBe('deadbeeftxhash');
    expect(calls.newKey).toEqual([
      'account-hash-1885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a',
    ]);
    expect(calls.newCLKey).toHaveLength(1);
    expect(calls.newCLUInt256).toEqual(['3000000000']);
    expect(calls.byPackageHash).toEqual(['pkg123']);
    expect(calls.entryPoint).toEqual(['transfer']);
    expect(calls.payment).toEqual([3_000_000_000]);
    expect(calls.chainName).toEqual(['casper-test']);
    expect(calls.signed).toBe(1);
    expect(calls.putTransaction).toBe(1);
    // runtimeArgs got the mapped CLValues under the same keys
    // Non-null: the submitter ran to completion above (putTransaction === 1), so fromMap was called.
    const argMap = calls.fromMap[0]!;
    expect(argMap.recipient).toEqual({ clKey: { key: expect.any(String) } });
    expect(argMap.amount).toEqual({ clU256: '3000000000' });
  });

  it('maps U512 deposit amount → newCLUInt512', async () => {
    const { sdk, calls } = makeFakeSdk();
    const submitter = createLiveCep18CallSubmitter({
      rpcUrl: 'http://node',
      pemPath: '/key.pem',
      algorithm: 'ed25519',
      importSdk: async () => sdk as never,
      readFileSync: (() => 'PEM'),
    });

    await submitter.call({
      packageHash: 'pkg123',
      entryPoint: 'deposit',
      args: buildWcsprDepositArgs({ amountMotes: '5000000000' }),
      paymentMotes: 3_000_000_000,
    });

    expect(calls.newCLUInt512).toEqual(['5000000000']);
    expect(calls.newCLUInt256).toEqual([]);
  });
});
