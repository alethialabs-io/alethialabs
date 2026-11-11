// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/projects/:id/environments (#6551): a namespace placement into a namespace the platform
// or the host environment uses is a 400 naming the namespace and the reason, and NOTHING is inserted.
// The host's namespaces come from the host's own BYO charts (mocked here at the query seam, whose
// shape is what the route passes on); the guard and the project resolver are mocked to an allowed
// caller, because authorization is not the unit.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	order: new Array<string>(),
	insert: vi.fn(),
	host: vi.fn(async (): Promise<string[]> => []),
	siblings: vi.fn(async (): Promise<{ environment: string; namespace: string }[]> => []),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: async () => ({ actor: { userId: "u1", orgId: "o1", credential: "session" } }),
}));
vi.mock("@/lib/cli/project-access", () => ({
	resolveCliProjectAuthorized: async () => ({ id: "p1" }),
}));
vi.mock("@/lib/queries/placement-host-namespaces", () => ({
	placementHostNamespaces: h.host,
	placementNamespacesOnFabric: h.siblings,
}));
vi.mock("@/lib/db", () => {
	/** A select chain that resolves to the default environment's Fabric, whatever is asked. */
	const chain: Record<string, unknown> = {};
	for (const k of ["from", "where", "orderBy", "leftJoin"]) chain[k] = () => chain;
	chain.limit = async () => [{ fabric_id: "f1", id: "f1", name: "prod" }];
	const db = {
		select: () => chain,
		insert: (...args: unknown[]) => {
			h.order.push("insert");
			h.insert(...args);
			throw new Error("insert reached in a test that expects a refusal");
		},
		execute: async () => {
			h.order.push("lock");
			return [];
		},
	};
	return {
		getServiceDb: () => ({
			...db,
			// #6575: the check and the insert run in one transaction, which this records.
			transaction: async (cb: (tx: typeof db) => Promise<unknown>) => {
				h.order.push("begin");
				try {
					return await cb(db);
				} finally {
					h.order.push("end");
				}
			},
		}),
	};
});

import { POST } from "@/app/api/cli/projects/[id]/environments/route";

/** POSTs `body` and returns the status and the decoded body. */
async function post(body: Record<string, unknown>) {
	const res = await POST(
		new Request("https://console.test/api/cli/projects/p1/environments", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id: "p1" }) },
	);
	const json: unknown = await res.json();
	return { status: res.status, error: typeof json === "object" && json && "error" in json ? String(json.error) : "" };
}

beforeEach(() => {
	h.order.length = 0;
	h.insert.mockClear();
	h.host.mockReset();
	h.host.mockImplementation(async () => {
		h.order.push("host");
		return [];
	});
	h.siblings.mockReset();
	h.siblings.mockImplementation(async () => {
		h.order.push("siblings");
		return [];
	});
});

describe("POST environments — a reserved placement namespace", () => {
	it.each(["argocd", "default", "kube-system", "alethia-byo-db-users", "byo-payments"])(
		"refuses %s with a 400 naming it, and inserts nothing",
		async (ns) => {
			const { status, error } = await post({ name: "team", placement_mode: "namespace", namespace: ns });
			expect(status).toBe(400);
			expect(error).toContain(`“${ns}” is reserved on the host cluster`);
			expect(h.insert).not.toHaveBeenCalled();
		},
	);

	it("refuses a namespace the host's own BYO chart chose, asking for THIS Fabric's host", async () => {
		h.host.mockResolvedValue(["payments"]);
		const { status, error } = await post({ name: "team", placement_mode: "namespace", namespace: "payments" });
		expect(status).toBe(400);
		expect(error).toMatch(/bring-your-own chart of the environment that owns this cluster/);
		expect(h.host).toHaveBeenCalledWith(expect.anything(), "p1", "f1");
		expect(h.insert).not.toHaveBeenCalled();
	});

	it("refuses a placement with no namespace whose name would be the namespace", async () => {
		const { status } = await post({ name: "argocd", placement_mode: "namespace" });
		expect(status).toBe(400);
		expect(h.insert).not.toHaveBeenCalled();
	});

	it("control: an ordinary namespace gets past the check to the insert", async () => {
		const { status } = await post({ name: "team", placement_mode: "namespace", namespace: "team-web" });
		expect(h.insert).toHaveBeenCalledTimes(1);
		expect(status).toBe(500); // the fake insert throws; reaching it is the point
	});

	it("refuses a namespace another placement on this Fabric already resolves to — the Preview env's included", async () => {
		h.siblings.mockResolvedValue([
			{ environment: "preview", namespace: "preview" },
			{ environment: "staging", namespace: "team-web" },
		]);
		for (const body of [
			{ name: "team", placement_mode: "namespace", namespace: "preview" },
			{ name: "team", placement_mode: "namespace", namespace: "team-web" },
			{ name: "preview", placement_mode: "namespace" },
		]) {
			const { status, error } = await post(body);
			expect(status).toBe(400);
			expect(error).toMatch(/is already used by the environment/);
		}
		expect(h.siblings).toHaveBeenCalledWith(expect.anything(), "p1", "f1");
		expect(h.insert).not.toHaveBeenCalled();
	});

	it("takes the project's namespace lock, then reads both sides and inserts, in ONE transaction (#6575)", async () => {
		await post({ name: "team", placement_mode: "namespace", namespace: "team-web" });
		expect(h.order).toEqual(["begin", "lock", "host", "siblings", "insert", "end"]);
	});

	it("does not apply to a vcluster placement", async () => {
		await post({ name: "team", placement_mode: "vcluster", namespace: "default" });
		expect(h.insert).toHaveBeenCalledTimes(1);
		expect(h.host).not.toHaveBeenCalled();
		expect(h.siblings).not.toHaveBeenCalled();
	});
});
