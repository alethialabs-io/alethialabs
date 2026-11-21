// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ONE form shape of an alert channel, shared by the add sheet (channel-sheet.tsx) and the
// inline editor (channels-panel.tsx). Both are react-hook-form over the same fields and the same
// destination rules, said inline under the field they are about. The two differ in exactly one
// rule, stated here rather than in either file: creating a channel needs a destination, and
// editing one does not, because a blank credential on an edit keeps the stored one.

import type { Path } from "react-hook-form";
import { z } from "zod";
import type { ChannelDTO } from "@/app/server/actions/alerts";
import { CHANNEL_TYPE_META } from "@/components/alerts/channel-meta";
import { alertChannelType } from "@/lib/db/schema/enums";
import type { ChannelInput } from "@/lib/validations/alerts";

/** The fields of an alert channel form, before the destination rules. */
const channelFields = z.object({
	type: z.enum(alertChannelType.enumValues),
	name: z.string().trim().min(1, "Name your channel").max(120),
	recipients: z.array(z.string().email()),
	url: z.string(),
	signingSecret: z.string(),
	routingKey: z.string(),
});

/** The values of an alert channel form. */
export type ChannelFormValues = z.infer<typeof channelFields>;

/**
 * The destination rules. With `required`, every transport needs its destination (a recipient, a
 * routing key or a URL); without it, a blank credential means "keep the stored one". A URL that is
 * given must parse either way, and an email channel always needs at least one recipient — the
 * recipients are not a secret, so an edit replaces them rather than keeping them.
 */
function destinationRules(required: boolean) {
	return (v: ChannelFormValues, ctx: z.RefinementCtx) => {
		const cred = CHANNEL_TYPE_META[v.type].credential;
		if (cred === "email") {
			if (v.recipients.length === 0)
				ctx.addIssue({
					code: "custom",
					path: ["recipients"],
					message: "Add at least one recipient.",
				});
			return;
		}
		if (cred === "routingKey") {
			if (required && !v.routingKey.trim())
				ctx.addIssue({
					code: "custom",
					path: ["routingKey"],
					message: "Paste the integration routing key.",
				});
			return;
		}
		if (!v.url.trim()) {
			if (required)
				ctx.addIssue({
					code: "custom",
					path: ["url"],
					message: "A destination URL is required.",
				});
			return;
		}
		try {
			new URL(v.url.trim());
		} catch {
			ctx.addIssue({ code: "custom", path: ["url"], message: "Enter a valid URL." });
		}
	};
}

/** Validation for adding a channel: the destination is required. */
export const channelCreateSchema = channelFields.superRefine(destinationRules(true));

/** Validation for editing a channel: a blank credential keeps the stored one. */
export const channelEditSchema = channelFields.superRefine(destinationRules(false));

/** The add sheet's starting values. */
export const NEW_CHANNEL_FORM: ChannelFormValues = {
	type: "slack",
	name: CHANNEL_TYPE_META.slack.name,
	recipients: [],
	url: "",
	signingSecret: "",
	routingKey: "",
};

/** The form field a server validation path is about (`secret.url` → `url`), or null. */
export function channelFieldOf(path: string): Path<ChannelFormValues> | null {
	const [head, sub] = path.split(".");
	if (head === "name" || head === "recipients") return head;
	if (head === "secret" && (sub === "url" || sub === "signingSecret" || sub === "routingKey"))
		return sub;
	return null;
}

/**
 * The edit form's values for a saved channel. The credential fields start blank: the stored
 * secret never leaves the server, and blank means "keep it".
 */
export function channelFormFrom(c: ChannelDTO): ChannelFormValues {
	return {
		type: c.type,
		name: c.name,
		recipients: c.recipients,
		url: "",
		signingSecret: "",
		routingKey: "",
	};
}

/** The server action's channel input for validated form values. */
export function toChannelInput(values: ChannelFormValues, enabled: boolean): ChannelInput {
	const cred = CHANNEL_TYPE_META[values.type].credential;
	return {
		type: values.type,
		name: values.name.trim(),
		enabled,
		recipients: cred === "email" ? values.recipients : undefined,
		secret:
			cred === "url"
				? {
						url: values.url.trim() || undefined,
						signingSecret:
							values.type === "webhook" ? values.signingSecret.trim() || undefined : undefined,
					}
				: cred === "routingKey"
					? { routingKey: values.routingKey.trim() || undefined }
					: undefined,
	};
}
