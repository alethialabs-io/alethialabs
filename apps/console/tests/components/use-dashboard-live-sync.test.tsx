// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The dashboard live-sync hook is the missing writer behind the "panel stuck on
// Building…" bug: it fills an AWAITING artifact panel when build_dashboard finishes.
// These tests pin its guardrails — it fills pending panels and refreshes same-source
// ones, but never reopens a closed panel, never clobbers a different dashboard or a
// project/job artifact, never writes the same result twice, and streams progress
// (title + block count) while the input composes.

import { renderHook } from "@testing-library/react";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { useDashboardLiveSync } from "@/components/agent/elench/use-dashboard-live-sync";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";

const SPEC = {
	title: "Infrastructure",
	blocks: [{ kind: "stat", title: "Clusters", value: 0 }],
};

type Part = UIMessage["parts"][number];

/** A transcript whose last assistant turn carries one build_dashboard part. */
function messagesWith(part: Part): UIMessage[] {
	return [
		{ id: "u1", role: "user", parts: [{ type: "text", text: "dashboard" }] },
		{ id: "a1", role: "assistant", parts: [part] },
	];
}

/** A finished build_dashboard tool part. */
function finished(toolCallId = "call-1"): Part {
	return {
		type: "tool-build_dashboard",
		toolCallId,
		state: "output-available",
		input: SPEC,
		output: SPEC,
	};
}

beforeEach(() => {
	useArtifactStore.setState({ artifact: null, tab: "config" });
});

describe("useDashboardLiveSync", () => {
	it("fills a pending panel when the result lands", () => {
		useArtifactStore.getState().open({ dashboard: null }, "dashboard");
		renderHook(() => useDashboardLiveSync(messagesWith(finished())));
		const { artifact, tab } = useArtifactStore.getState();
		expect(artifact?.dashboard).toEqual(SPEC);
		expect(artifact?.dashboardSourceId).toBe("call-1");
		expect(tab).toBe("dashboard");
	});

	it("never reopens a closed panel", () => {
		renderHook(() => useDashboardLiveSync(messagesWith(finished())));
		expect(useArtifactStore.getState().artifact).toBeNull();
	});

	it("never clobbers a dashboard opened from a different result", () => {
		const other = { title: "Older", blocks: [] };
		useArtifactStore
			.getState()
			.open({ dashboard: other, dashboardSourceId: "call-0" }, "dashboard");
		renderHook(() => useDashboardLiveSync(messagesWith(finished("call-1"))));
		expect(useArtifactStore.getState().artifact?.dashboard).toEqual(other);
	});

	it("never touches a project/job artifact the user navigated to", () => {
		useArtifactStore.getState().open({ projectId: "p1" }, "config");
		renderHook(() => useDashboardLiveSync(messagesWith(finished())));
		const { artifact } = useArtifactStore.getState();
		expect(artifact?.projectId).toBe("p1");
		expect(artifact?.dashboard).toBeUndefined();
	});

	it("writes a finished result once, even as messages keep changing", () => {
		useArtifactStore.getState().open({ dashboard: null }, "dashboard");
		const { rerender } = renderHook(
			({ messages }: { messages: UIMessage[] }) => useDashboardLiveSync(messages),
			{ initialProps: { messages: messagesWith(finished()) } },
		);
		// The user navigates the filled panel elsewhere within the same source…
		useArtifactStore.setState({
			artifact: {
				dashboard: { title: "Edited", blocks: [] },
				dashboardSourceId: "call-1",
			},
		});
		rerender({ messages: messagesWith(finished()) });
		// …and the effect does not stomp it with a second write.
		expect(useArtifactStore.getState().artifact?.dashboard?.title).toBe("Edited");
	});

	it("streams composing progress (title + block count) onto a pending panel", () => {
		useArtifactStore.getState().open({ dashboard: null }, "dashboard");
		renderHook(() =>
			useDashboardLiveSync(
				messagesWith({
					type: "tool-build_dashboard",
					toolCallId: "call-1",
					state: "input-streaming",
					input: { title: "Infrastructure", blocks: [{}, {}] },
				}),
			),
		);
		const { artifact } = useArtifactStore.getState();
		expect(artifact?.dashboard).toBeNull();
		expect(artifact?.dashboardProgress).toEqual({
			title: "Infrastructure",
			blocks: 2,
		});
	});
});
