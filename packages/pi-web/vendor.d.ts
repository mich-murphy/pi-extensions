/// <reference lib="dom" />

declare module "html-to-text" {
  type HtmlToTextOptions = {
    baseElements?: { selectors?: string[]; returnDomByDefault?: boolean };
    wordwrap?: number | false;
    selectors?: {
      selector: string;
      format?: string;
      options?: { uppercase?: boolean; uppercaseHeaderCells?: boolean };
    }[];
  };

  export function compile(options: HtmlToTextOptions): (html: string) => string;
}

declare module "@mixmark-io/domino" {
  export function createDocument(html?: string, force?: boolean): Document;
}

declare module "turndown-plugin-gfm" {
  import type { Plugin } from "turndown";

  export const gfm: Plugin;
}
