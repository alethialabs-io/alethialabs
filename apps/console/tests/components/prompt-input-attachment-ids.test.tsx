// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The prompt input gives every attachment its own id, and must keep doing so on a self-host served
// over plain HTTP. There `crypto.randomUUID` is undefined, so the ids come from `randomUuid()` in
// `lib/random-id.ts`, which is built on `crypto.getRandomValues`. The test removes
// `crypto.randomUUID` to stand in for that origin, then adds files through the real provider.

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AttachmentsContext,
	PromptInputProvider,
	useProviderAttachments,
} from "@/components/ai-elements/prompt-input";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Mounts the provider and returns a getter for the live attachments context. */
function mountAttachments(): () => AttachmentsContext {
	let ctx: AttachmentsContext | null = null;
	/** Captures the provider's attachments context on every render. */
	function Probe() {
		ctx = useProviderAttachments();
		return null;
	}
	render(
		<PromptInputProvider>
			<Probe />
		</PromptInputProvider>,
	);
	return () => {
		if (!ctx) throw new Error("the provider never rendered its child");
		return ctx;
	};
}

beforeEach(() => {
	// An insecure context: `crypto.randomUUID` does not exist there, but `getRandomValues` does.
	vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
	// jsdom has no object URLs; a subclass supplies them without mutating the real `URL`.
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL = vi.fn(() => "blob:test");
			static revokeObjectURL = vi.fn();
		},
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("PromptInputProvider attachment ids", () => {
	it("gives each added file a distinct version-4 UUID without crypto.randomUUID", () => {
		expect("randomUUID" in globalThis.crypto).toBe(false);
		const attachments = mountAttachments();
		const files = [
			new File(["a"], "a.txt", { type: "text/plain" }),
			new File(["b"], "b.txt", { type: "text/plain" }),
			new File(["c"], "c.txt", { type: "text/plain" }),
		];

		act(() => attachments().add(files));

		const ids = attachments().files.map((f) => f.id);
		expect(ids).toHaveLength(3);
		for (const id of ids) expect(id).toMatch(V4);
		expect(new Set(ids).size).toBe(3);
	});

	it("removes exactly the attachment whose id it is given", () => {
		const attachments = mountAttachments();
		act(() =>
			attachments().add([
				new File(["a"], "a.txt", { type: "text/plain" }),
				new File(["b"], "b.txt", { type: "text/plain" }),
			]),
		);
		const [first, second] = attachments().files;

		act(() => attachments().remove(first.id));

		expect(attachments().files.map((f) => f.filename)).toEqual([second.filename]);
	});
});
