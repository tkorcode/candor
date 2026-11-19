import { prices } from "./prices.js";

export interface Price {
  input: number;
  output: number;
}

export function priceFor(model: string, table: Record<string, Price> = prices.models): Price {
  const price = table[model];
  if (!price) {
    throw new Error(
      `No price is known for model "${model}". Add it to src/watcher/prices.ts from the pricing page of Anthropic, then run again.`,
    );
  }
  return price;
}

export function costOf(price: Price, inputTokens: number, outputTokens: number): number {
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** A deliberately high estimate: three characters to a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
