import { z } from "zod";

export const scenarios = ["pay", "attack", "queue"] as const;

const argsSchema = z.object({
  scenario: z.enum(scenarios),
  replay: z.boolean(),
});

export type CliArgs = z.infer<typeof argsSchema>;

export function parseArgs(argv: string[]): CliArgs {
  const replay = argv.includes("--replay");
  const scenario = argv.find((arg) => !arg.startsWith("--"));
  return argsSchema.parse({ scenario, replay });
}
