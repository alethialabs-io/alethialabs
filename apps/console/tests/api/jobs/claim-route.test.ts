// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins what POST /api/jobs/claim hands a runner BESIDES the job row (#5308). The route decrypts the
// cloud identity and the connector credentials the snapshot references, and each of those is a
// secret leaving the console — so it may leave only for a job type whose allow-list row
// (lib/runners/claim-grants.ts) grants it:
//   - MINT_KUBECONFIG reuses the latest DEPLOY's snapshot (which names a DNS and a registry connector)
//     but reads no connector credential: it gets none, and the console never even decrypts one.
//   - DEPLOY still gets every referenced connector credential and the full cloud identity.
//   - A job type this build does not know gets the row and nothing else.
//
// Every connector secret and the Hetzner S3 secret key are CANARY values, and the mint and unknown
// cases assert on the serialised response text, so a credential smuggled under any other key is caught
// too — not only one under `connector_credentials`.

import { is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	cloudIdentities,
	connectorCredentials,
	jobs,
	runners,
} from "@/lib/db/schema";
import { provisionJobType } from "@/lib/db/schema/enums";
import {
	CLAIM_GRANTS,
	claimGrantFor,
	NO_GRANT,
} from "@/lib/runners/claim-grants";

const verifyRunnerToken = vi.fn();
vi.mock("@/lib/runners/auth", () => ({
	verifyRunnerToken: (req: Request) => verifyRunnerToken(req),
}));
vi.mock("@/lib/runners/snapshot-sig", () => ({ verifySnapshot: () => true }));
vi.mock("@/lib/connectors/health", () => ({ markFailed: vi.fn() }));
vi.mock("@/lib/observability/metrics", () => ({ recordClaimLatency: vi.fn() }));
vi.mock("@/lib/observability/trace", () => ({ markJobSpan: vi.fn() }));

const DNS_CANARY = "CANARY-dns-cloudflare-7f3a";
const REGISTRY_CANARY = "CANARY-registry-dockerhub-91c2";
const S3_CANARY = "CANARY-hetzner-s3-secret-44d0";

/** What each ciphertext decrypts to — the plaintexts the route would release. */
const PLAINTEXT: Record<string, Record<string, string>> = {
	"enc:hcloud": { api_token: "hcloud-api-token" },
	"enc:s3-access": { access_key: "s3-access-key" },
	"enc:s3-secret": { secret_key: S3_CANARY },
	"enc:cloudflare": { api_token: DNS_CANARY },
	"enc:dockerhub": { password: REGISTRY_CANARY },
};
const decryptSecret = vi.fn((ciphertext: string) => PLAINTEXT[ciphertext] ?? {});
vi.mock("@/lib/crypto/secrets", () => ({
	decryptSecret: (ciphertext: string) => decryptSecret(ciphertext),
}));

/** The tables the route read, in order — so a test can prove a query was never issued. */
let tablesRead: unknown[] = [];
/** The rows each table's SELECT resolves to. */
let rowsByTable = new Map<unknown, unknown[]>();
/** The WHERE condition each table's SELECT was given — rendered to SQL by the #5479 tests. */
let whereByTable = new Map<unknown, unknown>();

/**
 * A drizzle stand-in: `from(table)` picks the rows, and both `.limit()` and awaiting `.where()` (the
 * connector query has no limit) resolve to them. `execute` is claim_next_job, answering one id.
 */
function fakeDb() {
	return {
		execute: () => Promise.resolve([{ id: "job-1" }]),
		select: () => ({
			from: (table: unknown) => {
				tablesRead.push(table);
				const rows = rowsByTable.get(table) ?? [];
				const terminal = {
					limit: () => Promise.resolve(rows),
					then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
				};
				const chain = {
					where: (cond: unknown) => {
						whereByTable.set(table, cond);
						return terminal;
					},
					innerJoin: () => chain,
				};
				return chain;
			},
		}),
		update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
	};
}
vi.mock("@/lib/db", () => ({ getServiceDb: () => fakeDb() }));

/** The connector-referencing snapshot a DEPLOY wrote and a MINT_KUBECONFIG reuses. */
const SNAPSHOT = {
	provider: "hetzner",
	dns: { provider: "cloudflare" },
	container_registries: [{ provider: "dockerhub" }],
};

/** Seeds the claimed job (of `jobType`), its Hetzner identity and the two connector credentials. */
function seed(jobType: string, jobOrgId: string | null = "org-1") {
	rowsByTable = new Map<unknown, unknown[]>([
		[runners, [{ cloud_identity_id: null }]],
		[
			jobs,
			[
				{
					id: "job-1",
					job_type: jobType,
					provider: "hetzner",
					user_id: "user-1",
					org_id: jobOrgId,
					cloud_identity_id: "ci-1",
					config_snapshot: SNAPSHOT,
					config_snapshot_sig: null,
					traceparent: null,
					created_at: new Date(),
				},
			],
		],
		[
			cloudIdentities,
			[
				{
					provider: "hetzner",
					credentials: {
						token: "enc:hcloud",
						s3_access_key: "enc:s3-access",
						s3_secret_key: "enc:s3-secret",
					},
				},
			],
		],
		[
			connectorCredentials,
			[
				{
					slug: "cloudflare",
					category: "dns",
					scope: "org",
					credentials: { fields: { zone: "example.com" }, secret: "enc:cloudflare" },
				},
				{
					slug: "dockerhub",
					category: "container_registry",
					scope: "org",
					credentials: { fields: { username: "ci" }, secret: "enc:dockerhub" },
				},
			],
		],
	]);
}

