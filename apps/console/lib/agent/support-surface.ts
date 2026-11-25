// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one exemption from the org's agent kill switch (#7646, amending #7477 "off means off"): the Ask
// AI support chat may still search the documentation and propose a support case while agent access is
// off, because neither can touch infrastructure. Every other agent surface, and every other tool on
// the support surface, stays refused.
//
// The exemption needs BOTH halves, and neither is a list of tool names:
//   - the SURFACE: the turn is answered on the support route. lib/agent/turn-route.ts derives it from
//     the route's thread kind (`threadKind: "support"`, which only /api/support/ask declares and which
//     reserveTurn checks against the stored thread), never from anything in the request body.
//   - the TOOL OBJECT: the tool was marked here where it is defined (lib/ai/tools/support.ts). The mark
//     is the object's identity in a WeakSet, so a copy of a marked tool (`{ ...def, execute }`) is NOT
//     marked, a different tool under a marked tool's name is not marked, and a tool added to the
//     support set later is refused until someone marks it on purpose, in review.
// Pure, with no imports, so the tool definitions can mark themselves without pulling in the database.

/** The agent surface a turn is answered on: the route that built its tools. */
export type AgentSurface = "agent" | "support";

/** The tool objects exempt on the support surface. Private: only {@link markSupportSurfaceTools} adds. */
const exempt = new WeakSet<object>();

/**
 * Marks every tool in `tools` as exempt from the kill switch ON THE SUPPORT SURFACE, and returns
 * `tools` unchanged. Only for a tool that cannot touch infrastructure: a search of the public
 * documentation, or a proposal the person submits themselves.
 */
export function markSupportSurfaceTools<T extends Record<string, object>>(tools: T): T {
	for (const def of Object.values(tools)) exempt.add(def);
	return tools;
}

/** True when the kill switch exempts `def` on `surface`: the support surface, and a tool marked as exactly this object. */
export function exemptFromAgentAccessSwitch(def: object, surface: AgentSurface): boolean {
	return surface === "support" && exempt.has(def);
}
