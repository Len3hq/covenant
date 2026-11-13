# @len3hq/covenant-mcp

An MCP server that lets Claude, Cursor or any MCP app pay from a
[Covenant](https://github.com/Len3hq/covenant) vault. The app can ask for any payment, and the vault
contract on NEAR decides what gets signed. This server holds only the agent's key, which can do
nothing but ask the vault.

Testnet only: Bitcoin testnet4, Base Sepolia and Solana devnet, plus other chains through Tidepool's
testnet swaps.

## Set up

You need a vault and an agent key. The [dashboard](https://covenant.len3.xyz/?create)
makes both: choose "I'll run it" as the agent, and it shows the key once, with these settings filled in.

Rather not hold a key? Create the vault with a **Hosted** agent instead, and add the hosted connector to
your app by URL. Nothing to install; see the [docs](https://covenant.len3.xyz/?docs#hosted).

**Claude Desktop** (`claude_desktop_config.json`) or **Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "covenant": {
      "command": "npx",
      "args": ["-y", "@len3hq/covenant-mcp"],
      "env": {
        "VAULT_ACCOUNT_ID": "acme.vaults-v3.len3hq.testnet",
        "AGENT_ACCOUNT_ID": "agent.you.testnet",
        "AGENT_PRIVATE_KEY": "ed25519:…"
      }
    }
  }
}
```

Claude Desktop doesn't read your shell's PATH: if Node came from nvm, put the full path from
`which npx` in `command`, then quit and reopen Claude Desktop.

**Claude Code:**

```sh
claude mcp add covenant -e VAULT_ACCOUNT_ID=… -e AGENT_ACCOUNT_ID=… -e AGENT_PRIVATE_KEY=… -- npx -y @len3hq/covenant-mcp
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "covenant": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@len3hq/covenant-mcp"],
      "env": { "VAULT_ACCOUNT_ID": "…", "AGENT_ACCOUNT_ID": "…", "AGENT_PRIVATE_KEY": "ed25519:…" }
    }
  }
}
```

To check it works, ask your assistant "what are my vault's addresses?".

Optional settings:

- `SPENDS_FILE`: where payments are recorded, so none is paid twice. The default is
  `~/.covenant/<vault>-spends.json`.
- `SOL_NONCE_ACCOUNTS`: needed for Solana payments. Create one, once, with
  `VAULT_ACCOUNT_ID=<vault> npx -y @len3hq/covenant-mcp@latest sol-nonce`: the first run makes a funder key in
  `~/.covenant/sol-funder.json` and asks you to send it a little devnet SOL for the rent; the second
  creates the account, with the vault as its authority, and prints the value to add.
- `NEAR_RPC_URL` and `SOL_RPC_URL`: other RPC endpoints.
- `AUTO_EXECUTE`: `off` stops the server sending held payments by itself once their wait ends. It's
  on by default, for as long as your app keeps the server running.

Run `npx @len3hq/covenant-mcp --help` to see them all.

## Tools

| Tool | What it does |
| --- | --- |
| `pay` | Pays from the vault, or on another chain or token with `to_chain` and `to_asset` |
| `quote_payment` | Previews what a cross-chain payment would deliver |
| `list_destinations` | Lists the chains and tokens a swap may deliver |
| `get_payment_status` | Shows a cross-chain payment's progress, by its reference |
| `list_payees` | Lists the payees on the vault's list |
| `get_balances` | Shows what the vault holds and has spent in 24 hours |
| `get_addresses` | Shows the vault's addresses, so you can fund it |
| `list_queue` | Lists payments held for a veto |
| `execute_queued` | Signs a held payment once its window has passed |

More in the [docs](https://covenant.len3.xyz/?docs#mcp).
