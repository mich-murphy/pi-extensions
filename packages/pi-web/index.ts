import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Layer, Result } from "effect";
import { createWebAuthentication } from "./authentication";
import type { WebAuthentication } from "./authentication";
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
import { WEB_EXTENSION_NAME } from "./types";
import { createWebFetchTool } from "./webfetch";
import { createWebSearchTool } from "./websearch";

export type RegisteredWebTool =
  | ReturnType<typeof createWebSearchTool>
  | ReturnType<typeof createWebFetchTool>
  | ReturnType<typeof createFailingTool<"websearch">>
  | ReturnType<typeof createFailingTool<"webfetch">>;

export type WebToolsHandlers = {
  readonly session_start: (
    event: SessionStartEvent,
    ctx: Pick<ExtensionContext, "modelRegistry"> & {
      readonly ui: Pick<ExtensionContext["ui"], "notify">;
    },
  ) => void;
  readonly session_shutdown: () => Promise<void>;
};

export type WebToolsRegistration = Pick<ExtensionAPI, "registerProvider" | "unregisterProvider"> & {
  readonly registerTool: (tool: RegisteredWebTool) => void;
  readonly on: {
    (name: "session_start", handler: WebToolsHandlers["session_start"]): void;
    (name: "session_shutdown", handler: WebToolsHandlers["session_shutdown"]): void;
  };
};

export default function webExtension(pi: WebToolsRegistration): void {
  const authentication = createWebAuthentication(readStoredCredential);
  let currentRegistry: ExtensionContext["modelRegistry"] | undefined;
  pi.on("session_start", (_event, ctx) => {
    currentRegistry = ctx.modelRegistry;
    try {
      authentication.register(pi, ctx.modelRegistry);
    } catch {
      ctx.ui.notify(
        `${WEB_EXTENSION_NAME}: could not register web authentication. Remove a duplicate pi-web or update Pi.`,
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
      ctx.ui.notify(`${WEB_EXTENSION_NAME}: ${message} Restart Pi after changing it.`, "error");
    });
    pi.registerTool(createFailingTool("websearch", "Web Search", message));
    pi.registerTool(createFailingTool("webfetch", "Web Fetch", message));
  }
}

function registerConfiguredTools(
  pi: WebToolsRegistration,
  settings: WebToolsSettings,
  authentication: WebAuthentication,
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

function createFailingTool<Name extends "websearch" | "webfetch">(
  name: Name,
  label: string,
  message: string,
) {
  return {
    name,
    label,
    description: `Unavailable: ${message}`,
    parameters: { type: "object", properties: {} },
    async execute(
      _toolCallId: string,
      _params:
        | Parameters<ReturnType<typeof createWebSearchTool>["execute"]>[1]
        | Parameters<ReturnType<typeof createWebFetchTool>["execute"]>[1],
      _signal?: AbortSignal,
      _onUpdate?: undefined,
      _context?: Pick<ExtensionContext, "modelRegistry">,
    ): Promise<never> {
      throw new Error(
        `pi-web is not configured: ${message} Ask the user to fix it and restart Pi.`,
      );
    },
  };
}
