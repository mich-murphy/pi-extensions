# Inspect subscription allowance

A user runs `/claude-sdk-usage` to see remaining subscription allowance and reset
times through the SDK's structured usage API, without a model prompt.

## Sub-features

- `usage-discover`: command is registered in Pi's command list.
- `usage-notify`: real allowance/reset notification reaches the client.
- `usage-safety`: paid extra usage remains disabled before any live prompt.

## How to get to it (user POV)

Type `/claude-sdk-usage` in Pi, or send that slash command through Pi RPC.

## Driving it with verify.py

Preconditions: Launch and Doctor passed; existing Claude subscription auth.

- **Invoke:** run `"$H" commands --evidence "$E"`. After status, the RPC client
  sends the exact slash command and captures its actual notification.
- **Observe:** `usage-notification.txt` must contain remaining percentages and
  reset times; `commands.jsonl` pairs action with notification and response.
  Missing authentication, unavailable limits, or a timeout is not a passing
  allowance journey. Report the exact unmet precondition; do not log in.
- **Interpret:** zero allowance still proves this display journey; it blocks the
  separate live journey. Require `Extra usage: disabled` before live prompts.
- **Proof:** retain notification, RPC transcript, stderr and result JSON.

## Gotchas

- This API makes a structured SDK request but sends no model prompt; it can work
  while text generation is rate limited. It is not an offline network test.
- Reset times are localized by the process locale; do not infer UTC from the
  displayed clock alone. Refresh allowance after the reported reset before retrying.
- Usage is account-wide and can change concurrently. Never enable extra usage,
  use an API key, or fall back to another billed provider to make verification pass.
