// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hetzner FleetProvider (lib/fleet/hcloud.ts). Mocked boundary: global fetch (the Hetzner REST API).
// Pure helpers (config-from-env, cloud-init, create payload) are exercised real; the provider's
// list/create/destroy are driven through getHcloudFleetProvider against canned responses — asserting
// request shape (method/url/headers/body) + response mapping + the !ok error path and 204→null.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
	buildEgressAllowlist,
	buildPlacementAttempts,
	getHcloudFleetProvider,
	hcloudConfigFromEnv,
	renderCloudInit,
	resetServerTypeAvailabilityCacheForTest,
	resolveSshKeyIdsFromKeys,
	serverCreatePayload,
	serverTypeAvailabilityFromTypes,
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
	"HCLOUD_SERVER_TYPES",
	"HCLOUD_FALLBACK_LOCATIONS",
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
		serverTypes: ["cax21"],
		fallbackLocations: [],
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
/** A canned GET /server_types page: each entry offers its type in the given locations (prices[].location). */
function serverTypesRes(offer: Record<string, string[]>) {
	return jsonRes({
		server_types: Object.entries(offer).map(([name, locations]) => ({
			name,
			prices: locations.map((location) => ({ location })),
		})),
		meta: { pagination: { next_page: null } },
	});
}
/** A 422 "unsupported location for server type" — the structural placement miss create() must spill past. */
function unsupportedLocationErr() {
	return errRes(
		422,
		JSON.stringify({ error: { code: "invalid_input", message: "unsupported location for server type" } }),
	);
}

beforeAll(() => {
	snapshotEnv();
	// Lock the cached singleton's config with known values (constructed on first use).
	process.env.HCLOUD_TOKEN = "test-token";
	process.env.ALETHIA_WEB_ORIGIN = "https://app.test";
	process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN = "boot-xyz";
	// Pin the failover config to its defaults so the singleton's create() candidates are deterministic
	// (serverTypes = [cax21, cpx31], fallbackLocations = [nbg1, hel1, ash, hil]).
	delete process.env.HCLOUD_SERVER_TYPE;
	delete process.env.HCLOUD_SERVER_TYPES;
	delete process.env.HCLOUD_FALLBACK_LOCATIONS;
	vi.stubGlobal("fetch", fetchMock);
	getHcloudFleetProvider(); // force construction now → cfg.token === "test-token"
});

beforeEach(() => {
	fetchMock.mockReset();
	// create() now consults a (cached) GET /server_types availability lookup — clear it so each test
	// fully controls that response rather than inheriting a prior test's cached map.
	resetServerTypeAvailabilityCacheForTest();
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

		delete process.env.HCLOUD_SERVER_TYPES;
		delete process.env.HCLOUD_FALLBACK_LOCATIONS;

		const cfg = hcloudConfigFromEnv();
		expect(cfg.webOrigin).toBe("https://fallback.test");
		// Default failover preference: cheap ARM first, x86 fallback.
		expect(cfg.serverTypes).toEqual(["cax21", "cpx31"]);
		expect(cfg.fallbackLocations).toEqual(["nbg1", "hel1", "ash", "hil"]);
		expect(cfg.image).toBe("ubuntu-24.04");
		expect(cfg.defaultImageTag).toBe("latest");
		expect(cfg.sshKeys).toEqual([]);
		expect(cfg.slots).toBe(1);
	});

	it("resolves the server-type preference: HCLOUD_SERVER_TYPES wins, legacy single gets an x86 fallback", () => {
		process.env.HCLOUD_TOKEN = "tok";
		process.env.ALETHIA_WEB_ORIGIN = "https://app.test";
		process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN = "boot";

		// Explicit plural list wins verbatim (order-preserving dedupe).
		process.env.HCLOUD_SERVER_TYPES = "cpx31, cax21 , cpx31";
		expect(hcloudConfigFromEnv().serverTypes).toEqual(["cpx31", "cax21"]);

		// Legacy single type gains the x86 fallback so an existing deploy fails over without a config change.
		delete process.env.HCLOUD_SERVER_TYPES;
		process.env.HCLOUD_SERVER_TYPE = "cax21";
		expect(hcloudConfigFromEnv().serverTypes).toEqual(["cax21", "cpx31"]);

		// A custom fallback-locations list is parsed (trim + drop empties).
		process.env.HCLOUD_FALLBACK_LOCATIONS = " ash , , hil ";
		expect(hcloudConfigFromEnv().fallbackLocations).toEqual(["ash", "hil"]);
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
			serverType: "cax21",
			location: "fsn1",
			version: "v9",
			bootstrapToken: "vm-boot-tok",
			sshKeyIds: [123],
		});
		expect(payload.name).toBe("fleet-aws-abc12345");
		expect(payload.server_type).toBe("cax21");
		expect(payload.location).toBe("fsn1");
		expect(payload.image).toBe("ubuntu-24.04");
		// Resolved numeric ids, never the raw config strings (a bare id sent as a string 404s).
		expect(payload.ssh_keys).toEqual([123]);
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
			serverType: "cax21",
			location: "nbg1",
			version: null,
			bootstrapToken: "vm-boot-tok",
			sshKeyIds: [],
		});
		expect(payload.labels).toEqual({ "alethia-managed": "true", "alethia-pool": "gcp" });
	});
});

