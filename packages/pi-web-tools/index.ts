import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Layer, Result } from "effect";
import { createWebAuthentication } from "./authentication";
import { CredentialResolver } from "./credentials";
import { FetchPage } from "./fetch-page";
import { McpClients } from "./mcp";
import { DnsLookup, HttpFetch, PublicWebClient } from "./network";
import { ProviderHttpClient } from "./provider-http";
import { PublicWebTransport } from "./public-web-transport";
import { FetchRescueProviders, SearchProviders } from "./search";
import { parseSettings, WebToolsConfig } from "./settings";
import type { WebToolsSettings } from "./settings";
import { ToolOutputStore } from "./tool-output";
import { createToolRuntime } from "./tool-runtime";
import { WEB_TOOLS_EXTENSION_NAME } from "./types";
import { createWebFetchTool } from "./webfetch";
import { createWebSearchTool } from "./websearch";

/** Pi registration capabilities consumed by web tools. */
export type WebToolsRegistration = Pick<
  ExtensionAPI,
  "registerTool" | "registerProvider" | "unregisterProvider"
> & {
  readonly on: {
    (
      name: "session_start",
      handler: (
        event: unknown,
        ctx: Pick<ExtensionContext, "modelRegistry"> & {
          readonly ui: Pick<ExtensionContext["ui"], "notify">;
        },
      ) => void,
    ): unknown;
    (name: "session_shutdown", handler: () => Promise<void>): unknown;
  };
};

/** Register the webfetch and websearch tools. */
export default function webToolsExtension(pi: WebToolsRegistration): void {
  const authentication = createWebAuthentication();
  let currentRegistry: ExtensionContext["modelRegistry"] | undefined;
  pi.on("session_start", (_event, ctx) => {
    currentRegistry = ctx.modelRegistry;
    try {
      authentication.register(pi, ctx.modelRegistry);
    } catch {
      ctx.ui.notify(
        `${WEB_TOOLS_EXTENSION_NAME}: could not register web authentication providers (provider ID conflict or unsupported runtime)`,
        "error",
      );
    }
  });
  const parsed = parseSettings();
  const runtime = Result.isSuccess(parsed)
    ? registerConfiguredTools(pi, parsed.success, authentication)
    : undefined;
  pi.on("session_shutdown", async () => {
    await runtime?.dispose();
    if (currentRegistry !== undefined) {
      authentication.unregister(pi, currentRegistry);
      currentRegistry = undefined;
    }
  });
  if (Result.isFailure(parsed)) {
    const { message } = parsed.failure;
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`${WEB_TOOLS_EXTENSION_NAME}: ${message}`, "error");
    });
    pi.registerTool(createFailingTool("websearch", "Web Search", message));
    pi.registerTool(createFailingTool("webfetch", "Web Fetch", message));
  }
}

function registerConfiguredTools(
  pi: WebToolsRegistration,
  settings: WebToolsSettings,
  authentication: ReturnType<typeof createWebAuthentication>,
) {
  const runtime = createToolRuntime(appLayer(settings));
  pi.on("session_start", () => {
    runtime.start();
  });
  const composition = {
    redactText: (input: string) => input,
    credentialsForContext: (ctx: Pick<ExtensionContext, "modelRegistry">) =>
      authentication.resolverFor(ctx.modelRegistry),
    runtime,
  };
  pi.registerTool(createWebSearchTool({ ...composition, settings: { search: settings.search } }));
  pi.registerTool(createWebFetchTool({ ...composition, settings: { fetch: settings.fetch } }));
  return runtime;
}

function appLayer(settings: WebToolsSettings) {
  const outbound = Layer.mergeAll(HttpFetch.layer, PublicWebTransport.layer, DnsLookup.layer);
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
    CredentialResolver.unavailableLayer,
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
