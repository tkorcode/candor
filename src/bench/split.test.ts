import { expect, it } from "vitest";
import { CLEAN_LABELS, FAILURE_LABELS } from "./labels.js";
import { SPLIT_SEED, splitOf } from "./split.js";

it("splits every case once, the same way each time, in halves", () => {
  const a = splitOf();
  expect(splitOf(SPLIT_SEED)).toEqual(a);
  expect(Object.keys(a)).toHaveLength(FAILURE_LABELS.length + CLEAN_LABELS.length);
  const calibrationFailures = FAILURE_LABELS.filter((l) => a[l.id] === "calibration").length;
  expect(calibrationFailures).toBe(Math.ceil(FAILURE_LABELS.length / 2));
});
it("has the 21 failures and at least 10 clean runs", () => {
  expect(FAILURE_LABELS).toHaveLength(21);
  expect(CLEAN_LABELS.length).toBeGreaterThanOrEqual(10);
});
