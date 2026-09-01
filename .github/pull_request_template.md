## Summary

Describe the behavior changed and why.

## Validation

List the commands run and their results.

## Claude Agent SDK upgrade evidence

Complete this section only when the pinned `@anthropic-ai/claude-agent-sdk` version changes.

- [ ] `npm run test:claude-sdk-upgrade` passed against the pinned SDK using an authenticated Claude Code installation.
- [ ] `packages/claude-sdk-provider/sdk-release-contract.json` records that SDK version, its bundled Claude Code version, the UTC verification time, and the observed defer shape.
- [ ] The reviewer checked the live command evidence rather than relying only on the editable attestation file.
