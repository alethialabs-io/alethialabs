// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useSyncExternalStore } from "react";
import { Alert, AlertTitle } from "@repo/ui/alert";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@repo/ui/alert-dialog";
import { Button } from "@repo/ui/button";
import { signInHref } from "@/lib/auth/sign-in-href";
import { useSessionState } from "@/lib/stores/use-session-state";

/** The unsubscribe of a subscription that was never made. */
function unsubscribeFromNothing(): void {
	return undefined;
}

/** The address does not change while the session-ended surface is up, so there is nothing to subscribe to. */
function subscribeToNothing(): () => void {
	return unsubscribeFromNothing;
}

/** This tab's path and query — where sign-in should come back to. */
function currentAddress(): string {
	return window.location.pathname + window.location.search;
}

/** The server render has no address to read; the link is plain sign-in until the browser has it. */
function noAddress(): null {
	return null;
}

/** The sign-in address that comes back to this tab's current address. */
function useSignInHref(): string {
	return signInHref(useSyncExternalStore(subscribeToNothing, currentAddress, noAddress));
}

/**
 * The console's one session-ended surface. It shows when `useSessionState` is `ended`, or when
 * `ended` is passed: `[org]/layout.tsx` passes it when the request itself had no session.
 *
 * It has two forms. First the dialog: controlled, with no close control, so Escape and a click
 * outside leave it open. Its "Stay on this page" swaps it for a banner at the top of the window,
 * which has no way to be closed; the page behind can then be selected and copied. The session is
 * still ended in that form, and the next report that it has ended (a write the person attempts)
 * brings the dialog back. The layout's form has no "Stay on this page": there is no page behind it.
 *
 * The page is never navigated away from. "Sign in" is a plain link, so it is a full page load. The
 * new document starts with an active session state and empty query caches.
 */
export function SessionEnded({ ended = false }: { ended?: boolean }) {
	const status = useSessionState((state) => state.status);
	const dismissed = useSessionState((state) => state.dismissed);
	const stay = useSessionState((state) => state.stay);
	if (ended) return <SessionEndedDialog />;
	if (status !== "ended") return null;
	return dismissed ? <SessionEndedBanner /> : <SessionEndedDialog onStay={stay} />;
}

/** The dialog form. `onStay` adds the secondary "Stay on this page" action. */
function SessionEndedDialog({ onStay }: { onStay?: () => void }) {
	const href = useSignInHref();
	return (
		<AlertDialog open>
			<AlertDialogContent data-slot="session-ended">
				<AlertDialogHeader>
					<AlertDialogTitle>Your session has ended</AlertDialogTitle>
					<AlertDialogDescription>
						Sign in again to continue. You will come back to this page.
					</AlertDialogDescription>
				</AlertDialogHeader>
				{/* "Sign in" is FIRST in the DOM: the dialog focuses its first focusable element when it
				    opens, and that must be the primary action. The classes then lay it out as the
				    primary one: on top when the buttons stack, rightmost when they sit in a row. */}
				<AlertDialogFooter className="flex-col sm:flex-row-reverse sm:justify-start">
					<Button nativeButton={false} render={<a href={href} />}>
						Sign in
					</Button>
					{onStay ? (
						<Button variant="outline" onClick={onStay}>
							Stay on this page
						</Button>
					) : null}
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/**
 * The banner form: fixed to the top of the window on the toast rung, so it stays above the shell
 * and anything the page opens. Only the banner itself takes pointer events; the strip beside it
 * lets clicks through to the page.
 */
function SessionEndedBanner() {
	const href = useSignInHref();
	return (
		<div className="pointer-events-none fixed inset-x-0 top-0 z-[var(--z-toast)] flex justify-center p-2">
			<Alert
				data-slot="session-ended-banner"
				className="pointer-events-auto flex w-auto items-center gap-3 shadow-sm"
			>
				<AlertTitle>Your session has ended. Sign in to continue.</AlertTitle>
				<Button size="sm" nativeButton={false} render={<a href={href} />}>
					Sign in
				</Button>
			</Alert>
		</div>
	);
}
