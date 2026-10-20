// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import type { QueryKey } from "@tanstack/react-query";
import { orpc } from "@/lib/rpc/client";

/**
 * What each real-time topic invalidates (ADR 0005 D3). An event names a topic (and maybe an id);
 * the bus calls `invalidateQueries` for the keys listed here, and only OBSERVED queries refetch —
 * through the read router, i.e. through RLS and the PDP again, so authorization stays in one place.
 *
 * The bus (#6115) reads this map; each page lane adds its topic's keys as it moves its reads onto
 * procedures. A topic with no keys yet invalidates nothing.
 */
export const TOPIC_KEYS = {
	jobs: (): QueryKey[] => [orpc.jobs.key()],
	environments: (): QueryKey[] => [],
	projects: (): QueryKey[] => [],
	clusters: (): QueryKey[] => [],
	runners: (): QueryKey[] => [],
	addons: (): QueryKey[] => [],
	alerts: (): QueryKey[] => [],
	support: (): QueryKey[] => [],
	usage: (): QueryKey[] => [],
} satisfies Record<string, () => QueryKey[]>;

/** A topic the bus may deliver. */
export type Topic = keyof typeof TOPIC_KEYS;
