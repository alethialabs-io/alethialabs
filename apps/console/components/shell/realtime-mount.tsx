// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useViewer } from "@/components/providers/viewer-provider";
import { useRealtimeConnection } from "@/hooks/use-realtime";
import { getQueryClient } from "@/lib/query/client";
import { startRealtime } from "@/lib/realtime/client/runtime";
import { tenantSegment } from "@/lib/rpc/client";

/**
 * The single mount point for the org's real-time stream (ADR 0005 D3, #6115). #6113 placed it in
 * `AppShell` so the bus is wired in by editing THIS file only, and the shell lane (#6114) and the
 * bus never co-edit `app-shell.tsx` (stress test R10).
 *
 * The runtime is keyed on the signed-in person and the address's org segment: switching org (or
 * account) stops the old stream and starts the new one, and two accounts signed in to one browser
 * never share an election or a relay. A remount starts from a first connect, so a `removed` from
 * before does not stick. The org's QueryClient is captured when it STARTS, so a hint that arrives
 * late for the org just left can only ever invalidate that org's cache, never the new one's.
 */
export function RealtimeMount() {
	const tenant = tenantSegment(usePathname());
	const userId = useViewer().viewer?.id ?? null;
	// The App Router's router object is stable across renders, so it does not restart the stream.
	const router = useRouter();

	useEffect(() => {
		if (userId === null) return; // nobody signed in: nothing to stream
		return startRealtime({
			userId,
			tenant,
			queryClient: getQueryClient(tenant),
			// The address is no longer ours to read: let the server decide what to render instead.
			onRemoved: () => router.refresh(),
		});
	}, [userId, tenant, router]);

	return <ConnectionIndicator />;
}

/**
 * A deliberately minimal "live updates paused" notice. Its visual design is the maintainer's call
 * (#6115); this is the smallest thing that meets R7: visible, announced politely, on the toast rung.
 * The live region is always in the DOM so a screen reader hears the text when it appears.
 */
function ConnectionIndicator() {
	const { state, hasBeenLive, noticeable } = useRealtimeConnection();
	const text = !noticeable
		? ""
		: state === "signed-out"
			? "Signed out — live updates stopped. Sign in again to resume."
			: hasBeenLive
				? "Live updates paused — retrying"
				: "Connecting…"; // nothing was live yet, so nothing is "paused"
	return (
		<div
			role="status"
			aria-live="polite"
			className="pointer-events-none fixed bottom-4 left-1/2 z-[var(--z-toast)] -translate-x-1/2"
		>
			{text ? (
				<span className="border border-border bg-background px-3 py-1.5 text-ui-sm text-text-secondary shadow-sm">
					{text}
				</span>
			) : null}
		</div>
	);
}
