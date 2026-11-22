// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// /onboarding decides on the server where setup stands BEFORE it renders anything (WIZ-W6, #6929).
// The defect it closes: the page asked `isOnboardingComplete` alone, so a reload after the trial
// started but before the browser marked completion rendered the plan chooser again. Now a live plan
// finishes setup and lands in the console, and the form only ever renders for a setup that has not
// started — with every default the page could work out.

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((to: string) => {
	throw new Error(`NEXT_REDIRECT ${to}`);
});
const formProps = vi.fn();
const headerValues = new Map<string, string>();

vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("next/headers", () => ({
	headers: async () => ({ get: (name: string) => headerValues.get(name) ?? null }),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/authz/grants", () => ({ ensureMemberGrant: vi.fn() }));
vi.mock("@/lib/auth/onboarding", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth/onboarding")>()),
	resolveOnboarding: vi.fn(),
	completeOnboarding: vi.fn(),
}));
vi.mock("@/lib/auth/owner", () => ({ getViewer: vi.fn() }));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: vi.fn(() => true) }));
vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: vi.fn(async () => null) }));
vi.mock("@/app/server/actions/billing", () => ({
	getProOffer: vi.fn(async () => ({ kind: "trial", trialDays: 30 })),
}));
vi.mock("@/app/server/actions/legal", () => ({
	getPendingAcceptance: vi.fn(async () => ({
		satisfied: false,
		documents: [
			{ id: "terms", title: "Terms of Service", version: "2026-08-24", path: "/terms", firstAcceptance: true },
		],
	})),
}));
vi.mock("@/app/server/actions/workspace", () => ({ setActiveOrganization: vi.fn() }));
vi.mock("@/components/auth/auth-shell", () => ({
	AuthShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	AuthCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/auth/onboarding-form", () => ({
	OnboardingForm: (props: unknown) => {
		formProps(props);
		return <p>onboarding form</p>;
	},
}));

import OnboardingPage from "@/app/(public)/onboarding/page";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import { completeOnboarding, resolveOnboarding } from "@/lib/auth/onboarding";
import { getViewer } from "@/lib/auth/owner";

const ORG = { id: "org-1", name: "Ana's Org", slug: "ana", logo: null, role: "owner" };

/** Renders the page for `next`, or returns the redirect it threw. */
async function open(next?: string): Promise<string | null> {
	try {
		render(await OnboardingPage({ searchParams: Promise.resolve({ next }) }));
		return null;
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (message.startsWith("NEXT_REDIRECT ")) return message.slice("NEXT_REDIRECT ".length);
		throw err;
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	headerValues.clear();
	vi.mocked(getViewer).mockResolvedValue({
		id: "user-1",
		name: "Ana",
		email: "ana@acme.de",
		image: null,
		createdAt: new Date(),
	});
});

describe("/onboarding — decided on the server", () => {
	it("sends a signed-out visitor to sign in", async () => {
		vi.mocked(getViewer).mockResolvedValue(null);
		expect(await open()).toBe("/login");
	});

	it("sends a finished setup on to the console, or to its `next`", async () => {
		vi.mocked(resolveOnboarding).mockResolvedValue({ kind: "complete" });
		expect(await open()).toBe("/dashboard");
		expect(await open("/start?plan=team")).toBe("/start?plan=team");
	});

	it("a reload after the trial started finishes setup and lands in the console, not on the form", async () => {
		vi.mocked(resolveOnboarding).mockResolvedValue({ kind: "settled", org: ORG });

		expect(await open()).toBe("/ana/~/new");
		expect(completeOnboarding).toHaveBeenCalledWith("user-1");
		expect(formProps).not.toHaveBeenCalled();
	});

	it.each([
		["no-org", /couldn't finish setting up/i],
		["unknown", /couldn't check your account/i],
	] as const)("%s: a card with a retry, never the form", async (kind, heading) => {
		vi.mocked(resolveOnboarding).mockResolvedValue({ kind });

		expect(await open()).toBeNull();
		expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
		expect(formProps).not.toHaveBeenCalled();
	});

	it("in-flight: says the payment is being confirmed and offers nothing to pay", async () => {
		vi.mocked(resolveOnboarding).mockResolvedValue({ kind: "in-flight", org: ORG });

		expect(await open()).toBeNull();
		expect(screen.getByRole("heading", { name: /still being confirmed/i })).toBeInTheDocument();
		expect(formProps).not.toHaveBeenCalled();
	});

	it("ignores a `next` that points back at itself", async () => {
		vi.mocked(resolveOnboarding).mockResolvedValue({ kind: "complete" });
		expect(await open("/onboarding")).toBe("/dashboard");
	});
});

describe("/onboarding — the form, with what the page could work out", () => {
	beforeEach(() => {
		vi.mocked(resolveOnboarding).mockResolvedValue({ kind: "not-started", org: ORG });
	});

	it("scopes the session to the org on the server, not from a browser effect (A-06)", async () => {
		await open();
		expect(setActiveOrganization).toHaveBeenCalledWith("org-1");
	});

	it("passes the deduced country, the suggested capacity, the pending terms and the trial", async () => {
		headerValues.set("cf-ipcountry", "PT");
		await open();

		expect(screen.getByText("onboarding form")).toBeInTheDocument();
		expect(formProps).toHaveBeenCalledWith(
			expect.objectContaining({
				org: ORG,
				viewerId: "user-1",
				country: { code: "PT", source: "location" },
				capacity: "organization",
				trial: { kind: "available", days: 30 },
				terms: [expect.objectContaining({ id: "terms", version: "2026-08-24" })],
				destination: null,
			}),
		);
	});

	it("falls back to the email's country when the request carries no location", async () => {
		await open();
		expect(formProps).toHaveBeenCalledWith(
			expect.objectContaining({ country: { code: "DE", source: "email" } }),
		);
	});
});
