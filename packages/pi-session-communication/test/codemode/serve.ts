/** CLI: start the SIMULATED gateway and print one JSON line. Runs until stdin closes.
 *  node --import jiti/register test/codemode/serve.ts --scenario aggregate [--codemode] [--receipts <file>]
 *  Receipts (observed ops + simulated outcomes) are written to <file> when stdin closes. */
import { SCENARIOS, TASKS } from "./corpus.js";
import { SimulatedGateway } from "./gateway.js";
import { makeProfile } from "./profile.js";

export async function startFixture(scenarioId: string, codemode = false, receiptsPath?: string) {
  const scenario = SCENARIOS[scenarioId];
  if (scenario === undefined) {
    throw new Error(`Unknown scenario ${scenarioId}`);
  }
  const gateway = new SimulatedGateway(scenario, receiptsPath);
  const socketPath = await gateway.start();
  const profile = await makeProfile(socketPath, codemode);
  return {
    gateway,
    profile,
    task: TASKS.find((t) => t.id === scenarioId),
    stop: async () => {
      await gateway.stop();
      await profile.cleanup();
    },
  };
}
if (process.argv[1]?.endsWith("serve.ts") === true) {
  const args = process.argv.slice(2);
  const id = args[args.indexOf("--scenario") + 1] ?? "aggregate";
  const receiptsIndex = args.indexOf("--receipts");
  const receiptsPath = receiptsIndex < 0 ? undefined : args[receiptsIndex + 1];
  const fixture = await startFixture(id, args.includes("--codemode"), receiptsPath);
  process.stdout.write(
    `${JSON.stringify({
      simulatedGateway: true,
      socketPath: fixture.gateway.socketPath,
      agentDir: fixture.profile.agentDir,
      config: fixture.profile.config,
      receiptsPath: receiptsPath ?? null,
      cwd: fixture.profile.cwd,
      extension: new URL("../../index.ts", import.meta.url).pathname,
      task: fixture.task,
    })}\n`,
  );
  process.stdin.resume();
  process.stdin.on("end", () => {
    void fixture.stop();
  });
}
