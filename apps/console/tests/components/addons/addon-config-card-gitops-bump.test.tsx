// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6549: a GitOps-mode install's update notice offers a pull request that bumps the seeded file,
// shows the one that exists, and reopens a declined one only when "Open it again" is pressed.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AddonInstallState,
	AddonMarketItem,
} from "@/app/server/actions/addons";

const { enableMut, disableMut, bumpMut } = vi.hoisted(() => ({
	enableMut: { mutateAsync: vi.fn(), isPending: false },
	disableMut: { mutateAsync: vi.fn(), isPending: false },
	bumpMut: { mutate: vi.fn(), isPending: false },
}));
vi.mock("@/lib/query/use-addons-query", () => ({
	useEnableAddon: () => enableMut,
	useDisableAddon: () => disableMut,
	useRequestGitopsBump: () => bumpMut,
	useAddonsQuery: vi.fn(),
}));

import { AddonConfigForm } from "@/components/addons/addon-config-card";
import type { GitopsBumpRecord } from "@/types/jsonb.types";

const SECURITY = {
	summary: "Includes the fixes for CVE-2025-1974.",
	advisoryUrl: "https://kubernetes.io/blog/2025/03/24/ingress-nginx-cve-2025-1974/",
};

const ITEM: AddonMarketItem = {
	id: "ingress-nginx",
	name: "Ingress NGINX",
	category: "networking",
	icon: "Network",
	summary: "Routes traffic.",
	docsUrl: "https://example.com",
	license: "Apache-2.0",
	chart: "ingress-nginx",
	version: "4.15.1",
	securityRelease: SECURITY,
	namespace: "ingress-nginx",
	requires: [],
	fields: [],
	install: null,
};

const PINNED: AddonInstallState = {
	enabled: true,
	mode: "managed",
	values: {},
	valuesYaml: null,
	version: "4.11.2",
	status: "ACTIVE",
	health: null,
	sync: null,
	lastSyncedAt: null,
	gitopsBump: null,
};

/** Renders the form for `item`. */
function renderForm(item: AddonMarketItem, appsRepoName: string | null = "acme/apps") {
	render(
		<AddonConfigForm
			item={item}
			projectId="p1"
			environmentId="e1"
			hasAppsRepo
			appsRepoName={appsRepoName}
			provider={null}
			onDone={vi.fn()}
		/>,
	);
}

const GITOPS: AddonInstallState = { ...PINNED, mode: "gitops", version: null };

const RECORD: GitopsBumpRecord = {
	version: "4.15.1",
	provider: "github",
	number: 42,
	url: "https://github.com/acme/apps/pull/42",
	branch: "alethia/addon-bump-ingress-nginx-4.15.1",
	state: "open",
	opened_by: "u1",
	updated_at: "2026-11-12T00:00:00.000Z",
};

beforeEach(() => {
	bumpMut.mutate.mockReset();
});

describe("AddonConfigForm — the GitOps bump pull request (#6549)", () => {
	it("offers the pull request, and sends nothing before the press", async () => {
		const user = userEvent.setup();
		renderForm({ ...ITEM, install: GITOPS });
		expect(bumpMut.mutate).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Open a pull request to 4.15.1" }));
		expect(bumpMut.mutate).toHaveBeenCalledTimes(1);
		expect(bumpMut.mutate.mock.calls[0]?.[0]).toEqual({
			projectId: "p1",
			environmentId: "e1",
			addonId: "ingress-nginx",
			again: false,
		});
	});

	it("links an open pull request instead of offering another", () => {
		renderForm({ ...ITEM, install: { ...GITOPS, gitopsBump: RECORD } });
		expect(screen.getByRole("link", { name: "#42" })).toHaveAttribute("href", RECORD.url);
		expect(screen.queryByRole("button", { name: /open a pull request/i })).toBeNull();
	});

	it("a declined pull request is said, and only 'Open it again' asks again", async () => {
		const user = userEvent.setup();
		renderForm({ ...ITEM, install: { ...GITOPS, gitopsBump: { ...RECORD, state: "declined" } } });
		expect(screen.getByTestId("gitops-bump")).toHaveTextContent("You closed pull request #42");
		expect(screen.queryByRole("button", { name: /open a pull request/i })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Open it again" }));
		expect(bumpMut.mutate.mock.calls[0]?.[0]).toMatchObject({ again: true });
	});

	it("a stored pull request for ANOTHER version is no pull request: the card offers a new one", () => {
		// #42 moved the file to 4.11.2; the catalog has since moved to 4.15.1.
		renderForm({ ...ITEM, install: { ...GITOPS, gitopsBump: { ...RECORD, version: "4.11.2", state: "declined" } } });
		expect(screen.queryByRole("link", { name: "#42" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Open it again" })).toBeNull();
		expect(screen.getByRole("button", { name: "Open a pull request to 4.15.1" })).toBeDefined();
	});

	it("a pinned GitOps install: the button names the PIN, which is what the bump moves the file to", () => {
		renderForm({ ...ITEM, install: { ...GITOPS, version: "4.13.0" } });
		expect(screen.getByRole("button", { name: "Open a pull request to 4.13.0" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Open a pull request to 4.15.1" })).toBeNull();
	});

	it("a pinned GitOps install: a stored pull request for the pin is shown", () => {
		renderForm({ ...ITEM, install: { ...GITOPS, version: "4.13.0", gitopsBump: { ...RECORD, version: "4.13.0" } } });
		expect(screen.getByRole("link", { name: "#42" })).toBeDefined();
	});

	it("names the repo the pull request is opened in, before the press", () => {
		renderForm({ ...ITEM, install: GITOPS });
		expect(screen.getByTestId("gitops-bump")).toHaveTextContent("It is opened in acme/apps, with your own GitHub account.");
	});

	it("names no repo when the apps repo is not a GitHub one", () => {
		renderForm({ ...ITEM, install: GITOPS }, null);
		expect(screen.getByTestId("gitops-bump")).not.toHaveTextContent("It is opened in");
	});

	it("offers nothing to a managed install", () => {
		renderForm({ ...ITEM, install: PINNED });
		expect(screen.queryByTestId("gitops-bump")).toBeNull();
	});

	it("offers nothing to a GitOps install on an environment with no apps repo", () => {
		render(
			<AddonConfigForm
				item={{ ...ITEM, install: GITOPS }}
				projectId="p1"
				environmentId="e1"
				hasAppsRepo={false}
				provider={null}
				onDone={vi.fn()}
			/>,
		);
		expect(screen.queryByTestId("gitops-bump")).toBeNull();
	});
});
