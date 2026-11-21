// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4490: the sheet's six icon-only account-row controls (Save name, Cancel rename, Re-verify,
// Rename, Disconnect, Classify) were named by `title` alone, or — for Classify — by a bare
// "Classify" shared by every row. `title` IS a valid fallback in the accname algorithm, so a role
// query by name and an axe `button-name` scan both stayed quiet on the title-only defect; a bare
// "Classify" repeated per row is a different defect (duplicate names, not absent ones) that the
// same axe rules don't flag either.
//
// Nothing else renders this sheet: `apps/console/e2e` has no `connector-detail-sheet` hit, and the
// one axe sweep in this repo (`e2e/flows/cross-cutting.spec.ts`) only ever scans the org overview
// route, non-failing. Save/Cancel additionally sit behind a second conditional (`editingId`) that
// only renders once "Rename" is clicked — a route-level scan could never reach them.
//
// HOW EACH CONTROL IS CHECKED, AND WHY NOT `toHaveAttribute`:
//
// This repo's stated convention (`tests/support/accessible-names.ts:63-67`,
// `page-controls-accessible-names.test.tsx:19-21`) is "assert the NAME, never the attribute" — an
// earlier revision of this file asserted `toHaveAttribute("aria-label", …)` instead, which is
// exactly backwards: it would fail a later, equally correct fix (naming these buttons via an
// `sr-only` span or `aria-labelledby` instead of `aria-label`) even though the accessible name
// stayed identical.
//
// But a bare role query can't pin this fix either — for four of the five title/aria-label pairs
// the two attributes' text is character-identical, so `getByRole("button", { name })` finds the
// same node whether `aria-label` exists or not (jsdom's accname computation falls back to `title`
// when `aria-label` is absent). `expectNamedWithoutTitleFallback` below closes that gap without
// naming any attribute: find the control by its expected name (works via `title` OR `aria-label`,
// deliberately — this step doesn't care which), strip `title`, then assert the SAME name still
// holds. That is red on the pre-fix tree for every control regardless of whether its `title` text
// happened to match: title-only naming disappears the moment `title` is gone; a real `aria-label`
// (or any other naming mechanism) does not. It is also green for any future correct renaming
// mechanism, which a `toHaveAttribute` assertion would not be. `title` is not a reliable
// accessible name in real assistive tech — it never reaches touch, and some screen-reader
// configurations suppress it outright — which is the actual, real-world defect being pinned.
//
// `unnamedControls` (the sweep `page-controls-accessible-names.test.tsx` /
// `shell-chrome-accessible-names.test.tsx` already use) runs alongside the per-control checks so
// the NEXT icon-only control this sheet grows doesn't ship silently unnamed just because it isn't
// individually enumerated here.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { ConnectorDetailSheet } from "@/components/connectors/connector-detail-sheet";
import { notOfferedSentence } from "@/components/connectors/connectors-query";
import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { unnamedControls } from "../support/accessible-names";

// `classification.canEdit` answers TRUE (not false) so `ClassificationControl` takes its
// `showPicker` branch — the same branch a real manager sees — and renders the per-row compact
// "Classify" trigger this sheet puts in production. Answering false would delete that button from
// every tree this file renders, which is exactly how the sixth control went unchecked before #4490's
// third review thread. The now-rendered `ClassificationPicker` queries the org's dimension taxonomy
// on mount; its popover content is never opened in this file, so an empty list is enough — this
// test is about the trigger's name, not the picker. All of them are GET reads since #6129.
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return {
		orpc: fakeOrpc({
			"classification.canEdit": async () => true,
			"classification.assignments": async () => [],
			"classification.assignmentsForKind": async () => ({}),
			"classification.dimensions": async () => [],
		}).orpc,
	};
});
// The sheet owns the rename (#6816): its inline form submits through `useActionMutation`.
const renameCloudAccount = vi.hoisted(() => vi.fn());
vi.mock("@/app/server/actions/identities", () => ({ renameCloudAccount }));
vi.mock("@/app/server/actions/classification/assignments", () => ({
	assignClassification: vi.fn(),
	unassignClassification: vi.fn(),
}));
// `ClassificationPicker` reads the org slug for its "no dimensions yet" link, unconditionally, and
// its writes go through `useActionMutation`, which reads the router (an expired session is sent to
// sign-in).
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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

