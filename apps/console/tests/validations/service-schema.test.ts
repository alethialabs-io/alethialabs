// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W1 seam — the service/workload form-fragment. Proves the `services[]` contract in
// projectFormSchema parses a full workload + rejects malformed ones (the seam can't pass
// vacuously). Built on a COMPLETE valid form so a rejection is the service's fault, not a
// missing sibling field. The form/AI round-trip + snapshot + Go↔TS parity are the tests lane (#572).
import { describe, expect, it } from "vitest";
import { projectFormSchema } from "@/lib/validations/project-form.schema";

// A complete valid form baseline (mirrors project-form.schema.test.ts) — vary only `services`.
const validForm = {
	project: {
		project_name: "my-project",
		environment_stage: "development" as const,
		region: "eu-west-1",
		cloud_identity_id: "660e8400-e29b-41d4-a716-446655440000",
		iac_version: "1.11.4",
	},
	network: { provision_network: true, cidr_block: "10.0.0.0/16", single_nat_gateway: true },
	cluster: {
		cluster_version: "1.32",
		provider_config: { enable_karpenter: true },
		instance_types: ["t3.medium"],
		node_min_size: 2,
		node_max_size: 5,
		node_desired_size: 2,
	},
	dns: { enabled: false },
	repositories: {},
};

const fullService = {
	name: "api",
	type: "deployment" as const,
	source: { kind: "repo" as const, repo_url: "https://github.com/acme/api", path: "apps/api" },
	build: { dockerfile: "Dockerfile" },
	env: [{ name: "LOG_LEVEL", value: "info" }],
	ports: [{ name: "http", container_port: 8080, protocol: "TCP" as const }],
	replicas: 3,
	resources: {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: { cpu: "500m", memory: "512Mi" },
	},
	probe: { type: "http" as const, path: "/healthz", port: 8080 },
};

const withServices = (services: unknown[]) =>
	projectFormSchema.safeParse({ ...validForm, services });

describe("service form-fragment (W1 seam)", () => {
	it("parses a full workload service", () => {
		const r = withServices([fullService]);
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.services[0].name).toBe("api");
	});

	it("parses a prebuilt-image service (no build)", () => {
		expect(
			withServices([{ ...fullService, source: { kind: "image", image: "ghcr.io/acme/api:1.2.3" } }])
				.success,
		).toBe(true);
	});

	it("defaults type to deployment when omitted", () => {
		const { type: _drop, ...noType } = fullService;
		const r = withServices([noType]);
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.services[0].type).toBe("deployment");
	});

	it("rejects a service with no name", () => {
		const { name: _drop, ...noName } = fullService;
		expect(withServices([noName]).success).toBe(false);
	});

	it("rejects a repo source missing repo_url", () => {
		expect(
			withServices([{ ...fullService, source: { kind: "repo", path: "x" } }]).success,
		).toBe(false);
	});

	it("rejects an out-of-range container_port", () => {
		expect(
			withServices([{ ...fullService, ports: [{ container_port: 70000 }] }]).success,
		).toBe(false);
	});

	it("defaults services to [] when omitted", () => {
		const r = projectFormSchema.safeParse(validForm);
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.services).toEqual([]);
	});

	// #572 — the refuter extension: each contract enum/required-field must actually reject,
	// so the Go side (which switches on these values) can trust the wire never carries them.

	it("rejects an unknown workload type", () => {
		expect(withServices([{ ...fullService, type: "daemonset" }]).success).toBe(false);
	});

	it("rejects an unknown source kind (bad discriminant)", () => {
		expect(
			withServices([{ ...fullService, source: { kind: "registry", image: "x" } }]).success,
		).toBe(false);
	});

	it("rejects an image source missing image", () => {
		expect(withServices([{ ...fullService, source: { kind: "image" } }]).success).toBe(false);
	});

	it("rejects an env var with an empty name", () => {
		expect(
			withServices([{ ...fullService, env: [{ name: "", value: "x" }] }]).success,
		).toBe(false);
	});

	it("rejects an unknown probe type and an out-of-range probe port", () => {
		expect(
			withServices([{ ...fullService, probe: { type: "exec", port: 8080 } }]).success,
		).toBe(false);
		expect(
			withServices([{ ...fullService, probe: { type: "http", port: 0 } }]).success,
		).toBe(false);
	});

	it("rejects partial resources (requests without limits)", () => {
		expect(
			withServices([
				{ ...fullService, resources: { requests: { cpu: "100m", memory: "128Mi" } } },
			]).success,
		).toBe(false);
	});

	it("rejects an unknown port protocol", () => {
		expect(
			withServices([{ ...fullService, ports: [{ container_port: 8080, protocol: "SCTP" }] }])
				.success,
		).toBe(false);
	});
});
