/**
 * pi-project-costs Extension
 *
 * Tracks token usage and costs per git branch for any pi session.
 *
 * Features:
 *   • Auto-records the current git branch on every assistant message
 *   • /project-costs usage [--by-model]           — per-branch costs for current session
 *   • /project-costs stats [--all|--repo] [--by-model] — costs across all sessions
 *   • /project-costs export [--all]               — export aggregated costs as CSV
 *   • /project-costs footer                       — toggle real-time branch cost footer
 *   • /project-costs config                       — show current configuration
 *   • /project-costs prune <branch>               — remove entries for a branch
 *   • /project-costs cleanup --before YYYY-MM-DD  — remove entries older than a date
 *
 * Stored as session custom entries so data survives restarts:
 *   { customType: "project-costs:usage", data: { branch, usage, model, timestamp } }
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UsageCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

interface UsageSnapshot {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: UsageCost;
}

interface BranchUsageEntry {
  branch: string;
  usage: UsageSnapshot;
  model: string;
  timestamp: number;
  project?: string;
}

interface SessionCustomEntry {
  type: "custom";
  customType?: string;
  data?: {
    branch?: string;
    usage?: UsageSnapshot;
    model?: string;
    timestamp?: number;
  };
}

type StoredSessionEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
};

interface FooterTuiLike {
  requestRender(): void;
}

interface FooterThemeLike {
  fg(tone: string, value: string): string;
}

interface FooterDataLike {
  onBranchChange(listener: () => void): () => void;
  getGitBranch(): string | null;
}

interface FooterRenderHandle {
  dispose(): void;
  invalidate(): void;
  render(width: number): string[];
}

type FooterFactory = (
  tui: FooterTuiLike,
  theme: FooterThemeLike,
  footerData: FooterDataLike,
) => FooterRenderHandle;

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
// Config
// ---------------------------------------------------------------------------

interface PiProjectCostsConfig {
  enabled?: boolean;
  gitOnly?: boolean;
  ignoreBranches?: string[];
}

interface ResolvedConfig {
  enabled: boolean;
  gitOnly: boolean;
  ignoreBranches: string[];
}

const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  gitOnly: true,
  ignoreBranches: ["main", "master"],
};

/** Read and parse a JSON file, returning null on any failure. */
function readJSON(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** Load merged config: defaults < global < project. */
export function loadConfig(cwd: string): ResolvedConfig {
  const global = readJSON(
    path.join(homedir(), ".pi", "agent", "extensions", "pi-project-costs.json"),
  ) as PiProjectCostsConfig | null;
  const project = readJSON(
    path.join(cwd, ".pi", "extensions", "pi-project-costs.json"),
  ) as PiProjectCostsConfig | null;

  return {
    enabled: project?.enabled ?? global?.enabled ?? DEFAULT_CONFIG.enabled,
    gitOnly: project?.gitOnly ?? global?.gitOnly ?? DEFAULT_CONFIG.gitOnly,
    ignoreBranches:
      project?.ignoreBranches ??
      global?.ignoreBranches ??
      DEFAULT_CONFIG.ignoreBranches,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CUSTOM_TYPE = "project-costs:usage";

function isTrackedCustomEntry(
  entry: StoredSessionEntry,
): entry is SessionCustomEntry {
  return (
    entry.type === "custom" &&
    (entry.customType === CUSTOM_TYPE ||
      entry.customType === "branch-tracker:usage")
  );
}

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
  const encoded =
    "--" +
    cwd.replace(/^~/, home).replace(/^\//, "").replace(/\//g, "-") +
    "--";
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
export function extractBranchEntries(
  entries: StoredSessionEntry[],
  project?: string,
): BranchUsageEntry[] {
  const result: BranchUsageEntry[] = [];
  for (const entry of entries) {
    if (
      isTrackedCustomEntry(entry) &&
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
export function parseSessionFile(filePath: string): StoredSessionEntry[] {
  try {
    const raw = readFileSync(filePath, "utf8");
    const entries: StoredSessionEntry[] = [];
    for (const line of raw.trim().split("\n")) {
      try {
        const entry = JSON.parse(line) as StoredSessionEntry;
        if (entry.type === "custom" || entry.type === "message")
          entries.push(entry);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Read a session JSONL file, apply a filter function to each entry, and write
 * back only the kept entries. Returns { kept: line count written (null on read
 * error), removed: count of removed entries }.
 */
export function filterSessionEntries(
  filePath: string,
  decide: (entry: StoredSessionEntry) => "keep" | "remove",
): { kept: number | null; removed: number } {
  try {
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.trim().split("\n");
    let kept = 0;
    let removed = 0;
    const output: string[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as StoredSessionEntry;
        const action = decide(entry);
        if (action === "remove") {
          removed++;
        } else {
          output.push(line);
          kept++;
        }
      } catch {
        // malformed line — preserve as-is
        output.push(line);
        kept++;
      }
    }

    writeFileSync(
      filePath,
      output.join("\n") + (output.length > 0 ? "\n" : ""),
      "utf8",
    );
    return { kept, removed };
  } catch {
    return { kept: null, removed: 0 };
  }
}

/** Aggregate branch-usage entries into per-branch summaries. */
export function aggregateByBranch(
  entries: BranchUsageEntry[],
): Map<string, BranchAggregate> {
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

/** Aggregate branch-usage entries grouped by branch, then by model. */
function aggregateByBranchAndModel(
  entries: BranchUsageEntry[],
): Map<string, Map<string, BranchAggregate>> {
  const branches = new Map<string, Map<string, BranchAggregate>>();

  for (const e of entries) {
    let models = branches.get(e.branch);
    if (!models) {
      models = new Map();
      branches.set(e.branch, models);
    }

    let agg = models.get(e.model);
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
      models.set(e.model, agg);
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

  return branches;
}

/** Aggregate branch-usage entries grouped by project, then by branch. */
function aggregateByProject(
  entries: BranchUsageEntry[],
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
  entries: { project: string; branch: string; agg: BranchAggregate }[],
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
      ].join(","),
    );
  }

  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let footerEnabled = false;
  let requestFooterRender: (() => void) | undefined;

  function parseArgTokens(args: string): string[] {
    return (args || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  function rejectUnknownFlags(
    tokens: string[],
    allowedFlags: string[],
    usage: string,
    ctx: ExtensionCommandContext,
  ): boolean {
    const unknownFlags = tokens.filter(
      (token) => token.startsWith("--") && !allowedFlags.includes(token),
    );
    if (unknownFlags.length === 0) {
      return false;
    }

    ctx.ui.notify(
      `Unknown option(s): ${unknownFlags.join(", ")}. Usage: ${usage}`,
      "error",
    );
    return true;
  }

  // =========================================================================
  // 1. Auto-capture branch on every assistant message
  // =========================================================================

  pi.on("message_end", async (event, ctx: ExtensionContext) => {
    const message = event.message as AssistantMessage;
    if (message.role !== "assistant" || !message.usage) return;

    const config = loadConfig(ctx.cwd);
    if (!config.enabled) return;

    const branch = getBranch(ctx.cwd);
    if (config.gitOnly && !branch) return;

    const branchName = branch || "unknown";
    if (
      config.ignoreBranches.length > 0 &&
      config.ignoreBranches.some((pattern) => branchName === pattern)
    ) {
      return;
    }

    pi.appendEntry(CUSTOM_TYPE, {
      branch: branchName,
      usage: message.usage,
      model: `${message.provider}/${message.model}`,
      timestamp: message.timestamp,
    });

    requestFooterRender?.();
  });

  async function handleUsage(args: string, ctx: ExtensionCommandContext) {
    const tokens = parseArgTokens(args);
    if (
      rejectUnknownFlags(
        tokens,
        ["--by-model"],
        "/project-costs usage [--by-model]",
        ctx,
      )
    ) {
      return;
    }

    const byModel = tokens.includes("--by-model");

    const entries = extractBranchEntries(ctx.sessionManager.getEntries());

    if (entries.length === 0) {
      ctx.ui.notify(
        "No project cost tracking data found in this session. Start a conversation first!",
        "info",
      );
      return;
    }

    const currentBranch = getBranch(ctx.cwd) || "unknown";
    const lines: string[] = [
      `╭─ Project Costs (current session)${byModel ? " — by model" : ""}`,
      `│ Current branch: ${currentBranch}`,
      `│ Total entries:  ${entries.length}`,
      `├─`,
    ];

    if (byModel) {
      const byBranch = aggregateByBranchAndModel(entries);
      const sortedBranches = [...byBranch.entries()].sort((a, b) => {
        const aCost = [...a[1].values()].reduce((s, m) => s + m.cost, 0);
        const bCost = [...b[1].values()].reduce((s, m) => s + m.cost, 0);
        return bCost - aCost;
      });

      let grandTotal = 0,
        grandCost = 0;
      for (const [branch, models] of sortedBranches) {
        const sortedModels = [...models.entries()].sort(
          (a, b) => b[1].cost - a[1].cost,
        );
        const branchTokens = sortedModels.reduce((s, [, a]) => s + a.tokens, 0);
        const branchCost = sortedModels.reduce((s, [, a]) => s + a.cost, 0);
        grandTotal += branchTokens;
        grandCost += branchCost;

        lines.push(`  ${branch}:`);
        lines.push(
          `    Messages:   ${sortedModels.reduce((s, [, a]) => s + a.messageCount, 0)}`,
        );
        lines.push(
          `    Total:      ${fmt(branchTokens)} tokens  ${fmtCost(branchCost)}`,
        );
        for (const [model, agg] of sortedModels) {
          lines.push(
            `    ├─ ${model}:  ${fmt(agg.tokens)} tokens  ${fmtCost(agg.cost)}  (${agg.messageCount} msgs)`,
          );
        }
        lines.push(`│`);
      }

      lines.push(`├─`);
      lines.push(`  TOTAL: ${fmt(grandTotal)} tokens  ${fmtCost(grandCost)}`);
    } else {
      const aggregated = aggregateByBranch(entries);
      const sorted = [...aggregated.entries()].sort(
        (a, b) => b[1].cost - a[1].cost,
      );

      for (const [branch, agg] of sorted) {
        lines.push(formatAggregate(branch, agg));
        lines.push(`│`);
      }

      const grandTotal = sorted.reduce((s, [, a]) => s + a.tokens, 0);
      const grandCost = sorted.reduce((s, [, a]) => s + a.cost, 0);
      lines.push(`├─`);
      lines.push(`  TOTAL: ${fmt(grandTotal)} tokens  ${fmtCost(grandCost)}`);
    }

    lines.push(`╰─`);

    ctx.ui.notify(lines.join("\n"), "info");
  }

  async function handleStats(args: string, ctx: ExtensionCommandContext) {
    const tokens = parseArgTokens(args);
    if (
      rejectUnknownFlags(
        tokens,
        ["--all", "--repo", "--by-model"],
        "/project-costs stats [--all|--repo] [--by-model]",
        ctx,
      )
    ) {
      return;
    }

    const allProjects = tokens.includes("--all");
    const byModel = tokens.includes("--by-model");

    if (allProjects && tokens.includes("--repo")) {
      ctx.ui.notify("Choose either --all or --repo, not both.", "error");
      return;
    }

    let sessionDirs: string[] = [];

    if (allProjects) {
      const base = path.join(
        process.env.HOME || "~",
        ".pi",
        "agent",
        "sessions",
      );
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
        "info",
      );
      return;
    }

    const lines: string[] = [
      `╭─ Project Costs${allProjects ? " (ALL PROJECTS)" : ""}${byModel ? " — by model" : ""}`,
      `│ Sessions scanned: ${fileCount}`,
      `│ Entries found:    ${allEntries.length}`,
    ];

    if (allProjects) {
      const byProject = aggregateByProject(allEntries);
      let grandTokens = 0,
        grandCost = 0;

      for (const [project, branches] of byProject) {
        const sorted = [...branches.entries()].sort(
          (a, b) => b[1].cost - a[1].cost,
        );
        const projTokens = sorted.reduce((s, [, a]) => s + a.tokens, 0);
        const projCost = sorted.reduce((s, [, a]) => s + a.cost, 0);
        grandTokens += projTokens;
        grandCost += projCost;

        lines.push(`├─ ${project} ─`);

        if (byModel) {
          const projectEntries = allEntries.filter(
            (e) => (e.project || "(unknown)") === project,
          );
          const byBranchAndModel = aggregateByBranchAndModel(projectEntries);
          for (const [branch, models] of [...byBranchAndModel.entries()].sort(
            (a, b) => {
              const aC = [...a[1].values()].reduce((s, m) => s + m.cost, 0);
              const bC = [...b[1].values()].reduce((s, m) => s + m.cost, 0);
              return bC - aC;
            },
          )) {
            const branchTokens = [...models.values()].reduce(
              (s, m) => s + m.tokens,
              0,
            );
            const branchCost = [...models.values()].reduce(
              (s, m) => s + m.cost,
              0,
            );
            lines.push(
              `  ${branch}:  ${fmt(branchTokens)} tokens  ${fmtCost(branchCost)}`,
            );
            for (const [model, agg] of [...models.entries()].sort(
              (a, b) => b[1].cost - a[1].cost,
            )) {
              lines.push(
                `    ├─ ${model}:  ${fmt(agg.tokens)} tokens  ${fmtCost(agg.cost)}  (${agg.messageCount} msgs)`,
              );
            }
          }
        } else {
          for (const [branch, agg] of sorted) {
            lines.push(formatAggregate(branch, agg));
          }
        }

        lines.push(
          `│  Project total: ${fmt(projTokens)} tokens  ${fmtCost(projCost)}`,
        );
      }

      lines.push(`├─`);
      lines.push(
        `  GRAND TOTAL: ${fmt(grandTokens)} tokens  ${fmtCost(grandCost)}`,
      );
      lines.push(`╰─`);
    } else {
      if (byModel) {
        const byBranch = aggregateByBranchAndModel(allEntries);
        const sortedBranches = [...byBranch.entries()].sort((a, b) => {
          const aCost = [...a[1].values()].reduce((s, m) => s + m.cost, 0);
          const bCost = [...b[1].values()].reduce((s, m) => s + m.cost, 0);
          return bCost - aCost;
        });

        lines.push(`├─`);
        let grandTotal = 0,
          grandCost = 0;
        for (const [branch, models] of sortedBranches) {
          const sortedModels = [...models.entries()].sort(
            (a, b) => b[1].cost - a[1].cost,
          );
          const branchTokens = sortedModels.reduce(
            (s, [, a]) => s + a.tokens,
            0,
          );
          const branchCost = sortedModels.reduce((s, [, a]) => s + a.cost, 0);
          grandTotal += branchTokens;
          grandCost += branchCost;

          lines.push(`  ${branch}:`);
          lines.push(
            `    Messages:   ${sortedModels.reduce((s, [, a]) => s + a.messageCount, 0)}`,
          );
          lines.push(
            `    Total:      ${fmt(branchTokens)} tokens  ${fmtCost(branchCost)}`,
          );
          for (const [model, agg] of sortedModels) {
            lines.push(
              `    ├─ ${model}:  ${fmt(agg.tokens)} tokens  ${fmtCost(agg.cost)}  (${agg.messageCount} msgs)`,
            );
          }
          lines.push(`│`);
        }
        lines.push(`├─`);
        lines.push(`  TOTAL: ${fmt(grandTotal)} tokens  ${fmtCost(grandCost)}`);
        lines.push(`╰─`);
      } else {
        const aggregated = aggregateByBranch(allEntries);
        const sorted = [...aggregated.entries()].sort(
          (a, b) => b[1].cost - a[1].cost,
        );

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
    }

    ctx.ui.notify(lines.join("\n"), "info");
  }

  async function handleFooter(args: string, ctx: ExtensionCommandContext) {
    if ((args || "").trim().length > 0) {
      ctx.ui.notify("Usage: /project-costs footer", "error");
      return;
    }

    footerEnabled = !footerEnabled;

    if (footerEnabled) {
      ctx.ui.setFooter(
        (
          tui: FooterTuiLike,
          theme: FooterThemeLike,
          footerData: FooterDataLike,
        ) => {
          requestFooterRender = () => tui.requestRender();
          const unsub = footerData.onBranchChange(() => tui.requestRender());

          return {
            dispose() {
              requestFooterRender = undefined;
              unsub();
            },
            invalidate() {},
            render(width: number): string[] {
              const entries = extractBranchEntries(
                ctx.sessionManager.getEntries(),
              );
              const aggregated = aggregateByBranch(entries);

              const branch = footerData.getGitBranch() || "no-git";
              const agg = aggregated.get(branch);

              let left: string;
              let right: string;

              if (agg && agg.messageCount > 0) {
                left = theme.fg(
                  "dim",
                  `↕${fmt(agg.inputTokens)} ↓${fmt(agg.outputTokens)} Σ${fmt(agg.tokens)} ${fmtCost(agg.cost)}`,
                );
                right = theme.fg("dim", `${ctx.model?.id || ""} (${branch})`);
              } else {
                let totalIn = 0,
                  totalOut = 0,
                  totalCost = 0;
                for (const e of ctx.sessionManager.getEntries()) {
                  if (
                    e.type === "message" &&
                    (e.message as AssistantMessage).role === "assistant"
                  ) {
                    const m = e.message as AssistantMessage;
                    totalIn += m.usage?.input ?? 0;
                    totalOut += m.usage?.output ?? 0;
                    totalCost += m.usage?.cost?.total ?? 0;
                  }
                }
                left = theme.fg(
                  "dim",
                  `↑${fmt(totalIn)} ↓${fmt(totalOut)} $${totalCost.toFixed(3)}`,
                );
                right = theme.fg("dim", `${ctx.model?.id || ""} (${branch})`);
              }

              const pad = " ".repeat(
                Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
              );
              return [truncateToWidth(left + pad + right, width)];
            },
          };
        },
      );
      ctx.ui.notify("Project cost footer enabled", "info");
    } else {
      requestFooterRender = undefined;
      ctx.ui.setFooter(undefined);
      ctx.ui.notify("Default footer restored", "info");
    }
  }

  async function handleExport(args: string, ctx: ExtensionCommandContext) {
    const tokens = parseArgTokens(args);
    if (
      rejectUnknownFlags(
        tokens,
        ["--all"],
        "/project-costs export [--all]",
        ctx,
      )
    ) {
      return;
    }

    const allProjects = tokens.includes("--all");

    let sessionDirs: string[] = [];

    if (allProjects) {
      const base = path.join(
        process.env.HOME || "~",
        ".pi",
        "agent",
        "sessions",
      );
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

    const allEntries: BranchUsageEntry[] = [];
    let fileCount = 0;

    for (const dir of sessionDirs) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      for (const file of files) {
        fileCount++;
        const filePath = path.join(dir, file);
        const rawEntries = parseSessionFile(filePath);
        const project = allProjects
          ? projectNameFromDir(dir)
          : path.basename(ctx.cwd);
        const branchEntries = extractBranchEntries(rawEntries, project);
        for (const be of branchEntries) {
          allEntries.push(be);
        }
      }
    }

    if (allEntries.length === 0) {
      ctx.ui.notify(
        `No project cost tracking data found across ${fileCount} session file(s).`,
        "info",
      );
      return;
    }

    const csvRows: { project: string; branch: string; agg: BranchAggregate }[] =
      [];

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

    csvRows.sort((a, b) => b.agg.cost - a.agg.cost);

    const now = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileName = `project-costs-${now}.csv`;
    const filePath = path.join(ctx.cwd, fileName);

    writeCSV(filePath, csvRows);

    ctx.ui.notify(
      `Exported ${csvRows.length} branch(es) across ${fileCount} session(s) to ${fileName}`,
      "info",
    );
  }

  async function handleConfig(args: string, ctx: ExtensionCommandContext) {
    const config = loadConfig(ctx.cwd);
    const lines = [
      `╭─ Project Costs Config`,
      `│ Enabled:          ${config.enabled}`,
      `│ Git repos only:   ${config.gitOnly}`,
      `│ Ignore branches:  ${config.ignoreBranches.join(", ") || "(none)"}`,
      `╰─`,
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  }

  async function handlePrune(args: string, ctx: ExtensionCommandContext) {
    const branch = (args || "").trim();
    if (!branch) {
      ctx.ui.notify("Usage: /project-costs prune <branch-name>", "error");
      return;
    }

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      ctx.ui.notify("No session file (in-memory session).", "error");
      return;
    }

    const { kept, removed } = filterSessionEntries(sessionFile, (entry) => {
      if (!isTrackedCustomEntry(entry)) return "keep";
      if (entry.data?.branch === branch) return "remove";
      return "keep";
    });

    if (kept === null) {
      ctx.ui.notify("Could not read session file.", "error");
      return;
    }

    if (removed === 0) {
      ctx.ui.notify(
        `No entries found for branch "${branch}" in this session.`,
        "info",
      );
      return;
    }

    ctx.ui.notify(
      `Removed ${removed} entry(s) for branch "${branch}" from the current session.`,
      "info",
    );
  }

  async function handleCleanup(args: string, ctx: ExtensionCommandContext) {
    const raw = (args || "").trim();
    const match = raw.match(/^--before\s+(\d{4}-\d{2}-\d{2})$/);
    if (!match) {
      ctx.ui.notify(
        "Usage: /project-costs cleanup --before YYYY-MM-DD",
        "error",
      );
      return;
    }

    const cutoff = new Date(match[1]).getTime();
    if (isNaN(cutoff)) {
      ctx.ui.notify("Invalid date. Use YYYY-MM-DD format.", "error");
      return;
    }

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      ctx.ui.notify("No session file (in-memory session).", "error");
      return;
    }

    const { kept, removed } = filterSessionEntries(sessionFile, (entry) => {
      if (!isTrackedCustomEntry(entry)) return "keep";
      const ts = entry.data?.timestamp ?? 0;
      if (ts > 0 && ts < cutoff) return "remove";
      return "keep";
    });

    if (kept === null) {
      ctx.ui.notify("Could not read session file.", "error");
      return;
    }

    if (removed === 0) {
      ctx.ui.notify(
        `No entries before ${match[1]} found in this session.`,
        "info",
      );
      return;
    }

    ctx.ui.notify(
      `Removed ${removed} entry(s) older than ${match[1]} from the current session.`,
      "info",
    );
  }

  async function handleHelp(ctx: ExtensionCommandContext) {
    const lines = [
      `╭─ Project Costs — subcommands`,
      `│ usage [--by-model]           Show costs for current session`,
      `│ stats [--all|--repo] [--by-model]  Show costs across sessions`,
      `│ export [--all]               Export costs as CSV`,
      `│ footer                       Toggle branch cost footer`,
      `│ config                       Show current configuration`,
      `│ prune <branch>               Remove entries for a branch`,
      `│ cleanup --before YYYY-MM-DD  Remove entries older than a date`,
      `│ help                         Show this message`,
      `╰─`,
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  }

  // =========================================================================
  // Single /project-costs dispatcher
  // =========================================================================

  pi.registerCommand("project-costs", {
    description:
      "Track LLM token usage and costs per git branch. Use /project-costs help for subcommands.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const parts = (_args || "").trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "help";
      const subArgs = parts.slice(1).join(" ");

      switch (subcommand) {
        case "usage":
          return handleUsage(subArgs, ctx);
        case "stats":
          return handleStats(subArgs, ctx);
        case "export":
          return handleExport(subArgs, ctx);
        case "footer":
          return handleFooter(subArgs, ctx);
        case "config":
          return handleConfig(subArgs, ctx);
        case "prune":
          return handlePrune(subArgs, ctx);
        case "cleanup":
          return handleCleanup(subArgs, ctx);
        case "help":
          return handleHelp(ctx);
        default:
          ctx.ui.notify(
            `Unknown subcommand "${subcommand}". Use /project-costs help for available commands.`,
            "error",
          );
      }
    },
  });

  // =========================================================================

  // =========================================================================
}
