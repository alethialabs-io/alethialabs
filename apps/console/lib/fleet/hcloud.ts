// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hetzner Cloud FleetProvider — primitive list/create/destroy over the Hetzner REST
// API (fetch, no SDK). A Hetzner VM is cheap host compute; cloud-init runs the per-cloud
// runner image (Phase 3) which self-registers via the bootstrap token. The controller
// (plan.ts) owns all diff logic. Live-tested when HCLOUD_TOKEN + a deploy exist;
// pure helpers are unit-tested + the controller is tested via the fake. See dataroom/spec/mvp/26.

import { randomUUID } from "crypto";
import type { FleetProvider, FleetTarget, ProviderInstance } from "@/lib/fleet/types";

const HCLOUD_API = "https://api.hetzner.cloud/v1";

/** Resolved Hetzner + runner-image config for provisioning a fleet VM. */
export interface HcloudConfig {
	token: string;
	serverType: string;
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
		serverType: process.env.HCLOUD_SERVER_TYPE ?? "cax21",
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
	opts: { name: string; location: string; version: string | null; bootstrapToken: string },
): Record<string, unknown> {
	const labels: Record<string, string> = {
		"alethia-managed": "true",
		"alethia-pool": project.provider,
	};
	if (opts.version) labels["alethia-version"] = opts.version;
	return {
		name: opts.name,
		server_type: cfg.serverType,
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

class HcloudFleetProvider implements FleetProvider {
	private readonly cfg = hcloudConfigFromEnv();

	async list(project: FleetTarget): Promise<ProviderInstance[]> {
		const res = await this.api(
			"GET",
			`/servers?label_selector=${encodeURIComponent(`alethia-pool=${project.provider}`)}`,
		);
		const servers = (res as { servers?: HcloudServer[] } | null)?.servers ?? [];
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
		await this.api(
			"POST",
			"/servers",
			serverCreatePayload(this.cfg, project, {
				name,
				location: opts.location,
				version: opts.version,
				bootstrapToken: opts.bootstrapToken,
			}),
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
			throw new Error(`hcloud ${method} ${path} → ${res.status}: ${await res.text()}`);
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
