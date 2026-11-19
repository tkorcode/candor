import { CLEAN_LABELS, FAILURE_LABELS } from "./labels.js";

/** The fixed seed of the calibration and held-out split. Record it in every manifest. */
export const SPLIT_SEED = 20261119;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export type Half = "calibration" | "held_out";

/** Failures and clean runs are split separately, so each half gets both. The split is not chosen by hand. */
export function splitOf(seed: number = SPLIT_SEED): Record<string, Half> {
  const out: Record<string, Half> = {};
  for (const [ids, offset] of [[FAILURE_LABELS.map((l) => l.id), 1], [CLEAN_LABELS.map((l) => l.id), 2]] as const) {
    const order = shuffled([...ids], seed + offset);
    const cut = Math.ceil(order.length / 2);
    order.forEach((id, i) => {
      out[id] = i < cut ? "calibration" : "held_out";
    });
  }
  return out;
}
