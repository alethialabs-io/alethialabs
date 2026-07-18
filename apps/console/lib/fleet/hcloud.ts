// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hetzner Cloud FleetProvider — primitive list/create/destroy over the Hetzner REST
// API (fetch, no SDK). A Hetzner VM is cheap host compute; cloud-init runs the per-cloud
// runner image (Phase 3) which self-registers via the bootstrap token. The controller
// (plan.ts) owns all diff logic. Live-tested when HCLOUD_TOKEN + a deploy exist;
// pure helpers are unit-tested + the controller is tested via the fake. See dataroom/spec/mvp/26.

import { randomUUID } from "crypto";
import type { FleetProvider, FleetTarget, ProviderInstance } from "@/lib/fleet/types";
import { log } from "@/lib/observability/log";

const HCLOUD_API = "https://api.hetzner.cloud/v1";

const flog = log.child({ component: "fleet" });

/** A non-2xx Hetzner API response, carrying the HTTP status + parsed error `code` so callers can
 *  distinguish a retryable placement/capacity miss (412 / `resource_unavailable`) from a real fault. */
export class HcloudApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string | null,
		message: string,
	) {
		super(message);
		this.name = "HcloudApiError";
	}
}

/** Resolved Hetzner + runner-image config for provisioning a fleet VM. */
export interface HcloudConfig {
	token: string;
	/**
	 * Server-type preference list, tried in order until one PLACES. Prefer cheap ARM (`cax`) and
	 * fall back to x86 (`cpx`) when ARM has no capacity — Hetzner ARM is chronically capacity-
	 * constrained and is EU-only, so a single fixed type strands the whole fleet (`412 error during
	 * placement`). The per-cloud runner images are multi-arch, so any type here can run the runner.
	 */
	serverTypes: string[];
	/**
	 * Locations tried (after the pool's requested location) when the requested one can't place any
	 * server type — lets the fleet spill to a region that has capacity (incl. x86-only US DCs).
	 */
	fallbackLocations: string[];
	image: string;
	sshKeys: string[];
	defaultImageTag: string;
	webOrigin: string;
	slots: number;
	/**
	 * E0 Step 3b — the per-job container sandbox (untrusted BYO). When false (default) the
	 * cloud-init is byte-identical to trusted provisioning today. When true, the VM boots a
	 * default-deny egress net + domain-allowlist forward proxy and starts the runner with the
	 * container backend so each untrusted job runs in a nested rootless-podman container.
	 * Requires a real-VM canary (see managed-provisioning runbook) before it is safe to enable.
	 */
	sandboxContainer: boolean;
	/** Adds ALETHIA_SANDBOX_EGRESS_ENFORCED=1 — set ONLY after the real-VM egress proof; until
	 *  then the container backend fail-closes on managed (proving the runtime without trusting egress). */
	sandboxEgressEnforced: boolean;
	/** Adds ALETHIA_SANDBOX_ENFORCE_MANAGED=1 — the fleet-wide kill-switch so a managed pool that
	 *  LACKS the container backend refuses jobs rather than silently running unsandboxed. */
	sandboxEnforceManaged: boolean;
	/** Extra domains appended to the egress allowlist (FLEET_EGRESS_EXTRA_DOMAINS, comma-separated). */
	egressExtraDomains: string[];
	/** The forward-proxy image (pin a digest in prod). */
	egressProxyImage: string;
}

