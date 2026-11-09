# SDK upgrade

Follow these steps to change the pinned Claude Agent SDK version. CI cannot run the live check, so you run it on a workstation with a Claude subscription.

## Rules

- Keep `@anthropic-ai/claude-agent-sdk` pinned to an exact version.
- CI checks that `package.json`, `package-lock.json` and `sdk-release-contract.json` name the installed SDK version, and that the attestation's `claudeCodeVersion` is at least the minimum.
- Only a complete live run writes `sdk-release-contract.json`. Never edit it by hand.
- A failed or filtered live run leaves the file untouched.
- CI has no subscription credential, so the reviewer decides whether the live evidence is enough.

## Steps

1. Install the exact version:

   ```sh
   npm install @anthropic-ai/claude-agent-sdk@<version> --save-exact -w packages/pi-claude-sdk
   ```

2. Sign in to the Claude Code installation you want to check.
3. Run `npm run test:claude-sdk-upgrade`. It probes text streaming, a deferred tool request, and a coding request that must call `read`. It then probes every registered model and fails if the resolved model, context window or maximum output differs from `models.ts`. If it does, fix `models.ts`. On success it rewrites `sdk-release-contract.json` and checks the pinned versions.
4. Commit the rewritten attestation with the pin change.
5. Run `npm run check`.
6. Put the live command and its result in the pull request.

Run the same gate whenever a model alias resolution is in doubt. Aliases can move without a pin change.

## When usage limits block the live gate

Do not edit `sdk-release-contract.json` or call the upgrade verified. The pin consistency test stays red until a complete live run passes. Wait for the window to reopen (`/claude-sdk-usage` shows when). You can still check model metadata without sending a prompt:

```sh
npm run test:live -- --testNamePattern="model metadata"
```

For provider and Pi-level checks before merging, use the [verification skill](../../../.agents/skills/verify-pi-claude-sdk/SKILL.md).
