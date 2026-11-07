/** Isolated temp Pi profile for the production adapter. No inherited credentials or user config. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_MACHINE, MACHINES, SCOPE } from "./corpus.js";

export type Profile = {
  root: string;
  config: unknown;
  agentDir: string;
  cwd: string;
  sessionsDir: string;
  cleanup: () => Promise<void>;
};
export async function makeProfile(socketPath: string, codemode: boolean): Promise<Profile> {
  const root = await mkdtemp(join(tmpdir(), "psc-profile-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "cwd");
  const sessionsDir = join(root, "sessions");
  await Promise.all([agentDir, cwd, sessionsDir].map(async (d) => mkdir(d, { recursive: true })));
  const config = {
    machineId: LOCAL_MACHINE,
    socketPath,
    scopeIds: [SCOPE],
    label: "offline evaluation adapter",
    policies: MACHINES.map((machineId) => ({
      machineId,
      scopeId: SCOPE,
      permissions: ["discover", "read", "push"],
    })),
  };
  await writeFile(join(agentDir, "session-communication.json"), JSON.stringify(config));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [],
      extensions: [],
      skills: [],
      promptTemplates: [],
      quietStartup: true,
      defaultProjectTrust: "never",
      ...(codemode ? { defaultTools: ["+codemode"], codemode: { mode: "on" } } : {}),
    }),
  );
  return {
    root,
    config,
    agentDir,
    cwd,
    sessionsDir,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}
