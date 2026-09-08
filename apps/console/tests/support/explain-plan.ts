// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

// Reading an `EXPLAIN (FORMAT JSON)` plan, for tests that assert a query's SHAPE rather than its
// result.
//
// WHY THIS IS A MODULE AND NOT FOUR LINES IN THE SUITE THAT USES IT. The suite is `describeIfDb`,
// so on a machine with no `ALETHIA_DATABASE_URL` it does not run at all and CI is the first
// execution its assertions ever get. That is precisely where an assertion that reads a plan wrongly
// survives: it is never exercised, and when it finally runs it reports a real implementation as
// broken, or a broken one as fine. Here the reading is separated from the database and pinned by
// `tests/lib/explain-plan.test.ts` against synthetic plans, which need no Postgres and run on every
// pull request.
//
// WHY NOT A SUBSTRING MATCH OVER THE SERIALIZED PLAN, which is what this replaced. It answers a
// different question than the one the caller asks. `expect(plan).not.toContain('"Node Type":"Sort"')`
// matches the WHOLE tree, so a merge join the outer query chooses — and `enable_seqscan = off`
// makes that likelier — introduces a Sort that has nothing to do with the node under test, and a
// correct implementation reds. The symmetric mistake is worse: asserting an index name is ABSENT
// from a control plan assumes the old shape cannot touch that index, when with sequential scans
// disabled Postgres may read the relation through it with no Index Cond at all, purely as a way to
// reach the heap.

/** The `EXPLAIN (FORMAT JSON)` envelope. Parsed, not cast — the plan tree itself stays opaque. */
export const explainSchema = z.array(
  z.object({ "QUERY PLAN": z.array(z.unknown()) }),
);

/**
 * One node of a plan tree, narrowed only where these helpers read it.
 *
 * The three optional fields are Postgres guarantees where they apply: a scan node carries
 * `Relation Name`, an index scan carries `Index Name`, and children hang off `Plans`.
 */
export interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

/**
 * Narrows an unknown plan node by CHECKING it rather than asserting it.
 *
 * `as` is banned repo-wide and this is one of the cases the ban exists for: a cast would let a
 * changed EXPLAIN shape read as `undefined` everywhere and turn every assertion below into a
 * vacuous pass. A throw names the node instead.
 */
export function asPlanNode(value: unknown): PlanNode {
  if (typeof value !== "object" || value === null || !("Node Type" in value)) {
    throw new Error(`not a plan node: ${JSON.stringify(value)}`);
  }
  const node: Record<string, unknown> = { ...value };
  const type = node["Node Type"];
  if (typeof type !== "string") {
    throw new Error(
      `plan node has no string "Node Type": ${JSON.stringify(value)}`,
    );
  }
  const relation = node["Relation Name"];
  const index = node["Index Name"];
  const children = Array.isArray(node.Plans)
    ? node.Plans.map(asPlanNode)
    : undefined;
  return {
    "Node Type": type,
    "Relation Name": typeof relation === "string" ? relation : undefined,
    "Index Name": typeof index === "string" ? index : undefined,
    Plans: children,
  };
}

/** Every node in the subtree rooted at `node`, itself included. */
export function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

/** The set of relations any node in this subtree reads. */
export function relationsUnder(node: PlanNode): Set<string> {
  return new Set(
    planNodes(node)
      .map((n) => n["Relation Name"])
      .filter((name): name is string => typeof name === "string"),
  );
}

/**
 * The root plan node of one `QUERY PLAN` element.
 *
 * ⚠ THE ROOT HANGS UNDER A `Plan` KEY, and getting this wrong is what shipped: each element is an
 * ENVELOPE — `{"Plan": {...}, "Planning Time": 0.283, "Triggers": [], "Execution Time": 0.061}` —
 * not the node itself. The first version walked the envelope, found no `Node Type` on it and threw
 * on the first real plan it ever saw, while six hand-written fixtures asserting a shape Postgres
 * never emits went green on every run. The throw did its job; the fixtures did not.
 *
 * Required rather than optional. An element with no `Plan` is a shape change and must be loud —
 * falling back to treating the element as a node is exactly how the original defect would return.
 */
function rootOf(element: unknown): PlanNode {
  if (typeof element !== "object" || element === null || !("Plan" in element)) {
    throw new Error(
      `EXPLAIN element has no "Plan" key — the root node hangs under it: ${JSON.stringify(element)}`,
    );
  }
  const envelope: Record<string, unknown> = { ...element };
  return asPlanNode(envelope.Plan);
}

/** Every node of every root in a serialized `EXPLAIN (FORMAT JSON)` document. */
function allNodes(plan: string): PlanNode[] {
  const parsed: unknown = JSON.parse(plan);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`empty EXPLAIN output: ${plan}`);
  }
  return explainSchema
    .parse(parsed)
    .flatMap((r) => r["QUERY PLAN"])
    .flatMap((element) => planNodes(rootOf(element)));
}

/**
 * The plan node that reads `relation`, or a throw naming what the plan did read.
 *
 * Anchoring an assertion here rather than on the serialized plan is the whole point: it asks about
 * the access under test and says nothing about how the rest of the query was planned.
 */
export function scanOf(plan: string, relation: string): PlanNode {
  const nodes = allNodes(plan);
  const scan = nodes.find((n) => n["Relation Name"] === relation);
  if (!scan) {
    const read = nodes.map((n) => n["Relation Name"]).filter(Boolean);
    throw new Error(
      `no plan node reads ${relation}; the plan reads ${JSON.stringify(read)}`,
    );
  }
  return scan;
}

/**
 * Whether the plan sorts rows of `relation` — a Sort with that relation's scan anywhere beneath it.
 *
 * ⚠ THIS WAS "a Sort whose subtree reads that relation AND NOTHING ELSE", and that was too strict
 * in the direction that matters. A sort of a relation's own rows does not have to sit directly on
 * its scan: put a join between them and the Sort's subtree reads two relations, so the old rule
 * answered `false` for a plan that was sorting exactly the history it claimed not to. It made the
 * assertion this exists for — "no sort of the probe history" — pass on a plan that sorts it.
 *
 * The looser rule is not looser in the direction that caused the original finding. The case that
 * started this is a merge join above a LATERAL, sorting the OUTER relations while the correlated
 * scan hangs off a sibling branch — so that relation's scan is not beneath the Sort, and this still
 * answers `false`. What it no longer does is require the two to be adjacent.
 *
 * It is only meaningful for a query with no top-level ORDER BY of its own: one of those puts every
 * scan beneath a Sort and the answer is `true` for everything. The caller owns that.
 */
export function sortsRowsOf(plan: string, relation: string): boolean {
  return allNodes(plan)
    .filter((n) => n["Node Type"] === "Sort")
    .some((n) => relationsUnder(n).has(relation));
}
