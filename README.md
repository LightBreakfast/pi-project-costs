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

### `/project-costs-usage`

Per-branch token & cost report for the **current session**. Shows tokens and costs broken down by branch, sorted by cost descending.

### `/project-costs-stats [--all | --repo]`

Cross-session per-branch aggregation.

- `--repo` (default) — scans all session files for the current git repo
- `--all` — scans session files across **all projects** on your machine, grouped by project

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

## How it works

On every assistant message, the extension records the current git branch along with the message's token usage and cost. Data is stored as custom entries in pi's session files so it survives restarts.

The extension also reads data recorded by the older `branch-tracker` extension, so you won't lose history when upgrading.

## License

MIT
