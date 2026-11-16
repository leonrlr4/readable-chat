# readable-chat

A Claude Code mod that makes long replies and tables readable in the terminal. Each assistant reply is rendered by [leaf](https://github.com/RivoLink/leaf), so tables get borders and in-cell wrapping, headings get color and underlines, and code blocks get a frame with line numbers. Long replies fold to a summary and an outline you can jump from.

The interface text (buttons, toasts, command replies) and the formatting rules it gives the model are in Traditional Chinese.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install readable-chat --marketplace leonrlr4/readable-chat
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install readable-chat --marketplace leonrlr4/readable-chat
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `leonrlr4/readable-chat`, then Add plugin.

## Requirements

| Tool | Needed for | Without it |
| --- | --- | --- |
| [leaf](https://github.com/RivoLink/leaf) 1.29+ | rendering replies | Claude Code draws replies itself; wide tables still become cards |
| `mmdr` ([mermaid-rs-renderer](https://crates.io/crates/mermaid-rs-renderer)) | mermaid blocks as images | leaf draws mermaid as ASCII, with a note under it |
| ImageMagick 7 (`magick`), `file`, and `resvg` or `rsvg-convert` for SVG | Markdown images and Read thumbnails | a caption with the alt text, the reason, and the path |
| `curl` and `getent` | remote images, once `/images remote on` | alt text and the URL as a link |
| node and MathJax 4, installed by `bin/install-mathjax.sh` (optional), plus `rsvg-convert` | complex display math as images | leaf's Unicode version of the formula |
| kitty graphics in your terminal | showing those images | the image's text description is shown |
| nvim, and optionally [herdr](https://herdr.dev) | opening clicked file paths | without herdr, a new window via `omarchy-launch-editor`, `$TERMINAL -e nvim`, or `xdg-open` |
| [Omarchy](https://omarchy.org) | leaf colors that follow your desktop theme | leaf's default theme |

Clicks and hover need Claude Code's fullscreen mode.

## What it does

- **Replies through leaf.** Tables that cannot fit at their narrowest words, or that have more than 4 columns and would need wrapping, become one card per row; the rest keep their grid.
- **Folding.** A reply longer than 60 rendered rows folds once you send your next prompt; the newest reply always shows in full. The folded view keeps the `**重點**：` (key point) paragraph, or the first paragraph, plus the headings as buttons that expand the reply and scroll to that heading.
- **Sticky heading.** While you scroll through a long reply, the heading of the section you are in stays on the top visible row.
- **Copy.** `[複製原文]` copies a reply's markdown source, each code block has its own copy button, and a mouse selection over a reply (fullscreen mode) copies the markdown source behind it in place of the screen text. Within 5 seconds of the selection changing, a clipboard that holds that selection's screen text (written by copy on select, or by herdr or tmux on mouse release) gets the source written over it; anything else on the clipboard, such as a screenshot, is left alone. This needs `wl-paste`: backticks around `snake_case` names and lines leaf only wrapped come out as written, so the paste does not turn italic in Slack. When the selection matches no reply source the screen text stays on the clipboard; `/copy-clean` copies it with leaf's borders, line numbers and wrap breaks removed.
- **Links and paths.** URLs and markdown links stay clickable. File paths open in nvim at the given line, in a herdr pane to the right that later clicks reuse; `.md` files open in leaf instead, each click replacing the last leaf pane.
- **Images.** An image on its own line, `![alt](path)`, is drawn in the reply (at most 20 rows) with a caption row: the alt text, the path (clicking it opens the file) or URL, `[原始碼]` to show the Markdown instead, and `[放大]`. If it cannot load, the caption says why, for example `圖：架構圖（檔案不存在）`. An image inside a sentence becomes `alt（path）`. Local PNG, JPEG, GIF, WebP, BMP and SVG are converted once into `~/.cache/readable-chat/images`. Remote https images are off by default, since fetching one tells its host you are reading; private and loopback addresses are refused even when on.
- **Math.** Display math that leaf flattens badly (fractions, roots, sums, matrices, multi-line) is typeset by MathJax and drawn as an image with the same caption buttons. Simple formulas stay text. If typesetting fails, leaf's version stays with a note under it.
- **Mermaid.** Diagrams get the same caption row; when `mmdr` fails, leaf's ASCII diagram stays with a note saying so. The formatting rules ask the model to chart numbers with `xychart-beta` or `pie` instead of text bars.
- **Zoom.** `[放大]` opens the picture in the desktop's image viewer (`xdg-open`): local files and URLs as they are, mermaid and math rendered again at 3× on the terminal's background into `~/.cache/readable-chat/zoom`.
- **Reader pane.** `/reader` opens a side pane with the last 10 replies and a table of contents; pin the ones you want to keep. The search box filters the reply to matching lines, highlighted. `f` puts a keyboard label beside every link and path, so typing the label opens it. After a jump from the table of contents or to another reply, `b` goes back.
- **Read thumbnails.** A collapsed Read of an image file shows an 8-row thumbnail under its summary row.
- **Collapsed tool output.** Edit, Write, Bash, Read, Grep and Glob rows collapse to one line such as `✎ 改了 hooks/format.ts  +12 −3`. Failed calls stay expanded.
- **Focus mode.** Once you send a new prompt, earlier replies draw dim. Each prompt you type gets a rule above it, and the `Worked for 23s` line and Skill-loading rows are hidden (ctrl+o still shows them).
- **Formatting rules.** A short section added to the system prompt asks for a conclusion first, headings that state their section's point, short paragraphs, tables of at most 4 columns, and mermaid charts for numbers.

## Commands

| Command | Does |
| --- | --- |
| `/reader` | open the reader pane |
| `/fold` | turn folding on or off |
| `/copy-clean` | copy the markdown source behind the current mouse selection |
| `/format more \| less \| off` | choose how much formatting the injected rules ask for, or none |
| `/tools` | turn tool-output collapsing on or off |
| `/focus-mode` | turn focus mode on or off |
| `/images` | show whether remote images are fetched |
| `/reader-colors system \| leaf` | color replies with your Omarchy theme (default) or with leaf's own theme; with no argument it switches, and the choice is kept across sessions |
| `/images remote on \| off` | fetch https images in replies, or show only their alt text and URL (default) |

## Optional setup

Install MathJax for math images (into `~/.cache/readable-chat/mathjax`, needs node and npm):

```
bash ~/.claude/plugins/cache/<marketplace>/readable-chat/<version>/bin/install-mathjax.sh
```

Rebuild leaf's colors as soon as the Omarchy theme changes, instead of within 30 seconds:

```
ln -s ~/.claude/plugins/cache/<marketplace>/readable-chat/<version>/bin/omarchy-theme-hook.sh \
  ~/.config/omarchy/hooks/theme-set.d/readable-chat-leaf
```

## Development

```
claude plugin validate .
claude plugin test .
bash tests/leaf-cjk.sh
```

## License

MIT
