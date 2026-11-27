import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findTailscale } from "../onboarding/tailscale.js";

const REFUSED = "Tailscale failed or gave an unexpected answer";

async function file(path: string, content: string | Uint8Array, mode: number): Promise<string> {
  await writeFile(path, content);
  await chmod(path, mode);

  return path;
}

async function program(root: string, mode: number): Promise<string> {
  return file(join(root, `tailscale-${mode.toString(8)}`), "binary", mode);
}

async function wrapper(root: string, body: string): Promise<string> {
  return file(join(root, "wrapper"), body, 0o755);
}

async function chain(root: string, links: number, target: string): Promise<string> {
  let previous = target;

  for (let index = 0; index < links; index += 1) {
    const link = join(root, `link-${String(index)}`);
    await symlink(previous, link);
    previous = link;
  }

  return previous;
}

async function groupWritable(root: string): Promise<string> {
  return program(root, 0o775);
}

async function worldWritable(root: string): Promise<string> {
  return program(root, 0o757);
}

async function notExecutable(root: string): Promise<string> {
  return program(root, 0o644);
}

async function directory(root: string): Promise<string> {
  const path = join(root, "tailscale-directory");
  await mkdir(path, { mode: 0o755 });

  return path;
}

async function worldWritableTarget(root: string): Promise<string> {
  const target = await program(root, 0o757);

  return wrapper(root, `#!/bin/sh\nexec ${target} "$@"\n`);
}

async function quotedGroupWritableTarget(root: string): Promise<string> {
  const target = await program(root, 0o775);

  return wrapper(root, `#!/bin/sh\nexec "${target}" "$@"\n`);
}

async function scriptTarget(root: string): Promise<string> {
  const target = await file(join(root, "inner"), "#!/bin/sh\n", 0o755);

  return wrapper(root, `#!/bin/sh\n${target} "$@"\n`);
}

async function groupWritableInterpreter(root: string): Promise<string> {
  const interpreter = await program(root, 0o775);

  return wrapper(root, `#!${interpreter}\n`);
}

async function scriptInterpreter(root: string): Promise<string> {
  const interpreter = await file(join(root, "interpreter"), "#!/bin/sh\n", 0o755);

  return wrapper(root, `#!${interpreter} -e\n`);
}

async function relativeInterpreter(root: string): Promise<string> {
  return wrapper(root, "#!sh\n");
}

async function noInterpreter(root: string): Promise<string> {
  return wrapper(root, "#!\nexec /bin/sh\n");
}

async function oversizedWrapper(root: string): Promise<string> {
  return wrapper(root, `#!/bin/sh\n${"#".repeat(4085)}\n`);
}

async function binaryWrapper(root: string): Promise<string> {
  return file(
    join(root, "wrapper"),
    new Uint8Array([35, 33, 47, 98, 105, 110, 47, 115, 104, 10, 255, 254]),
    0o755,
  );
}

async function symlinkLoop(root: string): Promise<string> {
  await symlink(join(root, "loop-b"), join(root, "loop-a"));
  await symlink(join(root, "loop-a"), join(root, "loop-b"));

  return join(root, "loop-a");
}

async function nineLinks(root: string): Promise<string> {
  return chain(root, 9, await program(root, 0o755));
}

async function linkToGroupWritable(root: string): Promise<string> {
  return chain(root, 1, await program(root, 0o775));
}

async function relativePath(): Promise<string> {
  return "tailscale";
}

describe("the tailscale command is trusted the way the gateway trusts it", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "pt-")));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test.each([
    ["a group-writable binary", groupWritable],
    ["a world-writable binary", worldWritable],
    ["a file nobody may run", notExecutable],
    ["a directory", directory],
    ["a wrapper whose target is world-writable", worldWritableTarget],
    ["a wrapper whose quoted target is group-writable", quotedGroupWritableTarget],
    ["a wrapper whose target is itself a script", scriptTarget],
    ["a wrapper whose interpreter is group-writable", groupWritableInterpreter],
    ["a wrapper whose interpreter is itself a script", scriptInterpreter],
    ["a wrapper with a relative interpreter", relativeInterpreter],
    ["a wrapper with no interpreter", noInterpreter],
    ["a wrapper of 4 KiB or more", oversizedWrapper],
    ["a wrapper that is not UTF-8", binaryWrapper],
    ["a symlink loop", symlinkLoop],
    ["a chain of nine symlinks", nineLinks],
    ["a symlink to a group-writable binary", linkToGroupWritable],
    ["a relative path", relativePath],
  ])("%s is refused", async (_case, build) => {
    const candidate = await build(root);
    await expect(findTailscale([candidate])).rejects.toThrow(REFUSED);
  });

  test("a dangling symlink is refused, not skipped for a later candidate", async () => {
    const dangling = join(root, "dangling");
    await symlink(join(root, "absent"), dangling);
    const good = await program(root, 0o755);
    await expect(findTailscale([dangling, good])).rejects.toThrow(REFUSED);
  });

  test.each([0o755, 0o700, 0o500])("an own binary with mode %o is accepted", async (mode) => {
    const own = await program(root, mode);
    await expect(findTailscale([own])).resolves.toBe(own);
  });

  test("a root-owned binary is accepted", async () => {
    const shell = await realpath("/bin/sh");
    await expect(findTailscale([shell])).resolves.toBe(shell);
  });

  test("a wrapper like the macOS install is accepted; comments and absent paths are not checked", async () => {
    const target = await program(root, 0o755);
    const ignored = await program(root, 0o777);
    const body = `#!/bin/sh\n# was ${ignored}\n${target} "$@" 2>/nonexistent/log\n`;
    const trusted = await wrapper(root, body);
    await expect(findTailscale([trusted])).resolves.toBe(trusted);
  });

  test("a wrapper of 4095 bytes is accepted", async () => {
    const trusted = await wrapper(root, `#!/bin/sh\n${"#".repeat(4084)}\n`);
    await expect(findTailscale([trusted])).resolves.toBe(trusted);
  });

  test("eight symlinks are followed and the canonical program is returned", async () => {
    const target = await program(root, 0o755);
    await expect(findTailscale([await chain(root, 8, target)])).resolves.toBe(target);
  });
});