/** Reads the provider config from env. Throws if the essentials are missing. */
export function hcloudConfigFromEnv(): HcloudConfig {
	const token = process.env.HCLOUD_TOKEN;
	const webOrigin = process.env.ALETHIA_WEB_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL;
	if (!token || !webOrigin) {
		throw new Error(
			"hcloud fleet provider requires HCLOUD_TOKEN and ALETHIA_WEB_ORIGIN",
		);
	}
	return {
		token,
		serverTypes: resolveServerTypes(),
		fallbackLocations: csv(process.env.HCLOUD_FALLBACK_LOCATIONS) ?? DEFAULT_FALLBACK_LOCATIONS,
		image: process.env.HCLOUD_IMAGE ?? "ubuntu-24.04",
		sshKeys: (process.env.HCLOUD_SSH_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
		defaultImageTag: process.env.FLEET_RUNNER_IMAGE_TAG ?? "latest",
		webOrigin,
		slots: Number.parseInt(process.env.FLEET_RUNNER_SLOTS ?? "1", 10) || 1,
		sandboxContainer: envTrue(process.env.FLEET_SANDBOX_CONTAINER),
		sandboxEgressEnforced: envTrue(process.env.FLEET_SANDBOX_EGRESS_ENFORCED),
		sandboxEnforceManaged: envTrue(process.env.FLEET_SANDBOX_ENFORCE_MANAGED),
		egressExtraDomains: (process.env.FLEET_EGRESS_EXTRA_DOMAINS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		egressProxyImage: process.env.FLEET_EGRESS_PROXY_IMAGE ?? "ubuntu/squid:latest",
	};
}

/** Truthy-env helper (1/true/yes/on). */
function envTrue(v: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
}

/** Parse a comma-separated env list → trimmed non-empty items, or undefined if unset/empty. */
function csv(v: string | undefined): string[] | undefined {
	if (v === undefined) return undefined;
	const items = v.split(",").map((s) => s.trim()).filter(Boolean);
	return items.length ? items : undefined;
}

/** Default placement preference: cheap ARM first, x86 fallback. Both run the multi-arch runner image. */
const DEFAULT_SERVER_TYPES = ["cax21", "cpx31"];
/** Extra locations to spill into (after the pool's own) when the primary can't place any type. */
const DEFAULT_FALLBACK_LOCATIONS = ["nbg1", "hel1", "ash", "hil"];
/** Hetzner ARM (`cax*`) is EU-only — skip ARM types in non-EU DCs instead of a guaranteed 412. */
const EU_LOCATIONS = new Set(["fsn1", "nbg1", "hel1"]);

/** Resolve the server-type preference list from env, honouring the legacy single `HCLOUD_SERVER_TYPE`
 *  by appending the x86 fallback so an existing deployment gains failover without a config change. */
function resolveServerTypes(): string[] {
	const explicit = csv(process.env.HCLOUD_SERVER_TYPES);
	if (explicit) return dedupe(explicit);
	const legacy = process.env.HCLOUD_SERVER_TYPE?.trim();
	if (legacy) return dedupe([legacy, "cpx31"]);
	return [...DEFAULT_SERVER_TYPES];
}

/** Order-preserving dedupe. */
function dedupe(xs: string[]): string[] {
	return [...new Set(xs)];
}

/** True for a Hetzner error that means "no capacity here, try elsewhere" (retryable placement). */
function isPlacementError(err: unknown): boolean {
	if (!(err instanceof HcloudApiError)) return false;
	return err.status === 412 || err.code === "resource_unavailable";
}

/** The forward-proxy service name + port the runner (and its nested child) point HTTP(S)_PROXY at. */
const EGRESS_PROXY_URL = "http://alethia-egress-proxy:3128";

/** Domains the untrusted child legitimately reaches regardless of cloud: provider/module
 *  registries + release hosts, Git + Helm-on-Pages, and GHCR (the fleet warms the nested-podman
 *  image store by pulling the runner image). Everything else is default-denied. */
const EGRESS_BASE_DOMAINS = [
	"registry.opentofu.org",
	"registry.terraform.io",
	"releases.hashicorp.com",
	"github.com",
	".githubusercontent.com",
	".github.io",
	"ghcr.io",
	"pkg-containers.githubusercontent.com",
];

/** Per-cloud API domains the provider's tofu/CLI calls reach (a pool is single-provider). */
const EGRESS_PROVIDER_DOMAINS: Record<string, string[]> = {
	aws: [".amazonaws.com"],
	gcp: [".googleapis.com", ".pkg.dev"],
	azure: [".azure.com", ".microsoftonline.com", ".azmk8s.io", ".azurecr.io"],
	alibaba: [".aliyuncs.com"],
	hetzner: ["api.hetzner.cloud", "api.hetznercloud.com"],
};

/** Pure: the domain allowlist for a provider's fleet VM (console origin + base + per-cloud +
 *  operator extras). The 169.254.169.254 metadata service is deliberately NOT a domain here, so
 *  it can never match the forward proxy — IMDS is unreachable by construction. */
export function buildEgressAllowlist(cfg: HcloudConfig, provider: string): string[] {
	let consoleHost = "";
	try {
		consoleHost = new URL(cfg.webOrigin).hostname;
	} catch {
		consoleHost = "";
	}
	const domains = [
		...(consoleHost ? [consoleHost] : []),
		...EGRESS_BASE_DOMAINS,
		...(EGRESS_PROVIDER_DOMAINS[provider] ?? []),
		...cfg.egressExtraDomains,
	];
	return Array.from(new Set(domains));
}

/** Pure: a minimal squid.conf that permits CONNECT/GET only to the allowlisted domains and
 *  default-denies everything else (squid matches HTTPS CONNECT by target host — no TLS interception). */
function renderSquidConf(domains: string[]): string {
	const acl = domains.map((d) => `acl allowed dstdomain ${d}`).join("\n");
	return `http_port 3128
acl SSL_ports port 443
acl Safe_ports port 80
acl Safe_ports port 443
acl CONNECT method CONNECT
${acl}
http_access deny CONNECT !SSL_ports
http_access deny !Safe_ports
http_access allow allowed
http_access deny all
cache deny all
`;
}

/** Serializes an env map to `-e KEY="value"` docker-run flags (JSON-quoted, shell-safe). */
function toEnvFlags(env: Record<string, string>): string {
	return Object.entries(env)
		.filter(([, v]) => v !== "")
		.map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`)
		.join(" ");
}

/** Pure: cloud-init that boots a per-cloud runner (at `version`) which self-registers with its
 *  PER-VM bootstrap token (E0 0b — minted by the scaler, short-TTL, instance-bound).
 *
 *  Two modes, selected by `cfg.sandboxContainer` (FLEET_SANDBOX_CONTAINER):
 *  - OFF (default): the trusted-provisioning cloud-init — a single `docker run` of the runner. This
 *    output is byte-identical to before 3b; today's managed provisioning is unaffected.
 *  - ON (E0 Step 3b, untrusted BYO): additionally stands up a **default-deny egress net**
 *    (`docker network --internal`, no route off the VM) + a **domain-allowlist squid forward proxy**,
 *    and runs the runner ON that net with the container sandbox backend + proxy env. The nested
 *    per-job podman child inherits the runner's IMDS-less netns (ALETHIA_SANDBOX_NETWORK=host), so
 *    169.254.169.254 (which serves the VM userdata) is unreachable and only allowlisted domains
 *    egress. The runner reads its instance-id from an env var (the HOST fetches it from IMDS during
 *    cloud-init) so the runner container itself needs no metadata egress.
 *
 *  The ON path is verifiable only on a real fleet VM (nested rootless podman + /dev/fuse + IMDS
 *  egress can't be reproduced in CI) — see the managed-provisioning runbook's 3b canary. */
export function renderCloudInit(
	cfg: HcloudConfig,
	provider: string,
	version: string | null,
	bootstrapToken: string,
): string {
	const tag = version ?? cfg.defaultImageTag;
	const image = `ghcr.io/alethialabs-io/runner-${provider}:${tag}`;
	const env: Record<string, string> = {
		ALETHIA_WEB_ORIGIN: cfg.webOrigin,
		ALETHIA_RUNNER_OPERATOR: "managed",
		ALETHIA_RUNNER_BOOTSTRAP_TOKEN: bootstrapToken,
		ALETHIA_RUNNER_SLOTS: String(cfg.slots),
		// No ALETHIA_STORAGE_*: runner-lifecycle + project tofu state both go via the console
		// http state proxy, so the fleet holds no storage master credentials (the metadata
		// userdata no longer leaks them).
	};

	if (!cfg.sandboxContainer) {
		const envFlags = toEnvFlags(env);
		return `#cloud-config
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
  - docker run -d --init --restart=always --name alethia-runner ${envFlags} ${image}
`;
	}

	// --- E0 Step 3b: default-deny egress net + domain-allowlist proxy + container sandbox ---
	const sandboxEnv: Record<string, string> = {
		...env,
		ALETHIA_SANDBOX_BACKEND: "container",
		ALETHIA_SANDBOX_RUNTIME: "podman",
		ALETHIA_SANDBOX_IMAGE: image,
		// Child shares the runner container's (IMDS-less, proxy-only) netns.
		ALETHIA_SANDBOX_NETWORK: "host",
		HTTP_PROXY: EGRESS_PROXY_URL,
		HTTPS_PROXY: EGRESS_PROXY_URL,
		// Minimal — NEVER the metadata IP/link-local/wildcard, so nothing bypasses the proxy.
		NO_PROXY: "localhost,127.0.0.1",
	};
	// Set ONLY after the real-VM egress proof; until then the container backend fail-closes on managed.
	if (cfg.sandboxEgressEnforced) sandboxEnv.ALETHIA_SANDBOX_EGRESS_ENFORCED = "1";
	// Fleet-wide kill-switch: a managed pool without the container backend refuses jobs.
	if (cfg.sandboxEnforceManaged) sandboxEnv.ALETHIA_SANDBOX_ENFORCE_MANAGED = "1";

	const envFlags = toEnvFlags(sandboxEnv);
	const runFlags =
		"--network alethia-egress --device /dev/fuse " +
		"--security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined";
	const squid = renderSquidConf(buildEgressAllowlist(cfg, provider))
		.split("\n")
		.map((l) => (l.length ? `      ${l}` : ""))
		.join("\n");

	return `#cloud-config
write_files:
  - path: /etc/alethia/squid.conf
    permissions: "0644"
    content: |
${squid}
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
  # Instance-id for the per-VM bootstrap-token binding (0b): the HOST reaches IMDS here; it is
  # passed to the runner container so the container itself never needs metadata egress.
  - INSTANCE_ID=$(curl -fsS --max-time 3 http://169.254.169.254/hetzner/v1/metadata/instance-id || hostname)
  # Belt: drop the metadata IP from all container traffic regardless of network config.
  - iptables -I DOCKER-USER -d 169.254.169.254 -j DROP || true
  # Default-deny egress net (no route off the VM) + the domain-allowlist forward proxy (bridged out).
  - docker network create --internal alethia-egress || true
  - docker run -d --restart=always --name alethia-egress-proxy --network alethia-egress -v /etc/alethia/squid.conf:/etc/squid/squid.conf:ro ${cfg.egressProxyImage}
  - docker network connect bridge alethia-egress-proxy || true
  # Runner on the IMDS-less net + proxy env → its own egress is domain-restricted; the nested child inherits this netns.
  - docker run -d --init --restart=always --name alethia-runner ${runFlags} -e ALETHIA_RUNNER_INSTANCE_ID="$INSTANCE_ID" ${envFlags} ${image}
  # Warm the nested-podman image store (one-time, multi-GB via the proxy — ghcr.io is allowlisted).
  - docker exec alethia-runner podman pull ${image} || true
`;
}

/** Pure: the Hetzner POST /servers payload for a fleet VM (labels carry pool + version). */
export function serverCreatePayload(
	cfg: HcloudConfig,
	project: FleetTarget,
	opts: {
		name: string;
		serverType: string;
		location: string;
		version: string | null;
		bootstrapToken: string;
	},
): Record<string, unknown> {
	const labels: Record<string, string> = {
		"alethia-managed": "true",
		"alethia-pool": project.provider,
	};
	if (opts.version) labels["alethia-version"] = opts.version;
	return {
		name: opts.name,
		server_type: opts.serverType,
		location: opts.location,
		image: cfg.image,
		ssh_keys: cfg.sshKeys,
		start_after_create: true,
		labels,
		user_data: renderCloudInit(cfg, project.provider, opts.version, opts.bootstrapToken),
	};
}

interface HcloudServer {
	id: number;
	created: string;
	labels?: Record<string, string>;
	datacenter?: { location?: { name?: string } };
}

/** Hetzner list-endpoint pagination cursor. The API paginates GET /servers (default per_page=25,
 *  max 50) and returns `next_page` = the next page number, or `null` on the last page. */
interface HcloudPagination {
	next_page: number | null;
}

/** One page of a GET /servers response: the servers slice + the pagination cursor. */
interface HcloudServerListResponse {
	servers: HcloudServer[];
	nextPage: HcloudPagination["next_page"];
}

/** Hetzner caps per_page at 50; request the max so a pool pages in as few round-trips as possible. */
const HCLOUD_LIST_PER_PAGE = 50;

/** Hard runaway stop for the pagination loop (50 * 1000 = 50k servers — far beyond any real pool);
 *  guards against a misbehaving API that never returns next_page=null. */
const HCLOUD_LIST_MAX_PAGES = 1000;

/** Narrows an unknown value to an indexable object (so nested fields can be read as `unknown`). */
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/** Narrows an unknown value to an array of unknowns (avoids `any[]` from Array.isArray). */
function isUnknownArray(v: unknown): v is unknown[] {
	return Array.isArray(v);
}

/** Type-guard for a Hetzner server object — validates only the fields list() maps that must exist;
 *  optional labels/datacenter are read defensively in the map, so a partial entry is skipped, not thrown. */
function isHcloudServer(v: unknown): v is HcloudServer {
	return isRecord(v) && typeof v.id === "number" && typeof v.created === "string";
}

/** Defensively narrows an unknown Hetzner list body into a typed page. A missing/malformed
 *  meta.pagination degrades to nextPage=null (treated as the last page — the loop never spins). */
function parseServerListPage(body: unknown): HcloudServerListResponse {
	const servers =
		isRecord(body) && isUnknownArray(body.servers) ? body.servers.filter(isHcloudServer) : [];
	let nextPage: HcloudPagination["next_page"] = null;
	if (isRecord(body) && isRecord(body.meta) && isRecord(body.meta.pagination)) {
		const next = body.meta.pagination.next_page;
		if (typeof next === "number") nextPage = next;
	}
	return { servers, nextPage };
}

class HcloudFleetProvider implements FleetProvider {
	private readonly cfg = hcloudConfigFromEnv();

	async list(project: FleetTarget): Promise<ProviderInstance[]> {
		const selector = encodeURIComponent(`alethia-pool=${project.provider}`);
		// Hetzner paginates GET /servers — follow meta.pagination.next_page until it is null so that
		// plan/reap see EVERY server. A truncated list would under-count the pool (the scaler keeps
		// emitting scale-up creates unbounded) AND hide servers past page 1 from reaping (permanent
		// billable orphans). Keep the label selector on every page.
		const servers: HcloudServer[] = [];
		let page = 1;
		// Bound the loop by ITERATION COUNT, not by the page value: a misbehaving API/proxy that
		// returns a constant (always 2) or cyclic (1↔2) next_page keeps `page` below any page-number
		// cap forever. Also require STRICT progress (next_page must exceed the current page) so such
		// a response terminates instead of spinning list() — which, awaited inside the 60s scaler
		// tick, would wedge scale-up AND reaping across every pool.
		for (let i = 0; i < HCLOUD_LIST_MAX_PAGES; i++) {
			const body = await this.api(
				"GET",
				`/servers?label_selector=${selector}&per_page=${HCLOUD_LIST_PER_PAGE}&page=${page}`,
			);
			const parsed = parseServerListPage(body);
			servers.push(...parsed.servers);
			if (parsed.nextPage === null || parsed.nextPage <= page) break;
			page = parsed.nextPage;
		}
		const now = Date.now();
		return servers.map((s) => ({
			instanceId: String(s.id),
			location: s.datacenter?.location?.name ?? "",
			version: s.labels?.["alethia-version"] ?? null,
			ageSeconds: Math.max(0, Math.floor((now - Date.parse(s.created)) / 1000)),
		}));
	}

	async create(
		project: FleetTarget,
		opts: { location: string; version: string | null; bootstrapToken?: string },
	): Promise<void> {
		if (!opts.bootstrapToken) {
			throw new Error("hcloud create requires a per-VM bootstrapToken (E0 0b)");
		}
		const name = `fleet-${project.provider}-${randomUUID().slice(0, 8)}`;
		// Failsafe placement: try each server type (cheap ARM first, x86 fallback) across the pool's
		// location then the fallback locations, until one PLACES. A `412 error during placement`
		// (ARM/region out of capacity) advances to the next candidate; any other error is a real
		// failure and aborts. First success wins — so a healthy pool with ARM capacity is unchanged,
		// and a fleet only spills to x86/other DCs when it genuinely must.
		const locations = dedupe([opts.location, ...this.cfg.fallbackLocations]);
		const attempts: { serverType: string; location: string }[] = [];
		for (const serverType of this.cfg.serverTypes) {
			for (const location of locations) {
				// Hetzner ARM is EU-only — don't burn a create round-trip on a guaranteed placement miss.
				if (serverType.startsWith("cax") && !EU_LOCATIONS.has(location)) continue;
				attempts.push({ serverType, location });
			}
		}
		let lastPlacementErr: unknown = null;
		for (let i = 0; i < attempts.length; i++) {
			const { serverType, location } = attempts[i];
			try {
				await this.api(
					"POST",
					"/servers",
					serverCreatePayload(this.cfg, project, {
						name,
						serverType,
						location,
						version: opts.version,
						bootstrapToken: opts.bootstrapToken,
					}),
				);
				if (i > 0) {
					// Only log when we actually fell back — the "why this VM is x86/elsewhere" signal.
					flog.warn("fleet placement fell back", {
						provider: project.provider,
						server_type: serverType,
						location,
						skipped: i,
					});
				}
				flog.info("fleet VM created", {
					provider: project.provider,
					server_type: serverType,
					location,
				});
				return;
			} catch (err) {
				if (isPlacementError(err)) {
					lastPlacementErr = err;
					continue; // no capacity for this type/location — try the next candidate
				}
				throw err; // real error (auth, bad ssh key, quota) — don't mask it
			}
		}
		throw new Error(
			`hcloud create: no capacity for ${project.provider} across ` +
				`${this.cfg.serverTypes.join("/")} in ${locations.join("/")} ` +
				`(last: ${lastPlacementErr instanceof Error ? lastPlacementErr.message : "placement failed"})`,
		);
	}

	async destroy(instanceId: string): Promise<void> {
		await this.api("DELETE", `/servers/${instanceId}`);
	}

	private async api(method: string, path: string, body?: unknown): Promise<unknown> {
		const res = await fetch(`${HCLOUD_API}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.cfg.token}`,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) {
			const text = await res.text();
			let code: string | null = null;
			try {
				const parsed: unknown = JSON.parse(text);
				if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === "string") {
					code = parsed.error.code;
				}
			} catch {
				// non-JSON body — leave code null, keep the raw text in the message
			}
			throw new HcloudApiError(res.status, code, `hcloud ${method} ${path} → ${res.status}: ${text}`);
		}
		return res.status === 204 ? null : res.json();
	}
}

let cached: HcloudFleetProvider | null = null;

/** The Hetzner fleet provider (lazily constructed so env is only required when used). */
export function getHcloudFleetProvider(): FleetProvider {
	if (!cached) cached = new HcloudFleetProvider();
	return cached;
}
