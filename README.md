# pi-project-costs

Track LLM token usage and costs per git branch across pi sessions.

## Installation

### From GitHub

```bash
pi install git:github.com/LightBreakfast/pi-project-costs
```

### From local path (development)

```bash
pi install ./path/to/pi-project-costs
```

### One-shot test (no install)

```bash
pi -e ./path/to/pi-project-costs/extensions/pi-project-costs.ts
```

## Commands

### `/project-costs-usage [--by-model]`

Per-branch token & cost report for the **current session**. Shows tokens and costs broken down by branch, sorted by cost descending.

- `--by-model` — sub-groups each branch by model (e.g. separate lines for `claude-sonnet` vs `claude-opus`)

### `/project-costs-stats [--all | --repo] [--by-model]`

Cross-session per-branch aggregation.

- `--repo` (default) — scans all session files for the current git repo
- `--all` — scans session files across **all projects** on your machine, grouped by project
- `--by-model` — sub-groups each branch by model

### `/project-costs-config`

Display the current merged configuration (global + project).

### `/project-costs-footer`

Toggle a footer in the TUI showing real-time token usage for the current branch. Run again to disable.

### `/project-costs-export [--all]`

Export aggregated per-branch costs as a CSV file. Writes to `project-costs-<timestamp>.csv` in the current working directory.

- Default — current repo only
- `--all` — all projects, with a `project` column to distinguish them

#### CSV Columns

| Column | Description |
|--------|-------------|
| `project` | Project directory name |
| `branch` | Git branch name |
| `message_count` | Number of assistant messages recorded |
| `input_tokens` | Total input tokens |
| `output_tokens` | Total output tokens |
| `cache_read_tokens` | Total cache read tokens |
| `cache_write_tokens` | Total cache write tokens |
| `total_tokens` | Total tokens (input + output + cache_read + cache_write) |
| `cost_input` | Cost of input tokens ($) |
| `cost_output` | Cost of output tokens ($) |
| `cost_cache_read` | Cost of cache read tokens ($) |
| `cost_cache_write` | Cost of cache write tokens ($) |
| `cost_total` | Total cost ($) |

## Configuration

Optional JSON config files control tracking behavior. Merge priority: **project > global > defaults**.

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/pi-project-costs.json` | Global (all projects) |
| `.pi/extensions/pi-project-costs.json` | Project (overrides global) |

### Schema

```jsonc
{
  "enabled": true,         // master switch; set false to disable tracking
  "gitOnly": true,          // only record when cwd is inside a git repo
  "ignoreBranches": []      // branch names to skip (defaults to ["main", "master"])
}
```

All fields are optional. Defaults:

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Disable to stop recording entirely for a project |
| `gitOnly` | `true` | When true, directories with no git repo produce no entries |
| `ignoreBranches` | `["main", "master"]` | Branch names to skip. Set to `[]` to track all branches |

### Example: per-project disable

`.pi/extensions/pi-project-costs.json`:

```json
{ "enabled": false }
```

### Example: track all branches

```json
{ "ignoreBranches": [] }
```

## How it works

On every assistant message, the extension records the current git branch along with the message's token usage and cost. Data is stored as custom entries in pi's session files so it survives restarts.

The extension also reads data recorded by the older `branch-tracker` extension, so you won't lose history when upgrading.

## License

MIT
