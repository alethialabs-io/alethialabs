// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An in-memory fleet world for testing the controller end-to-end without Postgres or
// Hetzner. It implements the FleetProvider primitives AND the ControllerDeps, modelling
// the runner lifecycle (create→booting→online, drain, crash). Tests drive it through
// reconcile ticks and assert convergence + the warmMin invariant. See spec/mvp/26.

import type { ControllerDeps, RunnerState } from "@/lib/fleet/controller";
import type { FleetProvider, FleetSpec, ProviderInstance } from "@/lib/fleet/types";

interface FakeInstance {
	instanceId: string;
	location: string;
	version: string | null;
	ageSeconds: number;
	status: "none" | "online" | "draining" | "offline";
	busy: boolean;
	runnerId: string | null;
}

export class FakeFleet implements FleetProvider {
	private readonly instances = new Map<string, FakeInstance>();
	private idc = 0;
	backlog = 0;
	recentPeak = 0;
	channelVersion: string | null = null;
	bootGraceSeconds = 180;

	/** Seed an already-running instance (for mid-state tests). */
	seed(over: Partial<FakeInstance> & { version: string | null; location: string }): string {
		const id = over.instanceId ?? `seed${this.idc++}`;
		this.instances.set(id, {
			instanceId: id,
			ageSeconds: 300,
			status: "online",
			busy: false,
			runnerId: `r-${id}`,
			...over,
		});
		return id;
	}

	// ── FleetProvider primitives ───────────────────────────────────────────────
	async list(_spec: FleetSpec): Promise<ProviderInstance[]> {
		return [...this.instances.values()].map((i) => ({
			instanceId: i.instanceId,
			location: i.location,
			version: i.version,
			ageSeconds: i.ageSeconds,
		}));
	}
	async create(_spec: FleetSpec, opts: { location: string; version: string | null }): Promise<void> {
		const id = `f${this.idc++}`;
		this.instances.set(id, {
			instanceId: id,
			location: opts.location,
			version: opts.version,
			ageSeconds: 0,
			status: "none",
			busy: false,
			runnerId: null,
		});
	}
	async destroy(instanceId: string): Promise<void> {
		this.instances.delete(instanceId);
	}

	// ── ControllerDeps (injected DB hooks, served from the same world) ─────────
	deps(): ControllerDeps {
		return {
			runnerMap: async (): Promise<Map<string, RunnerState>> => {
				const m = new Map<string, RunnerState>();
				for (const i of this.instances.values()) {
					if (i.status !== "none" && i.runnerId) {
						m.set(i.instanceId, {
							runnerId: i.runnerId,
							status: i.status,
							version: i.version,
							busy: i.busy,
						});
					}
				}
				return m;
			},
			backlog: async () => this.backlog,
			recentPeak: async () => this.recentPeak,
			resolveChannel: async () => this.channelVersion,
			drain: async (runnerId) => {
				for (const i of this.instances.values()) if (i.runnerId === runnerId) i.status = "draining";
			},
			retire: async (runnerId) => {
				for (const i of this.instances.values()) if (i.runnerId === runnerId) i.status = "offline";
			},
			bootGraceSeconds: this.bootGraceSeconds,
		};
	}

	// ── Test controls ──────────────────────────────────────────────────────────
	/** Advance time: registration-less instances come online; everything ages. */
	tick(): void {
		for (const i of this.instances.values()) {
			if (i.status === "none") {
				i.status = "online";
				i.runnerId = `r-${i.instanceId}`;
				i.ageSeconds = 300;
			} else {
				i.ageSeconds += 60;
			}
		}
	}
	crash(instanceId: string): void {
		const i = this.instances.get(instanceId);
		if (i) i.status = "offline";
	}
	online(): FakeInstance[] {
		return [...this.instances.values()].filter((i) => i.status === "online");
	}
	all(): FakeInstance[] {
		return [...this.instances.values()];
	}
}
