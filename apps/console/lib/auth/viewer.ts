// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The signed-in person as the console RENDERS them — one shape for both sources of it: the session
// the server read for this request (`getViewer()` in lib/auth/owner.ts) and the live client session
// `useViewer()` follows once the page has hydrated (components/providers/viewer-provider.tsx).
//
// No "use client" and no server import: the server layout calls `toViewer()`, and a function
// exported from a "use client" module is a client REFERENCE on the server, not a function.

/** The fields of the signed-in user that console surfaces render. */
export interface Viewer {
	id: string;
	name: string;
	email: string;
	image: string | null;
	createdAt: Date;
}

/** The user shape both better-auth sessions carry — the server's `getSession()` and the client's. */
export interface SessionUserLike {
	id: string;
	name: string;
	email: string;
	image?: string | null;
	createdAt: Date;
}

/**
 * Narrows a better-auth session user to the `Viewer` the console renders. Copying field by field
 * (rather than passing the user through) keeps the server→client seed free of anything a plugin
 * adds to the user row, so the layout never serialises more of the account than the UI shows.
 */
export function toViewer(user: SessionUserLike): Viewer {
	return {
		id: user.id,
		name: user.name,
		email: user.email,
		image: user.image ?? null,
		createdAt: user.createdAt,
	};
}
