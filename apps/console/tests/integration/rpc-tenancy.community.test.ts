// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113 (ADR 0005 Q4): the read router's tenancy proof in the COMMUNITY edition — the single-tenant
// answer, where every org address a member names resolves to the caller's PERSONAL scope
// (`currentActor()` arm 2, `lib/authz/guard.ts`).
//
// WHAT CAN FAIL HERE, AND WHAT CANNOT. Community's `getActiveScope` ignores its org argument, so
// neither the session's org nor the address's org can change who U is served as.
//   · The non-member 404s (both entry points) CAN fail: the membership check on the address
//     (`urlScopedOrgId`) is the only org-aware step left in community, and ignoring the address
//     turned both red (#6113, mutation 1).
//   · The "session X ≡ session Y" equalities CANNOT fail in community — the session is ignored by
//     construction, not by anything this file measures. Mutation 1 left them green.
//   · The "neither marker" checks fail only if community stops being single-tenant (serves an
//     org's rows instead of the personal scope). They pin what community MEANS; they do not
//     measure the address.
// The body, and what it does and does not claim, is `rpc-tenancy.shared.ts`.
//
// `ALETHIA_EDITION=community` is the configured single-tenant edition: ee/dist is not loaded even
// when it is built, and the suite's `beforeAll` asserts `editionState()` says exactly that.

import { afterAll, vi } from "vitest";

/** The hoisted request state the mocks read; `previous` restores the edition after the file. */
interface HoistedRequest {
	path: string;
	user: string;
	sessionOrg: string | undefined;
	previous: string | undefined;
}

const h = vi.hoisted((): HoistedRequest => {
	const previous = process.env.ALETHIA_EDITION;
	// Before ANY import: `lib/auth` builds better-auth at module evaluation, which loads the edition.
	process.env.ALETHIA_EDITION = "community";
	return { path: "", user: "", sessionOrg: undefined, previous };
});

// The three mocks `rpc-tenancy.shared.ts` expects — identical in both edition files; the shared
// `beforeAll` checks they are installed as written.
vi.mock("next/headers", () => ({
	headers: async () => new Headers({ "x-alethia-path": h.path }),
}));
vi.mock("@/lib/auth/owner", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth/owner")>()),
	getOwnerScope: async () => ({ userId: h.user, sessionId: "s", activeOrgId: h.sessionOrg }),
}));
vi.mock("@/lib/billing/eligibility", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/eligibility")>()),
	hasAcceptedCurrentDocuments: async () => true,
}));

import { runRpcTenancySuite } from "./rpc-tenancy.shared";

afterAll(() => {
	if (h.previous === undefined) delete process.env.ALETHIA_EDITION;
	else process.env.ALETHIA_EDITION = h.previous;
});

await runRpcTenancySuite({ edition: "community", h });
