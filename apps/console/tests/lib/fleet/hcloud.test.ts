// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hetzner FleetProvider (lib/fleet/hcloud.ts). Mocked boundary: global fetch (the Hetzner REST API).
// Pure helpers (config-from-env, cloud-init, create payload) are exercised real; the provider's
// list/create/destroy are driven through getHcloudFleetProvider against canned responses — asserting
// request shape (method/url/headers/body) + response mapping + the !ok error path and 204→null.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
	buildEgressAllowlist,
	getHcloudFleetProvider,
	hcloudConfigFromEnv,
	renderCloudInit,
	serverCreatePayload,
	type HcloudConfig,
} from "@/lib/fleet/hcloud";
import type { FleetTarget } from "@/lib/fleet/types";

// ── env helpers ────────────────────────────────────────────────────────────
const HCLOUD_ENV_KEYS = [
	"HCLOUD_TOKEN",
	"ALETHIA_WEB_ORIGIN",
	"NEXT_PUBLIC_APP_URL",
	"ALETHIA_RUNNER_BOOTSTRAP_TOKEN",
	"HCLOUD_SERVER_TYPE",
	"HCLOUD_IMAGE",
	"HCLOUD_SSH_KEYS",
	"FLEET_RUNNER_IMAGE_TAG",
	"FLEET_RUNNER_SLOTS",
	"FLEET_SANDBOX_CONTAINER",
	"FLEET_SANDBOX_EGRESS_ENFORCED",
	"FLEET_SANDBOX_ENFORCE_MANAGED",
	"FLEET_EGRESS_EXTRA_DOMAINS",
	"FLEET_EGRESS_PROXY_IMAGE",
] as const;

