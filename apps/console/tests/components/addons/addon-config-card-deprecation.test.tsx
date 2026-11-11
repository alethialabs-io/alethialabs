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

const { enableMut, disableMut } = vi.hoisted(() => ({
	enableMut: { mutateAsync: vi.fn(), isPending: false },
	disableMut: { mutateAsync: vi.fn(), isPending: false },
}));
vi.mock("@/lib/query/use-addons-query", () => ({
	useEnableAddon: () => enableMut,
	useDisableAddon: () => disableMut,
	useAddonsQuery: vi.fn(),
}));

import { AddonConfigForm } from "@/components/addons/addon-config-card";

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
	enableMut.mutateAsync.mockReset();
	enableMut.mutateAsync.mockResolvedValue({ ok: true });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("AddonConfigForm — a deprecated add-on", () => {
	it("before the removal date, leads a new install to the replacement and still allows Enable", async () => {
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
		expect(screen.getByRole("button", { name: /enable add-on/i })).toBeInTheDocument();
	});

	it("from the removal date, says new installs are closed and offers no Enable button", () => {
		at("2027-02-09T00:00:00Z");
		renderForm(ITEM);
		const notice = screen.getByTestId("addon-deprecation-notice");
		expect(notice).toHaveAttribute("data-closed", "true");
		expect(notice).toHaveTextContent("Ingress NGINX no longer accepts new installs");
		expect(screen.queryByRole("button", { name: /enable add-on/i })).toBeNull();
		expect(screen.getByRole("button", { name: "Open Traefik" })).toBeInTheDocument();
	});

	it("tells an installed environment it keeps working, and keeps Save — even after the date", () => {
		at("2027-06-01T00:00:00Z");
		renderForm({ ...ITEM, install: INSTALLED });
		const notice = screen.getByTestId("addon-deprecation-notice");
		expect(notice).toHaveAttribute("data-installed", "true");
		expect(notice).toHaveTextContent("Ingress NGINX is deprecated");
		expect(notice).toHaveTextContent("This environment keeps it");
		expect(notice).toHaveTextContent("New installs closed on");
		expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
	});

	it("shows nothing for an add-on that is not deprecated", () => {
		renderForm({ ...ITEM, deprecated: null });
		expect(screen.queryByTestId("addon-deprecation-notice")).toBeNull();
	});
});
