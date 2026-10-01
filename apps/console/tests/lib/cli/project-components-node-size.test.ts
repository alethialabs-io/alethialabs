// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `alethia project component add --kind cluster --set node_size=…` (#5267).
//
// The CLI used to refuse the field ("Unknown field(s) for cluster"), and since #5270 a new cluster
// row is stamped with a default instance type — which Go prefers over node_size, so a size written
// beside it would be shadowed for ever. Each case drives the route's own two steps, in order:
// validateComponentFields (schema + the one-writer rule) and then insertProjectComponent (the
// default stamp, and the ON CONFLICT arm that amends an existing row). Only `getServiceDb` is
// mocked, answering each `select … from(table)` by table, as project-components-default-instance
// does.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloudIdentities, projectEnvironments, projects } from "@/lib/db/schema";

const ENV_ID = "11111111-1111-4111-8111-111111111111";
const PROJ_ID = "33333333-3333-4333-8333-333333333333";
const IDENTITY = "55555555-5555-4555-8555-555555555555";

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
						if (table === projects) return [{ cloud_identity_id: IDENTITY }];
						if (table === cloudIdentities) return [{ provider: "gcp" }];
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

const { insertProjectComponent, validateComponentFields } = await import(
	"@/lib/cli/project-components"
);

/** The route's write path: validate the `--set` map, then upsert it. Throws on a 400. */
async function cliSet(fields: Record<string, unknown>) {
	const validated = validateComponentFields("cluster", fields);
	if (!validated.ok) throw new Error(validated.error);
	await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", validated.values);
}

describe("CLI --set node_size on a cluster (#5267)", () => {
	beforeEach(() => {
		captured = {};
	});

	it("accepts node_size — it used to be an unknown field", () => {
		const r = validateComponentFields("cluster", { node_size: { vcpu: 4, memory_gb: 16 } });
		expect(r.ok).toBe(true);
	});

	it("rejects a node_size outside the canvas's bounds, or with a stray key", () => {
		expect(validateComponentFields("cluster", { node_size: { vcpu: 0, memory_gb: 16 } }).ok).toBe(false);
		expect(validateComponentFields("cluster", { node_size: { vcpu: 4 } }).ok).toBe(false);
		expect(
			validateComponentFields("cluster", { node_size: { vcpu: 4, memory_gb: 16, gpu: 1 } }).ok,
		).toBe(false);
	});

	describe("the one-writer rule", () => {
		it("setting node_size clears instance_types, on the new row AND on the amended one", async () => {
			await cliSet({ node_size: { vcpu: 4, memory_gb: 16 } });
			expect(captured.values?.node_size).toEqual({ vcpu: 4, memory_gb: 16 });
			expect(captured.values?.instance_types).toEqual([]);
			// The upsert's conflict arm is what reaches an existing row whose instance_types was
			// default-stamped; without the clear there the stamp would go on shadowing the size.
			expect(captured.conflictSet?.instance_types).toEqual([]);
		});

		it("does not stamp the default instance type over a size the caller just set", async () => {
			await cliSet({ node_size: { vcpu: 4, memory_gb: 16 } });
			expect(captured.values?.instance_types).not.toEqual(["e2-standard-2"]);
		});

		it("pinning instance_types clears node_size — explicitly, so the conflict arm writes NULL", async () => {
			await cliSet({ instance_types: ["e2-standard-4"] });
			expect(captured.values?.instance_types).toEqual(["e2-standard-4"]);
			expect(captured.conflictSet).toHaveProperty("node_size", null);
		});

		it("refuses naming both in one write", () => {
			const r = validateComponentFields("cluster", {
				node_size: { vcpu: 4, memory_gb: 16 },
				instance_types: ["e2-standard-4"],
			});
			expect(r).toEqual({ ok: false, error: expect.stringContaining("mutually exclusive") });
		});

		it("leaves both alone on a write that names neither — an existing row is never reshaped", async () => {
			await cliSet({ node_min_size: 3 });
			expect(captured.conflictSet).not.toHaveProperty("node_size");
			expect(captured.conflictSet).not.toHaveProperty("instance_types");
			// A NEW row with neither still gets the default node (#5251), unchanged.
			expect(captured.values?.instance_types).toEqual(["e2-standard-2"]);
		});

		it("clearing node_size does not pin or clear a machine type", async () => {
			await cliSet({ node_size: null });
			expect(captured.conflictSet).toHaveProperty("node_size", null);
			expect(captured.conflictSet).not.toHaveProperty("instance_types");
		});
	});
});
