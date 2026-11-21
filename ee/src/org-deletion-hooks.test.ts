// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The organization plugin's delete hooks as `register(core)` mounts them, and the two tuple-removal
// methods the erasure and the org deletion call on the OpenFGA writer.
//
// What the hooks must do: `before` captures core's snapshot while the rows still exist; `after`
// hands THAT snapshot to core's `finish` (subscription and member emails) — and a failure there
// must not throw out of the hook, because the organization is already deleted. An `after` with no
// matching `before` does nothing rather than acting on a guess.

import { describe, expect, it, vi } from "vitest";
import type { OpenFgaClient } from "@openfga/sdk";
import { orgAc, orgRoles } from "@/lib/authz/org-access-control";
import type { CoreContext } from "@/lib/enterprise";
import type { OrgDeletionSnapshot } from "@/lib/org/deletion-teardown";
import { reservedOrgSlugRefusal } from "@/lib/routing";
import { orgSlugShapeRefusal } from "@repo/org-slug";
import { FgaTupleSync } from "./fga-tuple-sync";
import { register } from "./index";

const SNAPSHOT: OrgDeletionSnapshot = {
	orgId: "org-1",
	orgName: "Acme",
	teamIds: ["team-1"],
	recipients: ["a@example.com"],
	stripeSubscriptionId: "sub_1",
};

/** A CoreContext with only what `register` and the delete hooks touch; OpenFGA reported off. */
function stubCore(orgDeletion: CoreContext["orgDeletion"]): CoreContext {
	const stub = {
		db: {},
		orgAc,
		orgRoles,
		reservedOrgSlugRefusal,
		orgSlugShapeRefusal,
		ensureMemberGrant: vi.fn(async () => undefined),
		revokeMemberGrant: vi.fn(async () => undefined),
		sendInviteEmail: vi.fn(async () => undefined),
		canOrgInvite: vi.fn(async () => true),
		canOrgCreateTeams: vi.fn(async () => true),
		syncOrgSeats: vi.fn(async () => undefined),
		emitAlertEvent: vi.fn(),
		recordActivity: vi.fn(),
		resolveOrgEntitlements: vi.fn(),
		newOrgSetup: {
			stampMetadata: vi.fn(async () => null),
			recordCreated: vi.fn(async () => undefined),
			keepStoredMarker: vi.fn(async () => null),
		},
		isOrgMember: vi.fn(async () => false),
		roleChangeOwnerRefusal: vi.fn(async () => null),
		removalOwnerRefusal: vi.fn(async () => null),
		isNonActiveMember: vi.fn(async () => false),
		inviterRefusal: vi.fn(async () => null),
		orgDeletion,
		fga: { isEnabled: () => false },
	};
	// A test-only stub: `db` and most of `fga` are never reached with OpenFGA off.
	return stub as unknown as CoreContext;
}

/** The hooks object of the mounted organization plugin. */
function deleteHooks(core: CoreContext) {
	const plugin = register(core).authPlugins?.find((p) => p.id === "organization");
	const options: unknown = plugin && "options" in plugin ? plugin.options : undefined;
	if (typeof options !== "object" || options === null || !("organizationHooks" in options)) {
		throw new Error("the organization plugin exposes no hooks");
	}
	const hooks = options.organizationHooks;
	if (typeof hooks !== "object" || hooks === null) throw new Error("no hooks");
	const before = "beforeDeleteOrganization" in hooks ? hooks.beforeDeleteOrganization : undefined;
	const after = "afterDeleteOrganization" in hooks ? hooks.afterDeleteOrganization : undefined;
	if (typeof before !== "function" || typeof after !== "function") {
		throw new Error("the delete hooks are not mounted");
	}
	return {
		before: (orgId: string, userId: string): Promise<void> =>
			before({ organization: { id: orgId }, user: { id: userId } }),
		after: (orgId: string): Promise<void> => after({ organization: { id: orgId }, user: { id: "u" } }),
	};
}

