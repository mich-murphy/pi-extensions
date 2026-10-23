import { Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Catalogue, Concept, Match, Reference } from "./types";
import { normalizeLabel } from "./validation";

const WIDGET_KEY = "pi-terminology";
const MAX_VISIBLE_TERMS = 3;
const LIST_ROWS = 8;
const DETAIL_ROWS = 10;

export type WidgetUI = {
  readonly setWidget: (
    key: string,
    content: string[] | undefined,
    options?: { readonly placement?: "aboveEditor" | "belowEditor" },
  ) => void;
};

export function renderReminder(matches: readonly Match[]): string[] {
  if (matches.length === 0) {
    return [];
  }
  const shown = matches.slice(0, MAX_VISIBLE_TERMS).map((match) => match.concept.label);
  const more = matches.length > shown.length ? ` +${matches.length - shown.length} more` : "";
  return [
    `Terms: ${shown.join(", ")}${more}. Ctrl+Shift+T or /terminology for details; /terminology-hide <id> hides one.`,
  ];
}

export function showReminder(ui: WidgetUI, matches: readonly Match[]): void {
  ui.setWidget(WIDGET_KEY, renderReminder(matches), { placement: "aboveEditor" });
}

export function clearReminder(ui: WidgetUI): void {
  ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
}

export function createTerminologyBrowser(
  tui: Pick<TUI, "requestRender">,
  catalogue: Catalogue,
  initialQuery: string,
  currentMatches: readonly Match[],
  done: () => void,
): Component {
  return new TerminologyBrowser(tui, catalogue, initialQuery, currentMatches, done);
}

class TerminologyBrowser implements Component {
  private readonly input = new Input({
    prompt: "Search terms: ",
    placeholder: "label, alias, domain, source",
  });
  private selected = 0;
  private detailOffset = 0;
  private readonly history: string[] = [];

  constructor(
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly catalogue: Catalogue,
    initialQuery: string,
    private readonly currentMatches: readonly Match[],
    private readonly done: () => void,
  ) {
    this.input.focused = true;
    this.input.setValue(initialQuery.trim());
    this.input.onSubmit = () => {
      this.selected = 0;
      this.requestRender();
    };
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.escape();
      return;
    }
    if (matchesKey(data, Key.ctrl("down")) || matchesKey(data, Key.ctrl("up"))) {
      this.detailOffset = Math.max(
        0,
        this.detailOffset + (matchesKey(data, Key.ctrl("down")) ? 1 : -1),
      );
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("end")) || matchesKey(data, Key.ctrl("home"))) {
      this.detailOffset = matchesKey(data, Key.ctrl("end")) ? Number.MAX_SAFE_INTEGER : 0;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.move(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.move(-LIST_ROWS);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.move(LIST_ROWS);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
      this.navigateRelated();
      return;
    }
    this.input.handleInput(data);
    this.detailOffset = 0;
    this.selected = Math.min(this.selected, Math.max(0, this.matches().length - 1));
    this.requestRender();
  }

  render(width: number): string[] {
    const matches = this.matches();
    const selected = matches[this.selected];
    return [
      truncateToWidth("Terminology browser", width),
      ...this.input.render(width),
      truncateToWidth(this.summary(matches), width),
      ...this.renderCurrent(width),
      ...this.renderList(matches, width),
      ...this.renderDetails(selected, width),
      truncateToWidth("↑/↓ move  Ctrl+↑/↓ details  Enter/→ related  Esc back/clear/close", width),
    ];
  }

  private summary(matches: readonly Concept[]): string {
    const total = this.catalogue.concepts.length;
    const query = this.input.getValue().trim();
    const prefix = query.length === 0 ? "All entries" : `Matches for “${query}”`;
    return `${prefix}: ${String(matches.length)} of ${String(total)}.`;
  }

  private renderCurrent(width: number): string[] {
    if (this.currentMatches.length === 0) {
      return [truncateToWidth("Current reminder: none", width)];
    }
    const labels = this.currentMatches.map(
      (match) => `${match.concept.label} (${match.concept.id})`,
    );
    return wrapTextWithAnsi(`Current reminder: ${labels.join(", ")}`, width).slice(0, 3);
  }

  private renderList(matches: readonly Concept[], width: number): string[] {
    if (matches.length === 0) {
      return [truncateToWidth("No terminology entries matched.", width)];
    }
    const start = Math.max(
      0,
      Math.min(this.selected - Math.floor(LIST_ROWS / 2), matches.length - LIST_ROWS),
    );
    const visible = matches.slice(start, start + LIST_ROWS);
    const rows = visible.map((concept, index) => {
      const absolute = start + index;
      const marker = absolute === this.selected ? "›" : " ";
      const aliases = concept.alternativeLabels?.join(", ");
      const suffix = aliases === undefined ? "" : ` [${aliases}]`;
      return truncateToWidth(`${marker} ${concept.label}${suffix} · ${concept.domain}`, width);
    });
    const hiddenBefore = start;
    const hiddenAfter = Math.max(0, matches.length - start - visible.length);
    return [
      hiddenBefore === 0 ? "" : truncateToWidth(`… ${String(hiddenBefore)} above`, width),
      ...rows,
      hiddenAfter === 0 ? "" : truncateToWidth(`… ${String(hiddenAfter)} below`, width),
    ].filter((line) => line !== "");
  }

  private renderDetails(concept: Concept | undefined, width: number): string[] {
    if (concept === undefined) {
      return [];
    }
    const lines = detailLines(concept, this.currentMatches).flatMap((line) =>
      wrapTextWithAnsi(line, width),
    );
    this.detailOffset = Math.min(this.detailOffset, Math.max(0, lines.length - DETAIL_ROWS));
    const window = lines.slice(this.detailOffset, this.detailOffset + DETAIL_ROWS);
    return lines.length <= DETAIL_ROWS
      ? window
      : [
          truncateToWidth(
            `Details ${String(this.detailOffset + 1)}–${String(this.detailOffset + window.length)} of ${String(lines.length)} · Ctrl+Home/End first/last`,
            width,
          ),
          ...window,
        ];
  }

  private matches(): readonly Concept[] {
    const query = normalizeLabel(this.input.getValue());
    if (query.length === 0) {
      return this.catalogue.concepts;
    }
    return this.catalogue.concepts.filter((concept) => searchableText(concept).includes(query));
  }

  private move(delta: number): void {
    this.detailOffset = 0;
    const count = this.matches().length;
    if (count === 0) {
      this.selected = 0;
    } else {
      this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
    }
    this.requestRender();
  }

  private navigateRelated(): void {
    const selected = this.matches()[this.selected];
    const nextId = selected?.relatedConceptIds?.[0];
    const nextIndex =
      nextId === undefined ? -1 : this.catalogue.concepts.findIndex((item) => item.id === nextId);
    if (nextIndex < 0) {
      return;
    }
    this.detailOffset = 0;
    this.history.push(this.input.getValue());
    this.input.setValue("");
    this.selected = nextIndex;
    this.requestRender();
  }

  private escape(): void {
    this.detailOffset = 0;
    if (this.input.getValue().length > 0) {
      this.input.setValue("");
      this.selected = 0;
      this.requestRender();
      return;
    }
    const previous = this.history.pop();
    if (previous !== undefined) {
      this.input.setValue(previous);
      this.selected = 0;
      this.requestRender();
      return;
    }
    this.done();
  }

  private requestRender(): void {
    this.input.invalidate();
    this.tui.requestRender();
  }
}

