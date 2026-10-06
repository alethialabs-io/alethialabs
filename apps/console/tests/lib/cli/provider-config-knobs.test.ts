// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// `provider_config` template knobs from the CLI and alethia.yaml (#5529).
//
// The refusal cases come FIRST, because this is a write path into tofu variables and the boundary is
// the point: one case per reason a key is not settable, each on a REAL manifest entry — and each
// entry's manifest flags are asserted beside it, so a regenerated manifest that moves the entry out
// of its category fails here by name instead of silently testing a different thing. The one category
// the live manifest no longer holds (a dead knob, since #4320) is driven through a fixture.
//
// The write path is driven for real (insertProjectComponent / updateProjectComponent, and the two
// route handlers) over a fake service db that answers each SELECT by table, so merge and delete are
// asserted against a seeded row, not a stub of the merge.

import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	TEMPLATE_KNOBS,
	knobsFor,
	type TemplateKnob,
} from "@/lib/cloud-providers/template-knobs";
import {
	cloudIdentities,
	projectCluster,
	projectDatabases,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";

const PROJ_ID = "33333333-3333-4333-8333-333333333333";
const ENV_ID = "11111111-1111-4111-8111-111111111111";
const IDENTITY = "55555555-5555-4555-8555-555555555555";
/** A second identity, on GCP, that a write can move a component onto. */
const IDENTITY_GCP = "66666666-6666-4666-8666-666666666666";

/** What the fake db answers (the identity's cloud, the stored component row) and records. */
interface FakeDb {
	/** The cloud of IDENTITY (the project's); IDENTITY_GCP is always gcp. */
	cloud: string | null;
	/** Inside db.transaction(…) right now. */
	inTx: boolean;
	/** Every component-row read: whether it was FOR UPDATE and inside the transaction. */
	componentReads: Array<{ forUpdate: boolean; inTx: boolean }>;
	/** Whether the INSERT / UPDATE ran inside the transaction. */
	writeInTx: boolean | undefined;
	stored: Record<string, unknown> | null;
	componentSelects: number;
	inserted: Record<string, unknown> | undefined;
	conflictSet: Record<string, unknown> | undefined;
	updated: Record<string, unknown> | undefined;
}
const { db } = vi.hoisted((): { db: FakeDb } => ({
	db: {
		cloud: "aws",
		inTx: false,
		componentReads: [],
		writeInTx: undefined,
		stored: null,
		componentSelects: 0,
		inserted: undefined,
		conflictSet: undefined,
		updated: undefined,
	},
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", async () => {
	const { PgDialect } = await import("drizzle-orm/pg-core");
	/** The rows one SELECT answers, by table — an identity's cloud by the id its predicate binds. */
	const rowsFor = async (table: unknown, predicate: SQL, forUpdate: boolean): Promise<unknown[]> => {
		if (table === projectEnvironments) return [{ fabric_id: null, placement_mode: "dedicated" }];
		if (table === projects) return [{ cloud_identity_id: IDENTITY }];
		if (table === cloudIdentities) {
			const id = new PgDialect().sqlToQuery(predicate).params[0];
			if (id === IDENTITY_GCP) return [{ provider: "gcp" }];
			return id === IDENTITY && db.cloud ? [{ provider: db.cloud }] : [];
		}
		if (table === projectCluster || table === projectDatabases) {
			db.componentSelects++;
			db.componentReads.push({ forUpdate, inTx: db.inTx });
			return db.stored ? [db.stored] : [];
		}
		throw new Error("unexpected table in select");
	};
	const conn = {
		select: () => ({
			from: (table: unknown) => ({
				where: (predicate: SQL) => ({
					limit: () => rowsFor(table, predicate, false),
					for: (strength: string) => ({
						limit: () => rowsFor(table, predicate, strength === "update"),
					}),
				}),
			}),
		}),
		/** Runs `fn` on this same fake, flagged as inside the transaction. */
		transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
			db.inTx = true;
			try {
				return await fn(conn);
			} finally {
				db.inTx = false;
			}
		},
		insert: () => ({
			values: (v: Record<string, unknown>) => {
				db.writeInTx = db.inTx;
				db.inserted = v;
				const returning = async () => [{ id: "row-1", ...v }];
				return {
					onConflictDoUpdate: (arg: { set: Record<string, unknown> }) => {
						db.conflictSet = arg.set;
						return { returning };
					},
					returning,
				};
			},
		}),
		update: () => ({
			set: (v: Record<string, unknown>) => {
				db.writeInTx = db.inTx;
				db.updated = v;
				return {
					where: () => ({
						returning: async () => (db.stored ? [{ id: "row-1", name: "main", ...db.stored, ...v }] : []),
					}),
				};
			},
		}),
	};
	return { getServiceDb: () => conn };
});

// The routes' own collaborators. The guard and the project resolver are not what this file tests
// (component-update.test.ts drives the real guard); what is tested is that a refused knob reaches the
// caller as a 400 naming the key, through the routes' real error mapping.
vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: vi.fn(async () => ({
		actor: { userId: "u-1", orgId: "org-a" },
		credential: { kind: "user" },
	})),
	userIdIsTheCaller: () => true,
}));
vi.mock("@/lib/cli/resolve-project", () => ({
	resolveCliProject: vi.fn(async () => ({ id: PROJ_ID })),
	resolveCliWriteEnvironment: vi.fn(async () => ({ ok: true, id: ENV_ID })),
}));

