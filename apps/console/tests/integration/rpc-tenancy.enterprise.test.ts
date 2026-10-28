// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113 (ADR 0005 Q4): the read router's tenancy proof in the ENTERPRISE edition — the multi-tenant
// answer, where an address on Y is served Y's rows and nothing of X's whatever the session says.
// The body, and what it does and does not claim, is `rpc-tenancy.shared.ts`.
//
// REQUIRES `ee/dist/index.js` (`pnpm -F @alethia/ee build`). With `ALETHIA_EDITION=enterprise` a
// missing or broken module makes the load FAIL (`lib/enterprise.ts`, #6149) and the suite's
// `beforeAll` asserts `editionState()` is enterprise — so this file reds, it never skips into a
// community answer. CI builds ee/dist in the Integration job and guards that it exists.

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
	process.env.ALETHIA_EDITION = "enterprise";
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

await runRpcTenancySuite({ edition: "enterprise", h });
