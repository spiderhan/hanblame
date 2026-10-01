# Hanblame

Inline git blame for VS Code. Shows who last changed the line your cursor is on,
at the end of that line, plus a hover with the full commit and a status bar entry.

No account, no sign-in, no network calls. It runs `git` in your workspace and
nothing else.

## Install

No build step — it's plain JavaScript.

1. Copy the `hanblame` folder into your VS Code extensions folder:

   - macOS / Linux: `~/.vscode/extensions/`
   - Windows: `%USERPROFILE%\.vscode\extensions\`

   ```bash
   cp -r hanblame ~/.vscode/extensions/
   ```

2. Restart VS Code (or run **Developer: Reload Window** from the command palette).

3. Open a file in a git repo and put your cursor on a line.

To uninstall, delete the folder and reload.

### Using Cursor or VS Code Insiders

Same thing, different folder: `~/.cursor/extensions/` or
`~/.vscode-insiders/extensions/`.

## What you get

- **Inline annotation** on the cursor's line — author, when, and the commit subject
- **Hover** over it for the full commit message and links to view or copy the commit
- **Status bar** showing the same thing, clickable
- **Gutter heatmap** — a thin bar beside each line, strongest for the most
  recently changed code and fading to almost nothing for code that has sat still
  for a year
- **CodeLens above functions** — a summary line above each function, method and
  class: one author and when, or "3 authors, last changed 2 days ago". Click it
  to open the most recent commit. Off by default; turn on `hanblame.codeLens`
- **File History panel** in the activity bar — every commit that touched the
  current file, newest first, following renames. Click one to open its patch,
  or use the compare icon to diff that revision against your working copy.
  Right-click for "Open file at this revision" and "Copy commit SHA"
- **Commands** (all under `Hanblame:` in the command palette):
  - Toggle inline blame
  - Copy commit SHA for current line
  - Show commit for current line — opens the full diff in a tab
  - Toggle gutter heatmap
  - Toggle CodeLens above functions
  - Run diagnostics — walks every step and says exactly where it broke

## If nothing appears

Run **Hanblame: Run diagnostics** from the command palette. It checks each step
in order — finding git, the active file, the repo, the blame itself — and prints
the result into an output panel.

The usual culprit on a Mac is git. VS Code launched from the Dock doesn't inherit
the PATH from your shell, so a Homebrew git can be invisible to it even though
`git` works fine in Terminal. Run `which git`, then paste the result into the
`hanblame.gitPath` setting.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `hanblame.gitPath` | `""` | Full path to git. Empty means search the usual places |
| `hanblame.enabled` | `true` | Show the annotation at all |
| `hanblame.format` | `${author}, ${date} • ${message}` | Template. Placeholders: `${author}`, `${date}`, `${message}`, `${sha}`, `${shortSha}` |
| `hanblame.dateStyle` | `relative` | `relative` ("3 days ago") or `absolute` ("2026-09-15") |
| `hanblame.useYou` | `true` | Show "You" for your own commits, matched on your git email |
| `hanblame.maxMessageLength` | `60` | Truncate the commit message. `0` for no limit |
| `hanblame.statusBar` | `true` | Also show blame in the status bar |
| `hanblame.codeLens` | `false` | Blame summary above each function, method and class |
| `hanblame.codeLensKinds` | function, method, class, constructor | Which symbols get a CodeLens |
| `hanblame.heatmap` | `true` | Colour the gutter by how recently each line changed |
| `hanblame.heatmapColor` | `#3FB950` | Base colour for the heatmap. The eight steps are derived from it |
| `hanblame.heatmapMaxAge` | `365` | Age in days at which a line reaches the faintest colour |
| `hanblame.historyLimit` | `50` | How many commits to list in the File History panel |
| `hanblame.delay` | `200` | Milliseconds after the cursor stops before looking up blame |
| `hanblame.blameDirtyFiles` | `true` | Keep blame accurate in files with unsaved changes |
| `hanblame.ignoreWhitespace` | `true` | Ignore whitespace-only changes, so reformatting doesn't hide the real author |

## About the heatmap colours

Age is a magnitude, so it gets one hue ramped by lightness rather than a
hot-to-cold rainbow — a rainbow implies categories that aren't there. The
strongest step is the code that changed most recently, which is what you're
usually scanning for; older code fades until it stops competing for attention.

Green is the default because warm reds and oranges read as *warnings* in an
editor, which is the wrong signal for "somebody changed this recently". Set
`hanblame.heatmapColor` to any hex value and the eight steps are derived from
it — the hue is kept and only lightness and saturation move, so a custom colour
can't accidentally turn the ramp into a rainbow. Some that work well:

| | |
| --- | --- |
| `#3FB950` | green (default) |
| `#D97706` | amber |
| `#3B82F6` | blue |
| `#A855F7` | purple |
| `#8B949E` | grey, for something very understated |

Light and dark themes get separately chosen steps rather than one set flipped,
because a ramp that reads well on white disappears on a dark surface. The steps
rebuild automatically when you switch theme.

Age is scaled logarithmically: the difference between today and last week matters
far more than the difference between 300 days and 330, and a linear scale would
collapse everything recent into a single step.

## How it works

Four small files:

- `git.js` — runs `git blame --porcelain` and parses it
- `colour.js` — derives the heatmap ramp from one base colour
- `format.js` — turns a commit into the text shown on the line
- `extension.js` — the VS Code wiring: decorations, hover, status bar, commands

**On performance.** Git spends its time walking history rather than on the line
range you asked for, so blaming one line costs about the same as blaming the
whole file. Hanblame therefore blames the whole file on first touch and caches
it — measured at about 125ms for a 5,000-line file with 81 commits, and instant
for every line after that. The cache is keyed on the document version, so it
refreshes when you edit and clears on save. Files over 20,000 lines fall back to
one line at a time to keep git's output within the read buffer.

Files with unsaved changes are blamed by piping the editor's buffer to git, so
line numbers stay correct while you type and edited lines read as
"Uncommitted changes".

## About the CodeLens

Symbols come from whichever language extension owns the file, not from parsing
the code here — so it works in any language that has a symbol provider, and
quietly does nothing in one that doesn't. Both symbol shapes VS Code can return
are handled, since older language extensions return a flat list.

A block's date is the newest commit anywhere in it, not the commit on its first
line. Authors are grouped by email rather than name, so one person committing
under two spellings counts once.

It's off by default: a line above every function is a lot of extra furniture,
and it's worth choosing rather than inheriting.

## Independence of the pieces

Each feature is its own switch. Turning off the inline annotation leaves the
heatmap painted; the CodeLens and the History panel are separate again. The
heatmap describes the whole file rather than the cursor, so it stays put while
you move around, including on lines with no blame, and paints every split
showing that file.

## Tests

```bash
node test/run.js
```

Builds a throwaway repo in your temp folder, exercises the git and formatting
layers against it, cleans up after itself. The VS Code layer isn't covered —
that needs the editor running.

## Possible next steps

- Commit graph — the big one, needs a webview and a lane layout algorithm

## Licence

MIT. Written from scratch against the VS Code extension API.
