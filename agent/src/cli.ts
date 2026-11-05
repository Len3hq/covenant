import { z } from "zod";

export const scenarios = ["pay", "attack", "queue"] as const;

const argsSchema = z.object({
  scenario: z.enum(scenarios),
  replay: z.boolean(),
  /** Resumes an earlier run, whose spends are on record, instead of paying again. */
  run: z.string().optional(),
});

export type CliArgs = z.infer<typeof argsSchema>;

export function parseArgs(argv: string[]): CliArgs {
  const replay = argv.includes("--replay");
  const runFlag = argv.indexOf("--run");
  const run = runFlag === -1 ? undefined : argv[runFlag + 1];
  const scenario = argv.find(
    (arg, index) => !arg.startsWith("--") && (runFlag === -1 || index !== runFlag + 1),
  );
  return argsSchema.parse({ scenario, replay, ...(run ? { run } : {}) });
}
