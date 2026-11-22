// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CONTACT_METADATA, ContactPage } from "@/components/contact/contact-page";
import { parseContactTopic } from "@/lib/validations/contact.schema";

export const metadata = CONTACT_METADATA;

/**
 * The old "Enterprise trial" address, kept working for every link already out
 * there. It is the contact page with the topic preset to an Enterprise trial;
 * an explicit `?topic=` still wins.
 */
export default async function ContactEnterpriseRoute({
	searchParams,
}: {
	searchParams: Promise<{ topic?: string | string[] }>;
}) {
	const { topic } = await searchParams;
	return <ContactPage topic={parseContactTopic(topic, "enterprise")} />;
}
