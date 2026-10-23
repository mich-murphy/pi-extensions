import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { Catalogue } from "../types";
import { createTerminologyBrowser } from "../ui";

const catalogue: Catalogue = {
  hash: "details-test",
  recognition: [],
  concepts: [
    {
      id: "core:long-entry",
      label: "long entry",
      domain: "testing",
      definition: "A deliberately long definition. ".repeat(20),
      scopeNote: "A deliberately long boundary explanation. ".repeat(20),
      references: [
        { kind: "web", title: "Source at the end", url: "https://example.com/provenance" },
      ],
    },
    {
      id: "core:short-entry",
      label: "short entry",
      domain: "testing",
      definition: "A short definition.",
      references: [{ kind: "web", title: "Short source", url: "https://example.com/short" }],
    },
  ],
};

function browser() {
  return createTerminologyBrowser(
    { requestRender: () => undefined },
    catalogue,
    "",
    [],
    () => undefined,
  );
}

describe("complete terminology details", () => {
  test.each([60, 120])(
    "makes long definitions, scope and source accessible at %i columns",
    (width) => {
      const view = browser();
      expect(view.render(width).join("\n")).toContain("Details 1–10");
      expect(view.render(width).join("\n")).not.toContain("Source at the end");
      view.handleInput?.("\u001b[1;5F"); // Ctrl+End
      const last = view.render(width);
      expect(last.join("\n")).toContain("Source at the end");
      expect(last.join("\n")).toContain("https://example.com/provenance");
      expect(last.every((line) => visibleWidth(line) <= width)).toBe(true);
      view.handleInput?.("\u001b[1;5H"); // Ctrl+Home
      expect(view.render(width).join("\n")).toContain("Details 1–10");
      view.handleInput?.("\u001b[1;5B"); // Ctrl+Down
      expect(view.render(width).join("\n")).toContain("Details 2–11");
      view.handleInput?.("\u001b[1;5A"); // Ctrl+Up
      expect(view.render(width).join("\n")).toContain("Details 1–10");
    },
  );

  test("resets detail scrolling on entry and query changes", () => {
    const view = browser();
    view.handleInput?.("\u001b[1;5F");
    view.render(60);
    view.handleInput?.("\u001b[B");
    expect(view.render(60).join("\n")).toContain("Short source");
    view.handleInput?.("\u001b[A");
    expect(view.render(60).join("\n")).toContain("Details 1–10");
    view.handleInput?.("\u001b[1;5F");
    view.render(60);
    view.handleInput?.("long");
    expect(view.render(60).join("\n")).toContain("Details 1–10");
  });
});
