// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The credential kind an `Actor` was built from, and the one question code asks of it: whose
// `personal` cloud identities may this actor bind or use? For a CLI service token `actor.userId` is
// the profile that MINTED the credential, not a caller, so the answer is nobody. Pure and
// dependency-free, so server actions and routes can import it without pulling in the guard.

import type { CliCredential } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";

/**
 * `actor` carrying the kind of credential it was built from (`Actor.credential`): marked for a
 * service token, unchanged for a session. The one way to set the mark, so the two places that build
 * an actor from a CLI token — `authorizeCliWith` and the `POST /api/jobs` route — cannot spell it
 * differently. A `switch` so a third credential kind is a type error here, not a silent fall-through.
 */
export function actorWithCredential(actor: Actor, credential: CliCredential): Actor {
	switch (credential) {
		case "session":
			return actor;
		case "service_token":
			return { ...actor, credential: "service_token" };
	}
}

/**
 * Whose `personal` cloud identities `actor` may bind or use: `actor.userId` for a person, and
 * nobody (`undefined`) for a service token.
 *
 * This is the `personalAuthorId` argument of `actorIdentityWhere` / `identityScopeWhere`
 * (lib/runners/claim-identity.ts) for code that holds an `Actor` but no `CliCredential`: the server
 * actions the CLI routes reach through `runWithActor`. A route that has the credential in hand may
 * equally pass `userIdIsTheCaller(credential) ? actor.userId : undefined`; the two agree.
 */
export function personalIdentityAuthor(actor: Actor): string | undefined {
	switch (actor.credential) {
		case undefined:
			return actor.userId;
		case "service_token":
			return undefined;
	}
}
