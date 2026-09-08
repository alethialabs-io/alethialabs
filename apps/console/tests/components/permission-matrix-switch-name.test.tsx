// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// EVERY permission toggle has an accessible name, and the name is the text already beside it.
//
// A `role="switch"` takes its name from the AUTHOR only — the two lines of text in the row are
// not its name, however obvious they look. The release gate's audit leg scored
// `aria-toggle-field-name` (serious) with **39 nodes** on `/[org]/~/settings/roles`, in both
// themes, and it was that route's only violation: to a screen-reader user the matrix was 39
// unnamed toggles.
//
// The count is asserted against the REGISTRY rather than against 39, because 39 is a fact about
// today's `PERMISSIONS` and not about this component. A permission added tomorrow must be named
// too, and a test pinned to the old number would go green while missing it.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PermissionMatrix } from "@/components/settings/roles/permission-matrix";
import { PERMISSIONS } from "@/lib/authz/registry";

/**
 * Every group renders open, so every switch is in the DOM.
 *
 * A group is `defaultOpen` only when it already has a grant, and a collapsed group's content is
 * unmounted — so passing every key is what makes this test see all of them. Without it the
 * matrix would report a handful of switches and pass while the rest went unnamed, which is the
 * same shape of vacuous green the gate exists to refuse.
 */
const ALL_KEYS = PERMISSIONS.map((p) => p.key);

describe("PermissionMatrix", () => {
	it("names every switch, with no reliance on a hardcoded count", () => {
		render(<PermissionMatrix value={ALL_KEYS} readOnly />);
		const switches = screen.getAllByRole("switch");
		// The denominator is the registry: a new permission is covered the day it is added.
		expect(switches).toHaveLength(PERMISSIONS.length);
		const unnamed = switches.filter(
			(s) => (s.getAttribute("aria-label") ?? "").trim() === "" && !s.getAttribute("aria-labelledby"),
		);
		expect(unnamed).toHaveLength(0);
	});

	it("names each switch by the action AND the key, because the action alone repeats", () => {
		render(<PermissionMatrix value={ALL_KEYS} readOnly />);
		// `project:create` and `runner:create` both render the action "create". A name of
		// "Create" would be ambiguous across groups, so the key is part of it.
		const target = PERMISSIONS.find((p) => p.key === "project:create");
		expect(target, "registry no longer has project:create").toBeDefined();
		expect(
			screen.getByRole("switch", { name: /create\s+project:create/i }),
		).toBeInTheDocument();
	});

	it("takes the name from the visible text, so it cannot drift from what is on screen", () => {
		const { container } = render(
			<PermissionMatrix value={ALL_KEYS} readOnly />,
		);
		const sw = screen.getByRole("switch", { name: /create\s+project:create/i });
		// Not an authored string: every id in `aria-labelledby` resolves to an element that is
		// rendered. That is the property that makes a 39-entry `aria-label` table unnecessary.
		const ids = (sw.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
		expect(ids.length).toBe(2);
		for (const id of ids) {
			const el = container.querySelector(`#${CSS.escape(id)}`);
			expect(el, `aria-labelledby points at missing #${id}`).not.toBeNull();
			expect(el?.textContent?.trim()).not.toBe("");
		}
	});

	it("gives two rendered matrices distinct ids rather than colliding on the permission key", () => {
		// The role sheet can render a matrix while one is already on the page. Ids come from
		// `useId`, not from `p.key`, precisely so the second matrix does not point every switch
		// at the first one's labels.
		render(
			<div>
				<div data-testid="a">
					<PermissionMatrix value={ALL_KEYS} readOnly />
				</div>
				<div data-testid="b">
					<PermissionMatrix value={ALL_KEYS} readOnly />
				</div>
			</div>,
		);
		const a = within(screen.getByTestId("a")).getByRole("switch", {
			name: /create\s+project:create/i,
		});
		const b = within(screen.getByTestId("b")).getByRole("switch", {
			name: /create\s+project:create/i,
		});
		expect(a.getAttribute("aria-labelledby")).not.toBe(
			b.getAttribute("aria-labelledby"),
		);
	});
});