describe("resolveSshKeyIdsFromKeys", () => {
	const keys = [
		{ id: 123, name: "prod-key" },
		{ id: 999, name: "debug" },
	];

	it("matches a configured NAME to its numeric id", () => {
		expect(resolveSshKeyIdsFromKeys(["prod-key"], keys)).toEqual({ ids: [123], missing: [] });
	});

	it("matches a numeric-id-as-STRING to the numeric id (not a name lookup — the 404 root cause)", () => {
		expect(resolveSshKeyIdsFromKeys(["123"], keys)).toEqual({ ids: [123], missing: [] });
	});

	it("routes an unknown key to `missing` instead of dropping it silently", () => {
		expect(resolveSshKeyIdsFromKeys(["ghost", "prod-key"], keys)).toEqual({
			ids: [123],
			missing: ["ghost"],
		});
	});

	it("order-preserving dedupes when name + id-string point at the same key", () => {
		expect(resolveSshKeyIdsFromKeys(["prod-key", "123", "debug"], keys)).toEqual({
			ids: [123, 999],
			missing: [],
		});
	});

	it("returns empty for no configured keys", () => {
		expect(resolveSshKeyIdsFromKeys([], keys)).toEqual({ ids: [], missing: [] });
	});
});

describe("HcloudFleetProvider.create — ssh key resolution", () => {
	// The provider caches its config on first construction, so a non-empty HCLOUD_SSH_KEYS needs a
	// FRESH module (the top-level singleton was built with no keys). vi.resetModules() + dynamic import
	// gives us one; the global fetch stub survives the reset. restoreEnv() (afterEach) resets the env.
	async function freshProviderWithKeys(keysCsv: string) {
		vi.resetModules();
		process.env.HCLOUD_TOKEN = "test-token";
		process.env.ALETHIA_WEB_ORIGIN = "https://app.test";
		process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN = "boot-xyz";
		process.env.HCLOUD_SSH_KEYS = keysCsv;
		const mod = await import("@/lib/fleet/hcloud");
		return mod.getHcloudFleetProvider();
	}

	/** GET /ssh_keys → canned keys; POST /servers → placed. */
	function mockSshKeysThenPlace(keys: { id: number; name: string }[]) {
		fetchMock.mockImplementation(async (url: string) =>
			String(url).includes("/ssh_keys")
				? jsonRes({ ssh_keys: keys })
				: jsonRes({ server: { id: 1 } }, 201),
		);
	}

	/** The POST /servers body (the create request, past the GET /ssh_keys lookup). */
	function postBody() {
		const call = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
		return JSON.parse(call![1].body);
	}

	it("resolves configured names + id-strings to numeric ids in the POST payload", async () => {
		mockSshKeysThenPlace([
			{ id: 123, name: "prod-key" },
			{ id: 999, name: "debug" },
		]);
		const provider = await freshProviderWithKeys("prod-key,999");

		await provider.create(target("aws"), {
			location: "fsn1",
			version: "v3",
			bootstrapToken: "vm-boot-tok",
		});

		// A GET /ssh_keys precedes the create; the payload carries numeric ids, never the raw strings.
		expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/ssh_keys"))).toBe(true);
		expect(postBody().ssh_keys).toEqual([123, 999]);
	});

	it("skips an unknown key (does NOT 404 the create) — fail-open on the non-essential ssh convenience", async () => {
		mockSshKeysThenPlace([{ id: 123, name: "prod-key" }]);
		const provider = await freshProviderWithKeys("ghost");

		await expect(
			provider.create(target("aws"), { location: "fsn1", version: null, bootstrapToken: "t" }),
		).resolves.toBeUndefined();

		expect(postBody().ssh_keys).toEqual([]);
	});

	it("fails open when the ssh-key lookup itself errors — still POSTs with no ssh keys", async () => {
		fetchMock.mockImplementation(async (url: string) =>
			String(url).includes("/ssh_keys")
				? errRes(500, "boom")
				: jsonRes({ server: { id: 1 } }, 201),
		);
		const provider = await freshProviderWithKeys("prod-key");

		await expect(
			provider.create(target("aws"), { location: "fsn1", version: null, bootstrapToken: "t" }),
		).resolves.toBeUndefined();

		expect(postBody().ssh_keys).toEqual([]);
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
				encodeURIComponent("alethia-pool=aws") +
				"&per_page=50&page=1",
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

describe("HcloudFleetProvider.list — Hetzner pagination", () => {
	// ids a..b inclusive → the server ids one page holds.
	const range = (a: number, b: number): number[] =>
		Array.from({ length: b - a + 1 }, (_, i) => a + i);
	// A canned GET /servers page: the servers slice + the meta.pagination cursor Hetzner returns.
	const pageRes = (ids: number[], nextPage: number | null) =>
		jsonRes({
			servers: ids.map((id) => ({ id, created: new Date().toISOString() })),
			meta: { pagination: { next_page: nextPage } },
		});

	it("follows next_page across EVERY page (not just the first ≤50 servers)", async () => {
		// page 1 → 50 servers (ids 1..50), next_page=2; page 2 → 10 servers (ids 51..60), next_page=null.
		// Default branch also serves the pre-fix single-request URL (no page param) → 50 servers, proving
		// the RED: without paging, list() returns only page 1 (length 50), truncating the pool.
		fetchMock.mockImplementation(async (url: string) => {
			if (String(url).includes("page=2")) return pageRes(range(51, 60), null);
			return pageRes(range(1, 50), 2);
		});

		const out = await getHcloudFleetProvider().list(target("aws"));

		expect(out).toHaveLength(60);
		const ids = out.map((i) => i.instanceId);
		// Servers past page 1 (ids 51..60) MUST surface — the reaper only ever sees what list() returns,
		// so a truncated list leaves them as permanent billable orphans.
		for (const id of range(51, 60)) expect(ids).toContain(String(id));

		// Exactly two fetches: page=1 then page=2, both label-scoped + per_page=50, no infinite loop.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const urls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(urls[0]).toContain("&per_page=50&page=1");
		expect(urls[1]).toContain("&per_page=50&page=2");
		for (const u of urls) {
			expect(u).toContain(`label_selector=${encodeURIComponent("alethia-pool=aws")}`);
		}
	});

	it("TERMINATES on a misbehaving API that returns a non-increasing/cyclic next_page (no infinite loop)", async () => {
		// A broken API/proxy that always says next_page=1 (cyclic) would spin forever if the loop
		// trusted the page value. The iteration bound + strict-progress guard (next_page must exceed
		// the current page) stops it — otherwise list() wedges the whole 60s scaler tick.
		fetchMock.mockImplementation(async () => pageRes(range(1, 3), 1)); // always claims next_page=1

		const out = await getHcloudFleetProvider().list(target("aws"));

		// Stops after page 1 (next_page=1 is not strictly greater than page=1) → 3 servers, one fetch.
		expect(out).toHaveLength(3);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("makes a SINGLE fetch when the first page is the last (next_page null)", async () => {
		fetchMock.mockImplementation(async () => pageRes([1, 2, 3], null));

		const out = await getHcloudFleetProvider().list(target("gcp"));

		expect(out).toHaveLength(3);
		expect(out.map((i) => i.instanceId)).toEqual(["1", "2", "3"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("HcloudFleetProvider.create", () => {
	it("POSTs a generated server payload built from serverCreatePayload", async () => {
		fetchMock.mockImplementation(async (url: string) =>
			String(url).includes("/server_types")
				? serverTypesRes({ cax21: ["fsn1"] })
				: jsonRes({ server: { id: 1 } }, 201),
		);

		await getHcloudFleetProvider().create(target("aws"), {
			location: "fsn1",
			version: "v3",
			bootstrapToken: "vm-boot-tok",
		});

		// The create is the POST /servers (preceded by the GET /server_types availability lookup).
		const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST")!;
		const [url, init] = post;
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

describe("HcloudFleetProvider.create — failsafe placement", () => {
	/** Hetzner placement/capacity miss (retryable). */
	const placementErr = () =>
		errRes(412, JSON.stringify({ error: { code: "resource_unavailable", message: "error during placement" } }));

	/** POST /servers bodies in call order (skips the GET /server_types availability lookup). */
	function postBodies() {
		return fetchMock.mock.calls
			.filter((c) => c[1]?.method === "POST")
			.map((c) => JSON.parse(c[1].body));
	}

	it("falls back from ARM (cax) to x86 (cpx) when ARM has no capacity", async () => {
		// Both types are offered in EU; every ARM attempt misses (412); the first x86 attempt places.
		fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
			if (String(url).includes("/server_types")) {
				return serverTypesRes({
					cax21: ["fsn1", "nbg1", "hel1"],
					cpx31: ["fsn1", "nbg1", "hel1", "ash", "hil"],
				});
			}
			const body = JSON.parse(init!.body!);
			return String(body.server_type).startsWith("cax") ? placementErr() : jsonRes({ server: { id: 1 } }, 201);
		});

		await expect(
			getHcloudFleetProvider().create(target("aws"), {
				location: "fsn1",
				version: "v3",
				bootstrapToken: "vm-boot-tok",
			}),
		).resolves.toBeUndefined();

		const bodies = postBodies();
		// ARM is tried FIRST (cheapest), at the pool's location.
		expect(bodies[0].server_type).toBe("cax21");
		expect(bodies[0].location).toBe("fsn1");
		// The placed VM is x86 (fell back).
		expect(bodies[bodies.length - 1].server_type).toBe("cpx31");
		// EU-only guard: no ARM attempt is ever aimed at a non-EU DC (ash/hil).
		const armInUs = bodies.some(
			(b) => String(b.server_type).startsWith("cax") && ["ash", "hil"].includes(String(b.location)),
		);
		expect(armInUs).toBe(false);
	});

	it("spills past a 422 'unsupported location for server type' to a later candidate (the #912 fix)", async () => {
		// Availability lookup fails → full offline candidate set. Every ARM pair returns the structural
		// 422; the first x86 pair places. Before the fix the 422 aborted on the FIRST attempt (the bug).
		fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
			if (String(url).includes("/server_types")) return errRes(500, "boom");
			const body = JSON.parse(init!.body!);
			return String(body.server_type).startsWith("cax")
				? unsupportedLocationErr()
				: jsonRes({ server: { id: 1 } }, 201);
		});

		await expect(
			getHcloudFleetProvider().create(target("aws"), {
				location: "fsn1",
				version: null,
				bootstrapToken: "t",
			}),
		).resolves.toBeUndefined();

		const bodies = postBodies();
		expect(bodies[0].server_type).toBe("cax21"); // first (unsupported) pair 422'd — but did NOT abort
		expect(bodies[bodies.length - 1].server_type).toBe("cpx31"); // spilled through to x86
	});

	it("does NOT spill on a non-placement 422 (e.g. bad image) — surfaces it immediately", async () => {
		fetchMock.mockImplementation(async (url: string) =>
			String(url).includes("/server_types")
				? errRes(500, "boom")
				: errRes(422, JSON.stringify({ error: { code: "invalid_input", message: "image not found" } })),
		);
		await expect(
			getHcloudFleetProvider().create(target("aws"), {
				location: "fsn1",
				version: null,
				bootstrapToken: "t",
			}),
		).rejects.toThrow(/image not found/);
		expect(postBodies()).toHaveLength(1); // aborted on the first POST — narrow 422 match, no over-retry
	});

	it("does NOT retry a real (non-placement) error — surfaces it immediately", async () => {
		fetchMock.mockImplementation(async (url: string) =>
			String(url).includes("/server_types")
				? serverTypesRes({ cax21: ["fsn1"], cpx31: ["fsn1"] })
				: errRes(404, JSON.stringify({ error: { code: "not_found", message: "SSH key not found" } })),
		);
		await expect(
			getHcloudFleetProvider().create(target("aws"), {
				location: "fsn1",
				version: null,
				bootstrapToken: "t",
			}),
		).rejects.toThrow(/SSH key not found/);
		expect(postBodies()).toHaveLength(1); // aborted on the first POST, no failover
	});

	it("throws a clear no-capacity error when every candidate is exhausted", async () => {
		fetchMock.mockResolvedValue(placementErr());
		await expect(
			getHcloudFleetProvider().create(target("gcp"), {
				location: "fsn1",
				version: null,
				bootstrapToken: "t",
			}),
		).rejects.toThrow(/no capacity for gcp/);
	});
});

describe("HcloudFleetProvider.create — server-type availability pre-filter", () => {
	/** POST /servers bodies in call order (skips the GET /server_types availability lookup). */
	function postBodies() {
		return fetchMock.mock.calls
			.filter((c) => c[1]?.method === "POST")
			.map((c) => JSON.parse(c[1].body));
	}

	it("only attempts {type,location} pairs Hetzner offers — avoids the 422 before POSTing", async () => {
		// cpx31 is offered ONLY in ash; cax21 nowhere. The default candidate grid (cax21/cpx31 across
		// fsn1+fallbacks) is filtered down to the single supported pair, so we POST cpx31@ash directly.
		fetchMock.mockImplementation(async (url: string) =>
			String(url).includes("/server_types")
				? serverTypesRes({ cpx31: ["ash"] })
				: jsonRes({ server: { id: 1 } }, 201),
		);

		await expect(
			getHcloudFleetProvider().create(target("gcp"), {
				location: "fsn1",
				version: null,
				bootstrapToken: "t",
			}),
		).resolves.toBeUndefined();

		const bodies = postBodies();
		expect(bodies).toHaveLength(1); // no wasted round-trips on unsupported pairs
		expect(bodies[0].server_type).toBe("cpx31");
		expect(bodies[0].location).toBe("ash");
	});

	it("fails open to the full offline candidate set when the availability lookup errors", async () => {
		// /server_types 500s → availability is null → create() must use the offline cross-product, not
		// give up. Every POST placement-misses (412), proving it tried MORE than one candidate.
		const placement412 = errRes(
			412,
			JSON.stringify({ error: { code: "resource_unavailable", message: "error during placement" } }),
		);
		fetchMock.mockImplementation(async (url: string) =>
			String(url).includes("/server_types") ? errRes(500, "boom") : placement412,
		);

		await expect(
			getHcloudFleetProvider().create(target("gcp"), {
				location: "fsn1",
				version: null,
				bootstrapToken: "t",
			}),
		).rejects.toThrow(/no capacity/);

		expect(postBodies().length).toBeGreaterThan(1);
	});
});

describe("serverTypeAvailabilityFromTypes", () => {
	it("folds server_types into name → offered-locations, empty set when a type has no prices", () => {
		const map = serverTypeAvailabilityFromTypes([
			{ name: "cax21", prices: [{ location: "fsn1" }, { location: "hel1" }] },
			{ name: "cpx31", prices: [{ location: "ash" }] },
			{ name: "ccx13", prices: undefined },
		]);
		expect([...(map.get("cax21") ?? [])].sort()).toEqual(["fsn1", "hel1"]);
		expect([...(map.get("cpx31") ?? [])]).toEqual(["ash"]);
		expect(map.get("ccx13")?.size).toBe(0);
	});

	it("defensively skips malformed price entries without throwing", () => {
		const map = serverTypeAvailabilityFromTypes([
			{ name: "cax21", prices: [{ location: "fsn1" }, { nope: true }, null, { location: "" }] },
		]);
		expect([...(map.get("cax21") ?? [])]).toEqual(["fsn1"]);
	});
});

describe("buildPlacementAttempts", () => {
	const TYPES = ["cax21", "cpx31"];
	const LOCS = ["fsn1", "ash"];

	it("offline (no availability): drops ARM outside EU, keeps the rest, ARM-major order", () => {
		expect(buildPlacementAttempts(TYPES, LOCS, null)).toEqual([
			{ serverType: "cax21", location: "fsn1" }, // cax21@ash dropped (non-EU ARM)
			{ serverType: "cpx31", location: "fsn1" },
			{ serverType: "cpx31", location: "ash" },
		]);
	});

	it("with availability: keeps only offered pairs (supersedes the EU heuristic)", () => {
		const avail = new Map([
			["cax21", new Set(["fsn1"])],
			["cpx31", new Set(["ash"])],
		]);
		expect(buildPlacementAttempts(TYPES, LOCS, avail)).toEqual([
			{ serverType: "cax21", location: "fsn1" },
			{ serverType: "cpx31", location: "ash" },
		]);
	});

	it("falls back to the offline set when the availability filter would empty the list (misconfig)", () => {
		const avail = new Map([["cax99", new Set(["fsn1"])]]); // none of TYPES are offered anywhere
		expect(buildPlacementAttempts(TYPES, LOCS, avail)).toEqual(buildPlacementAttempts(TYPES, LOCS, null));
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
