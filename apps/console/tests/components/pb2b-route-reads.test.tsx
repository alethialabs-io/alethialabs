// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CON-PB2b (#7401). The pure halves of three R6 findings, pinned where a route and a panel share them:
//   C-34  the runners and usage routes dehydrate only their own reads, not the `[org]` layout's shell
//         reads (`workspace.*`), which the layout already hands the browser through its own boundary;
//   C-32  the usage chart's window and metric decode from the link, totally — an unreadable value is
//         the default, never an error and never a window nobody chose;
//   C-19  a pool's health and pause read through the shared status device, not a hand-rolled dot.

import { type Query, QueryClient, dehydrate } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rpc/server", () => ({ serverOrpc: () => ({}) }));

import { isRunnersRead } from "@/components/runners/runners-prefetch";
import { PoolCard } from "@/components/runners/pool-card";
import {
	isUsageRead,
	metricFromUrl,
	USAGE_DEFAULT_RANGE,
	usageRangeSpec,
} from "@/components/settings/usage/usage-reads";
import { parseRangeFilter } from "@/lib/query/range-filter";
import { orpc } from "@/lib/rpc/client";
import type { FleetPoolView } from "@/lib/rpc/procedures/runners";

/**
 * The keys a route's filter hands down from a request client holding the shell's settled
 * `workspace.projects`, each of `own` settled, and `unsettled` built but never answered.
 */
function handedDown(
	filter: (query: Pick<Query, "queryKey" | "state">) => boolean,
	own: unknown[][],
	unsettled: unknown[],
): unknown[] {
	const client = new QueryClient();
	client.setQueryData([...orpc.workspace.projects.queryKey()], []);
	for (const key of own) client.setQueryData(key, []);
	client.getQueryCache().build(client, { queryKey: unsettled });
	return dehydrate(client, { shouldDehydrateQuery: filter }).queries.map((q) => q.queryKey);
}

/** A reader over one query string. */
function reader(search: string) {
	const params = new URLSearchParams(search);
	return { get: (name: string) => params.get(name) };
}

describe("C-34 — a route dehydrates only its own reads", () => {
	it("runners: its own settled reads, not the shell's and not an unsettled one", () => {
		// Plain arrays: the cache cares about the key's VALUE, not the typed payload.
		const fleet: unknown[] = [...orpc.runners.fleet.queryKey()];
		const list: unknown[] = [...orpc.runners.list.queryKey()];
		const economics: unknown[] = [...orpc.runners.fleetEconomics.queryKey()];
		expect(handedDown(isRunnersRead, [fleet, list], economics)).toEqual([fleet, list]);
	});

	it("usage: usage and billing reads, not the shell's and not an unsettled one", () => {
		const org: unknown[] = [...orpc.usage.org.queryKey()];
		const summary: unknown[] = [...orpc.billing.summary.queryKey()];
		const ai: unknown[] = [...orpc.usage.ai.queryKey()];
		expect(handedDown(isUsageRead, [org, summary], ai)).toEqual([org, summary]);
	});
});

describe("C-32 — the usage window and metric decode from the link", () => {
	it("a bare link is the default preset, the key the route always prefetched", () => {
		expect(usageRangeSpec(parseRangeFilter(""))).toEqual(USAGE_DEFAULT_RANGE);
	});

	it("a preset stays relative; an explicit window is its two bounds", () => {
		expect(usageRangeSpec(parseRangeFilter("30d"))).toEqual({ preset: "30d" });
		expect(
			usageRangeSpec(parseRangeFilter("2026-11-01T00:00:00.000Z/2026-11-08T00:00:00.000Z")),
		).toEqual({ from: "2026-11-01T00:00:00.000Z", to: "2026-11-08T00:00:00.000Z" });
	});

	it("an unreadable range is the default window", () => {
		expect(usageRangeSpec(parseRangeFilter("last-tuesday"))).toEqual(USAGE_DEFAULT_RANGE);
	});

	it("a known metric is read; an absent or unknown one is runner minutes", () => {
		expect(metricFromUrl(reader("metric=jobs"))).toBe("jobs");
		expect(metricFromUrl(reader("metric=aiCredits"))).toBe("aiCredits");
		expect(metricFromUrl(reader(""))).toBe("runnerMinutes");
		expect(metricFromUrl(reader("metric=revenue"))).toBe("runnerMinutes");
	});
});

describe("C-19 — a pool's state reads through the shared status device", () => {
	/** A pool, healthy and enabled unless overridden. */
	function pool(over: Partial<FleetPoolView> = {}): FleetPoolView {
		return {
			id: "pool-1",
			provider: "aws",
			name: null,
			enabled: true,
			target: 2,
			max: 4,
			targetVersion: null,
			locations: ["EU-CENTRAL-1"],
			online: 2,
			draining: 0,
			offline: 0,
			busy: 0,
			busyOnline: 0,
			versions: [],
			locDist: [],
			rolloutPct: 100,
			fullyRolled: true,
			belowFloor: false,
			degraded: false,
			...over,
		};
	}

	it("a healthy pool is an active status badge", () => {
		const { container } = render(<PoolCard pool={pool()} />);
		const badge = screen.getByText("Healthy").closest(".vx-status");
		expect(badge?.className).toContain("vx-status--active");
		expect(container.querySelector(".vx-status--pending")).toBeNull();
	});

	it("a degraded, paused pool says both through status badges", () => {
		render(<PoolCard pool={pool({ degraded: true, enabled: false })} />);
		expect(screen.getByText("Degraded").closest(".vx-status")?.className).toContain(
			"vx-status--pending",
		);
		expect(screen.getByText("Paused").closest(".vx-status")?.className).toContain(
			"vx-status--disabled",
		);
	});
});
