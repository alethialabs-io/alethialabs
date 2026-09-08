// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import realLateralPlan from "../fixtures/explain-lateral-probe-plan.json";
import {
  asPlanNode,
  relationsUnder,
  scanOf,
  sortsOnly,
} from "../support/explain-plan";

// The instrument that reads a query plan, tested WITHOUT a database.
//
// The suite that uses it is `describeIfDb`, so on a machine with no `ALETHIA_DATABASE_URL` it does
// not run and CI is the first execution its assertions ever get. That is where an assertion which
// reads a plan wrongly survives: never exercised, and when it finally runs it reports a correct
// implementation as broken.
//
// ── WHY THE FIRST FIXTURE IS VERBATIM, AND WHY THAT IS THE WHOLE LESSON ───────────────────────
//
// The first version of this file had six hand-written fixtures shaped `"QUERY PLAN": [{"Node
// Type": "Sort", …}]` — the plan node placed directly in the array. Postgres never emits that. Each
// element is an ENVELOPE whose root node hangs under a `Plan` key, beside `Planning Time` and
// friends. So six offline cases passed on every run while the first real execution threw, and the
// suite was checking the wrong thing quickly instead of the right thing slowly — the exact failure
// moving it offline was meant to prevent.
//
// `explain-lateral-probe-plan.json` is therefore the REAL output, taken verbatim from the run that
// caught this, and it leads. The synthetic cases below still earn their place — they reach shapes a
// single real plan does not contain — but they are wrapped through `asExplainOutput`, so the
// envelope has exactly one definition and cannot drift away from the real one again.

/** One synthetic plan tree, wrapped in the envelope `EXPLAIN (FORMAT JSON)` actually returns. */
function asExplainOutput(root: unknown): string {
  return JSON.stringify([
    {
      "QUERY PLAN": [
        { Plan: root, "Planning Time": 0.2, Triggers: [], "Execution Time": 0.1 },
      ],
    },
  ]);
}

/** A Sort over one relation: the shape a "read the history and dedupe in JS" query produces. */
const sortedHistory = asExplainOutput({
  "Node Type": "Sort",
  Plans: [{ "Node Type": "Seq Scan", "Relation Name": "environment_probes" }],
});

/**
 * A per-key index lookup under a nested loop, with a merge join ABOVE it sorting two OTHER
 * relations.
 *
 * The case the substring form got wrong. `enable_seqscan = off` makes a merge join likelier for the
 * outer join, and the Sort it introduces has nothing to do with how one environment's latest probe
 * is found — but `expect(plan).not.toContain('"Node Type":"Sort"')` reds on it.
 */
const lateralUnderAMergeJoin = asExplainOutput({
  "Node Type": "Nested Loop",
  Plans: [
    {
      "Node Type": "Merge Join",
      Plans: [
        {
          "Node Type": "Sort",
          Plans: [
            {
              "Node Type": "Index Scan",
              "Relation Name": "project_environments",
              "Index Name": "idx_project_environments_project",
            },
            {
              "Node Type": "Index Scan",
              "Relation Name": "projects",
              "Index Name": "projects_pkey",
            },
          ],
        },
      ],
    },
    {
      "Node Type": "Limit",
      Plans: [
        {
          "Node Type": "Index Scan",
          "Relation Name": "environment_probes",
          "Index Name": "idx_environment_probes_env_time",
        },
      ],
    },
  ],
});

/**
 * The old shape reading the relation THROUGH the ordering index with no Index Cond.
 *
 * The symmetric mistake: asserting the index name is absent from a control plan assumes the old
 * shape cannot touch that index. It cannot use it for the predicate or the ordering — the index
 * leads on `environment_id` and the query has no equality on it — but with sequential scans
 * disabled Postgres may still read the whole relation through it to reach the heap.
 */
const sortedHistoryViaTheIndex = asExplainOutput({
  "Node Type": "Sort",
  Plans: [
    {
      "Node Type": "Index Scan",
      "Relation Name": "environment_probes",
      "Index Name": "idx_environment_probes_env_time",
    },
  ],
});

