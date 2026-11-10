//! Solana adapter: a legacy message from the vault alone, that advances a durable nonce and then
//! only moves SOL or one SPL token to listed payees. See docs/SPEC.md, "Solana adapter spec".
//!
//! Ed25519 signs the message itself, so the vault asks the signer to sign exactly the bytes checked
//! here. There's no hash a caller could swap.

use covenant_policy::{AssetId, ChainKind, CovenantError, ParsedTx, Payment, Policy, SignPayload};
use near_sdk::json_types::U128;

/// A transaction with one signature must fit Solana's 1,232-byte packet: 1 byte of count and 64 of
/// signature leave this for the message.
pub const MAX_MESSAGE_LEN: usize = 1232 - 1 - 64;
/// Lamports per signature, and the vault's is the only one.
pub const BASE_FEE: u128 = 5_000;
/// The most compute a transaction can use, charged when the message doesn't set a limit.
pub const MAX_COMPUTE_UNITS: u128 = 1_400_000;
const MICRO_LAMPORTS: u128 = 1_000_000;
const KEY_LEN: usize = 32;

pub const SYSTEM_PROGRAM: [u8; 32] = [0; 32];
/// `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`. Token-2022 isn't accepted: its transfer hooks
/// and fees would make a transfer do more than it says.
pub const TOKEN_PROGRAM: [u8; 32] = [
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
];
/// `ComputeBudget111111111111111111111111111111`.
pub const COMPUTE_BUDGET_PROGRAM: [u8; 32] = [
    0x03, 0x06, 0x46, 0x6f, 0xe5, 0x21, 0x17, 0x32, 0xff, 0xec, 0xad, 0xba, 0x72, 0xc3, 0x9b, 0xe7,
    0xbc, 0x8c, 0xe5, 0xbb, 0xc5, 0xf7, 0x12, 0x6b, 0x2c, 0x43, 0x9b, 0x3a, 0x40, 0x00, 0x00, 0x00,
];
/// `SysvarRecentB1ockHashes11111111111111111111`, which `AdvanceNonceAccount` reads.
pub const RECENT_BLOCKHASHES_SYSVAR: [u8; 32] = [
    0x06, 0xa7, 0xd5, 0x17, 0x19, 0x2c, 0x56, 0x8e, 0xe0, 0x8a, 0x84, 0x5f, 0x73, 0xd2, 0x97, 0x88,
    0xcf, 0x03, 0x5c, 0x31, 0x45, 0xb2, 0x1a, 0xb3, 0x44, 0xd8, 0x06, 0x2e, 0xa9, 0x40, 0x00, 0x00,
];

const SYSTEM_TRANSFER: u32 = 2;
const SYSTEM_ADVANCE_NONCE: u32 = 4;
const TOKEN_TRANSFER_CHECKED: u8 = 12;
const SET_COMPUTE_UNIT_LIMIT: u8 = 2;
const SET_COMPUTE_UNIT_PRICE: u8 = 3;

struct Instruction<'a> {
    program: usize,
    accounts: Vec<usize>,
    data: &'a [u8],
}

struct Message<'a> {
    keys: Vec<[u8; KEY_LEN]>,
    instructions: Vec<Instruction<'a>>,
}

/// Reads a Solana `short_vec` length: 1 to 3 bytes, 7 bits each, in its one canonical encoding.
fn compact_u16(bytes: &[u8]) -> Result<(usize, &[u8]), CovenantError> {
    let mut value = 0usize;
    for index in 0..3 {
        let byte = *bytes.get(index).ok_or(CovenantError::MalformedTx)?;
        value |= ((byte & 0x7f) as usize) << (7 * index);
        if byte & 0x80 == 0 {
            if index > 0 && byte == 0 {
                return Err(CovenantError::MalformedTx);
            }
            if value > u16::MAX as usize {
                return Err(CovenantError::MalformedTx);
            }
            return Ok((value, &bytes[index + 1..]));
        }
    }
    Err(CovenantError::MalformedTx)
}

