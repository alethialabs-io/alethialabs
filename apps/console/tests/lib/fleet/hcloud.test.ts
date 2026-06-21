// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	computeScaleAction,
	type HcloudConfig,
	renderCloudInit,
	serverCreatePayload,
} from "@/lib/fleet/hcloud";
import { describe, expect, it } from "vitest";

const cfg: HcloudConfig = {
	token: "tok",
	serverType: "cax21",
	location: "fsn1",
	image: "ubuntu-24.04",
	sshKeys: ["deploy"],
	imageTag: "abc123",
	webOrigin: "https://app.alethialabs.io",
	bootstrapToken: "boot-secret",
	slots: 2,
	storage: { endpoint: "https://s3", region: "eu", accessKey: "AK", secretKey: "SK" },
};

describe("computeScaleAction", () => {
	it("creates up to the gap when below desired", () => {
		expect(computeScaleAction(1, 4, 10)).toEqual({ toCreate: 3, toDelete: 0 });
	});
	it("deletes the surplus when above desired", () => {
		expect(computeScaleAction(5, 2, 10)).toEqual({ toCreate: 0, toDelete: 3 });
	});
	it("clamps desired to max", () => {
		expect(computeScaleAction(2, 100, 6)).toEqual({ toCreate: 4, toDelete: 0 });
	});
	it("is steady at target", () => {
		expect(computeScaleAction(3, 3, 10)).toEqual({ toCreate: 0, toDelete: 0 });
	});
});

describe("renderCloudInit", () => {
	const ci = renderCloudInit(cfg, "aws");
	it("runs the per-cloud runner image at the configured tag", () => {
		expect(ci).toContain("ghcr.io/alethialabs-io/runner-aws:abc123");
	});
	it("passes bootstrap + origin + slots so the VM self-registers", () => {
		expect(ci).toContain("ALETHIA_RUNNER_BOOTSTRAP_TOKEN");
		expect(ci).toContain('-e ALETHIA_WEB_ORIGIN="https://app.alethialabs.io"');
		expect(ci).toContain('-e ALETHIA_RUNNER_SLOTS="2"');
		expect(ci).toContain("docker run -d --init");
	});
	it("omits empty storage env entries", () => {
		const bare = renderCloudInit(
			{ ...cfg, storage: { endpoint: "", region: "", accessKey: "", secretKey: "" } },
			"gcp",
		);
		expect(bare).not.toContain("ALETHIA_STORAGE_ENDPOINT");
		expect(bare).toContain("runner-gcp:abc123");
	});
});

describe("serverCreatePayload", () => {
	const p = serverCreatePayload(cfg, "azure", "fleet-azure-12ab34cd");
	it("labels the server for its pool and includes cloud-init", () => {
		expect(p.labels).toEqual({ "alethia-managed": "true", "alethia-pool": "azure" });
		expect(p.server_type).toBe("cax21");
		expect(p.location).toBe("fsn1");
		expect(typeof p.user_data).toBe("string");
		expect(String(p.user_data)).toContain("runner-azure:abc123");
	});
});
