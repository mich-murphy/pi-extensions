// Offline-only jiti alias. Everything except query delegates to the installed SDK.
// No SDK query/Claude subprocess, credentials, or provider network are used.
import type * as SDK from "@anthropic-ai/claude-agent-sdk";

declare global {
  var piUsageLimitBoundary: { sdk: typeof SDK; query: () => AsyncIterable<unknown> } | undefined;
}
const boundary = globalThis.piUsageLimitBoundary;
if (boundary === undefined) {
  throw new Error("offline SDK boundary not installed");
}
export const createSdkMcpServer = boundary.sdk.createSdkMcpServer;
export const tool = boundary.sdk.tool;
export const AbortError = boundary.sdk.AbortError;
export const query = boundary.query;
