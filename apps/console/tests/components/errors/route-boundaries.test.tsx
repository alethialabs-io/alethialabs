// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's error boundaries, in the forms of the polish-wave spec (§4, #7741).
//
// - REGION form, one `error.tsx` per data region: a title naming the region ("Clusters didn't
//   load"), a cause-and-consequence sentence, Try again — which re-reads the segment's server data
//   (`router.refresh()`) and re-renders it (`reset()`) — and a mono `ref <digest>`.
// - ROUTE form, the org and project boundaries and the root one: "Something broke on our side.",
//   "Nothing in your cloud changed.", Try again / Contact support, and `ref <digest> · <UTC time>`.
// - 404 form (#7875): `[ 404 ]` in the mark's brackets, "Nothing here.", a SPECIFIC reason line,
//   the way back. Every console 404 is rendered below, and each is told apart by its reason line.
//
// Every boundary is imported statically, so a deleted one fails this file at import, not silently.

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { refresh, captureException } = vi.hoisted(() => ({
	refresh: vi.fn(),
	captureException: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
	useParams: () => ({ org: "acme" }),
	usePathname: () => "/acme/~/nowhere",
}));
vi.mock("@/lib/analytics/track", () => ({ captureException }));

import AlertsError from "@/app/(private)/[org]/~/alerts/error";
import ApprovalsError from "@/app/(private)/[org]/~/approvals/error";
import ClustersError from "@/app/(private)/[org]/~/clusters/error";
import ConnectorsError from "@/app/(private)/[org]/~/connectors/error";
import EvidenceError from "@/app/(private)/[org]/~/evidence/error";
import JobsError from "@/app/(private)/[org]/~/jobs/error";
import RunnersError from "@/app/(private)/[org]/~/runners/error";
import BillingError from "@/app/(private)/[org]/~/settings/billing/error";
import SettingsError from "@/app/(private)/[org]/~/settings/error";
import SupportError from "@/app/(private)/[org]/~/support/error";
import ProjectClustersError from "@/app/(private)/[org]/[project]/clusters/error";
import EnvironmentsError from "@/app/(private)/[org]/[project]/environments/error";
import ProjectError from "@/app/(private)/[org]/[project]/error";
import ProjectJobsError from "@/app/(private)/[org]/[project]/jobs/error";
import OrgError from "@/app/(private)/[org]/error";
import OrgNotFound from "@/app/(private)/[org]/not-found";
import ProjectNotFound from "@/app/(private)/[org]/[project]/not-found";
import JobNotFound from "@/app/(private)/[org]/~/jobs/[id]/not-found";
import SupportCaseNotFound from "@/app/(private)/[org]/~/support/cases/[id]/not-found";
import PrivateNotFound from "@/app/(private)/not-found";
import RootNotFound from "@/app/not-found";
import AppError from "@/app/error";

/** What Next hands an `error.tsx`. */
interface BoundaryProps {
	error: Error & { digest?: string };
	reset: () => void;
}

/** A boundary component, as Next renders it. */
type Boundary = (props: BoundaryProps) => ReactNode;

const REGIONS: Array<[name: string, Boundary, title: string]> = [
	["org clusters", ClustersError, "Clusters didn't load"],
	["project clusters", ProjectClustersError, "Clusters didn't load"],
	["environments", EnvironmentsError, "Environments didn't load"],
	["org jobs", JobsError, "Jobs didn't load"],
	["project jobs", ProjectJobsError, "Jobs didn't load"],
	["runners", RunnersError, "Runners didn't load"],
	["alerts", AlertsError, "Alerts didn't load"],
	["approvals", ApprovalsError, "Approvals didn't load"],
	["evidence", EvidenceError, "Evidence didn't load"],
	["connectors", ConnectorsError, "Connectors didn't load"],
	["settings", SettingsError, "Settings didn't load"],
	["billing", BillingError, "Billing didn't load"],
	["support", SupportError, "Support didn't load"],
];

/** A server error as the boundary receives it: Next strips the message and keeps a digest. */
function serverError(digest?: string): Error & { digest?: string } {
	return Object.assign(new Error("boom"), digest === undefined ? {} : { digest });
}

beforeEach(() => {
	refresh.mockReset();
	captureException.mockReset();
});

