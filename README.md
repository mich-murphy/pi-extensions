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
      "extensions": ["packages/pi-vim/index.ts", "packages/pi-web-tools/index.ts"]
    }
  ]
}
```

You can also switch individual extensions on and off with `pi config`.

## Packages

| Package | What it does | Requires |
| --- | --- | --- |
| [pi-claude-sdk](packages/pi-claude-sdk) | Runs Claude models through your Claude Code subscription | Claude Code, signed in |
| [pi-auto-resume](packages/pi-auto-resume) | Continues a session when a usage limit resets or a transient failure clears | |
| [pi-caffeinate](packages/pi-caffeinate) | Keeps macOS awake while Pi is working | macOS |
| [pi-skill-toggle](packages/pi-skill-toggle) | Switches skills and instruction files on or off without deleting them | |
| [pi-vim](packages/pi-vim) | Adds Vim keys to the prompt editor | |
| [pi-scroll-context](packages/pi-scroll-context) | Keeps your prompt visible while you scroll back through history | Fullscreen mode |
| [pi-web-tools](packages/pi-web-tools) | Adds web search and fetch tools that work without an API key | |
| [pi-comms](packages/pi-comms) | Lets live Pi sessions message each other | A gateway, for sessions on other machines |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
