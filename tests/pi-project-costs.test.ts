import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  aggregateByBranch,
  extractBranchEntries,
  filterSessionEntries,
  parseSessionFile,
} from "../extensions/pi-project-costs.ts";

test("extractBranchEntries keeps both current and legacy custom entry types", () => {
  const entries = extractBranchEntries(
    [
      {
        type: "custom",
        customType: "project-costs:usage",
        data: {
          branch: "feature/api",
          usage: {
            input: 100,
            output: 25,
            totalTokens: 125,
            cost: { total: 0.12 },
          },
          model: "anthropic/claude-sonnet",
          timestamp: 1,
        },
      },
      {
        type: "custom",
        customType: "branch-tracker:usage",
        data: {
          branch: "main",
          usage: {
            input: 50,
            output: 10,
            totalTokens: 60,
            cost: { total: 0.03 },
          },
          model: "openai/gpt-4.1",
          timestamp: 2,
        },
      },
      {
        type: "custom",
        customType: "unrelated",
        data: {
          branch: "ignored",
        },
      },
    ],
    "pi-project-costs",
  );

  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => ({
      branch: entry.branch,
      model: entry.model,
      project: entry.project,
    })),
    [
      {
        branch: "feature/api",
        model: "anthropic/claude-sonnet",
        project: "pi-project-costs",
      },
      {
        branch: "main",
        model: "openai/gpt-4.1",
        project: "pi-project-costs",
      },
    ],
  );
});

test("aggregateByBranch sums tokens, costs, and message count", () => {
  const aggregated = aggregateByBranch([
    {
      branch: "feature/api",
      model: "anthropic/claude-sonnet",
      timestamp: 1,
      usage: {
        input: 100,
        output: 25,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 140,
        cost: {
          input: 0.05,
          output: 0.04,
          cacheRead: 0.01,
          cacheWrite: 0.02,
          total: 0.12,
        },
      },
    },
    {
      branch: "feature/api",
      model: "anthropic/claude-haiku",
      timestamp: 2,
      usage: {
        input: 30,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 50,
        cost: {
          input: 0.01,
          output: 0.02,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.03,
        },
      },
    },
  ]);

  const feature = aggregated.get("feature/api");
  assert.ok(feature);
  assert.equal(feature.messageCount, 2);
  assert.equal(feature.tokens, 190);
  assert.equal(feature.inputTokens, 130);
  assert.equal(feature.outputTokens, 45);
  assert.equal(feature.cacheReadTokens, 10);
  assert.equal(feature.cacheWriteTokens, 5);
  assert.equal(feature.cost, 0.15);
});

test("filterSessionEntries removes tracked entries and preserves malformed lines", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-project-costs-"));
  const sessionFile = path.join(dir, "session.jsonl");

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: "custom",
        customType: "project-costs:usage",
        data: { branch: "feature/api", timestamp: 1 },
      }),
      "not-json",
      JSON.stringify({
        type: "custom",
        customType: "project-costs:usage",
        data: { branch: "main", timestamp: 2 },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const result = filterSessionEntries(sessionFile, (entry) => {
    if (
      entry.type === "custom" &&
      entry.customType === "project-costs:usage" &&
      typeof entry.data === "object" &&
      entry.data !== null &&
      "branch" in entry.data &&
      entry.data.branch === "feature/api"
    ) {
      return "remove";
    }

    return "keep";
  });

  assert.deepEqual(result, { kept: 2, removed: 1 });

  const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "not-json");

  const parsedEntries = parseSessionFile(sessionFile);
  assert.equal(parsedEntries.length, 1);
  assert.equal(parsedEntries[0].type, "custom");
});
