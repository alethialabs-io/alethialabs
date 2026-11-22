// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6543: the configure card of a deprecated add-on steers a new install to the replacement, drops
// its Enable button once new installs have closed, and tells an environment that already has it
// that it keeps working — without ever offering to remove it.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const GUIDE = "https://alethialabs.io/docs/guides/design-project/migrate-from-ingress-nginx";

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
	securityRelease: null,
	deprecated: {
		reason: "Upstream retired it.",
		replacementId: "traefik",
		replacementName: "Traefik",
		removalDate: "2027-02-09",
		migrationGuideUrl: GUIDE,
	},
	namespace: "ingress-nginx",
	requires: [],
	fields: [],
	install: null,
};

const INSTALLED: AddonInstallState = {
	enabled: true,
	mode: "managed",
	values: {},
	valuesYaml: null,
	version: null,
	status: "ACTIVE",
	health: null,
	sync: null,
	lastSyncedAt: null,
	gitopsBump: null,
};

/** Renders the form for `item`; returns the replacement-opener spy. */
function renderForm(item: AddonMarketItem) {
	const onOpenAddon = vi.fn();
	render(
		<AddonConfigForm
			item={item}
			projectId="p1"
			environmentId="e1"
			hasAppsRepo
			provider={null}
			onDone={vi.fn()}
			onOpenAddon={onOpenAddon}
		/>,
	);
	return onOpenAddon;
}

/** Pins the clock to `iso` (only Date — timers stay real for user-event). */
function at(iso: string) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
	board.reset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("AddonConfigForm — a deprecated add-on", () => {
	it("before the removal date, leads a new install to the replacement and still lets it be added", async () => {
		at("2026-12-01T12:00:00Z");
		const user = userEvent.setup();
		const onOpenAddon = renderForm(ITEM);
		const notice = screen.getByTestId("addon-deprecation-notice");
		expect(notice).toHaveAttribute("data-closed", "false");
		expect(notice).toHaveTextContent("Ingress NGINX is deprecated. Use Traefik instead");
		expect(notice).toHaveTextContent("Upstream retired it.");
		expect(notice).toHaveTextContent("New installs close on");
		expect(screen.getByRole("link", { name: /migration guide/i })).toHaveAttribute("href", GUIDE);
		await user.click(screen.getByRole("button", { name: "Open Traefik" }));
		expect(onOpenAddon).toHaveBeenCalledWith("traefik");
		expect(screen.getByRole("button", { name: "Add to changes" })).toBeInTheDocument();
	});

	it("from the removal date, says new installs are closed and stages nothing", async () => {
		at("2027-02-09T00:00:00Z");
		renderForm(ITEM);
		const notice = screen.getByTestId("addon-deprecation-notice");
		expect(notice).toHaveAttribute("data-closed", "true");
		expect(notice).toHaveTextContent("Ingress NGINX no longer accepts new installs");
		expect(screen.queryByRole("button", { name: "Add to changes" })).toBeNull();
		expect(screen.getByRole("button", { name: "Open Traefik" })).toBeInTheDocument();
		// A change that could only be refused is not offered: the form is disabled, and leaving it
		// stages nothing.
		const version = screen.getByLabelText("Chart version");
		expect(version).toBeDisabled();
		await userEvent.setup().tab();
		expect(board.document.getState().operations).toEqual([]);
	});

	it("tells an installed environment it keeps working, and can still be reconfigured — even after the date", async () => {
		at("2027-06-01T00:00:00Z");
		renderForm({ ...ITEM, install: INSTALLED });
		const notice = screen.getByTestId("addon-deprecation-notice");
		expect(notice).toHaveAttribute("data-installed", "true");
		expect(notice).toHaveTextContent("Ingress NGINX is deprecated");
		expect(notice).toHaveTextContent("This environment keeps it");
		expect(notice).toHaveTextContent("New installs closed on");
		const user = userEvent.setup();
		const version = screen.getByLabelText("Chart version");
		expect(version).toBeEnabled();
		await user.type(version, "4.12.0");
		await user.tab();
		expect(board.document.getState().operations.map((o) => o.verb)).toEqual(["update"]);
	});

	it("after the date, the Remove confirm says plainly that removal cannot be undone", async () => {
		at("2027-06-01T00:00:00Z");
		const user = userEvent.setup();
		renderForm({ ...ITEM, install: INSTALLED });
		await user.click(screen.getByRole("button", { name: "Remove" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("This cannot be undone");
		expect(dialog).toHaveTextContent("it cannot be re-enabled here");
		expect(dialog).not.toHaveTextContent("re-enabling it starts from the defaults");
	});

	it("before the date, the Remove confirm keeps the ordinary re-enable sentence", async () => {
		at("2026-12-01T12:00:00Z");
		const user = userEvent.setup();
		renderForm({ ...ITEM, install: INSTALLED });
		await user.click(screen.getByRole("button", { name: "Remove" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("re-enabling it starts from the defaults");
		expect(dialog).not.toHaveTextContent("cannot be undone");
	});

	it("shows nothing for an add-on that is not deprecated", () => {
		renderForm({ ...ITEM, deprecated: null });
		expect(screen.queryByTestId("addon-deprecation-notice")).toBeNull();
	});
});
