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
| `mmdr` ([mermaid-rs-renderer](https://crates.io/crates/mermaid-rs-renderer)) | mermaid blocks as images | leaf draws mermaid as ASCII |
| kitty graphics in your terminal | showing those images | the image's text description is shown |
| nvim, and optionally [herdr](https://herdr.dev) | opening clicked file paths | without herdr, a new window via `omarchy-launch-editor`, `$TERMINAL -e nvim`, or `xdg-open` |
| [Omarchy](https://omarchy.org) | leaf colors that follow your desktop theme | leaf's default theme |

Clicks and hover need Claude Code's fullscreen mode.

## What it does

- **Replies through leaf.** Tables that cannot fit at their narrowest words, or that have more than 4 columns and would need wrapping, become one card per row; the rest keep their grid.
- **Folding.** A reply longer than 60 rendered rows folds once you send your next prompt; the newest reply always shows in full. The folded view keeps the `**重點**：` (key point) paragraph, or the first paragraph, plus the headings as buttons that expand the reply and scroll to that heading.
- **Sticky heading.** While you scroll through a long reply, the heading of the section you are in stays on the top visible row.
- **Copy.** `[複製原文]` copies a reply's markdown source, each code block has its own copy button, and `/copy-clean` copies your mouse selection with leaf's borders, line numbers and hard line breaks removed.
- **Links and paths.** URLs and markdown links stay clickable. File paths open in nvim at the given line, in a herdr pane to the right that later clicks reuse.
- **Reader pane.** `/reader` opens a side pane with the last 10 replies and a table of contents; pin the ones you want to keep.
- **Collapsed tool output.** Edit, Write, Bash, Read, Grep and Glob rows collapse to one line such as `✎ 改了 hooks/format.ts  +12 −3`. Failed calls stay expanded.
- **Formatting rules.** A short section added to the system prompt asks for a conclusion first, headings that state their section's point, short paragraphs and tables of at most 4 columns.

## Commands

| Command | Does |
| --- | --- |
| `/reader` | open the reader pane |
| `/fold` | turn folding on or off |
| `/copy-clean` | copy the current mouse selection as clean markdown |
| `/format more \| less \| off` | choose how much formatting the injected rules ask for, or none |
| `/tools` | turn tool-output collapsing on or off |

## Optional setup

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
