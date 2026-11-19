import { describe, expect, it } from "vitest";
import { CandorContainer } from "./container.js";

describe("the container of a Claude Code job", () => {
  // A static field would hide the library's setter, register no handler, and the platform would refuse every call.
  it("registers its outbound handlers with the container library", () => {
    expect(Object.getOwnPropertyDescriptor(CandorContainer, "outboundByHost")).toBeUndefined();
    expect(Object.keys(CandorContainer.outboundByHost ?? {})).toEqual(["anthropic.gateway"]);
    expect(typeof CandorContainer.outbound).toBe("function");
  });
});
