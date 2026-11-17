import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, parse, resolve as absolutePath, join } from "node:path";
import { decodeRecord, parseJson } from "./schema.js";

export function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** Bounded read follows config symlinks only when explicitly requested; never opens devices blocking. */
export async function regularBytes(path: string, follow = false): Promise<Buffer | undefined> {
  try {
    const target = follow ? await realpath(path) : path;
    const entry = await lstat(target);
    if (!entry.isFile() || entry.size > 32_768) {
      throw new Error("Expected bounded regular file");
    }
    const file = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 32_768) {
        throw new Error("Expected bounded regular file");
      }
      const bytes = Buffer.alloc(32_769);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 32_768) {
        throw new Error("File too large");
      }
      return bytes.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
export async function privateDirectory(path: string): Promise<void> {
  const absolute = absolutePath(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split("/")) {
    current = join(current, part);
    try {
      // eslint-disable-next-line eslint/no-await-in-loop -- Ownership checks and durable filesystem mutations must be ordered before the next step.
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("Unsafe setup directory ancestor");
      }
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
      // eslint-disable-next-line eslint/no-await-in-loop -- Ownership checks and durable filesystem mutations must be ordered before the next step.
      await mkdir(current, { mode: 0o700 });
      // eslint-disable-next-line eslint/no-await-in-loop -- Ownership checks and durable filesystem mutations must be ordered before the next step.
      await syncDirectory(dirname(current));
    }
  }
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  ) {
    throw new Error("Setup directory must be private, owned, and not a symlink");
  }
}
export async function createPrivate(path: string, content: string): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}
export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await directory.stat();
    if (!stat.isDirectory()) {
      throw new Error("Expected directory");
    }
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function durableRename(source: string, destination: string): Promise<void> {
  await rename(source, destination);
  await syncDirectory(dirname(destination));
  if (dirname(source) !== dirname(destination)) {
    await syncDirectory(dirname(source));
  }
}
export async function durableUnlink(path: string): Promise<void> {
  await unlink(path);
  await syncDirectory(dirname(path));
}
/** Permanent native flock. Holder crash/EOF releases ownership; the lock inode is never unlinked. */
export async function withSetupLock<A>(
  path: string,
  executable: string,
  run: () => Promise<A>,
): Promise<A> {
  await privateDirectory(dirname(path));
  const child = spawn(executable, ["--setup-lock", path], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    cwd: "/",
  });
  child.stdin.on("error", () => undefined);
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.once("error", () => {
      resolve();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let bytes = "";
      const timer = setTimeout(() => {
        reject(new Error("Setup lock acquisition timed out"));
      }, 5000);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("Setup is busy or native lock unavailable; no stale lock is deleted"));
      };
      child.once("error", fail);
      child.once("exit", fail);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.toString("utf8");
        if (bytes.length > 4096) {
          fail();
          return;
        }
        if (!bytes.includes("\n")) {
          return;
        }
        try {
          const ready = decodeRecord(parseJson(bytes.trim()));
          if (ready.version !== 1 || ready.state !== "locked") {
            fail();
            return;
          }
          clearTimeout(timer);
          child.off("error", fail);
          child.off("exit", fail);
          resolve();
        } catch {
          fail();
        }
      });
      child.stderr.resume();
    });
    return await run();
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 2000);
    await exited;
    clearTimeout(timer);
  }
}
