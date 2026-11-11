import type { CapForm, PayeeForm } from "./create";

/* Form parts shared by the create page and the policy editor. */

export function Field({
  label,
  value,
  onChange,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export function CapFields({
  name,
  cap,
  open,
  onChange,
}: {
  name: string;
  cap: CapForm;
  open: boolean;
  onChange(cap: CapForm): void;
}) {
  return (
    <fieldset className="caps">
      <legend>{name}</legend>
      <Field label="Most per payment" value={cap.perTx} onChange={(perTx) => onChange({ ...cap, perTx })} />
      <Field label="Most per 24 hours" value={cap.per24h} onChange={(per24h) => onChange({ ...cap, per24h })} />
      <Field
        label="Hold for veto from"
        value={cap.queueAt}
        onChange={(queueAt) => onChange({ ...cap, queueAt })}
      />
      {open && (
        <Field
          label="New payees, most per 24 hours"
          value={cap.unlisted24h}
          hint="0 means new payees can't be paid in this asset."
          onChange={(unlisted24h) => onChange({ ...cap, unlisted24h })}
        />
      )}
    </fieldset>
  );
}

export function Payees({
  payees,
  open,
  onChange,
}: {
  payees: PayeeForm[];
  open: boolean;
  onChange(payees: PayeeForm[]): void;
}) {
  const update = (index: number, patch: Partial<PayeeForm>) =>
    onChange(payees.map((payee, i) => (i === index ? { ...payee, ...patch } : payee)));
  return (
    <fieldset className="payee-list">
      <legend>{open ? "Trusted payees (optional)" : "Who it may pay"}</legend>
      <p className="muted small">
        {open
          ? "These are paid without the new-payee wait. Anyone else can be paid too, but each payment waits out the new-payee window so you can veto it."
          : "Everything else is refused."}{" "}
        Bitcoin payees must be tb1q addresses. A Solana payee's USDC account is listed for you, and must
        already exist.
      </p>
      {payees.map((payee, index) => (
        <div className="payee-row" key={index}>
          <input
            aria-label="Payee name"
            placeholder="Name"
            value={payee.label}
            onChange={(event) => update(index, { label: event.target.value })}
          />
          <select
            aria-label="Payee chain"
            value={payee.chain}
            onChange={(event) => update(index, { chain: event.target.value as PayeeForm["chain"] })}
          >
            <option value="Bitcoin">Bitcoin</option>
            <option value="Evm">Base</option>
            <option value="Solana">Solana</option>
          </select>
          <input
            aria-label="Payee address"
            className="mono"
            placeholder={payee.chain === "Bitcoin" ? "tb1q…" : payee.chain === "Solana" ? "Solana address" : "0x…"}
            value={payee.address}
            onChange={(event) => update(index, { address: event.target.value })}
          />
          <button type="button" className="ghost" onClick={() => onChange(payees.filter((_, i) => i !== index))}>
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ghost"
        onClick={() => onChange([...payees, { label: "", chain: "Bitcoin", address: "" }])}
      >
        Add a payee
      </button>
    </fieldset>
  );
}

