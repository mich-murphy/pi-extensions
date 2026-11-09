# Security policy

## Supported versions

Only the latest commit on `main` receives fixes.

## Report a vulnerability

Report it privately through [GitHub's vulnerability reporting](https://github.com/mich-murphy/pi-extensions/security/advisories/new). Do not open a public issue.

Include the affected package, the steps to reproduce it and the impact you expect. Leave out real credentials.

This is a personal project, so responses are best effort.

## Scope

Reports are most useful for:

- Credentials leaking into tool output, logs, errors or unofficial endpoints.
- `pi-web-tools` fetching private or internal addresses, including through redirects or DNS rebinding.
- `pi-comms` peers connecting or exchanging messages outside their configured trust and policy.
- `pi-claude-sdk` running a tool without Pi's approval, or sending traffic to an endpoint other than Claude's.
