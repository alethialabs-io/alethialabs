// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The engine's wiring to a console page (lib/wizard/location.ts, and `useWizard` on top of it):
// the App Router behind `WizardLocation`, the viewer behind `viewerId`, and an overlay's open
// state derived from `?wizard=`. The router and the viewer are replaced here; what the engine
// does with a location is covered in use-wizard.test.tsx.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerState } from "@/components/providers/viewer-provider";

const page = vi.hoisted(() => {
	const viewer: ViewerState = { viewer: null, isPending: false };
	return { search: "", pathname: "/acme/~/fleet", push: vi.fn(), replace: vi.fn(), viewer };
});

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: page.push, replace: page.replace }),
	usePathname: () => page.pathname,
	useSearchParams: () => new URLSearchParams(page.search),
}));

vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => page.viewer,
}));

import { useWizardEnvironment, useWizardOpener, wizardOpener } from "@/lib/wizard/location";
import type { WizardLocation } from "@/lib/wizard/types";
import { useWizard } from "@/lib/wizard/use-wizard";
import { type ExamplePoolValues, examplePoolWizard } from "./fixtures/example.wizard";

/** A signed-in viewer, as `useViewer()` answers. */
const SIGNED_IN: ViewerState = {
	viewer: { id: "user-1", name: "Ada", email: "ada@example.com", image: null, createdAt: new Date(0) },
	isPending: false,
};

beforeEach(() => {
	page.search = "";
	page.push.mockReset();
	page.replace.mockReset();
	page.viewer = SIGNED_IN;
	window.sessionStorage.clear();
});

describe("useWizardEnvironment", () => {
	it("reads params from the URL", () => {
		page.search = "wizard=fleet-pool&step=capacity";
		const { result } = renderHook(() => useWizardEnvironment());
		expect(result.current.location.read("step")).toBe("capacity");
		expect(result.current.location.read("absent")).toBeNull();
	});

	it("pushes and replaces a patched href without scrolling, keeping other params", () => {
		page.search = "status=active&step=cloud";
		const { result } = renderHook(() => useWizardEnvironment());
		result.current.location.push({ step: "review" });
		result.current.location.replace({ step: null });
		expect(page.push).toHaveBeenCalledWith("/acme/~/fleet?status=active&step=review", { scroll: false });
		expect(page.replace).toHaveBeenCalledWith("/acme/~/fleet?status=active", { scroll: false });
	});

	it("leaves for a path by replacing the current entry", () => {
		const { result } = renderHook(() => useWizardEnvironment());
		result.current.location.leave("/acme/~/new");
		expect(page.replace).toHaveBeenCalledWith("/acme/~/new");
	});

	it("answers the viewer's id, null for nobody, and undefined while that is not known", () => {
		expect(renderHook(() => useWizardEnvironment()).result.current.viewerId).toBe("user-1");
		page.viewer = { viewer: null, isPending: false };
		expect(renderHook(() => useWizardEnvironment()).result.current.viewerId).toBeNull();
		page.viewer = { viewer: null, isPending: true };
		expect(renderHook(() => useWizardEnvironment()).result.current.viewerId).toBeUndefined();
	});
});

describe("an overlay's open state", () => {
	/** A location over a fixed query string that records its pushes. */
	function locationOver(search: string, pushes: unknown[]): WizardLocation {
		return {
			read: (name) => new URLSearchParams(search).get(name),
			push: (patch) => {
				pushes.push(patch);
			},
			replace: () => {},
			leave: () => {},
		};
	}

	it("is open exactly while ?wizard= names it", () => {
		expect(wizardOpener(locationOver("wizard=fleet-pool", []), "fleet-pool").open).toBe(true);
		expect(wizardOpener(locationOver("wizard=byo-chart", []), "fleet-pool").open).toBe(false);
		expect(wizardOpener(locationOver("step=cloud", []), "fleet-pool").open).toBe(false);
	});

	it("opens with a history entry naming the overlay", () => {
		const pushes: unknown[] = [];
		wizardOpener(locationOver("", pushes), "fleet-pool").setOpen(true);
		expect(pushes).toEqual([{ wizard: "fleet-pool" }]);
	});

	it("closes with a history entry removing the overlay and its step", () => {
		const pushes: unknown[] = [];
		wizardOpener(locationOver("wizard=fleet-pool&step=capacity", pushes), "fleet-pool").setOpen(false);
		expect(pushes).toEqual([{ wizard: null, step: null }]);
	});

	it("does nothing when asked for the state it is already in", () => {
		const pushes: unknown[] = [];
		wizardOpener(locationOver("wizard=fleet-pool", pushes), "fleet-pool").setOpen(true);
		wizardOpener(locationOver("", pushes), "fleet-pool").setOpen(false);
		expect(pushes).toEqual([]);
	});

	it("useWizardOpener reads and writes the page's URL", () => {
		page.search = "tab=pools";
		const { result } = renderHook(() => useWizardOpener("fleet-pool"));
		expect(result.current.open).toBe(false);
		result.current.setOpen(true);
		expect(page.push).toHaveBeenCalledWith("/acme/~/fleet?tab=pools&wizard=fleet-pool", { scroll: false });
	});
});

describe("useWizard", () => {
	it("runs the engine against the page's URL", async () => {
		const values: ExamplePoolValues = { provider: "aws", region: "eu-west-1", min: 1, surge: "1", note: "" };
		const { result } = renderHook(() =>
			useWizard(examplePoolWizard, { defaultValues: values, scope: "acme", onSubmit: () => {} }),
		);
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(result.current.current.id).toBe("cloud");
		await act(async () => {
			await result.current.next();
		});
		expect(page.push).toHaveBeenCalledWith("/acme/~/fleet?step=placement", { scroll: false });
	});
});
