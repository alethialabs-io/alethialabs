// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The onboarding form (WIZ-W6, #6929): one screen, one server call, every refusal shown where it
// belongs.
//
// History this file keeps: #5415 — a slug the server refuses must be SHOWN inline (a thrown refusal
// was a production digest); #5453 — a hyphen must be typeable into the URL. Both now travel through
// `finishOnboarding`'s field refusals instead of `configureOnboardingOrg`'s return value.
//
// New: the plan is a labelled radio group (A-24); the inline terms box is required and its
// documents travel with the submission; the Pro trial carries the deduced payer facts; a refusal that
// is about no field (the purchase gate's) is shown above the button; nothing marks setup complete or
// scopes the session from the browser (A-04, A-06).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const finishOnboarding = vi.fn();
const toastError = vi.fn();
const replace = vi.fn();
const push = vi.fn();

vi.mock("@/app/server/actions/onboarding", () => ({
	finishOnboarding: (...args: unknown[]) => finishOnboarding(...args),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({
	toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn() },
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push, replace, refresh: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
// The logo uploader is its own screen's subject.
vi.mock("@/components/org/org-logo-upload", () => ({ OrgLogoUpload: () => null }));
vi.mock("@/lib/org-url", () => ({ orgHost: () => "alethialabs.io" }));

import { OnboardingForm, type OnboardingFormProps } from "@/components/auth/onboarding-form";

const RESERVED = "That slug is reserved — try another.";
const TERMS = [
	{ id: "terms", title: "Terms of Service", version: "2026-08-24", path: "/terms", firstAcceptance: true },
];

/** Renders the form for an owner's freshly provisioned primary org. */
function renderIt(overrides: Partial<OnboardingFormProps> = {}) {
	const props: OnboardingFormProps = {
		org: { id: "org-1", name: "Acme", slug: "acme", logo: null, role: "owner" },
		viewerId: "user-1",
		trial: { kind: "unavailable", reason: "Hosted billing isn’t configured on this deployment." },
		terms: [],
		country: null,
		capacity: "consumer",
		destination: null,
		...overrides,
	};
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<OnboardingForm {...props} />
		</QueryClientProvider>,
	);
}

/** The submit button. */
function createButton() {
	return screen.getByRole("button", { name: /create organization/i });
}

beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
});

describe("OnboardingForm — a slug the server refuses (#5415)", () => {
	it("renders the server's sentence under the slug, opens the URL editor and stays on the form", async () => {
		finishOnboarding.mockResolvedValue({
			ok: false,
			error: { kind: "validation", message: RESERVED, fields: { slug: [RESERVED] } },
		});
		const user = userEvent.setup();
		renderIt();

		expect(screen.queryByRole("textbox", { name: "URL slug" })).toBeNull();
		await user.click(createButton());

		expect(await screen.findByRole("alert")).toHaveTextContent(RESERVED);
		expect(screen.getByRole("textbox", { name: "URL slug" })).toHaveValue("acme");
		expect(toastError).not.toHaveBeenCalled();
		expect(replace).not.toHaveBeenCalled();
		expect(createButton()).toBeEnabled();
	});

	it("routes a name refusal to the name field, not the slug", async () => {
		finishOnboarding.mockResolvedValue({
			ok: false,
			error: {
				kind: "validation",
				message: "Give your organization a name.",
				fields: { name: ["Give your organization a name."] },
			},
		});
		const user = userEvent.setup();
		renderIt();

		await user.click(createButton());

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/give your organization a name/i);
		expect(alert.id).toBe("org-name-error");
		expect(screen.queryByRole("textbox", { name: "URL slug" })).toBeNull();
	});

	it("toasts an unexpected failure with its reference and never presents it as a field error", async () => {
		finishOnboarding.mockResolvedValue({ ok: false, error: { kind: "unexpected", ref: "ab12cd34" } });
		const user = userEvent.setup();
		renderIt();

		await user.click(createButton());

		await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(String(toastError.mock.calls[0]?.[0])).toMatch(/ab12cd34/);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(replace).not.toHaveBeenCalled();
	});
});