/** Renders the sheet, open, for a manager unless `over` says otherwise. */
function renderSheet(over: { canManage?: boolean; offered?: boolean } = {}) {
	return render(
		<ConnectorDetailSheet
			integration={connector()}
			open
			onOpenChange={() => {}}
			canManage={over.canManage ?? true}
			offered={over.offered}
			onConnect={() => {}}
			onDisconnectConnector={() => {}}
			onDisconnectAccount={() => {}}
			onReverifyAccount={async () => {}}
		/>,
	);
}

/**
 * Finds a button by its expected accessible name (via `title` OR `aria-label` — either is a valid
 * source at this step), strips `title`, then re-asserts the SAME name. A control named only by
 * `title` loses its name here; one named by `aria-label` (or any other real mechanism) keeps it.
 */
function expectNamedWithoutTitleFallback(name: string): HTMLElement {
	const control = screen.getByRole("button", { name });
	control.removeAttribute("title");
	expect(control).toHaveAccessibleName(name);
	return control;
}

describe("ConnectorDetailSheet — account row controls are reachable by accessible name", () => {
	it("names Rename, Disconnect, Classify and Re-verify per account, independent of title", async () => {
		const { container } = renderSheet();

		// `ClassificationControl`'s `showPicker` gate depends on `useCanEditClassification`, an
		// async query — the compact "Classify" trigger isn't in the tree until it resolves.
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Classify Prod AWS" }),
			).toBeInTheDocument(),
		);

		// Two accounts, so "Rename"/"Disconnect"/"Classify" alone would be ambiguous — each name
		// carries the account, same as the board's Connect/Manage controls (#4439).
		expectNamedWithoutTitleFallback("Rename Prod AWS");
		expectNamedWithoutTitleFallback("Disconnect Prod AWS");
		expectNamedWithoutTitleFallback("Classify Prod AWS");
		expectNamedWithoutTitleFallback("Rename Staging AWS");
		expectNamedWithoutTitleFallback("Disconnect Staging AWS");
		expectNamedWithoutTitleFallback("Classify Staging AWS");

		// Every account can be re-verified (#6816), not only one that already failed: a role
		// changed in the cloud is checked from here.
		expectNamedWithoutTitleFallback("Re-verify Staging AWS");
		expectNamedWithoutTitleFallback("Re-verify Prod AWS");

		// The sweep, so the next icon-only control this sheet grows doesn't ship silently unnamed
		// just because nobody added it to the list above.
		expect(unnamedControls(container)).toEqual([]);
	});

	it("names Save name and Cancel rename once a row enters edit mode, independent of title", async () => {
		const user = userEvent.setup();
		const { container } = renderSheet();

		// Save/Cancel don't exist until "Rename" is clicked — a conditional subtree a route-level
		// axe scan can never reach.
		expect(
			screen.queryByRole("button", { name: "Save name" }),
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Rename Prod AWS" }));

		// Exactly one row can be editing (`editingId` is a single id, not a set), so these two
		// names need no account in them to stay unique on the page.
		expectNamedWithoutTitleFallback("Save name");
		expectNamedWithoutTitleFallback("Cancel rename");

		// Let `useCanEditClassification` settle before the sweep, so it judges the same tree a
		// manager actually sees (picker rendered) rather than a transient loading one. Staging AWS,
		// not Prod AWS: the row being edited swaps its whole right-hand side for the Input +
		// Save/Cancel pair, so Prod AWS's own Classify trigger is unmounted while editingId holds it.
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Classify Staging AWS" }),
			).toBeInTheDocument(),
		);
		expect(unnamedControls(container)).toEqual([]);
	});
});