const savedEnv: Record<string, string | undefined> = {};
function snapshotEnv() {
	for (const k of HCLOUD_ENV_KEYS) savedEnv[k] = process.env[k];
}
function restoreEnv() {
	for (const k of HCLOUD_ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
}

// A complete config literal so the pure helpers need no env wiring.
function baseCfg(over: Partial<HcloudConfig> = {}): HcloudConfig {
	return {
		token: "test-token",
		serverType: "cax21",
		image: "ubuntu-24.04",
		sshKeys: ["key-a"],
		defaultImageTag: "latest",
		webOrigin: "https://app.test",
		slots: 2,
		sandboxContainer: false,
		sandboxEgressEnforced: false,
		sandboxEnforceManaged: false,
		egressExtraDomains: [],
		egressProxyImage: "ubuntu/squid:latest",
		...over,
	};
}

const target = (provider = "aws"): FleetTarget => ({ provider } as never);

// ── fetch (Hetzner API) boundary ─────────────────────────────────────────────
const fetchMock = vi.fn();
function jsonRes(body: unknown, status = 200) {
	return { ok: true, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function noContentRes() {
	return {
		ok: true,
		status: 204,
		json: async () => {
			throw new Error("204 has no body");
		},
		text: async () => "",
	};
}
function errRes(status: number, text: string) {
	return { ok: false, status, json: async () => ({}), text: async () => text };
}

beforeAll(() => {
	snapshotEnv();
	// Lock the cached singleton's config with known values (constructed on first use).
	process.env.HCLOUD_TOKEN = "test-token";
	process.env.ALETHIA_WEB_ORIGIN = "https://app.test";
	process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN = "boot-xyz";
	vi.stubGlobal("fetch", fetchMock);
	getHcloudFleetProvider(); // force construction now → cfg.token === "test-token"
});

beforeEach(() => {
	fetchMock.mockReset();
});

afterEach(() => {
	restoreEnv();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("hcloudConfigFromEnv", () => {
	it("throws when an essential var is missing", () => {
		delete process.env.HCLOUD_TOKEN;
		process.env.ALETHIA_WEB_ORIGIN = "https://app.test";
		process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN = "boot-xyz";
		expect(() => hcloudConfigFromEnv()).toThrow(/HCLOUD_TOKEN/);
	});

	it("falls back to NEXT_PUBLIC_APP_URL for the web origin and applies defaults", () => {
		process.env.HCLOUD_TOKEN = "tok";
		delete process.env.ALETHIA_WEB_ORIGIN;
		process.env.NEXT_PUBLIC_APP_URL = "https://fallback.test";
		process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN = "boot";
		delete process.env.HCLOUD_SERVER_TYPE;
		delete process.env.HCLOUD_IMAGE;
		delete process.env.FLEET_RUNNER_IMAGE_TAG;
		delete process.env.HCLOUD_SSH_KEYS;
		delete process.env.FLEET_RUNNER_SLOTS;

		const cfg = hcloudConfigFromEnv();
		expect(cfg.webOrigin).toBe("https://fallback.test");
		expect(cfg.serverType).toBe("cax21");
		expect(cfg.image).toBe("ubuntu-24.04");
		expect(cfg.defaultImageTag).toBe("latest");
		expect(cfg.sshKeys).toEqual([]);
		expect(cfg.slots).toBe(1);
	});

	it("parses HCLOUD_SSH_KEYS (trim + drop empties) and a numeric slots", () => {
		process.env.HCLOUD_TOKEN = "tok";
		process.env.ALETHIA_WEB_ORIGIN = "https://app.test";
		process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN = "boot";
		process.env.HCLOUD_SSH_KEYS = " a , , b ,";
		process.env.FLEET_RUNNER_SLOTS = "4";

		const cfg = hcloudConfigFromEnv();
		expect(cfg.sshKeys).toEqual(["a", "b"]);
		expect(cfg.slots).toBe(4);
	});

	it("defaults slots to 1 when the env value is non-numeric", () => {
		process.env.HCLOUD_TOKEN = "tok";
		process.env.ALETHIA_WEB_ORIGIN = "https://app.test";
		process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN = "boot";
		process.env.FLEET_RUNNER_SLOTS = "not-a-number";
		expect(hcloudConfigFromEnv().slots).toBe(1);
	});

	it("defaults the 3b sandbox flags OFF and reads them when set (config-gated turn-on)", () => {
		process.env.HCLOUD_TOKEN = "tok";
		process.env.ALETHIA_WEB_ORIGIN = "https://app.test";
		process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN = "boot";
		delete process.env.FLEET_SANDBOX_CONTAINER;
		delete process.env.FLEET_SANDBOX_EGRESS_ENFORCED;
		delete process.env.FLEET_SANDBOX_ENFORCE_MANAGED;
		delete process.env.FLEET_EGRESS_EXTRA_DOMAINS;
		delete process.env.FLEET_EGRESS_PROXY_IMAGE;

		const off = hcloudConfigFromEnv();
		expect(off.sandboxContainer).toBe(false);
		expect(off.sandboxEgressEnforced).toBe(false);
		expect(off.sandboxEnforceManaged).toBe(false);
		expect(off.egressExtraDomains).toEqual([]);
		expect(off.egressProxyImage).toBe("ubuntu/squid:latest");

		process.env.FLEET_SANDBOX_CONTAINER = "true";
		process.env.FLEET_SANDBOX_EGRESS_ENFORCED = "1";
		process.env.FLEET_SANDBOX_ENFORCE_MANAGED = "yes";
		process.env.FLEET_EGRESS_EXTRA_DOMAINS = " charts.example.com , , foo.test ";
		process.env.FLEET_EGRESS_PROXY_IMAGE = "ubuntu/squid@sha256:abc";

		const on = hcloudConfigFromEnv();
		expect(on.sandboxContainer).toBe(true);
		expect(on.sandboxEgressEnforced).toBe(true);
		expect(on.sandboxEnforceManaged).toBe(true);
		expect(on.egressExtraDomains).toEqual(["charts.example.com", "foo.test"]);
		expect(on.egressProxyImage).toBe("ubuntu/squid@sha256:abc");
	});
});

describe("renderCloudInit", () => {
	it("pins the runner image to the explicit version and injects the PER-VM bootstrap token", () => {
		const out = renderCloudInit(baseCfg(), "gcp", "v1.2.3", "vm-boot-tok");
		expect(out).toContain("ghcr.io/alethialabs-io/runner-gcp:v1.2.3");
		expect(out).toContain('-e ALETHIA_RUNNER_OPERATOR="managed"');
		expect(out).toContain('-e ALETHIA_WEB_ORIGIN="https://app.test"');
		// The token comes from the per-VM arg (E0 0b), NOT a shared config field.
		expect(out).toContain('-e ALETHIA_RUNNER_BOOTSTRAP_TOKEN="vm-boot-tok"');
		expect(out).toContain('-e ALETHIA_RUNNER_SLOTS="2"');
		expect(out).toContain("#cloud-config");
	});

	it("uses the default image tag when no version is pinned", () => {
		const out = renderCloudInit(baseCfg({ defaultImageTag: "stable" }), "aws", null, "vm-boot-tok");
		expect(out).toContain("ghcr.io/alethialabs-io/runner-aws:stable");
	});

	it("never injects storage master credentials into the fleet (proxy-only state)", () => {
		const out = renderCloudInit(baseCfg(), "azure", null, "vm-boot-tok");
		expect(out).not.toContain("ALETHIA_STORAGE_");
		// The runner still gets what it needs to self-register + reach the console.
		expect(out).toContain('-e ALETHIA_WEB_ORIGIN="https://app.test"');
		expect(out).toContain('-e ALETHIA_RUNNER_BOOTSTRAP_TOKEN="vm-boot-tok"');
	});

	it("with sandboxContainer OFF renders NO 3b machinery (trusted path unchanged)", () => {
		const out = renderCloudInit(baseCfg({ sandboxContainer: false }), "aws", null, "vm-boot-tok");
		expect(out).not.toContain("alethia-egress");
		expect(out).not.toContain("squid");
		expect(out).not.toContain("/dev/fuse");
		expect(out).not.toContain("ALETHIA_SANDBOX_");
		expect(out).not.toContain("HTTP_PROXY");
		// A single docker run, exactly as before.
		expect(out).toContain("docker run -d --init --restart=always --name alethia-runner");
	});
});

describe("renderCloudInit — E0 3b (sandboxContainer ON)", () => {
	const cfg3b = (over: Partial<HcloudConfig> = {}) => baseCfg({ sandboxContainer: true, ...over });

	it("stands up the default-deny egress net + domain-allowlist proxy + container-backend runner", () => {
		const out = renderCloudInit(cfg3b(), "aws", null, "vm-boot-tok");
		// default-deny egress net + bridged forward proxy
		expect(out).toContain("docker network create --internal alethia-egress");
		expect(out).toContain("--name alethia-egress-proxy --network alethia-egress");
		expect(out).toContain("ubuntu/squid:latest");
		expect(out).toContain("docker network connect bridge alethia-egress-proxy");
		// runner: nested-podman flags + on the IMDS-less net
		expect(out).toContain("--network alethia-egress --device /dev/fuse");
		expect(out).toContain("--security-opt seccomp=unconfined");
		expect(out).toContain("--security-opt apparmor=unconfined");
		expect(out).toContain("--security-opt systempaths=unconfined");
		// sandbox + proxy env
		expect(out).toContain('-e ALETHIA_SANDBOX_BACKEND="container"');
		expect(out).toContain('-e ALETHIA_SANDBOX_RUNTIME="podman"');
		expect(out).toContain('-e ALETHIA_SANDBOX_IMAGE="ghcr.io/alethialabs-io/runner-aws:latest"');
		expect(out).toContain('-e ALETHIA_SANDBOX_NETWORK="host"');
		expect(out).toContain('-e HTTP_PROXY="http://alethia-egress-proxy:3128"');
		expect(out).toContain('-e HTTPS_PROXY="http://alethia-egress-proxy:3128"');
		// instance-id passed from the host (runner needs no metadata egress); IMDS belt
		expect(out).toContain('-e ALETHIA_RUNNER_INSTANCE_ID="$INSTANCE_ID"');
		expect(out).toContain("iptables -I DOCKER-USER -d 169.254.169.254 -j DROP");
		// still no storage creds
		expect(out).not.toContain("ALETHIA_STORAGE_");
	});

	it("keeps NO_PROXY minimal — never the metadata IP / link-local / wildcard", () => {
		const out = renderCloudInit(cfg3b(), "gcp", null, "vm-boot-tok");
		expect(out).toContain('-e NO_PROXY="localhost,127.0.0.1"');
		expect(out).not.toMatch(/NO_PROXY="[^"]*169\.254/);
		expect(out).not.toMatch(/NO_PROXY="[^"]*\*/);
	});

	it("gates EGRESS_ENFORCED + ENFORCE_MANAGED behind their own flags (fail-closed until proven)", () => {
		const plain = renderCloudInit(cfg3b(), "aws", null, "t");
		expect(plain).not.toContain("ALETHIA_SANDBOX_EGRESS_ENFORCED");
		expect(plain).not.toContain("ALETHIA_SANDBOX_ENFORCE_MANAGED");

		const enforced = renderCloudInit(
			cfg3b({ sandboxEgressEnforced: true, sandboxEnforceManaged: true }),
			"aws",
			null,
			"t",
		);
		expect(enforced).toContain('-e ALETHIA_SANDBOX_EGRESS_ENFORCED="1"');
		expect(enforced).toContain('-e ALETHIA_SANDBOX_ENFORCE_MANAGED="1"');
	});

	it("renders the squid allowlist with the console origin + per-cloud + extra domains", () => {
		const out = renderCloudInit(
			cfg3b({ egressExtraDomains: ["charts.example.com"] }),
			"alibaba",
			null,
			"t",
		);
		expect(out).toContain("acl allowed dstdomain app.test");
		expect(out).toContain("acl allowed dstdomain .aliyuncs.com");
		expect(out).toContain("acl allowed dstdomain registry.opentofu.org");
		expect(out).toContain("acl allowed dstdomain ghcr.io");
		expect(out).toContain("acl allowed dstdomain charts.example.com");
		expect(out).toContain("http_access deny all");
	});
});

describe("buildEgressAllowlist", () => {
	it("includes console host + base + per-cloud + extras, deduped, no metadata IP", () => {
		const list = buildEgressAllowlist(
			baseCfg({ egressExtraDomains: ["a.test", "a.test"] }),
			"azure",
		);
		expect(list).toContain("app.test"); // console origin host
		expect(list).toContain(".azure.com");
		expect(list).toContain(".microsoftonline.com");
		expect(list).toContain("registry.opentofu.org");
		expect(list).toContain("a.test");
		// deduped
		expect(list.filter((d) => d === "a.test")).toHaveLength(1);
		// the metadata IP is never a domain in the allowlist
		expect(list).not.toContain("169.254.169.254");
	});

	it("returns only base + extras for an unknown provider", () => {
		const list = buildEgressAllowlist(baseCfg(), "digitalocean");
		expect(list).toContain("registry.opentofu.org");
		expect(list).not.toContain(".amazonaws.com");
	});
});

describe("serverCreatePayload", () => {
	it("carries the pool label and version label when versioned", () => {
		const payload = serverCreatePayload(baseCfg(), target("aws"), {
			name: "fleet-aws-abc12345",
			location: "fsn1",
			version: "v9",
			bootstrapToken: "vm-boot-tok",
		});
		expect(payload.name).toBe("fleet-aws-abc12345");
		expect(payload.server_type).toBe("cax21");
		expect(payload.location).toBe("fsn1");
		expect(payload.image).toBe("ubuntu-24.04");
		expect(payload.ssh_keys).toEqual(["key-a"]);
		expect(payload.start_after_create).toBe(true);
		expect(payload.labels).toEqual({
			"alethia-managed": "true",
			"alethia-pool": "aws",
			"alethia-version": "v9",
		});
		expect(String(payload.user_data)).toContain("ghcr.io/alethialabs-io/runner-aws:v9");
	});

	it("omits the version label when version is null", () => {
		const payload = serverCreatePayload(baseCfg(), target("gcp"), {
			name: "n",
			location: "nbg1",
			version: null,
			bootstrapToken: "vm-boot-tok",
		});
		expect(payload.labels).toEqual({ "alethia-managed": "true", "alethia-pool": "gcp" });
	});
});

describe("HcloudFleetProvider.list", () => {
	it("requests the pool label selector and maps servers to ProviderInstances", async () => {
		const created = new Date(Date.now() - 120_000).toISOString();
		fetchMock.mockResolvedValue(
			jsonRes({
				servers: [
					{
						id: 42,
						created,
						labels: { "alethia-version": "v5" },
						datacenter: { location: { name: "fsn1" } },
					},
				],
			}),
		);

		const out = await getHcloudFleetProvider().list(target("aws"));

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			"https://api.hetzner.cloud/v1/servers?label_selector=" +
				encodeURIComponent("alethia-pool=aws"),
		);
		expect(init.method).toBe("GET");
		expect(init.headers.Authorization).toBe("Bearer test-token");

		expect(out).toHaveLength(1);
		expect(out[0].instanceId).toBe("42");
		expect(out[0].location).toBe("fsn1");
		expect(out[0].version).toBe("v5");
		expect(out[0].ageSeconds).toBeGreaterThanOrEqual(119);
		expect(out[0].ageSeconds).toBeLessThanOrEqual(125);
	});

	it("defaults version/location and clamps a future-created age to 0", async () => {
		fetchMock.mockResolvedValue(
			jsonRes({ servers: [{ id: 7, created: new Date(Date.now() + 60_000).toISOString() }] }),
		);
		const out = await getHcloudFleetProvider().list(target("gcp"));
		expect(out[0]).toEqual({ instanceId: "7", location: "", version: null, ageSeconds: 0 });
	});

	it("returns [] when the API body has no servers", async () => {
		fetchMock.mockResolvedValue(jsonRes({}));
		expect(await getHcloudFleetProvider().list(target("azure"))).toEqual([]);
	});
});

describe("HcloudFleetProvider.create", () => {
	it("POSTs a generated server payload built from serverCreatePayload", async () => {
		fetchMock.mockResolvedValue(jsonRes({ server: { id: 1 } }, 201));

		await getHcloudFleetProvider().create(target("aws"), {
			location: "fsn1",
			version: "v3",
			bootstrapToken: "vm-boot-tok",
		});

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.hetzner.cloud/v1/servers");
		expect(init.method).toBe("POST");
		expect(init.headers["Content-Type"]).toBe("application/json");

		const body = JSON.parse(init.body);
		expect(body.name).toMatch(/^fleet-aws-[0-9a-f]{8}$/);
		expect(body.location).toBe("fsn1");
		expect(body.labels["alethia-version"]).toBe("v3");
		expect(body.labels["alethia-pool"]).toBe("aws");
		expect(String(body.user_data)).toContain("runner-aws:v3");
		expect(String(body.user_data)).toContain('-e ALETHIA_RUNNER_BOOTSTRAP_TOKEN="vm-boot-tok"');
	});
});

describe("HcloudFleetProvider.destroy", () => {
	it("DELETEs the server by id and tolerates a 204 (no body)", async () => {
		fetchMock.mockResolvedValue(noContentRes());

		await expect(getHcloudFleetProvider().destroy("99")).resolves.toBeUndefined();

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.hetzner.cloud/v1/servers/99");
		expect(init.method).toBe("DELETE");
		expect(init.body).toBeUndefined();
	});
});

describe("api error handling", () => {
	it("throws with method, path, status, and body text on a non-ok response", async () => {
		fetchMock.mockResolvedValue(errRes(403, "forbidden"));
		await expect(getHcloudFleetProvider().destroy("5")).rejects.toThrow(
			"hcloud DELETE /servers/5 → 403: forbidden",
		);
	});
});