const {
	isCredentialKnob,
	knobTypeError,
	mergeProviderConfig,
	resolveProviderConfigPatch,
	settableProviderConfigKnobs,
} = await import("@/lib/cli/provider-config-knobs");
const {
	componentSchemaDocument,
	insertProjectComponent,
	updateProjectComponent,
	validateComponentFields,
} = await import("@/lib/cli/project-components");
const addRoute = await import("@/app/api/cli/projects/[id]/components/[kind]/route");
const updateRoute = await import("@/app/api/cli/projects/[id]/components/[kind]/[name]/route");
const schemaRoute = await import("@/app/api/cli/schema/components/route");

/** The manifest entry for one knob, or a failure naming it. */
function manifestKnob(cloud: string, component: string, name: string): TemplateKnob {
	const found = TEMPLATE_KNOBS.knobs.find(
		(k) => k.cloud === cloud && k.component === component && k.name === name,
	);
	if (!found) throw new Error(`${cloud}/${component}/${name} is not in template-knobs.json`);
	return found;
}

/** The refusal message for one patch, or a failure when it was accepted. */
function refusal(cloud: string, kind: string, patch: Record<string, unknown>): string {
	const r = resolveProviderConfigPatch(cloud, kind, patch);
	if (r.ok) throw new Error(`expected ${JSON.stringify(patch)} to be refused`);
	return r.error;
}

beforeEach(() => {
	db.cloud = "aws";
	db.inTx = false;
	db.componentReads = [];
	db.writeInTx = undefined;
	db.stored = null;
	db.componentSelects = 0;
	db.inserted = undefined;
	db.conflictSet = undefined;
	db.updated = undefined;
});

