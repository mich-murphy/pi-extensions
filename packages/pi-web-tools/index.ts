import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Layer, Result } from "effect";
import { FetchPage } from "./fetch-page";
import { McpClients } from "./mcp";
import { DnsLookup, HttpFetch, PublicWebClient } from "./network";
import { ProviderHttpClient } from "./provider-http";
import { FetchRescueProviders, SearchProviders } from "./search";
import { parseSettings, WebToolsConfig } from "./settings";
import type { WebToolsSettings } from "./settings";
import { ToolOutputStore } from "./tool-output";
import { createToolRuntime } from "./tool-runtime";
import { WEB_TOOLS_EXTENSION_NAME } from "./types";
import { createWebFetchTool } from "./webfetch";
import { createWebSearchTool } from "./websearch";

/** Register the webfetch and websearch tools. */
export default function webToolsExtension(pi: ExtensionAPI): void {
  const parsed = parseSettings();
  if (Result.isFailure(parsed)) {
    const { message } = parsed.failure;
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`${WEB_TOOLS_EXTENSION_NAME}: ${message}`, "error");
    });
    // Register tools that surface the configuration problem instead of silently disappearing.
    pi.registerTool(createFailingTool("websearch", "Web Search", message));
    pi.registerTool(createFailingTool("webfetch", "Web Fetch", message));
    return;
  }

  const settings = parsed.success;
  // One runtime for both tools; it is built on the first tool call and disposed at shutdown.
  const runtime = createToolRuntime(appLayer(settings));
  pi.on("session_shutdown", async () => {
    await runtime.dispose();
  });
  // The tools get only the non-secret settings; API keys reach the adapters via WebToolsConfig.
  pi.registerTool(createWebSearchTool({ settings: { search: settings.search }, runtime }));
  pi.registerTool(createWebFetchTool({ settings: { fetch: settings.fetch }, runtime }));
}

// The live layer graph both tools run against.
function appLayer(settings: WebToolsSettings) {
  const outbound = Layer.mergeAll(HttpFetch.layer, DnsLookup.layer);
  const config = WebToolsConfig.layer(settings);
  const providerDeps = Layer.mergeAll(ProviderHttpClient.layer, McpClients.layer, config);
  // One build of both chains shares their internal provider pairs (Parallel session id, MCP clients).
  const providers = Layer.mergeAll(SearchProviders.layer, FetchRescueProviders.layer).pipe(
    Layer.provide(providerDeps),
  );
  return Layer.mergeAll(
    providers,
    config,
    FetchPage.layer.pipe(Layer.provide(PublicWebClient.layer)),
    ToolOutputStore.layer,
  ).pipe(Layer.provide(outbound));
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
