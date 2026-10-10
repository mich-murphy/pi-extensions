import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FetchPage } from "./fetch-page";
import { FetchPublicWebClient } from "./network";
import { FetchProviderHttpClient } from "./provider-http";
import { buildFetchProviders, buildSearchProviders, defaultMcpFor } from "./search";
import { parseSettings } from "./settings";
import { tempFileToolOutputStore } from "./tool-output";
import { WEB_TOOLS_EXTENSION_NAME } from "./types";
import { createWebFetchTool } from "./webfetch";
import { createWebSearchTool } from "./websearch";

/** Register the webfetch and websearch tools. */
export default function webToolsExtension(pi: ExtensionAPI): void {
  const parsed = parseSettings();
  if (parsed._tag === "err") {
    const { message } = parsed.error;
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`${WEB_TOOLS_EXTENSION_NAME}: ${message}`, "error");
    });
    // Register tools that surface the configuration problem instead of silently disappearing.
    pi.registerTool(createFailingTool("websearch", "Web Search", message));
    pi.registerTool(createFailingTool("webfetch", "Web Fetch", message));
    return;
  }

  const settings = parsed.value;
  const composition = {
    settings,
    http: new FetchProviderHttpClient(),
    sessionId: randomUUID(),
    mcpFor: defaultMcpFor,
  };
  const secrets = [
    settings.credentials.exaApiKey,
    settings.credentials.parallelApiKey,
    settings.credentials.braveApiKey,
  ];

  pi.registerTool(
    createWebSearchTool({
      settings,
      providers: buildSearchProviders(composition),
      outputStore: tempFileToolOutputStore,
      secrets,
    }),
  );
  const fetchPage = new FetchPage(new FetchPublicWebClient());
  pi.registerTool(
    createWebFetchTool({
      settings,
      fetchPage,
      fetchProviders: buildFetchProviders(composition),
      outputStore: tempFileToolOutputStore,
      secrets,
    }),
  );
}

function createFailingTool(name: string, label: string, message: string) {
  return {
    name,
    label,
    description: `Unavailable: ${message}`,
    parameters: { type: "object", properties: {} },
    async execute() {
      throw new Error(`pi-web-tools configuration error: ${message}`);
    },
  };
}
