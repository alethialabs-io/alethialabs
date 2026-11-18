// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The credential kind an `Actor` was built from, and the one question code asks of it: whose
// `personal` cloud identities may this actor bind or use? Pure and dependency-free, so server
// actions and routes can import it without pulling in the guard.

import type {
	Actor,
	CredentialKind,
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
	credential: CredentialKind,
): Actor {
	return { ...scope, credential };
}

/**
 * Whether an actor's `userId` is the person the credential belongs to (`true`), or the profile
 * that minted a machine credential (`false`). Read by {@link personalIdentityAuthor}.
 */
const USER_ID_IS_THE_OWNER: Record<CredentialKind, boolean> = {
	session: true,
	cli_session: true,
	agent_oauth: true,
	agent_in_app: true,
	service_token: false,
};

/**
 * Whose `personal` cloud identities `actor` may bind or use — the `personalAuthorId` argument of
 * `identityScopeWhere` / `actorIdentityWhere` (lib/runners/claim-identity.ts). Every identity rule
 * asks this one function.
 *
 * - A person's own credential (`session`, `cli_session`, `agent_oauth`, `agent_in_app`): their own
 *   id. For all four `userId` is the person the credential belongs to; whether that person is
 *   present is a different question, and not this function's.
 * - A service token pinned to its minter's OWN personal workspace (`orgId === userId`): the minter's
 *   id. A personal workspace has no other member, so the token acts for the only person who could
 *   use those identities anyway.
 * - A service token pinned to any other org: nobody (`undefined`). Its `userId` is the profile that
 *   MINTED it, and a credential issued to a shared org must not reach one member's personal
 *   accounts; it uses the org's shared identities only.
 *
 * The split between the first bullet and the other two is {@link USER_ID_IS_THE_OWNER}, a record
 * keyed by every kind, so a sixth kind is a type error there until it is given an answer. A
 * `switch` here would not be: this return type contains `undefined`, so one that answered for
 * fewer kinds than exist would still compile, and the missing kind would silently get "nobody".
 */
export function personalIdentityAuthor(actor: Actor): string | undefined {
	if (USER_ID_IS_THE_OWNER[actor.credential]) return actor.userId;
	return actor.orgId === actor.userId ? actor.userId : undefined;
}

/**
 * Whether `credential` is a person present in a browser — the only kind whose own action can
 * stand as a decision to apply or destroy. Every other kind can be held by a program.
 *
 * It answers for the KIND. Which requests are bound to `session` is the builders' business, and
 * {@link CredentialKind} says where that is still wider than this function's name.
 */
export function isInteractiveCredential(credential: CredentialKind): boolean {
	switch (credential) {
		case "session":
			return true;
		case "cli_session":
		case "agent_oauth":
		case "agent_in_app":
		case "service_token":
			return false;
	}
}
