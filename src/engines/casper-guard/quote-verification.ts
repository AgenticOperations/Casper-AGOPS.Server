/**
 * D-5⑤ / Milestone E.2: verify a cspr-trade intent's claimed min-received against a live quote,
 * not just the intent's self-reported slippageBps. amountOutMin = quotedAmountOut adjusted down
 * by the policy's allowed slippage (in basis points); the intent's min-received must be at least
 * that floor or the swap is denied — an agent cannot claim a worse price got approved than the
 * live market actually supports within the allowed tolerance.
 */
export function verifyMinReceivedWithinSlippage(input: {
  quotedAmountOut: bigint;
  maxSlippageBps: number;
  intentMinReceived: bigint;
}): { ok: true } | { ok: false; amountOutMin: bigint } {
  const amountOutMin =
    (input.quotedAmountOut * BigInt(10_000 - input.maxSlippageBps)) / 10_000n;

  if (input.intentMinReceived >= amountOutMin) {
    return { ok: true };
  }
  return { ok: false, amountOutMin };
}
