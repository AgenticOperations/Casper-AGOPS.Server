import CasperSDK from 'casper-js-sdk';
import { readFile } from 'fs/promises';

const pemPath = process.env.CASPER_GUARD_SIGNER_PEM_PATH!;
const rpcUrl = process.env.CASPER_GUARD_FACILITATOR_RPC_URL!;
// wCSPR package hash on testnet
const WCSPR_PACKAGE_HASH = '8df5d26790e18cf0404502c62ce5dc9025800ad6975c97466e20506c39c505b6';
// Wrap 2 CSPR = 2_000_000_000 motes
const DEPOSIT_AMOUNT = BigInt('2000000000');
// Gas for the deposit call
const GAS_PAYMENT = BigInt('3000000000');

const pem = await readFile(pemPath, 'utf-8');
const key = CasperSDK.PrivateKey.fromPem(pem, 2); // 2 = secp256k1
console.log('public key:', key.publicKey.toHex());
console.log('account hash:', '00' + key.publicKey.accountHash().toHex());

const rpcClient = new CasperSDK.RpcClient(new CasperSDK.HttpHandler(rpcUrl));

// Build deposit (wrap) transaction
// wCSPR deposit takes an `amount` arg of type U512 and requires native CSPR attached
const args = CasperSDK.Args.fromMap({
  amount: CasperSDK.CLValue.newCLUInt512(DEPOSIT_AMOUNT),
});

const tx = new CasperSDK.ContractCallBuilder()
  .from(key.publicKey)
  .byPackageHash(WCSPR_PACKAGE_HASH)
  .entryPoint('deposit')
  .runtimeArgs(args)
  .chainName('casper-test')
  .payment(Number(GAS_PAYMENT))
  .build();

tx.sign(key);

console.log('\nSubmitting deposit (wrap) transaction...');
const result = await rpcClient.putTransaction(tx);
const txHash = result.transactionHash.toHex();
console.log('TX hash:', txHash);
console.log('Wrapped', Number(DEPOSIT_AMOUNT) / 1e9, 'CSPR → wCSPR');
console.log('\nTrack at: https://testnet.cspr.live/deploy/' + txHash);
