// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The one answer to "whose personal cloud identities may this actor use" (lib/authz/actor-credential.ts),
// and the only way a resolved scope becomes an actor. Every identity rule — design writes, the job
// snapshot, the runner routes, the kubeconfig mint, the CLI identity reads — passes this answer to
// `identityScopeWhere`, so the table below is the whole decision.

import { describe, expect, it } from "vitest";
import {
	actorWithCredential,
	isInteractiveCredential,
	personalIdentityAuthor,
} from "@/lib/authz/actor-credential";
import { CREDENTIAL_KINDS } from "@/lib/authz/types";

describe("personalIdentityAuthor", () => {
	it("is the person, for a session — in a team org and in their own workspace", () => {
		expect(personalIdentityAuthor(actorWithCredential({ userId: "u", orgId: "team" }, "session"))).toBe("u");
		expect(personalIdentityAuthor(actorWithCredential({ userId: "u", orgId: "u" }, "session"))).toBe("u");
	});

	// A device login, an MCP grant and an in-product agent turn all act for the person the
	// credential belongs to, so the identity rule answers for them as it does for a session.
	it.each(["cli_session", "agent_oauth", "agent_in_app"] as const)(
		"is the person, for %s — in a team org and in their own workspace",
		(credential) => {
			expect(personalIdentityAuthor(actorWithCredential({ userId: "u", orgId: "team" }, credential))).toBe("u");
			expect(personalIdentityAuthor(actorWithCredential({ userId: "u", orgId: "u" }, credential))).toBe("u");
		},
	);

	it("is nobody, for a service token pinned to a team org: its user id is the minter's", () => {
		expect(
			personalIdentityAuthor(actorWithCredential({ userId: "minter", orgId: "team" }, "service_token")),
		).toBeUndefined();
	});

	it("is the minter, for a service token pinned to the minter's own personal workspace", () => {
		expect(
			personalIdentityAuthor(actorWithCredential({ userId: "minter", orgId: "minter" }, "service_token")),
		).toBe("minter");
	});
});

describe("actorWithCredential", () => {
	it("binds the kind it is given and keeps the scope", () => {
		expect(actorWithCredential({ userId: "u", orgId: "o" }, "service_token")).toEqual({
			userId: "u",
			orgId: "o",
			credential: "service_token",
		});
	});
});

describe("isInteractiveCredential", () => {
	// The whole table, keyed by the list of kinds itself, so a kind added to the union without an
	// answer here fails on the missing key rather than passing unasked.
	const expected: Record<(typeof CREDENTIAL_KINDS)[number], boolean> = {
		session: true,
		cli_session: false,
		agent_oauth: false,
		agent_in_app: false,
		service_token: false,
	};

	it.each(CREDENTIAL_KINDS)("answers for %s", (credential) => {
		expect(isInteractiveCredential(credential)).toBe(expected[credential]);
	});

	it("is true for exactly one kind", () => {
		expect(CREDENTIAL_KINDS.filter(isInteractiveCredential)).toEqual(["session"]);
	});
});
