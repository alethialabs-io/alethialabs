// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for lib/cloud-providers/connections.ts. The only boundaries stubbed are
// the service DB (a thenable drizzle-ish chain whose query results are a per-test FIFO queue), the
// alerts emitter, the scaler notifier, and the secret-encryptor. Everything else — the pure ARN /
// WIF / GUID parsers, the per-provider toStatus mapping, the credential/config-snapshot builders,
// and the connected/revoked alert branching — runs for real. We assert the persisted `.set()` /
// inserted `.values()` payloads, the returned shapes, and which boundary fired with what.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/crypto/secrets", () => ({
	encryptSecret: vi.fn((v: unknown) => `ENC::${JSON.stringify(v)}`),
}));

import {
	disconnectIdentity,
	finalizeConnectionTest,
	getStatus,
	initIdentity,
	listIdentities,
	parseAwsRoleArn,
	parseWifConfig,
	renameIdentity,
	requeueConnectionTest,
	saveAlibabaIdentity,
	saveAwsIdentity,
	saveAzureIdentity,
	saveGcpIdentity,
	saveSelfManagedTokenIdentity,
	saveTokenCloudIdentity,
	verifyIdentity,
} from "@/lib/cloud-providers/connections";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getServiceDb } from "@/lib/db";
import { notifyScaler } from "@/lib/scaler";
import { encryptSecret } from "@/lib/crypto/secrets";

const SCOPE = { userId: "user-1", orgId: "org-1" };

/**
 * Builds a thenable drizzle-ish db. Every terminal await (a chain `.then`, or `.execute`)
 * dequeues the next pushed result, so distinct queries inside one SUT call resolve to
 * distinct rows in call order. `.set()` / `.values()` payloads are captured for assertions.
 */
function makeDb() {
	const results: unknown[] = [];
	const sets: Record<string, unknown>[] = [];
	const values: Record<string, unknown>[] = [];
	const executes: unknown[] = [];
	function chain(): Record<string, unknown> {
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			select: () => c,
			from: () => c,
			where: () => c,
			limit: () => c,
			orderBy: () => c,
			set: (v: Record<string, unknown>) => {
				sets.push(v);
				return c;
			},
			values: (v: Record<string, unknown>) => {
				values.push(v);
				return c;
			},
			returning: () => c,
			then: (resolve: (v: unknown) => void) => resolve(results.shift()),
		});
		return c;
	}
	return {
		select: () => chain(),
		insert: () => chain(),
		update: () => chain(),
		execute: (arg: unknown) => {
			executes.push(arg);
			return Promise.resolve(results.shift());
		},
		_results: results,
		_sets: sets,
		_values: values,
		_executes: executes,
	};
}

let db: ReturnType<typeof makeDb>;

/** Enqueue query results in the order the SUT will await them. */
function queue(...rows: unknown[]) {
	db._results.push(...rows);
}

beforeEach(() => {
	vi.clearAllMocks();
	db = makeDb();
	vi.mocked(getServiceDb).mockReturnValue(db as never);
});

// --- pure parsers ---

describe("parseAwsRoleArn", () => {
	it("extracts the 12-digit account id from a valid role ARN", () => {
		expect(parseAwsRoleArn("arn:aws:iam::123456789012:role/AlethiaRole")).toEqual({
			accountId: "123456789012",
		});
	});

	it("throws on a non-role / malformed ARN", () => {
		expect(() => parseAwsRoleArn("arn:aws:iam::123:user/foo")).toThrow(/Invalid format/);
		expect(() => parseAwsRoleArn("not-an-arn")).toThrow(/Invalid format/);
	});
});

