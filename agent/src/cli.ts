import { z } from "zod";

export const scenarios = ["pay", "attack", "queue"] as const;

const argsSchema = z.object({
  scenario: z.enum([...scenarios, "all"]),
  /** Live testnets with the agent's key, instead of the local sandbox. */
  live: z.boolean(),
  /** A real model, instead of replaying saved tool calls. */
  llm: z.boolean(),
  /** Saves a model run's tool calls as the scenario's replay. */
  record: z.boolean(),
  /** Resumes an earlier run, whose spends are on record, instead of paying again. */
  run: z.string().optional(),
});

export type CliArgs = z.infer<typeof argsSchema>;

export function parseArgs(argv: string[]): CliArgs {
  const runFlag = argv.indexOf("--run");
  const run = runFlag === -1 ? undefined : argv[runFlag + 1];
  const scenario = argv.find(
    (arg, index) => !arg.startsWith("--") && (runFlag === -1 || index !== runFlag + 1),
  );
  const args = argsSchema.parse({
    scenario,
    live: argv.includes("--live"),
    llm: argv.includes("--llm"),
    record: argv.includes("--record"),
    ...(run ? { run } : {}),
  });
  if (args.record && !args.llm) throw new Error("--record needs --llm: only a model run is recorded");
  return args;
}
