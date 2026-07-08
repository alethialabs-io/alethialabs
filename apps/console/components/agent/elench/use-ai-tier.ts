"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useState } from "react";
import { getAiUsageSummary } from "@/app/server/actions/billing";
import type { AiTier } from "@/lib/billing/ai-plan";

// Module-level cache so the tier is fetched once per page load and shared across every
// composer instance (docked + modal hero mount the composer independently). A per-message
// gating affordance, not billing enforcement — a stale value after an in-session upgrade is
// harmless (the routes re-resolve the tier server-side on every request).
let cachedTier: AiTier | undefined;
let inflight: Promise<AiTier> | undefined;

/**
 * Fetch (and module-cache) the active org's effective AI tier for gating client-only
 * affordances (e.g. the Max-only "deep reasoning" toggle). Returns `undefined` until the
 * canonical AI summary resolves; best-effort — a failed fetch stays `undefined`.
 */
export function useAiTier(): AiTier | undefined {
	const [tier, setTier] = useState<AiTier | undefined>(cachedTier);

	useEffect(() => {
		if (cachedTier) return;
		inflight ??= getAiUsageSummary().then((s) => {
			cachedTier = s.tier;
			return s.tier;
		});
		let alive = true;
		inflight.then((t) => alive && setTier(t)).catch(() => {
			/* best-effort — the affordance just stays hidden */
		});
		return () => {
			alive = false;
		};
	}, []);

	return tier;
}
