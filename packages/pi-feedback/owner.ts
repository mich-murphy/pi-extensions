import { isAbsolute, join, relative, sep } from "node:path";

export const UNATTRIBUTED = "unattributed";
export const PI_CORE = "pi-core";

const CLAUDE = "pi-claude";
const CLAUDE_SCRATCH = /\/(?:private\/)?tmp\/claude-\d+\//u;
const PATH_END = /[\s'"`(),;]/u;
const TRAILING_PUNCTUATION = /[.:]+$/u;

export type ToolSource = {
  readonly name: string;
  readonly sourceInfo: { readonly path: string; readonly source: string };
  readonly annotations?: { readonly readOnlyHint?: boolean };
};

export type CommandSource = {
  readonly name: string;
  readonly sourceInfo: { readonly path: string };
};

export type OwnerSources = {
  readonly getAllTools: () => ReadonlyArray<ToolSource>;
  readonly getCommands: () => ReadonlyArray<CommandSource>;
};

export type OwnerSettings = {
  readonly packagesDir: string;
  readonly ownPackages: ReadonlyArray<string>;
  readonly agentDir: string;
  readonly home: string;
};

export type Attribution = {
  readonly owner: string;
  readonly evidence?: "pi-path";
  readonly pathExisted?: boolean;
};

function escapeRegExp(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

export function createAttribution(sources: OwnerSources, settings: OwnerSettings) {
  const own: ReadonlySet<string> = new Set(settings.ownPackages);
  const encodedHome = escapeRegExp(settings.home.replace(/^\//u, "").replaceAll("/", "-"));
  const sessionName = `--${encodedHome}(?:-[^\\s'"\`/]*)?--`;
  const piSessionNames = new RegExp(sessionName, "gu");
  const claudeProjectName = new RegExp(`(?<![\\w-])-${encodedHome}`, "u");
  const sessionsDir = join(settings.agentDir, "sessions");

  const sessionsDirs = settings.agentDir.startsWith(`${settings.home}/`)
    ? [sessionsDir, `~${sessionsDir.slice(settings.home.length)}`]
    : [sessionsDir];

  const packageAt = (path: string): string | undefined => {
    if (!isAbsolute(path)) {
      return undefined;
    }

    const inside = relative(settings.packagesDir, path);
    const name = inside.split(sep)[0] ?? "";

    return inside.startsWith("..") || isAbsolute(inside) || !own.has(name) ? undefined : name;
  };

  const claudePath = (text: string): boolean =>
    own.has(CLAUDE) && (CLAUDE_SCRATCH.test(text) || claudeProjectName.test(text));

  const piPathsIn = (text: string): ReadonlyArray<string> => {
    const underSessions = sessionsDirs.flatMap((dir) =>
      text
        .split(dir)
        .slice(1)
        .map((rest) => {
          const [named = ""] = rest.split(PATH_END);

          return join(sessionsDir, named.replace(TRAILING_PUNCTUATION, ""));
        }),
    );

    const sessionNames = [...text.matchAll(piSessionNames)].map(([name]) =>
      join(sessionsDir, name),
    );

    return [...new Set([...underSessions, ...sessionNames])].filter((path) => {
      const inside = relative(sessionsDir, path);

      return !inside.startsWith("..") && !isAbsolute(inside);
    });
  };

  const toolNamed = (name: string): ToolSource | undefined =>
    sources.getAllTools().find((tool) => tool.name === name);

  const attribute = (tool: ToolSource | undefined, text: string): Attribution => {
    const registeredBy = tool === undefined ? undefined : packageAt(tool.sourceInfo.path);

    if (registeredBy !== undefined) {
      return { owner: registeredBy };
    }

    if (claudePath(text)) {
      return { owner: CLAUDE };
    }

    return tool?.sourceInfo.source === "builtin" && piPathsIn(text).length > 0
      ? { owner: UNATTRIBUTED, evidence: "pi-path" }
      : { owner: UNATTRIBUTED };
  };

  const forSignal = (toolName: string, error: string): Attribution =>
    attribute(toolNamed(toolName), error);

  const commandNamed = (name: string): CommandSource | undefined =>
    sources
      .getCommands()
      .find((candidate) => candidate.name === name || candidate.name === `skill:${name}`);

  const forReport = (component: string, actual: string): Attribution => {
    const trimmed = component.trim();
    const named = trimmed.replace(/^\//u, "");
    const first = named.toLowerCase().split(/[\s/:]+/u)[0] ?? "";

    if (own.has(first)) {
      return { owner: first };
    }

    const invoked = named.split(/\s+/u)[0] ?? "";
    const command = trimmed.startsWith("/") ? commandNamed(invoked) : undefined;

    const commandOwner = command === undefined ? undefined : packageAt(command.sourceInfo.path);

    return commandOwner === undefined
      ? attribute(toolNamed(named), actual)
      : { owner: commandOwner };
  };

  return { forSignal, forReport, toolNamed, piPathsIn };
}
