import type { ClassifierBoolQuestion, ClassifierChoiceQuestion } from "@earendil-works/pi-ai";

export const JEV_PROVIDER = "typesafe";
export const JEV_CATALOG_ID = "jev-latest";
export const JEV_MODEL_ID = "jev-1.14.0";
export const JEV_MODEL = `${JEV_PROVIDER}/${JEV_MODEL_ID}`;

export const INPUT_LIMIT = 400;
export const ERROR_LIMIT = 600;
export const MAX_MERGE_COMPARISONS = 12;
export const CLASSIFY_TIMEOUT_MS = 30_000;

export const THRESHOLDS = {
  harnessPath: 0.7,
  piCoreOutsideBelow: 0.3,
  excludedOutsideFrom: 0.9,
  sameCause: 0.7,
  owner: 0.9,
} as const;

export type RecordQuestion = "harnessPath" | "outsideService";

export const RECORD_QUESTIONS: Readonly<Record<RecordQuestion, ClassifierBoolQuestion>> = {
  harnessPath: {
    type: "bool",
    instructions:
      "An AI coding agent's tool call failed. Does the error involve a path or directory name that the agent harness (Pi or one of its extensions) created, such as a temporary scratch directory, a session directory or a socket path?",
    criteria: {
      true: "A harness-created path or directory name is involved",
      false: "No harness-created path or directory name is involved",
    },
  },
  outsideService: {
    type: "bool",
    instructions:
      "Did a service outside this machine cause the error, such as a website returning 404, a network timeout, a rate limit or a remote API failure?",
    criteria: {
      true: "An outside service failed, refused or timed out",
      false: "The error came from this machine: the harness, the agent's command or the project",
    },
  },
};

export const SAME_CAUSE_QUESTION: Readonly<Record<"sameCause", ClassifierBoolQuestion>> = {
  sameCause: {
    type: "bool",
    instructions:
      "These are two failures an AI coding agent hit. Did `a` and `b` fail for the same underlying reason, even if their wording, tool or file differ?",
    criteria: {
      true: "One underlying cause explains both failures",
      false: "They fail for different reasons",
    },
  },
};

const PACKAGE_DESCRIPTIONS = {
  "pi-claude":
    "Claude provider: runs claude/... models through the Claude Agent SDK and a Claude Code subscription. Turn failure categories (rate-limit, usage-limit, internal-continuation, stream-interrupted, authentication), Claude Code version and login, /claude status|usage, SDK tool validation (pi_claude_sdk_validation_error), Claude scratchpad paths, its bash cat/which guard and base64 output quarantine, the Extra Usage guard, thinking replay, publishing usage-limit reset times. Not Pi's own built-in providers (anthropic, openai, google and others) or their API keys and OAuth login",
  "pi-coffee":
    "Keeps the Mac awake while Pi works by running caffeinate (/coffee): system sleep, display, battery, leftover caffeinate processes",
  "pi-feedback":
    "The harness_feedback tool and the failed-tool-call ledger (/feedback): report limits and duplicates, the queue CLI, background Jev classification of records",
  "pi-peers":
    "Messages between live Pi sessions: peers_list, peers_send, peers_take, the gateway, its Unix socket, mTLS links between machines, pairing, the /peers menu and doctor",
  "pi-retry":
    "Continues a session automatically after a provider usage-limit reset or a transient provider failure (/retry): the wait, its widget, the resume marker, which failures are retried, maxAttempts, window, piRetry settings, print and JSON mode exits",
  "pi-scrollback":
    "A muted row pinned above the transcript that shows the current prompt while scrolling back in fullscreen mode (/scrollback)",
  "pi-skills":
    "The /skills menu that switches skills and instruction files (AGENTS.md, CLAUDE.md) on or off: saved choices (pi-skills.json, formerly pi-skill-toggle), blocking reads of disabled resources ('The user disabled ... in /skills'), subagents following the parent, toggle notes that keep the prompt cache",
  "pi-vim":
    "Vim-style Normal mode in the prompt editor (/vim): Esc and Ctrl+[, motions, dd, the mode label",
  "pi-web":
    "websearch (Exa, Parallel and Brave providers, free-tier rate limits, /login pi-web-*) and webfetch (fetch a URL as markdown/text, timeouts, 404s, offset and truncation, images, PDFs, fetch rescue)",
} as const;

export const OUTSIDE_OWNERS = {
  "pi-core":
    "Pi itself: built-in tools read, bash, edit, write, grep, find and ls; the codemode script runner and its models/tools API; the TUI, editor, themes and scrolling; sessions, tree, compaction, settings, Pi's built-in providers and their API keys and OAuth login, Pi's own provider retries, its own skill discovery and /skill:name commands, bug reports",
  other: "A third-party extension or MCP server not listed here",
} as const;

const OWNER_INSTRUCTIONS =
  "An AI coding agent filed a feedback report about a component of the Pi coding agent harness. Which package owns the component that actually failed? Judge from what happened, not only from the name given.";

export type OwnerQuestion = Readonly<Record<"owner", ClassifierChoiceQuestion>>;

export function ownerQuestion(ownPackages: ReadonlyArray<string>): OwnerQuestion | undefined {
  const own = new Set(ownPackages);
  const packages = Object.entries(PACKAGE_DESCRIPTIONS).filter(([name]) => own.has(name));

  if (packages.length === 0) {
    return undefined;
  }

  return {
    owner: {
      type: "choice",
      instructions: OWNER_INSTRUCTIONS,
      criteria: Object.fromEntries([...packages, ...Object.entries(OUTSIDE_OWNERS)]),
    },
  };
}
