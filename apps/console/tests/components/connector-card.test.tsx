// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component test for ConnectorCard: a connected connector renders its logo in
// full color (no grayscale filter) and offers "Manage"; a not-connected one is
// grayscale and offers "Connect".

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { ConnectorCard } from "@/components/connectors/connector-card";
import { unnamedControls } from "../support/accessible-names";

/** Builds a non-git (observability) connector fixture so the logo routes through ConnectorIcon. */
function connector(
	over: Partial<ConnectorWithConnection> = {},
): ConnectorWithConnection {
	return {
		id: "c-1",
		slug: "datadog",
		name: "Datadog",
		description: "Observability platform.",
		category: "observability",
		auth_method: "api_key",
		organization: "Datadog, Inc.",
		icon_url: "/icons/datadog/datadog-32x32.png",
		docs_url: null,
		support_url: null,
		privacy_url: null,
		status: "active",
		sort_order: 0,
		created_at: null,
		updated_at: null,
		connected: false,
		connection_details: null,
		group: "observability",
		...over,
	};
}

describe("ConnectorCard", () => {
	it("renders a connected logo in color and offers Manage", () => {
		render(
			<ConnectorCard
				integration={connector({ connected: true })}
				canManage
				onConnect={() => {}}
				onManage={() => {}}
			/>,
		);
		const logo = screen.getByAltText("Datadog");
		expect(logo.className).not.toContain("grayscale");
		expect(screen.getByRole("button", { name: /manage/i })).toBeInTheDocument();
	});

	it("renders a not-connected logo in grayscale and offers Connect", () => {
		render(
			<ConnectorCard
				integration={connector({ connected: false })}
				canManage
				onConnect={() => {}}
				onManage={() => {}}
			/>,
		);
		const logo = screen.getByAltText("Datadog");
		expect(logo.className).toContain("grayscale");
		expect(screen.getByRole("button", { name: /connect/i })).toBeInTheDocument();
	});

	it("shows Verification failed + a Re-verify action that calls onReverify", async () => {
		const user = userEvent.setup();
		const onReverify = vi.fn();
		render(
			<ConnectorCard
				integration={connector({
					category: "cloud",
					slug: "aws",
					name: "AWS",
					connected: false,
					cloud_health: "failed",
					last_error: "AssumeRole denied — check the role trust policy.",
					reverify_identity_id: "id-1",
				})}
				canManage
				onConnect={() => {}}
				onManage={() => {}}
				onReverify={onReverify}
			/>,
		);
		expect(screen.getByText(/verification failed/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /re-verify/i }));
		expect(onReverify).toHaveBeenCalledTimes(1);
	});

	it("gates an unconfigured git provider — 'Not enabled on this instance', no Connect", () => {
		render(
			<ConnectorCard
				integration={connector({
					category: "git",
					slug: "github",
					name: "GitHub",
					connected: false,
				})}
				canManage
				platformConfigured={false}
				onConnect={() => {}}
				onManage={() => {}}
			/>,
		);
		expect(screen.getByText(/not enabled on this instance/i)).toBeInTheDocument();
		expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /connect/i }),
		).not.toBeInTheDocument();
	});

	it("offers Connect for a configured git provider", () => {
		render(
			<ConnectorCard
				integration={connector({
					category: "git",
					slug: "github",
					name: "GitHub",
					connected: false,
				})}
				canManage
				platformConfigured
				onConnect={() => {}}
				onManage={() => {}}
			/>,
		);
		expect(screen.getByRole("button", { name: /connect/i })).toBeInTheDocument();
		expect(
			screen.queryByText(/not enabled on this instance/i),
		).not.toBeInTheDocument();
	});

	it("shows a Verifying… state with no action while a test is in flight", () => {
		render(
			<ConnectorCard
				integration={connector({
					category: "cloud",
					slug: "aws",
					name: "AWS",
					connected: false,
					cloud_health: "testing",
				})}
				canManage
				onConnect={() => {}}
				onManage={() => {}}
				onReverify={() => {}}
			/>,
		);
		expect(screen.getByText(/verifying/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /connect|re-verify/i }),
		).not.toBeInTheDocument();
	});
});

