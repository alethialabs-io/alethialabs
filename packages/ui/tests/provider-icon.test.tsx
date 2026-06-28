// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit test for the ProviderIcon mapping: provider slug → the right <img> src/alt
// (cloud vs git path conventions, size buckets), the inline currentColor SVGs for
// github/google, the null fallback for unknown slugs, and size/class/mono props.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderIcon } from "../src/provider-icon";

describe("ProviderIcon", () => {
	it("renders a cloud provider as an <img> with the bucketed favicon path and label alt", () => {
		render(<ProviderIcon provider="aws" size={32} />);
		const img = screen.getByRole("img", { name: "AWS" });
		expect(img).toHaveAttribute("src", "/aws/favicon_32x32.png");
		expect(img).toHaveAttribute("width", "32");
		expect(img).toHaveAttribute("height", "32");
	});

	it("buckets the cloud favicon size up to the next available asset", () => {
		// size 40 falls in the (32, 48] bucket → 48px asset.
		const { rerender } = render(<ProviderIcon provider="gcp" size={40} />);
		expect(screen.getByRole("img", { name: "GCP" })).toHaveAttribute(
			"src",
			"/gcp/favicon_48x48.png",
		);

		// size 100 is above the largest bucket → clamps to 64px asset.
		rerender(<ProviderIcon provider="gcp" size={100} />);
		expect(screen.getByRole("img", { name: "GCP" })).toHaveAttribute(
			"src",
			"/gcp/favicon_64x64.png",
		);

		// default size 16 → 16px asset.
		rerender(<ProviderIcon provider="gcp" />);
		expect(screen.getByRole("img", { name: "GCP" })).toHaveAttribute(
			"src",
			"/gcp/favicon_16x16.png",
		);
	});

	it("renders a git provider with the /icons path convention and the brand label", () => {
		render(<ProviderIcon provider="gitlab" size={24} />);
		const img = screen.getByRole("img", { name: "GitLab" });
		expect(img).toHaveAttribute("src", "/icons/gitlab/gitlab-32x32.png");
		expect(img).toHaveAttribute("width", "24");
	});

	it("uppercases/normalizes the slug before mapping", () => {
		render(<ProviderIcon provider="AWS" />);
		// Resolved despite the mixed-case input.
		expect(screen.getByRole("img", { name: "AWS" })).toHaveAttribute(
			"src",
			"/aws/favicon_16x16.png",
		);
	});

	it("renders github as an inline currentColor svg (no <img>)", () => {
		const { container } = render(<ProviderIcon provider="github" size={20} />);
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		const svg = container.querySelector("svg");
		expect(svg).not.toBeNull();
		expect(svg).toHaveAttribute("fill", "currentColor");
		expect(svg).toHaveAttribute("width", "20");
		expect(svg).toHaveAttribute("height", "20");
	});

	it("renders google as an inline svg with multiple arc paths", () => {
		const { container } = render(<ProviderIcon provider="google" />);
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		const svg = container.querySelector("svg");
		expect(svg).not.toBeNull();
		// The grayscale Google glyph is composed of four arc <path>s.
		expect(svg?.querySelectorAll("path").length).toBe(4);
	});

	it("falls back to rendering nothing for an unknown provider slug", () => {
		const { container } = render(<ProviderIcon provider="not-a-cloud" />);
		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});

	it("applies the grayscale mono treatment by default and drops it when mono=false", () => {
		const { rerender } = render(<ProviderIcon provider="aws" />);
		expect(screen.getByRole("img", { name: "AWS" })).toHaveClass("grayscale");

		rerender(<ProviderIcon provider="aws" mono={false} />);
		expect(screen.getByRole("img", { name: "AWS" })).not.toHaveClass("grayscale");
	});

	it("merges a custom className onto the rendered element", () => {
		const { rerender, container } = render(
			<ProviderIcon provider="aws" className="size-8 rounded" />,
		);
		const img = screen.getByRole("img", { name: "AWS" });
		expect(img).toHaveClass("size-8");
		expect(img).toHaveClass("rounded");
		expect(img).toHaveClass("object-contain");

		// The className also threads through to the inline svg path.
		rerender(<ProviderIcon provider="github" className="text-muted" />);
		expect(container.querySelector("svg")).toHaveClass("text-muted");
	});
});
