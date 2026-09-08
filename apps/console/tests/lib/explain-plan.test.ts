// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  asPlanNode,
  relationsUnder,
  scanOf,
  sortsOnly,
} from "../support/explain-plan";

// The instrument that reads a query plan, tested WITHOUT a database.
//
// The suite that uses it is `describeIfDb`, so on a machine with no `ALETHIA_DATABASE_URL` it never
// runs and CI is the first execution its assertions get. An assertion that reads a plan wrongly
// survives exactly there — never exercised, and when it finally runs it reports a correct
// implementation as broken. These cases are the two plan shapes that were argued about, written out
// as fixtures, so the reader is checked on every pull request instead of on a Postgres that happens
// to be up.

/** A Sort over one relation: the shape a "read the history and dedupe in JS" query produces. */
const sortedHistory = JSON.stringify([
  {
    "QUERY PLAN": [
      {
        "Node Type": "Sort",
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "environment_probes",
          },
        ],
      },
    ],
  },
]);

/**
 * A per-key index lookup under a nested loop, with a merge join ABOVE it sorting two OTHER
 * relations.
 *
 * This is the case the substring form got wrong. `enable_seqscan = off` makes a merge join likelier
 * for the outer join, and the Sort it introduces has nothing to do with how one environment's
 * latest probe is found — but `expect(plan).not.toContain('"Node Type":"Sort"')` reds on it.
 */
const lateralUnderAMergeJoin = JSON.stringify([
  {
    "QUERY PLAN": [
      {
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
      },
    ],
  },
]);

/**
 * The old shape reading the relation THROUGH the ordering index with no Index Cond.
 *
 * The symmetric mistake: asserting the index name is absent from a control plan assumes the old
 * shape cannot touch that index. It cannot use it for the predicate or the ordering — the index
 * leads on `environment_id` and the query has no equality on it — but with sequential scans
 * disabled Postgres may still read the whole relation through it to reach the heap.
 */
const sortedHistoryViaTheIndex = JSON.stringify([
  {
    "QUERY PLAN": [
      {
        "Node Type": "Sort",
        Plans: [
          {
            "Node Type": "Index Scan",
            "Relation Name": "environment_probes",
            "Index Name": "idx_environment_probes_env_time",
          },
        ],
      },
    ],
  },
]);

describe("reading an EXPLAIN plan", () => {
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
    expect(
      relationsUnder(
        asPlanNode(
          JSON.parse(lateralUnderAMergeJoin)[0]["QUERY PLAN"][0].Plans[0]
            .Plans[0],
        ),
      ),
    ).toEqual(new Set(["project_environments", "projects"]));
  });

  it("still sees the index when the old shape happens to read through it", () => {
    // The other half: a control plan CAN carry the index name, so absence of that string is not
    // evidence about the ordering. The sort is.
    expect(sortedHistoryViaTheIndex).toContain(
      "idx_environment_probes_env_time",
    );
    expect(scanOf(sortedHistoryViaTheIndex, "environment_probes")["Index Name"]).toBe(
      "idx_environment_probes_env_time",
    );
  });
});
