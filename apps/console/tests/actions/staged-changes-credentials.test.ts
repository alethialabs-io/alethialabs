// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5565 on the STAGING path. `stageChanges` persists a diff of the desired design into
// `project_changes`, and it is also the CLI's staged `alethia apply`. Two properties:
//
//   1. A NEW credential in a component's provider_config is refused before the staged rows are
//      replaced — no delete, no insert.
//   2. A legacy credential that passes the guard (already stored, unchanged) is not written a
//      second time, in plaintext, into `project_changes.payload`: the payload omits it, and keeps
//      everything else about the component.
//
// The seams stubbed are the PDP guard, the scoped transaction and the live-design read; the guard
// itself (credential-knob-store + credential-knobs) and the differ stay real.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn(async () => ({ userId: "u-1", orgId: "org-1" })) }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn() }));
vi.mock("@/app/server/actions/projects", () => ({
	getProjectAsFormData: vi.fn(),
	updateProjectDesign: vi.fn(),
}));

const { stageChanges } = await import("@/app/server/actions/staged-changes");
const { getProjectAsFormData } = await import("@/app/server/actions/projects");
const { withActorScope } = await import("@/lib/db");
const { CredentialKnobRefusedError } = await import("@/lib/cloud-providers/credential-knobs");
const { projectChanges, projectSecrets } = await import("@/lib/db/schema");

/** Records what the staged-changes transaction deleted and inserted; `stored` answers the guard's read of secrets. */
function wireTx(stored: unknown[]) {
	const deleted: unknown[] = [];
	const inserted: { table: unknown; rows: unknown }[] = [];
	const tx = {
		select: () => ({
			from: (table: unknown) => ({
				where: () => Promise.resolve(table === projectSecrets ? stored : []),
			}),
		}),
		delete: (table: unknown) => ({
			where: () => {
				deleted.push(table);
				return Promise.resolve();
			},
		}),
		insert: (table: unknown) => ({
			values: (rows: unknown) => {
				inserted.push({ table, rows });
				return Promise.resolve();
			},
		}),
	};
	vi.mocked(withActorScope).mockImplementation(((_actor: unknown, cb: (t: unknown) => unknown) => cb(tx)) as never);
	return { deleted, inserted };
}

/** A design with one secret whose provider_config is `providerConfig`, plus a changed `length`. */
function design(providerConfig: Record<string, unknown>) {
	return {
		project: { project_name: "Shop", environment_stage: "production", region: "us-east-1", iac_version: "1.11.4" },
		network: {},
		cluster: { provider_config: {} },
		dns: { enabled: false },
		repositories: {},
		secrets: [{ name: "api-key", generate: false, length: 48, provider_config: providerConfig }],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// The live design: the same secret, length 32, holding a legacy value.
	vi.mocked(getProjectAsFormData).mockResolvedValue({
		formData: {
			...design({ value: "legacy-s3cr3t" }),
			secrets: [{ name: "api-key", generate: false, length: 32, provider_config: { value: "legacy-s3cr3t" } }],
		},
		provider: "aws",
	} as never);
});

describe("stageChanges and a credential in provider_config (#5565)", () => {
	it("refuses a NEW secret value before replacing any staged row", async () => {
		const { deleted, inserted } = wireTx([]);
		await expect(stageChanges("p1", "env-1", design({ value: "hunter2" }) as never)).rejects.toBeInstanceOf(
			CredentialKnobRefusedError,
		);
		expect(deleted).toEqual([]);
		expect(inserted).toEqual([]);
	});

	it("stages an edit to a component holding a legacy value without copying the value into the payload", async () => {
		const { inserted } = wireTx([{ provider_config: { value: "legacy-s3cr3t" } }]);
		await stageChanges("p1", "env-1", design({ value: "legacy-s3cr3t", keepers: { rotate: "1" } }) as never);
		const staged = inserted.find((i) => i.table === projectChanges);
		expect(staged).toBeDefined();
		expect(JSON.stringify(staged?.rows)).not.toContain("legacy-s3cr3t");
		// The change itself is still staged, with the rest of the component.
		expect(JSON.stringify(staged?.rows)).toContain('"length":48');
		expect(JSON.stringify(staged?.rows)).toContain('"keepers"');
	});
});
