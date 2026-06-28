// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit test for StatusBadge: product status strings map onto the five grayscale
// visual tiers (active/pending/idle/failed/disabled), the label defaults to the
// raw status string, and unknown statuses fall back to `idle`. Also covers the
// `statusTier` resolver, tier/label/showLabel overrides, and case-insensitivity.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge, statusTier } from "../src/status-badge";

/** Returns the outer `.vx-status` element wrapping the given label text. */
function badgeForLabel(text: string): HTMLElement {
	const el = screen.getByText(text).closest(".vx-status");
	if (!(el instanceof HTMLElement)) throw new Error(`no badge for "${text}"`);
	return el;
}

describe("statusTier resolver", () => {
	it.each([
		["active", "active"],
		["online", "active"],
		["success", "active"],
		["succeeded", "active"],
		["ready", "active"],
		["connected", "active"],
		["running", "active"],
		["queued", "pending"],
		["pending", "pending"],
		["processing", "pending"],
		["claimed", "pending"],
		["provisioning", "pending"],
		["creating", "pending"],
		["updating", "pending"],
		["deploying", "pending"],
		["destroying", "pending"],
		["idle", "idle"],
		["offline", "idle"],
		["draining", "idle"],
		["draft", "idle"],
		["cancelled", "idle"],
		["canceled", "idle"],
		["failed", "failed"],
		["error", "failed"],
		["errored", "failed"],
		["disabled", "disabled"],
		["destroyed", "disabled"],
		["skipped", "disabled"],
	])("maps %s -> %s tier", (status, tier) => {
		expect(statusTier(status)).toBe(tier);
	});

	it("is case-insensitive", () => {
		expect(statusTier("ACTIVE")).toBe("active");
		expect(statusTier("Processing")).toBe("pending");
		expect(statusTier("FaIlEd")).toBe("failed");
	});

	it("falls back to idle for unknown statuses", () => {
		expect(statusTier("whatever")).toBe("idle");
		expect(statusTier("")).toBe("idle");
		expect(statusTier("nonsense-status")).toBe("idle");
	});
});

describe("StatusBadge", () => {
	it("renders the status string (verbatim) as the label by default", () => {
		render(<StatusBadge status="ACTIVE" />);
		const badge = badgeForLabel("ACTIVE");
		expect(badge).toHaveClass("vx-status");
		expect(badge).toHaveClass("vx-status--active");
	});

	it.each([
		["ACTIVE", "vx-status--active"],
		["PROCESSING", "vx-status--pending"],
		["FAILED", "vx-status--failed"],
		["destroyed", "vx-status--disabled"],
		["offline", "vx-status--idle"],
	])("status %s gets the %s tier class", (status, tierClass) => {
		render(<StatusBadge status={status} />);
		const badge = badgeForLabel(status);
		expect(badge).toHaveClass(tierClass);
		// Exactly one tier class is applied.
		const tierClasses = Array.from(badge.classList).filter((c) =>
			c.startsWith("vx-status--"),
		);
		expect(tierClasses).toEqual([tierClass]);
	});

	it("falls back to the idle tier for an unknown status", () => {
		render(<StatusBadge status="bananas" />);
		const badge = badgeForLabel("bananas");
		expect(badge).toHaveClass("vx-status--idle");
	});

	it("always renders the dot element", () => {
		const { container } = render(<StatusBadge status="active" />);
		expect(container.querySelector(".vx-status__dot")).not.toBeNull();
	});

	it("honors an explicit tier override regardless of the status string", () => {
		// status "active" would resolve to the active tier, but tier wins.
		render(<StatusBadge status="active" tier="failed" />);
		const badge = badgeForLabel("active");
		expect(badge).toHaveClass("vx-status--failed");
		expect(badge).not.toHaveClass("vx-status--active");
	});

	it("renders a custom label instead of the status string", () => {
		render(<StatusBadge status="active" label="Online now" />);
		expect(screen.queryByText("active")).toBeNull();
		const badge = badgeForLabel("Online now");
		expect(badge).toHaveClass("vx-status--active");
	});

	it("hides the text label when showLabel is false but keeps the dot + tier", () => {
		const { container } = render(
			<StatusBadge status="FAILED" showLabel={false} />,
		);
		expect(screen.queryByText("FAILED")).toBeNull();
		const dot = container.querySelector(".vx-status__dot");
		expect(dot).not.toBeNull();
		const badge = dot?.closest(".vx-status");
		expect(badge).toHaveClass("vx-status--failed");
	});

	it("merges a caller-supplied className and forwards pass-through props", () => {
		render(
			<StatusBadge status="active" className="extra-class" data-testid="sb" />,
		);
		const badge = screen.getByTestId("sb");
		expect(badge).toHaveClass("vx-status");
		expect(badge).toHaveClass("vx-status--active");
		expect(badge).toHaveClass("extra-class");
	});
});
