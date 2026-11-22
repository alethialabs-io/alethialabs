// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The subject's privacy emails (lib/privacy/emails.ts) and the privacy sweep (lib/privacy/sweep.ts).
//
// Pinned: every privacy email goes through the suppression guard; the deletion emails carry the
// cancel link only when there is a token to carry, and the export email the download link; the
// links point at the deployment's own origin; the sweep runs both halves and reports both.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, sweepErasures, sweepExports } = vi.hoisted(() => ({
	send: vi.fn(),
	sweepErasures: vi.fn(),
	sweepExports: vi.fn(),
}));
vi.mock("@/lib/email/guard", () => ({ sendGuardedEmail: (...a: unknown[]) => send(...a) }));
vi.mock("@repo/email/config", () => ({
	getEmailConfig: () => ({ from: { general: "hello@example.io" }, configSet: { general: "general" } }),
}));
vi.mock("@/lib/config/auth", () => ({ getAuthConfig: () => ({ baseURL: "https://console.example.io" }) }));
vi.mock("@/emails/account-deletion", async (importActual) => {
	const actual = await importActual<typeof import("@/emails/account-deletion")>();
	return { subject: actual.subject, AccountDeletionEmail: (props: unknown) => ({ props }) };
});
vi.mock("@/emails/data-export-ready", () => ({
	subject: "Your Alethia data export is ready",
	DataExportReadyEmail: (props: unknown) => ({ props }),
}));
vi.mock("@/lib/privacy/self-deletion", () => ({ sweepScheduledErasures: (...a: unknown[]) => sweepErasures(...a) }));
vi.mock("@/lib/privacy/export", () => ({ sweepExpiredExports: (...a: unknown[]) => sweepExports(...a) }));

import {
	deletionCancelUrl,
	exportDownloadUrl,
	sendAccountDeletionEmail,
	sendDataExportReadyEmail,
} from "@/lib/privacy/emails";
import { runPrivacySweep } from "@/lib/privacy/sweep";

beforeEach(() => {
	send.mockReset();
	send.mockResolvedValue(undefined);
});

describe("privacy emails", () => {
	it("builds links on the deployment's own origin", () => {
		expect(deletionCancelUrl("tok")).toBe("https://console.example.io/account/deletion?t=tok");
		expect(exportDownloadUrl("DSR-0000000E", "tok")).toBe(
			"https://console.example.io/api/privacy/export/DSR-0000000E?t=tok",
		);
	});

	it("sends the scheduled-deletion email with its cancel link, dated in UTC", async () => {
		await sendAccountDeletionEmail({
			to: "ada@example.io",
			stage: "scheduled",
			reference: "DSR-0000000E",
			at: new Date("2026-12-05T23:30:00.000Z"),
			cancelToken: "tok",
		});
		const args = send.mock.calls[0]?.[0];
		expect(args.to).toBe("ada@example.io");
		expect(args.subject).toBe("Your Alethia account will be deleted on 5 Dec 2026");
		expect(args.react.props.cancelUrl).toBe("https://console.example.io/account/deletion?t=tok");
	});

	it("sends a reminder with no cancel link when there is no token", async () => {
		await sendAccountDeletionEmail({ to: "a@example.io", stage: "reminder", reference: "DSR-0000000E", at: new Date() });
		expect(send.mock.calls[0]?.[0].react.props.cancelUrl).toBeUndefined();
	});

	it("sends the export link", async () => {
		await sendDataExportReadyEmail({
			to: "ada@example.io",
			reference: "DSR-0000000E",
			token: "tok",
			expiresAt: new Date("2026-11-24T10:00:00.000Z"),
		});
		expect(send.mock.calls[0]?.[0].react.props.downloadUrl).toContain("/api/privacy/export/DSR-0000000E?t=tok");
	});
});

describe("runPrivacySweep", () => {
	it("runs the erasure half and the export half, and reports both", async () => {
		sweepErasures.mockResolvedValue({ reminded: 1, erased: 2, refused: 0, failed: 0 });
		sweepExports.mockResolvedValue({ deleted: 3 });
		const now = new Date("2026-11-21T10:00:00.000Z");
		expect(await runPrivacySweep(now)).toEqual({ reminded: 1, erased: 2, refused: 0, failed: 0, exportsExpired: 3 });
		expect(sweepErasures).toHaveBeenCalledWith(now);
		expect(sweepExports).toHaveBeenCalledWith(now);
	});
});
