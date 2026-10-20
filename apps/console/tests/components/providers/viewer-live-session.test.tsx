// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `useViewer()` asks the browser for the session only when the server's answer can be stale (F003,
// #6114).
//
// Subscribing to better-auth's session atom is what makes it fetch `/get-session`. Every private
// page already carries the session the layout read (`ViewerProvider`), so a SEEDED viewer must not
// subscribe — until a client auth call changes the session (better-auth's session signal), which
// is the one way that seed goes stale without a navigation. An UNSEEDED viewer (a public route)
// follows the live session as before. `liveSession` is the seam: these tests count its subscribers.

import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSessionRead } from "@/lib/auth/client";
import type { Viewer } from "@/lib/auth/viewer";

/** The spies behind `liveSession`, and the session-changed listener the provider registered. */
const h = vi.hoisted(() => ({
	subscribe: vi.fn(() => () => {}),
	get: vi.fn((): LiveSessionRead => ({ data: null, isPending: true, error: null })),
	changed: new Array<() => void>(),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {},
	liveSession: {
		subscribe: h.subscribe,
		get: h.get,
		onChange: (listener: () => void) => {
			h.changed.push(listener);
			return () => {};
		},
	},
}));

const ADA: Viewer = {
	id: "u-ada",
	name: "Ada Lovelace",
	email: "ada@acme.test",
	image: null,
	createdAt: new Date("2026-01-15T09:00:00.000Z"),
};

/** A fresh copy of the provider module: its "session changed" flag is module state. */
async function load() {
	vi.resetModules();
	return import("@/components/providers/viewer-provider");
}

beforeEach(() => {
	h.subscribe.mockClear();
	h.get.mockClear();
	h.changed.length = 0;
});

describe("useViewer and the live session (F003)", () => {
	it("SEEDED: renders the seed and never subscribes, so better-auth fetches nothing", async () => {
		const { ViewerProvider, useViewer } = await load();
		/** Prints the viewer's name. */
		function Name() {
			return <span>{useViewer().viewer?.name ?? "nobody"}</span>;
		}
		render(
			<ViewerProvider viewer={ADA}>
				<Name />
			</ViewerProvider>,
		);
		expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
		expect(h.subscribe).not.toHaveBeenCalled();
		expect(h.get).not.toHaveBeenCalled();
	});

	it("SEEDED: follows the live session once a client call changed it", async () => {
		const { ViewerProvider, useViewer } = await load();
		/** Prints the viewer's name. */
		function Name() {
			return <span>{useViewer().viewer?.name ?? "nobody"}</span>;
		}
		render(
			<ViewerProvider viewer={ADA}>
				<Name />
			</ViewerProvider>,
		);
		h.get.mockReturnValue({ data: { user: { ...ADA, name: "Ada King" } }, isPending: false, error: null });
		act(() => {
			for (const notify of h.changed) notify();
		});
		expect(h.subscribe).toHaveBeenCalled();
		expect(screen.getByText("Ada King")).toBeInTheDocument();
	});

	it("UNSEEDED: follows the live session from the start", async () => {
		const { useViewer } = await load();
		h.get.mockReturnValue({ data: { user: ADA }, isPending: false, error: null });
		/** Prints the viewer's name. */
		function Name() {
			return <span>{useViewer().viewer?.name ?? "nobody"}</span>;
		}
		render(<Name />);
		expect(h.subscribe).toHaveBeenCalled();
		expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
	});
});
