// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The read-side snapshot filter every user-facing job read goes through (lib/jobs/redact-snapshot.ts).
// The deny-list is ENUMERATED here, not derived from the module: adding or removing a key is a
// decision, and it has to show up in this file's diff.

import { describe, expect, it } from "vitest";
import { TEMPLATE_KNOBS, isCredentialKnob } from "@/lib/cloud-providers/template-knobs";
import {
	DESIGN_CREDENTIAL_KNOB_KEYS,
	JOB_SNAPSHOT_SECRET_KEYS,
	redactJobRow,
	redactJobSnapshot,
} from "@/lib/jobs/redact-snapshot";

/** A value unlikely to occur by accident: a surviving occurrence means the filter missed a key. */
const SENTINEL = "SENTINEL-1c9e0b7a-snapshot";

/** The deny-list as decided. */
const EXPECTED_KEYS = [
	"runner_token",
	"api_token",
	"s3_access_key",
	"s3_secret_key",
	"secret_key",
	"client_secret",
	"private_key",
	"kubeconfig",
	"talosconfig",
	"talos_admin_config",
	"password",
];

describe("JOB_SNAPSHOT_SECRET_KEYS", () => {
	it("is exactly the decided deny-list", () => {
		expect([...JOB_SNAPSHOT_SECRET_KEYS].sort()).toEqual([...EXPECTED_KEYS].sort());
	});
});

describe("DESIGN_CREDENTIAL_KNOB_KEYS", () => {
	it("is the write-time classifier's credential knobs, without the secret's bare `value`", () => {
		const classified = new Set(TEMPLATE_KNOBS.knobs.filter(isCredentialKnob).map((k) => k.name));
		classified.delete("value");
		expect([...DESIGN_CREDENTIAL_KNOB_KEYS].sort()).toEqual([...classified].sort());
	});

	it("covers the cloud-token knobs the templates declare today", () => {
		expect(DESIGN_CREDENTIAL_KNOB_KEYS).toEqual(
			expect.arrayContaining(["hcloud_token", "hetzner_s3_access_key", "hetzner_s3_secret_key"]),
		);
		expect(DESIGN_CREDENTIAL_KNOB_KEYS).not.toContain("value");
	});

	it.each(["hcloud_token", "hetzner_s3_access_key", "hetzner_s3_secret_key"])(
		"drops the design knob %s from an embedded provider_config",
		(key) => {
			const snapshot = { cluster: { provider_config: { [key]: SENTINEL, node_count: 3 } } };
			expect(redactJobSnapshot(snapshot)).toEqual({ cluster: { provider_config: { node_count: 3 } } });
		},
	);
});

describe("redactJobSnapshot", () => {
	it("drops a secret's `value` under provider_config, and keeps `value` anywhere else", () => {
		const snapshot = {
			secrets: [{ name: "db", provider_config: { value: SENTINEL, rotation: 30 } }],
			tags: [{ key: "team", value: "infra" }],
			annotation: { value: "kept" },
			value: "top-level",
		};
		expect(redactJobSnapshot(snapshot)).toEqual({
			secrets: [{ name: "db", provider_config: { rotation: 30 } }],
			tags: [{ key: "team", value: "infra" }],
			annotation: { value: "kept" },
			value: "top-level",
		});
	});

	it.each(EXPECTED_KEYS)("drops %s at the top level, nested, and inside arrays", (key) => {
		const snapshot = {
			runner_id: "r-1",
			[key]: SENTINEL,
			nested: { deeper: { [key]: SENTINEL, keep: "yes" } },
			list: [{ [key]: SENTINEL, name: "a" }, "scalar"],
		};
		const out = redactJobSnapshot(snapshot);
		expect(JSON.stringify(out)).not.toContain(SENTINEL);
		expect(out).toEqual({
			runner_id: "r-1",
			nested: { deeper: { keep: "yes" } },
			list: [{ name: "a" }, "scalar"],
		});
	});

	it("keeps the runner-lifecycle fields the runners page and job detail read", () => {
		const snapshot = {
			runner_id: "r-1",
			runner_token: SENTINEL,
			runner_name: "edge",
			region: "eu-central-1",
			cloud_provider: "aws",
			image_tag: "1.2.3",
			alethia_url: "https://alethialabs.io",
		};
		expect(redactJobSnapshot(snapshot)).toEqual({
			runner_id: "r-1",
			runner_name: "edge",
			region: "eu-central-1",
			cloud_provider: "aws",
			image_tag: "1.2.3",
			alethia_url: "https://alethialabs.io",
		});
	});

	it("matches exact names only: a key that merely contains a credential word is user data", () => {
		const snapshot = {
			databases: [
				{ provider_config: { flags: { password_encryption: "scram-sha-256" } } },
			],
			token_ttl: 30,
			kubeconfig_path: "/etc/k",
		};
		expect(redactJobSnapshot(snapshot)).toEqual(snapshot);
	});

	it("does not modify its input", () => {
		const snapshot = { runner_id: "r-1", runner_token: SENTINEL, nested: { password: SENTINEL } };
		const before = JSON.stringify(snapshot);
		redactJobSnapshot(snapshot);
		expect(JSON.stringify(snapshot)).toBe(before);
	});

	it("answers a non-object snapshot with an empty object", () => {
		expect(redactJobSnapshot(null)).toEqual({});
		expect(redactJobSnapshot([{ runner_token: SENTINEL }])).toEqual({});
		expect(redactJobSnapshot("runner_token")).toEqual({});
	});
});

describe("redactJobRow", () => {
	it("redacts the snapshot and leaves every other column as it was", () => {
		const row = {
			id: "job-1",
			job_type: "DEPLOY_RUNNER",
			execution_metadata: { note: "untouched" },
			config_snapshot: { runner_id: "r-1", runner_token: SENTINEL },
		};
		const out = redactJobRow(row);
		expect(out).toEqual({
			id: "job-1",
			job_type: "DEPLOY_RUNNER",
			execution_metadata: { note: "untouched" },
			config_snapshot: { runner_id: "r-1" },
		});
		expect(row.config_snapshot.runner_token).toBe(SENTINEL);
	});
});