describe("a key that is not offerable is refused, with the settable keys listed", () => {
	const awsClusterSettable = settableProviderConfigKnobs("aws", "cluster").map((k) => k.name);

	it("lists every settable key in the refusal, so the error is how keys are found", () => {
		const error = refusal("aws", "cluster", { not_a_knob: 1 });
		expect(awsClusterSettable.length).toBeGreaterThan(0);
		for (const name of awsClusterSettable) expect(error).toContain(name);
		expect(error).toContain("not_a_knob (not a variable of this template)");
	});

	it("refuses a reserved alethia_* key — platform context, never caller input", () => {
		expect(refusal("aws", "cluster", { alethia_project: "other" })).toContain(
			"alethia_project (reserved for platform context",
		);
		expect(refusal("gcp", "cluster", { alethia_anything_new: true })).toContain("reserved");
	});

	// The prefix, not a list, and it holds against the MANIFEST: a template that one day declares an
	// alethia_* variable that is otherwise offerable (reachable, read, not typed or owned) must still
	// not open it to the CLI. No live knob has that shape, so it is a fixture.
	it("refuses an alethia_* knob even when the manifest makes it offerable", () => {
		const reserved: TemplateKnob = {
			...manifestKnob("aws", "cluster", "eks_ami_type"),
			name: "alethia_environment",
		};
		expect(knobsFor("aws", "cluster").some((k) => k.name === "alethia_environment")).toBe(false);
		expect(settableProviderConfigKnobs("aws", "cluster", [reserved])).toEqual([]);
		const r = resolveProviderConfigPatch("aws", "cluster", { alethia_environment: "prod" }, [reserved]);
		expect(r).toEqual({
			ok: false,
			error: expect.stringContaining("alethia_environment (reserved for platform context"),
		});
	});

	it("refuses a credential the canvas would offer: rds_extra_credentials declares a password", () => {
		const knob = manifestKnob("aws", "database", "rds_extra_credentials");
		expect(knobsFor("aws", "database")).toContainEqual(knob);
		expect(knob.typeExpr).toMatch(/password\s*=/);
		expect(refusal("aws", "databases", { rds_extra_credentials: { username: "u", database: "d", password: "p" } })).toContain(
			"rds_extra_credentials (a credential",
		);
	});

	it("refuses a secret's own material (`value` on a secret)", () => {
		const knob = manifestKnob("aws", "secret", "value");
		expect(knobsFor("aws", "secret")).toContainEqual(knob);
		expect(isCredentialKnob(knob)).toBe(true);
		expect(refusal("aws", "secrets", { value: "hunter2" })).toContain("value (a credential");
	});

	it("refuses a sensitive knob whatever else it is", () => {
		const knob = manifestKnob("hetzner", "cluster", "hcloud_token");
		expect(knob.sensitive || /token/.test(knob.name)).toBe(true);
		expect(refusal("hetzner", "cluster", { hcloud_token: "t" })).toContain("hcloud_token (a credential");
	});

	// `sensitive` ALONE makes a knob a credential: a fixture whose name and type carry no credential
	// word, otherwise offerable, marked sensitive by its template.
	it("treats a template-sensitive knob as a credential, by the flag alone", () => {
		const plain = manifestKnob("aws", "cluster", "eks_ami_type");
		const sensitive: TemplateKnob = { ...plain, name: "bootstrap_blob", sensitive: true };
		expect(isCredentialKnob({ ...sensitive, sensitive: false })).toBe(false);
		expect(isCredentialKnob(sensitive)).toBe(true);
		expect(settableProviderConfigKnobs("aws", "cluster", [sensitive])).toEqual([]);
		const r = resolveProviderConfigPatch("aws", "cluster", { bootstrap_blob: "x" }, [sensitive]);
		expect(r).toEqual({ ok: false, error: expect.stringContaining("bootstrap_blob (a credential") });
	});

	it("refuses a typed key — a typed field already writes it", () => {
		const knob = manifestKnob("aws", "cluster", "eks_instance_types");
		expect([knob.typed, knob.ownedByProvider]).toEqual([true, false]);
		expect(refusal("aws", "cluster", { eks_instance_types: ["m5.large"] })).toContain(
			"eks_instance_types (set through the component's own field",
		);
	});

	it("refuses a provider-owned key — the provider always writes it, so an override would lose", () => {
		const knob = manifestKnob("aws", "cluster", "enable_karpenter");
		expect(knob.ownedByProvider).toBe(true);
		expect(refusal("aws", "cluster", { enable_karpenter: true })).toContain(
			"enable_karpenter (always set by Alethia",
		);
	});

	it("refuses a ceiling key — the cloud cannot honour it", () => {
		const knob = manifestKnob("alibaba", "dns", "alidns_managed_certificate");
		expect(knob.ceiling).toBe(true);
		expect(knob.reachable).toBe(true);
		expect(refusal("alibaba", "dns", { alidns_managed_certificate: true })).toContain(
			"alidns_managed_certificate (a provider ceiling",
		);
	});

	it("refuses an unreachable key — no merge lands on it", () => {
		const knob = manifestKnob("aws", "secret", "custom_secrets");
		expect(knob.reachable).toBe(false);
		expect(refusal("aws", "secrets", { custom_secrets: {} })).toContain(
			"custom_secrets (not reachable from this component's provider_config",
		);
	});

	// No dead knob is left in the live manifest (#4320), so the category is pinned on a fixture: the
	// filters are the same function either way.
	it("refuses a dead key — read by nothing", () => {
		const dead: TemplateKnob = {
			...manifestKnob("aws", "cluster", "eks_ami_type"),
			name: "never_read",
			readBy: [],
			reportedByOutput: false,
		};
		const r = resolveProviderConfigPatch("aws", "cluster", { never_read: "x" }, [dead]);
		expect(r).toEqual({
			ok: false,
			error: expect.stringContaining("never_read (read by nothing in the template)"),
		});
	});

	it("is per cloud: an AWS knob is unknown on GCP", () => {
		expect(refusal("gcp", "cluster", { eks_ami_type: "AL2023_x86_64_STANDARD" })).toContain(
			"eks_ami_type (not a variable of this template)",
		);
	});

	it("refuses a null (delete) of a key outside the allow-list too", () => {
		expect(refusal("aws", "cluster", { alethia_project: null })).toContain("reserved");
	});

	it("names the kind as having no settable keys when the cloud offers none", () => {
		expect(refusal("aws", "observability", { anything: 1 })).toContain(
			"observability on aws has no settable provider_config keys",
		);
	});
});

