// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Whether this tab's session is still good. Three sources end it, and each calls `endSession()`:
//   · a write that answers `unauthenticated` (`lib/actions/use-action-mutation.ts`);
//   · a read that answers `UNAUTHORIZED` (the `QueryCache` `onError` in `lib/query/client.ts`);
//   · the change stream reaching `signed-out` (`components/shell/realtime-mount.tsx`).
// One reader shows it: `components/shell/session-ended.tsx`. Two more stop work that could only be
// refused: `lib/query/client.ts` (queries) and `lib/realtime/client/fallback-poll.ts` (the poll).
//
// Nothing here sets the status back to `active`. The dialog's "Sign in" link is a full page load,
// and a new document starts from `active`.

import { create } from "zustand";

/** `active` until one of the three sources reports the session gone; then `ended` for good. */
export type SessionStatus = "active" | "ended";

/** The store's shape. */
interface SessionState {
	status: SessionStatus;
	/** Marks the session ended. A second call changes nothing and notifies nobody. */
	end: () => void;
}

/** This document's session status. Read it with a selector: `useSessionState((s) => s.status)`. */
export const useSessionState = create<SessionState>((set) => ({
	status: "active",
	end: () => set((state) => (state.status === "ended" ? state : { status: "ended" })),
}));

/** Marks the session ended, from code that is not a component. */
export function endSession(): void {
	useSessionState.getState().end();
}

/** Whether the session has ended, for code that is not a component. */
export function isSessionEnded(): boolean {
	return useSessionState.getState().status === "ended";
}
