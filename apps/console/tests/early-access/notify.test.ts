// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ reads: [] as unknown[][] }));
vi.mock("@/lib/db", () => {
	/** Any select chain ends in the next queued result, wherever it stops. */
	const chain = (): unknown =>
		new Proxy(
			{},
			{
				get: (_t, prop) => {
					if (prop === "then") {
						const rows = db.reads.shift() ?? [];
						return (resolve: (v: unknown) => void) => resolve(rows);
					}
					return () => chain();
				},
			},
		);
	return { getServiceDb: () => ({ select: () => chain() }) };
});

const alerts = vi.hoisted(() => ({ alertOperator: vi.fn(async (_alert: { summary: string }) => true) }));
vi.mock("@/lib/billing/operator-alert", () => alerts);

const mail = vi.hoisted(() => ({
	sendEmail: vi.fn(async (_args: { to: string; subject: string }) => undefined),
	sendGuardedEmail: vi.fn(async (_args: { to: string; subject: string }) => undefined),
}));
vi.mock("@repo/email/send", () => ({ sendEmail: mail.sendEmail }));
vi.mock("@/lib/email/guard", () => ({ sendGuardedEmail: mail.sendGuardedEmail }));
vi.mock("@repo/email/config", () => ({
	getEmailConfig: () => ({ from: { general: "Alethia <hello@alethia.test>" }, configSet: { general: "general" } }),
}));

import {
	earlyAccessPlanName,
	notifyEarlyAccessRequest,
	sendEarlyAccessGrantedEmail,
} from "@/lib/early-access/notify";

const filed = {
	requestId: "req-1",
	organizationId: "org-1",
	country: "DE",
	vatId: "DE123456789",
	plan: "team" as const,
	vies: "valid" as const,
	viesName: "ACME GMBH",
	requesterUserId: "user-1",
	note: null,
};

beforeEach(() => {
	db.reads = [];
	alerts.alertOperator.mockClear();
	mail.sendEmail.mockReset();
	mail.sendGuardedEmail.mockReset();
});

describe("notifyEarlyAccessRequest", () => {
	it("alerts the operator and emails the legal inbox, both naming org, country, VAT number and Art. 97a", async () => {
		db.reads = [[{ name: "Acme GmbH", slug: "acme" }], [{ email: "billing@acme.example" }]];
		const r = await notifyEarlyAccessRequest(filed);
		expect(r).toEqual({ alerted: true, emailed: true });
		const alert = alerts.alertOperator.mock.calls[0]?.[0];
		expect(alert?.summary).toContain("Acme GmbH (DE)");
		expect(alert?.summary).toContain("DE123456789");
		expect(alert?.summary).toContain("Art. 97a must be filed when this client commits to pay.");
		const email = mail.sendEmail.mock.calls[0]?.[0];
		expect(email).toMatchObject({ to: "legal@alethialabs.io", subject: "Early Access request: Acme GmbH (DE, DE123456789)" });
	});

	it("never throws when the email fails; it reports it", async () => {
		db.reads = [[{ name: "Acme GmbH", slug: "acme" }], []];
		mail.sendEmail.mockRejectedValueOnce(new Error("ses down"));
		await expect(notifyEarlyAccessRequest(filed)).resolves.toEqual({ alerted: true, emailed: false });
	});
});

describe("sendEarlyAccessGrantedEmail", () => {
	it("writes to the org's owner through the suppression guard", async () => {
		db.reads = [[{ email: "owner@acme.example" }], [{ name: "Acme GmbH", slug: "acme" }]];
		const sent = await sendEarlyAccessGrantedEmail({
			orgId: "org-1",
			plan: "ai_plus",
			periodEnd: new Date("2027-02-21T00:00:00Z"),
		});
		expect(sent).toBe(true);
		expect(mail.sendGuardedEmail.mock.calls[0]?.[0]).toMatchObject({
			to: "owner@acme.example",
			subject: `Complimentary Early Access to Alethia ${earlyAccessPlanName("ai_plus")}`,
		});
	});

	it("sends nothing when the org has no owner", async () => {
		db.reads = [[]];
		expect(await sendEarlyAccessGrantedEmail({ orgId: "org-1", plan: "team", periodEnd: null })).toBe(false);
		expect(mail.sendGuardedEmail).not.toHaveBeenCalled();
	});
});
