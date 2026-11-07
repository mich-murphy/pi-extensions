import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Schema } from "effect";

function hasControls(value: string): boolean {
  // eslint-disable-next-line typescript/no-misused-spread -- Inspect Unicode code points only for forbidden control ranges.
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}
const scope = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u));
const machine = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u));
const configuration = Schema.Struct({
  machineId: machine,
  socketPath: Schema.String.check(
    Schema.makeFilter<string>(
      (value) => isAbsolute(value) && Buffer.byteLength(value) < 104 && !hasControls(value),
    ),
  ),
  scopeIds: Schema.Array(scope).check(
    Schema.makeFilter<readonly string[]>(
      (items) => items.length >= 1 && items.length <= 4 && new Set(items).size === items.length,
    ),
  ),
  label: Schema.String.check(
    Schema.makeFilter<string>(
      (value) =>
        value.length > 0 &&
        value.isWellFormed() &&
        Buffer.byteLength(value) <= 128 &&
        !hasControls(value),
    ),
  ),
  policies: Schema.Array(
    Schema.Struct({
      machineId: machine,
      scopeId: scope,
      permissions: Schema.Array(Schema.Literals(["discover", "read", "push", "interest"])),
    }),
  ).check(Schema.makeFilter<readonly unknown[]>((items) => items.length <= 256)),
});
export type Configuration = typeof configuration.Type;
export type Permission = Configuration["policies"][number]["permissions"][number];
export function decodeConfiguration(value: unknown): Configuration {
  return Schema.decodeUnknownSync(configuration, { onExcessProperty: "error" })(value);
}
/** Only this explicit user-agent file enables a runtime. Project files are never inspected. */
export async function loadConfiguration(agentDir: string): Promise<Configuration | undefined> {
  let content: string;
  try {
    const bytes = await readFile(join(agentDir, "session-communication.json"));
    if (bytes.length > 32_768) {
      throw new Error("Configuration is too large");
    }
    content = bytes.toString("utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error("Session communication configuration could not be loaded", { cause: error });
  }
  try {
    return decodeConfiguration(JSON.parse(content));
  } catch {
    throw new Error("Invalid session communication configuration");
  }
}
export function permits(
  config: Configuration,
  machineId: string,
  scopeId: string,
  action: Permission,
): boolean {
  return (
    config.scopeIds.includes(scopeId) &&
    config.policies.some(
      (policy) =>
        policy.machineId === machineId &&
        policy.scopeId === scopeId &&
        policy.permissions.includes(action),
    )
  );
}
/** Terminal rendering is inert; JSON/control interpretation never executes authored text. */
export function visibleText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 8 || (code >= 11 && code <= 31) || (code >= 127 && code <= 159)
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : character;
  }).join("");
}
