import { hex } from "@scure/base";
import { deriveVaultKeys } from "./vault-keys.ts";

const keys = await deriveVaultKeys();
console.log(
  JSON.stringify(
    {
      vault: keys.vault,
      btc_address: keys.btcAddress,
      btc_pubkey: hex.encode(keys.btcPubkey),
      evm_address: keys.evmAddress,
    },
    null,
    2,
  ),
);
