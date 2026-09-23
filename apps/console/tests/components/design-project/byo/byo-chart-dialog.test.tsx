// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component tests for the BYO Helm chart attach dialog, focused on the OCI branch added for #1247:
// an OCI chart is one URL + a chart version (no chart path, no git ref), and the wizard must send
// exactly that shape to attachByoChart — `chartPath` omitted so the server stores null, and the
// version defaulting to `*` rather than the git-flavoured HEAD. The git branch must keep working
// unchanged. The heavy RepositorySelector is stubbed; its auth/fetch internals aren't under test.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ByoChartDialog,
	EXAMPLE_OCI_CHART_REF,
	STARTER_CHART_PATH,
	STARTER_CHART_REPO_URL,
} from "@/components/design-project/byo/byo-chart-dialog";

const { attachByoChart } = vi.hoisted(() => ({ attachByoChart: vi.fn() }));
vi.mock("@/app/server/actions/byo-charts", () => ({
	attachByoChart: (input: unknown) => attachByoChart(input),
}));

// The stub forwards `placeholder` on purpose: the real selector renders it as the empty trigger's
// label, so it is the example the user actually reads, and a stub that dropped it would make the
// worked-example assertions below pass over a dialog showing nothing.
vi.mock("@/components/repository-selector", () => ({
	RepositorySelector: ({
		value,
		onChange,
		placeholder,
	}: {
		value: string;
		onChange: (v: string) => void;
		placeholder?: string;
	}) => (
		<input
			aria-label="Chart repository"
			value={value}
			placeholder={placeholder}
			onChange={(e) => onChange(e.target.value)}
		/>
	),
}));

const { toast } = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
	attachByoChart.mockReset();
	attachByoChart.mockResolvedValue({ ok: true, id: "payments" });
	toast.success.mockReset();
	toast.error.mockReset();
});

function renderDialog() {
	return render(
		<ByoChartDialog
			open
			onOpenChange={() => {}}
			projectId="proj-1"
			environmentId="env-1"
		/>,
	);
}

const next = () => screen.getByRole("button", { name: /next/i });

describe("ByoChartDialog — OCI source", () => {
	it("attaches an OCI chart as a single reference with no chart path", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());

		await user.type(
			screen.getByLabelText(/chart reference/i),
			"oci://ghcr.io/acme/payments",
		);
		// No "Chart path" step exists on this branch.
		expect(screen.queryByLabelText(/chart path/i)).not.toBeInTheDocument();
		await user.click(next());

		await user.type(screen.getByLabelText(/chart version/i), "1.4.2");
		await user.click(next());
		await user.click(screen.getByRole("button", { name: /attach chart/i }));

		await waitFor(() => expect(attachByoChart).toHaveBeenCalledTimes(1));
		const input = attachByoChart.mock.calls[0][0];
		expect(input).toMatchObject({
			projectId: "proj-1",
			environmentId: "env-1",
			id: "payments",
			repoUrl: "oci://ghcr.io/acme/payments",
			ref: "1.4.2",
			namespace: "default",
		});
		// Omitted, not empty — attachByoChart stores chart_path null for OCI, and an empty string
		// would resolve to a git chart with a missing path.
		expect(input).not.toHaveProperty("chartPath");
	});

	it("defaults the chart version to * (latest), not HEAD", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());
		await user.type(
			screen.getByLabelText(/chart reference/i),
			"oci://ghcr.io/acme/payments",
		);
		await user.click(next());
		await user.click(next()); // leave the version blank
		await user.click(screen.getByRole("button", { name: /attach chart/i }));

		await waitFor(() => expect(attachByoChart).toHaveBeenCalledTimes(1));
		expect(attachByoChart.mock.calls[0][0].ref).toBe("*");
	});

	it("blocks advancing on a reference that names no chart, and says why", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());

		// Host only — resolveByoChartInstall needs a host AND a chart segment to address a chart.
		await user.type(screen.getByLabelText(/chart reference/i), "oci://ghcr.io");
		await user.click(next());

		// Still on the Registry step, with the reason on screen — not a dead Next button that never
		// explains itself.
		expect(await screen.findByText(/including the chart name/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/chart reference/i)).toBeInTheDocument();

		await user.type(screen.getByLabelText(/chart reference/i), "/acme/payments");
		await user.click(next());
		expect(await screen.findByLabelText(/chart version/i)).toBeInTheDocument();
	});

	it("does not claim OCI charts are unscannable — the runner pulls and scans them (#1300)", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());
		await user.type(
			screen.getByLabelText(/chart reference/i),
			"oci://ghcr.io/acme/payments",
		);
		await user.click(next());
		await user.click(next());

		expect(screen.queryByText(/isn't available for OCI charts/i)).not.toBeInTheDocument();
	});
});

