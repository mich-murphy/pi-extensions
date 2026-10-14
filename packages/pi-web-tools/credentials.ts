import { Context, Duration, Effect, Layer, Redacted, Result, Schema } from "effect";
import type { SearchProviderName } from "./types";

/** Safe categories only: never retain the rejected value, exception, or command. */
export class CredentialFailure extends Schema.TaggedError<CredentialFailure>()(
  "CredentialFailure",
  {
    provider: Schema.Literals(["exa", "parallel", "brave"]),
    reason: Schema.Literals(["unavailable", "resolution", "invalid", "timeout", "incompatible"]),
  },
) {
  override get message(): string {
    return `credential ${this.reason}`;
  }
}

export type CredentialOutcome = Result.Result<Redacted.Redacted | undefined, CredentialFailure>;
export type CredentialSnapshot = {
  readonly outcomes: Readonly<Record<SearchProviderName, CredentialOutcome>>;
  readonly secrets: readonly string[];
};

/** Validate at ingress, before any request or telemetry can see the value. */
function validateCredential(provider: SearchProviderName, value: string | undefined) {
  if (value === undefined) {
    return Effect.succeed(undefined);
  }
  if (typeof value !== "string") {
    return Effect.fail(new CredentialFailure({ provider, reason: "invalid" }));
  }
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed.split("").some((character) => character < " " || character === "\u007f")
  ) {
    return Effect.fail(new CredentialFailure({ provider, reason: "invalid" }));
  }
  return Effect.succeed(Redacted.make(trimmed));
}

export class CredentialResolver extends Context.Service<
  CredentialResolver,
  {
    readonly resolve: (
      provider: SearchProviderName,
    ) => Effect.Effect<Redacted.Redacted | undefined, CredentialFailure>;
  }
>()("pi-web-tools/CredentialResolver") {
  static layerWith(
    resolver: (provider: SearchProviderName, signal: AbortSignal) => Promise<string | undefined>,
    timeout: Duration.Input = Duration.seconds(10),
  ) {
    return Layer.succeed(CredentialResolver, {
      resolve: (provider) =>
        Effect.tryPromise({
          try: async (signal) => resolver(provider, signal),
          catch: () => new CredentialFailure({ provider, reason: "resolution" }),
        }).pipe(
          Effect.flatMap((value) => validateCredential(provider, value)),
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(new CredentialFailure({ provider, reason: "timeout" })),
          }),
        ),
    });
  }

  static readonly unavailableLayer = Layer.succeed(CredentialResolver, {
    resolve: (provider) => Effect.fail(new CredentialFailure({ provider, reason: "unavailable" })),
  });
}

/** Resolve once per requested provider; missing providers are deliberately unrequested, not failures. */
export function resolveCredentialSnapshot(
  names: readonly SearchProviderName[],
): Effect.Effect<CredentialSnapshot, never, CredentialResolver> {
  return Effect.gen(function* () {
    const resolver = yield* CredentialResolver;
    const outcomes: Record<SearchProviderName, CredentialOutcome> = {
      exa: Result.succeed(undefined),
      parallel: Result.succeed(undefined),
      brave: Result.succeed(undefined),
    };
    const secrets: string[] = [];
    for (const provider of new Set(names)) {
      const outcome = yield* Effect.result(resolver.resolve(provider));
      outcomes[provider] = outcome;
      if (Result.isSuccess(outcome) && outcome.success !== undefined) {
        secrets.push(Redacted.value(outcome.success));
      }
    }
    return { outcomes, secrets };
  });
}
