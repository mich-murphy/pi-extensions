# Pi extensions

Extensions for the [Pi coding agent](https://pi.dev/).

## Install

Install every extension in this repository:

```sh
pi install git:github.com/mich-murphy/pi-extensions
```

Then restart Pi or run `/reload`. The extensions need Node.js 22 or later.

To load only some of them, edit the package entry in `~/.pi/agent/settings.json` and list the extensions you want:

```json
{
  "packages": [
    {
      "source": "git:github.com/mich-murphy/pi-extensions",
      "extensions": ["packages/pi-vim/index.ts", "packages/pi-web/index.ts"]
    }
  ]
}
```

You can also switch individual extensions on and off with `pi config`.

## Packages

| Package | What it does | Requires |
| --- | --- | --- |
| [pi-claude](packages/pi-claude) | Runs Claude models through your Claude Code subscription | Claude Code, signed in |
| [pi-retry](packages/pi-retry) | Continues a session when a usage limit resets or a transient failure clears | |
| [pi-coffee](packages/pi-coffee) | Keeps macOS awake while Pi is working | macOS |
| [pi-skills](packages/pi-skills) | Switches skills and instruction files on or off without deleting them | |
| [pi-vim](packages/pi-vim) | Adds Vim keys to the prompt editor | |
| [pi-scrollback](packages/pi-scrollback) | Keeps your prompt visible while you scroll back through history | Fullscreen mode |
| [pi-web](packages/pi-web) | Adds web search and fetch tools that work without an API key | |
| [pi-comms](packages/pi-comms) | Lets live Pi sessions message each other | Shared local gateway; reviewed `/comms setup`, optional mTLS peer; fresh acquisition awaits a published trusted pin |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), including [why the quality gates are set where they are](CONTRIBUTING.md#why-these-gates). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
