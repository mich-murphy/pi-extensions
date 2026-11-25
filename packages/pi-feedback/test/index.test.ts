import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FEEDBACK_TOOL } from "../feedback.ts";
import piFeedback from "../index.ts";
import { ledgerPath, readLedger } from "../ledger.ts";
import { fakePi } from "./fake-pi.ts";

const PACKAGES_DIR = fileURLToPath(new URL("../..", import.meta.url));

describe("extension factory", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-feedback-index-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  test("registers the tool and writes to the agent directory's ledger", async () => {
    const pi = fakePi(PACKAGES_DIR);
    piFeedback(pi.pi);
    expect(pi.tools.map((tool) => tool.name)).toStrictEqual([FEEDBACK_TOOL]);

    await pi.end("webfetch", true, "Request failed (404 Not Found).");
    const { events } = await readLedger(ledgerPath(root));
    expect(events).toMatchObject([
      { type: "signal", tool: "webfetch", owner: "pi-web", piVersion: VERSION },
    ]);
  });
});
