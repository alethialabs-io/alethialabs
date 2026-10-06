// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The pure half of the #5565 write guard: which `provider_config` keys of a design are credentials,
// and when a design carrying one is refused. The write actions that call it are pinned in
// tests/actions/projects.test.ts.

import { describe, expect, it } from "vitest";
import {
	type CredentialEntry,
	credentialKeyCounts,
	credentialKeysInDesign,
	credentialRefusal,
	isCredentialKey,
	providerConfigKeyCountSql,
} from "@/lib/cloud-providers/credential-knobs";

/** A design with one database and one secret, each carrying the given provider_config. */
function design(db: Record<string, unknown>, secret: Record<string, unknown> = {}) {
	return {
		project: { project_name: "shop" },
		cluster: { provider_config: { eks_ami_type: "AL2023_x86_64_STANDARD" } },
		dns: { enabled: false },
		databases: [{ name: "orders", engine: "postgres", provider_config: db }],
		secrets: [{ name: "api-key", provider_config: secret }],
	};
}

const CREDS = { username: "reporting", database: "orders", password: "hunter2" };

describe("isCredentialKey", () => {
	it("knows the two credential knobs the canvas used to offer", () => {
		expect(isCredentialKey("database", "rds_extra_credentials")).toBe(true);
		expect(isCredentialKey("secret", "value")).toBe(true);
	});

	it("a credential word in the name is enough, declared or not", () => {
		expect(isCredentialKey("cluster", "hcloud_token")).toBe(true);
		expect(isCredentialKey("cache", "redis_password")).toBe(true);
	});

	it("leaves ordinary knobs alone", () => {
		expect(isCredentialKey("database", "rds_default_username")).toBe(false);
		expect(isCredentialKey("cluster", "external_secrets_service_account_email")).toBe(false);
		// `value` is a secret's own material, not a credential on any other kind.
		expect(isCredentialKey("bucket", "value")).toBe(false);
	});
});

describe("credentialKeysInDesign", () => {
	it("finds each credential with its component, and nothing else", () => {
		const found = credentialKeysInDesign(design({ rds_extra_credentials: CREDS }, { value: "s3cr3t", keepers: {} }));
		expect(found.map(({ kind, component, key }) => ({ kind, component, key }))).toEqual([
			{ kind: "database", component: "orders", key: "rds_extra_credentials" },
			{ kind: "secret", component: "api-key", key: "value" },
		]);
	});

	it("a null value is a removal, not a credential", () => {
		expect(credentialKeysInDesign(design({ rds_extra_credentials: null }))).toEqual([]);
	});
});

describe("credentialRefusal", () => {
	it("refuses a credential, naming the component and the key and never the value", () => {
		const refusal = credentialRefusal(design({ rds_extra_credentials: CREDS }), []);
		expect(refusal).toContain('database "orders": rds_extra_credentials');
		expect(refusal).toContain("AWS Secrets Manager");
		expect(refusal).not.toContain("hunter2");
	});

	it("passes a design with no credential key", () => {
		expect(credentialRefusal(design({ rds_default_username: "svc" }), [])).toBeNull();
	});

	it("lets an unchanged value already stored in the project through, whatever its key order", () => {
		const stored: CredentialEntry[] = [
			{
				kind: "database",
				component: "database",
				key: "rds_extra_credentials",
				value: { password: "hunter2", database: "orders", username: "reporting" },
			},
		];
		expect(credentialRefusal(design({ rds_extra_credentials: CREDS }), stored)).toBeNull();
	});

	it("refuses a CHANGED value even when an older one is stored", () => {
		const stored: CredentialEntry[] = [{ kind: "database", component: "database", key: "rds_extra_credentials", value: CREDS }];
		const changed = design({ rds_extra_credentials: { ...CREDS, password: "hunter3" } });
		expect(credentialRefusal(changed, stored)).toContain("rds_extra_credentials");
	});

	it("a stored value on one kind does not excuse the same key on another", () => {
		const stored: CredentialEntry[] = [{ kind: "secret", component: "secret", key: "value", value: "s3cr3t" }];
		expect(credentialRefusal(design({}, { value: "s3cr3t" }), stored)).toBeNull();
		expect(credentialRefusal({ caches: [{ name: "c", provider_config: { value: "s3cr3t", auth_token: "x" } }] }, stored)).toContain(
			"auth_token",
		);
	});
});

describe("the audit:credential-knobs query (#5565 item 3)", () => {
	it("reads key names and counts, and never selects a provider_config value", () => {
		const sql = providerConfigKeyCountSql("project_databases");
		expect(sql).toContain('public."project_databases"');
		expect(sql).toContain("jsonb_object_keys");
		// The select list is the key, two counts — nothing that dereferences the JSONB.
		const selectList = sql.slice(sql.indexOf("select") + 6, sql.indexOf("from")).trim();
		expect(selectList).toBe("k as key, count(*)::int as rows, count(distinct t.project_id)::int as projects");
		expect(sql).not.toMatch(/->|#>|\bvalue\b/);
		expect(sql).not.toMatch(/\b(delete|update|insert|drop|alter)\b/i);
	});

	it("reports only the credential keys of a kind's tallies", () => {
		const counts = [
			{ key: "rds_default_username", rows: 4, projects: 2 },
			{ key: "rds_extra_credentials", rows: 3, projects: 1 },
		];
		expect(credentialKeyCounts("database", counts)).toEqual([{ key: "rds_extra_credentials", rows: 3, projects: 1 }]);
		expect(credentialKeyCounts("secret", [{ key: "value", rows: 1, projects: 1 }])).toHaveLength(1);
	});
});
