// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RegionRefusal is the ONE refused render (CON-SM4, #6813): distinct from the error render and from
// an empty state, never with a retry, and with one wording per refusal. The components that used to
// carry their own no-access render now render it, and those are pinned here too, so a sibling page
// cannot drift back to its own shape or words.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ClassificationNoAccess } from "@/components/classification/classification-no-access";
import { RegionRefusal, refusalCopy } from "@/components/errors/region-refusal";
import { EvidenceForbidden } from "@/components/evidence/evidence-empty";
import { AccessNoAccess } from "@/components/settings/access/access-no-access";
import { ActivityNoAccess } from "@/components/settings/activity/activity-no-access";
import { RegionRefusal as BillingRefusal } from "@/components/settings/billing/read-state";
import { GeneralRefusal } from "@/components/settings/general/general-states";
import type { ReadRefusal } from "@/lib/rpc/refusal";

/** The one refused region a render produced. Fails when there are none, or more than one. */
function refused(container: HTMLElement): Element {
	const found = container.querySelectorAll('[data-state="refused"]');
	expect(found).toHaveLength(1);
	return found[0];
}

describe("RegionRefusal", () => {
	it("is a refused state — not the error render, and not announced", () => {
		const { container } = render(<RegionRefusal refusal="forbidden" subject="clusters" />);
		const region = refused(container);
		expect(region.getAttribute("data-state")).toBe("refused");
		expect(region.getAttribute("data-refusal")).toBe("forbidden");
		expect(container.querySelector('[data-state="error"]')).toBeNull();
		// Still the shared empty-state frame, which the e2e audits read a deliberate render by.
		expect(region.getAttribute("data-slot")).toBe("empty");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("never offers a retry: the same question gets the same answer", () => {
		render(<RegionRefusal refusal="forbidden" subject="clusters" />);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("does not add a heading to the document outline", () => {
		render(<RegionRefusal refusal="forbidden" />);
		expect(screen.queryByRole("heading")).toBeNull();
	});

	it.each<[ReadRefusal, string, string]>([
		[
			"forbidden",
			"You don't have access to runners",
			"Your role in this organization doesn't include it. Ask an owner or admin for access.",
		],
		["not-found", "Not found", "This no longer exists, or it isn't in this organization."],
		["plan", "Not on this plan", "Your plan doesn't include runners."],
		["sign-in", "Your session has ended", "Sign in again to see runners."],
	])("%s has one wording, in terms of the subject", (refusal, title, description) => {
		const { container } = render(<RegionRefusal refusal={refusal} subject="runners" />);
		expect(refused(container).getAttribute("data-refusal")).toBe(refusal);
		expect(screen.getByText(title)).toBeInTheDocument();
		expect(screen.getByText(description)).toBeInTheDocument();
	});

	it("says 'this' when no subject is given", () => {
		expect(refusalCopy("forbidden").title).toBe("You don't have access to this");
		expect(refusalCopy("plan").description).toBe("Your plan doesn't include this.");
		expect(refusalCopy("sign-in").description).toBe("Sign in again to see this.");
	});

	it("compact is one line carrying the same state, for a narrow column", () => {
		const { container } = render(<RegionRefusal compact refusal="forbidden" subject="the warm pools" />);
		const region = refused(container);
		expect(region.tagName).toBe("P");
		expect(region.getAttribute("data-state")).toBe("refused");
		expect(region.textContent).toBe("You don't have access to the warm pools.");
	});

	it("takes a title and a line of its own where the shared words would be untrue", () => {
		render(<RegionRefusal refusal="forbidden" title="Billing admins only" description="Ask one." />);
		expect(screen.getByText("Billing admins only")).toBeInTheDocument();
		expect(screen.getByText("Ask one.")).toBeInTheDocument();
		expect(screen.queryByText(/You don't have access/)).toBeNull();
	});
});

describe("the renders that used to be bespoke are the one refused render", () => {
	it.each([
		["Classification", <ClassificationNoAccess key="c" />, "You don't have access to classification"],
		["Activity", <ActivityNoAccess key="a" />, "You don't have access to the activity log"],
		["Access", <AccessNoAccess key="g" />, "You don't have access to access grants"],
		["Evidence", <EvidenceForbidden key="e" />, "You don't have access to evidence"],
		["General settings", <GeneralRefusal key="s" refusal="forbidden" />, "You don't have access to these settings"],
	])("%s", (_, element, title) => {
		const { container } = render(element);
		const region = refused(container);
		expect(region.getAttribute("data-state")).toBe("refused");
		expect(region.getAttribute("data-refusal")).toBe("forbidden");
		expect(screen.getByText(title)).toBeInTheDocument();
		expect(
			screen.getByText("Your role in this organization doesn't include it. Ask an owner or admin for access."),
		).toBeInTheDocument();
	});

	it("a General page keeps the refusal it was given, and its own words when it passes them", () => {
		const { container } = render(
			<GeneralRefusal refusal="not-found" title="Project not found" description="It was deleted." />,
		);
		expect(refused(container).getAttribute("data-refusal")).toBe("not-found");
		expect(screen.getByText("Project not found")).toBeInTheDocument();
		expect(screen.getByText("It was deleted.")).toBeInTheDocument();
	});

	it("a billing section is the same render with billing's own lines", () => {
		const { container } = render(<BillingRefusal refusal="forbidden" />);
		const region = refused(container);
		expect(region.getAttribute("data-state")).toBe("refused");
		expect(screen.getByText("Billing admins only")).toBeInTheDocument();
		expect(screen.getByText("You need the billing permission in this organization to see this.")).toBeInTheDocument();
	});
});