describe("values are type-checked against the knob's declared type", () => {
	const cases: Array<[string, string, string, string, unknown, string]> = [
		// [cloud, cli kind, manifest component, knob, wrong value, expected fragment]
		["aws", "cluster", "cluster", "eks_ami_type", 5, "must be a string"],
		["aws", "cluster", "cluster", "eks_volume_iops", "3000", "must be a number"],
		["aws", "cluster", "cluster", "ec2_spot_service_role", "true", "must be a bool"],
		["aws", "cluster", "cluster", "cluster_endpoint_public_access_cidrs", "10.0.0.0/8", "must be a list"],
		["aws", "cluster", "cluster", "cluster_endpoint_public_access_cidrs", [10], "must be a list of string values"],
		["aws", "secrets", "secret", "keepers", ["a"], "must be a map"],
		["aws", "secrets", "secret", "keepers", { rotate: 1 }, "must be a map of string values"],
	];

	it.each(cases)("%s %s.%s: refuses a wrong %s", (cloud, kind, component, name, value, expected) => {
		const knob = manifestKnob(cloud, component, name);
		expect(settableProviderConfigKnobs(cloud, kind)).toContainEqual(knob);
		expect(refusal(cloud, kind, { [name]: value })).toContain(`${name} ${expected}`);
	});

	it("refuses a non-finite number", () => {
		expect(knobTypeError(manifestKnob("aws", "cluster", "eks_volume_iops"), Number.NaN)).toBe("a number");
	});

	// The only live `object` knob is rds_extra_credentials, which is refused as a credential before
	// its type is read — so the object check is pinned on a fixture of the same shape.
	it("refuses a non-object for an object knob", () => {
		const objectKnob: TemplateKnob = {
			...manifestKnob("aws", "cluster", "eks_ami_type"),
			name: "tuning",
			kind: "object",
			typeExpr: "object({ a = string })",
		};
		const r = resolveProviderConfigPatch("aws", "cluster", { tuning: [1] }, [objectKnob]);
		expect(r).toEqual({ ok: false, error: expect.stringContaining("tuning must be an object") });
		expect(resolveProviderConfigPatch("aws", "cluster", { tuning: { a: "x" } }, [objectKnob]).ok).toBe(true);
	});

	it("accepts any JSON for an `any` (json) knob, and the declared shape for the rest", () => {
		const r = resolveProviderConfigPatch("aws", "cluster", {
			eks_access_entries: [{ principal_arn: "arn:aws:iam::1:role/x" }],
			eks_ami_type: "AL2023_x86_64_STANDARD",
			eks_volume_iops: 3000,
			ec2_spot_service_role: false,
			cluster_endpoint_public_access_cidrs: ["10.0.0.0/8"],
			cluster_log_retention_in_days: null,
		});
		expect(r).toEqual({
			ok: true,
			set: {
				cluster_endpoint_public_access_cidrs: ["10.0.0.0/8"],
				ec2_spot_service_role: false,
				eks_access_entries: [{ principal_arn: "arn:aws:iam::1:role/x" }],
				eks_ami_type: "AL2023_x86_64_STANDARD",
				eks_volume_iops: 3000,
			},
			unset: ["cluster_log_retention_in_days"],
		});
	});
});

