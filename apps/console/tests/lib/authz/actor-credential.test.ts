// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The one answer to "whose personal cloud identities may this actor use" (lib/authz/actor-credential.ts),
// and the only way a resolved scope becomes an actor. Every identity rule — design writes, the job
// snapshot, the runner routes, the kubeconfig mint, the CLI identity reads — passes this answer to
// `identityScopeWhere`, so the table below is the whole decision.

import { describe, expect, it } from "vitest";
import { actorWithCredential, personalIdentityAuthor } from "@/lib/authz/actor-credential";

describe("personalIdentityAuthor", () => {
	it("is the person, for a session — in a team org and in their own workspace", () => {
		expect(personalIdentityAuthor(actorWithCredential({ userId: "u", orgId: "team" }, "session"))).toBe("u");
		expect(personalIdentityAuthor(actorWithCredential({ userId: "u", orgId: "u" }, "session"))).toBe("u");
	});

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
