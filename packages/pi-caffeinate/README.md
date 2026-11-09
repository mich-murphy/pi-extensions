# pi-caffeinate

Keeps your Mac awake while Pi is working. It works on macOS only and does nothing on other systems.

## Install

Run `pi install git:github.com/mich-murphy/pi-extensions`, or [load only some extensions](../../README.md#install). It has no settings or commands.

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

While Pi works, `pmset -g assertions` lists a `caffeinate` entry. If caffeinate fails to start or exits unexpectedly, Pi shows a `No Sleep` message.
