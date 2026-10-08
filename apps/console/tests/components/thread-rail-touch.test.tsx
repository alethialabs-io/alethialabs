// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A chat's "Delete chat …" control must be reachable on a device that cannot hover (#5657).
// It used to be `opacity-0` with only `group-hover:` and `focus-visible:` to lift it — and
// Tailwind v4 scopes `group-hover:` to `@media (hover: hover)`, so on a phone (where #5655
// made the rail reachable as a sheet) there was no gesture that ever showed it.
//
// What jsdom CANNOT see: it evaluates no media queries and computes no Tailwind CSS, so it
// cannot tell us the button is visible on a touch screen. These tests pin the CLASS contract
// that produces that visibility in a real browser — a `(hover: none)` media variant that lifts
// the opacity, a keyboard reveal, and the hover reveal kept for pointers that can hover —
// plus the named ink tier (no alpha) and the accessible name.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadRail } from "@/components/agent/thread-rail";
import type { AgentThread } from "@/lib/db/schema";

const TITLE = "Scale the staging cluster";

/** A minimal thread row for rendering (only the fields the rail reads). */
function thread(): AgentThread {
	const now = new Date();
	return {
		id: "t1",
		org_id: "o1",
		user_id: "u1",
		project_id: null,
		title: TITLE,
		status: "active",
		kind: "chat",
		messages: [],
		billing_org_id: null,
		revision: 1,
		created_at: now,
		updated_at: now,
	};
}

/** Render the rail with one thread and return its delete control's class tokens. */
function deleteControlClasses(): string[] {
	render(
		<ThreadRail
			threads={[thread()]}
			activeId={null}
			onSelect={vi.fn()}
			onNew={vi.fn()}
			onDelete={vi.fn()}
		/>,
	);
	const btn = screen.getByRole("button", { name: `Delete chat ${TITLE}` });
	return btn.className.split(/\s+/);
}

describe("thread rail delete control on touch screens (#5657)", () => {
	it("is shown outright on a device that cannot hover", () => {
		const classes = deleteControlClasses();
		// Hidden by default, and lifted by a (hover: none) media variant — the only reveal
		// a touch screen can trigger without a keyboard.
		expect(classes).toContain("opacity-0");
		expect(classes).toContain("[@media(hover:none)]:opacity-100");
	});

	it("is shown outright when ANY pointer is coarse — a touchscreen laptop's primary pointer can hover", () => {
		// (hover: none) reads only the PRIMARY pointer, so a laptop with a touchscreen, or a tablet
		// with a trackpad, would otherwise leave a tap with nothing to press.
		expect(deleteControlClasses()).toContain("[@media(any-pointer:coarse)]:opacity-100");
	});

	it("keeps the hover reveal for pointers that can hover, and reveals on keyboard focus", () => {
		const classes = deleteControlClasses();
		expect(classes).toContain("group-hover:opacity-100");
		expect(classes).toContain("focus-visible:opacity-100");
		expect(classes).toContain("group-focus-within:opacity-100");
	});

	it("uses a named ink tier at full strength — no alpha on the text colour", () => {
		const classes = deleteControlClasses();
		expect(classes).toContain("text-muted-foreground");
		expect(classes.filter((c) => /(^|:)text-[a-z-]+\/[\d[]/.test(c))).toEqual([]);
	});
});
