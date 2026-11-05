# Evidence

Filled in from real testnet runs.

| Item | Value |
| --- | --- |
| Vault contract | [`covenant.len3hq.testnet`](https://testnet.nearblocks.io/address/covenant.len3hq.testnet) |
| Bitcoin testnet4 vault address | [`tb1qddd2cgvedtlfgvgvx6f93rt9te77zsu9ccmcw9`](https://mempool.space/testnet4/address/tb1qddd2cgvedtlfgvgvx6f93rt9te77zsu9ccmcw9) |
| Base Sepolia vault address | [`0xd913a8c28efdb2f30563e063b5fac5abd6ec9361`](https://sepolia.basescan.org/address/0xd913a8c28efdb2f30563e063b5fac5abd6ec9361) |
| Named test count | Pending |

| Outcome | Chain | NEAR receipt | Chain explorer |
| --- | --- | --- | --- |
| BTC payment | Bitcoin testnet4 | [3ZgtQynX…](https://testnet.nearblocks.io/txns/3ZgtQynXR9rr6mU5gvKSHoTRnRZ3FnecxpzAhvZQajQe) | [4cffaf61…](https://mempool.space/testnet4/tx/4cffaf61a766be2d0ca02be13ee43aac0812b1d29986e1b763665c42ce52c07e), confirmed in block 158989 |
| ETH payment | Base Sepolia | [GpZoGLLm…](https://testnet.nearblocks.io/txns/GpZoGLLmLug6prqQ6hCjxEv7m5QCsz9kUHYoVZEZKF4i) | [0x4638f90c…](https://sepolia.basescan.org/tx/0x4638f90c74963d32b16cd9cc1928d6c2c5aa6f34b0d3690cdf55586b25f88d8d), confirmed in block 54444549 |
| LLM-driven BTC payment, 20,000 sats (scenario `pay`, `gpt-5.4-mini`) | Bitcoin testnet4 | [Cdzviyh9…](https://testnet.nearblocks.io/txns/Cdzviyh9QCR1BibFfuitmC6FxZAsVGJB4WbyRbg1t6LG) | [82884970…](https://mempool.space/testnet4/tx/828849709508b78f0315e5380fa91dd1361c983785eae32b418c5ea98fdf28f4) |
| LLM-driven USDC payment, 1 USDC (scenario `pay`, `gpt-5.4-mini`) | Base Sepolia | [B9cj48mc…](https://testnet.nearblocks.io/txns/B9cj48mc9r3SFHPnavcJPmuJKsX9JvA4ZG9nJ5fREi9A) | [0x64c17e72…](https://sepolia.basescan.org/tx/0x64c17e72ebd042436941040a7492042f47d51385da2715c60b61397474cdde1f), confirmed in block 54829182 |
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
