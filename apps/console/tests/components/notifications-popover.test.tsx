// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsPopover } from "@/components/shell/notifications-popover";
import { useNotificationsStore } from "@/lib/stores/use-notifications-store";
import { makeJob } from "../fixtures/jobs";

const { useJobsQuery, useSupportNotifications } = vi.hoisted(() => ({
	useJobsQuery: vi.fn(),
	useSupportNotifications: vi.fn(),
}));
vi.mock("@/lib/query/use-jobs-query", () => ({
	useJobsQuery: () => useJobsQuery(),
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
};

beforeEach(() => {
	localStorage.clear();
	useNotificationsStore.setState({ readJobIds: [], readSupportCaseIds: [] });
	useJobsQuery.mockReset();
	useSupportNotifications.mockReset();
	useSupportNotifications.mockReturnValue(EMPTY_SUPPORT);
});

describe("NotificationsPopover", () => {
	it("renders a row per notifiable job and filters internal types", async () => {
		useJobsQuery.mockReturnValue({
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
		useJobsQuery.mockReturnValue({
			data: [makeJob({ id: "j1", status: "FAILED" })],
		});
		render(<NotificationsPopover />);
		await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
		expect(screen.getByText("1 unread")).toBeInTheDocument();
	});

	it("does not count in-flight jobs as unread", async () => {
		useJobsQuery.mockReturnValue({
			data: [makeJob({ id: "j1", status: "PROCESSING" })],
		});
		render(<NotificationsPopover />);
		await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
		expect(screen.getByText("All caught up")).toBeInTheDocument();
	});

	it("links org-scoped and marks the job read on click", async () => {
		useJobsQuery.mockReturnValue({
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
		useJobsQuery.mockReturnValue({
			data: [makeJob({ id: "j1", status: "SUCCESS" })],
		});
		render(<NotificationsPopover />);
		await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
		await userEvent.click(screen.getByText("Mark all read"));
		expect(screen.getByText("All caught up")).toBeInTheDocument();
	});

	it("renders the empty state when there are no notifiable jobs", async () => {
		useJobsQuery.mockReturnValue({ data: [] });
		render(<NotificationsPopover />);
		await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
		expect(screen.getByText(/all caught up!/i)).toBeInTheDocument();
	});
});
