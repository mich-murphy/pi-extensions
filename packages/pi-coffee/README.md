# pi-coffee

Keeps your Mac awake while Pi is working. It works on macOS only. On other systems, it only registers `/coffee`, which reports that sleep prevention is unavailable.

## Install

Run `pi install git:github.com/mich-murphy/pi-extensions`, or [load only some extensions](../../README.md#install). It has no settings.

## Commands

| Command | Effect |
| --- | --- |
| `/coffee` | Toggles sleep prevention for this session. |
| `/coffee on` | Turns sleep prevention on for this session. If Pi is working, it starts at once; otherwise it starts with the next agent run. |
| `/coffee off` | Turns sleep prevention off for this session and stops any running caffeinate at once. |

Sleep prevention is on when a session starts. The command confirms each change with `Coffee is on for this session.` or `Coffee is off for this session.` Any other argument shows `Usage: /coffee [on|off]` and changes nothing.

## How it behaves

Pi holds the Mac awake from the start of agent work, including retries and compaction. It releases when Pi settles and is idle, or when the session shuts down. If the process exits unexpectedly, it restarts once. caffeinate exits when Pi exits, so a crashed Pi cannot leave the Mac awake.

It runs `/usr/bin/caffeinate -d -i -s -w <pi-pid>`:

| Flag | Prevents |
| --- | --- |
| `-d` | Display sleep. |
| `-i` | Idle sleep. |
| `-s` | System sleep, only on AC power. |
| `-w` | Outliving Pi: caffeinate exits when Pi does. |

## Troubleshooting

While Pi works, `pmset -g assertions` lists a `caffeinate` entry. If caffeinate fails to start or exits unexpectedly, Pi shows a `Coffee` message with the failed operation and a next step. Pi can continue working, but sleep prevention may be unavailable. Check `/usr/bin/caffeinate` and macOS process permissions/resources. After an unexpected exit, the message says whether the extension is restarting once or has exhausted that run's restart allowance.
