import type { ApiRequest, ApiResponse, Transport } from "./judge.js";

/** An offline transport for tests and the no-key path. It makes no network call. */
export function stubTransport(
  answer: (request: ApiRequest) => { dimensions: Record<string, number>; findings?: unknown[] } | ApiResponse,
  usage = { input_tokens: 1000, output_tokens: 200 },
): Transport {
  return async (request) => {
    const out = answer(request);
    if ("content" in out) return out;
    return { content: [{ type: "text", text: JSON.stringify({ findings: [], ...out }) }], stop_reason: "end_turn", usage };
  };
}

/** The sequence numbers in the evidence block of a request. Lets a stub cite real entries. */
export function seqsIn(request: ApiRequest): number[] {
  const text = request.messages[0]?.content ?? "";
  const begin = text.indexOf("BEGIN-DATA-");
  const rows = text.slice(text.indexOf("\n", begin) + 1, text.lastIndexOf("END-DATA-"));
  return (JSON.parse(rows) as { seq: number }[]).map((r) => r.seq);
}
