import { createHash } from "node:crypto";

const SIGNAL_TEXT_LIMIT = 96;
const GROUP_ID_LENGTH = 12;

const NORMALIZERS: readonly (readonly [RegExp, string])[] = [
  [/[a-z][a-z0-9+.-]*:\/\/\S+/giu, "<url>"],
  [/(?<![\w/])(?:~|\.{1,2})?\/[^\s'"`,;:()[\]{}<>]+/gu, "<path>"],
  [/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu, "<id>"],
  [/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/giu, "<id>"],
  [/\d+(?:\.\d+)*/gu, "<n>"],
  [/\s+/gu, " "],
];

export function normalizeErrorText(text: string): string {
  let current = text;

  for (const [pattern, replacement] of NORMALIZERS) {
    current = current.replaceAll(pattern, replacement);
  }

  return current.trim();
}

export function signalFingerprint(tool: string, error: string): string {
  return `${tool}: ${normalizeErrorText(error).slice(0, SIGNAL_TEXT_LIMIT).trimEnd()}`;
}

export function reportFingerprint(component: string, kind: string): string {
  return `${component.trim().toLowerCase().replaceAll(/\s+/gu, " ")}/${kind}`;
}

export function groupId(owner: string, fingerprint: string): string {
  return createHash("sha256")
    .update(`${owner}\n${fingerprint}`)
    .digest("hex")
    .slice(0, GROUP_ID_LENGTH);
}