describe("the organization delete hooks", () => {
	it("snapshots before the delete and finishes with that snapshot after it", async () => {
		const snapshot = vi.fn(async () => SNAPSHOT);
		const finish = vi.fn(async () => ({ subscriptionCancelled: true, membersEmailed: 1 }));
		const hooks = deleteHooks(stubCore({ snapshot, finish }));

		await hooks.before("org-1", "owner-1");
		expect(snapshot).toHaveBeenCalledWith("org-1", "owner-1");
		expect(finish).not.toHaveBeenCalled();

		await hooks.after("org-1");
		expect(finish).toHaveBeenCalledWith(SNAPSHOT);
	});

	it("does nothing after a delete it never saw begin", async () => {
		const finish = vi.fn(async () => ({ subscriptionCancelled: false, membersEmailed: 0 }));
		const hooks = deleteHooks(stubCore({ snapshot: vi.fn(async () => SNAPSHOT), finish }));
		await hooks.after("org-unknown");
		expect(finish).not.toHaveBeenCalled();
	});

	it("does not throw when finishing fails — the organization is already gone", async () => {
		const finish = vi.fn(async () => {
			throw new Error("stripe down");
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const hooks = deleteHooks(stubCore({ snapshot: vi.fn(async () => SNAPSHOT), finish }));
		await hooks.before("org-1", "owner-1");
		await expect(hooks.after("org-1")).resolves.toBeUndefined();
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});
});

/** A tuple as the fake store holds it. */
interface Tuple {
	user: string;
	relation: string;
	object: string;
}

/** An in-memory OpenFGA store with Read's filter rules and Write's deletes. */
function fakeStore(tuples: Tuple[]) {
	const store = [...tuples];
	const client = {
		async read(filter: { user?: string; relation?: string; object?: string } = {}) {
			const match = store.filter((t) => {
				if (filter.user && t.user !== filter.user) return false;
				if (filter.relation && t.relation !== filter.relation) return false;
				if (filter.object) {
					// `type:` alone matches every object of that type, as OpenFGA's Read does.
					if (filter.object.endsWith(":")) return t.object.startsWith(filter.object);
					if (t.object !== filter.object) return false;
				}
				return true;
			});
			return { tuples: match.map((key) => ({ key })), continuation_token: "" };
		},
		async write(body: { deletes?: Tuple[] }) {
			for (const d of body.deletes ?? []) {
				const i = store.findIndex(
					(t) => t.user === d.user && t.relation === d.relation && t.object === d.object,
				);
				if (i >= 0) store.splice(i, 1);
			}
		},
	};
	return { store, client };
}

/** A FgaTupleSync over the fake store, with `project` as the one per-instance type. */
function writer(client: ReturnType<typeof fakeStore>["client"]): FgaTupleSync {
	const core = { fga: { instanceTypes: ["project"] } };
	// Test-only: the writer reads nothing else from core for these two methods.
	return new FgaTupleSync(core as unknown as CoreContext, client as unknown as OpenFgaClient);
}

describe("FgaTupleSync — removing an erased account and a deleted organization", () => {
	it("removeUserTuples removes the account's tuples on every type and leaves others alone", async () => {
		const { store, client } = fakeStore([
			{ user: "user:u1", relation: "org_view", object: "org:o1" },
			{ user: "user:u1", relation: "member", object: "team:t1" },
			{ user: "user:u1", relation: "project_edit", object: "project:p1" },
			{ user: "user:u2", relation: "org_view", object: "org:o1" },
		]);
		await writer(client).removeUserTuples("u1");
		expect(store).toEqual([{ user: "user:u2", relation: "org_view", object: "org:o1" }]);
	});

	it("removeOrgTuples removes the org's, its teams' and its projects' tuples only", async () => {
		const { store, client } = fakeStore([
			{ user: "user:u1", relation: "org_view", object: "org:o1" },
			{ user: "user:u1", relation: "member", object: "team:t1" },
			{ user: "org:o1", relation: "parent", object: "project:p1" },
			{ user: "user:u1", relation: "project_edit", object: "project:p1" },
			{ user: "user:u1", relation: "org_view", object: "org:o2" },
			{ user: "org:o2", relation: "parent", object: "project:p2" },
		]);
		await writer(client).removeOrgTuples("o1", ["t1"]);
		expect(store).toEqual([
			{ user: "user:u1", relation: "org_view", object: "org:o2" },
			{ user: "org:o2", relation: "parent", object: "project:p2" },
		]);
	});
});