describe("reading a real EXPLAIN plan", () => {
  const real = JSON.stringify(realLateralPlan);

  it("unwraps the Plan envelope rather than walking it", () => {
    // The regression, stated as the thing that failed: this threw `not a plan node: {"Plan":…}`.
    const scan = scanOf(real, "environment_probes");
    expect(scan["Node Type"]).toBe("Index Scan");
    expect(scan["Index Name"]).toBe("idx_environment_probes_env_time");
  });

  it("is the plan the optimisation claims — one index lookup per environment, no sort", () => {
    expect(sortsOnly(real, "environment_probes")).toBe(false);
    // And the outer join really is in there, so the absence above is a measurement of the probe
    // access rather than of a plan too small to contain anything.
    expect(scanOf(real, "project_environments")["Node Type"]).toBe("Index Scan");
    expect(scanOf(real, "projects")["Index Name"]).toBe("projects_pkey");
  });

  it("refuses an element with no Plan key, which is how the shape came back wrong", () => {
    // The shape the hand-written fixtures used, and the one Postgres does not emit. It must be an
    // error rather than something the reader tolerates, or the original defect returns silently.
    const bare = JSON.stringify([
      { "QUERY PLAN": [{ "Node Type": "Seq Scan", "Relation Name": "x" }] },
    ]);
    expect(() => scanOf(bare, "x")).toThrow(/no "Plan" key/);
  });
});

describe("reading a synthetic EXPLAIN plan", () => {
  it("finds the node that reads a relation, wherever it sits in the tree", () => {
    const scan = scanOf(lateralUnderAMergeJoin, "environment_probes");
    expect(scan["Index Name"]).toBe("idx_environment_probes_env_time");
    expect(scan["Node Type"]).toBe("Index Scan");
  });

  it("names what the plan did read when the relation is absent", () => {
    expect(() => scanOf(sortedHistory, "project_environments")).toThrow(
      /environment_probes/,
    );
  });

  it("refuses a document that is not a plan rather than reading undefined out of it", () => {
    expect(() => scanOf("[]", "environment_probes")).toThrow(/empty EXPLAIN/);
    expect(() => asPlanNode({ foo: 1 })).toThrow(/not a plan node/);
    expect(() => asPlanNode({ "Node Type": 7 })).toThrow(/no string/);
  });

  it("reports a sort of the relation's own history", () => {
    expect(sortsOnly(sortedHistory, "environment_probes")).toBe(true);
    expect(sortsOnly(sortedHistoryViaTheIndex, "environment_probes")).toBe(true);
  });

  it("does NOT report a sort that belongs to the outer join", () => {
    // The case the substring form got wrong. A Sort is present, and it reads two other relations.
    expect(lateralUnderAMergeJoin).toContain('"Node Type":"Sort"');
    expect(sortsOnly(lateralUnderAMergeJoin, "environment_probes")).toBe(false);
    // And it is genuinely a sort of something — the assertion above is not passing because the
    // walker failed to find any Sort at all.
    expect(sortsOnly(lateralUnderAMergeJoin, "project_environments")).toBe(
      false,
    );
    const mergeSort = scanOf(lateralUnderAMergeJoin, "project_environments");
    expect(mergeSort["Node Type"]).toBe("Index Scan");
    expect(relationsUnder(asPlanNode(mergeSort))).toEqual(
      new Set(["project_environments"]),
    );
  });

  it("still sees the index when the old shape happens to read through it", () => {
    // The other half: a control plan CAN carry the index name, so absence of that string is not
    // evidence about the ordering. The sort is.
    expect(sortedHistoryViaTheIndex).toContain(
      "idx_environment_probes_env_time",
    );
    expect(
      scanOf(sortedHistoryViaTheIndex, "environment_probes")["Index Name"],
    ).toBe("idx_environment_probes_env_time");
  });
});
