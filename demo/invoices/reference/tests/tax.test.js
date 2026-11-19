import test from "node:test";
import assert from "node:assert";
import { taxFor } from "../src/index.js";

test("taxes by region", () => {
  assert.strictEqual(taxFor("south", 10000), 600);
  assert.strictEqual(taxFor("east", 10000), 750);
});

test("refuses an unknown region", () => {
  assert.throws(() => taxFor("mars", 100), /Unknown region/);
});
