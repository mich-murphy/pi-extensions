## Summary

What changed and why.

## Validation

- [ ] `npm run check` passed
- [ ] Docs updated, or no user-visible change

Other commands run, with results:

## Claude Agent SDK upgrade

Only when the pinned `@anthropic-ai/claude-agent-sdk` version changes:

- [ ] `npm run test:claude-sdk-upgrade` passed against an authenticated Claude Code
- [ ] `sdk-release-contract.json` was rewritten by that run, not by hand
- [ ] The reviewer checked the live command output
