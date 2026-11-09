export type LogFields = Record<string, unknown>;
export type Log = (step: string, fields?: LogFields) => void;

/** One JSON object per line on stderr, leaving stdout for the result. */
export const jsonLog: Log = (step, fields = {}) => {
  console.error(
    JSON.stringify({ at: new Date().toISOString(), step, ...fields }, (_, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
};