describe("ByoChartDialog — git source", () => {
	it("still attaches a git chart with its path and ref", async () => {
		const user = userEvent.setup();
		renderDialog();

		// Git is the default source.
		await user.click(next());
		await user.type(
			screen.getByLabelText(/chart repository/i),
			"https://github.com/acme/payments-helm",
		);
		await user.click(next());
		await user.type(screen.getByLabelText(/chart path/i), "charts/payments");
		await user.click(next());
		await user.type(screen.getByLabelText(/git ref/i), "main");
		await user.click(next());
		await user.click(screen.getByRole("button", { name: /attach chart/i }));

		await waitFor(() => expect(attachByoChart).toHaveBeenCalledTimes(1));
		expect(attachByoChart.mock.calls[0][0]).toMatchObject({
			repoUrl: "https://github.com/acme/payments-helm",
			chartPath: "charts/payments",
			ref: "main",
			id: "payments-helm",
		});
	});
});

// ── THE WORKED EXAMPLE IS REAL (#4114) ───────────────────────────────────────────────────────────
//
// The dialog is where a user first meets the BYO chart contract, and it used to meet them with
// `acme/payments-helm` and `oci://ghcr.io/acme/payments` — neither of which resolves. The fix is
// only worth as much as what stops it rotting back, so there are three layers here and they answer
// different questions:
//
//   1. the constants are what we verified      — an exact pin, fails on any edit
//   2. nothing ELSE repository-shaped is shown — a sweep of every step of both branches, so a
//      newly invented example reds even in a step nobody thought to pin
//   3. the pinned things still exist           — opt-in, because it needs the network
//
// Layer 2 is the one that matters: layer 1 only sees the values someone remembered to list, and a
// future step with its own fictional placeholder would sail past it. Note the test fixtures ABOVE
// keep their `acme` values deliberately — a fixture is an input to an assertion, not a suggestion
// to a user, and only what the dialog SHOWS is swept.

/** Every repository-shaped example currently on screen — rendered text plus placeholder attributes,
 * which is where this dialog puts most of them. An input's typed `value` is excluded on purpose:
 * that is the user's own text, not the product's example. */
function shownRepoExamples(): string[] {
	const placeholders = Array.from(document.body.querySelectorAll("[placeholder]")).map(
		(el) => el.getAttribute("placeholder") ?? "",
	);
	const sources = [document.body.textContent ?? "", ...placeholders];
	return sources.flatMap(
		(s) => s.match(/(?:https?:\/\/[^\s"'<>)]*github[^\s"'<>)]*|oci:\/\/[^\s"'<>)]+)/g) ?? [],
	);
}

describe("ByoChartDialog — the worked example resolves", () => {
	it("pins the repository, chart path and OCI reference that were verified", () => {
		// Changed one of these? Then fetch the new value before you change the line — the point of
		// the issue is that the example is copy-pasteable, and only a real fetch says whether it is.
		expect(STARTER_CHART_REPO_URL).toBe(
			"https://github.com/alethialabs-io/alethia-starter-chart",
		);
		// `chart`, not `charts/<name>`: the starter repo holds one chart at the top level.
		expect(STARTER_CHART_PATH).toBe("chart");
		expect(EXAMPLE_OCI_CHART_REF).toBe("oci://ghcr.io/stefanprodan/charts/podinfo");
	});

	it("offers the starter repository and its chart path on the git branch", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(next());
		expect(screen.getByLabelText(/chart repository/i)).toHaveAttribute(
			"placeholder",
			STARTER_CHART_REPO_URL,
		);
		// And says it out loud, for the user who has no chart of their own to select.
		expect(screen.getByText(/no chart of your own yet/i)).toBeInTheDocument();

		await user.type(screen.getByLabelText(/chart repository/i), STARTER_CHART_REPO_URL);
		await user.click(next());
		expect(screen.getByLabelText(/chart path/i)).toHaveAttribute(
			"placeholder",
			STARTER_CHART_PATH,
		);
	});

	it("offers a pullable chart reference on the OCI branch", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());
		expect(screen.getByLabelText(/chart reference/i)).toHaveAttribute(
			"placeholder",
			EXAMPLE_OCI_CHART_REF,
		);
	});

	it("shows no repository example but those two, on any step of either branch", async () => {
		const user = userEvent.setup();
		const seen: string[] = [];
		const sweep = () => seen.push(...shownRepoExamples());

		// Git: Source → Repository → Chart path → Ref → Review.
		const git = renderDialog();
		sweep();
		await user.click(next());
		sweep();
		await user.type(screen.getByLabelText(/chart repository/i), STARTER_CHART_REPO_URL);
		await user.click(next());
		sweep();
		await user.type(screen.getByLabelText(/chart path/i), STARTER_CHART_PATH);
		await user.click(next());
		sweep();
		await user.click(next());
		sweep();
		git.unmount();

		// OCI: Source → Registry → Version → Review.
		renderDialog();
		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());
		sweep();
		await user.type(screen.getByLabelText(/chart reference/i), EXAMPLE_OCI_CHART_REF);
		await user.click(next());
		sweep();
		await user.click(next());
		sweep();

		// The sweep must have SEEN something, or an empty result would read as a clean one.
		expect(seen.length).toBeGreaterThan(0);
		const allowed = new Set([STARTER_CHART_REPO_URL, EXAMPLE_OCI_CHART_REF]);
		// Listed, not counted: a failure has to name the invented example, not just deny a total.
		expect([...new Set(seen)].filter((e) => !allowed.has(e))).toEqual([]);
		expect(document.body.textContent ?? "").not.toMatch(/acme/i);
	});
});

