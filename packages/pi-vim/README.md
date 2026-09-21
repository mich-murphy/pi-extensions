# Pi Vim editor

Adds a small Vim-style normal mode to Pi's main prompt editor without replacing
Pi's editor implementation.

The editor starts in Insert mode. Press `Esc` or `Ctrl+[` for Normal mode. The
editor border shows the current mode and any pending command, such as
`NORMAL di`. When Pi empties the editor, for example after it accepts a
submission, the editor returns to Insert mode for the next prompt.

## Normal-mode bindings

- Movement: `h`, `j`, `k`, `l`, `w`, `b`, `0`, `$`
- Insert: `i`, `a`, `A`, `I`, `o`, `O`
- Editing: `x`, `D`, `C`, `u`, `dd`, `dw`, `diw`, `cc`, `cw`, `ciw`

Printable keys never reach Pi in Normal mode, so an unbound key does nothing.
`Esc` cancels a pending command. With nothing pending, `Esc` keeps Pi's
interrupt behavior. Control keys such as `Enter`, arrows, and Pi's application
shortcuts keep their configured Pi meaning.

`h`, `l`, `x`, `D`, and `dw` stay within the current line, as they do in Vim.
`j` and `k` move like Pi's arrow keys, so they follow wrapped lines and browse
prompt history from the first and last line.

## How it works

Each binding is a list of base-editor actions, such as "line start" or "delete
word". The extension performs an action by sending the base editor the input
that Pi's default keybindings map to it. It sends that input under the default
keybindings and past Pi's application shortcuts, so rebinding Pi's editor keys
does not change what a Vim command does.

Word operations intentionally use Pi's existing word boundaries. `dw` and `cw`
delete to the end of the word, and `diw` does nothing on whitespace. Pi offers
no atomic way to delete a whole line, so `dd` on a line with text needs two `u`
presses to restore it.
