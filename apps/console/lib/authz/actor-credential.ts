// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The credential kind an `Actor` was built from, and the one question code asks of it: whose
// `personal` cloud identities may this actor bind or use? Pure and dependency-free, so server
// actions and routes can import it without pulling in the guard.

import type {
	Actor,
	ActorCredential,
	ResolvedScope,
} from "@/lib/authz/types";

/**
 * Binds a resolved scope to the kind of credential it was resolved for, making it an `Actor`. The
 * only way a `ResolvedScope` (what `getActiveScope` returns) becomes an `Actor`, so every builder —
 * the session path in `currentActor`, `authorizeCliWith`, the `POST /api/jobs` route — states the
 * kind, and a new builder that forgets to is a type error rather than a silent "person".
 */
export function actorWithCredential(
	scope: ResolvedScope,
	credential: ActorCredential,
): Actor {
	return { ...scope, credential };
}

/**
 * Whose `personal` cloud identities `actor` may bind or use — the `personalAuthorId` argument of
 * `identityScopeWhere` / `actorIdentityWhere` (lib/runners/claim-identity.ts). Every identity rule
 * asks this one function.
 *
 * - A person (`session`): their own id.
 * - A service token pinned to its minter's OWN personal workspace (`orgId === userId`): the minter's
 *   id. A personal workspace has no other member, so the token acts for the only person who could
 *   use those identities anyway.
 * - A service token pinned to any other org: nobody (`undefined`). Its `userId` is the profile that
 *   MINTED it, and a credential issued to a shared org must not reach one member's personal
 *   accounts; it uses the org's shared identities only.
 *
 * A `switch` so a third credential kind is a type error here, not a silent fall-through.
 */
export function personalIdentityAuthor(actor: Actor): string | undefined {
	switch (actor.credential) {
		case "session":
			return actor.userId;
		case "service_token":
			return actor.orgId === actor.userId ? actor.userId : undefined;
	}
}
