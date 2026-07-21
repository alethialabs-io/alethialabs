// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
vi.mock("@/lib/crypto/secrets", () => ({
	encryptSecret: vi.fn((v: unknown) => `ENC::${JSON.stringify(v)}`),
}));
// Verification is server-side now: the save fns probe health inline (no runner, no job) and kick off
// the inventory sync in the background. Both boundaries are stubbed; `probeHealth` defaults to CONNECTED.
vi.mock("@/lib/cloud-providers/health", () => ({ probeHealth: vi.fn() }));
vi.mock("@/lib/cloud-providers/inventory", () => ({
	syncCloudInventory: vi.fn(),
	purgeCloudInventory: vi.fn(),
}));
vi.mock("@/lib/cloud-providers/capabilities", () => ({
	hasServerSideCapabilities: vi.fn(() => true),
	syncCloudCapabilities: vi.fn(),
	purgeCloudCapabilities: vi.fn(),
}));
// Observability boundaries: every verify outcome is logged, and a hard failure is reported to PostHog
// Error tracking. Both are stubbed so we can assert they fire without a real logger / PostHog client.
vi.mock("@/lib/observability/log", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/analytics/server", () => ({ captureServerException: vi.fn() }));

import {
	disconnectIdentity,
	getStatus,
	initIdentity,
	listIdentities,
	parseAwsRoleArn,
	parseWifConfig,
	renameIdentity,
	reverifyConnection,
	saveAlibabaIdentity,
	saveAwsIdentity,
	saveAzureIdentity,
	saveGcpIdentity,
	saveTokenCloudIdentity,
} from "@/lib/cloud-providers/connections";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getServiceDb } from "@/lib/db";
import { probeHealth } from "@/lib/cloud-providers/health";
import { encryptSecret } from "@/lib/crypto/secrets";
import { log } from "@/lib/observability/log";
import { captureServerException } from "@/lib/analytics/server";

const SCOPE = { userId: "user-1", orgId: "org-1" };

/** A CONNECTED health probe result (auth ok, no missing permissions). */
const CONNECTED = {
	status: "connected" as const,
	accountId: "acc-123",
	error: null,
	missingPermissions: [] as string[],
};

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
	vi.mocked(probeHealth).mockResolvedValue(CONNECTED);
});

/**
 * Queues the DB results a successful server-side verify awaits AFTER the save fn's own
 * load+credential-update: verifyConnectionInline re-loads the identity, updates its status, then
 * re-loads it once more to seed the background inventory sync. `provider`/`status` shape the alert branch.
 */
