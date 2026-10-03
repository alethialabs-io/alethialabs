// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A Button that NAVIGATES must be announced as a link (#5444).
//
// base-ui's `useButton` merges `{role: "button"}` onto every non-native element it renders, so
// `<Button nativeButton={false} render={<Link href="…" />}>` — the console's way of drawing a link
// as a button — reached the accessibility tree as `<a href role="button">`. A screen reader said
// "button" for something that leaves the page, and `getByRole("link")` found nothing. Every
// `nativeButton={false}` call site rendering an href had it; seven renders, in six files, had
// patched it one at a time with `role="link"`.
//
// The other half matters as much: the fix must NOT strip `role="button"` from a non-native render
// that does not navigate, and a caller's own `role` must still win.

import { render, screen } from "@testing-library/react";
import type * as React from "react";
import { describe, expect, it } from "vitest";

import { Button } from "../src/button";

/** A stand-in for Next's `<Link>`: a component, not an `<a>`, whose `href` is a prop. */
function RouterLink({ href, ...rest }: { href: string } & React.ComponentProps<"a">) {
	return <a data-router-link="" href={href} {...rest} />;
}

describe("Button rendering an element with an href", () => {
	it("is a link, not a button, when it renders an <a href> through nativeButton={false}", () => {
		render(
			<Button nativeButton={false} render={<a href="/jobs" />}>
				Back to jobs
			</Button>,
		);
		const link = screen.getByRole("link", { name: "Back to jobs" });
		expect(link).toHaveAttribute("href", "/jobs");
		expect(link).toHaveAttribute("role", "link");
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("is a link when the element is a router Link component carrying the href", () => {
		render(
			<Button nativeButton={false} render={<RouterLink href="/settings" />}>
				Settings
			</Button>,
		);
		const link = screen.getByRole("link", { name: "Settings" });
		expect(link).toHaveAttribute("data-router-link");
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("defaults nativeButton to false for an href, so the anchor carries no type=button", () => {
		render(<Button render={<a href="/docs" />}>Docs</Button>);
		const link = screen.getByRole("link", { name: "Docs" });
		expect(link.tagName).toBe("A");
		expect(link).not.toHaveAttribute("type");
	});

	it("lets the caller's own role win", () => {
		render(
			<Button nativeButton={false} role="menuitem" render={<a href="/x" />}>
				Open
			</Button>,
		);
		expect(screen.getByRole("menuitem", { name: "Open" })).toHaveAttribute("href", "/x");
	});
});

describe("Button that does not navigate", () => {
	it("keeps base-ui's role=button on a non-native element with no href", () => {
		render(
			<Button nativeButton={false} render={<span />}>
				Toggle
			</Button>,
		);
		const button = screen.getByRole("button", { name: "Toggle" });
		expect(button.tagName).toBe("SPAN");
		expect(button).toHaveAttribute("role", "button");
	});

	it("is still a native <button type=button> by default", () => {
		render(<Button>Save</Button>);
		const button = screen.getByRole("button", { name: "Save" });
		expect(button.tagName).toBe("BUTTON");
		expect(button).toHaveAttribute("type", "button");
		expect(button).not.toHaveAttribute("role");
	});
});
