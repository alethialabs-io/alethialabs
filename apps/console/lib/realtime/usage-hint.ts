// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";

// The `usage` topic's producer (#6127, spec-6115 §1.1): an APP-LAYER hint, not a trigger.
//
// AI spend is written per AI call — a hold row inside the transaction that holds the org's
// AI-budget advisory lock, then a settle. A trigger there would NOTIFY inside that transaction, and
// a notifying commit serialises with every other notifying commit database-wide (it takes the
// NOTIFY queue's lock), so the busiest org's AI calls would queue behind every job update. So the
// writers call `emitUsageHint(orgId)` AFTER their commit, outside the lock, and it announces at most
// ONCE PER 30 s PER ORG:
//   · the first change in a quiet window is announced at once (leading edge);
//   · changes inside the window are folded into ONE announcement when the window ends (trailing
//     edge), so the last call of a burst is never left unannounced — it is at most 30 s late.
// The throttle is per PROCESS (a module-level map). With N console replicas an org can hear up to N
// hints per window; the client coalesces them (lib/realtime/client/coalescer.ts).
//
// Fire-and-forget: a hint is an optimisation over `refetchOnWindowFocus`, so a failed NOTIFY is
// logged and dropped, and nothing here can fail or delay the AI call that triggered it.

/** The window inside which an org's usage is announced at most once. */
export const USAGE_HINT_WINDOW_MS = 30_000;

/** What {@link createUsageHinter} needs; injectable for tests. */
export interface UsageHinterDeps {
	/** Sends one `usage` hint for an org (a NOTIFY on the change bus). */
	emit: (orgId: string) => Promise<void>;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
}

/** One org's throttle state: when it was last announced, and whether a trailing one is scheduled. */
interface OrgWindow {
	lastAt: number;
	trailing: boolean;
}

/** Builds a throttled hinter: leading edge at once, at most one trailing edge per window. */
export function createUsageHinter(deps: UsageHinterDeps): (orgId: string) => void {
	const now = deps.now ?? Date.now;
	const setTimer =
		deps.setTimer ??
		((fn: () => void, ms: number) => {
			const t = setTimeout(fn, ms);
			// Never keeps the process alive for a hint.
			if (typeof t === "object" && t !== null && "unref" in t) t.unref();
			return t;
		});
	const windows = new Map<string, OrgWindow>();

	const send = (orgId: string) => {
		deps.emit(orgId).catch((error: unknown) => {
			console.error("[realtime] usage hint failed; the page refreshes on focus instead", error);
		});
	};

	return (orgId: string) => {
		const at = now();
		const w = windows.get(orgId);
		if (!w || at - w.lastAt >= USAGE_HINT_WINDOW_MS) {
			windows.set(orgId, { lastAt: at, trailing: false });
			send(orgId);
			return;
		}
		if (w.trailing) return; // already folded into this window's trailing announcement
		w.trailing = true;
		setTimer(() => {
			windows.set(orgId, { lastAt: now(), trailing: false });
			send(orgId);
		}, USAGE_HINT_WINDOW_MS - (at - w.lastAt));
	};
}

/** The NOTIFY itself: `emit_change('usage', …)` on the org arm, no row id (programmables.sql). */
async function notifyUsage(orgId: string): Promise<void> {
	await getServiceDb().execute(
		sql`select public.emit_change('usage', NULL, ${orgId}::uuid, NULL, NULL)`,
	);
}

/**
 * Announce that an org's AI usage changed. Call it AFTER the write committed and outside any lock;
 * it never throws and never waits.
 */
export const emitUsageHint: (orgId: string) => void = createUsageHinter({ emit: notifyUsage });
