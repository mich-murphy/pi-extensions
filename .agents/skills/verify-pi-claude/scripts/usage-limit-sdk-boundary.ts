import type {
  AbortError as SdkAbortError,
  createSdkMcpServer as sdkCreateMcpServer,
  tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";

declare global {
  var piUsageLimitBoundary:
    | {
        sdk: {
          AbortError: typeof SdkAbortError;
          createSdkMcpServer: typeof sdkCreateMcpServer;
          tool: typeof sdkTool;
        };
        query: () => AsyncIterable<unknown>;
      }
    | undefined;
}

const boundary = globalThis.piUsageLimitBoundary;

if (boundary === undefined) {
  throw new Error("offline SDK boundary not installed");
}

export const createSdkMcpServer = boundary.sdk.createSdkMcpServer;
export const tool = boundary.sdk.tool;
export const AbortError = boundary.sdk.AbortError;
export const query = boundary.query;