describe("OnboardingForm — finishing", () => {
	it("sends one call and lands on the new-project screen, replacing this page", async () => {
		finishOnboarding.mockResolvedValue({ ok: true, data: { slug: "acme" } });
		const user = userEvent.setup();
		renderIt();

		await user.click(createButton());

		await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/acme/~/new"));
		expect(push).not.toHaveBeenCalled();
		expect(finishOnboarding).toHaveBeenCalledTimes(1);
		expect(finishOnboarding.mock.calls[0]?.[0]).toMatchObject({
			name: "Acme",
			slug: "acme",
			plan: "community",
			acceptedDocuments: [],
			payer: null,
		});
	});

	it("goes to the `next` it was given instead", async () => {
		finishOnboarding.mockResolvedValue({ ok: true, data: { slug: "acme" } });
		const user = userEvent.setup();
		renderIt({ destination: "/start?plan=team" });

		await user.click(createButton());

		await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/start?plan=team"));
	});

	it("submits once however many times the button is pressed", async () => {
		let resolve: (value: unknown) => void = () => undefined;
		finishOnboarding.mockReturnValue(
			new Promise((r) => {
				resolve = r;
			}),
		);
		const user = userEvent.setup();
		renderIt();

		await user.click(createButton());
		const busy = await screen.findByRole("button", { name: /creating/i });
		expect(busy).toBeDisabled();
		await user.click(busy);
		resolve({ ok: true, data: { slug: "acme" } });

		await vi.waitFor(() => expect(replace).toHaveBeenCalled());
		expect(finishOnboarding).toHaveBeenCalledTimes(1);
	});
});

// #5453 — the URL field re-slugged on every keystroke and trimmed a trailing dash.
describe("OnboardingForm — typing a hyphen into the URL", () => {
	it("keeps the typed hyphen, and submits the slug with a trailing one trimmed", async () => {
		finishOnboarding.mockResolvedValue({ ok: true, data: { slug: "my-team" } });
		const user = userEvent.setup();
		renderIt();

		await user.click(screen.getByRole("button", { name: /customize/i }));
		const slugBox = screen.getByRole("textbox", { name: "URL slug" });
		await user.clear(slugBox);
		await user.type(slugBox, "my-");
		expect(slugBox).toHaveValue("my-");
		await user.type(slugBox, "team-");
		expect(slugBox).toHaveValue("my-team-");
		await user.click(createButton());

		await vi.waitFor(() => expect(finishOnboarding).toHaveBeenCalled());
		expect(finishOnboarding.mock.calls[0]?.[0]).toMatchObject({ name: "Acme", slug: "my-team" });
	});
});

describe("OnboardingForm — the plan (A-24)", () => {
	it("is a labelled radio group with Hobby chosen, and a disabled Pro tile that says why", () => {
		renderIt();

		const group = screen.getByRole("radiogroup", { name: "Plan" });
		const hobby = within(group).getByRole("radio", { name: /personal projects/i });
		const pro = within(group).getByRole("radio", { name: /commercial projects/i });
		expect(hobby).toBeChecked();
		expect(pro).toBeDisabled();
		expect(pro.closest("label")).toHaveTextContent(/hosted billing isn’t configured/i);
	});
});

describe("OnboardingForm — the inline terms box", () => {
	it("starts unticked, names the version, and refuses to submit until it is ticked", async () => {
		const user = userEvent.setup();
		renderIt({ terms: TERMS });

		const box = screen.getByRole("checkbox", {
			name: /I have read and accept the Terms of Service \(version 2026-08-24\)/,
		});
		expect(box).not.toBeChecked();
		await user.click(createButton());

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Tick the box to accept the Terms of Service.",
		);
		expect(finishOnboarding).not.toHaveBeenCalled();
	});

	it("sends the documents it showed, at the versions it printed, once ticked", async () => {
		finishOnboarding.mockResolvedValue({ ok: true, data: { slug: "acme" } });
		const user = userEvent.setup();
		renderIt({ terms: TERMS });

		await user.click(screen.getByRole("checkbox", { name: /I have read and accept/ }));
		await user.click(createButton());

		await vi.waitFor(() => expect(finishOnboarding).toHaveBeenCalled());
		const sent = finishOnboarding.mock.calls[0]?.[0];
		expect(sent).toMatchObject({ acceptedDocuments: [{ id: "terms", version: "2026-08-24" }] });
		expect(typeof sent.clientTimestamp).toBe("string");
	});

	it("links the Terms and the Privacy Policy notice", () => {
		renderIt({ terms: TERMS });

		expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute(
			"href",
			expect.stringMatching(/\/terms$/),
		);
		expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
			"href",
			expect.stringMatching(/\/privacy$/),
		);
	});

	it("shows no box when nothing is awaiting acceptance", () => {
		renderIt({ terms: [] });

		expect(screen.queryByRole("checkbox")).toBeNull();
	});
});

