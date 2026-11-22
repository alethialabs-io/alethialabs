// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CONTACT_METADATA, ContactPage } from "@/components/contact/contact-page";
import { parseContactTopic } from "@/lib/validations/contact.schema";

export const metadata = CONTACT_METADATA;

/**
 * The old "Talk to sales" address, kept working for every link already out
 * there. It is the contact page with the topic preset to a product demo; an
 * explicit `?topic=` still wins.
 */
export default async function ContactSalesRoute({
	searchParams,
}: {
	searchParams: Promise<{ topic?: string | string[] }>;
}) {
	const { topic } = await searchParams;
	return <ContactPage topic={parseContactTopic(topic, "demo")} />;
}
