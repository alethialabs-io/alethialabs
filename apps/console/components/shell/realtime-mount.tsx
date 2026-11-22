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
import { endSession, useSessionState } from "@/lib/stores/use-session-state";
import { SessionEnded } from "./session-ended";

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
 *
 * It also mounts the shell's one session-ended dialog (`SessionEnded`), and is the third of the
 * three sources that end the session state: the stream reaching `signed-out`.
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

	return (
		<>
			<ConnectionIndicator />
			<SessionEnded />
		</>
	);
}

/**
 * Where the notice sits: centred just under the shell header. Toasts are bottom-centre
 * (`app/layout.tsx`), and the notice used to be fixed bottom-centre on the same rung, so a toast and
 * "Live updates paused" drew over each other. The header's own centre is the breadcrumb, so the
 * notice hangs below it, offset by the header's height variable rather than a number of its own.
 */
export const CONNECTION_NOTICE_POSITION =
	"pointer-events-none fixed top-[calc(var(--shell-header-h)+0.5rem)] left-1/2 z-[var(--z-toast)] -translate-x-1/2";

/**
 * A deliberately minimal "live updates paused" notice. Its visual design is the maintainer's call
 * (#6115); this is the smallest thing that meets R7: visible, announced politely, on the toast rung.
 * The live region is always in the DOM so a screen reader hears the text when it appears.
 *
 * A stream that reports `signed-out` ends the session state, and the notice then says nothing: the
 * session-ended dialog is what the person is shown, whichever source ended the session, and a
 * "retrying" line behind it would be about a stream that cannot come back.
 */
function ConnectionIndicator() {
	const { state, hasBeenLive, noticeable } = useRealtimeConnection();
	const sessionEnded = useSessionState((session) => session.status === "ended");
	useEffect(() => {
		if (state === "signed-out") endSession();
	}, [state]);
	const text =
		!noticeable || sessionEnded || state === "signed-out"
			? ""
			: hasBeenLive
				? "Live updates paused — retrying"
				: "Connecting…"; // nothing was live yet, so nothing is "paused"
	return (
		<div
			role="status"
			aria-live="polite"
			data-slot="realtime-notice"
			className={CONNECTION_NOTICE_POSITION}
		>
			{text ? (
				<span className="border border-border bg-background px-3 py-1.5 text-ui-sm text-text-secondary shadow-sm">
					{text}
				</span>
			) : null}
		</div>
	);
}
