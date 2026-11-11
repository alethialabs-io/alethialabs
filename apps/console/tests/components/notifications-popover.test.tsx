// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ORPCError } from "@orpc/client";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsPopover } from "@/components/shell/notifications-popover";
import { useNotificationsStore } from "@/lib/stores/use-notifications-store";
import { makeJob } from "../fixtures/jobs";

const { useRecentJobsQuery, useSupportNotifications } = vi.hoisted(() => ({
	useRecentJobsQuery: vi.fn(),
	useSupportNotifications: vi.fn(),
}));
vi.mock("@/lib/query/use-jobs-query", () => ({
	useRecentJobsQuery: () => useRecentJobsQuery(),
}));
// The popover composes support notifications too; default it to an empty feed so these
// job-focused tests stay isolated (support wiring is covered in its own hook test).
vi.mock("@/hooks/use-support-notifications", () => ({
	useSupportNotifications: () => useSupportNotifications(),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ org: "acme" }) }));

const EMPTY_SUPPORT = {
	notifications: [],
	unreadCount: 0,
	markAsRead: vi.fn(),
	markAllRead: vi.fn(),
	feed: { status: "ready", retry: vi.fn() },
};

beforeEach(() => {
	localStorage.clear();
	useNotificationsStore.setState({ readJobIds: [], readSupportCaseIds: [] });
	useRecentJobsQuery.mockReset();
	useSupportNotifications.mockReset();
	useSupportNotifications.mockReturnValue(EMPTY_SUPPORT);
});

describe("NotificationsPopover", () => {
	it("renders a row per notifiable job and filters internal types", async () => {
		useRecentJobsQuery.mockReturnValue({
			data: [
				makeJob({ id: "j1", job_type: "DEPLOY", status: "SUCCESS" }),
				makeJob({ id: "j2", job_type: "DETECT_DRIFT", status: "SUCCESS" }),
			],
		});
		render(<NotificationsPopover />);
		await userEvent.click(screen.getByRole("button", { name: "Notifications" }));

		expect(screen.getByText(/Deploy — success/i)).toBeInTheDocument();
		expect(screen.queryByText(/Connection Test/i)).not.toBeInTheDocument();
	});

	it("shows an unread count for unacknowledged terminal jobs", async () => {
		useRecentJobsQuery.mockReturnValue({
			data: [makeJob({ id: "j1", status: "FAILED" })],
		});
		render(<NotificationsPopover />);
		await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
		expect(screen.getByText("1 unread")).toBeInTheDocument();
	});

	it("does not count in-flight jobs as unread", async () => {
		useRecentJobsQuery.mockReturnValue({
			data: [makeJob({ id: "j1", status: "PROCESSING" })],
		});
		render(<NotificationsPopover />);
		await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
		expect(screen.getByText("All caught up")).toBeInTheDocument();
	});

	it("links org-scoped and marks the job read on click", async () => {
		useRecentJobsQuery.mockReturnValue({
			data: [makeJob({ id: "j1", status: "SUCCESS" })],
		});
		render(<NotificationsPopover />);
		await userEvent.click(screen.getByRole("button", { name: "Notifications" }));

		const link = screen.getByRole("link", { name: /Deploy/i });
		expect(link).toHaveAttribute("href", "/acme/~/jobs/j1");

		await userEvent.click(link);
		expect(useNotificationsStore.getState().readJobIds).toContain("j1");
	});

	it("clears the unread count when Mark all read is pressed", async () => {
		useRecentJobsQuery.mockReturnValue({
			data: [makeJob({ id: "j1", status: "SUCCESS" })],
		});
		render(<NotificationsPopover />);
		await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
		await userEvent.click(screen.getByText("Mark all read"));
		expect(screen.getByText("All caught up")).toBeInTheDocument();
	});

	it("renders the empty state when there are no notifiable jobs", async () => {
		useRecentJobsQuery.mockReturnValue({ data: [] });
		render(<NotificationsPopover />);
		await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
		expect(screen.getByText("You're all caught up")).toBeInTheDocument();
	});
});

// Pending, empty, error and forbidden are four different renders (#6114). The bell used to read
// `data ?? []`, so a job feed that FAILED or was REFUSED said "You're all caught up!" — a claim about
// the viewer's jobs that nothing had checked.
describe("NotificationsPopover — the four read states", () => {
	/** Opens the bell. */
	async function open(): Promise<void> {
		render(<NotificationsPopover />);
		await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
	}

	it("a failed job feed renders an error with a retry, never the empty state", async () => {
		const refetch = vi.fn(async () => undefined);
		useRecentJobsQuery.mockReturnValue({ data: undefined, isError: true, error: new Error("boom"), refetch });
		await open();
		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load notifications");
		expect(screen.getByRole("alert")).toHaveTextContent("Your job activity didn't load.");
		expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("a REFUSED job feed says so, offers no retry, and still shows the support rows' empty answer", async () => {
		useRecentJobsQuery.mockReturnValue({
			data: undefined,
			isError: true,
			error: new ORPCError("FORBIDDEN", { defined: true }),
		});
		await open();
		expect(screen.getByText(/your role can't view jobs/i)).toHaveAttribute("data-state", "forbidden");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
		// Support answered with nothing, so that half IS caught up.
		expect(screen.getByText("You're all caught up")).toBeInTheDocument();
	});

	it("both feeds refused: no empty state claims anything", async () => {
		const refused = new ORPCError("FORBIDDEN", { defined: true });
		useRecentJobsQuery.mockReturnValue({ data: undefined, isError: true, error: refused });
		useSupportNotifications.mockReturnValue({ ...EMPTY_SUPPORT, feed: { status: "forbidden", retry: vi.fn() } });
		await open();
		expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
		expect(screen.getAllByText(/aren't shown|isn't shown/)).toHaveLength(2);
	});

	it("an unanswered feed renders the pending skeleton, not the empty state", async () => {
		useRecentJobsQuery.mockReturnValue({ data: undefined, isError: false });
		await open();
		expect(screen.getByRole("status", { name: "Loading notifications" })).toBeInTheDocument();
		expect(screen.getByText("Loading…")).toBeInTheDocument();
		expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
	});

	it("a failed refetch that still holds rows shows the rows, not an error", async () => {
		useRecentJobsQuery.mockReturnValue({
			data: [makeJob({ id: "j1", job_type: "DEPLOY", status: "SUCCESS" })],
			isError: true,
			error: new Error("background refetch failed"),
		});
		await open();
		expect(screen.getByText(/Deploy — success/i)).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