describe("one definition of settable: the canvas's knobsFor, narrowed only", () => {
	it.each(TEMPLATE_KNOBS.clouds)("%s: every CLI-settable cluster knob is one the canvas offers", (cloud) => {
		const canvas = knobsFor(cloud, "cluster").map((k) => k.name);
		for (const k of settableProviderConfigKnobs(cloud, "cluster")) expect(canvas).toContain(k.name);
	});

	it("keeps every canvas knob that is neither reserved nor a credential", () => {
		const cli = settableProviderConfigKnobs("aws", "databases").map((k) => k.name);
		const canvas = knobsFor("aws", "database").map((k) => k.name);
		expect(cli).toEqual(canvas.filter((n) => n !== "rds_extra_credentials"));
	});
});

describe("mergeProviderConfig", () => {
	it("keeps keys the caller did not send, overwrites the ones it did, and removes nulls", () => {
		const stored = { gke_disk_type: "pd-ssd", gke_enable_private_nodes: true };
		expect(mergeProviderConfig(stored, { gke_enable_private_nodes: false, gke_volume_iops: 3000 }, ["gke_disk_type"])).toEqual({
			gke_enable_private_nodes: false,
			gke_volume_iops: 3000,
		});
		expect(stored).toEqual({ gke_disk_type: "pd-ssd", gke_enable_private_nodes: true });
	});
});

