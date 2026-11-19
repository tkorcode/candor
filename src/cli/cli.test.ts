import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anchorHead } from "../core/anchor/file.js";
import { Ledger } from "../core/ledger/ledger.js";
import { scriptedStream } from "../core/ledger/testing.js";
import { anchorPath, ledgerPath } from "../core/paths.js";
import { main } from "./main.js";

const FIXTURE = new URL("../core/charter/fixtures/migrate-customers.yaml", import.meta.url).pathname;
let home: string;
let work: string;
let out: string;
let err: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cli-home-"));
  work = mkdtempSync(join(tmpdir(), "cli-work-"));
  process.env.CANDOR_HOME = home;
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CANDOR_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe("candor charter and candor verify", () => {
  it("drafts a charter, flags what is missing, and refuses to approve it until each item is resolved", async () => {
    const file = join(work, "charter.yaml");
    expect(await main(["charter", "new", "--goal", "Improve the data.", "--out", file])).toBe(0);
    expect(await main(["charter", "review", file])).toBe(1);
    expect(out).toMatch(/OPEN\s+vague_goal:goal/);
    expect(out).toMatch(/OPEN\s+unchecked_criterion:s1/);
    expect(await main(["charter", "approve", file])).toBe(1);
    expect(err).toMatch(/nobody has resolved/);
  });

  it("goes from the sample charter to a run whose ledger verifies", async () => {
    const file = join(work, "charter.yaml");
    writeFileSync(file, readFileSync(FIXTURE, "utf8"));
    expect(await main(["charter", "review", file])).toBe(1);
    expect(await main(["charter", "review", file, "--accept", "unchecked_criterion:s3=No check exists for contact recency.", "--accept", "check_without_fault:no-pii-in-logs=Pattern checks have no fault command."])).toBe(0);
    expect(await main(["charter", "approve", file, "--run", "r_demo"])).toBe(0);
    out = "";
    expect(await main(["verify", "r_demo"])).toBe(0);
    expect(out).toMatch(/verifies: 2 entries/);
    expect(out).toMatch(/No anchor file was checked/);
  });

  it("fails verify on a changed ledger and names the first bad entry", async () => {
    const file = join(work, "charter.yaml");
    writeFileSync(file, readFileSync(FIXTURE, "utf8"));
    await main(["charter", "review", file, "--accept", "unchecked_criterion:s3=none", "--accept", "check_without_fault:no-pii-in-logs=none"]);
    await main(["charter", "approve", file, "--run", "r_demo"]);
    const ledger = ledgerPath(home, "r_demo");
    writeFileSync(ledger, readFileSync(ledger, "utf8").replace('"version":1', '"version":2'));
    out = "";
    expect(await main(["verify", "r_demo"])).toBe(1);
    expect(out).toMatch(/FAILED. First bad entry: 1/);
  });

  it("checks anchors when a run has them", async () => {
    const ledger = Ledger.open({ path: ledgerPath(home, "r_scripted"), run: "r_scripted" });
    for (const event of scriptedStream()) ledger.append(event);
    anchorHead(ledger, anchorPath(home, "r_scripted"));
    expect(await main(["verify", "r_scripted"])).toBe(0);
    expect(out).toMatch(/1 anchor from outside the ledger matched/);
  });

  it("says what to do when there is nothing to verify", async () => {
    expect(await main(["verify", "r_missing"])).toBe(1);
    expect(out).toMatch(/There is no ledger/);
    expect(await main(["verify"])).toBe(2);
  });
});