describe("ConnectorDetailSheet — renaming a cloud account (#6816)", () => {
	it("refuses an empty name under the field, and sends nothing", async () => {
		const user = userEvent.setup();
		renameCloudAccount.mockReset();
		renderSheet();

		await user.click(screen.getByRole("button", { name: "Rename Prod AWS" }));
		const field = screen.getByRole("textbox", { name: "Account name" });
		await user.clear(field);
		await user.click(screen.getByRole("button", { name: "Save name" }));

		expect(await screen.findByText("Name cannot be empty.")).toBeInTheDocument();
		expect(renameCloudAccount).not.toHaveBeenCalled();
		// The form is still open, with the field still there to correct.
		expect(screen.getByRole("textbox", { name: "Account name" })).toBeInTheDocument();
	});

	it("sends the trimmed name once and closes the form when the rename lands", async () => {
		const user = userEvent.setup();
		renameCloudAccount.mockReset();
		renameCloudAccount.mockResolvedValue({ ok: true, data: { identityId: "acc-1", name: "Production" } });
		renderSheet();

		await user.click(screen.getByRole("button", { name: "Rename Prod AWS" }));
		const field = screen.getByRole("textbox", { name: "Account name" });
		await user.clear(field);
		await user.type(field, "  Production {Enter}");

		await waitFor(() =>
			expect(renameCloudAccount).toHaveBeenCalledWith({ identityId: "acc-1", name: "Production" }),
		);
		expect(renameCloudAccount).toHaveBeenCalledTimes(1);
		await waitFor(() =>
			expect(screen.queryByRole("textbox", { name: "Account name" })).not.toBeInTheDocument(),
		);
	});

	it("keeps the form open with the server's sentence under the field when the name is refused", async () => {
		const user = userEvent.setup();
		renameCloudAccount.mockReset();
		renameCloudAccount.mockResolvedValue({
			ok: false,
			error: { kind: "validation", message: "Invalid input.", fields: { name: ["Keep the name under 120 characters."] } },
		});
		renderSheet();

		await user.click(screen.getByRole("button", { name: "Rename Prod AWS" }));
		const field = screen.getByRole("textbox", { name: "Account name" });
		await user.clear(field);
		await user.type(field, "Another{Enter}");

		expect(await screen.findByText("Keep the name under 120 characters.")).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Account name" })).toHaveValue("Another");
	});

	it("closes without a request when the name was not changed", async () => {
		const user = userEvent.setup();
		renameCloudAccount.mockReset();
		renderSheet();

		await user.click(screen.getByRole("button", { name: "Rename Prod AWS" }));
		await user.click(screen.getByRole("button", { name: "Save name" }));

		await waitFor(() =>
			expect(screen.queryByRole("textbox", { name: "Account name" })).not.toBeInTheDocument(),
		);
		expect(renameCloudAccount).not.toHaveBeenCalled();
	});
});

describe("ConnectorDetailSheet — a viewer who may not manage connections (#6816)", () => {
	it("draws every changing control disabled with the reason, and says the sheet is read-only", () => {
		const { container } = renderSheet({ canManage: false });

		for (const name of [
			"Re-verify Prod AWS",
			"Rename Prod AWS",
			"Disconnect Prod AWS",
			"Add another account",
		]) {
			const control = screen.getByRole("button", { name });
			expect(control).toBeDisabled();
			expect(control).toHaveAccessibleDescription(MANAGE_DENIED_REASON);
		}
		expect(container.ownerDocument.querySelector('[data-slot="connector-read-only"]')).toHaveTextContent(
			MANAGE_DENIED_REASON,
		);
	});
});

describe("ConnectorDetailSheet — a cloud that takes no new connection (#6816)", () => {
	it("says why once, keeps the account's controls, and offers no way to add an account", () => {
		const { container } = renderSheet({ offered: false });

		expect(container.ownerDocument.querySelector('[data-slot="connector-not-offered"]')).toHaveTextContent(
			notOfferedSentence("AWS"),
		);
		expect(screen.getByRole("button", { name: "Re-verify Prod AWS" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Rename Prod AWS" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Disconnect Prod AWS" })).toBeEnabled();
		expect(screen.queryByRole("button", { name: "Add another account" })).not.toBeInTheDocument();
	});
});
