// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hetzner Cloud capacity provider for the in-app fleet scaler (ADR 20 §3). A Hetzner
// VM is just cheap host compute; cloud-init runs the per-cloud runner image (Phase 3),
// which self-registers via the bootstrap token. Talks to the Hetzner REST API via
// fetch (no SDK dep). Selected by FLEET_PROVIDER=hcloud; otherwise the manual no-op
// provider runs. Live-tested when HCLOUD_TOKEN + a deploy exist.

import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import type { FleetProvider, Pool } from "@/lib/fleet/provider";
import { idleManagedRunnersForProvider } from "@/lib/queries/runner-usage";

const HCLOUD_API = "https://api.hetzner.cloud/v1";

/** Resolved Hetzner + runner-image config for provisioning a fleet VM. */
export interface HcloudConfig {
	token: string;
	serverType: string;
	location: string;
	image: string;
	sshKeys: string[];
	imageTag: string;
	webOrigin: string;
	bootstrapToken: string;
	slots: number;
	storage: {
		endpoint: string;
		region: string;
		accessKey: string;
		secretKey: string;
	};
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
		location: process.env.HCLOUD_LOCATION ?? "fsn1",
		image: process.env.HCLOUD_IMAGE ?? "ubuntu-24.04",
		sshKeys: (process.env.HCLOUD_SSH_KEYS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		imageTag: process.env.FLEET_RUNNER_IMAGE_TAG ?? "latest",
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

/** Pure: create N vs delete N to converge `current` → `desired`, bounded by `max`. */
export function computeScaleAction(
	current: number,
	desired: number,
	max: number,
): { toCreate: number; toDelete: number } {
	const target = Math.max(0, Math.min(desired, max));
	if (target > current) return { toCreate: target - current, toDelete: 0 };
	if (target < current) return { toCreate: 0, toDelete: current - target };
	return { toCreate: 0, toDelete: 0 };
}

/** Pure: the cloud-init that boots a per-cloud runner which self-registers. */
export function renderCloudInit(cfg: HcloudConfig, provider: string): string {
	const image = `ghcr.io/alethialabs-io/runner-${provider}:${cfg.imageTag}`;
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

/** Pure: the Hetzner POST /servers payload for a fleet VM. */
export function serverCreatePayload(
	cfg: HcloudConfig,
	provider: string,
	name: string,
): Record<string, unknown> {
	return {
		name,
		server_type: cfg.serverType,
		location: cfg.location,
		image: cfg.image,
		ssh_keys: cfg.sshKeys,
		start_after_create: true,
		labels: { "alethia-managed": "true", "alethia-pool": provider },
		user_data: renderCloudInit(cfg, provider),
	};
}

interface HcloudServer {
	id: number;
	name: string;
}

class HcloudFleetProvider implements FleetProvider {
	private readonly cfg = hcloudConfigFromEnv();

	async current(pool: Pool): Promise<number> {
		return (await this.listServers(pool.provider)).length;
	}

	async scale(pool: Pool, desired: number): Promise<void> {
		const current = await this.listServers(pool.provider);
		const { toCreate, toDelete } = computeScaleAction(
			current.length,
			desired,
			pool.max,
		);
		for (let i = 0; i < toCreate; i++) {
			const name = `fleet-${pool.provider}-${randomUUID().slice(0, 8)}`;
			await this.api("POST", "/servers", serverCreatePayload(this.cfg, pool.provider, name));
		}
		if (toDelete > 0) await this.scaleDown(pool.provider, toDelete);
	}

	/** Graceful: delete only idle runners' servers, up to `count`. */
	private async scaleDown(provider: string, count: number): Promise<void> {
		const idle = await idleManagedRunnersForProvider(getServiceDb(), provider);
		const servers = await this.listServers(provider);
		const byId = new Map(servers.map((s) => [String(s.id), s]));
		let removed = 0;
		for (const r of idle) {
			if (removed >= count) break;
			const srv = byId.get(r.instance_id);
			if (!srv) continue;
			await this.api("DELETE", `/servers/${srv.id}`);
			await this.markOffline(r.runner_id);
			removed++;
		}
	}

	/** Mark a removed runner OFFLINE and close its open usage session at now(). */
	private async markOffline(runnerId: string): Promise<void> {
		await getServiceDb().execute(sql`
			with closed as (
				update public.runners set status = 'OFFLINE'::public.runner_status
				where id = ${runnerId} returning id
			)
			update public.runner_usage_sessions s
			set ended_at = now(),
			    duration_seconds = greatest(0, extract(epoch from (now() - s.started_at)))::bigint
			from closed c where s.runner_id = c.id and s.ended_at is null
		`);
	}

	private async listServers(provider: string): Promise<HcloudServer[]> {
		const res = await this.api(
			"GET",
			`/servers?label_selector=${encodeURIComponent(`alethia-pool=${provider}`)}`,
		);
		const servers = (res as { servers?: HcloudServer[] } | null)?.servers;
		return servers ?? [];
	}

	private async api(
		method: string,
		path: string,
		body?: unknown,
	): Promise<unknown> {
		const res = await fetch(`${HCLOUD_API}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.cfg.token}`,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) {
			throw new Error(
				`hcloud ${method} ${path} → ${res.status}: ${await res.text()}`,
			);
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
