// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useSyncExternalStore } from "react";
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

/** The address does not change while the dialog is up, so there is nothing to subscribe to. */
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

/**
 * The console's one "Your session has ended" dialog. It shows when `useSessionState` is `ended`,
 * or when `ended` is passed: `[org]/layout.tsx` passes it when the request itself had no session.
 *
 * The dialog is controlled and has no close control, so Escape and a click outside leave it open.
 * The page is not navigated away from: it stays rendered behind the dialog. "Sign in" is a plain
 * link, so it is a full page load. The new document starts with an active session state and empty
 * query caches.
 */
export function SessionEnded({ ended = false }: { ended?: boolean }) {
	const storeEnded = useSessionState((state) => state.status === "ended");
	if (!ended && !storeEnded) return null;
	return <SessionEndedDialog />;
}

/** The dialog itself, mounted only once the session has ended. */
function SessionEndedDialog() {
	const address = useSyncExternalStore(subscribeToNothing, currentAddress, noAddress);
	return (
		<AlertDialog open>
			<AlertDialogContent data-slot="session-ended">
				<AlertDialogHeader>
					<AlertDialogTitle>Your session has ended</AlertDialogTitle>
					<AlertDialogDescription>
						Sign in again to continue. You will come back to this page.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<Button nativeButton={false} render={<a href={signInHref(address)} />}>
						Sign in
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
