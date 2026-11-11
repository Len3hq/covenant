import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/* Small parts the pages share. None of them decides anything: the vault checks every rule. */

/** A colourful dot derived from a name, so accounts and vaults are told apart at a glance. */
export function Identicon({ seed, size = 28 }: { seed: string; size?: number }) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const a = hash % 360;
  const b = (a + 40 + ((hash >> 9) % 80)) % 360;
  return (
    <span
      className="identicon"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${a} 80% 60%), hsl(${b} 75% 45%))`,
      }}
    />
  );
}

/** A copy button that says so for two seconds. */
export function CopyButton({ text, label = "Copy", compact }: { text: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={compact ? "icon-button" : "ghost copy-button"}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "✓" : "⧉"}
      {compact ? null : ` ${copied ? "Copied" : label}`}
    </button>
  );
}

/** An address shortened in the middle, with copy and an explorer link. */
export function AddressChip({ label, address, href }: { label: string; address: string; href?: string }) {
  return (
    <span className="address-chip">
      <span className="address-chip-label">{label}</span>
      {href ? (
        <a className="mono" href={href} title={address}>
          {middle(address)}
        </a>
      ) : (
        <span className="mono" title={address}>
          {middle(address)}
        </span>
      )}
      <CopyButton text={address} label={`Copy the ${label} address`} compact />
    </span>
  );
}

export const middle = (text: string, head = 8, tail = 6) =>
  text.length > head + tail + 1 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text;

/** A ⓘ that explains a term on hover or focus. */
export function InfoTip({ children }: { children: ReactNode }) {
  const id = useId();
  return (
    <span className="infotip">
      <button type="button" className="infotip-button" aria-describedby={id} aria-label="What's this?">
        ⓘ
      </button>
      <span role="tooltip" id={id} className="infotip-body">
        {children}
      </span>
    </span>
  );
}

/** A short "what this is and what to do" line at the top of a section. */
export function Explainer({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="explainer">
      {title && <strong>{title}</strong>}
      <span>{children}</span>
    </div>
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: string;
  badge?: number | string | null;
}

/** Tabs whose choice lives in the URL hash, so a link can open one. */
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: TabDef<T>[]; value: T; onChange(tab: T): void }) {
  return (
    <nav className="page-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          className={value === tab.id ? "page-tab active" : "page-tab"}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.badge ? <span className="tab-badge">{tab.badge}</span> : null}
        </button>
      ))}
    </nav>
  );
}

export function useHashTab<T extends string>(tabs: readonly T[], fallback: T): [T, (tab: T) => void] {
  const read = () => {
    const hash = (typeof location === "undefined" ? "" : location.hash.slice(1)) as T;
    return tabs.includes(hash) ? hash : fallback;
  };
  const [tab, setTab] = useState<T>(read);
  useEffect(() => {
    const onHash = () => setTab(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return [
    tab,
    (next: T) => {
      setTab(next);
      history.replaceState(null, "", `${location.pathname}${location.search}#${next}`);
    },
  ];
}

/** Where a multi-step form is. */
export function Stepper({ steps, current, onPick }: { steps: string[]; current: number; onPick?(index: number): void }) {
  return (
    <ol className="stepper">
      {steps.map((step, index) => {
        const state = index < current ? "done" : index === current ? "current" : "todo";
        return (
          <li key={step} className={`step step-${state}`}>
            <button type="button" disabled={!onPick || index > current} onClick={() => onPick?.(index)}>
              <span className="step-dot">{state === "done" ? "✓" : index + 1}</span>
              <span className="step-label">{step}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** A choice shown as a card, for the few decisions that matter most. */
export function ChoiceCard({
  name,
  checked,
  onSelect,
  title,
  children,
  badge,
}: {
  name: string;
  checked: boolean;
  onSelect(): void;
  title: string;
  children: ReactNode;
  badge?: string;
}) {
  return (
    <label className={checked ? "choice-card checked" : "choice-card"}>
      <input type="radio" name={name} checked={checked} onChange={onSelect} />
      <span className="choice-title">
        {title}
        {badge && <span className="badge">{badge}</span>}
      </span>
      <span className="choice-body">{children}</span>
    </label>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ width: `${90 - i * 15}%` }} />
      ))}
    </div>
  );
}

export type ToastTone = "pending" | "success" | "error" | "info";

/** The wallet's progress, read from the page's status message, in the corner of the screen. */
export function Toast({ message, onClose }: { message: string | null; onClose(): void }) {
  const tone = toneOf(message);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    if (message && tone === "success") timer.current = setTimeout(onClose, 8000);
    return () => clearTimeout(timer.current);
  }, [message, tone, onClose]);
  if (!message) return null;
  return (
    <div className={`toast toast-${tone}`} role="status" aria-live="polite">
      <span className="toast-icon">{tone === "pending" ? <span className="spinner" /> : tone === "error" ? "!" : "✓"}</span>
      <span className="toast-text">{message}</span>
      <button type="button" className="icon-button" aria-label="Dismiss" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

/** How a status message reads: still waiting, done, or failed. */
export function toneOf(message: string | null): ToastTone {
  if (!message) return "info";
  if (/failed|couldn't|error|refused/i.test(message)) return "error";
  if (/waiting|sign \d of \d|…$/i.test(message)) return "pending";
  if (/sent|now|added|removed|created|updates within/i.test(message)) return "success";
  return "info";
}
