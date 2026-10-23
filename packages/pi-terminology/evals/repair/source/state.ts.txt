import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const STATE_VERSION = 1;

type StateFile = {
  readonly version: 1;
  readonly approvedGlossaries: readonly string[];
  readonly hiddenConceptIds: readonly string[];
  readonly dismissedConceptIds?: readonly string[];
  readonly noticeKeys: readonly string[];
  readonly cooldowns: Record<string, number>;
};

export type TerminologyState = {
  readonly approvedGlossaries: ReadonlySet<string>;
  readonly hiddenConceptIds: ReadonlySet<string>;
  readonly dismissedConceptIds: ReadonlySet<string>;
  readonly noticeKeys: ReadonlySet<string>;
  readonly cooldowns: ReadonlyMap<string, number>;
};

export class TerminologyStateStore {
  constructor(private readonly path = join(getAgentDir(), "pi-terminology.json")) {}

  load(): TerminologyState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
        return emptyState();
      }
      throw cause;
    }
    if (!isRecord(parsed) || parsed.version !== STATE_VERSION) {
      return emptyState();
    }
    return {
      approvedGlossaries: new Set(readStringArray(parsed.approvedGlossaries)),
      hiddenConceptIds: new Set(readStringArray(parsed.hiddenConceptIds)),
      dismissedConceptIds: new Set(readStringArray(parsed.dismissedConceptIds)),
      noticeKeys: new Set(readStringArray(parsed.noticeKeys)),
      cooldowns: new Map(
        Object.entries(isRecord(parsed.cooldowns) ? parsed.cooldowns : {}).flatMap(
          ([key, value]) => (typeof value === "number" ? [[key, value]] : []),
        ),
      ),
    };
  }

  approveGlossary(path: string): TerminologyState {
    const state = this.load();
    const next = new Set(state.approvedGlossaries);
    next.add(path);
    return this.save({ ...state, approvedGlossaries: next });
  }

  hideConcept(conceptId: string): TerminologyState {
    const state = this.load();
    const next = new Set(state.hiddenConceptIds);
    next.add(conceptId);
    return this.save({ ...state, hiddenConceptIds: next });
  }

  restoreConcept(conceptId: string): TerminologyState {
    const state = this.load();
    const hidden = new Set(state.hiddenConceptIds);
    hidden.delete(conceptId);
    return this.save({ ...state, hiddenConceptIds: hidden });
  }

  setCooldown(conceptId: string, until: number): TerminologyState {
    const state = this.load();
    const cooldowns = new Map(state.cooldowns);
    cooldowns.set(conceptId, until);
    return this.save({ ...state, cooldowns });
  }

  private save(state: TerminologyState): TerminologyState {
    const file: StateFile = {
      version: STATE_VERSION,
      approvedGlossaries: [...state.approvedGlossaries].toSorted(),
      hiddenConceptIds: [...state.hiddenConceptIds].toSorted(),
      noticeKeys: [...state.noticeKeys].toSorted(),
      cooldowns: Object.fromEntries(
        [...state.cooldowns].toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
    } finally {
      rmSync(temp, { force: true });
    }
    return state;
  }
}

function emptyState(): TerminologyState {
  return {
    approvedGlossaries: new Set(),
    hiddenConceptIds: new Set(),
    dismissedConceptIds: new Set(),
    noticeKeys: new Set(),
    cooldowns: new Map(),
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
