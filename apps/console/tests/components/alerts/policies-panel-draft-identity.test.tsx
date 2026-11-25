// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An edit draft belongs to the policy it was opened on, and to no other.
//
// The selection is NOT this panel's own: it lives in `useAlertsSection`, and the Channels panel's
// "Used by" link moves it from outside. So the store here is the REAL one, not a stub — a stub with
// a fixed selection cannot express the one event under test, which is the selection changing while
// a draft is open. Each case states which way it moved (a rail click, or the store written directly
// as the cross-link does) because the panel only controls the first.
//
// What every case pins: `updatePolicy` is never called with one policy's id and another's draft.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolicyDTO } from "@/app/server/actions/alerts";
import type { AlertsHub } from "@/components/alerts/alerts-hub";
import { useAlertsSection } from "@/lib/stores/use-alerts-section";
import { queryWrapper } from "@/tests/helpers/query-wrapper";

const updatePolicy = vi.fn(async (input: { id: string; name: string }) => ({
	ok: true as const,
	data: { id: input.id },
}));

vi.mock("@/app/server/actions/alerts", () => ({
	updatePolicy: (input: { id: string; name: string }) => updatePolicy(input),
	togglePolicy: vi.fn(async () => ({ ok: true, data: { id: "p-a" } })),
	deletePolicy: vi.fn(async () => ({ ok: true, data: { id: "p-a" } })),
	createPolicy: vi.fn(async () => ({ ok: true, data: { id: "p-new" } })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: {} }),
	useAssignmentsQuery: () => ({ data: [], isLoading: false }),
	useDimensionsQuery: () => ({ data: [], isLoading: false }),
	useCanEditClassification: () => ({ data: false }),
	useAssignmentMutations: () => ({ assign: vi.fn(), unassign: vi.fn() }),
}));

import { PoliciesPanel } from "@/components/alerts/policies-panel";

/** A saveable policy: one event and one channel binding, so Save is not refused for emptiness. */
function policy(id: string, name: string): PolicyDTO {
	return {
		id,
		name,
		description: null,
		event_patterns: ["job.failed"],
		is_security: false,
		severity: "warning",
		match: {},
		throttle_seconds: 0,
		escalate: false,
		recipient: null,
		enabled: true,
		channels: [{ id: "c-1", minSeverity: null }],
		channelIds: ["c-1"],
	};
}

const alpha = policy("p-a", "Alpha");
const beta = policy("p-b", "Beta");

const hub: AlertsHub = {
	channels: [],
	policies: [alpha, beta],
	categories: [],
	conditionOptions: { projects: [], jobTypes: [], resourceTypes: [], actions: [] },
	alerting: true,
	advancedAlerting: false,
	canManage: true,
	encryptionConfigured: true,
	policiesKnown: true,
};

const view: Parameters<typeof PoliciesPanel>[0]["view"] = {
	rows: [alpha, beta],
	universeEmpty: false,
	facets: { status: [], kinds: [], channels: [] },
	stale: false,
	busy: false,
	state: "ready",
	refreshFailed: false,
	retry: () => {},
};

/** Render the panel and put Alpha into edit mode with its name changed to `typed`. */
async function editAlpha(user: ReturnType<typeof userEvent.setup>, typed: string) {
	render(<PoliciesPanel hub={hub} view={view} onOpenChannel={() => {}} />, {
		wrapper: queryWrapper(),
	});
	await user.click(screen.getByRole("button", { name: /edit policy/i }));
	const name = screen.getByRole("textbox", { name: /policy name/i });
	await user.clear(name);
	await user.type(name, typed);
}

/** Every id `updatePolicy` was called with. */
function savedIds(): string[] {
	return updatePolicy.mock.calls.map(([input]) => input.id);
}

