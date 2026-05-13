/**
 * pi-project-costs Extension
 *
 * Tracks token usage and costs per git branch for any pi session.
 *
 * Features:
 *   • Auto-records the current git branch on every assistant message
 *   • /project-costs-usage  — per-branch token & cost report for the current session
 *   • /project-costs-stats  — per-branch stats across ALL sessions for this repo
 *   • /project-costs-footer — toggle a footer showing current branch usage in real time
 *   • /project-costs-export — export aggregated branch costs as CSV
 *
 * Stored as session custom entries so data survives restarts:
 *   { customType: "project-costs:usage", data: { branch, usage, model, timestamp } }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BranchUsageEntry {
  branch: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  model: string;
  timestamp: number;
  project?: string;
}

interface BranchAggregate {
  tokens: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CUSTOM_TYPE = "project-costs:usage";

/** Run a shell command silently, returning stdout trimmed or null on failure. */
function shell(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

/** Get the current git branch for a working directory. */
function getBranch(cwd: string): string | null {
  return shell("git rev-parse --abbrev-ref HEAD", cwd);
}

/** Resolve the session storage directory for a given cwd. */
function sessionDirFor(cwd: string): string {
  const home = process.env.HOME || "~";
  const encoded = "--" + cwd.replace(/^~/, home).replace(/^\//, "").replace(/\//g, "-") + "--";
  return path.join(home, ".pi", "agent", "sessions", encoded);
}

/** Format a number in a human-friendly way (1.2k, 3.5M, etc). */
function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Format cost, showing 4 decimal places for small values. */
function fmtCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(6)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Extract branch-usage entries from a session's custom entries. */
function extractBranchEntries(entries: any[], project?: string): BranchUsageEntry[] {
  const result: BranchUsageEntry[] = [];
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      (entry.customType === CUSTOM_TYPE || entry.customType === "branch-tracker:usage") &&
      entry.data?.branch &&
      entry.data?.usage
    ) {
      result.push({
        branch: entry.data.branch,
        usage: entry.data.usage,
        model: entry.data.model || "unknown",
        timestamp: entry.data.timestamp || 0,
        project,
      });
    }
  }
  return result;
}

/** Derive a human-readable project name from a session directory path. */
function projectNameFromDir(dirPath: string): string {
  const dirName = path.basename(dirPath);
  const stripped = dirName.replace(/^--|--$/g, "");
  const fullPath = "/" + stripped.replace(/-/g, "/");
  return path.basename(fullPath);
}

