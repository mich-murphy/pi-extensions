# Codemode comparison harness

Compares direct tool calls with native codemode using the production adapter, a simulated gateway and a scripted offline model. It measures scheduling and context size, not model quality or live latency.

Run from the repository root. The runner writes the results file only when you ask for it. The last argument is the trial count.

```sh
node --import jiti/register packages/pi-comms/test/codemode/run.ts results.json 3
npm test -- packages/pi-comms/test/codemode --maxWorkers=2
```

| File | Purpose |
| --- | --- |
| `corpus.ts` | Tasks and expected answers. |
| `gateway.ts` | Simulated gateway speaking real frames. |
| `profile.ts` | Temporary agent directory. |
| `recorder.ts` | Scripted model. The direct arm batches independent calls. |
| `trial.ts` | One trial per process. |
| `run.ts` | Runner, at most 2 trials at once. |
| `serve.ts` | Fixture CLI: `--scenario aggregate [--codemode] [--receipts file]`. |
| `codemode.test.ts` | One-trial test that writes nothing. |

| Metric | Meaning |
| --- | --- |
| `toolResultBytes` | UTF-8 bytes of tool-result text. |
| `cumulativeRequestBytes` | JSON bytes of every request transcript, including tool declarations. |
| Rounds | Model turns, including the final answer. |
| Tool calls | Calls issued by the model. |
| Gateway ops | Operations that reached the gateway. |
| Correctness | Answer compared with the expected JSON. |
