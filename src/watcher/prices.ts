/** Read from the pricing page of Anthropic. Update with the date when it changes. Results files copy this table. */
export const prices = {
  source: "https://platform.claude.com/docs/en/about-claude/pricing",
  read_on: "2026-11-17",
  unit: "USD per million tokens, base input and output only",
  models: {
    "claude-opus-5-5": { input: 4, output: 20 },
    "claude-sonnet-5-5": { input: 2, output: 10 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  } as Record<string, { input: number; output: number }>,
};
