# pi-project-costs

Track LLM token usage and cost per git branch across pi sessions.

## Quick start

```bash
# Install from GitHub
pi install git:github.com/LightBreakfast/pi-project-costs

# One-shot test (no install)
pi -e ./path/to/pi-project-costs/extensions/pi-project-costs.ts
```

## Commands

### `/project-costs-usage [--by-model]`

Per-branch token and cost report for the current session, sorted by cost descending.

```
/project-costs-usage

  feature/api-v2:
    Total:  12.4k tokens  $0.04  (4 msgs)
  main:
    Total:   3.1k tokens  $0.01  (1 msg)
```

Pass `--by-model` to break each branch down by model:

```
/project-costs-usage --by-model

  feature/api-v2:
    Messages: 4
    Total:    12.4k tokens  $0.04
    ├─ claude-sonnet-4-20250514:  8.2k tokens  $0.03  (3 msgs)
    └─ claude-haiku-4-20250514:   4.2k tokens  $0.01  (1 msg)
  main:
    Messages: 1
    Total:    3.1k tokens  $0.01
    └─ claude-sonnet-4-20250514:  3.1k tokens  $0.01  (1 msg)
```

### `/project-costs-stats [--all | --repo] [--by-model]`

Cross-session aggregation across all saved sessions for the repo.

```
/project-costs-stats --repo

  feature/api-v2:
    Total:  45.2k tokens  $0.15  (14 msgs)
  chore/cleanup:
    Total:   8.7k tokens  $0.03  (5 msgs)
  main:
    Total:   5.1k tokens  $0.02  (2 msgs)
```

Use `--all` to scan every project on the machine, `--by-model` for per-model subtotals.

### `/project-costs-export [--all]`

Export aggregated costs as CSV. Writes `project-costs-<timestamp>.csv` to the current directory.

- Default: current repo only
- `--all`: all projects (adds a project column)

### `/project-costs-footer`

Toggle a real-time footer in the TUI showing the current branch's token usage. Run again to disable.

### `/project-costs-config`

Display the active merged configuration:

```
/project-costs-config

  Enabled:         true
  Git repos only:  true
  Ignore branches: main, master
```

## Configuration

Optional JSON files control tracking behavior. Merge priority: project > global > defaults.

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/pi-project-costs.json` | Global (all projects) |
| `.pi/extensions/pi-project-costs.json` | Project (overrides global) |

### Schema

```jsonc
{
  "enabled": true,         // master switch; set false to stop all tracking
  "gitOnly": true,         // only record inside git repos (avoids "unknown" entries)
  "ignoreBranches": ["main", "master"]  // branch names to skip (default shown)
}
```

All fields are optional and inherit their defaults when omitted.

**Disable tracking for one project:**

```json
// .pi/extensions/pi-project-costs.json
{ "enabled": false }
```

**Track every branch (including main/master):**

```json
{ "ignoreBranches": [] }
```

## How it works

On every assistant message the extension records the current git branch, model, token counts, and cost as a custom entry in pi's session file. Data survives restarts.

## License

MIT
