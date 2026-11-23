// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7325: on a self-managed instance the Early Access route renders a STATE, never an error. The
// release gate (a self-managed console) measured the route throwing: the page mounted the request
// panel, whose overview read called a server action that refuses off the hosted service by throwing.
//
// The deployment fact is mocked at its one seam (`deploymentMode()`, the same function the actions'
// `requireHosted` reads). The panel is mocked to a marker that, on a self-managed instance, would
// mean the page mounted the form the server refuses — and the actions module to throwing stubs, so a
// call from anything the page renders fails the test rather than going unnoticed.

import { render, screen } from "@testing-library/react";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

/** The test's switchboard: the deployment mode, and the refusing action stub. */
interface Hoisted {
	mode: "hosted" | "self-managed";
	overview: Mock<() => never>;
}

const h = vi.hoisted(
	(): Hoisted => ({
		mode: "self-managed",
		overview: vi.fn((): never => {
			throw new Error("Early Access grants exist only on the hosted service.");
		}),
	}),
);

vi.mock("@/lib/billing/config", () => ({ deploymentMode: () => h.mode }));
vi.mock("@/app/server/actions/early-access", () => ({
	getEarlyAccessOverview: h.overview,
	requestEarlyAccess: h.overview,
}));
vi.mock("@/components/billing/early-access-request-panel", () => ({
	EarlyAccessRequestPanel: () => <div data-testid="request-panel" />,
}));

import EarlyAccessLoading from "@/app/(private)/[org]/~/settings/billing/early-access/loading";
import EarlyAccessPage from "@/app/(private)/[org]/~/settings/billing/early-access/page";

/** Every bordered card the render draws. */
const cards = (root: ParentNode) => root.querySelectorAll('[data-slot="card"]');

describe("Early Access route on a self-managed instance", () => {
	beforeEach(() => {
		h.mode = "self-managed";
		h.overview.mockClear();
	});

	it("renders the self-managed notice, not the request form", () => {
		const { container } = render(<EarlyAccessPage />);
		expect(screen.getByText("Self-managed deployment")).toBeTruthy();
		expect(screen.getByText(/Complimentary Early Access is a hosted-service offer/)).toBeTruthy();
		expect(screen.queryByTestId("request-panel")).toBeNull();
		expect(cards(container)).toHaveLength(1);
		expect(h.overview).not.toHaveBeenCalled();
	});

	it("draws the same single card while loading", () => {
		const page = render(<EarlyAccessPage />);
		const loading = render(<EarlyAccessLoading />);
		expect(cards(loading.container)).toHaveLength(1);
		expect(loading.container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
		expect(cards(loading.container)[0]?.textContent).toBe(cards(page.container)[0]?.textContent);
	});

	it("mounts the request form on the hosted service", () => {
		h.mode = "hosted";
		render(<EarlyAccessPage />);
		expect(screen.getByTestId("request-panel")).toBeTruthy();
		expect(screen.queryByText("Self-managed deployment")).toBeNull();
	});
});
