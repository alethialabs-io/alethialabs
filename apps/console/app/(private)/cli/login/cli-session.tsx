// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/* Reached from both graphs — the server `layout.tsx` renders the provider, the client
   `page.tsx` calls the hook — so the boundary is declared rather than inferred, for the
   reason `components/auth/auth-shell.tsx` states at its top. */
"use client";

import { createContext, useContext } from "react";

/**
 * The account the approval would bind, resolved on the server and handed down.
 *
 * WHY A CONTEXT AND NOT A FETCH. `/cli/login` has to name the signed-in account — a person
 * may be signed into more than one, and approval binds *this* session's — but the identity
 * is a server fact and the approval UI is a client component (it owns `useSearchParams` and
 * the stage machine). A context lets `layout.tsx` read the session once, on the server, with
 * no request from the browser at all. The alternative was a `useEffect` fetch on mount, and
 * this page is #2213: it is worth a great deal that NOTHING here runs as a consequence of
 * rendering.
 *
 * `null` is a first-class value, not a bug: the session read is best-effort (see
 * `layout.tsx`), and a page rendered without the provider — which is how the unit tests
 * render it — gets `null` and simply omits the line. It must never be shown as "unknown
 * account" or as an empty string beside "Approving as".
 */
const CliAccountContext = createContext<string | null>(null);

/** Publishes the signed-in account's email to the approval UI below it. */
export function CliAccountProvider({
	email,
	children,
}: {
	email: string | null;
	children: React.ReactNode;
}) {
	return (
		<CliAccountContext.Provider value={email}>
			{children}
		</CliAccountContext.Provider>
	);
}

/** The signed-in account's email, or `null` when it could not be resolved. */
export function useCliAccount(): string | null {
	return useContext(CliAccountContext);
}
