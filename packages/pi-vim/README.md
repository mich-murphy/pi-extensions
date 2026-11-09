# pi-vim

Adds Vim-style Normal mode to Pi's main prompt editor.

## Install

Run `pi install git:github.com/mich-murphy/pi-extensions`, or [load only some extensions](../../README.md#install). It has no settings, and works in the interactive terminal UI only.

## Usage

The editor starts in Insert mode. Press `Esc` or `Ctrl+[` for Normal mode. The editor's bottom border shows ` INSERT ` or ` NORMAL `, plus any pending command, such as `NORMAL d`. The label is hidden while the autocomplete list is open or the terminal is very narrow.

After Pi accepts a prompt, the editor returns to Insert mode.

## Normal-mode keys

| Key | Action | Notes |
| --- | --- | --- |
| `h` `l` | Left, right | Stay within the line. |
| `j` `k` | Down, up | Move like Pi's arrow keys: follow wrapped lines and browse history from the first or last line. |
| `w` `b` | Next word, previous word | Use Pi's word boundaries. |
| `0` `$` | Line start, line end | |
| `i` `a` | Insert at, after the cursor | |
| `I` `A` | Insert at line start, end | |
| `o` `O` | Open a line below, above | Enters Insert mode. |
| `x` | Delete character | Stays within the line. |
| `D` | Delete to line end | |
| `C` | Delete to line end, then insert | |
| `dd` | Delete line | Needs two `u` presses to restore. |
| `dw` `cw` | Delete word, change word | Delete to the word's end. |
| `diw` `ciw` | Delete inner word, change inner word | Does nothing on whitespace. |
| `cc` | Clear line, then insert | |
| `u` | Undo | |
| `Esc` | Cancel a pending command | With nothing pending, keeps Pi's interrupt behavior. |

Enter, arrows and Pi's shortcuts keep their Pi meaning. Other printable keys do nothing.

## Differences from Vim

- Word motions and edits use Pi's word boundaries.
- `dd` is not a single undo step.
- Rebinding Pi's editor keys does not change these commands.

## Not supported

Counts (`3w`), `.` repeat, visual mode, registers and `p`, search, and any key not in the table.
