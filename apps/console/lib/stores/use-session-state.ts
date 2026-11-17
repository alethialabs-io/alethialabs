// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Whether this tab's session is still good. Three sources end it, and each calls `endSession()`:
//   · a write that answers `unauthenticated` (`lib/actions/use-action-mutation.ts`);
//   · a read that answers `UNAUTHORIZED` (the `QueryCache` `onError` in `lib/query/client.ts`);
//   · the change stream reaching `signed-out` (`components/shell/realtime-mount.tsx`).
// A write attempted after that is not sent; it reports the session ended again instead.
// One reader shows it: `components/shell/session-ended.tsx`. Two more stop work that could only be
// refused: `lib/query/client.ts` (queries) and `lib/realtime/client/fallback-poll.ts` (the poll).
//
// Nothing here sets the status back to `active`. The dialog's "Sign in" link is a full page load,
// and a new document starts from `active`.
//
// `dismissed` is only about HOW the ended session is shown. The dialog's "Stay on this page" sets
// it, and the dialog becomes a banner so the page behind can be selected and copied. The status is
// still `ended`: reads stay held and the poll stays stopped. Any later report that the session has
// ended — in practice a write the person attempts — clears it, which brings the dialog back.

import { create } from "zustand";

/** `active` until one of the three sources reports the session gone; then `ended` for good. */
export type SessionStatus = "active" | "ended";

/** The store's shape. */
interface SessionState {
	status: SessionStatus;
	/** True while the person has chosen to stay on the page: the banner shows, not the dialog. */
	dismissed: boolean;
	/**
	 * Marks the session ended and asks for the dialog. While it is already ended with the dialog
	 * asked for, a call changes nothing and notifies nobody.
	 */
	end: () => void;
	/** Swaps the dialog for the banner. Does nothing unless the session has ended. */
	stay: () => void;
}

/** This document's session status. Read it with a selector: `useSessionState((s) => s.status)`. */
export const useSessionState = create<SessionState>((set) => ({
	status: "active",
	dismissed: false,
	end: () =>
		set((state) =>
			state.status === "ended" && !state.dismissed ? state : { status: "ended", dismissed: false },
		),
	stay: () => set((state) => (state.status === "ended" && !state.dismissed ? { dismissed: true } : state)),
}));

/** Marks the session ended and asks for the dialog, from code that is not a component. */
export function endSession(): void {
	useSessionState.getState().end();
}

/** Whether the session has ended, for code that is not a component. */
export function isSessionEnded(): boolean {
	return useSessionState.getState().status === "ended";
}