function queueVerify(provider: string) {
	queue(
		[{ id: "ci", provider, status: "testing", credentials: {} }], // verify loadIdentity
		[], // status update
		[{ id: "ci", provider, status: "connected", credentials: {} }], // reload for inventory
	);
}

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
	it("reuses an existing pending row without minting anything (non-role cloud)", async () => {
		queue([{ id: "ci-gcp" }]);
		const r = await initIdentity(SCOPE, "gcp");
		expect(r).toEqual({ identityId: "ci-gcp" });
		expect(db._values).toHaveLength(0); // no insert
	});

	it("reuses an existing keyless AWS pending row without minting an external id", async () => {
		// AWS is keyless direct-OIDC now — no ExternalId is minted, backfilled, or returned.
		queue([{ id: "ci-aws", credentials: {} }]);
		const r = await initIdentity(SCOPE, "aws");
		expect(r).toEqual({ identityId: "ci-aws" });
		expect(db._sets).toHaveLength(0); // no backfill update
	});

	it("creates a fresh keyless pending row with empty credentials for AWS (no external id)", async () => {
		queue([], [{ id: "ci-new" }]); // no existing, then insert returning
		const r = await initIdentity(SCOPE, "aws");
		expect(r).toEqual({ identityId: "ci-new" });
		const inserted = db._values[0];
		expect(inserted).toMatchObject({
			user_id: "user-1",
			org_id: "org-1",
			scope: "org",
			provider: "aws",
			name: "AWS Connection (Pending)",
			is_verified: false,
		});
		expect(inserted.credentials).toEqual({});
	});

	it("creates a keyless Alibaba pending row with empty credentials (no external id)", async () => {
		queue([], [{ id: "ci-ali" }]);
		const r = await initIdentity(SCOPE, "alibaba");
		expect(r).toEqual({ identityId: "ci-ali" });
		expect(db._values[0].credentials).toEqual({});
	});

	it("creates a token-cloud pending row with empty credentials and no external id", async () => {
		queue([], [{ id: "ci-do" }]);
		const r = await initIdentity(SCOPE, "digitalocean");
		expect(r).toEqual({ identityId: "ci-do" });
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
	it("persists the role/account, verifies server-side (no job), and returns the status", async () => {
		queue(
			[{ id: "ci-1", provider: "aws", status: "testing", credentials: { external_id: "ext-1" } }], // loadIdentity (save)
			[], // credential update
		);
		queueVerify("aws");
		const r = await saveAwsIdentity(
			SCOPE,
			"ci-1",
			"arn:aws:iam::123456789012:role/AlethiaRole",
		);
		expect(r).toEqual({
			identityId: "ci-1",
			verified: true,
			status: "connected",
			error: null,
			missingPermissions: [],
		});

		// credential update (sets[0]) then the health-result status update (sets[1])
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
		expect(db._sets[1]).toMatchObject({
			is_verified: true,
			status: "connected",
			verified_account_id: "acc-123",
			missing_permissions: [],
		});
		// No job is created — verification is server-side.
		expect(db._values).toHaveLength(0);
		expect(probeHealth).toHaveBeenCalledTimes(1);
	});

	it("returns disconnected (unverified) when the probe fails to authenticate", async () => {
		vi.mocked(probeHealth).mockResolvedValue({
			status: "disconnected",
			accountId: null,
			error: "AssumeRole denied",
			missingPermissions: [],
		});
		queue(
			[{ id: "ci-1", provider: "aws", status: "testing", credentials: {} }], // loadIdentity (save)
			[], // credential update
			[{ id: "ci-1", provider: "aws", status: "testing", credentials: {} }], // verify loadIdentity
			[], // status update
		);
		const r = await saveAwsIdentity(SCOPE, "ci-1", "arn:aws:iam::123456789012:role/R");
		expect(r).toMatchObject({ verified: false, status: "disconnected", error: "AssumeRole denied" });
		expect(db._values).toHaveLength(0);
		// The failure is now observable: a structured error log carrying the provider + real cloud error,
		// and a PostHog Error-tracking exception whose message includes both.
		expect(log.error).toHaveBeenCalledWith(
			"cloud connection verify failed",
			expect.objectContaining({ provider: "aws", status: "disconnected", last_error: "AssumeRole denied" }),
		);
		expect(captureServerException).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("AssumeRole denied") }),
			expect.objectContaining({ props: expect.objectContaining({ provider: "aws" }) }),
		);
	});

	it("throws on a malformed ARN before any db write", async () => {
		await expect(saveAwsIdentity(SCOPE, "ci-1", "bad")).rejects.toThrow(/Invalid format/);
		expect(db._sets).toHaveLength(0);
		expect(probeHealth).not.toHaveBeenCalled();
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

	it("derives the name/credentials from the WIF config and verifies server-side", async () => {
		queue([{ id: "ci-g", provider: "gcp", status: "testing", credentials: {} }], []);
		queueVerify("gcp");
		const r = await saveGcpIdentity(SCOPE, "ci-g", validWif);
		expect(r).toMatchObject({ identityId: "ci-g", verified: true, status: "connected" });
		expect(db._sets[0]).toMatchObject({
			name: "GCP Project (proj)",
			credentials: {
				project_id: "proj",
				project_number: "777",
				service_account_email: "sa@proj.iam.gserviceaccount.com",
			},
		});
		expect(db._values).toHaveLength(0);
	});
});

// --- saveAzureIdentity ---

describe("saveAzureIdentity", () => {
	// Three DISTINCT GUIDs — the tenant, the managed identity's application id and the subscription
	// name three different things. (This fixture used to reuse one GUID for all three, which is
	// precisely the mis-paste that reaches Entra as AADSTS700016 and is now rejected.)
	const TENANT = "12345678-1234-1234-1234-123456789abc";
	const CLIENT = "22222222-2222-4222-8222-222222222222";
	const SUB = "33333333-3333-4333-8333-333333333333";

	it("validates the three GUIDs, names from the subscription prefix, and verifies server-side", async () => {
		queue([{ id: "ci-az", provider: "azure", status: "testing", credentials: {} }], []);
		queueVerify("azure");
		const r = await saveAzureIdentity(SCOPE, "ci-az", TENANT, CLIENT, SUB);
		expect(r).toMatchObject({ identityId: "ci-az", verified: true, status: "connected" });
		expect(db._sets[0]).toMatchObject({
			name: "Azure Subscription (33333333...)",
			credentials: { tenant_id: TENANT, client_id: CLIENT, subscription_id: SUB },
		});
		expect(db._values).toHaveLength(0);
	});

	it("rejects a bad tenant GUID before any db write", async () => {
		await expect(
			saveAzureIdentity(SCOPE, "ci-az", "nope", CLIENT, SUB),
		).rejects.toThrow(/Tenant ID/);
		expect(db._sets).toHaveLength(0);
	});

	it("rejects a bad subscription GUID", async () => {
		await expect(
			saveAzureIdentity(SCOPE, "ci-az", TENANT, CLIENT, "nope"),
		).rejects.toThrow(/Subscription ID/);
	});

	// The reported bug: the connect form's paste parser swapped client ↔ subscription, so the
	// subscription GUID was stored as the application id and Entra answered AADSTS700016. The CLI
	// reaches this action directly, so the check has to live here too — not only in the form.
	it("rejects a Subscription ID pasted into Client ID, before any db write", async () => {
		await expect(
			saveAzureIdentity(SCOPE, "ci-az", TENANT, SUB, SUB),
		).rejects.toThrow(/Subscription ID/);
		expect(db._sets).toHaveLength(0);
	});

	it("rejects a Tenant ID pasted into Client ID, before any db write", async () => {
		await expect(
			saveAzureIdentity(SCOPE, "ci-az", TENANT, TENANT, SUB),
		).rejects.toThrow(/Tenant ID/);
		expect(db._sets).toHaveLength(0);
	});
});

