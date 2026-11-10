// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `useHydrated` (promoted from the console in #6146) must answer false for the server render AND
// for the client render that hydrates it, true on every render after, and true from the FIRST
// render of something mounted on the client. Each half is what a caller relies on: the first keeps
// the hydrating render identical to the server's HTML (React #418 otherwise), the second keeps a
// client mount from flashing its pending state for a frame.

// RTL's `act` (not React's) flags the environment as an act environment while it runs.
import { act, render } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useHydrated } from "../src/use-hydrated";

/** Reports every value the hook answers, in render order, and prints the latest. */
function Probe({ onRender }: { onRender: (hydrated: boolean) => void }) {
	const hydrated = useHydrated();
	onRender(hydrated);
	return <span>{hydrated ? "hydrated" : "server"}</span>;
}

/** A recorder for `Probe`: the values it saw, and the callback that appends to them. */
function recorder() {
	const seen: boolean[] = [];
	return { seen, onRender: (hydrated: boolean) => void seen.push(hydrated) };
}

describe("useHydrated", () => {
	it("is false in the server render", () => {
		const { seen, onRender } = recorder();
		expect(renderToString(<Probe onRender={onRender} />)).toContain("server");
		expect(seen).toEqual([false]);
	});

	it("is false while hydrating the server's HTML, then true", async () => {
		const host = document.createElement("div");
		host.innerHTML = renderToString(<Probe onRender={() => {}} />);
		document.body.appendChild(host);
		const { seen, onRender } = recorder();
		const errors: unknown[] = [];

		let root: Root | undefined;
		await act(async () => {
			root = hydrateRoot(host, <Probe onRender={onRender} />, {
				onRecoverableError: (error) => void errors.push(error),
			});
		});

		expect(seen[0]).toBe(false);
		expect(seen.at(-1)).toBe(true);
		expect(host.textContent).toBe("hydrated");
		expect(errors).toEqual([]);
		act(() => root?.unmount());
		host.remove();
	});

	it("is true from the first render of a client-only mount", () => {
		const { seen, onRender } = recorder();
		const { container } = render(<Probe onRender={onRender} />);
		expect(seen[0]).toBe(true);
		expect(container.textContent).toBe("hydrated");
	});
});
