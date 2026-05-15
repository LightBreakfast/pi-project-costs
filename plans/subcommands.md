# Plan: Refactor to `/project-costs` subcommands

## Goal

Replace 8 separate commands (`/project-costs-usage`, `/project-costs-stats`, etc.) with a single `/project-costs` command dispatching to subcommands (e.g. `/project-costs usage`, `/project-costs stats --by-model`).

## Approach

1. Extract each handler body into a standalone `async function handleX(args, ctx)` — placed in a block between `message_end` hook and the command registration sections.
2. Replace all 8 `pi.registerCommand(...)` calls with a single `pi.registerCommand("project-costs", ...)` that parses the first token and dispatches via a `switch`.
3. Add a `help` subcommand listing available options — bare `/project-costs` defaults to help.
4. Update the file header comment and README.

## Benefits

- Discoverable: `/project-costs help` shows everything
- Clean: no command-name prefix repetition
- Extensible: adding a subcommand is one handler function + one `case`

## Files to modify

- `extensions/pi-project-costs.ts`
- `README.md`

## Steps

- [ ] 1. Ensure we're on `refactor/subcommands` branch

### Step 2 — Insert handler functions (one per subcommand)
Inserted between the `message_end` hook (`});` at line 482) and the section 2 comment.
- [ ] 2a. Insert `handleUsage(args, ctx)` function
- [ ] 2b. Insert `handleStats(args, ctx)` function
- [ ] 2c. Insert `handleFooter(args, ctx)` function
- [ ] 2d. Insert `handleExport(args, ctx)` function
- [ ] 2e. Insert `handleConfig(args, ctx)` function
- [ ] 2f. Insert `handlePrune(args, ctx)` function
- [ ] 2g. Insert `handleCleanup(args, ctx)` function

### Step 3 — Replace separate registrations with single dispatcher
- [ ] 3a. Add the single `pi.registerCommand("project-costs", ...)` dispatcher with switch statement + `handleHelp`
- [ ] 3b. Remove `pi.registerCommand("project-costs-usage", ...)` block
- [ ] 3c. Remove `pi.registerCommand("project-costs-stats", ...)` block
- [ ] 3d. Remove `pi.registerCommand("project-costs-footer", ...)` block
- [ ] 3e. Remove `pi.registerCommand("project-costs-export", ...)` block
- [ ] 3f. Remove `pi.registerCommand("project-costs-config", ...)` block
- [ ] 3g. Remove `pi.registerCommand("project-costs-prune", ...)` block
- [ ] 3h. Remove `pi.registerCommand("project-costs-cleanup", ...)` block

### Step 4 — Documentation
- [ ] 4a. Update file header comment (8 commands → `/project-costs` with subcommands)
- [ ] 4b. Update README.md with new subcommand syntax

### Step 5 — Finalize
- [ ] 5a. Commit, merge to main, push, clean up branch

## Verification

- `/project-costs` → shows help
- `/project-costs help` → shows help
- `/project-costs usage` → same output as old `/project-costs-usage`
- `/project-costs usage --by-model` → model breakdown
- `/project-costs stats --all` → cross-project stats
- `/project-costs config` → config display
- `/project-costs prune foo` → prune entries
- `/project-costs cleanup --before 2026-01-01` → cleanup
- `/project-costs export --all` → export
- `/project-costs footer` → toggle footer
- `/project-costs nonsense` → unknown subcommand error
