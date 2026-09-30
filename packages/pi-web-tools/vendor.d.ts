/// <reference lib="dom" />

declare module "html-to-text" {
  export function convert(html: string, options?: unknown): string;
  export function compile(options: unknown): (html: string) => string;
}

// @mixmark-io/domino ships typings for the module name "domino" only.
declare module "@mixmark-io/domino" {
  export function createDocument(html?: string, force?: boolean): Document;
}

declare module "turndown-plugin-gfm" {
  export const gfm: (service: unknown) => void;
}
