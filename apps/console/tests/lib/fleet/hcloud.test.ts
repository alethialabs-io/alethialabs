// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type HcloudConfig, renderCloudInit, serverCreatePayload } from "@/lib/fleet/hcloud";
import type { FleetSpec } from "@/lib/fleet/types";
import { describe, expect, it } from "vitest";

const cfg: HcloudConfig = {
	token: "tok",
	serverType: "cax21",
	image: "ubuntu-24.04",
	sshKeys: ["deploy"],
	defaultImageTag: "latest",
	webOrigin: "https://app.alethialabs.io",
	bootstrapToken: "boot-secret",
	slots: 2,
	storage: { endpoint: "https://s3", region: "eu", accessKey: "AK", secretKey: "SK" },
};

const spec: FleetSpec = {
	provider: "aws",
	warmMin: 1,
	max: 5,
	slotsPerRunner: 1,
	locations: ["fsn1"],
	minPerLocation: 0,
	surge: 1,
	buffer: 1,
	scaleDownGraceTicks: 5,
	targetVersion: "abc123",
	channel: null,
};

describe("renderCloudInit", () => {
	it("runs the per-cloud runner image at the requested version", () => {
		const ci = renderCloudInit(cfg, "aws", "abc123");
		expect(ci).toContain("ghcr.io/alethialabs-io/runner-aws:abc123");
		expect(ci).toContain("ALETHIA_RUNNER_BOOTSTRAP_TOKEN");
		expect(ci).toContain('-e ALETHIA_RUNNER_SLOTS="2"');
		expect(ci).toContain("docker run -d --init");
	});

	it("falls back to the default image tag when version is null", () => {
		expect(renderCloudInit(cfg, "gcp", null)).toContain("runner-gcp:latest");
	});

	it("omits empty storage env entries", () => {
		const bare = renderCloudInit(
			{ ...cfg, storage: { endpoint: "", region: "", accessKey: "", secretKey: "" } },
			"azure",
			"v9",
		);
		expect(bare).not.toContain("ALETHIA_STORAGE_ENDPOINT");
		expect(bare).toContain("runner-azure:v9");
	});
});

describe("serverCreatePayload", () => {
	it("labels the server for its pool + version and includes cloud-init", () => {
		const p = serverCreatePayload(cfg, spec, { name: "fleet-aws-12ab", location: "nbg1", version: "abc123" });
		expect(p.location).toBe("nbg1");
		expect(p.server_type).toBe("cax21");
		expect(p.labels).toEqual({
			"alethia-managed": "true",
			"alethia-pool": "aws",
			"alethia-version": "abc123",
		});
		expect(String(p.user_data)).toContain("runner-aws:abc123");
	});

	it("omits the version label when version is null", () => {
		const p = serverCreatePayload(cfg, spec, { name: "n", location: "fsn1", version: null });
		expect(p.labels).toEqual({ "alethia-managed": "true", "alethia-pool": "aws" });
	});
});
