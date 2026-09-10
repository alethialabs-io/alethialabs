// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4490: the sheet's five icon-only account-row controls (Save name, Cancel rename, Re-verify,
// Rename, Disconnect) were named by `title` alone — no `aria-label`. `title` IS a valid fallback
// in the accname algorithm, so a role query by name and an axe `button-name` scan both stayed
// quiet.
//
// Nothing else renders this sheet: `apps/console/e2e` has no `connector-detail-sheet` hit, and the
// one axe sweep in this repo (`e2e/flows/cross-cutting.spec.ts`) only ever scans the org overview
// route, non-failing. Save/Cancel additionally sit behind a second conditional (`editingId`) that
// only renders once "Rename" is clicked — a route-level scan could never reach them.
//
// EACH CONTROL BELOW CARRIES TWO ASSERTIONS, DELIBERATELY, AND NEITHER SHOULD BE DELETED:
//
//  - `getByRole("button", { name })` proves the accessible name is correct and unambiguous — an
//    `aria-label` set to the wrong string, or one that collides with another control's name, fails
//    here even though the attribute is "present".
//  - `toHaveAttribute("aria-label", …)` is the one that actually pins THIS fix. For four of the
//    five controls (Save name, Cancel rename, Rename, Disconnect) the `aria-label` text chosen is
//    CHARACTER-IDENTICAL to the pre-existing `title` — only Re-verify's `title` carries extra text
//    ("… with the stored credentials"). jsdom's accname computation falls back to `title` when
//    `aria-label` is absent, so for those four the role query above returns the exact same node,
//    named the exact same way, whether or not `aria-label` exists — it would have passed on the
//    pre-fix tree too. The attribute assertion is what actually distinguishes "named by
//    `aria-label`" from "named by the `title` fallback", which matters because `title` is not a
//    reliable accessible name in real assistive tech: it never reaches touch, and some
//    screen-reader configurations suppress it outright. A future reader who "simplifies" this back
//    to a single role query per control silently re-introduces a test that cannot fail on a
//    reverted fix.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { ConnectorDetailSheet } from "@/components/connectors/connector-detail-sheet";

// The sheet renders `ClassificationControl` per account row, which always queries
// `canEditClassification` and (absent seeded `initialAssignments`) `getAssignments` too. Stub the
// server actions so the row renders without a real DB — this test is about the rename/reverify/
// disconnect controls' names, not classification.
vi.mock("@/app/server/actions/classification/assignments", () => ({
	assignClassification: vi.fn(),
	canEditClassification: vi.fn(async () => false),
	getAssignments: vi.fn(async () => []),
	getAssignmentsForKind: vi.fn(async () => ({})),
	unassignClassification: vi.fn(),
}));

/** Renders under a fresh QueryClient (retries off so a mock rejection would fail fast, not hang). */
function render(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** A cloud connector with one connected account and one failed one (so Re-verify renders too). */
function connector(): ConnectorWithConnection {
	return {
		id: "c-1",
		slug: "aws",
		name: "AWS",
		description: "Amazon Web Services.",
		category: "cloud",
		auth_method: "iam_role",
		organization: "Amazon",
		icon_url: "/icons/aws/aws-32x32.png",
		docs_url: null,
		support_url: null,
		privacy_url: null,
		status: "active",
		sort_order: 0,
		created_at: null,
		updated_at: null,
		connected: true,
		connection_details: null,
		group: "clouds",
		accounts: [
			{
				identityId: "acc-1",
				name: "Prod AWS",
				status: "connected",
			},
			{
				identityId: "acc-2",
				name: "Staging AWS",
				status: "failed",
				lastError: "AssumeRole denied.",
			},
		],
	};
}

/** Renders the sheet, `canManage`, open. */
function renderSheet() {
	return render(
		<ConnectorDetailSheet
			integration={connector()}
			open
			onOpenChange={() => {}}
			canManage
			onConnect={() => {}}
			onDisconnectConnector={() => {}}
			onDisconnectAccount={() => {}}
			onReverifyAccount={async () => {}}
			onRenameAccount={async () => {}}
		/>,
	);
}

describe("ConnectorDetailSheet — account row controls are reachable by accessible name", () => {
	it("names Rename, Disconnect and Re-verify per account", () => {
		renderSheet();

		// Two accounts, so "Rename"/"Disconnect" alone would be ambiguous — each name carries the
		// account, same as the board's Connect/Manage controls (#4439).
		const renameProd = screen.getByRole("button", { name: "Rename Prod AWS" });
		expect(renameProd).toBeInTheDocument();
		expect(renameProd).toHaveAttribute("aria-label", "Rename Prod AWS");

		const disconnectProd = screen.getByRole("button", {
			name: "Disconnect Prod AWS",
		});
		expect(disconnectProd).toBeInTheDocument();
		expect(disconnectProd).toHaveAttribute("aria-label", "Disconnect Prod AWS");

		const renameStaging = screen.getByRole("button", {
			name: "Rename Staging AWS",
		});
		expect(renameStaging).toBeInTheDocument();
		expect(renameStaging).toHaveAttribute("aria-label", "Rename Staging AWS");

		const disconnectStaging = screen.getByRole("button", {
			name: "Disconnect Staging AWS",
		});
		expect(disconnectStaging).toBeInTheDocument();
		expect(disconnectStaging).toHaveAttribute(
			"aria-label",
			"Disconnect Staging AWS",
		);

		// Only the failed account is eligible to re-verify.
		const reverifyStaging = screen.getByRole("button", {
			name: "Re-verify Staging AWS",
		});
		expect(reverifyStaging).toBeInTheDocument();
		expect(reverifyStaging).toHaveAttribute("aria-label", "Re-verify Staging AWS");
		expect(
			screen.queryByRole("button", { name: /re-verify prod aws/i }),
		).not.toBeInTheDocument();
	});

	it("names Save name and Cancel rename once a row enters edit mode", async () => {
		const user = userEvent.setup();
		renderSheet();

		// Save/Cancel don't exist until "Rename" is clicked — a conditional subtree a route-level
		// axe scan can never reach.
		expect(
			screen.queryByRole("button", { name: "Save name" }),
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Rename Prod AWS" }));

		// Exactly one row can be editing (`editingId` is a single id, not a set), so these two
		// names need no account in them to stay unique on the page.
		const save = screen.getByRole("button", { name: "Save name" });
		expect(save).toBeInTheDocument();
		expect(save).toHaveAttribute("aria-label", "Save name");

		const cancel = screen.getByRole("button", { name: "Cancel rename" });
		expect(cancel).toBeInTheDocument();
		expect(cancel).toHaveAttribute("aria-label", "Cancel rename");
	});
});
