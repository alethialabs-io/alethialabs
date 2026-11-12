// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6599: the card says GitOps delivery is unavailable for an apps repo that is not on GitHub, and
// does not let it be picked, before the server refuses the same choice with the same sentence.

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

const REFUSAL =
	"GitOps delivery works only with an apps repository on GitHub for now. This environment's apps " +
	"repository is on Bitbucket, and Alethia's Bitbucket connection can read repositories but cannot " +
	"push to them. Use Managed delivery instead.";

/** Renders the form with an apps repo whose GitOps refusal is `gitopsRefusal`. */
function renderForm(item: AddonMarketItem, gitopsRefusal: string | null) {
	render(
		<AddonConfigForm
			item={item}
			projectId="p1"
			environmentId="e1"
			hasAppsRepo
			appsRepoName={null}
			gitopsRefusal={gitopsRefusal}
			provider={null}
			onDone={vi.fn()}
		/>,
	);
}

/** Opens the Delivery picker and returns its GitOps option. */
async function openGitopsOption() {
	const user = userEvent.setup();
	const trigger = screen
		.getAllByRole("combobox")
		.find((el) => el.textContent?.includes("Managed"));
	if (!trigger) throw new Error("no Delivery picker");
	await user.click(trigger);
	return screen.findByRole("option", { name: /GitOps/ });
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("AddonConfigForm — GitOps delivery on an apps repo that is not on GitHub", () => {
	it("states the refusal and disables the GitOps option", async () => {
		renderForm(ITEM, REFUSAL);
		expect(screen.getByText(REFUSAL)).toBeInTheDocument();
		const option = await openGitopsOption();
		expect(option).toHaveAttribute("aria-disabled", "true");
	});

	it("keeps the GitOps option available for an apps repo on GitHub", async () => {
		renderForm(ITEM, null);
		expect(screen.queryByText(REFUSAL)).not.toBeInTheDocument();
		const option = await openGitopsOption();
		expect(option).not.toHaveAttribute("aria-disabled", "true");
	});

	it("states the refusal on an add-on already in GitOps mode, so the person knows to switch", () => {
		const gitops: AddonInstallState = { ...PINNED, mode: "gitops", version: null };
		renderForm({ ...ITEM, install: gitops }, REFUSAL);
		expect(screen.getByText(REFUSAL)).toBeInTheDocument();
		expect(screen.queryByText(/The manifest is seeded into your apps repo/)).not.toBeInTheDocument();
	});
});