describe("parseWifConfig", () => {
	const validWif = JSON.stringify({
		type: "external_account",
		audience:
			"//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/pool/providers/prov",
		service_account_impersonation_url:
			"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/my-sa@my-project.iam.gserviceaccount.com:generateAccessToken",
		credential_source: { url: "https://example.com" },
	});

	it("extracts project number, SA email, and derives project id from the SA domain", () => {
		const r = parseWifConfig(validWif);
		expect(r.projectNumber).toBe("123456789");
		expect(r.serviceAccountEmail).toBe("my-sa@my-project.iam.gserviceaccount.com");
		expect(r.projectId).toBe("my-project");
		expect(r.parsed.type).toBe("external_account");
	});

	it("rejects invalid JSON", () => {
		expect(() => parseWifConfig("{not json")).toThrow(/Invalid JSON/);
	});

	it("rejects a non external_account credential type", () => {
		expect(() => parseWifConfig(JSON.stringify({ type: "service_account" }))).toThrow(
			/external_account/,
		);
	});

	it("rejects an audience that is not a workload identity pool", () => {
		expect(() =>
			parseWifConfig(
				JSON.stringify({ type: "external_account", audience: "//iam/projects/1" }),
			),
		).toThrow(/Workload Identity Pool/);
	});

	it("rejects when the impersonation url is missing", () => {
		expect(() =>
			parseWifConfig(
				JSON.stringify({
					type: "external_account",
					audience: "//x/workloadIdentityPools/projects/1/p",
				}),
			),
		).toThrow(/service_account_impersonation_url/);
	});
});

// --- initIdentity ---

describe("initIdentity", () => {
	it("reuses an existing pending row without an external id for a non-role cloud", async () => {
		queue([{ id: "ci-gcp" }]);
		const r = await initIdentity(SCOPE, "gcp");
		expect(r).toEqual({ identityId: "ci-gcp" });
		expect(db._values).toHaveLength(0); // no insert
	});

	it("returns the stored external id when a role-cloud pending row already has one", async () => {
		queue([{ id: "ci-aws", credentials: { external_id: "ext-existing" } }]);
		const r = await initIdentity(SCOPE, "aws");
		expect(r).toEqual({ identityId: "ci-aws", externalId: "ext-existing" });
		expect(db._sets).toHaveLength(0); // no backfill update
	});

	it("backfills a missing external id on an existing role-cloud pending row", async () => {
		queue([{ id: "ci-aws", credentials: {} }], []); // select, then update
		const r = await initIdentity(SCOPE, "aws");
		expect(typeof r.externalId).toBe("string");
		expect(r.externalId).toHaveLength(36);
		// the backfilled external_id is exactly what was written
		expect(db._sets[0].credentials).toEqual({ external_id: r.externalId });
	});

	it("creates a fresh pending row with a generated external id for a role cloud", async () => {
		queue([], [{ id: "ci-new" }]); // no existing, then insert returning
		const r = await initIdentity(SCOPE, "aws");
		expect(r.identityId).toBe("ci-new");
		expect(typeof r.externalId).toBe("string");
		const inserted = db._values[0];
		expect(inserted).toMatchObject({
			user_id: "user-1",
			org_id: "org-1",
			scope: "org",
			provider: "aws",
			name: "AWS Connection (Pending)",
			is_verified: false,
		});
		expect(inserted.credentials).toEqual({ external_id: r.externalId });
	});

	it("creates a token-cloud pending row with empty credentials and no external id", async () => {
		queue([], [{ id: "ci-do" }]);
		const r = await initIdentity(SCOPE, "digitalocean");
		expect(r).toEqual({ identityId: "ci-do", externalId: undefined });
		expect(db._values[0].credentials).toEqual({});
	});
});

// --- toStatus via getStatus / listIdentities ---

