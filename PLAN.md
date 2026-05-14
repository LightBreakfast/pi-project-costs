# Plan: pi-project-costs config + enhancements

## Context

The pi-project-costs extension currently has no config — it always tracks all assistant messages across all directories. Two usability issues and two feature gaps:

- **gitOnly**: tracking outside git repos (e.g. `~/`) produces useless `"unknown"` branch entries
- **Per-project disable**: no way to turn it off for specific projects
- **Per-model breakdown**: model is captured per-entry but never surfaced. Add an optional `--by-model` flag to `/project-costs-usage` and `/project-costs-stats` to group by model within each branch (default stays unchanged)
- **Ignore branches**: hopping to `main` for a quick lookup pollutes the report

## Approach

Add a JSON config file following the same pattern as guardrails (`ConfigLoader`-style with global + project scopes), then wire the four new behaviors into the extension.

## Config schema

```jsonc
{
  "enabled": true,           // master switch (project-level override)
  "gitOnly": true,           // skip tracking when cwd is not a git repo
  "ignoreBranches": []       // branch name patterns to skip (glob or exact)
                             // default: ["main", "master"]
}
```

**Locations (merge priority: project > global):**
- Global: `~/.pi/agent/extensions/pi-project-costs.json`
- Project: `.pi/extensions/pi-project-costs.json`

## Files to modify

- `extensions/pi-project-costs.ts` — add config loading, wire config into message_end hook and commands
- `README.md` — document new config file (locations, schema, defaults), new `--by-model` flag, and `/project-costs-config` command
- `.gitignore` — tighten up (see below)

## Reuse

- Config pattern from `@aliou/pi-guardrails` (`ConfigLoader` from `@aliou/pi-utils-settings`) — but that's a guardrails internal dependency. For cleanliness, roll a minimal inline config reader (read JSON, merge top-level keys, no migrations needed yet).
- Existing helpers: `getBranch()`, `extractBranchEntries()`, `aggregateByBranch()`, `formatAggregate()`

## Steps

- [ ] 1. Add config types and loader (read/merge global + project JSON, apply defaults)
- [ ] 2. Wire `enabled` and `gitOnly` into the `message_end` hook — skip entry if disabled or not a git repo
- [ ] 3. Wire `ignoreBranches` into the `message_end` hook — skip entry if branch matches
- [ ] 4. Add `aggregateByBranchAndModel()` helper — group entries by branch then model
- [ ] 5. Add `--by-model` flag to `/project-costs-usage` — default unchanged, flag enables model sub-grouping
- [ ] 6. Add `--by-model` flag to `/project-costs-stats` — same behavior
- [ ] 7. Add `/project-costs-config` helper command to show current config
- [ ] 8. Update README.md — document config file locations, schema, `--by-model` flag, `/project-costs-config`
- [ ] 9. Review and tighten `.gitignore`

## Config implementation detail

No dependency on `@aliou/pi-utils-settings` — use a simple read/merge:

```ts
function loadConfig(cwd: string): ResolvedConfig {
  const defaults = { enabled: true, gitOnly: true, ignoreBranches: ["main", "master"] };
  const global = readJSON("~/.pi/agent/extensions/pi-project-costs.json");
  const project = readJSON(".pi/extensions/pi-project-costs.json");
  return { ...defaults, ...global, ...project };
}
```

Config is read fresh on each `message_end` (lightweight — just two file reads, no watchers needed).

## Per-model breakdown approach

Default output stays unchanged. When `--by-model` is passed to `/project-costs-usage` or `/project-costs-stats`, add a sub-grouping by model within each branch:

```
  my-feature:
    Messages:   12
    Total:      45.2k tokens  $0.23
    ├─ claude-sonnet-4-20250514:  30.1k tokens  $0.15  (8 msgs)
    └─ claude-opus-4-20250514:   15.1k tokens  $0.08  (4 msgs)
```

Requires a new `aggregateByBranchAndModel()` returning `Map<string, Map<string, BranchAggregate>>`, wired behind the flag.

## .gitignore improvements

Current is minimal (`node_modules/`, `.DS_Store`, `*.log`, `*.csv`). Add:

- `.pi/` — project-local pi config and sessions (not for version control)
- `*.tsbuildinfo` — TypeScript incremental build artifacts
- Keep existing: `node_modules/`, `.DS_Store`, `*.log`, `*.csv`

## Verification

Run from the feature branch, loading the extension via `pi -e`:

1. `/project-costs-usage` → see default per-branch report (should show the feature branch)
2. Create `.pi/extensions/pi-project-costs.json` with `"enabled": false` → verify no new entries recorded
3. `cd ~` and start a session → verify no entries with `"gitOnly": true`
4. Add `"ignoreBranches": ["main"]` → switch to main, send a message, verify no main entries appear in report
5. `/project-costs-usage --by-model` → verify model sub-grouping appears
6. `/project-costs-usage` (no flag) → verify default output unchanged
7. `/project-costs-config` → verify it shows merged config from global + project
8. Switch back to the feature branch, verify entries are being recorded again
