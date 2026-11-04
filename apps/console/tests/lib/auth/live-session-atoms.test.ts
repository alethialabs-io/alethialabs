// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The viewer's live-session seam reaches better-auth's REAL atoms (#6114).
//
// `lib/auth/client.ts` reads better-auth's `session` and `$sessionSignal` atoms through an untyped
// store and falls back to an inert stand-in when they are not there. That fallback would make the
// viewer stop following session changes from other tabs and on focus with no error anywhere — so
// this asserts, against the real better-auth client this console ships, that both atoms are found.

import { describe, expect, it, vi } from "vitest";

vi.mock("next-runtime-env", () => ({ env: () => undefined }));

import { sessionAtomsReachable } from "@/lib/auth/client";

describe("the live-session seam", () => {
	it("finds better-auth's session and session-signal atoms on the real client", () => {
		expect(sessionAtomsReachable()).toBe(true);
	});
});
