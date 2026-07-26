// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-identity capability bags for the design canvas.
//
// Mirrors `use-cloud-provider-store`'s pattern (Zustand + a server action + a TTL) but NOT its
// shape: that store is a single global slot with `setIdentity` clobber semantics, while a canvas
// node's effective identity is PER-NODE — a node can diverge from the project core. So entries are
// keyed, and a divergent node simply gets its own.
//
// Keyed on `${identityId}|${region}` because three axes (instance types, cache tiers, quotas) are
// genuinely region-scoped: the same account answers differently in eu-central-1 and us-east-1.

import { create } from "zustand";
import { getIdentityCapabilities } from "@/app/server/actions/capabilities";
import {
	NO_CAPABILITIES,
	type CapabilityBag,
} from "@/components/design-project/canvas/inspector/config-schema";

/** Matches use-cloud-provider-store's staleness window — same data freshness, same sweeper. */
const TTL_MS = 6 * 60 * 60 * 1000;

type Key = string;

interface Entry {
	bag: CapabilityBag;
	fetchedAt: number;
	/** Held while a fetch is in flight so N mounted fields share ONE request. */
	inflight?: Promise<void>;
}

interface CapabilitiesStore {
	entries: Record<Key, Entry>;
	/** Idempotent, in-flight-deduped and TTL'd — safe to call from an effect on every render. */
	ensure: (identityId: string, region: string | null) => void;
	/** Read a bag, or NO_CAPABILITIES. Never triggers a fetch (keeps render pure). */
	get: (identityId: string | null, region: string | null) => CapabilityBag;
	/** Drop cached bags — e.g. after reconnecting an account. */
	invalidate: (identityId?: string) => void;
}

const keyOf = (identityId: string, region: string | null): Key =>
	`${identityId}|${region ?? "*"}`;

export const useCapabilitiesStore = create<CapabilitiesStore>()((set, get) => ({
	entries: {},

	ensure: (identityId, region) => {
		const key = keyOf(identityId, region);
		const existing = get().entries[key];
		if (existing?.inflight) return;
		if (existing && Date.now() - existing.fetchedAt < TTL_MS) return;

		const inflight = getIdentityCapabilities(identityId, region)
			.then((bag) => {
				set((s) => ({
					entries: { ...s.entries, [key]: { bag, fetchedAt: Date.now() } },
				}));
			})
			.catch(() => {
				// Fail OPEN, loudly enough for the footnote but never for the picker: an error bag
				// still resolves the static catalog, so the canvas stays usable when the read fails.
				set((s) => ({
					entries: {
						...s.entries,
						[key]: {
							bag: { ...NO_CAPABILITIES, identityId, state: "error" },
							fetchedAt: Date.now(),
						},
					},
				}));
			});

		set((s) => ({
			entries: {
				...s.entries,
				[key]: {
					bag: existing?.bag ?? { ...NO_CAPABILITIES, identityId, state: "loading" },
					fetchedAt: existing?.fetchedAt ?? 0,
					inflight,
				},
			},
		}));
	},

	get: (identityId, region) =>
		identityId ? (get().entries[keyOf(identityId, region)]?.bag ?? NO_CAPABILITIES) : NO_CAPABILITIES,

	invalidate: (identityId) =>
		set((s) => ({
			entries: identityId
				? Object.fromEntries(
						Object.entries(s.entries).filter(([k]) => !k.startsWith(`${identityId}|`)),
					)
				: {},
		})),
}));
