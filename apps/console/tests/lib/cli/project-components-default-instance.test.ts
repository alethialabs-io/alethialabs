// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `insertProjectComponent` gives a NEW cluster row with no instance types the catalog's default node
// for its cloud — and gives an EXISTING row nothing (#5251).
//
// The CLI/API path (`alethia project component add --kind cluster`) used to write NULL, so the
// snapshot carried `[]` and the template's own default applied: 2× m5a.4xlarge on AWS, a different
// machine from the console's create path. The fix is INSERT-only on purpose: `component add` upserts,
// and the row it amends is very often a deployed cluster whose NULL IS its current shape. Writing the
// default into the ON CONFLICT `set` would re-shape that running cluster on its next apply — the
// "amend an existing row" tests below are what fail if the default is ever moved there.
//
// Only `getServiceDb` is mocked; the function under test runs for real. The mock answers each
// `select … from(table)` by TABLE, so the provider lookup is exercised through the same query shape
// the production code issues rather than through a stub of the helper.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INSTANCE_TYPE } from "@/lib/cloud-providers";
import { cloudIdentities, projectEnvironments, projects } from "@/lib/db/schema";

const ENV_ID = "11111111-1111-4111-8111-111111111111";
const PROJ_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_IDENTITY = "55555555-5555-4555-8555-555555555555";
const OTHER_IDENTITY = "66666666-6666-4666-8666-666666666666";

/** The project's linked identity; null models a project with no cloud account yet. */
let projectIdentity: string | null;
/** identity id → provider, as `cloud_identities` holds it. */
let identities: Record<string, string>;
/** The identity id each cloud_identities lookup was asked for, in order. */
let identityLookups: string[];
let captured: {
	values?: Record<string, unknown>;
	conflictSet?: Record<string, unknown>;
};

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({
			from: (table: unknown) => ({
				where: () => ({
					limit: async () => {
						if (table === projectEnvironments) {
							return [{ fabric_id: null, placement_mode: "dedicated" }];
						}
						if (table === projects) {
							return [{ cloud_identity_id: projectIdentity }];
						}
						if (table === cloudIdentities) {
							// The id is not observable through the drizzle `where` clause without
							// rendering SQL, so the mock serves whichever identity the test armed.
							const id = identityLookups.shift();
							const provider = id ? identities[id] : undefined;
							return provider ? [{ provider }] : [];
						}
						throw new Error("unexpected table in select");
					},
				}),
			}),
		}),
		insert: () => ({
			values: (v: Record<string, unknown>) => {
				captured.values = v;
				const returning = async () => [{ id: "row-1", ...v }];
				return {
					onConflictDoUpdate: (arg: { set: Record<string, unknown> }) => {
						captured.conflictSet = arg.set;
						return { returning };
					},
					returning,
				};
			},
		}),
	}),
}));

const { insertProjectComponent } = await import("@/lib/cli/project-components");

describe("insertProjectComponent — the default node on a new cluster row", () => {
	beforeEach(() => {
		captured = {};
		projectIdentity = PROJECT_IDENTITY;
		identities = { [PROJECT_IDENTITY]: "aws", [OTHER_IDENTITY]: "hetzner" };
		identityLookups = [PROJECT_IDENTITY];
	});

	it.each(["aws", "gcp", "azure", "hetzner", "alibaba"] as const)(
		"inserts the catalog default for %s when no instance type is given",
		async (provider) => {
			identities = { [PROJECT_IDENTITY]: provider };
			await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {
				cluster_version: "1.35",
			});
			expect(captured.values?.instance_types).toEqual([DEFAULT_INSTANCE_TYPE[provider]]);
		},
	);

	it("pins the shipped defaults to the proven floors, not the values the code happens to hold", async () => {
		// Fixture by DECISION, not derived from DEFAULT_INSTANCE_TYPE: the cases above would pass
		// against any catalog value; this one fails if the catalog drifts off the #5251 decision.
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {});
		expect(captured.values?.instance_types).toEqual(["t3.large"]);
	});

	it.each([
		["absent", {}],
		["null", { instance_types: null }],
		["empty", { instance_types: [] }],
	])("treats an %s instance_types as unset", async (_label, values) => {
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", values);
		expect(captured.values?.instance_types).toEqual(["t3.large"]);
	});

	it("keeps an explicit instance type and does not look the cloud up", async () => {
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {
			instance_types: ["m5a.xlarge"],
		});
		expect(captured.values?.instance_types).toEqual(["m5a.xlarge"]);
		expect(identityLookups).toEqual([PROJECT_IDENTITY]); // never consumed
	});

	it("uses the cluster's own cloud identity over the project's", async () => {
		identityLookups = [OTHER_IDENTITY];
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {
			cloud_identity_id: OTHER_IDENTITY,
		});
		expect(captured.values?.instance_types).toEqual(["cpx22"]);
	});

	it("leaves instance_types NULL when the project has no cloud identity", async () => {
		projectIdentity = null;
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {});
		expect(captured.values).not.toHaveProperty("instance_types");
	});

	it("leaves instance_types NULL when the identity's cloud has no catalog", async () => {
		identities = { [PROJECT_IDENTITY]: "digitalocean" };
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {});
		expect(captured.values).not.toHaveProperty("instance_types");
	});

	it("leaves instance_types NULL when the identity row is gone", async () => {
		identities = {};
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {});
		expect(captured.values).not.toHaveProperty("instance_types");
	});

	describe("amending an EXISTING row (the ON CONFLICT arm)", () => {
		it("never writes the default into the conflict set", async () => {
			// `component add --kind cluster --set cluster_version=1.36` on a deployed cluster whose
			// instance_types is NULL: the update must leave that NULL alone.
			await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {
				cluster_version: "1.36",
			});
			expect(captured.values?.instance_types).toEqual(["t3.large"]);
			expect(captured.conflictSet).toBeDefined();
			expect(captured.conflictSet).not.toHaveProperty("instance_types");
			expect(captured.conflictSet?.cluster_version).toBe("1.36");
		});

		it("still writes an instance type the caller asked for", async () => {
			await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {
				instance_types: ["t3.xlarge"],
			});
			expect(captured.conflictSet?.instance_types).toEqual(["t3.xlarge"]);
		});
	});

	it("does not touch any other kind", async () => {
		await insertProjectComponent("repositories", PROJ_ID, ENV_ID, "", {
			apps_path: "examples/online-boutique/overlays/prod",
		});
		expect(captured.values).not.toHaveProperty("instance_types");
		expect(identityLookups).toEqual([PROJECT_IDENTITY]); // never consumed
	});
});