fn take(bytes: &[u8], count: usize) -> Result<(&[u8], &[u8]), CovenantError> {
    if count > bytes.len() {
        return Err(CovenantError::MalformedTx);
    }
    Ok(bytes.split_at(count))
}

/// Rule 1: a legacy message, read whole, with distinct keys and in-range indices. A versioned
/// message sets the top bit of its first byte, and its lookup tables name accounts this can't see.
fn read_message(bytes: &[u8]) -> Result<Message<'_>, CovenantError> {
    if bytes.len() > MAX_MESSAGE_LEN {
        return Err(CovenantError::MalformedTx);
    }
    let (header, rest) = take(bytes, 3)?;
    let [signatures, readonly_signed, readonly_unsigned] = [header[0], header[1], header[2]];
    if signatures & 0x80 != 0 {
        return Err(CovenantError::MalformedTx);
    }
    // Rule 2: the vault is the only signer, and as the fee payer it must be writable.
    if signatures != 1 || readonly_signed != 0 {
        return Err(CovenantError::MalformedTx);
    }

    let (count, mut rest) = compact_u16(rest)?;
    let mut keys: Vec<[u8; KEY_LEN]> = Vec::with_capacity(count);
    for _ in 0..count {
        let (key, after) = take(rest, KEY_LEN)?;
        let key: [u8; KEY_LEN] = key.try_into().map_err(|_| CovenantError::MalformedTx)?;
        if keys.contains(&key) {
            return Err(CovenantError::MalformedTx);
        }
        keys.push(key);
        rest = after;
    }
    if keys.is_empty() || readonly_unsigned as usize > keys.len() - 1 {
        return Err(CovenantError::MalformedTx);
    }

    // The blockhash, which for a durable-nonce message is the nonce's value.
    let (_, rest) = take(rest, 32)?;

    let (count, mut rest) = compact_u16(rest)?;
    let mut instructions = Vec::with_capacity(count);
    for _ in 0..count {
        let (program, after) = take(rest, 1)?;
        let program = program[0] as usize;
        let (account_count, after) = compact_u16(after)?;
        let (accounts, after) = take(after, account_count)?;
        let (data_len, after) = compact_u16(after)?;
        let (data, after) = take(after, data_len)?;
        let accounts: Vec<usize> = accounts.iter().map(|index| *index as usize).collect();
        if program >= keys.len() || accounts.iter().any(|index| *index >= keys.len()) {
            return Err(CovenantError::MalformedTx);
        }
        instructions.push(Instruction {
            program,
            accounts,
            data,
        });
        rest = after;
    }
    if !rest.is_empty() {
        return Err(CovenantError::MalformedTx);
    }
    Ok(Message { keys, instructions })
}

fn u32_le(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().unwrap_or([0xff; 4]))
}

fn u64_le(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().unwrap_or([0; 8]))
}

/// The vault is account 0, the only signer, so every instruction that spends must name it there.
const VAULT: usize = 0;

/// Rule 3: a durable nonce, so a queued spend can still land after its veto window. A recent
/// blockhash expires in about a minute.
fn is_nonce_advance(message: &Message<'_>, instruction: &Instruction<'_>) -> bool {
    message.keys[instruction.program] == SYSTEM_PROGRAM
        && instruction.data.len() == 4
        && u32_le(instruction.data) == SYSTEM_ADVANCE_NONCE
        && instruction.accounts.len() == 3
        && message.keys[instruction.accounts[1]] == RECENT_BLOCKHASHES_SYSVAR
        && instruction.accounts[2] == VAULT
}