const ClaimBody = z.object({
	cloud_identity: z
		.object({
			api_token: z.string(),
			s3_access_key: z.string(),
			s3_secret_key: z.string(),
		})
		.nullable(),
	connector_credentials: z.array(
		z.object({
			slug: z.string(),
			credentials: z.record(
				z.string(),
				z.string(),
			),
		}),
	),
});

/** Claims a seeded job of `jobType`; returns the parsed body and its raw text. */
async function claim(jobType: string, jobOrgId: string | null = "org-1") {
	seed(jobType, jobOrgId);
	const { POST } = await import("@/app/api/jobs/claim/route");
	const res = await POST(
		new Request("https://console.local/api/jobs/claim", { method: "POST" }),
	);
	expect(res.status).toBe(200);
	const text = await res.text();
	return { body: ClaimBody.parse(JSON.parse(text)), text };
}

beforeEach(() => {
	vi.clearAllMocks();
	tablesRead = [];
	whereByTable = new Map();
	verifyRunnerToken.mockResolvedValue({ runnerId: "runner-1", tokenHash: "h" });
});

describe("POST /api/jobs/claim — per-job-type grants (#5308)", () => {
	it("hands a MINT_KUBECONFIG job no connector credential, and never decrypts one", async () => {
		const { body, text } = await claim("MINT_KUBECONFIG");

		expect(body.connector_credentials).toEqual([]);
		expect(text).not.toContain(DNS_CANARY);
		expect(text).not.toContain(REGISTRY_CANARY);
		expect(tablesRead).not.toContain(connectorCredentials);
		expect(decryptSecret).not.toHaveBeenCalledWith("enc:cloudflare");
		expect(decryptSecret).not.toHaveBeenCalledWith("enc:dockerhub");

		// It does read the cloud identity — the dispatcher activates the Hetzner API token — but not
		// the Object Storage keys, which only the tofu minio provider uses.
		expect(body.cloud_identity?.api_token).toBe("hcloud-api-token");
		expect(body.cloud_identity?.s3_access_key).toBe("");
		expect(body.cloud_identity?.s3_secret_key).toBe("");
		expect(text).not.toContain(S3_CANARY);
		expect(decryptSecret).not.toHaveBeenCalledWith("enc:s3-secret");
	});

	it("still hands a DEPLOY every referenced connector credential and the full identity", async () => {
		const { body } = await claim("DEPLOY");

		const bySlug = new Map(
			body.connector_credentials.map((c) => [c.slug, c.credentials]),
		);
		expect(bySlug.get("cloudflare")).toEqual({
			zone: "example.com",
			api_token: DNS_CANARY,
		});
		expect(bySlug.get("dockerhub")).toEqual({
			username: "ci",
			password: REGISTRY_CANARY,
		});
		expect(body.cloud_identity?.api_token).toBe("hcloud-api-token");
		expect(body.cloud_identity?.s3_secret_key).toBe(S3_CANARY);
	});

	it("hands a job type this build does not know the row and nothing else", async () => {
		const { body, text } = await claim("SOME_FUTURE_JOB");

		expect(body.cloud_identity).toBeNull();
		expect(body.connector_credentials).toEqual([]);
		expect(decryptSecret).not.toHaveBeenCalled();
		expect(tablesRead).not.toContain(cloudIdentities);
		expect(tablesRead).not.toContain(connectorCredentials);
		for (const canary of [DNS_CANARY, REGISTRY_CANARY, S3_CANARY, "hcloud-api-token"]) {
			expect(text).not.toContain(canary);
		}
	});
});

/** The SQL text and parameters of the WHERE the route gave the cloud identity lookup. */
function identityLookup(): { sql: string; params: unknown[] } {
	const cond = whereByTable.get(cloudIdentities);
	if (!is(cond, SQL)) throw new Error("the cloud identity lookup was not given a SQL condition");
	return new PgDialect().sqlToQuery(cond);
}

describe("POST /api/jobs/claim — the identity is bound to the job's tenancy (#5479)", () => {
	it("looks the identity up by id AND the job's org, not by id alone", async () => {
		await claim("DEPLOY");

		const { sql, params } = identityLookup();
		expect(params).toContain("ci-1");
		expect(params).toContain("org-1");
		expect(sql).toContain('"cloud_identities"."org_id"');
	});

	it("admits by authorship only a personal identity or one in the creator's personal org", async () => {
		await claim("DEPLOY");

		const { sql, params } = identityLookup();
		expect(params).toContain("user-1");
		expect(params).toContain("personal");
		expect(sql).toContain('"cloud_identities"."user_id"');
		expect(sql).toContain('"cloud_identities"."scope"');
	});

	it("binds a job with no org by its creator alone", async () => {
		await claim("DEPLOY", null);

		const { params } = identityLookup();
		expect(params).toContain("ci-1");
		expect(params).toContain("user-1");
		expect(params).not.toContain(null);
		expect(params).not.toContain("org-1");
	});
});

describe("CLAIM_GRANTS", () => {
	it("has a row for exactly the provision_job_type values", () => {
		expect(Object.keys(CLAIM_GRANTS).sort()).toEqual(
			[...provisionJobType.enumValues].sort(),
		);
	});

	it("grants connector credentials to exactly the handlers that read them", () => {
		const granted = provisionJobType.enumValues
			.filter((t) => claimGrantFor(t).connectorCredentials)
			.sort();
		expect(granted).toEqual(["CHART_SCAN", "DEPLOY", "DESTROY", "PLAN"]);
	});

	it("answers NO_GRANT for an unknown or empty type", () => {
		expect(claimGrantFor("SOME_FUTURE_JOB")).toEqual(NO_GRANT);
		expect(claimGrantFor("")).toEqual(NO_GRANT);
		expect(claimGrantFor("constructor")).toEqual(NO_GRANT);
	});
});