describe("region boundaries (#7741)", () => {
	it.each(REGIONS)("%s renders the region form", (_, Region, title) => {
		const reset = vi.fn();
		render(<Region error={serverError("d1g3st")} reset={reset} />);

		expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
		// Cause, then consequence: a region that failed says what it could not read and what that
		// did NOT do. Never the raw error message, which can carry server detail.
		const sentence = screen.getByText(/^We couldn't (read|load) .+ just now\. .+\.$/);
		expect(sentence).toBeInTheDocument();
		expect(screen.queryByText("boom")).toBeNull();
		expect(screen.getByText("ref d1g3st")).toHaveClass("font-mono");

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(reset).toHaveBeenCalledTimes(1);
		expect(captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ digest: "d1g3st" }));
	});

	it.each(REGIONS)("%s draws no ref line for a client error, which has no digest", (_, Region) => {
		render(<Region error={serverError()} reset={vi.fn()} />);
		expect(screen.queryByText(/^ref /)).toBeNull();
	});
});

describe("route boundaries (#7741)", () => {
	it.each([
		["org", OrgError],
		["project", ProjectError],
	] satisfies Array<[string, Boundary]>)(
		"the %s boundary renders the route form, with support in the console",
		(_, Route) => {
			const reset = vi.fn();
			render(<Route error={serverError("d1g3st")} reset={reset} />);

			expect(screen.getByRole("heading", { level: 1, name: "Something broke on our side." })).toBeInTheDocument();
			expect(screen.getByText("Nothing in your cloud changed.")).toBeInTheDocument();
			expect(screen.getByRole("link", { name: "Contact support" })).toHaveAttribute("href", "/acme/~/support");
			expect(screen.getByText(/^ref d1g3st · .+ UTC$/)).toHaveClass("font-mono");

			fireEvent.click(screen.getByRole("button", { name: "Try again" }));
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(reset).toHaveBeenCalledTimes(1);
		},
	);

	it("the root boundary renders the route form full page, with support by mail", () => {
		const reset = vi.fn();
		render(<AppError error={serverError("d1g3st")} reset={reset} />);

		expect(screen.getByRole("heading", { level: 1, name: "Something broke on our side." })).toBeInTheDocument();
		expect(screen.getByText("Nothing in your cloud changed.")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Contact support" })).toHaveAttribute(
			"href",
			"mailto:support@alethialabs.io",
		);
		// The time is UTC whatever the runtime's zone, so support and the reader agree on it.
		expect(screen.getByText(/^ref d1g3st · .+ UTC$/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(reset).toHaveBeenCalledTimes(1);
	});

	it("without a digest the ref line still carries the time", () => {
		render(<OrgError error={serverError()} reset={vi.fn()} />);
		expect(screen.getByText(/^.+ UTC$/)).toBeInTheDocument();
		expect(screen.queryByText(/^ref /)).toBeNull();
	});
});

/** A 404 boundary component, as Next renders it: no props. */
type NotFoundBoundary = () => ReactNode;

const NOT_FOUNDS: Array<[name: string, NotFoundBoundary, reason: string, link: string, href: string]> = [
	["root", RootNotFound, "There's no page at this address. The link may be out of date, or the page has moved.", "Go home", "/"],
	["org", PrivateNotFound, "This organization doesn't exist, or you don't have access to it.", "Go home", "/"],
	["org fallback", OrgNotFound, "There's no page at this address in acme, or you don't have access to it.", "Back to projects", "/acme"],
	["project", ProjectNotFound, "This project doesn't exist in acme, or you don't have access to it.", "All projects", "/acme"],
	["job", JobNotFound, "This job doesn't exist, or it belongs to another organization.", "Back to jobs", "/acme/~/jobs"],
	["support case", SupportCaseNotFound, "This support case doesn't exist, or you don't have access to it.", "Back to cases", "/acme/~/support/my-cases"],
];

describe("the 404 boundaries (#7875)", () => {
	it.each(NOT_FOUNDS)("the %s 404 says nothing is here, exactly why, and the way out", (_, NotFound, reason, link, href) => {
		const { container } = render(<NotFound />);
		// `[ 404 ]`: the code as its own text, inside the bracketed slot.
		expect(screen.getByText("404", { exact: true }).closest('[data-slot="error-state-code"]')).toBe(
			container.querySelector('[data-slot="error-state-code"]'),
		);
		expect(screen.getByRole("heading", { level: 1, name: "Nothing here." })).toBeInTheDocument();
		expect(screen.getByText(reason, { exact: true })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: link })).toHaveAttribute("href", href);
	});
});