describe("getStatus / toStatus mapping", () => {
	it("returns disconnected when no verified identity exists", async () => {
		queue([]);
		expect(await getStatus(SCOPE, "aws")).toEqual({ connected: false });
	});

	it("maps an AWS identity to the role-cloud shape", async () => {
		queue([
			{
				id: "ci-1",
				provider: "aws",
				name: "AWS Account (123456789012)",
				is_verified: true,
				credentials: {
					account_id: "123456789012",
					role_arn: "arn:aws:iam::123456789012:role/R",
					external_id: "ext-1",
				},
			},
		]);
		expect(await getStatus(SCOPE, "aws")).toEqual({
			connected: true,
			identityId: "ci-1",
			name: "AWS Account (123456789012)",
			accountId: "123456789012",
			roleArn: "arn:aws:iam::123456789012:role/R",
			externalId: "ext-1",
		});
	});

	it("maps an Azure identity to its GUID triple", async () => {
		queue([
			{
				id: "ci-az",
				provider: "azure",
				name: "Azure Subscription (aaaaaaaa...)",
				is_verified: true,
				credentials: { tenant_id: "t", client_id: "c", subscription_id: "s" },
			},
		]);
		expect(await getStatus(SCOPE, "azure")).toEqual({
			connected: true,
			identityId: "ci-az",
			name: "Azure Subscription (aaaaaaaa...)",
			tenantId: "t",
			clientId: "c",
			subscriptionId: "s",
		});
	});

	it("maps a token cloud, exposing only apiTokenSet/selfManaged (never the token)", async () => {
		queue([
			{
				id: "ci-hz",
				provider: "hetzner",
				name: "Hetzner Connection",
				is_verified: true,
				credentials: { token: "ENC::secret", self_managed: false },
			},
		]);
		const [status] = await listIdentities(SCOPE, "hetzner");
		expect(status).toEqual({
			connected: true,
			identityId: "ci-hz",
			name: "Hetzner Connection",
			apiTokenSet: true,
			selfManaged: false,
		});
		expect(JSON.stringify(status)).not.toContain("secret");
	});
});

// --- renameIdentity ---

describe("renameIdentity", () => {
	it("rejects an empty name before touching the db", async () => {
		await expect(renameIdentity(SCOPE, "ci-1", "   ")).rejects.toThrow(/empty/);
		expect(db._sets).toHaveLength(0);
	});

	it("trims, truncates to 120 chars, and persists", async () => {
		queue([]);
		await renameIdentity(SCOPE, "ci-1", `  ${"x".repeat(200)}  `);
		expect(db._sets[0].name).toBe("x".repeat(120));
	});
});

// --- saveAwsIdentity ---