// Opt-in, and OFF by default: the unit suite is hermetic (vitest.config.ts: "no external services,
// runs everywhere"), and a test that reds because GitHub is slow would teach people to ignore it.
// What it buys is the half no offline test can reach — a repository can be renamed, made private or
// deleted without any file in this monorepo changing, and every assertion above would stay green
// over an example that 404s. Run it with ALETHIA_CHECK_LIVE_EXAMPLES=1 whenever you touch these
// constants.
//
// #4910 puts it on a schedule — the `live-worked-examples` job in `.github/workflows/
// workflow-health.yml`, daily. TWO THINGS THERE DEPEND ON THIS FILE'S SHAPE, and both fail CLOSED:
//
//   1. the job reads vitest's JSON report and requires at least two tests whose `fullName` begins
//      with the describe title below to have RUN and PASSED. Rename that title, delete a test, or
//      forget the env var, and the job is BLIND — which it reports as a failure, never as a pass.
//   2. it also requires the run to have skipped NOTHING. `describe.runIf(false)` reports its tests
//      as `skipped` while the FILE reports `passed` and vitest exits 0 — that exact combination is
//      the vacuous green the issue is about, so a non-zero skip count reds the job on its own.
//
// So the coupling is a name, and breaking the name costs a red job rather than a silent pass.
const LIVE = process.env.ALETHIA_CHECK_LIVE_EXAMPLES === "1";

/**
 * The GitHub API headers to probe with: a bearer token when one is in the environment, nothing
 * otherwise.
 *
 * WHY. GitHub's anonymous API budget is 60 requests/hour per SOURCE IP, and a hosted Actions runner
 * shares its egress IP with every other job on that host — so an unauthenticated probe can be
 * refused (403) for a reason that has nothing to do with the example, which would file a rot report
 * about a repository that is perfectly fine. A token lifts the budget WITHOUT weakening the
 * question: the starter chart lives in a different repository, so a token scoped to this one can
 * still only read it while it is PUBLIC — which is precisely what the assertion is. Absent locally,
 * where the budget is the developer's own and two calls do not trouble it.
 */
function githubHeaders(): Record<string, string> {
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Narrows a registry's token response to the bearer token it granted, or `undefined` when it
 * granted none — which is how a registry says "not anonymously, you don't". */
function bearerTokenOf(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null || !("token" in body)) return undefined;
	const { token } = body;
	return typeof token === "string" ? token : undefined;
}

describe.runIf(LIVE)("ByoChartDialog — the worked example, fetched for real", () => {
	it("the starter repository is public, a template, and holds Chart.yaml at the offered path", async () => {
		// Derived from the constant, never retyped: a copy here could agree with itself while the
		// dialog showed something else.
		const slug = new URL(STARTER_CHART_REPO_URL).pathname.replace(/^\//, "");
		const headers = githubHeaders();
		const repo = await fetch(`https://api.github.com/repos/${slug}`, { headers });
		expect(repo.status).toBe(200);
		const meta: unknown = await repo.json();
		expect(meta).toMatchObject({ private: false, is_template: true });

		const chart = await fetch(
			`https://api.github.com/repos/${slug}/contents/${STARTER_CHART_PATH}/Chart.yaml`,
			{ headers },
		);
		expect(chart.status).toBe(200);
	}, 30_000);

	it("the OCI chart reference is pullable with no credential", async () => {
		const ref = EXAMPLE_OCI_CHART_REF.replace(/^oci:\/\//, "");
		const [host, ...rest] = ref.split("/");
		const path = rest.join("/");
		const auth = await fetch(
			`https://${host}/token?scope=repository:${path}:pull&service=${host}`,
		);
		expect(auth.status).toBe(200);
		const granted: unknown = await auth.json();
		// A registry answers an anonymous token request for a repository nobody may pull with an
		// `errors` body and no token, so the token's presence IS the assertion.
		const token = bearerTokenOf(granted);
		expect(token).toEqual(expect.any(String));

		const tags = await fetch(`https://${host}/v2/${path}/tags/list?n=1`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(tags.status).toBe(200);
	}, 30_000);
});
