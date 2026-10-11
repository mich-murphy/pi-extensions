# Pi No Sleep

Prevents macOS idle and display sleep while Pi is doing agent work. It also
prevents system sleep while the Mac is connected to AC power.
Each active Pi process holds one `/usr/bin/caffeinate` process. The assertion
starts on `agent_start`, remains active across retries and compaction, and ends
on `agent_settled` or `session_shutdown`. Each assertion started by
`agent_start` gets one restart after an unexpected process exit. That allowance
prevents a restart loop; a later `agent_start` gets a fresh allowance whenever
no assertion remains, including a continuation that starts before settlement.

Stopping requests `SIGTERM`, then requests `SIGKILL` one second later if
caffeinate is still running. Pi never waits for terminal process exit, so the
extension adds no delay to settling or shutdown. A failed signal is a process
notification, not proof that caffeinate exited; the adapter may subsequently
report its actual exit. Released-child notifications are intentionally ignored.
The `-w` flag makes caffeinate exit with Pi, so a crashed Pi cannot leave the Mac
awake.

The extension has no settings or commands. Installing it enables this command:

```text
/usr/bin/caffeinate -d -i -s -w <pi-pid>
```

Other operating systems remain unchanged: the extension registers nothing.