describe("saveAwsIdentity", () => {
	it("persists the role/account, queues a CONNECTION_TEST, and notifies the scaler", async () => {
		queue(
			[{ id: "ci-1", credentials: { external_id: "ext-1" } }], // loadIdentity
			[], // update
			[{ id: "job-1" }], // queueConnectionTest insert
		);
		const r = await saveAwsIdentity(
			SCOPE,
			"ci-1",
			"arn:aws:iam::123456789012:role/AlethiaRole",
		);
		expect(r).toEqual({ jobId: "job-1", identityId: "ci-1" });

		expect(db._sets[0]).toMatchObject({
			name: "AWS Account (123456789012)",
			is_verified: false,
			status: "testing",
			credentials: {
				external_id: "ext-1",
				role_arn: "arn:aws:iam::123456789012:role/AlethiaRole",
				account_id: "123456789012",
			},
		});
		expect(db._values[0]).toMatchObject({
			user_id: "user-1",
			org_id: "org-1",
			job_type: "CONNECTION_TEST",
			cloud_identity_id: "ci-1",
			status: "QUEUED",
			requires_self_runner: false,
			config_snapshot: {
				role_arn: "arn:aws:iam::123456789012:role/AlethiaRole",
				account_id: "123456789012",
			},
		});
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	it("throws on a malformed ARN before any db write", async () => {
		await expect(saveAwsIdentity(SCOPE, "ci-1", "bad")).rejects.toThrow(/Invalid format/);
		expect(db._sets).toHaveLength(0);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("throws when the identity session is missing", async () => {
		queue([]); // loadIdentity → empty
		await expect(
			saveAwsIdentity(SCOPE, "ci-x", "arn:aws:iam::123456789012:role/R"),
		).rejects.toThrow(/not found/);
	});
});

// --- saveGcpIdentity ---

describe("saveGcpIdentity", () => {
	const validWif = JSON.stringify({
		type: "external_account",
		audience:
			"//iam.googleapis.com/projects/777/locations/global/workloadIdentityPools/p/providers/x",
		service_account_impersonation_url:
			"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@proj.iam.gserviceaccount.com:generateAccessToken",
		credential_source: { url: "u" },
	});

	it("derives the name/credentials from the WIF config and queues a test", async () => {
		queue([{ id: "ci-g", credentials: {} }], [], [{ id: "job-g" }]);
		const r = await saveGcpIdentity(SCOPE, "ci-g", validWif);
		expect(r).toEqual({ jobId: "job-g", identityId: "ci-g" });
		expect(db._sets[0]).toMatchObject({
			name: "GCP Project (proj)",
			credentials: {
				project_id: "proj",
				project_number: "777",
				service_account_email: "sa@proj.iam.gserviceaccount.com",
			},
		});
		expect(db._values[0].config_snapshot).toEqual({
			project_id: "proj",
			project_number: "777",
			service_account_email: "sa@proj.iam.gserviceaccount.com",
		});
	});
});

// --- saveAzureIdentity ---

describe("saveAzureIdentity", () => {
	const G = "12345678-1234-1234-1234-123456789abc";

	it("validates the three GUIDs, names from the subscription prefix, and queues a test", async () => {
		queue([{ id: "ci-az", credentials: {} }], [], [{ id: "job-az" }]);
		const r = await saveAzureIdentity(SCOPE, "ci-az", G, G, G);
		expect(r).toEqual({ jobId: "job-az", identityId: "ci-az" });
		expect(db._sets[0]).toMatchObject({
			name: "Azure Subscription (12345678...)",
			credentials: { tenant_id: G, client_id: G, subscription_id: G },
		});
		expect(db._values[0].config_snapshot).toEqual({
			tenant_id: G,
			client_id: G,
			subscription_id: G,
		});
	});

	it("rejects a bad tenant GUID before any db write", async () => {
		await expect(saveAzureIdentity(SCOPE, "ci-az", "nope", G, G)).rejects.toThrow(
			/Tenant ID/,
		);
		expect(db._sets).toHaveLength(0);
	});

	it("rejects a bad subscription GUID", async () => {
		await expect(saveAzureIdentity(SCOPE, "ci-az", G, G, "nope")).rejects.toThrow(
			/Subscription ID/,
		);
	});
});

// --- saveAlibabaIdentity ---

describe("saveAlibabaIdentity", () => {
	it("parses the RAM role ARN and persists account id", async () => {
		queue([{ id: "ci-al", credentials: {} }], [], [{ id: "job-al" }]);
		const r = await saveAlibabaIdentity(
			SCOPE,
			"ci-al",
			"acs:ram::5123456789012345:role/MyRole",
		);
		expect(r).toEqual({ jobId: "job-al", identityId: "ci-al" });
		expect(db._sets[0]).toMatchObject({
			name: "Alibaba Cloud (5123456789012345)",
			credentials: {
				role_arn: "acs:ram::5123456789012345:role/MyRole",
				account_id: "5123456789012345",
			},
		});
	});

	it("throws on a malformed RAM ARN", async () => {
		await expect(saveAlibabaIdentity(SCOPE, "ci-al", "acs:bad")).rejects.toThrow(
			/Invalid format/,
		);
	});
});

// --- token clouds ---

describe("saveTokenCloudIdentity", () => {
	it("encrypts the token, stores it under credentials.token, and keeps it out of the snapshot", async () => {
		queue([{ id: "ci-do", credentials: {} }], [], [{ id: "job-do" }]);
		const r = await saveTokenCloudIdentity(
			SCOPE,
			"ci-do",
			"digitalocean",
			"  dop_v1_supersecrettoken  ",
		);
		expect(r).toEqual({ jobId: "job-do", identityId: "ci-do" });
		expect(encryptSecret).toHaveBeenCalledWith({ api_token: "dop_v1_supersecrettoken" });
		expect(db._sets[0]).toMatchObject({
			name: "DigitalOcean Connection",
			credentials: { token: 'ENC::{"api_token":"dop_v1_supersecrettoken"}' },
		});
		// snapshot carries only a marker, never the secret
		expect(db._values[0].config_snapshot).toEqual({ token_connection_test: true });
		expect(JSON.stringify(db._values[0].config_snapshot)).not.toContain("supersecret");
	});

	it("rejects a non token-authenticated cloud", async () => {
		await expect(
			saveTokenCloudIdentity(SCOPE, "ci", "aws", "x".repeat(20)),
		).rejects.toThrow(/not a token-authenticated cloud/);
		expect(encryptSecret).not.toHaveBeenCalled();
	});

	it("rejects a too-short token", async () => {
		await expect(
			saveTokenCloudIdentity(SCOPE, "ci", "hetzner", "short"),
		).rejects.toThrow(/Invalid API token/);
	});
});

describe("saveSelfManagedTokenIdentity", () => {
	it("stores no token, marks self_managed, and pins the test to a self runner", async () => {
		queue([{ id: "ci-hz", credentials: { token: "ENC::old" } }], [], [{ id: "job-hz" }]);
		const r = await saveSelfManagedTokenIdentity(SCOPE, "ci-hz", "hetzner");
		expect(r).toEqual({ jobId: "job-hz", identityId: "ci-hz" });
		expect(db._sets[0].credentials).toEqual({ token: null, self_managed: true });
		expect(db._values[0]).toMatchObject({
			requires_self_runner: true,
			config_snapshot: { token_connection_test: true, self_managed: true },
		});
		expect(encryptSecret).not.toHaveBeenCalled();
	});

	it("rejects a non token cloud", async () => {
		await expect(saveSelfManagedTokenIdentity(SCOPE, "ci", "gcp")).rejects.toThrow(
			/not a token-authenticated cloud/,
		);
	});
});

// --- requeueConnectionTest ---

describe("requeueConnectionTest", () => {
	it("rebuilds the AWS snapshot from stored credentials (managed runner)", async () => {
		queue(
			[{ id: "ci-1", provider: "aws", credentials: { role_arn: "arn:x", account_id: "1" } }],
			[],
			[{ id: "job-r" }],
		);
		const r = await requeueConnectionTest(SCOPE, "ci-1");
		expect(r).toEqual({ jobId: "job-r", identityId: "ci-1" });
		expect(db._sets[0]).toMatchObject({ status: "testing", last_error: null });
		expect(db._values[0]).toMatchObject({
			requires_self_runner: false,
			config_snapshot: { role_arn: "arn:x", account_id: "1" },
		});
	});

	it("rebuilds a self-managed token snapshot and re-pins to a self runner", async () => {
		queue(
			[{ id: "ci-2", provider: "hetzner", credentials: { self_managed: true } }],
			[],
			[{ id: "job-r2" }],
		);
		await requeueConnectionTest(SCOPE, "ci-2");
		expect(db._values[0]).toMatchObject({
			requires_self_runner: true,
			config_snapshot: { token_connection_test: true, self_managed: true },
		});
	});
});

// --- finalizeConnectionTest ---

describe("finalizeConnectionTest", () => {
	it("no-ops when the identity row is missing", async () => {
		queue([]);
		await finalizeConnectionTest("ci-missing", true);
		expect(db._sets).toHaveLength(0);
		expect(db._executes).toHaveLength(0);
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("records a failure with the error message and emits no alert", async () => {
		queue([{ status: "testing", org_id: "org-1", provider: "aws" }], []);
		await finalizeConnectionTest("ci-1", false, { errorMessage: "boom" });
		expect(db._sets[0]).toMatchObject({ status: "failed", last_error: "boom" });
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("marks connected and emits the connected alert on the transition", async () => {
		queue([{ status: "testing", org_id: "org-1", provider: "gcp" }], []);
		await finalizeConnectionTest("ci-1", true);
		expect(db._sets[0]).toMatchObject({ is_verified: true, status: "connected" });
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"org-1",
			"system.identity.connected",
			expect.objectContaining({ resource_id: "ci-1", resource_type: "cloud_identity" }),
		);
	});

	it("does not re-emit when the identity was already connected", async () => {
		queue([{ status: "connected", org_id: "org-1", provider: "gcp" }], []);
		await finalizeConnectionTest("ci-1", true);
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("writes cached_resources via raw jsonb sql when a cached payload is provided", async () => {
		queue([{ status: "testing", org_id: "org-1", provider: "aws" }], []);
		await finalizeConnectionTest("ci-1", true, { cached: { vpcs: ["v1"] } });
		expect(db._executes).toHaveLength(1); // raw sql path, not the .set() path
		expect(db._sets).toHaveLength(0);
		expect(emitAlertEventSafe).toHaveBeenCalledTimes(1);
	});
});

// --- verifyIdentity ---

describe("verifyIdentity", () => {
	it("pulls the job's cached_resources and finalizes connected via the raw sql path", async () => {
		queue(
			[{ execution_metadata: { cached_resources: { zones: ["a"] } } }], // job lookup
			[{ status: "testing", org_id: "org-1", provider: "aws" }], // finalize select
			[], // execute
		);
		const r = await verifyIdentity(SCOPE, "ci-1", "job-1");
		expect(r).toEqual({ success: true });
		expect(db._executes).toHaveLength(1);
		expect(emitAlertEventSafe).toHaveBeenCalledTimes(1);
	});

	it("finalizes without a job lookup when no jobId is given", async () => {
		queue([{ status: "testing", org_id: "org-1", provider: "aws" }], []);
		const r = await verifyIdentity(SCOPE, "ci-1");
		expect(r).toEqual({ success: true });
		expect(db._executes).toHaveLength(0); // no cached → plain update path
		expect(db._sets[0]).toMatchObject({ is_verified: true, status: "connected" });
	});
});

// --- disconnectIdentity ---

describe("disconnectIdentity", () => {
	it("preserves the external id for a role cloud, orphans projects, and emits a revoked alert", async () => {
		queue(
			[{ credentials: { external_id: "ext-keep", role_arn: "arn:x" } }], // role-cloud select
			[{ org_id: "org-1" }], // reset update returning
			[], // projects update
		);
		const r = await disconnectIdentity(SCOPE, "ci-1", "aws");
		expect(r).toEqual({ success: true });
		// identity reset (sets[0]) keeps ONLY the external_id
		expect(db._sets[0]).toMatchObject({
			name: "AWS Connection (Pending)",
			status: "pending",
			is_verified: false,
			credentials: { external_id: "ext-keep" },
		});
		expect(db._sets[0].credentials).not.toHaveProperty("role_arn");
		// projects reset (sets[1]) orphans the FK
		expect(db._sets[1]).toEqual({ cloud_identity_id: null });
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"org-1",
			"system.identity.revoked",
			expect.objectContaining({ actor_id: "user-1", resource_id: "ci-1" }),
		);
	});

	it("resets a non-role cloud to empty credentials (no external id lookup)", async () => {
		queue([{ org_id: "org-1" }], []); // no initial select for token clouds
		await disconnectIdentity(SCOPE, "ci-2", "digitalocean");
		expect(db._sets[0].credentials).toEqual({});
		expect(db._sets[0]).toMatchObject({ name: "DigitalOcean Connection (Pending)" });
	});
});
