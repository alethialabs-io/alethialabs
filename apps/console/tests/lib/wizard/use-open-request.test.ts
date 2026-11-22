// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// lib/wizard/use-open-request.ts: a parent's open request and an overlay's URL, kept in step.
// The hook reacts to edges, so each case renders, then re-renders with one input changed.

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WizardOpener } from "@/lib/wizard/location";
import { useOpenRequest } from "@/lib/wizard/use-open-request";

/** The hook's inputs for one render. */
interface Props {
	readonly requested: boolean;
	readonly urlOpen: boolean;
}

/** An opener whose `open` is the URL's state; `setOpen` is never called by the hook. */
function opener(open: boolean): WizardOpener {
	return { open, setOpen: () => undefined };
}

/** Renders the hook with spies for both callbacks. */
function setup(initial: Props) {
	const onRequestedChange = vi.fn<(open: boolean) => void>();
	const openUrl = vi.fn<() => void>();
	const view = renderHook(
		({ requested, urlOpen }: Props) =>
			useOpenRequest(requested, onRequestedChange, opener(urlOpen), openUrl),
		{ initialProps: initial },
	);
	return { ...view, onRequestedChange, openUrl };
}

describe("useOpenRequest", () => {
	it("does nothing while neither the request nor the URL is open", () => {
		const { rerender, onRequestedChange, openUrl } = setup({ requested: false, urlOpen: false });
		rerender({ requested: false, urlOpen: false });
		expect(openUrl).not.toHaveBeenCalled();
		expect(onRequestedChange).not.toHaveBeenCalled();
	});

	it("opens the URL when the request rises", () => {
		const { rerender, onRequestedChange, openUrl } = setup({ requested: false, urlOpen: false });
		rerender({ requested: true, urlOpen: false });
		expect(openUrl).toHaveBeenCalledTimes(1);
		expect(onRequestedChange).not.toHaveBeenCalled();
	});

	it("opens the URL for a request that is up on the first render", () => {
		const { openUrl } = setup({ requested: true, urlOpen: false });
		expect(openUrl).toHaveBeenCalledTimes(1);
	});

	it("does not open the URL again while the same request stays up", () => {
		const { rerender, openUrl } = setup({ requested: false, urlOpen: false });
		rerender({ requested: true, urlOpen: false });
		rerender({ requested: true, urlOpen: true });
		rerender({ requested: true, urlOpen: true });
		expect(openUrl).toHaveBeenCalledTimes(1);
	});

	it("does not open the URL when the request rises while it is already open", () => {
		const { rerender, openUrl, onRequestedChange } = setup({ requested: false, urlOpen: true });
		onRequestedChange.mockClear();
		rerender({ requested: true, urlOpen: true });
		expect(openUrl).not.toHaveBeenCalled();
		expect(onRequestedChange).not.toHaveBeenCalled();
	});

	it("reports a URL that opens on its own", () => {
		const { rerender, onRequestedChange, openUrl } = setup({ requested: false, urlOpen: false });
		rerender({ requested: false, urlOpen: true });
		expect(onRequestedChange).toHaveBeenCalledExactlyOnceWith(true);
		expect(openUrl).not.toHaveBeenCalled();
	});

	it("reports a URL that closes on its own while the request is up", () => {
		const { rerender, onRequestedChange, openUrl } = setup({ requested: false, urlOpen: false });
		rerender({ requested: true, urlOpen: false });
		rerender({ requested: true, urlOpen: true });
		rerender({ requested: true, urlOpen: false });
		expect(onRequestedChange).toHaveBeenCalledExactlyOnceWith(false);
		expect(openUrl).toHaveBeenCalledTimes(1);
	});

	it("does not report a URL change that already matches the request", () => {
		const { rerender, onRequestedChange } = setup({ requested: false, urlOpen: false });
		rerender({ requested: true, urlOpen: false });
		rerender({ requested: true, urlOpen: true });
		rerender({ requested: false, urlOpen: false });
		expect(onRequestedChange).not.toHaveBeenCalled();
	});
});
