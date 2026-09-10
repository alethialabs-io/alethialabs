// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4490: the sheet's five icon-only account-row controls (Save name, Cancel rename, Re-verify,
// Rename, Disconnect) were named by `title` alone — no `aria-label`. `title` IS a valid fallback
// in the accname algorithm, so a role query by name and an axe `button-name` scan both stayed
// quiet; that is exactly why this needed a test that reaches the controls the way a screen reader
// does, rather than one that checks for the `aria-label` attribute's presence (which would pass
// even for a wrong or duplicated name, and would have passed before the fix too).
//
// Nothing else renders this sheet: `apps/console/e2e` has no `connector-detail-sheet` hit, and the
// one axe sweep in this repo (`e2e/flows/cross-cutting.spec.ts`) only ever scans the org overview
// route, non-failing. Save/Cancel additionally sit behind a second conditional (`editingId`) that
// only renders once "Rename" is clicked — a route-level scan could never reach them.

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
		expect(
			screen.getByRole("button", { name: "Rename Prod AWS" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Disconnect Prod AWS" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Rename Staging AWS" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Disconnect Staging AWS" }),
		).toBeInTheDocument();

		// Only the failed account is eligible to re-verify.
		expect(
			screen.getByRole("button", { name: "Re-verify Staging AWS" }),
		).toBeInTheDocument();
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
		expect(screen.getByRole("button", { name: "Save name" })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Cancel rename" }),
		).toBeInTheDocument();
	});
});