// --- saveAlibabaIdentity ---

describe("saveAlibabaIdentity", () => {
	it("parses the RAM role ARN, persists account id, and verifies server-side (STS)", async () => {
		queue([{ id: "ci-al", provider: "alibaba", status: "testing", credentials: {} }], []);
		queueVerify("alibaba");
		const r = await saveAlibabaIdentity(
			SCOPE,
			"ci-al",
			"acs:ram::5123456789012345:role/MyRole",
		);
		expect(r).toMatchObject({ identityId: "ci-al", verified: true, status: "connected" });
		expect(db._sets[0]).toMatchObject({
			name: "Alibaba Cloud (5123456789012345)",
			credentials: {
				role_arn: "acs:ram::5123456789012345:role/MyRole",
				account_id: "5123456789012345",
			},
		});
		expect(db._values).toHaveLength(0);
	});

	it("throws on a malformed RAM ARN", async () => {
		await expect(saveAlibabaIdentity(SCOPE, "ci-al", "acs:bad")).rejects.toThrow(
			/Invalid format/,
		);
	});
});

// --- token clouds ---

describe("saveTokenCloudIdentity", () => {
	it("encrypts the token, stores it under credentials.token, and verifies server-side", async () => {
		queue([{ id: "ci-do", provider: "digitalocean", status: "testing", credentials: {} }], []);
		queueVerify("digitalocean");
		const r = await saveTokenCloudIdentity(
			SCOPE,
			"ci-do",
			"digitalocean",
			"  dop_v1_supersecrettoken  ",
		);
		expect(r).toMatchObject({ identityId: "ci-do", verified: true, status: "connected" });
		expect(encryptSecret).toHaveBeenCalledWith({ api_token: "dop_v1_supersecrettoken" });
		expect(db._sets[0]).toMatchObject({
			name: "DigitalOcean Connection",
			credentials: { token: 'ENC::{"api_token":"dop_v1_supersecrettoken"}' },
		});
		// No job is created — the token never leaves the console for a runner.
		expect(db._values).toHaveLength(0);
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

// --- reverifyConnection ---

describe("reverifyConnection", () => {
	it("flips to testing, re-probes health, and returns the fresh status (no job)", async () => {
		queue([]); // status→testing update
		queueVerify("aws");
		const r = await reverifyConnection(SCOPE, "ci-1");
		expect(r).toMatchObject({ identityId: "ci-1", verified: true, status: "connected" });
		expect(db._sets[0]).toMatchObject({ status: "testing", last_error: null });
		expect(db._values).toHaveLength(0);
		expect(probeHealth).toHaveBeenCalledTimes(1);
	});
});

// --- disconnectIdentity ---

describe("disconnectIdentity", () => {
	it("clears all credentials for keyless AWS, orphans projects, and emits a revoked alert", async () => {
		queue(
			[{ provider: "aws" }], // provider-assert select (provider only)
			[{ org_id: "org-1" }], // reset update returning
			[], // projects update
		);
		const r = await disconnectIdentity(SCOPE, "ci-1", "aws");
		expect(r).toEqual({ success: true });
		// AWS is keyless — the reset (sets[0]) clears ALL credentials (no ExternalId to preserve).
		expect(db._sets[0]).toMatchObject({
			name: "AWS Connection (Pending)",
			status: "pending",
			is_verified: false,
			credentials: {},
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

	it("resets a non-role cloud to empty credentials (no external id preserved)", async () => {
		queue(
			[{ provider: "digitalocean", credentials: {} }], // provider-assert select (always)
			[{ org_id: "org-1" }], // reset update
			[], // projects update
		);
		await disconnectIdentity(SCOPE, "ci-2", "digitalocean");
		expect(db._sets[0].credentials).toEqual({});
		expect(db._sets[0]).toMatchObject({ name: "DigitalOcean Connection (Pending)" });
	});

	it("throws on a provider mismatch instead of relabeling the wrong row", async () => {
		queue([{ provider: "gcp", credentials: {} }]); // the row is actually gcp
		await expect(disconnectIdentity(SCOPE, "ci-3", "aws")).rejects.toThrow(/provider mismatch/i);
		// No reset was written.
		expect(db._sets.length).toBe(0);
	});
});
