import { describe, expect, test } from "vitest";
import { gatewayCatalog } from "../onboarding/catalog.js";
import { acquisitionDescription } from "../onboarding/setup.js";

const tail = ". Private dedicated install, no shell profile or OS service registration.";

describe("setup acquisition review text", () => {
  const { nix, native } = gatewayCatalog;
  if (nix === null || native === null) {
    throw new Error("Shipped catalog must pin both routes");
  }
  test("a native selection names its manifest pin and no unavailable-fallback clause", () => {
    expect(acquisitionDescription({ method: "native", ...native }, null)).toBe(
      `Acquire ${native.version} from reviewed native source ${native.sourceRevision}, artifact manifest SHA256 ${native.manifestSha256}${tail}`,
    );
  });
  test("a Nix selection states explicit native fallback consent", () => {
    expect(acquisitionDescription({ method: "nix", ...nix }, native)).toBe(
      `Acquire ${nix.version} from reviewed nix source ${nix.sourceRevision}, source NAR hash ${nix.narHash}; if Nix is unusable/build fails, this Apply also authorizes verified native fallback ${native.version} source ${native.sourceRevision} manifest SHA256 ${native.manifestSha256}${tail}`,
    );
  });
  test("a Nix selection without a native pin honestly reports no fallback", () => {
    const text = acquisitionDescription({ method: "nix", ...nix }, null);
    expect(text).toBe(
      `Acquire ${nix.version} from reviewed nix source ${nix.sourceRevision}, source NAR hash ${nix.narHash}; no published native fallback is available${tail}`,
    );
    expect(text).not.toContain("authorizes");
  });
});
