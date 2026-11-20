// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6537: the add-on subject tells a pinned or GitOps-mode install that the catalogue has moved on,
// prominently when the catalogue's version is a security release. It offers a one-click pin update
// and never changes the pin unless that button is pressed. The update is staged like every other
// edit of the add-on (#6834).

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AddonInstallState,
	AddonMarketItem,
} from "@/app/server/actions/addons";

const { disableMut } = vi.hoisted(() => ({
	disableMut: { mutateAsync: vi.fn(), isPending: false },
}));
vi.mock("@/lib/query/use-addons-query", () => ({
	useDisableAddon: () => disableMut,
	useRequestGitopsBump: () => ({ mutate: () => {}, isPending: false }),
	useAddonsQuery: vi.fn(),
}));

import { AddonConfigForm } from "@/components/addons/addon-config-card";
import { board } from "@/lib/canvas/store/board";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

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
function renderForm(item: AddonMarketItem) {
	render(
		<AddonConfigForm
			item={item}
			projectId="p1"
			environmentId="e1"
			hasAppsRepo
			provider={null}
			onDone={vi.fn()}
		/>,
	);
}

/** The operations staged in the document. */
const staged = () => board.document.getState().operations;

/** The `version` the staged operation carries. */
function stagedVersion(): unknown {
	const input = staged().at(-1)?.input;
	return input && typeof input === "object" && "version" in input ? input.version : "<absent>";
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("AddonConfigForm — the catalogue's update offer", () => {
	it("shows a pinned install a security update prominently, with the advisory", () => {
		renderForm({ ...ITEM, install: PINNED });
		const notice = screen.getByTestId("addon-update-notice");
		expect(notice).toHaveAttribute("data-security", "true");
		expect(notice).toHaveTextContent("Security update: Ingress NGINX 4.15.1");
		expect(notice).toHaveTextContent("pinned to 4.11.2");
		expect(notice).toHaveTextContent(SECURITY.summary);
		expect(screen.getByRole("link", { name: /read the advisory/i })).toHaveAttribute(
			"href",
			SECURITY.advisoryUrl,
		);
	});

	it("shows an ordinary update without the security treatment", () => {
		renderForm({ ...ITEM, securityRelease: null, install: PINNED });
		const notice = screen.getByTestId("addon-update-notice");
		expect(notice).toHaveAttribute("data-security", "false");
		expect(notice).toHaveTextContent("The catalog now ships Ingress NGINX 4.15.1");
		expect(screen.queryByRole("link", { name: /read the advisory/i })).toBeNull();
	});

	it("one click stages the pin at the catalogue's version — and nothing is staged before it", async () => {
		const user = userEvent.setup();
		renderForm({ ...ITEM, install: PINNED });
		expect(staged()).toEqual([]);
		await user.click(screen.getByRole("button", { name: "Update pin to 4.15.1" }));
		expect(staged()).toHaveLength(1);
		expect(stagedVersion()).toBe("4.15.1");
		expect(screen.getByLabelText("Chart version")).toHaveValue("4.15.1");
	});

	it("another edit keeps the pin — the update is offered, never forced", async () => {
		const user = userEvent.setup();
		renderForm({ ...ITEM, install: PINNED });
		await user.click(screen.getByRole("button", { name: /raw helm values/i }));
		await user.type(screen.getByLabelText("Raw Helm values (YAML)"), "replicaCount: 2");
		await user.tab();
		expect(staged()).toHaveLength(1);
		expect(stagedVersion()).toBe("4.11.2");
	});

	it("tells a GitOps install which file to change, and offers no pin button", () => {
		renderForm({ ...ITEM, install: { ...PINNED, mode: "gitops", version: null } });
		const notice = screen.getByTestId("addon-update-notice");
		expect(notice).toHaveAttribute("data-security", "true");
		expect(notice).toHaveTextContent("addons/ingress-nginx.yaml");
		expect(notice).toHaveTextContent("never rewrites that file");
		expect(screen.queryByRole("button", { name: /update pin/i })).toBeNull();
	});

	it("says nothing to a managed, unpinned install, which follows the catalogue", () => {
		renderForm({ ...ITEM, install: { ...PINNED, version: null } });
		expect(screen.queryByTestId("addon-update-notice")).toBeNull();
	});

	it("says nothing before the add-on is installed", () => {
		renderForm(ITEM);
		expect(screen.queryByTestId("addon-update-notice")).toBeNull();
	});
});
