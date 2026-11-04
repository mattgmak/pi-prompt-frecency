# pi-prompt-frecency

Zoxide-style prompt memory for pi. The extension records prompts you send in pi.
It ranks them by frequency and recency. A fuzzy picker opens on `ctrl+k`.

The picker opens with the composer text as its query. `enter` puts the chosen prompt
back in the composer in place of that text. Tab and shift-tab switch scope.

## How it works

### Capture

`index.ts` listens to the `input` event and records each interactive prompt. Slash
commands, shell lines, and injected prefixes never reach the store. A
`session_start` event starts the index job.

### Index

The first run spawns a detached runtime. It walks every session JSONL file in
`sessionDirs` and fills one global SQLite database. Later runs read only the bytes
past a stored per-file offset. `cli.ts` runs the same indexer on demand.

### Store

`src/db.ts` keeps two tables. `prompts` holds `hash`, `text`, and `first_used`.
`usages` holds `hash`, `scope`, `uses`, `last_used`, and `rank`. One send writes
three rows: `g`, `c:<cwd>`, and `s:<file>`. Any scope query is one indexed lookup.

### Rank

`src/score.ts` ports zoxide scoring. A rank multiplies an age bucket. The bucket is
`4x` under one hour, `2x` under one day, `0.5x` under one week, and `0.25x` for
older rows. `maxAge` caps the total rank of a scope. Past the cap every rank scales
by `0.9 * maxAge / total`, and rows under `1.0` drop.

### Pick

`src/picker.ts` reads `candidateLimit` rows for the active scope. `src/fuzzy.ts`
scores them, and it is a port of the pi-tui fuzzy scorer. The SQL candidate set plus
the JS scorer is the same split zoxide uses.

`fuzzyMatch` returns the index of every matched character, and the picker colors those
columns with the theme accent, the way fzf marks matched characters.

The frame holds the scope line, the query line, the rows, and the key hints between two
rules. `src/theme.ts` holds every color behind one interface, so the picker matches the
active pi theme and falls back to SGR codes without one. Every row starts with a gutter
mark: accent on the selected row, muted on the others. The score column takes only the
width of the widest score, so a short score does not push the text away. The selected
row gets `selectedBg` across the full width, and `esc` and `ctrl+c` both close it.

`index.ts` seeds the query with `seedQuery`, which folds the composer text to one line
and caps it at `maxPromptChars`. A query given on the command line wins over the
composer text.

The query line carries a real text caret, and the block cursor shows its column. `left`,
`right`, `ctrl+b`, and `ctrl+f` move it one character. `home` and `ctrl+e` move it to the
ends. `ctrl+w` and `alt+backspace` cut the word before it, and `alt+d` cuts the word
after it. `ctrl+k` and `ctrl+u` cut to the end and to the start, and `ctrl+y` puts the
last cut back. `backspace`, `ctrl+h`, `delete`, and `ctrl+d` remove one character.

## Install

Add the repo to the pi extensions directory. Pi loads `index.ts` through jiti and
resolves `@earendil-works/pi-tui` from the pi binary. For the NixConfig layout, the
repo lives at `vendor/mattgmak/pi-prompt-frecency` and a thin loader directory in
`dendritic/home-modules/pi-coding-agent/extensions` re-exports it.

## Config

Set `PF_CONFIG` to a JSON file. Otherwise pi reads
`<agentDir>/extensions/pi-prompt-frecency.json`, then `config.json` next to the
entry point. Every key has a default, so an empty file works. `agentDir` comes from
`PI_CODING_AGENT_DIR` and falls back to `~/.pi/agent`.

| Key | Default | Meaning |
| --- | --- | --- |
| `dbPath` | `$XDG_DATA_HOME/pi-prompt-frecency/prompts.db` | SQLite file |
| `sessionDirs` | pi session dir | Directories to index |
| `shortcut` | `ctrl+k` | Key that opens the picker |
| `commandName` | `prompt-frecency` | Slash command name |
| `scopes` | `global`, `cwd`, `session` | Scopes that tab cycles |
| `defaultScope` | `global` | Scope the picker opens on |
| `candidateLimit` | `500` | Rows read from SQL before the fuzzy pass |
| `visibleRows` | `12` | Rows the picker shows at once |
| `minPromptLength` | `4` | Shorter text is not stored |
| `maxPromptChars` | `8000` | Longest stored prompt |
| `maxAge` | `10000` | Total rank budget per scope |
| `dedupeWindowSec` | `5` | Two sends inside this window count once |
| `ignorePatterns` | `*/node_modules/*`, `*/.git/*` | Session files to skip |
| `ignorePrefixes` | `<file name=`, `<system-reminder>`, `<task>`, `<command-name>` | Injected text to skip |
| `excludeCwdPatterns` | none | Working directories to skip |
| `indexOnStart` | `true` | Index on first launch |
| `runtime` | `null` | Runtime for the detached indexer, auto-detected when null |
| `logLevel` | `info` | `info`, `warn`, `error`, or `silent` |
| `logPath` | empty | Log file, empty disables the file log |

## CLI

```sh
node cli.ts index                 # rescan session files now
node cli.ts state                 # index state and per-file cursors
node cli.ts stats                 # row counts per scope
node cli.ts query "commit"        # fuzzy query against the store
node cli.ts add "commit and push" # record one prompt
```

`cli.ts` imports only local files, so it runs on plain node with no install.

## Tests

```sh
npm test
```

`test/` covers `text`, `score`, `fuzzy`, `db`, `scan`, `picker`, and `index` with
`node:test`. The tests use `node:sqlite` and need node 22.6 or newer.