/// Parses an unsigned legacy message into its payments, maximum fee and signing payload,
/// enforcing spec rules 1 to 7. `vault` is the vault's Ed25519 key.
pub fn parse(message: &[u8], policy: &Policy, vault: &[u8; 32]) -> Result<ParsedTx, CovenantError> {
    let read = read_message(message)?;

    // Rule 2.
    if read.keys[VAULT] != *vault {
        return Err(CovenantError::InputNotOwned);
    }

    // Rule 3.
    let (first, rest) = read
        .instructions
        .split_first()
        .ok_or(CovenantError::CalldataNotAllowed)?;
    if !is_nonce_advance(&read, first) {
        return Err(CovenantError::CalldataNotAllowed);
    }

    // Rules 4 and 5.
    let mut payments = Vec::new();
    let mut unit_limit: Option<u128> = None;
    let mut unit_price: Option<u128> = None;
    for instruction in rest {
        let program = read.keys[instruction.program];
        let data = instruction.data;
        let accounts = &instruction.accounts;
        if program == SYSTEM_PROGRAM {
            if data.len() != 12 || u32_le(&data[..4]) != SYSTEM_TRANSFER || accounts.len() != 2 {
                return Err(CovenantError::CalldataNotAllowed);
            }
            if accounts[0] != VAULT {
                return Err(CovenantError::InputNotOwned);
            }
            payments.push(Payment {
                asset: AssetId::Sol,
                to: read.keys[accounts[1]].to_vec(),
                amount: U128(u64_le(&data[4..]) as u128),
            });
        } else if program == TOKEN_PROGRAM {
            // Accounts: source, mint, destination, owner. A multisig owner adds signers, and the
            // vault is the only one.
            if data.len() != 10 || data[0] != TOKEN_TRANSFER_CHECKED || accounts.len() != 4 {
                return Err(CovenantError::CalldataNotAllowed);
            }
            if accounts[3] != VAULT {
                return Err(CovenantError::InputNotOwned);
            }
            let asset = AssetId::Spl {
                mint: read.keys[accounts[1]],
            };
            if !policy.caps.iter().any(|cap| cap.asset == asset) {
                return Err(CovenantError::TokenNotAllowed);
            }
            payments.push(Payment {
                asset,
                to: read.keys[accounts[2]].to_vec(),
                amount: U128(u64_le(&data[1..9]) as u128),
            });
        } else if program == COMPUTE_BUDGET_PROGRAM {
            let slot = match (data.first(), data.len()) {
                (Some(&SET_COMPUTE_UNIT_LIMIT), 5) => &mut unit_limit,
                (Some(&SET_COMPUTE_UNIT_PRICE), 9) => &mut unit_price,
                _ => return Err(CovenantError::CalldataNotAllowed),
            };
            // Solana refuses a repeated budget instruction, so one would never land.
            if slot.is_some() || !accounts.is_empty() {
                return Err(CovenantError::CalldataNotAllowed);
            }
            *slot = Some(if data.len() == 5 {
                u32_le(&data[1..]) as u128
            } else {
                u64_le(&data[1..]) as u128
            });
        } else {
            return Err(CovenantError::CalldataNotAllowed);
        }
    }
    if payments.is_empty() || payments.iter().any(|payment| payment.amount.0 == 0) {
        return Err(CovenantError::CalldataNotAllowed);
    }

    // Rule 6.
    if !payments
        .iter()
        .all(|payment| policy.allows_payee(ChainKind::Solana, &payment.to))
    {
        return Err(CovenantError::OutputNotWhitelisted);
    }

    // Rule 7: the priority fee is price times the requested limit, rounded up, so it's charged at
    // the most it could cost.
    let units = unit_limit.unwrap_or(MAX_COMPUTE_UNITS);
    let priority = unit_price
        .unwrap_or(0)
        .checked_mul(units)
        .ok_or(CovenantError::FeeTooHigh)?
        .div_ceil(MICRO_LAMPORTS);
    let fee = BASE_FEE + priority;
    if fee > policy.sol_max_fee.0 {
        return Err(CovenantError::FeeTooHigh);
    }

    Ok(ParsedTx {
        payments,
        fee,
        fee_asset: AssetId::Sol,
        signing_payloads: vec![SignPayload::Eddsa(message.to_vec().into())],
        vsize: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use covenant_policy::{AssetCap, Payee, UnlistedPayees};

    const VAULT_KEY: [u8; 32] = [0x11; 32];
    const NONCE: [u8; 32] = [0x22; 32];
    const PAYEE: [u8; 32] = [0xaa; 32];
    const PAYEE_TOKENS: [u8; 32] = [0xab; 32];
    const STRANGER: [u8; 32] = [0xbb; 32];
    const VAULT_TOKENS: [u8; 32] = [0x12; 32];
    const USDC: [u8; 32] = [0x33; 32];
    const OTHER_MINT: [u8; 32] = [0x44; 32];
    const MAX_FEE: u128 = 100_000;

    fn policy() -> Policy {
        let cap = |asset| AssetCap {
            asset,
            per_tx: U128(1_000_000_000),
            per_24h: U128(5_000_000_000),
            queue_at: U128(500_000_000),
            unlisted_per_24h: U128(0),
        };
        let payee = |to: [u8; 32]| Payee {
            chain: ChainKind::Solana,
            to: to.to_vec(),
            label: "supplier".into(),
        };
        Policy {
            caps: vec![cap(AssetId::Sol), cap(AssetId::Spl { mint: USDC })],
            payees: vec![payee(PAYEE), payee(PAYEE_TOKENS)],
            btc_max_fee_rate: 50,
            btc_max_inputs: 3,
            evm_chain_ids: vec![84532],
            evm_max_gas_cost: U128(1),
            veto_delay_ns: 1,
            sol_max_fee: U128(MAX_FEE),
            unlisted: UnlistedPayees::Refuse,
            unlisted_veto_delay_ns: 0,
        }
    }

    fn short_vec(mut value: usize) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return out;
            }
            out.push(byte | 0x80);
        }
    }

    /// Builds a legacy message, adding keys in the order instructions first name them.
    struct Builder {
        header: [u8; 3],
        keys: Vec<[u8; 32]>,
        instructions: Vec<(usize, Vec<usize>, Vec<u8>)>,
    }

    impl Builder {
        fn new() -> Self {
            Builder {
                header: [1, 0, 0],
                keys: vec![VAULT_KEY],
                instructions: vec![],
            }
        }

        fn key(&mut self, key: [u8; 32]) -> usize {
            if let Some(index) = self.keys.iter().position(|k| *k == key) {
                return index;
            }
            self.keys.push(key);
            self.keys.len() - 1
        }

        fn instruction(mut self, program: [u8; 32], accounts: &[[u8; 32]], data: Vec<u8>) -> Self {
            let accounts = accounts.iter().map(|key| self.key(*key)).collect();
            let program = self.key(program);
            self.instructions.push((program, accounts, data));
            self
        }

        fn nonce(self) -> Self {
            let data = SYSTEM_ADVANCE_NONCE.to_le_bytes().to_vec();
            self.instruction(
                SYSTEM_PROGRAM,
                &[NONCE, RECENT_BLOCKHASHES_SYSVAR, VAULT_KEY],
                data,
            )
        }

        fn sol(self, from: [u8; 32], to: [u8; 32], lamports: u64) -> Self {
            let data = [
                SYSTEM_TRANSFER.to_le_bytes().to_vec(),
                lamports.to_le_bytes().to_vec(),
            ];
            self.instruction(SYSTEM_PROGRAM, &[from, to], data.concat())
        }

        fn token(self, program: [u8; 32], mint: [u8; 32], to: [u8; 32], amount: u64) -> Self {
            let mut data = vec![TOKEN_TRANSFER_CHECKED];
            data.extend(amount.to_le_bytes());
            data.push(6);
            self.instruction(program, &[VAULT_TOKENS, mint, to, VAULT_KEY], data)
        }

        fn unit_limit(self, units: u32) -> Self {
            let data = [vec![SET_COMPUTE_UNIT_LIMIT], units.to_le_bytes().to_vec()].concat();
            self.instruction(COMPUTE_BUDGET_PROGRAM, &[], data)
        }

        fn unit_price(self, micro_lamports: u64) -> Self {
            let data = [
                vec![SET_COMPUTE_UNIT_PRICE],
                micro_lamports.to_le_bytes().to_vec(),
            ];
            self.instruction(COMPUTE_BUDGET_PROGRAM, &[], data.concat())
        }

        fn build(&self) -> Vec<u8> {
            let mut out = self.header.to_vec();
            out.extend(short_vec(self.keys.len()));
            for key in &self.keys {
                out.extend(key);
            }
            out.extend([0x55; 32]);
            out.extend(short_vec(self.instructions.len()));
            for (program, accounts, data) in &self.instructions {
                out.push(*program as u8);
                out.extend(short_vec(accounts.len()));
                out.extend(accounts.iter().map(|index| *index as u8));
                out.extend(short_vec(data.len()));
                out.extend(data);
            }
            out
        }
    }

    fn run(message: &[u8]) -> Result<ParsedTx, CovenantError> {
        parse(message, &policy(), &VAULT_KEY)
    }

    fn sol_payment() -> Builder {
        Builder::new().nonce().sol(VAULT_KEY, PAYEE, 1_000_000)
    }

    fn usdc_payment() -> Builder {
        Builder::new()
            .nonce()
            .token(TOKEN_PROGRAM, USDC, PAYEE_TOKENS, 2_500_000)
    }

    #[test]
    fn sol_accepts_system_transfer() {
        let parsed = run(&sol_payment().build()).unwrap();
        assert_eq!(
            parsed.payments,
            vec![Payment {
                asset: AssetId::Sol,
                to: PAYEE.to_vec(),
                amount: U128(1_000_000),
            }]
        );
        // No limit set, so the priority fee is charged at the 1.4M-unit maximum. It's zero here.
        assert_eq!(parsed.fee, BASE_FEE);
        assert_eq!(parsed.fee_asset, AssetId::Sol);
    }

    #[test]
    fn sol_accepts_usdc_transfer_checked() {
        let parsed = run(&usdc_payment().build()).unwrap();
        assert_eq!(
            parsed.payments,
            vec![Payment {
                asset: AssetId::Spl { mint: USDC },
                to: PAYEE_TOKENS.to_vec(),
                amount: U128(2_500_000),
            }]
        );
        assert_eq!(parsed.fee_asset, AssetId::Sol);
    }

    /// Messages built by @solana/web3.js, so the parser is checked against an outside encoder.
    #[test]
    fn sol_parses_the_web3_js_vectors() {
        use near_sdk::serde_json::{self, Value};
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/vectors/solana_message.json"
        ))
        .unwrap();
        for vector in vectors["vectors"].as_array().unwrap() {
            let field = |name: &str| hex::decode(vector[name].as_str().unwrap()).unwrap();
            let name = vector["name"].as_str().unwrap();
            let vault: [u8; 32] = field("vault").try_into().unwrap();
            let payee = field("payee");
            let asset = match vector["asset"].as_str().unwrap() {
                "Sol" => AssetId::Sol,
                _ => AssetId::Spl {
                    mint: field("mint").try_into().unwrap(),
                },
            };
            let mut rules = policy();
            rules.caps.push(AssetCap {
                asset: asset.clone(),
                per_tx: U128(u128::MAX),
                per_24h: U128(u128::MAX),
                queue_at: U128(u128::MAX),
                unlisted_per_24h: U128(0),
            });
            rules.payees.push(Payee {
                chain: ChainKind::Solana,
                to: payee.clone(),
                label: "vector".into(),
            });
            let message = field("message");
            let parsed = parse(&message, &rules, &vault).unwrap_or_else(|e| panic!("{name}: {e}"));
            let amount: u128 = vector["amount"].as_str().unwrap().parse().unwrap();
            assert_eq!(
                parsed.payments,
                vec![Payment {
                    asset,
                    to: payee,
                    amount: U128(amount),
                }],
                "{name}"
            );
            let fee: u128 = vector["fee"].as_str().unwrap().parse().unwrap();
            assert_eq!(parsed.fee, fee, "{name}");
            assert_eq!(
                parsed.signing_payloads,
                vec![SignPayload::Eddsa(message.into())],
                "{name}"
            );
        }
    }

    #[test]
    fn sol_signs_exactly_the_checked_message() {
        let message = sol_payment().build();
        let parsed = run(&message).unwrap();
        assert_eq!(
            parsed.signing_payloads,
            vec![SignPayload::Eddsa(message.into())]
        );
    }

    #[test]
    fn sol_accepts_several_payments_and_sums_nothing_away() {
        let message = sol_payment().sol(VAULT_KEY, PAYEE, 5).build();
        assert_eq!(run(&message).unwrap().payments.len(), 2);
    }

    #[test]
    fn sol_rejects_unknown_program() {
        let message = sol_payment()
            .instruction([0x99; 32], &[VAULT_KEY], vec![1])
            .build();
        assert_eq!(run(&message), Err(CovenantError::CalldataNotAllowed));
    }

    #[test]
    fn sol_rejects_token_2022() {
        const TOKEN_2022: [u8; 32] = [
            0x06, 0xdd, 0xf6, 0xe1, 0xee, 0x75, 0x8f, 0xde, 0x18, 0x42, 0x5d, 0xbc, 0xe4, 0x6c,
            0xcd, 0xda, 0xb6, 0x1a, 0xfc, 0x4d, 0x83, 0xb9, 0x0d, 0x27, 0xfe, 0xbd, 0xf9, 0x28,
            0xd8, 0xa1, 0x8b, 0xfc,
        ];
        let message = Builder::new()
            .nonce()
            .token(TOKEN_2022, USDC, PAYEE_TOKENS, 1)
            .build();
        assert_eq!(run(&message), Err(CovenantError::CalldataNotAllowed));
    }

    #[test]
    fn sol_rejects_spl_approve_and_close() {
        // Approve(amount) is 4, CloseAccount is 9, SetAuthority is 6.
        for data in [vec![4, 0, 0, 0, 0, 0, 0, 0, 1], vec![9], vec![6, 2, 0]] {
            let message = Builder::new()
                .nonce()
                .instruction(TOKEN_PROGRAM, &[VAULT_TOKENS, STRANGER, VAULT_KEY], data)
                .build();
            assert_eq!(run(&message), Err(CovenantError::CalldataNotAllowed));
        }
    }

    #[test]
    fn sol_rejects_other_system_instructions() {
        // Assign (1) hands the vault's account to another program; CreateAccount (0) moves SOL.
        let assign = [1u32.to_le_bytes().to_vec(), STRANGER.to_vec()].concat();
        let message = Builder::new()
            .nonce()
            .instruction(SYSTEM_PROGRAM, &[VAULT_KEY], assign)
            .build();
        assert_eq!(run(&message), Err(CovenantError::CalldataNotAllowed));
        // A second nonce advance isn't a payment either.
        assert_eq!(
            run(&sol_payment().nonce().build()),
            Err(CovenantError::CalldataNotAllowed)
        );
    }

    #[test]
    fn sol_rejects_uncapped_mint() {
        let message = Builder::new()
            .nonce()
            .token(TOKEN_PROGRAM, OTHER_MINT, PAYEE_TOKENS, 1)
            .build();
        assert_eq!(run(&message), Err(CovenantError::TokenNotAllowed));
    }

    #[test]
    fn sol_rejects_unlisted_payee() {
        let sol = Builder::new().nonce().sol(VAULT_KEY, STRANGER, 1).build();
        assert_eq!(run(&sol), Err(CovenantError::OutputNotWhitelisted));
        let token = Builder::new()
            .nonce()
            .token(TOKEN_PROGRAM, USDC, STRANGER, 1)
            .build();
        assert_eq!(run(&token), Err(CovenantError::OutputNotWhitelisted));
        // One listed payment doesn't carry an unlisted one.
        let mixed = sol_payment().sol(VAULT_KEY, STRANGER, 1).build();
        assert_eq!(run(&mixed), Err(CovenantError::OutputNotWhitelisted));
    }

    #[test]
    fn sol_rejects_zero_amount() {
        let message = Builder::new().nonce().sol(VAULT_KEY, PAYEE, 0).build();
        assert_eq!(run(&message), Err(CovenantError::CalldataNotAllowed));
    }

    #[test]
    fn sol_rejects_nonce_advance_alone() {
        assert_eq!(
            run(&Builder::new().nonce().build()),
            Err(CovenantError::CalldataNotAllowed)
        );
    }

    #[test]
    fn sol_rejects_v0_with_lookup_tables() {
        // A v0 message starts with 0x80, then the legacy layout, then its table lookups.
        let mut message = vec![0x80];
        message.extend(sol_payment().build());
        message.extend([1, 0x77]);
        message.extend([0x66; 32]);
        message.extend([1, 0, 0]);
        assert_eq!(run(&message), Err(CovenantError::MalformedTx));
        // Even with no lookups, a versioned message is refused.
        let mut bare = vec![0x80];
        bare.extend(sol_payment().build());
        bare.push(0);
        assert_eq!(run(&bare), Err(CovenantError::MalformedTx));
    }

    #[test]
    fn sol_rejects_missing_nonce_advance() {
        let message = Builder::new().sol(VAULT_KEY, PAYEE, 1).build();
        assert_eq!(run(&message), Err(CovenantError::CalldataNotAllowed));
        // The advance must come first.
        let late = Builder::new().sol(VAULT_KEY, PAYEE, 1).nonce().build();
        assert_eq!(run(&late), Err(CovenantError::CalldataNotAllowed));
        // And the vault must be its authority, through the real sysvar.
        let foreign = Builder::new()
            .instruction(
                SYSTEM_PROGRAM,
                &[NONCE, RECENT_BLOCKHASHES_SYSVAR, STRANGER],
                SYSTEM_ADVANCE_NONCE.to_le_bytes().to_vec(),
            )
            .sol(VAULT_KEY, PAYEE, 1)
            .build();
        assert_eq!(run(&foreign), Err(CovenantError::CalldataNotAllowed));
        let fake_sysvar = Builder::new()
            .instruction(
                SYSTEM_PROGRAM,
                &[NONCE, [0x01; 32], VAULT_KEY],
                SYSTEM_ADVANCE_NONCE.to_le_bytes().to_vec(),
            )
            .sol(VAULT_KEY, PAYEE, 1)
            .build();
        assert_eq!(run(&fake_sysvar), Err(CovenantError::CalldataNotAllowed));
    }

    #[test]
    fn sol_rejects_priority_fee_above_cap() {
        // 95,000 lamports of priority plus the 5,000 base fee is exactly the cap.
        let at_cap = sol_payment()
            .unit_limit(200_000)
            .unit_price(475_000)
            .build();
        assert_eq!(run(&at_cap).unwrap().fee, MAX_FEE);
        let above = sol_payment()
            .unit_limit(200_000)
            .unit_price(475_001)
            .build();
        assert_eq!(run(&above), Err(CovenantError::FeeTooHigh));
        // With no limit, the price is charged at the 1.4M-unit maximum.
        let no_limit = sol_payment().unit_price(100_000).build();
        assert_eq!(run(&no_limit), Err(CovenantError::FeeTooHigh));
        let huge = sol_payment()
            .unit_limit(u32::MAX)
            .unit_price(u64::MAX)
            .build();
        assert_eq!(run(&huge), Err(CovenantError::FeeTooHigh));
    }

    #[test]
    fn sol_rejects_repeated_or_unknown_budget_instructions() {
        let twice = sol_payment().unit_price(1).unit_price(1).build();
        assert_eq!(run(&twice), Err(CovenantError::CalldataNotAllowed));
        // RequestHeapFrame (1).
        let heap = sol_payment()
            .instruction(COMPUTE_BUDGET_PROGRAM, &[], vec![1, 0, 0, 1, 0])
            .build();
        assert_eq!(run(&heap), Err(CovenantError::CalldataNotAllowed));
    }

    #[test]
    fn sol_rejects_transfer_from_another_account() {
        let message = Builder::new().nonce().sol(STRANGER, PAYEE, 1).build();
        assert_eq!(run(&message), Err(CovenantError::InputNotOwned));
    }

    #[test]
    fn sol_rejects_fee_payer_other_than_vault() {
        let message = sol_payment().build();
        assert_eq!(
            parse(&message, &policy(), &STRANGER),
            Err(CovenantError::InputNotOwned)
        );
    }

    #[test]
    fn sol_rejects_a_second_signer_or_readonly_payer() {
        let mut two = sol_payment();
        two.header = [2, 0, 0];
        assert_eq!(run(&two.build()), Err(CovenantError::MalformedTx));
        let mut readonly = sol_payment();
        readonly.header = [1, 1, 0];
        assert_eq!(run(&readonly.build()), Err(CovenantError::MalformedTx));
    }

    #[test]
    fn sol_rejects_duplicate_keys_and_bad_indices() {
        let mut duplicate = sol_payment();
        duplicate.keys.push(PAYEE);
        assert_eq!(run(&duplicate.build()), Err(CovenantError::MalformedTx));
        let mut out_of_range = sol_payment();
        out_of_range.instructions[1].1[1] = 200;
        assert_eq!(run(&out_of_range.build()), Err(CovenantError::MalformedTx));
    }

    #[test]
    fn sol_rejects_trailing_bytes_and_truncation() {
        let mut long = sol_payment().build();
        long.push(0);
        assert_eq!(run(&long), Err(CovenantError::MalformedTx));
        let short = sol_payment().build();
        assert_eq!(
            run(&short[..short.len() - 1]),
            Err(CovenantError::MalformedTx)
        );
        assert_eq!(run(&[]), Err(CovenantError::MalformedTx));
    }

    #[test]
    fn sol_rejects_oversized_message() {
        let mut builder = sol_payment();
        while builder.build().len() <= MAX_MESSAGE_LEN {
            builder = builder.sol(VAULT_KEY, PAYEE, 1);
        }
        assert_eq!(run(&builder.build()), Err(CovenantError::MalformedTx));
    }

    #[test]
    fn compact_u16_accepts_only_canonical_lengths() {
        assert_eq!(compact_u16(&[0x05]).unwrap().0, 5);
        assert_eq!(compact_u16(&[0x80, 0x01]).unwrap().0, 128);
        assert_eq!(compact_u16(&[0xff, 0xff, 0x03]).unwrap().0, 0xffff);
        assert!(compact_u16(&[0x85, 0x00]).is_err(), "5 with a padding byte");
        assert!(compact_u16(&[0xff, 0xff, 0x04]).is_err(), "above u16");
        assert!(compact_u16(&[0x80, 0x80, 0x80, 0x01]).is_err());
        assert!(compact_u16(&[0x80]).is_err());
    }

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(2048))]

        /// Flips bytes of allowed messages. Each is refused, or it still pays only listed payees
        /// within the fee cap, and the vault signs the mutated bytes rather than the original.
        #[test]
        fn prop_mutated_solana_message_never_pays_elsewhere(
            flips in proptest::collection::vec((0usize..400, 1u8..=255), 1..4),
            token in proptest::prelude::any::<bool>(),
            budget in proptest::prelude::any::<bool>(),
        ) {
            let mut builder = if token { usdc_payment() } else { sol_payment() };
            if budget {
                builder = builder.unit_limit(10_000).unit_price(1_000);
            }
            let original = builder.build();
            let mut mutated = original.clone();
            for (index, mask) in flips {
                let index = index % mutated.len();
                mutated[index] ^= mask;
            }
            proptest::prop_assume!(mutated != original);
            if let Ok(parsed) = run(&mutated) {
                proptest::prop_assert!(parsed
                    .payments
                    .iter()
                    .all(|p| p.to == PAYEE || p.to == PAYEE_TOKENS));
                proptest::prop_assert!(parsed.fee <= MAX_FEE);
                proptest::prop_assert_eq!(
                    parsed.signing_payloads,
                    vec![SignPayload::Eddsa(mutated.into())]
                );
            }
        }

        /// Random bytes never get a signature.
        #[test]
        fn prop_random_bytes_are_refused(bytes in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..300)) {
            proptest::prop_assert!(run(&bytes).is_err());
        }
    }
    #[test]
    fn sol_hold_mode_accepts_an_unlisted_payee() {
        let mut open = policy();
        open.unlisted = UnlistedPayees::Hold;
        let sol = Builder::new().nonce().sol(VAULT_KEY, STRANGER, 1).build();
        let parsed = parse(&sol, &open, &VAULT_KEY).unwrap();
        assert_eq!(parsed.payments[0].to, STRANGER.to_vec());
    }
}
