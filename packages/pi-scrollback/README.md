# pi-scrollback

Keeps your current prompt visible while you scroll back through a Pi session. A single muted row above the transcript shows the nearest user prompt before the part you are reading.

## Install

Run `pi install git:github.com/mich-murphy/pi-extensions`, or [load only some extensions](../../README.md#install). It has no settings.

## Requirements

It needs Pi's fullscreen mode. That is the default, so you usually need to do nothing. If you switched to regular mode, set `tuiMode` back to `fullscreen` in `/settings`, or start Pi with `--tui-mode fullscreen`. In regular, print, JSON and RPC modes there is no row.

## Usage

Scroll up through the transcript. Once the prompt you are reading under scrolls off screen, it appears in a row at the top.

## How it behaves

- **Shows** when you scroll back and the prompt that owns the visible content has scrolled off screen.
- **Hides** while that prompt's own text is still visible.
- **Returns** the row to the transcript when you scroll back to the live end, including during long streamed output.

## Commands

| Command | Effect |
| --- | --- |
| `/scrollback` | Toggles the row on or off for this session |
| `/scrollback on` | Shows the row for this session. This is the default |
| `/scrollback off` | Removes the row for this session |

The setting is not saved. A new Pi process starts with the row on.

## Limitations

Pi has no public way to pin a row above the transcript, so the extension hooks into undocumented parts of Pi's screen layout. A Pi upgrade may break it. If the layout is not recognised, the extension leaves Pi untouched and shows no row.

## Credit

[BlockLune/pi-sticky-header](https://github.com/BlockLune/pi-sticky-header) informed the research into Pi's private layout. This implementation is original.
