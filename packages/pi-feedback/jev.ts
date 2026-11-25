import type { ClassifierBoolQuestion } from "@earendil-works/pi-ai";

export const JEV_PROVIDER = "typesafe";
export const JEV_CATALOG_ID = "jev-latest";
export const JEV_MODEL_ID = "jev-1.14.0";
export const JEV_MODEL = `${JEV_PROVIDER}/${JEV_MODEL_ID}`;

export const INPUT_LIMIT = 400;
export const ERROR_LIMIT = 600;
export const MAX_MERGE_COMPARISONS = 12;

export const THRESHOLDS = {
  harnessPath: 0.7,
  pathExisted: 0.7,
  piCoreOutsideBelow: 0.3,
  excludedOutsideFrom: 0.9,
  sameCause: 0.7,
} as const;

export type RecordQuestion = "harnessPath" | "pathExisted" | "outsideService";

export const RECORD_QUESTIONS: Readonly<Record<RecordQuestion, ClassifierBoolQuestion>> = {
  harnessPath: {
    type: "bool",
    instructions:
      "An AI coding agent's tool call failed. Does the error involve a path, directory name or length limit that the agent harness (Pi or one of its extensions) created, such as a temporary scratch directory, a session directory or a socket path?",
    criteria: {
      true: "A harness-created path, directory name or limit is involved",
      false: "No harness-created path, name or limit is involved",
    },
  },
  pathExisted: {
    type: "bool",
    instructions:
      "When the call ran, did the path named in the error exist? Answer yes when the error is about how an existing path was used, for example its name being read as a command-line option or being too long.",
    criteria: {
      true: "The path existed when the call ran",
      false: "The path did not exist, or no path is involved",
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