// ── Pick mode (#4625) ────────────────────────────────────────────────────────────────────────
//
// The create-project cloud picker renders THIS card with `selectable`, and the pick used to be a
// bare `<div onClick>`: no role, no `tabIndex`, no key handling, and an `aria-hidden` check
// indicator. Choosing a cloud — the first required step of creating a project — was therefore
// impossible from a keyboard.
//
// That is an OPERABILITY failure, not a naming one, which is the shape these tests take: a query
// that only asks whether a control EXISTS, or what it is CALLED, passes happily over a tile no
// keyboard can reach. So the assertions are FOCUS and ACTIVATION — `user.tab()` has to land on the
// tile, and Enter and Space have to run the same handler a click does.
//
// `user-event` does NOT synthesise a click for a `<div role="button">` the way it does for a native
// `<button>`; it dispatches the key events and nothing else. So the Enter and Space tests are red
// both for the original bare div AND for a `role`/`tabIndex` addition that forgot its key handler.
describe("ConnectorCard — pick mode", () => {
	/** A connected, healthy cloud: the one shape `isPick` accepts. */
	function cloud(over: Partial<ConnectorWithConnection> = {}): ConnectorWithConnection {
		return connector({
			slug: "aws",
			name: "AWS",
			description: "Amazon Web Services.",
			category: "cloud",
			auth_method: "iam_role",
			connected: true,
			accounts: [{ identityId: "acc-1", name: "Prod", status: "connected" }],
			...over,
		});
	}

	/** Renders the card the way `create-project/cloud-picker.tsx` does. */
	function renderPick(
		over: {
			selected?: boolean;
			onSelect?: () => void;
			integration?: ConnectorWithConnection;
		} = {},
	) {
		return render(
			<ConnectorCard
				integration={over.integration ?? cloud()}
				canManage
				onConnect={() => {}}
				onManage={() => {}}
				selectable
				selected={over.selected ?? false}
				onSelect={over.onSelect ?? (() => {})}
			/>,
		);
	}

	const PICK = { name: "Select AWS" } as const;

	it("exposes the pick as a control named for its cloud", () => {
		renderPick();
		// The NAME, not the attribute that happens to carry it (tests/support/accessible-names.ts):
		// an `aria-labelledby` at the title node would be an equally correct fix and must stay green.
		expect(screen.getByRole("button", PICK)).toBeInTheDocument();
	});

	it("puts the pick in the tab order", async () => {
		const user = userEvent.setup();
		renderPick();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByRole("button", PICK));
	});

	it("selects on Enter", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		renderPick({ onSelect });
		await user.tab();
		await user.keyboard("{Enter}");
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it("selects on Space", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		renderPick({ onSelect });
		await user.tab();
		await user.keyboard("[Space]");
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it("ignores a key that is not an activation key", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		renderPick({ onSelect });
		await user.tab();
		await user.keyboard("{ArrowDown}a{Escape}");
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("selects once — not twice — when the pointer clicks the tile", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		renderPick({ onSelect });
		await user.click(screen.getByText("Amazon Web Services."));
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it("says whether the pick is chosen, not just what colour it is", () => {
		const { unmount } = renderPick({ selected: true });
		expect(screen.getByRole("button", { ...PICK, pressed: true })).toBeInTheDocument();
		unmount();
		renderPick({ selected: false });
		expect(screen.getByRole("button", { ...PICK, pressed: false })).toBeInTheDocument();
	});

	// THE REGRESSION `role="button"` BUYS IF NOTHING WATCHES IT. `button` is
	// children-presentational in ARIA, so the tile's body stops being content the moment the role
	// lands: measured on this tree, a bare `role="button"` computed ONE name reading
	// "AWS AWS Amazon Web Services. 1 accountConnected" and exposed no description at all. The
	// explicit name plus `aria-describedby` is what gives the copy and the state back — and this
	// asserts the DESCRIPTION, which is the half that silently disappears if either id is dropped.
	it("keeps the description and the connection state out of the name and in the description", () => {
		renderPick();
		const pick = screen.getByRole("button", PICK);
		expect(pick).toHaveAccessibleName("Select AWS");
		expect(pick).toHaveAccessibleDescription(/Amazon Web Services\./);
		expect(pick).toHaveAccessibleDescription(/1 account/);
		expect(pick).toHaveAccessibleDescription(/Connected/);
	});

	// The sweep, over the WHOLE rendered card rather than the control this issue added — so the
	// next control a pick tile grows cannot ship unnamed either (the same denominator
	// `shell-chrome-accessible-names.test.tsx` uses).
	it("leaves no unnamed control anywhere in the pick tile", () => {
		const { container } = renderPick({ selected: true });
		expect(unnamedControls(container)).toEqual([]);
	});

	// `isPick` is SIX conditions and the role rides behind all of them, so a tile that is not a
	// pick target must not claim to be one. An unconnected cloud in a selectable picker still
	// offers Connect, and Connect is the only control on it.
	it("gives no pick role to a selectable tile that is not a pick target", () => {
		renderPick({ integration: cloud({ connected: false, accounts: [] }) });
		expect(screen.queryByRole("button", PICK)).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Connect AWS" })).toBeInTheDocument();
	});

	// `selectable` is off everywhere but the picker, and the connectors page must render exactly
	// what it rendered before: one Manage button, no pick control, no tab stop.
	it("adds nothing to the connectors-page card", () => {
		const { container } = render(
			<ConnectorCard
				integration={cloud()}
				canManage
				onConnect={() => {}}
				onManage={() => {}}
			/>,
		);
		expect(screen.getByRole("button", { name: "Manage AWS" })).toBeInTheDocument();
		expect(screen.queryByRole("button", PICK)).not.toBeInTheDocument();
		const root = container.firstElementChild;
		expect(root).not.toHaveAttribute("role");
		expect(root).not.toHaveAttribute("tabindex");
		expect(root).not.toHaveClass("cursor-pointer");
		expect(unnamedControls(container)).toEqual([]);
	});
});
