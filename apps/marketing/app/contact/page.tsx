// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CONTACT_METADATA, ContactPage } from "@/components/contact/contact-page";
import { parseContactTopic } from "@/lib/validations/contact.schema";

export const metadata = CONTACT_METADATA;

/**
 * The one contact page. `?topic=demo|enterprise|services|other` presets the
 * topic field; anything else opens on a product demo. This used to redirect to
 * `/contact/sales`, so every "talk to us" path landed on a sales pitch.
 */
export default async function ContactRoute({
	searchParams,
}: {
	searchParams: Promise<{ topic?: string | string[] }>;
}) {
	const { topic } = await searchParams;
	return <ContactPage topic={parseContactTopic(topic)} />;
}
