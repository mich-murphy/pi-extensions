import { describe, expect, test } from "vitest";
import { AGENT_DIR_VARIABLE, agentDir } from "../agent-dir.ts";

describe("agentDir", () => {
  test.each([
    [undefined, "/home/u/.pi/agent"],
    ["", "/home/u/.pi/agent"],
    ["~", "/home/u"],
    ["~/custom/agent", "/home/u/custom/agent"],
    ["file:///srv/agent", "/srv/agent"],
    ["/opt/agent", "/opt/agent"],
    ["relative/agent", "relative/agent"],
  ])("resolves %j to %s", (configured, expected) => {
    expect(agentDir({ [AGENT_DIR_VARIABLE]: configured }, "/home/u")).toBe(expected);
  });
});