describe("alerts policy: a draft is saved only onto its own policy", () => {
	beforeEach(() => {
		updatePolicy.mockClear();
		useAlertsSection.setState({ selectedPolicyId: null });
	});

	it("clicking another policy's row with unsaved edits asks first, and Cancel keeps the draft on its policy", async () => {
		const user = userEvent.setup();
		await editAlpha(user, "Alpha edited");

		await user.click(screen.getByRole("option", { name: /beta/i }));

		expect(await screen.findByText(/discard unsaved changes\?/i)).toBeInTheDocument();
		// The detail holds on Alpha behind the question — it has not become Beta's. (`hidden`: an
		// open alert dialog takes the rest of the page out of the accessibility tree.)
		expect(screen.getByRole("option", { name: /alpha/i, hidden: true })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(updatePolicy).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: /^cancel$/i }));
		await waitFor(() =>
			expect(screen.queryByText(/discard unsaved changes\?/i)).not.toBeInTheDocument(),
		);
		expect(useAlertsSection.getState().selectedPolicyId).toBe("p-a");
		expect(screen.getByRole("textbox", { name: /policy name/i })).toHaveValue("Alpha edited");

		await user.click(screen.getByRole("button", { name: /^save$/i }));
		await waitFor(() => expect(updatePolicy).toHaveBeenCalledTimes(1));
		expect(updatePolicy.mock.calls[0][0]).toMatchObject({ id: "p-a", name: "Alpha edited" });
	});

	// The path the panel does not own: the selection is written from outside, as the Channels
	// panel's "Used by" link writes it. No click in this panel precedes it.
	it("a selection moved from outside the panel with unsaved edits asks first, and Discard opens the other policy clean", async () => {
		const user = userEvent.setup();
		await editAlpha(user, "Alpha edited");

		act(() => useAlertsSection.getState().setSelectedPolicyId("p-b"));

		expect(await screen.findByText(/discard unsaved changes\?/i)).toBeInTheDocument();
		// Still Alpha's draft in Alpha's detail: no frame shows it under Beta.
		expect(screen.getByRole("textbox", { name: /policy name/i, hidden: true })).toHaveValue(
			"Alpha edited",
		);
		expect(screen.getByRole("option", { name: /alpha/i, hidden: true })).toHaveAttribute(
			"aria-selected",
			"true",
		);

		await user.click(screen.getByRole("button", { name: /discard changes/i }));
		await waitFor(() =>
			expect(screen.queryByText(/discard unsaved changes\?/i)).not.toBeInTheDocument(),
		);

		// Beta, viewed — not editing, and nothing of Alpha's draft in it.
		expect(screen.getByRole("option", { name: /beta/i })).toHaveAttribute("aria-selected", "true");
		expect(screen.queryByRole("textbox", { name: /policy name/i })).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /edit policy/i }));
		expect(screen.getByRole("textbox", { name: /policy name/i })).toHaveValue("Beta");
		expect(updatePolicy).not.toHaveBeenCalled();
	});

	// The assertion the unit is named for, with no dialog answered: whatever is clicked after the
	// selection moves, Beta's id never receives Alpha's draft.
	it("no save carries the newly selected policy's id with the previous policy's draft", async () => {
		const user = userEvent.setup();
		await editAlpha(user, "Alpha edited");

		act(() => useAlertsSection.getState().setSelectedPolicyId("p-b"));
		await screen.findByText(/discard unsaved changes\?/i);

		// Save is behind the modal question; drive it the way a script or a stray key would.
		const saves = screen.getAllByRole("button", { name: /^save$/i, hidden: true });
		expect(saves).toHaveLength(1);
		expect(saves[0]).toBeEnabled();
		act(() => saves[0].click());
		await act(async () => {});
		expect(savedIds()).not.toContain("p-b");
		expect(savedIds()).toEqual([]);
	});

	// The control: a draft with nothing in it is not worth a question. A fix that asked on every
	// selection change would pass the cases above and put a dialog in front of plain navigation.
	it("an unchanged draft is dropped without asking", async () => {
		const user = userEvent.setup();
		render(<PoliciesPanel hub={hub} view={view} onOpenChannel={() => {}} />, {
			wrapper: queryWrapper(),
		});
		await user.click(screen.getByRole("button", { name: /edit policy/i }));
		expect(screen.getByRole("textbox", { name: /policy name/i })).toHaveValue("Alpha");

		await user.click(screen.getByRole("option", { name: /beta/i }));

		expect(screen.queryByText(/discard unsaved changes\?/i)).not.toBeInTheDocument();
		expect(screen.getByRole("option", { name: /beta/i })).toHaveAttribute("aria-selected", "true");
		expect(screen.queryByRole("textbox", { name: /policy name/i })).not.toBeInTheDocument();
		// Back on Alpha, it is viewed, not resumed in an edit nobody asked for.
		await user.click(screen.getByRole("option", { name: /alpha/i }));
		expect(screen.queryByRole("textbox", { name: /policy name/i })).not.toBeInTheDocument();
	});
});
