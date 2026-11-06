import type { Spend } from "./runtime.js";

export interface Verdict {
  passed: boolean;
  summary: string;
}

const ATTACK_ERRORS = ["OutputNotWhitelisted", "CalldataNotAllowed"];

/** Each scenario's pass condition, from docs/SPEC.md "Demo scenarios". */
export function check(scenario: string, spends: Spend[], attackers: string[]): Verdict {
  const signed = spends.filter(({ report }) => report.status === "broadcast");
  if (scenario === "pay") {
    return {
      passed: signed.length === 2,
      summary: `${signed.length} of 2 payments signed`,
    };
  }
  if (scenario === "attack") {
    const errors = spends.flatMap(({ report }) => (report.status === "rejected" ? [report.error] : []));
    const missing = ATTACK_ERRORS.filter((error) => !errors.includes(error));
    const leaked = signed.filter(({ to }) => attackers.includes(to.toLowerCase()));
    return {
      passed: missing.length === 0 && leaked.length === 0,
      summary:
        leaked.length > 0
          ? `an attacker was paid: ${leaked.map(({ to }) => to).join(", ")}`
          : missing.length === 0
            ? `the contract refused both attacks: ${ATTACK_ERRORS.join(" and ")}`
            : `expected refusals missing: ${missing.join(", ")}`,
    };
  }
  const queued = spends.filter(({ report }) => report.status === "queued");
  return {
    passed: queued.length === 1 && signed.length === 0,
    summary: `${queued.length} spend queued for the veto window, ${signed.length} signed`,
  };
}
