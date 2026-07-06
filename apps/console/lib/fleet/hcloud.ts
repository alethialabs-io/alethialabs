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
	bootstrapToken: string;
	slots: number;
	storage: { endpoint: string; region: string; accessKey: string; secretKey: string };
}

/** Reads the provider config from env. Throws if the essentials are missing. */
export function hcloudConfigFromEnv(): HcloudConfig {
	const token = process.env.HCLOUD_TOKEN;
	const webOrigin = process.env.ALETHIA_WEB_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL;
	const bootstrapToken = process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN;
	if (!token || !webOrigin || !bootstrapToken) {
		throw new Error(
			"hcloud fleet provider requires HCLOUD_TOKEN, ALETHIA_WEB_ORIGIN, and ALETHIA_RUNNER_BOOTSTRAP_TOKEN",
		);
	}
	return {
		token,
		serverType: process.env.HCLOUD_SERVER_TYPE ?? "cax21",
		image: process.env.HCLOUD_IMAGE ?? "ubuntu-24.04",
		sshKeys: (process.env.HCLOUD_SSH_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
		defaultImageTag: process.env.FLEET_RUNNER_IMAGE_TAG ?? "latest",
		webOrigin,
		bootstrapToken,
		slots: Number.parseInt(process.env.FLEET_RUNNER_SLOTS ?? "1", 10) || 1,
		storage: {
			endpoint: process.env.ALETHIA_STORAGE_ENDPOINT ?? "",
			region: process.env.ALETHIA_STORAGE_REGION ?? "",
			accessKey: process.env.ALETHIA_STORAGE_ACCESS_KEY_ID ?? "",
			secretKey: process.env.ALETHIA_STORAGE_SECRET_ACCESS_KEY ?? "",
		},
	};
}

/** Pure: cloud-init that boots a per-cloud runner (at `version`) which self-registers. */
export function renderCloudInit(cfg: HcloudConfig, provider: string, version: string | null): string {
	const tag = version ?? cfg.defaultImageTag;
	const image = `ghcr.io/alethialabs-io/runner-${provider}:${tag}`;
	const env: Record<string, string> = {
		ALETHIA_WEB_ORIGIN: cfg.webOrigin,
		ALETHIA_RUNNER_OPERATOR: "managed",
		ALETHIA_RUNNER_BOOTSTRAP_TOKEN: cfg.bootstrapToken,
		ALETHIA_RUNNER_SLOTS: String(cfg.slots),
		ALETHIA_STORAGE_ENDPOINT: cfg.storage.endpoint,
		ALETHIA_STORAGE_REGION: cfg.storage.region,
		ALETHIA_STORAGE_ACCESS_KEY_ID: cfg.storage.accessKey,
		ALETHIA_STORAGE_SECRET_ACCESS_KEY: cfg.storage.secretKey,
	};
	const envFlags = Object.entries(env)
		.filter(([, v]) => v !== "")
		.map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`)
		.join(" ");
	return `#cloud-config
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
  - docker run -d --init --restart=always --name alethia-runner ${envFlags} ${image}
`;
}

/** Pure: the Hetzner POST /servers payload for a fleet VM (labels carry pool + version). */
export function serverCreatePayload(
	cfg: HcloudConfig,
	project: FleetTarget,
	opts: { name: string; location: string; version: string | null },
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
		user_data: renderCloudInit(cfg, project.provider, opts.version),
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

	async create(project: FleetTarget, opts: { location: string; version: string | null }): Promise<void> {
		const name = `fleet-${project.provider}-${randomUUID().slice(0, 8)}`;
		await this.api("POST", "/servers", serverCreatePayload(this.cfg, project, { name, ...opts }));
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
