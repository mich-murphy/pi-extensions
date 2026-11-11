import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensions: Record<string, RegExp> = {
  format: /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|html?|css|scss|less|vue|graphql|gql)$/iu,
  "format-check": /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|html?|css|scss|less|vue|graphql|gql)$/iu,
  lint: /\.(?:[cm]?[jt]sx?|vue)$/iu,
  markdownlint: /\.md$/iu,
};

type Tool = { name: string; options: string[]; pathPrefix: string; retry: string };

const tools: Record<string, Tool> = {
  format: { name: "oxfmt", options: ["--threads=2"], pathPrefix: "./", retry: "format" },
  "format-check": {
    name: "oxfmt",
    options: ["--check", "--threads=2"],
    pathPrefix: "./",
    retry: "format:check",
  },
  lint: { name: "oxlint", options: ["--threads=2"], pathPrefix: "./", retry: "lint" },
  markdownlint: {
    name: "markdownlint-cli2",
    options: ["--config", "config/markdownlint-cli2.yaml", "--no-globs"],
    pathPrefix: ":./",
    retry: "markdownlint",
  },
};

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const advice = "Git query failed; run from a Git checkout with a readable index.";
  if (result.error !== undefined) {
    throw new Error(`${advice} ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${advice} ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function indexedStat(root: string, path: string) {
  try {
    return lstatSync(resolve(root, path));
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

function rejectSymlink(path: string, component: string): never {
  throw new Error(
    `Indexed symlink ${JSON.stringify(path)} (component ${JSON.stringify(component)}) cannot be checked safely; replace it with a regular source file or directory, or remove it from the index.`,
  );
}

type PathStats = Map<string, ReturnType<typeof indexedStat>>;

function checkedStat(root: string, path: string, component: string, stats: PathStats) {
  if (!stats.has(component)) {
    stats.set(component, indexedStat(root, component));
  }
  const stat = stats.get(component);
  if (stat?.isSymbolicLink() === true) {
    rejectSymlink(path, component);
  }
  return stat;
}

function existingFile(root: string, path: string, stats: PathStats): boolean {
  const components: string[] = [];
  let stat: ReturnType<typeof indexedStat>;
  // Start below Git's canonical root: a checkout reached through a root alias is legitimate.
  // Cache shared ancestors within selection, not across runs. This is not a TOCTOU sandbox.
  for (const part of path.split("/")) {
    components.push(part);
    stat = checkedStat(root, path, components.join("/"), stats);
    if (stat === undefined) {
      return false;
    }
  }
  return stat?.isFile() ?? false;
}

function indexedEntry(entry: string): { path: string; symlink: boolean } {
  // Only the first tab separates metadata; the remaining path may contain literal tabs.
  return { path: entry.slice(entry.indexOf("\t") + 1), symlink: entry.startsWith("120000 ") };
}

function indexedFiles(root: string, extension: RegExp): string[] {
  const indexed = git(["ls-files", "--cached", "--stage", "-z"], root);
  const stats: PathStats = new Map();
  const files = indexed
    .split("\0")
    .filter(Boolean)
    .map((entry) => indexedEntry(entry))
    .filter(({ path }) => extension.test(path))
    .filter(({ path }) => existingFile(root, path, stats))
    .map(({ path, symlink }) => {
      if (symlink) {
        rejectSymlink(path, path);
      }
      return path;
    });
  return [...new Set(files)];
}

function completedStatus(result: ReturnType<typeof spawnSync>, tool: Tool): number {
  if (result.signal !== null || result.status === null) {
    throw new Error(
      `${tool.name} was interrupted (${result.signal ?? "unknown termination"}); rerun the check when ready.`,
    );
  }
  return result.status;
}

function toolStatus(result: ReturnType<typeof spawnSync>, tool: Tool): number {
  const status = completedStatus(result, tool);
  if (status !== 0) {
    process.stderr.write(
      `repository-quality: ${tool.name} failed (exit ${status}); fix the diagnostics above and rerun npm run ${tool.retry}.\n`,
    );
  }
  return status;
}

function toolExecutable(root: string, tool: Tool): string {
  if (tool.name !== "markdownlint-cli2") {
    return resolve(root, "node_modules", ".bin", tool.name);
  }
  try {
    // Resolve the pinned runner dependency without importing/executing its library.
    // The package exports its library entry; its bin lives beside that entry.
    const entry = fileURLToPath(import.meta.resolve("markdownlint-cli2"));
    return resolve(dirname(entry), "markdownlint-cli2-bin.mjs");
  } catch (error) {
    throw new Error(`Unable to locate markdownlint-cli2; run npm ci and retry.`, { cause: error });
  }
}

function runBatch(root: string, tool: Tool, files: string[]): number {
  const paths = files.map((path) => `${tool.pathPrefix}${path}`);
  const result = spawnSync(toolExecutable(root, tool), [...tool.options, ...paths], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw new Error(`Unable to start ${tool.name}; run npm ci and retry. ${result.error.message}`);
  }
  return toolStatus(result, tool);
}

function runBatches(root: string, tool: Tool, files: string[]): number {
  // Bounded argv avoids ARG_MAX on large repositories. Never invoke a tool with an empty list:
  // both formatter and Markdown CLI otherwise fall back to whole-directory discovery.
  for (let start = 0; start < files.length; start += 64) {
    const status = runBatch(root, tool, files.slice(start, start + 64));
    if (status !== 0) {
      return status;
    }
  }
  return 0;
}

function run(mode: string): number {
  const extension = extensions[mode];
  const tool = tools[mode];
  if (extension === undefined || tool === undefined) {
    throw new Error("Choose format, format-check, lint or markdownlint.");
  }
  // --show-toplevel ends in exactly one LF; trim() would corrupt legal directory names.
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).replace(/\n$/u, "");
  const files = indexedFiles(root, extension);
  if (files.length === 0) {
    process.stdout.write(`repository-quality: no indexed files for ${mode}; nothing to check.\n`);
  }
  return runBatches(root, tool, files);
}

try {
  process.exitCode = run(process.argv[2] ?? "");
} catch (error) {
  process.stderr.write(
    `repository-quality: ${error instanceof Error ? error.message : "Unexpected failure; inspect the checkout and retry."}\n`,
  );
  process.exitCode = 1;
}
