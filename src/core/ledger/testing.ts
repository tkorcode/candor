import type { AppendInput } from "./ledger.js";

/** A fixed clock for tests and scripted traces. Each call moves one second on. */
export function fixedClock(start = "2026-11-18T12:00:00.000Z"): () => Date {
  let tick = 0;
  return () => new Date(Date.parse(start) + 1000 * tick++);
}

/**
 * A scripted stream of events, like the ones the hooks produce. It is data, so
 * two runs of it give the same hashes when the clock is fixed.
 */
export function scriptedStream(): AppendInput[] {
  const stream: AppendInput[] = [
    { type: "session_start", actor: "worker", body: { session: "s1", source: "startup", model: "scripted", workspace: "/work" } },
  ];
  for (let i = 1; i <= 6; i++) {
    stream.push({ type: "tool_intent", actor: "worker", body: { session: "s1", tool: "Bash", tool_use_id: `t${i}`, input_digest: `sha256:${String(i).repeat(64)}`, decision: "allow" } });
    stream.push({ type: "tool_result", actor: "worker", body: { session: "s1", tool: "Bash", tool_use_id: `t${i}`, failed: false, result_digest: `sha256:${String(i + 1).repeat(64)}` } });
  }
  stream.push({ type: "stage_report", actor: "worker", body: { stage: "profile", form: "file", accepted: true, report_digest: `sha256:${"a".repeat(64)}`, bytes: 120 } });
  stream.push({ type: "hook_event", actor: "worker", body: { session: "s1", event: "Stop" } });
  stream.push({ type: "human_action", actor: "operator", body: { action: "pause", accepted: true } });
  return stream;
}

/**
 * Strings shaped like credentials, for the redaction tests. None is a real key. They are put together at run
 * time so that no credential-shaped text sits in the source, where secret scanners would rightly flag it.
 */
const part = (...pieces: string[]): string => pieces.join("");
export const FAKE_SECRET = {
  anthropic: (tail = "abcdefghijklmnopqrstuvwxyz0123456789") => part("sk-", "ant-", "api03-", tail),
  aws: part("AK", "IA", "ABCDEFGHIJKLMNOP"),
  github: part("gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"),
  pem: (body: string) => `${part("-----BEGIN ", "PRIVATE KEY-----")}\n${body}\n${part("-----END ", "PRIVATE KEY-----")}`,
};
