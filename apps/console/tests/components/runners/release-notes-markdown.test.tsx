// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runner release notes are read from `runner_releases` and rendered as markdown inside the
// version popover. They moved from react-markdown to streamdown (#6140) so the console has one
// markdown renderer. These pin that the move kept the structure readable (heading, list, code,
// link, image) and kept the notes UNTRUSTED: a `javascript:` link and `data:`/`javascript:` images
// are neutralised to plain text, and raw HTML never becomes an element.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReleaseNotesMarkdown } from "@/components/runners/release-notes-markdown";

const NOTES = [
	"## What's changed",
	"",
	"- Faster plan uploads",
	"- Retries on transient errors",
	"",
	"Run `alethia runner update`, see [the changelog](https://example.com/changelog).",
	"",
	"```sh",
	"alethia runner update --channel stable",
	"```",
	"",
	"[click me](javascript:alert(document.cookie))",
	"",
	"![release banner](https://example.com/banner.png)",
	"",
	"![data pixel](data:image/png;base64,iVBORw0KGgo=)",
	"",
	"![script image](javascript:alert(3))",
	"",
	'<b>bold</b> <img src="https://example.com/x.png" onerror="alert(1)"> <script>alert(2)</script>',
	"",
].join("\n");

/** Renders the notes and waits for the heading, so every assertion reads a settled tree. */
async function renderNotes() {
	const view = render(<ReleaseNotesMarkdown markdown={NOTES} />);
	await screen.findByRole("heading", { level: 2, name: "What's changed" });
	return view;
}

describe("ReleaseNotesMarkdown", () => {
	it("renders a heading on a shared text rung, not streamdown's chat size", async () => {
		const { container } = await renderNotes();
		const heading = screen.getByRole("heading", { level: 2, name: "What's changed" });
		const root = container.firstElementChild;
		expect(root?.contains(heading)).toBe(true);
		// jsdom computes no Tailwind, so the rung is read where it is set: on the renderer's root,
		// as a descendant rule that out-ranks streamdown's own `text-2xl` on the h2.
		expect(root?.classList.contains("[&_h2]:text-ui-md")).toBe(true);
	});

	it("renders a list with its items, with markers generated from console source", async () => {
		const { container } = await renderNotes();
		// streamdown's own `list-disc` is never generated (no `@source` for its dist), so the
		// marker must come from the wrapper's descendant rule, which Tailwind does see.
		expect(container.firstElementChild?.classList.contains("[&_ul]:list-disc")).toBe(true);
		const items = screen.getAllByRole("listitem").map((li) => li.textContent);
		expect(items).toEqual(["Faster plan uploads", "Retries on transient errors"]);
	});

	it("renders inline code and a fenced code block", async () => {
		const { container } = await renderNotes();
		expect(screen.getByText("alethia runner update").tagName).toBe("CODE");
		const block = container.querySelector("[data-streamdown='code-block'] pre");
		expect(block?.textContent).toContain("alethia runner update --channel stable");
	});

	it("renders a safe link that opens in a new tab without an opener", async () => {
		await renderNotes();
		const link = screen.getByRole("link", { name: "the changelog" });
		expect(link).toHaveAttribute("href", "https://example.com/changelog");
		expect(link).toHaveAttribute("target", "_blank");
		expect(link.getAttribute("rel")).toContain("noopener");
	});

	it("neutralises a javascript: link", async () => {
		const { container } = await renderNotes();
		expect(screen.queryByRole("link", { name: /click me/ })).toBeNull();
		expect(screen.getByText(/click me/)).toBeInTheDocument();
		for (const el of container.querySelectorAll("[href]")) {
			expect(el.getAttribute("href")?.toLowerCase()).not.toContain("javascript:");
		}
		expect(screen.getAllByRole("link")).toHaveLength(1);
		// Text-only block policy: the link text stands alone, with no indicator or tooltip.
		expect(container.textContent).not.toContain("[blocked]");
		expect(container.querySelector("[title*='Blocked']")).toBeNull();
	});

	it("keeps a remote https image as an image", async () => {
		await renderNotes();
		const img = screen.getByRole("img", { name: "release banner" });
		expect(img).toHaveAttribute("src", "https://example.com/banner.png");
	});

	it("blocks data: and javascript: images, leaving their alt text", async () => {
		const { container } = await renderNotes();
		expect(screen.getAllByRole("img")).toHaveLength(1);
		for (const el of container.querySelectorAll("[src]")) {
			const src = el.getAttribute("src")?.toLowerCase() ?? "";
			expect(src.startsWith("data:")).toBe(false);
			expect(src.startsWith("javascript:")).toBe(false);
		}
		expect(screen.getByText("data pixel")).toBeInTheDocument();
		expect(screen.getByText("script image")).toBeInTheDocument();
		expect(container.textContent).not.toContain("[blocked]");
	});

	it("keeps raw HTML off: no element is created from it", async () => {
		const { container } = await renderNotes();
		// `<b>` is the plain signal: markdown itself never produces one (`**x**` is a `<strong>`),
		// and it is a tag the sanitiser allows — so it only exists if raw HTML was parsed.
		expect(container.querySelector("b")).toBeNull();
		expect(container.textContent).toContain("<b>bold</b>");
		expect(container.querySelector("script")).toBeNull();
		expect(container.querySelector("img[src='https://example.com/x.png']")).toBeNull();
		expect(container.querySelector("[onerror]")).toBeNull();
	});
});