describe("OnboardingForm — the Pro trial's payer facts", () => {
	const trial = { kind: "available", days: 30 } as const;

	it("shows the deduced country and why, and the capacity switch on for a work email", async () => {
		const user = userEvent.setup();
		renderIt({ trial, country: { code: "DE", source: "location" }, capacity: "organization" });

		expect(screen.queryByText(/billing country/i)).toBeNull();
		await user.click(screen.getByRole("radio", { name: /commercial projects/i }));

		// The flag carries the name as its title too, so the name is found at least once.
		expect(screen.getAllByText("Germany").length).toBeGreaterThan(0);
		expect(screen.getByText(/based on where you're signing in from/i)).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: /buying for a company/i })).toBeChecked();
		expect(screen.getByRole("textbox", { name: /your role/i })).toBeInTheDocument();
	});

	it("asks for the role only when the purchase is for a company", async () => {
		const user = userEvent.setup();
		renderIt({ trial, country: { code: "DE", source: "email" }, capacity: "organization" });

		await user.click(screen.getByRole("radio", { name: /commercial projects/i }));
		await user.click(createButton());

		expect(await screen.findByRole("alert")).toHaveTextContent(/say what your role is/i);
		expect(finishOnboarding).not.toHaveBeenCalled();

		await user.click(screen.getByRole("switch", { name: /buying for a company/i }));
		expect(screen.queryByRole("textbox", { name: /your role/i })).toBeNull();
	});

	it("submits the payer facts with the trial", async () => {
		finishOnboarding.mockResolvedValue({ ok: true, data: { slug: "acme" } });
		const user = userEvent.setup();
		renderIt({ trial, country: { code: "DE", source: "location" }, capacity: "organization" });

		await user.click(screen.getByRole("radio", { name: /commercial projects/i }));
		await user.type(screen.getByRole("textbox", { name: /your role/i }), "Founder");
		await user.click(createButton());

		await vi.waitFor(() => expect(finishOnboarding).toHaveBeenCalled());
		expect(finishOnboarding.mock.calls[0]?.[0]).toMatchObject({
			plan: "team",
			payer: { capacity: "organization", billingCountry: "DE", authorityAttestation: "Founder" },
		});
	});

	it("sends a consumer with no attestation", async () => {
		finishOnboarding.mockResolvedValue({ ok: true, data: { slug: "acme" } });
		const user = userEvent.setup();
		renderIt({ trial, country: { code: "FR", source: "language" }, capacity: "consumer" });

		await user.click(screen.getByRole("radio", { name: /commercial projects/i }));
		expect(screen.getByRole("switch", { name: /buying for a company/i })).not.toBeChecked();
		await user.click(createButton());

		await vi.waitFor(() => expect(finishOnboarding).toHaveBeenCalled());
		expect(finishOnboarding.mock.calls[0]?.[0]).toMatchObject({
			payer: { capacity: "consumer", billingCountry: "FR", authorityAttestation: null },
		});
	});

	it("refuses a trial with no country when nothing could be deduced", async () => {
		const user = userEvent.setup();
		renderIt({ trial, country: null, capacity: "consumer" });

		await user.click(screen.getByRole("radio", { name: /commercial projects/i }));
		await user.click(createButton());

		expect(await screen.findByRole("alert")).toHaveTextContent(/select the country/i);
		expect(finishOnboarding).not.toHaveBeenCalled();
	});

	it("shows the purchase gate's refusal above the button and stays on the form", async () => {
		const closed = "Alethia is not yet able to sell to customers in this country in this capacity.";
		finishOnboarding.mockResolvedValue({ ok: false, error: { kind: "conflict", message: closed } });
		const user = userEvent.setup();
		renderIt({ trial, country: { code: "DE", source: "location" }, capacity: "consumer" });

		await user.click(screen.getByRole("radio", { name: /commercial projects/i }));
		await user.click(createButton());

		expect(await screen.findByText(closed)).toBeInTheDocument();
		expect(toastError).not.toHaveBeenCalled();
		expect(replace).not.toHaveBeenCalled();
		// Hobby is still one click away.
		expect(screen.getByRole("radio", { name: /personal projects/i })).toBeEnabled();
	});
});
