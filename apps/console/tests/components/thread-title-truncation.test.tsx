// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Thread titles must truncate properly everywhere they surface: single-line ellipsis in
// the thread rail (with min-w-0 so the flex row actually lets it shrink) and a 2-line
// clamp on the modal landing's recents cards — each with a `title` attribute exposing
// the full text on hover. jsdom can't measure overflow, so these tests pin the class +
// attribute contract that produces the truncation.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadRail } from "@/components/agent/thread-rail";
import type { AgentThread } from "@/lib/db/schema";

const LONG_TITLE =
	"Build a dashboard of my infrastructure — clusters, jobs, cost, and…";

/** A minimal thread row for rendering (only the fields the rail reads). */
function thread(): AgentThread {
	const now = new Date();
	return {
		id: "t1",
		org_id: "o1",
		user_id: "u1",
		project_id: null,
		title: LONG_TITLE,
		status: "active",
		kind: "chat",
		messages: [],
		created_at: now,
		updated_at: now,
	};
}

describe("thread title truncation", () => {
	it("rail rows ellipsize (truncate + min-w-0) and expose the full title on hover", () => {
		render(
			<ThreadRail
				threads={[thread()]}
				activeId={null}
				onSelect={vi.fn()}
				onNew={vi.fn()}
				onDelete={vi.fn()}
			/>,
		);
		const el = screen.getByText(LONG_TITLE);
		expect(el.className).toContain("truncate");
		expect(el.className).toContain("min-w-0");
		expect(el).toHaveAttribute("title", LONG_TITLE);
	});
});