describe("the write path merges into the stored row", () => {
	it("an add on an existing cluster keeps the canvas's keys, sets the sent one, and deletes a null", async () => {
		db.stored = {
			cloud_identity_id: null,
			provider_config: { eks_volume_type: "gp3", eks_ami_type: "AL2_x86_64", cluster_log_retention_in_days: 30 },
		};
		const v = validateComponentFields("cluster", {
			provider_config: { eks_volume_iops: 4000, cluster_log_retention_in_days: null },
		});
		if (!v.ok) throw new Error(v.error);
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", v.values);
		const merged = { eks_volume_type: "gp3", eks_ami_type: "AL2_x86_64", eks_volume_iops: 4000 };
		expect(db.conflictSet?.provider_config).toEqual(merged);
		expect(db.inserted?.provider_config).toEqual(merged);
	});

	it("an update on a named database merges and deletes the same way", async () => {
		db.stored = {
			cloud_identity_id: null,
			provider_config: { rds_cluster_parameters: [{ name: "a", value: "1" }], rds_default_username: "app" },
		};
		const v = validateComponentFields("databases", {
			provider_config: { rds_allowed_cidr_blocks: ["10.0.0.0/16"], rds_default_username: null },
		});
		if (!v.ok) throw new Error(v.error);
		const wire = await updateProjectComponent("databases", PROJ_ID, ENV_ID, "main", v.values);
		expect(db.updated?.provider_config).toEqual({
			rds_cluster_parameters: [{ name: "a", value: "1" }],
			rds_allowed_cidr_blocks: ["10.0.0.0/16"],
		});
		expect(wire?.config.provider_config).toEqual(db.updated?.provider_config);
	});

	it("an update of a component that does not exist is the caller's 404 (null), not a write", async () => {
		const v = validateComponentFields("databases", { provider_config: { rds_default_username: "x" } });
		if (!v.ok) throw new Error(v.error);
		expect(await updateProjectComponent("databases", PROJ_ID, ENV_ID, "missing", v.values)).toBeNull();
		expect(db.updated).toBeUndefined();
	});

	it("a write with no linked cloud is refused rather than guessed", async () => {
		db.cloud = null;
		const v = validateComponentFields("cluster", { provider_config: { eks_volume_iops: 1 } });
		if (!v.ok) throw new Error(v.error);
		await expect(insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", v.values)).rejects.toMatchObject({
			code: "23514",
			message: expect.stringContaining("provider_config needs a cloud"),
		});
		expect(db.inserted).toBeUndefined();
	});

	it("a refused key stores nothing", async () => {
		db.stored = { cloud_identity_id: null, provider_config: { eks_volume_type: "gp3" } };
		const v = validateComponentFields("cluster", { provider_config: { eks_volume_iops: 1, alethia_project: "x" } });
		if (!v.ok) throw new Error(v.error);
		await expect(insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", v.values)).rejects.toThrow(/alethia_project/);
		expect(db.inserted).toBeUndefined();
	});

	// The stored row is on AWS (IDENTITY); the write moves it to GCP (IDENTITY_GCP). The keys must be
	// judged on GCP: a GKE knob passes and an EKS one is refused. Judged on the stored identity, both
	// answers flip.
	it("checks the keys against the identity the write SETS, not the stored one", async () => {
		db.stored = { cloud_identity_id: IDENTITY, provider_config: {} };
		const gke = validateComponentFields("cluster", {
			cloud_identity_id: IDENTITY_GCP,
			provider_config: { gke_disk_type: "pd-ssd" },
		});
		if (!gke.ok) throw new Error(gke.error);
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", gke.values);
		expect(db.conflictSet?.provider_config).toEqual({ gke_disk_type: "pd-ssd" });

		const eks = validateComponentFields("cluster", {
			cloud_identity_id: IDENTITY_GCP,
			provider_config: { eks_volume_iops: 1 },
		});
		if (!eks.ok) throw new Error(eks.error);
		await expect(insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", eks.values)).rejects.toThrow(
			/not settable for cluster on gcp/,
		);
	});

	it("falls back to the stored row's identity when the write sets none", async () => {
		db.stored = { cloud_identity_id: IDENTITY_GCP, provider_config: {} };
		const v = validateComponentFields("cluster", { provider_config: { gke_disk_type: "pd-ssd" } });
		if (!v.ok) throw new Error(v.error);
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", v.values);
		expect(db.conflictSet?.provider_config).toEqual({ gke_disk_type: "pd-ssd" });
	});

	// The read-merge-write is one transaction with the row locked, so a concurrent save cannot land
	// between the read and the write and be overwritten by a merge computed without it.
	it("reads the row FOR UPDATE and writes inside the same transaction (add and update)", async () => {
		db.stored = { cloud_identity_id: null, provider_config: { eks_volume_type: "gp3" } };
		const add = validateComponentFields("cluster", { provider_config: { eks_volume_iops: 1 } });
		if (!add.ok) throw new Error(add.error);
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", add.values);
		expect(db.componentReads).toEqual([{ forUpdate: true, inTx: true }]);
		expect(db.writeInTx).toBe(true);

		db.componentReads = [];
		db.writeInTx = undefined;
		const upd = validateComponentFields("databases", { provider_config: { rds_default_username: "x" } });
		if (!upd.ok) throw new Error(upd.error);
		await updateProjectComponent("databases", PROJ_ID, ENV_ID, "main", upd.values);
		expect(db.componentReads).toEqual([{ forUpdate: true, inTx: true }]);
		expect(db.writeInTx).toBe(true);
	});

	// Defaults unchanged: a write that sends no provider_config reads no row for it and writes no
	// provider_config at all, so the row keeps exactly what it had.
	it("a write without provider_config neither reads nor writes it", async () => {
		db.stored = { cloud_identity_id: null, provider_config: { eks_volume_type: "gp3" } };
		const v = validateComponentFields("cluster", { node_min_size: 2 });
		if (!v.ok) throw new Error(v.error);
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", v.values);
		expect(db.componentSelects).toBe(0);
		expect(db.inserted).not.toHaveProperty("provider_config");
		expect(db.conflictSet).not.toHaveProperty("provider_config");
	});
});