/** Parse a session JSONL file and return its custom entries. */
function parseSessionFile(filePath: string): any[] {
  try {
    const raw = readFileSync(filePath, "utf8");
    const entries: any[] = [];
    for (const line of raw.trim().split("\n")) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "custom" || entry.type === "message") entries.push(entry);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Aggregate branch-usage entries into per-branch summaries. */
function aggregateByBranch(entries: BranchUsageEntry[]): Map<string, BranchAggregate> {
  const map = new Map<string, BranchAggregate>();

  for (const e of entries) {
    let agg = map.get(e.branch);
    if (!agg) {
      agg = {
        tokens: 0,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costInput: 0,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0,
        messageCount: 0,
      };
      map.set(e.branch, agg);
    }
    agg.tokens += e.usage.totalTokens ?? 0;
    agg.cost += e.usage.cost?.total ?? 0;
    agg.inputTokens += e.usage.input ?? 0;
    agg.outputTokens += e.usage.output ?? 0;
    agg.cacheReadTokens += e.usage.cacheRead ?? 0;
    agg.cacheWriteTokens += e.usage.cacheWrite ?? 0;
    agg.costInput += e.usage.cost?.input ?? 0;
    agg.costOutput += e.usage.cost?.output ?? 0;
    agg.costCacheRead += e.usage.cost?.cacheRead ?? 0;
    agg.costCacheWrite += e.usage.cost?.cacheWrite ?? 0;
    agg.messageCount++;
  }

  return map;
}

/** Aggregate branch-usage entries grouped by project, then by branch. */
function aggregateByProject(
  entries: BranchUsageEntry[]
): Map<string, Map<string, BranchAggregate>> {
  const projects = new Map<string, Map<string, BranchAggregate>>();

  for (const e of entries) {
    const project = e.project || "(unknown)";
    let branches = projects.get(project);
    if (!branches) {
      branches = new Map();
      projects.set(project, branches);
    }

    let agg = branches.get(e.branch);
    if (!agg) {
      agg = {
        tokens: 0,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costInput: 0,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0,
        messageCount: 0,
      };
      branches.set(e.branch, agg);
    }
    agg.tokens += e.usage.totalTokens ?? 0;
    agg.cost += e.usage.cost?.total ?? 0;
    agg.inputTokens += e.usage.input ?? 0;
    agg.outputTokens += e.usage.output ?? 0;
    agg.cacheReadTokens += e.usage.cacheRead ?? 0;
    agg.cacheWriteTokens += e.usage.cacheWrite ?? 0;
    agg.costInput += e.usage.cost?.input ?? 0;
    agg.costOutput += e.usage.cost?.output ?? 0;
    agg.costCacheRead += e.usage.cost?.cacheRead ?? 0;
    agg.costCacheWrite += e.usage.cost?.cacheWrite ?? 0;
    agg.messageCount++;
  }

  return projects;
}

/** Format a branch aggregate into a display string. */
function formatAggregate(branch: string, agg: BranchAggregate): string {
  return [
    `  ${branch}:`,
    `    Messages:   ${agg.messageCount}`,
    `    Total:      ${fmt(agg.tokens)} tokens  ${fmtCost(agg.cost)}`,
    `    Input:      ${fmt(agg.inputTokens)}  (cache read: ${fmt(agg.cacheReadTokens)} / write: ${fmt(agg.cacheWriteTokens)})`,
    `    Output:     ${fmt(agg.outputTokens)}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CSV Export
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  "project",
  "branch",
  "message_count",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "cost_input",
  "cost_output",
  "cost_cache_read",
  "cost_cache_write",
  "cost_total",
];

/** Escape a CSV field — quote if it contains commas, quotes, or newlines. */
function csvEscape(field: string | number): string {
  const s = String(field);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Write aggregated entries as CSV rows. */
function writeCSV(
  filePath: string,
  entries: { project: string; branch: string; agg: BranchAggregate }[]
): void {
  const lines: string[] = [CSV_HEADERS.join(",")];

  for (const { project, branch, agg } of entries) {
    lines.push(
      [
        csvEscape(project),
        csvEscape(branch),
        agg.messageCount,
        agg.inputTokens,
        agg.outputTokens,
        agg.cacheReadTokens,
        agg.cacheWriteTokens,
        agg.tokens,
        agg.costInput,
        agg.costOutput,
        agg.costCacheRead,
        agg.costCacheWrite,
        agg.cost,
      ].join(",")
    );
  }

  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let footerEnabled = false;

  // =========================================================================
  // 1. Auto-capture branch on every assistant message
  // =========================================================================

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const branch = getBranch(ctx.cwd) || "unknown";

    pi.appendEntry(CUSTOM_TYPE, {
      branch,
      usage: event.message.usage,
      model: `${event.message.provider}/${event.message.model}`,
      timestamp: event.message.timestamp,
    });
  });

  // =========================================================================
  // 2. /project-costs-usage  — per-branch report for the current session
  // =========================================================================

  pi.registerCommand("project-costs-usage", {
    description: "Show token usage and cost per git branch (current session)",
    handler: async (_args, ctx) => {
      const entries = extractBranchEntries(ctx.sessionManager.getEntries());

      if (entries.length === 0) {
        ctx.ui.notify("No project cost tracking data found in this session. Start a conversation first!", "info");
        return;
      }

      const aggregated = aggregateByBranch(entries);

      // Sort by cost descending
      const sorted = [...aggregated.entries()].sort((a, b) => b[1].cost - a[1].cost);

      const currentBranch = getBranch(ctx.cwd) || "unknown";
      const lines: string[] = [
        `╭─ Project Costs (current session) ─`,
        `│ Current branch: ${currentBranch}`,
        `│ Total entries:  ${entries.length}`,
        `├─`,
      ];

      for (const [branch, agg] of sorted) {
        lines.push(formatAggregate(branch, agg));
        lines.push(`│`);
      }

      // Grand total
      const grandTotal = sorted.reduce((s, [, a]) => s + a.tokens, 0);
      const grandCost = sorted.reduce((s, [, a]) => s + a.cost, 0);
      lines.push(`├─`);
      lines.push(`  TOTAL: ${fmt(grandTotal)} tokens  ${fmtCost(grandCost)}`);
      lines.push(`╰─`);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // =========================================================================
  // 3. /project-costs-stats [--all | --repo]  — cross-session aggregation
  // =========================================================================

  pi.registerCommand("project-costs-stats", {
    description: "Show per-branch token usage across sessions. Use --all for all projects, --repo for current repo.",
    handler: async (args, ctx) => {
      const flag = (args || "").trim().toLowerCase();
      const allProjects = flag === "--all";
      const thisRepo = flag === "--repo" || (!allProjects && flag === "");

      let sessionDirs: string[] = [];

      if (allProjects) {
        const base = path.join(process.env.HOME || "~", ".pi", "agent", "sessions");
        if (existsSync(base)) {
          sessionDirs = readdirSync(base, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => path.join(base, d.name));
        }
      } else {
        // Current repo only (default)
        const dir = sessionDirFor(ctx.cwd);
        sessionDirs = [dir];
      }

      if (sessionDirs.length === 0) {
        ctx.ui.notify("No session directories found.", "error");
        return;
      }

      // Collect branch entries from all session files
      const allEntries: BranchUsageEntry[] = [];
      let fileCount = 0;

      for (const dir of sessionDirs) {
        if (!existsSync(dir)) continue;
        const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
        for (const file of files) {
          fileCount++;
          const filePath = path.join(dir, file);
          const rawEntries = parseSessionFile(filePath);
          const project = allProjects ? projectNameFromDir(dir) : undefined;
          const branchEntries = extractBranchEntries(rawEntries, project);
          for (const be of branchEntries) {
            allEntries.push(be);
          }
        }
      }

      if (allEntries.length === 0) {
        ctx.ui.notify(
          `No project cost tracking data found across ${fileCount} session file(s). Make sure the extension was loaded during those sessions.`,
          "info"
        );
        return;
      }

      const lines: string[] = [
        `╭─ Project Costs${allProjects ? " (ALL PROJECTS)" : ""}`,
        `│ Sessions scanned: ${fileCount}`,
        `│ Entries found:    ${allEntries.length}`,
      ];

      if (allProjects) {
        // Grouped by project
        const byProject = aggregateByProject(allEntries);
        let grandTokens = 0, grandCost = 0;

        for (const [project, branches] of byProject) {
          const sorted = [...branches.entries()].sort((a, b) => b[1].cost - a[1].cost);
          const projTokens = sorted.reduce((s, [, a]) => s + a.tokens, 0);
          const projCost = sorted.reduce((s, [, a]) => s + a.cost, 0);
          grandTokens += projTokens;
          grandCost += projCost;

          lines.push(`├─ ${project} ─`);
          for (const [branch, agg] of sorted) {
            lines.push(formatAggregate(branch, agg));
          }
          lines.push(`│  Project total: ${fmt(projTokens)} tokens  ${fmtCost(projCost)}`);
        }

        lines.push(`├─`);
        lines.push(`  GRAND TOTAL: ${fmt(grandTokens)} tokens  ${fmtCost(grandCost)}`);
        lines.push(`╰─`);
      } else {
        // Single repo — flat per-branch
        const aggregated = aggregateByBranch(allEntries);
        const sorted = [...aggregated.entries()].sort((a, b) => b[1].cost - a[1].cost);

        lines.push(`├─`);
        for (const [branch, agg] of sorted) {
          lines.push(formatAggregate(branch, agg));
          lines.push(`│`);
        }

        const grandTotal = sorted.reduce((s, [, a]) => s + a.tokens, 0);
        const grandCost = sorted.reduce((s, [, a]) => s + a.cost, 0);
        lines.push(`├─`);
        lines.push(`  TOTAL: ${fmt(grandTotal)} tokens  ${fmtCost(grandCost)}`);
        lines.push(`╰─`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // =========================================================================
  // 4. /project-costs-footer  — toggle a branch-aware footer in the TUI
  // =========================================================================

  pi.registerCommand("project-costs-footer", {
    description: "Toggle a custom footer that shows current branch token usage",
    handler: async (_args, ctx) => {
      footerEnabled = !footerEnabled;

      if (footerEnabled) {
        ctx.ui.setFooter((tui, theme, footerData) => {
          const unsub = footerData.onBranchChange(() => tui.requestRender());

          return {
            dispose: unsub,
            invalidate() {},
            render(width: number): string[] {
              // Compute per-branch stats from session entries
              const entries = extractBranchEntries(ctx.sessionManager.getEntries());
              const aggregated = aggregateByBranch(entries);

              const branch = footerData.getGitBranch() || "no-git";
              const agg = aggregated.get(branch);

              let left: string;
              let right: string;

              if (agg && agg.messageCount > 0) {
                left = theme.fg(
                  "dim",
                  `↕${fmt(agg.inputTokens)} ↓${fmt(agg.outputTokens)} Σ${fmt(agg.tokens)} ${fmtCost(agg.cost)}`
                );
                right = theme.fg("dim", `${ctx.model?.id || ""} (${branch})`);
              } else {
                // Fallback: show session-wide totals from all assistant messages
                let totalIn = 0, totalOut = 0, totalCost = 0;
                for (const e of ctx.sessionManager.getEntries()) {
                  if (e.type === "message" && (e.message as AssistantMessage).role === "assistant") {
                    const m = e.message as AssistantMessage;
                    totalIn += m.usage?.input ?? 0;
                    totalOut += m.usage?.output ?? 0;
                    totalCost += m.usage?.cost?.total ?? 0;
                  }
                }
                left = theme.fg("dim", `↑${fmt(totalIn)} ↓${fmt(totalOut)} $${totalCost.toFixed(3)}`);
                right = theme.fg("dim", `${ctx.model?.id || ""} (${branch})`);
              }

              const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
              return [truncateToWidth(left + pad + right, width)];
            },
          };
        });
        ctx.ui.notify("Project cost footer enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Default footer restored", "info");
      }
    },
  });

  // =========================================================================
  // 5. /project-costs-export [--all]  — export aggregated costs as CSV
  // =========================================================================

  pi.registerCommand("project-costs-export", {
    description: "Export per-branch project costs as CSV. Use --all for all projects.",
    handler: async (args, ctx) => {
      const flag = (args || "").trim().toLowerCase();
      const allProjects = flag === "--all";

      let sessionDirs: string[] = [];

      if (allProjects) {
        const base = path.join(process.env.HOME || "~", ".pi", "agent", "sessions");
        if (existsSync(base)) {
          sessionDirs = readdirSync(base, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => path.join(base, d.name));
        }
      } else {
        const dir = sessionDirFor(ctx.cwd);
        sessionDirs = [dir];
      }

      if (sessionDirs.length === 0) {
        ctx.ui.notify("No session directories found.", "error");
        return;
      }

      // Collect branch entries from all session files
      const allEntries: BranchUsageEntry[] = [];
      let fileCount = 0;

      for (const dir of sessionDirs) {
        if (!existsSync(dir)) continue;
        const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
        for (const file of files) {
          fileCount++;
          const filePath = path.join(dir, file);
          const rawEntries = parseSessionFile(filePath);
          const project = allProjects ? projectNameFromDir(dir) : path.basename(ctx.cwd);
          const branchEntries = extractBranchEntries(rawEntries, project);
          for (const be of branchEntries) {
            allEntries.push(be);
          }
        }
      }

      if (allEntries.length === 0) {
        ctx.ui.notify(
          `No project cost tracking data found across ${fileCount} session file(s).`,
          "info"
        );
        return;
      }

      // Aggregate and flatten for CSV
      const csvRows: { project: string; branch: string; agg: BranchAggregate }[] = [];

      if (allProjects) {
        const byProject = aggregateByProject(allEntries);
        for (const [project, branches] of byProject) {
          for (const [branch, agg] of branches) {
            csvRows.push({ project, branch, agg });
          }
        }
      } else {
        const aggregated = aggregateByBranch(allEntries);
        const project = path.basename(ctx.cwd);
        for (const [branch, agg] of aggregated) {
          csvRows.push({ project, branch, agg });
        }
      }

      // Sort by cost descending
      csvRows.sort((a, b) => b.agg.cost - a.agg.cost);

      // Generate filename with ISO timestamp
      const now = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const fileName = `project-costs-${now}.csv`;
      const filePath = path.join(ctx.cwd, fileName);

      writeCSV(filePath, csvRows);

      ctx.ui.notify(
        `Exported ${csvRows.length} branch(es) across ${fileCount} session(s) to ${fileName}`,
        "info"
      );
    },
  });
}
