// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AGT-L2-U1 (#7501), gap G1 — the org-less `/approvals/<id>` link the CLI and the MCP tools print.
// It redirects a member of the approval's org to that org's list with the sheet open, sends anyone
// else (and any id that is not an approval) to the console root exactly as an unknown id would, and
// sends a visitor with no session to sign in, coming back here. Plus `approvalsPath`, the one place
// the new link is spelled.

import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ userId: null as string | null }));
const lookup = vi.hoisted(() => ({ target: vi.fn() }));

vi.mock("@/lib/auth/owner", () => ({ getOwner: async () => auth.userId }));
vi.mock("@/lib/approvals/http", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/approvals/http")>();
	return { ...actual, legacyApprovalTarget: lookup.target };
});
vi.mock("@/lib/db", () => ({ getServiceDb: () => ({}) }));

import { GET } from "@/app/(private)/approvals/[id]/route";
import { approvalsPath, approvePath } from "@/lib/approvals/http";

const ID = "11111111-1111-4111-8111-111111111111";

/** Calls the route for `id` and answers the redirect's status and target path. */
async function follow(id: string): Promise<{ status: number; to: string }> {
	const res = await GET(new Request(`https://console.example/approvals/${id}`), { params: Promise.resolve({ id }) });
	const location = new URL(res.headers.get("location") ?? "", "https://console.example");
	return { status: res.status, to: `${location.pathname}${location.search}` };
}

beforeEach(() => {
	auth.userId = "u-dana";
	lookup.target.mockReset();
});

describe("approvalsPath", () => {
	it("is the org's approvals list with the approval's sheet open", () => {
		expect(approvalsPath("acme", ID)).toBe(`/acme/~/approvals?selected=${ID}`);
	});

	it("is the list itself with no id", () => {
		expect(approvalsPath("acme")).toBe("/acme/~/approvals");
	});

	it("keeps the legacy org-less path for what already printed it", () => {
		expect(approvePath(ID)).toBe(`/approvals/${ID}`);
	});
});

describe("GET /approvals/:id", () => {
	it("a member is sent to the approval's org, sheet open", async () => {
		lookup.target.mockResolvedValue(approvalsPath("acme", ID));
		expect(await follow(ID)).toEqual({ status: 307, to: `/acme/~/approvals?selected=${ID}` });
		expect(lookup.target).toHaveBeenCalledWith(ID, "u-dana");
	});

	it("anyone else goes to the console root, which names nothing about the approval", async () => {
		lookup.target.mockResolvedValue(null);
		expect(await follow(ID)).toEqual({ status: 307, to: "/" });
	});

	it("an id that is not an approval id goes to the root without a lookup", async () => {
		expect(await follow("not-an-id")).toEqual({ status: 307, to: "/" });
		expect(lookup.target).not.toHaveBeenCalled();
	});

	it("no session: sign in, then come back to this link", async () => {
		auth.userId = null;
		expect(await follow(ID)).toEqual({ status: 307, to: `/login?next=${encodeURIComponent(`/approvals/${ID}`)}` });
		expect(lookup.target).not.toHaveBeenCalled();
	});
});
