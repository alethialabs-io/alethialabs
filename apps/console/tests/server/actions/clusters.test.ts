// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6122: `getClusters` — the agent tool's and the @-mention picker's cluster read — is the clusters
// procedure's body, not a second definition of a cluster: it hands the signed-in actor to
// `readClusters`, and with no actor it answers no clusters rather than throwing.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The signed-in actor `currentActor` answers with, or none. */
interface Signed {
	userId: string;
	orgId: string;
	credential: "session";
}

const h = vi.hoisted(() => {
	const state: { actor: Signed | null; read: unknown[] } = { actor: null, read: [] };
	return state;
});

vi.mock("@/lib/authz/guard", () => ({
	currentActor: async () => {
		if (!h.actor) throw new Error("no session");
		return h.actor;
	},
}));
vi.mock("@/lib/rpc/procedures/clusters", () => ({
	readClusters: async (actor: unknown) => {
		h.read.push(actor);
		return [{ id: "p1" }];
	},
}));

import { getClusters } from "@/app/server/actions/clusters";

beforeEach(() => {
	h.actor = null;
	h.read = [];
});

describe("getClusters", () => {
	it("reads the clusters procedure's definition for the signed-in actor", async () => {
		h.actor = { userId: "u1", orgId: "o1", credential: "session" };
		expect(await getClusters()).toEqual([{ id: "p1" }]);
		expect(h.read).toEqual([{ userId: "u1", orgId: "o1", credential: "session" }]);
	});

	it("answers no clusters, and reads nothing, without a signed-in actor", async () => {
		expect(await getClusters()).toEqual([]);
		expect(h.read).toEqual([]);
	});
});
