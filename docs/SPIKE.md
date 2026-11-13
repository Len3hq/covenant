# MPC signing spike

A contract can request real signatures from the testnet MPC network, including several in one call, and all 21 returned signatures verified against the expected derived key. Run on 3 Nov 2026 against `v1.signer-prod.testnet` version 3.18.0.

The spike contract was deployed at `spike.len3hq.testnet`. Both it and its source, `tests/spike`, were deleted once the vault itself signed, and the transactions below remain on chain. Each case ran once, so treat the timings as rough, not as a load test.

## Results

| Signatures | Gas attached per `sign` | Signed | Time, including about 5 s of CLI overhead | Gas burnt | Transaction |
| --- | --- | --- | --- | --- | --- |
| 1 | 50 Tgas | 1 of 1 | 10.1 s | 12.2 Tgas | [CdLQi7E2…](https://testnet.nearblocks.io/txns/CdLQi7E23L8E2rXZ78F7ykKvL3fDZpphNBv6jcEPYCoN) |
| 2 | 50 Tgas | 2 of 2 | 10.5 s | 20.8 Tgas | [DtpoayAp…](https://testnet.nearblocks.io/txns/DtpoayApq18UEDZuoqqERUcv7BrB6t2JrGq4E4nV3Jsx) |
| 3 | 50 Tgas | 3 of 3 | 9.8 s | 29.4 Tgas | [4w38vkMu…](https://testnet.nearblocks.io/txns/4w38vkMuTLZNMSTkctYVLAno23NTJoBHKthmLPgh6uN1) |
| 8 | 30 Tgas | 8 of 8 | 19.5 s | 72.4 Tgas | [FHCWboNT…](https://testnet.nearblocks.io/txns/FHCWboNTNEhZAdv8HpkTK45uz3GjVeckeGkh1ynWp2Hf) |

## Minimum gas

| Gas attached per `sign` | Result | Transaction |
| --- | --- | --- |
| 5 Tgas | Failed | [7Z58a2Fq…](https://testnet.nearblocks.io/txns/7Z58a2FqTax8dHZT23NJNa9Teakx5hmhdqmvWHMJFzYU) |
| 10 Tgas | Failed: `Provided: 10000000000000, required: 15000000000000` | [Din5KrVy…](https://testnet.nearblocks.io/txns/Din5KrVye6QSif6XhwSRBzzWdpLSB4MhZLNgoQnXLMmq) |
| 12 Tgas | Failed | [7Ftk3mgA…](https://testnet.nearblocks.io/txns/7Ftk3mgAKzXnQtGYGdNCBeTdqFGd3yvVsXmYwCKE7bb3) |
| 15 Tgas | Signed | [Gh8YbAqo…](https://testnet.nearblocks.io/txns/Gh8YbAqoFHAgxuzFap2Hm1cpkM47JkZJ9LvjoUqVRdX5) |
| 20 Tgas | Signed | [AyWBtWuv…](https://testnet.nearblocks.io/txns/AyWBtWuvHqXnpVdep4fP2heW3k5onXQ63kx3r8Lhvbvs) |
| 25 Tgas | Signed | [4aS1eehj…](https://testnet.nearblocks.io/txns/4aS1eehjPasQHdPkRH9VYsstWiwKNMSscvZ2i3zEP7iz) |

The [MPC docs](https://github.com/near/mpc/blob/main/crates/contract/README.md) say 10 Tgas, but the live contract requires 15.

## What the vault should do

- **Attach 30 Tgas per `sign`.** That's the lowest value we ran with a full 8-signature join, and it leaves room above the 15 Tgas minimum if the requirement rises.
- **Budget for parsing.** Three inputs at 30 Tgas each, plus a 10 Tgas callback, reserve 100 Tgas and leave up to 200 Tgas of the 300 Tgas limit for parsing and policy. The gas table in the README has the measured numbers.
- **Treat a failed `sign` as an ordinary callback result.** A failure didn't revert the joined call. The callback still ran, and it saw that result as failed, so `on_signed` can release the reservation and return `SignFailed`.
- **Expect partial failure.** In [59WQU9aW…](https://testnet.nearblocks.io/txns/59WQU9aWdzPnvvHPUZoUZ7tABpZZwnfvzJL6ZkifnnKZ), one bad payload failed while the other was signed. That signature was still published even though the spend as a whole failed.

Partial failure doesn't break the caps. SIGHASH_ALL ties each Bitcoin signature to the whole transaction, which also needs every other input's signature, and getting those takes a new proposal with its own reservation. SECURITY.md says so under "Limits to know".

## Response shape

```json
{
  "scheme": "Secp256k1",
  "big_r": { "affine_point": "0265c90fd8479fe510e68c39fb23e42bf30e1869e6affb2249c09820a08bb664ec" },
  "s": { "scalar": "08f7ed44a950030d0cbb3b5066a08049ded45620080af5c455617fbaec6a3878" },
  "recovery_id": 1
}
```

`scripts/src/keys.test.ts` checks this real signature against the derived key, and against a wrong key and a wrong payload. `MpcSignature` in the vault and the mock signer use the same shape.

## Signer domains

| `domain_id` | Protocol | Purpose |
| --- | --- | --- |
| 0 | CaitSith (secp256k1) | Sign: Bitcoin and EVM |
| 1 | Frost (Ed25519) | Sign: Solana |
| 2 | Confidential key derivation | Not used |
| 3 | CaitSith | Foreign transaction verification, not used |

## Not covered

This spike signed test hashes. It didn't broadcast anything to Bitcoin or Base. The live payments in [EVIDENCE.md](../EVIDENCE.md) do.
