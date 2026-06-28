// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component test for the redesigned Activity feed: bold actor + target segments, the Denied
// badge, avatar image-vs-initials fallback, month grouping, the empty state, and the
// server-paged "Load more" affordance.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ActivityRow } from "@/app/server/actions/activity";
import { ActivityFeed } from "@/components/settings/activity/activity-feed";
import type { ActivityContext } from "@/components/settings/activity/humanize-event";

const ctx: ActivityContext = {
	resolveName: (type, id) => (type === "project" && id === "project-1" ? "my-api" : null),
};

function row(over: Partial<ActivityRow> = {}): ActivityRow {
	return {
		id: "1",
		actorId: "u-1",
		actorName: null,
		actorEmail: "borislav@tovr.eu",
		actorImage: null,
		actorUsername: null,
		action: "manage_alerts",
		resourceType: "alert",
		resourceId: null,
		decision: true,
		reason: null,
		ts: "2026-06-20T10:00:00.000Z",
		...over,
	};
}

describe("ActivityFeed", () => {
	it("bolds the actor and the action target", () => {
		render(<ActivityFeed rows={[row()]} ctx={ctx} />);
		// "borislav@tovr.eu updated alert settings" → actor + target bold, "updated" plain.
		expect(screen.getByText("borislav").tagName).toBe("STRONG");
		expect(screen.getByText("alert settings").tagName).toBe("STRONG");
		expect(screen.getByText(/updated/)).toBeInTheDocument();
		// One line only — the email is not rendered as a second line.
		expect(screen.queryByText("borislav@tovr.eu")).toBeNull();
	});

	it("renders the resolved resource name in the target", () => {
		render(
			<ActivityFeed
				rows={[row({ action: "create", resourceType: "project", resourceId: "project-1" })]}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("project my-api").tagName).toBe("STRONG");
	});

	it("flags denials with a badge and shows the reason", () => {
		render(
			<ActivityFeed
				rows={[
					row({
						action: "export_activity",
						resourceType: "activity",
						decision: false,
						reason: "Not an admin",
					}),
				]}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("Denied")).toBeInTheDocument();
		expect(screen.getByText("an activity-log export").tagName).toBe("STRONG");
		// The deny reason moves to the row's tooltip (no second line).
		expect(screen.getByTitle("Not an admin")).toBeInTheDocument();
	});

	it("shows the avatar image when present, else initials", () => {
		const { container, rerender } = render(
			<ActivityFeed
				rows={[row({ actorImage: "https://example.com/a.png" })]}
				ctx={ctx}
			/>,
		);
		expect(container.querySelector("img")).toBeInTheDocument();

		rerender(<ActivityFeed rows={[row({ actorImage: null })]} ctx={ctx} />);
		expect(container.querySelector("img")).toBeNull();
		expect(screen.getByText("BO")).toBeInTheDocument(); // initials of "borislav"
	});

	it("groups rows into month sections", () => {
		render(
			<ActivityFeed
				rows={[
					row({ id: "2", ts: "2026-06-20T10:00:00.000Z" }),
					row({ id: "1", ts: "2026-05-30T10:00:00.000Z" }),
				]}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("June 2026")).toBeInTheDocument();
		expect(screen.getByText("May 2026")).toBeInTheDocument();
	});

	it("renders an empty state when there are no rows", () => {
		render(<ActivityFeed rows={[]} ctx={ctx} />);
		expect(screen.getByText(/no activity matches these filters/i)).toBeInTheDocument();
	});

	it("shows 'Load more' only when more pages exist and fires the callback", async () => {
		const onLoadMore = vi.fn();
		const { rerender } = render(
			<ActivityFeed rows={[row()]} ctx={ctx} onLoadMore={onLoadMore} hasMore={false} />,
		);
		expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();

		rerender(
			<ActivityFeed rows={[row()]} ctx={ctx} onLoadMore={onLoadMore} hasMore />,
		);
		const button = screen.getByRole("button", { name: /load more/i });
		await userEvent.click(button);
		expect(onLoadMore).toHaveBeenCalledTimes(1);
	});

	it("disables 'Load more' while a page is loading", () => {
		render(
			<ActivityFeed
				rows={[row()]}
				ctx={ctx}
				onLoadMore={vi.fn()}
				hasMore
				loadingMore
			/>,
		);
		expect(screen.getByRole("button", { name: /load more/i })).toBeDisabled();
	});
});
