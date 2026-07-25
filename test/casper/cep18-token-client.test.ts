import { describe, it, expect } from 'vitest';
import {
  buildCep18TransferArgs,
  buildWcsprDepositArgs,
} from '../../src/lib/casper/cep18-token-client.js';

describe('cep18-token-client arg builders', () => {
  it('transfer args: recipient as account-hash Key, amount as U256', () => {
    const rec = buildCep18TransferArgs({
      recipientAccountHash: '001885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a',
      amountMotes: '3000000000',
    });
    expect(rec.recipient.kind).toBe('account-hash-key');
    expect(rec.recipient.rawHash).toBe(
      '1885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a',
    ); // 00 stripped
    expect(rec.amount).toEqual({ clType: 'U256', value: '3000000000' });
  });

  it('deposit (wrap) args: amount as U512', () => {
    const rec = buildWcsprDepositArgs({ amountMotes: '5000000000' });
    expect(rec.amount).toEqual({ clType: 'U512', value: '5000000000' });
  });
});