describe("the routes answer a refused knob with a 400 naming it", () => {
	/** A request to the component routes with a JSON body. */
	const request = (method: string, body: unknown) =>
		new Request(`http://x/api/cli/projects/${PROJ_ID}/components/k`, {
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	it("POST .../components/cluster", async () => {
		const res = await addRoute.POST(request("POST", { fields: { provider_config: { alethia_project: "x" } } }), {
			params: Promise.resolve({ id: PROJ_ID, kind: "cluster" }),
		});
		expect(res.status).toBe(400);
		const body: unknown = await res.json();
		expect(body).toEqual({ error: expect.stringContaining("alethia_project (reserved") });
		expect(db.inserted).toBeUndefined();
	});

	it("PATCH .../components/databases/main", async () => {
		db.stored = { cloud_identity_id: null, provider_config: {} };
		const res = await updateRoute.PATCH(request("PATCH", { fields: { provider_config: { rds_allowed_cidr_blocks: "10.0.0.0/16" } } }), {
			params: Promise.resolve({ id: PROJ_ID, kind: "databases", name: "main" }),
		});
		expect(res.status).toBe(400);
		const body: unknown = await res.json();
		expect(body).toEqual({ error: expect.stringContaining("rds_allowed_cidr_blocks must be a list") });
		expect(db.updated).toBeUndefined();
	});

	it("POST accepts a settable knob and returns the merged config", async () => {
		db.stored = { cloud_identity_id: null, provider_config: { eks_volume_type: "gp3" } };
		const res = await addRoute.POST(request("POST", { fields: { provider_config: { eks_volume_iops: 4000 } } }), {
			params: Promise.resolve({ id: PROJ_ID, kind: "cluster" }),
		});
		expect(res.status).toBe(201);
		expect(db.conflictSet?.provider_config).toEqual({ eks_volume_type: "gp3", eks_volume_iops: 4000 });
	});
});

describe("the published component schema advertises provider_config", () => {
	const withColumn = [
		"cluster",
		"dns",
		"observability",
		"databases",
		"caches",
		"queues",
		"topics",
		"nosql_tables",
		"container_registries",
		"helm_registries",
		"secrets",
		"storage_buckets",
	];

	it.each(withColumn)("%s publishes provider_config as an object field", (kind) => {
		const entry = componentSchemaDocument().kinds.find((k) => k.kind === kind);
		expect(entry?.fields).toContain("provider_config");
		const props = entry?.schema.properties;
		expect(props).toMatchObject({ provider_config: { type: "object" } });
	});

	it.each(["network", "repositories"])("%s has no column and does not publish it", (kind) => {
		const entry = componentSchemaDocument().kinds.find((k) => k.kind === kind);
		expect(entry?.fields).not.toContain("provider_config");
		const r = validateComponentFields(kind, { provider_config: { a: 1 } });
		expect(r).toEqual({
			ok: false,
			error: expect.stringContaining(`${kind} has no provider_config column`),
		});
	});

	// What alethia.yaml validates against (apps/cli/pkg/manifest/validate.go reads `fields`): the
	// route's own body, so a nested `provider_config:` mapping is a known field in the file.
	it("GET /api/cli/schema/components serves provider_config in cluster's fields", async () => {
		const res = await schemaRoute.GET(new Request("http://x/api/cli/schema/components"));
		expect(res.status).toBe(200);
		const body: unknown = await res.json();
		expect(body).toMatchObject({
			kinds: expect.arrayContaining([
				expect.objectContaining({ kind: "cluster", fields: expect.arrayContaining(["provider_config"]) }),
			]),
		});
	});

	it("refuses a provider_config that is not an object before any cloud is consulted", () => {
		expect(validateComponentFields("cluster", { provider_config: "x" }).ok).toBe(false);
		expect(validateComponentFields("cluster", { provider_config: ["x"] }).ok).toBe(false);
	});
});
