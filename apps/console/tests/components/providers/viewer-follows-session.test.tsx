// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A SEEDED viewer still follows session changes from other tabs and on focus (#6114).
//
// The private layout seeds `useViewer()` with the session it read, and a seeded viewer does not
// subscribe to better-auth's session atom on load (subscribing is a `/get-session` request). It
// follows session changes from other tabs and on focus. These tests drive the REAL `liveSession`
// seam (`lib/auth/client.ts`) and the real provider; only better-auth's client is replaced, by two
// minimal atoms. Asserted: after another tab's broadcast, or after the tab is focused again, the
// viewer follows the live session, and a live answer of "no session" renders as signed out; and a
// session change in this tab is broadcast while nothing had the atom mounted.

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/viewer";

/** A minimal nanostores-shaped atom: a value, listeners, and a count of them. */
interface FakeAtom {
	get(): unknown;
	listen(listener: () => void): () => void;
	set(value: unknown): void;
	listeners(): number;
}

/** Builds a {@link FakeAtom} holding `initial`. */
function fakeAtom(initial: unknown): FakeAtom {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => value,
		listen: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		set: (next) => {
			value = next;
			for (const l of listeners) l();
		},
		listeners: () => listeners.size,
	};
}

const h = vi.hoisted(() => {
	const atoms: Record<string, unknown> = {};
	return { atoms };
});

vi.mock("next-runtime-env", () => ({ env: () => undefined }));
vi.mock("better-auth/react", () => ({
	createAuthClient: () => ({ $store: { atoms: h.atoms } }),
}));

const ADA: Viewer = {
	id: "u-ada",
	name: "Ada Lovelace",
	email: "ada@acme.test",
	image: null,
	createdAt: new Date("2026-01-15T09:00:00.000Z"),
};

let session: FakeAtom;
let signal: FakeAtom;

/** Fresh copies of the seam and the provider (both hold module state), over fresh atoms. */
async function load() {
	session = fakeAtom({ data: null, isPending: true, error: null });
	signal = fakeAtom(false);
	h.atoms.session = session;
	h.atoms.$sessionSignal = signal;
	vi.resetModules();
	const { ViewerProvider, useViewer } = await import("@/components/providers/viewer-provider");
	/** Prints the viewer's name, or "signed out". */
	function Name() {
		return <span>{useViewer().viewer?.name ?? "signed out"}</span>;
	}
	render(
		<ViewerProvider viewer={ADA}>
			<Name />
		</ViewerProvider>,
	);
	return { session, signal };
}

/** better-auth's answer once it has fetched: nobody is signed in. */
const NO_SESSION = { data: null, isPending: false, error: null };

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.useRealTimers();
});

/** Another person, as better-auth's live session carries them. */
const GRACE = { id: "u-grace", name: "Grace Hopper", email: "grace@acme.test", createdAt: new Date(0) };

/** Wakes a seeded viewer the way another tab's session change does. */
function broadcast(): void {
	act(() => {
		window.dispatchEvent(new StorageEvent("storage", { key: "better-auth.message" }));
	});
}

describe("a seeded viewer follows session changes (#6114)", () => {
	it("renders the seed without mounting the session atom (no request on load)", async () => {
		const { session } = await load();
		expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
		expect(session.listeners()).toBe(0);
	});

	it("follows another tab's session change: a broadcast, then no live session ⇒ signed out", async () => {
		const { session } = await load();
		act(() => {
			window.dispatchEvent(new StorageEvent("storage", { key: "better-auth.message" }));
		});
		expect(session.listeners()).toBeGreaterThan(0);
		act(() => session.set(NO_SESSION));
		expect(screen.getByText("signed out")).toBeInTheDocument();
	});

	it("follows on focus after the rate limit: no live session ⇒ signed out", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { session } = await load();
		// Inside the rate limit, a focus does nothing.
		act(() => window.dispatchEvent(new Event("focus")));
		expect(session.listeners()).toBe(0);
		vi.setSystemTime(Date.now() + 6_000);
		act(() => window.dispatchEvent(new Event("focus")));
		expect(session.listeners()).toBeGreaterThan(0);
		act(() => session.set(NO_SESSION));
		expect(screen.getByText("signed out")).toBeInTheDocument();
	});

	it("keeps the LIVE answer through a later failed refetch — never the seed again", async () => {
		const { session } = await load();
		broadcast();
		act(() => session.set({ data: { user: GRACE }, isPending: false, error: null }));
		expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
		// better-auth keeps the last good data and sets `error` when a refetch fails (a 5xx, a drop).
		act(() =>
			session.set({ data: { user: GRACE }, isPending: false, error: { status: 502, message: "Bad Gateway" } }),
		);
		expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
		expect(screen.queryByText("Ada Lovelace")).toBeNull();
	});

	it("keeps a settled signed-out answer through a later failed refetch", async () => {
		const { session } = await load();
		broadcast();
		act(() => session.set(NO_SESSION));
		expect(screen.getByText("signed out")).toBeInTheDocument();
		act(() => session.set({ data: null, isPending: false, error: new Error("network down") }));
		expect(screen.getByText("signed out")).toBeInTheDocument();
	});

	it("before the live session has ever answered, a failed fetch keeps the seed", async () => {
		const { session } = await load();
		broadcast();
		act(() => session.set({ data: null, isPending: false, error: new Error("network down") }));
		expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
	});

	it("an unrelated storage key does not wake it", async () => {
		const { session } = await load();
		act(() => {
			window.dispatchEvent(new StorageEvent("storage", { key: "something-else" }));
		});
		expect(session.listeners()).toBe(0);
	});

	it("this tab's own session change is broadcast to other tabs while nothing had the atom mounted", async () => {
		const { signal } = await load();
		expect(localStorage.getItem("better-auth.message")).toBeNull();
		act(() => signal.set(true)); // what better-auth does after sign-out / update-user
		const message: unknown = JSON.parse(localStorage.getItem("better-auth.message") ?? "null");
		expect(message).toMatchObject({ event: "session", data: expect.anything() });
	});
});