function detailLines(concept: Concept, currentMatches: readonly Match[]): string[] {
  const matched = currentMatches.some((match) => match.concept.id === concept.id)
    ? "Matched now"
    : "";
  return [
    `${concept.label} (${concept.id}) ${matched}`.trim(),
    `Domain: ${concept.domain}`,
    aliasesLine(concept),
    `Definition: ${concept.definition}`,
    concept.scopeNote === undefined ? undefined : `Scope: ${concept.scopeNote}`,
    fixedTipLine(concept, currentMatches),
    relatedLine(concept),
    ...concept.references.map(referenceLine),
  ].filter((line): line is string => line !== undefined && line.length > 0);
}

function aliasesLine(concept: Concept): string | undefined {
  return concept.alternativeLabels === undefined
    ? undefined
    : `Aliases: ${concept.alternativeLabels.join(", ")}`;
}

function fixedTipLine(concept: Concept, currentMatches: readonly Match[]): string | undefined {
  const match = currentMatches.find((item) => item.concept.id === concept.id);
  return match === undefined ? undefined : `Fixed tip: ${match.tip}`;
}

function relatedLine(concept: Concept): string | undefined {
  return concept.relatedConceptIds === undefined
    ? undefined
    : `Related: ${concept.relatedConceptIds.join(", ")}`;
}

function referenceLine(reference: Reference): string {
  if (reference.kind === "book") {
    const url = reference.url === undefined ? "" : ` URL: ${reference.url}`;
    const isbn = reference.isbn === undefined ? "" : ` ISBN: ${reference.isbn}`;
    return `Source: ${reference.title}. Authors: ${reference.authors.join(", ")}. Edition: ${reference.edition}. Locator: ${reference.locator}.${url}${isbn}`;
  }
  const locator = reference.locator === undefined ? "" : ` Locator: ${reference.locator}.`;
  const version = reference.version === undefined ? "" : ` Version: ${reference.version}.`;
  return `Source: ${reference.title}. URL: ${reference.url}.${locator}${version}`;
}

function searchableText(concept: Concept): string {
  const references = concept.references.map((reference) =>
    Object.values(reference).flat().join(" "),
  );
  return normalizeLabel(
    [
      concept.id,
      concept.label,
      concept.domain,
      concept.definition,
      concept.scopeNote ?? "",
      ...(concept.alternativeLabels ?? []),
      ...(concept.relatedConceptIds ?? []),
      ...references,
    ].join(" "),
  );
}

export function browseText(
  catalogue: Catalogue,
  query: string,
  currentMatches: readonly Match[] = [],
): string {
  const normalized = normalizeLabel(query);
  const concepts = catalogue.concepts.filter((concept) => {
    if (normalized.length === 0) {
      return true;
    }
    return searchableText(concept).includes(normalized);
  });
  if (concepts.length === 0) {
    return "No terminology entries matched.";
  }
  const current =
    currentMatches.length === 0
      ? "Current matches: none"
      : `Current matches: ${currentMatches.map((match) => `${match.concept.label} (${match.concept.id})`).join(", ")}`;
  return `${current}\n\n${concepts.map((concept) => detailLines(concept, currentMatches).join("\n")).join("\n\n")}`;
}
