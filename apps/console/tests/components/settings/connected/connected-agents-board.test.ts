// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connected-agents board as data (SPEC §5a): connected cards first, catalogue apps listed whether
// connected or not, an unknown app described from its own metadata, the search and the Status facet
// over the board, facet counts over the UNFILTERED board, and the URL round trip of the filters.

import { describe, expect, it } from "vitest";
import {
	activeAgentFilters,
	agentFiltersFromUrl,
	agentFiltersPatch,
	agentStatusCounts,
	buildAgentBoard,
	filterAgentBoard,
	projectsLabel,
} from "@/components/settings/connected/connected-agents-board";
import { AGENT_APPS, agentAppIdentity } from "@/lib/agents/catalog";
import type { ConnectedAgent } from "@/lib/agents/grants";

/** A live grant for `clientId`. */
function grant(grantId: string, clientId: string, extra: Partial<ConnectedAgent> = {}): ConnectedAgent {
	return {
		grantId,
		clientId,
		identity: agentAppIdentity({ clientId, name: extra.identity?.name ?? "Release bot", icon: null }),
		verified: true,
		scopes: ["read"],
		projectIds: null,
		connectedAt: "2026-11-20T10:00:00.000Z",
		...extra,
	};
}

const cursor = grant("g-cursor", "https://cursor.com/oauth/client.json");
const custom = grant("g-custom", "https://tools.acme.io/mcp/client.json");

describe("buildAgentBoard", () => {
	it("lists every catalogue app once, connected cards first in catalogue order, then unknown apps", () => {
		const board = buildAgentBoard(AGENT_APPS, [custom, cursor]);
		expect(board.map((c) => c.name)).toEqual(["Cursor", "Release bot", "Claude Code", "Claude", "GitHub Copilot", "OpenAI Codex"]);
		expect(board[0]?.grant?.grantId).toBe("g-cursor");
		expect(board.slice(2).every((c) => c.grant === null)).toBe(true);
	});

	it("describes an unknown app from where it is published, with no mark and no docs page", () => {
		const card = buildAgentBoard(AGENT_APPS, [custom]).find((c) => c.key === "g-custom");
		expect(card?.description).toBe("Registered by its own metadata document at tools.acme.io.");
		expect(card?.mark).toBeNull();
		expect(card?.docsPath).toBeNull();
	});

	it("says an unverified unknown app is not verified", () => {
		const card = buildAgentBoard(AGENT_APPS, [{ ...custom, verified: false }])[0];
		expect(card?.description).toBe("Registered itself with Alethia. Its identity isn't verified.");
	});

	it("with nothing connected, every catalogue app is a Set up card with its docs page", () => {
		const board = buildAgentBoard(AGENT_APPS, []);
		expect(board).toHaveLength(AGENT_APPS.length);
		expect(board.every((c) => c.grant === null && c.docsPath?.startsWith("/docs/agents/"))).toBe(true);
	});
});

describe("filters", () => {
	const board = buildAgentBoard(AGENT_APPS, [cursor]);

	it("search matches the name case-insensitively; Status narrows by connection", () => {
		expect(filterAgentBoard(board, { search: "CLAU", status: [] }).map((c) => c.name)).toEqual(["Claude Code", "Claude"]);
		expect(filterAgentBoard(board, { search: "", status: ["connected"] }).map((c) => c.name)).toEqual(["Cursor"]);
		expect(filterAgentBoard(board, { search: "cursor", status: ["not-connected"] })).toEqual([]);
	});

	it("facet counts come from the unfiltered board", () => {
		expect(agentStatusCounts(board)).toEqual({ connected: 1, "not-connected": AGENT_APPS.length - 1 });
	});

	it("round-trips through the URL and drops unknown status values", () => {
		const patch = agentFiltersPatch({ search: "cur", status: ["connected"] });
		expect(patch).toEqual({ q: "cur", status: "connected" });
		const params = new URLSearchParams("q=cur&status=connected,bogus");
		expect(agentFiltersFromUrl(params)).toEqual({ search: "cur", status: ["connected"] });
		expect(agentFiltersPatch({ search: "  ", status: [] })).toEqual({ q: null, status: null });
		expect(activeAgentFilters({ search: "x", status: ["connected"] })).toBe(2);
		expect(activeAgentFilters({ search: " ", status: [] })).toBe(0);
	});
});

describe("projectsLabel", () => {
	const names = new Map([["p1", "payments-api"]]);
	it("names all, one or a count — never an id", () => {
		expect(projectsLabel(null, names)).toBe("All projects");
		expect(projectsLabel(["p1"], names)).toBe("payments-api");
		expect(projectsLabel(["hidden"], names)).toBe("1 project");
		expect(projectsLabel(["p1", "p2"], names)).toBe("2 projects");
	});
});
