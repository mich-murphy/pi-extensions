import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { CredentialResolver, CredentialFailure } from "../credentials";
import { createWebFetchTool } from "../webfetch";
import { createWebSearchTool } from "../websearch";
import { settingsFrom, toolRuntimeWith } from "./fakes";

function rejectionMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected failure";
}

/** Exercise the injectable credential boundary while the real tool/runtime own cancellation. */
describe("credential wait lifecycle", () => {
  test.each([
    {
      environment: { PI_WEB_TOOLS_FETCH_DENY_DOMAINS: "example.com" },
      url: "https://unresolved-synthetic-key.example.com/",
      message: "denied by the webfetch domain policy",
    },
    {
      environment: { PI_WEB_TOOLS_FETCH_ALLOW_DOMAINS: "allowed.example.com" },
      url: "https://unresolved-synthetic-key.example.com/",
      message: "not in the webfetch allowed domains list",
    },
    {
      environment: {},
      url: "unresolved-synthetic-key://example.com/",
      message: "URL must start with http:// or https://",
    },
  ])(
    "early fetch validation never echoes secrets or resolves unrelated auth: $url",
    async ({ environment, url, message }) => {
      let resolutions = 0;
      const settings = settingsFrom(environment);
      const runtime = toolRuntimeWith({
        settings,
        credentials: CredentialResolver.of({
          resolve: () =>
            Effect.sync(() => {
              resolutions += 1;
              return Redacted.make("unresolved-synthetic-key");
            }),
        }),
      });
      const tool = createWebFetchTool({ settings, runtime, redactText: (input) => input });
      const outcome = tool.execute("invalid", { url });
      await expect(outcome).rejects.toThrow(message);
      await expect(outcome).rejects.not.toThrow("unresolved-synthetic-key");
      expect(resolutions).toBe(0);
      await runtime.dispose();
    },
  );
  test("shutdown interrupts resolution, suppresses late transport, and rejects stale calls", async () => {
    const started = Promise.withResolvers<undefined>();
    const resolved = Promise.withResolvers<Redacted.Redacted>();
    let resolverAborted = false;
    let transportCalls = 0;
    const settings = settingsFrom({ PI_WEB_TOOLS_PROVIDERS: "exa" });
    const credentials = CredentialResolver.of({
      resolve: (provider) =>
        Effect.tryPromise({
          try: async (signal) => {
            signal.addEventListener(
              "abort",
              () => {
                resolverAborted = true;
              },
              { once: true },
            );
            started.resolve(undefined);
            return resolved.promise;
          },
          catch: () => new CredentialFailure({ provider, reason: "resolution" }),
        }),
    });
    const runtime = toolRuntimeWith({
      settings,
      credentials,
      searchProviders: [
        {
          name: "exa",
          transport: "api",
          search: () =>
            Effect.sync(() => {
              transportCalls += 1;
              return [];
            }),
        },
      ],
    });
    const tool = createWebSearchTool({ settings, runtime, redactText: (input) => input });
    const updates: unknown[] = [];
    const outcome = tool
      .execute("pending", { query: "query" }, undefined, (update) => {
        updates.push(update);
      })
      .catch(rejectionMessage);
    await started.promise;
    await runtime.dispose();
    await expect(outcome).resolves.toBe("Web search cancelled");
    expect(resolverAborted).toBe(true);
    resolved.resolve(Redacted.make("late-synthetic-key"));
    await Promise.resolve();
    await expect(tool.execute("stale", { query: "late-synthetic-key" })).rejects.toThrow(
      "Web search cancelled",
    );
    expect(transportCalls).toBe(0);
    expect(updates).toStrictEqual([]);
  });
});
