// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// SectionHeading (src/section-heading.tsx): the heading inside a page. `level` sets the outline
// rung and nothing else, a plain-string title is recoverable when it truncates, and the
// description and actions each render only when given, and it renders no count (LST-14).

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SectionHeading } from "../src/section-heading";
import { Spinner } from "../src/spinner";

/** The outline rungs below the default. */
const LEVELS: readonly (3 | 4 | 5 | 6)[] = [3, 4, 5, 6];

describe("SectionHeading", () => {
	it("is a level-2 heading by default and carries its string title as a tooltip", () => {
		render(<SectionHeading title="Members" />);
		const heading = screen.getByRole("heading", { level: 2, name: "Members" });
		expect(heading).toHaveAttribute("title", "Members");
	});

	it.each(LEVELS)("renders level %i with the same type rung", (level) => {
		render(<SectionHeading title="Members" level={level} />);
		expect(screen.getByRole("heading", { level, name: "Members" })).toHaveClass("text-ui-lg");
	});

	it("gives a non-string title no tooltip", () => {
		render(<SectionHeading title={<span>Members</span>} />);
		expect(screen.getByRole("heading", { name: "Members" })).not.toHaveAttribute("title");
	});

	it("renders the description and the actions only when given", () => {
		const { container, rerender } = render(<SectionHeading title="Members" />);
		expect(container.querySelector('[data-slot="section-heading-description"]')).toBeNull();
		expect(container.querySelector('[data-slot="section-heading-actions"]')).toBeNull();

		rerender(
			<SectionHeading
				title="Members"
				description="People with access"
				actions={<button type="button">Invite</button>}
			/>,
		);
		expect(screen.getByText("People with access")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
	});

	it("renders no count pill (the console carries no list counts, epic #7481)", () => {
		const { container } = render(<SectionHeading title="Members" description="People with access" />);
		expect(container.querySelector('[data-slot="count-pill"]')).toBeNull();
	});

	it("passes its other props to the root, and merges the class", () => {
		const { container } = render(<SectionHeading title="Members" id="members" className="mt-4" />);
		const root = container.querySelector('[data-slot="section-heading"]');
		expect(root).toHaveAttribute("id", "members");
		expect(root).toHaveClass("mt-4", "flex");
	});
});

describe("Spinner", () => {
	// The [·] mark loader since #7740: its motion is the `.ah-loader__*` keyframes, not a spin.
	it("is a status named Loading, and merges the class", () => {
		render(<Spinner className="size-6" />);
		const spinner = screen.getByRole("status", { name: "Loading" });
		expect(spinner).toHaveClass("ah-loader__glyph", "size-6");
	});
});
