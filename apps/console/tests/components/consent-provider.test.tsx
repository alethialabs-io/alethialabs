// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CONSENT_COOKIE, writeConsent } from "@repo/privacy/consent";
import { ConsentProvider } from "@repo/privacy/consent-provider";
import { PrivacySettingsButton } from "@repo/privacy/privacy-settings-button";

describe("ConsentProvider", () => {
	beforeEach(() => {
		document.cookie = `${CONSENT_COOKIE}=; Path=/; Max-Age=0`;
	});

	it("pins the first-visit notice to the right and uses the configured notice URL", async () => {
		render(
			<ConsentProvider cookieNoticeHref="https://alethialabs.io/cookies">
				<div>Product</div>
			</ConsentProvider>,
		);

		const notice = await screen.findByRole("region", { name: "Privacy choices" });
		expect(notice).toHaveClass("sm:left-auto");
		expect(notice).toHaveClass("sm:w-[28rem]");
		expect(screen.getByRole("link", { name: "Cookie notice" })).toHaveAttribute(
			"href",
			"https://alethialabs.io/cookies",
		);
	});

	// The notice used to be `inset-x-4` with only an `sm:` escape, so below 640px it
	// spanned the viewport and covered the console's sidebar profile.
	it("caps the notice width so it cannot span the viewport on a small screen", async () => {
		render(
			<ConsentProvider>
				<div>Product</div>
			</ConsentProvider>,
		);

		const notice = await screen.findByRole("region", { name: "Privacy choices" });
		expect(notice).toHaveClass("max-w-[28rem]");
		expect(notice).toHaveClass("ml-auto");
	});

	// The floating launcher was removed outright — it sat on top of the sidebar
	// profile in the console and could not be placed anywhere that suited both apps.
	it("never renders a floating launcher, in either app", async () => {
		writeConsent({ analytics: false, replay: false });

		render(
			<ConsentProvider>
				<div>Product</div>
			</ConsentProvider>,
		);

		await waitFor(() => {
			expect(
				screen.queryByRole("region", { name: "Privacy choices" }),
			).not.toBeInTheDocument();
		});
		expect(
			screen.queryByRole("button", { name: "Privacy choices" }),
		).not.toBeInTheDocument();
	});

	// Removing the launcher must not remove the ability to withdraw consent.
	it("reopens preferences from an in-page control once a decision exists", async () => {
		writeConsent({ analytics: false, replay: false });

		render(
			<ConsentProvider>
				<PrivacySettingsButton />
			</ConsentProvider>,
		);

		const trigger = await screen.findByRole("button", { name: "Privacy settings" });
		fireEvent.click(trigger);

		expect(
			await screen.findByRole("dialog", { name: "Choose what Alethia may collect." }),
		).toBeInTheDocument();
	});

	it("offers no settings control before a decision has been made", async () => {
		render(
			<ConsentProvider>
				<PrivacySettingsButton />
			</ConsentProvider>,
		);

		// The first-visit notice is on screen and already offers the same dialog.
		await screen.findByRole("region", { name: "Privacy choices" });
		expect(
			screen.queryByRole("button", { name: "Privacy settings" }),
		).not.toBeInTheDocument();
	});
});
