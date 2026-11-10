# Evidence

Filled in from real testnet runs.

| Item | Value |
| --- | --- |
| Vault contract | [`covenant.len3hq.testnet`](https://testnet.nearblocks.io/address/covenant.len3hq.testnet) |
| Bitcoin testnet4 vault address | [`tb1qddd2cgvedtlfgvgvx6f93rt9te77zsu9ccmcw9`](https://mempool.space/testnet4/address/tb1qddd2cgvedtlfgvgvx6f93rt9te77zsu9ccmcw9) |
| Base Sepolia vault address | [`0xd913a8c28efdb2f30563e063b5fac5abd6ec9361`](https://sepolia.basescan.org/address/0xd913a8c28efdb2f30563e063b5fac5abd6ec9361) |
| Solana devnet vault address | [`GnSDBdzbso6EgokmsndtcYbDdH7Vg3kczwf1Ro4mZA6T`](https://explorer.solana.com/address/GnSDBdzbso6EgokmsndtcYbDdH7Vg3kczwf1Ro4mZA6T?cluster=devnet) |
| Named test count | Pending |

| Outcome | Chain | NEAR receipt | Chain explorer |
| --- | --- | --- | --- |
| BTC payment | Bitcoin testnet4 | [3ZgtQynX…](https://testnet.nearblocks.io/txns/3ZgtQynXR9rr6mU5gvKSHoTRnRZ3FnecxpzAhvZQajQe) | [4cffaf61…](https://mempool.space/testnet4/tx/4cffaf61a766be2d0ca02be13ee43aac0812b1d29986e1b763665c42ce52c07e), confirmed in block 158989 |
| ETH payment | Base Sepolia | [GpZoGLLm…](https://testnet.nearblocks.io/txns/GpZoGLLmLug6prqQ6hCjxEv7m5QCsz9kUHYoVZEZKF4i) | [0x4638f90c…](https://sepolia.basescan.org/tx/0x4638f90c74963d32b16cd9cc1928d6c2c5aa6f34b0d3690cdf55586b25f88d8d), confirmed in block 54444549 |
| LLM-driven BTC payment, 20,000 sats (scenario `pay`, `gpt-5.4-mini`) | Bitcoin testnet4 | [Cdzviyh9…](https://testnet.nearblocks.io/txns/Cdzviyh9QCR1BibFfuitmC6FxZAsVGJB4WbyRbg1t6LG) | [82884970…](https://mempool.space/testnet4/tx/828849709508b78f0315e5380fa91dd1361c983785eae32b418c5ea98fdf28f4) |
| LLM-driven USDC payment, 1 USDC (scenario `pay`, `gpt-5.4-mini`) | Base Sepolia | [B9cj48mc…](https://testnet.nearblocks.io/txns/B9cj48mc9r3SFHPnavcJPmuJKsX9JvA4ZG9nJ5fREi9A) | [0x64c17e72…](https://sepolia.basescan.org/tx/0x64c17e72ebd042436941040a7492042f47d51385da2715c60b61397474cdde1f), confirmed in block 54829182 |
| Claude-driven ETH payment to an unlisted address refused (`OutputNotWhitelisted`, `claude-opus-5-5`) | NEAR | [98y49NzU…](https://testnet.nearblocks.io/txns/98y49NzULc1DyiPeximK8uJp3d13tauaa4m5getQBsJR) | None: never signed |
| A real model hijacked by a poisoned invoice tries to pay the attacker 600,000 sats (`OutputNotWhitelisted`, `gpt-4o-mini`) | NEAR | [9mwbnHAA…](https://testnet.nearblocks.io/txns/9mwbnHAAfQc6BG5xkKQnSVCPeDMaKR5kY623PtM45KF2) | None: never signed |
| The same model tries to approve the attacker for unlimited USDC (`CalldataNotAllowed`) | NEAR | [7A6ecoDz…](https://testnet.nearblocks.io/txns/7A6ecoDzX1jtfGsxKK7EXbPm4aNjdTWCJPZJaeEaDSX1) | None: never signed |
| Queue scenario: 300,000 sats queued, then vetoed by a DAO vote | NEAR | [3vCgmygt…](https://testnet.nearblocks.io/txns/3vCgmygtT6FgoFapMRRzkp5Y2tYt5HEM33PBNdLSd5nd), [veto 2igAxtsG…](https://testnet.nearblocks.io/txns/2igAxtsGvXPBhVYvbLxPNYPU96zeFhsDPhrt4HTZWpz2) | None: never signed |
| Vault created through the factory, keyless, on the shared code `2icvfZAX…`, with addresses matching a separate derivation | NEAR | [EWXfTxo5…](https://testnet.nearblocks.io/txns/EWXfTxo5BzuamTpZbj1SzY6CEfhb7U1peEugu55vwzps) | None: no funds moved |
| Same name again: creation refused and the 1.5 NEAR deposit refunded | NEAR | [B8oXnDuX…](https://testnet.nearblocks.io/txns/B8oXnDuXj6rZyCGu8yJvtAfEfc2evoS6PmEiJtbTgv6f) | None: no funds moved |
| The factory vault refuses an attacker address (`OutputNotWhitelisted`) | NEAR | [t1Z6gYR6…](https://testnet.nearblocks.io/txns/t1Z6gYR6pzxzXXNoDskTAzYDTG1X9WzXyWkNjFdrKoo) | None: never signed |
| The real MPC network signs a listed payment for the factory vault, and the signature recovers to its address `0x09739a41…` | NEAR | [EmcuFLmL…](https://testnet.nearblocks.io/txns/EmcuFLmL1io8Rnjuio7QGycirzCT7KCr1edZ7Fagz1kg) | Not broadcast: the vault holds no ETH |
| `@covenant/sdk`: an attacker address refused (`OutputNotWhitelisted`) | NEAR | [X5gkoQuS…](https://testnet.nearblocks.io/txns/X5gkoQuSpS9NUB2QmAiyGJTmtWp1KZNUn5CY2y2SJPs) | None: never signed |
| `@covenant/sdk`: 1 wei to DesignCo, then the same `reference` again returns the same transaction instead of paying twice | Base Sepolia | [4J7t2V6y…](https://testnet.nearblocks.io/txns/4J7t2V6yoGLxNFfDJzjZbrxF2xyPsCoKPnTkX2LKPrVs) | [0xf53de2e1…](https://sepolia.basescan.org/tx/0xf53de2e1894f255d9a4e2defd4067deffcd603c3edb96556802e279b98783072) |
| MCP server over stdio: an assistant's 600,000-sat payment to the attacker refused (`OutputNotWhitelisted`) | NEAR | [G3su7e28…](https://testnet.nearblocks.io/txns/G3su7e28XdpybA5KdEmQQJpHwHevRMRCgbMchA76bCsx) | None: never signed |
| MCP server over stdio: 1,000 sats to Acme Hosting | Bitcoin testnet4 | [CKKTVGyG…](https://testnet.nearblocks.io/txns/CKKTVGyGv49dKcHyGYBon2xkf99xzSna7CyzQaUuRtus) | [77fab75e…](https://mempool.space/testnet4/tx/77fab75ed8e0df9abf6194e8b9bf09291619101356a888de387b91193c2c06a6) |
| Queued BTC spend refused as too early (`NotYetExecutable`) | NEAR | [Dy3RdEho…](https://testnet.nearblocks.io/txns/Dy3RdEho98WBgQxqr7fJXKLqXhDfquqHrpmRUKCGDhJA) | None: never signed |
| Same spend executed after its veto window, 16,000 sats | Bitcoin testnet4 | [86B4xHWg…](https://testnet.nearblocks.io/txns/86B4xHWgYDrQSCrfSXhkJ6VndBu5Ak17WrrFcakXXamU) | [9f5793e9…](https://mempool.space/testnet4/tx/9f5793e9e6b14f22e26a8d0abc8734ff7488829ce5b33ded048fc249a156855a) |
| USDC payment, 1 USDC, sent with the agent's restricted key | Base Sepolia | [3pXYBbFU…](https://testnet.nearblocks.io/txns/3pXYBbFUfiiYr8EAYETZQG7Mkuf4JoJGtsu4UTjbongz) | [0xe5ba350b…](https://sepolia.basescan.org/tx/0xe5ba350b3621cdc7f5dc86affa7b270ec76e69f5655e371652f528db14f2eb97), confirmed in block 54801922 |
| Rejected BTC attack (`OutputNotWhitelisted`) | NEAR | [2ZKGhLm1…](https://testnet.nearblocks.io/txns/2ZKGhLm1ye6KwCKrxHs8zeCRmNoG3b8zXRukeowUJGpS) | None: never signed |
| Rejected ETH payment to an unlisted address (`OutputNotWhitelisted`) | NEAR | [D9Y2SYED…](https://testnet.nearblocks.io/txns/D9Y2SYEDrHjVx5xKhKWt1XFy34HLU2yD7dugmicPYMxP) | None: never signed |
| Rejected EVM approve (`CalldataNotAllowed`) | NEAR | [74Lp7yqV…](https://testnet.nearblocks.io/txns/74Lp7yqVoj3DQ5Qwa35dsvvszBTvYXU85XQ5vikYw6uy) | None: never signed |
| Large BTC spend queued (`spend_queued`, 260,000 sats) | NEAR | [FGxhcEgh…](https://testnet.nearblocks.io/txns/FGxhcEgh7vqBtFoJ8YQ2jawsuGSV4wJkNVz3N6LEJdc7) | None: never signed |
| That spend vetoed by the guardian (`spend_vetoed`) | NEAR | [BzEN28qd…](https://testnet.nearblocks.io/txns/BzEN28qduEkrBbFNBHy5Uoo3ZgrjvmtZAGeQP3bJdQex) | None: never signed |
| Vault frozen by the guardian (`frozen`) | NEAR | [CxUjq6NZ…](https://testnet.nearblocks.io/txns/CxUjq6NZyCvb831XxdFceQdP2Vpvdsmxi8qGUm1ZdshT) | None |
| Vault unfrozen by the owner (`unfrozen`) | NEAR | [6NkUuBH9…](https://testnet.nearblocks.io/txns/6NkUuBH9sSgSoSkqdEDdtean8sy382PDyduwqkAcyvYC) | None |
| Guardian role moved to the Sputnik DAO (`guardian_updated`) | NEAR | [7F1JqF2E…](https://testnet.nearblocks.io/txns/7F1JqF2EFi699TXubUbEbaqem8zzWScjJB3mjiYm8eZQ) | None |
| Queued spend vetoed by a DAO vote (`spend_vetoed`) | NEAR | [7Z1PDspM…](https://testnet.nearblocks.io/txns/7Z1PDspM3JScG9dTqxYH91qH1cmt3heYHNC8zgAKHUhE) | None: never signed |
| Vault frozen by a DAO vote (`frozen`) | NEAR | [Coa7GEbm…](https://testnet.nearblocks.io/txns/Coa7GEbmRkT2wpEfayBh3DMFh3cJDDYNk12ELTXmcPe4) | None |
| Ed25519 spike: the signer signs a raw 80-byte message in domain 1, and it verifies against the derived key | NEAR | [BeX39ENF…](https://testnet.nearblocks.io/txns/BeX39ENFf3Ud1E95eoBqZAj1fo3U5F7TCpLD7D1wDms2) | None: a test message |
| Vault moved to the Solana code with `migrate`, keeping its roles, ledger and addresses | NEAR | [4y5rowTd…](https://testnet.nearblocks.io/txns/4y5rowTd8JSP9rLbdZe4i5YLt1qQ8aUq7Ptp6sAgTBYm) | None |
| Policy with SOL and Solana USDC limits applied by the owner (`policy_updated`) | NEAR | [4WrLLqzV…](https://testnet.nearblocks.io/txns/4WrLLqzVQT8XBK7yFJZC2TWMx63bfiSLqtkXmVZ7JJoB) | None |
| Rejected SOL payment to an unlisted address (`OutputNotWhitelisted`) | NEAR | [A6iSWhG2…](https://testnet.nearblocks.io/txns/A6iSWhG2s9qsMFZ4exPdLBXoqL8MFJ3Jtjj7dco6af3x) | None: never signed |
| The real MPC network signs a listed SOL payment in the Ed25519 domain, and the signature verifies against the vault's Solana address | NEAR | [BFwgkbT4…](https://testnet.nearblocks.io/txns/BFwgkbT4RtMRXRmnVe4TVCjqc99g7Zq1eEUSyXbDEJMG) | Not broadcast: its nonce account doesn't exist, so it can never land |
