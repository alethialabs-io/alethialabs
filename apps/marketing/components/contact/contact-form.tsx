"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useState, useTransition } from "react";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@repo/ui/button";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { Textarea } from "@repo/ui/textarea";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { CountrySelect } from "@repo/ui/country-select";
import { isPhoneCountry, PhoneInput } from "@repo/ui/phone-input";
import { submitContactLead } from "@/app/server/actions/contact";
import { disp, Icon, mono } from "@repo/brand/site-primitives";
import {
	CONTACT_TOPIC_LABELS,
	CONTACT_TOPICS,
	contactLeadSchema,
	DEFAULT_CONTACT_TOPIC,
	DEFAULT_COUNTRY,
	INTERESTS,
	SALES_MAIL,
	SIZES,
	topicAsksInterest,
	topicAsksSize,
	type ContactLeadInput,
	type ContactTopic,
} from "@/lib/validations/contact.schema";

/** The submit button's words for each topic, when the caller does not pass its own. */
const SUBMIT_LABELS: Record<ContactTopic, string> = {
	demo: "Request a demo",
	enterprise: "Request your trial",
	services: "Send project details",
	other: "Send message",
};

/** The message box's prompt for each topic — what a useful first message contains. */
const MESSAGE_PLACEHOLDERS: Record<ContactTopic, string> = {
	demo: "Your stack — which clouds, how many clusters, how many teams.",
	enterprise: "Your company needs — teams, identity provider, where your data has to live.",
	services: "What you are running, and what you need built, audited or run.",
	other: "What can we help with?",
};

/** Field label, with an optional "optional" tag mirroring the design. */
function FieldLabel({
	children,
	optional,
}: {
	children: React.ReactNode;
	optional?: boolean;
}) {
	return (
		<span style={{ display: "flex", alignItems: "center" }}>
			<span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-secondary)" }}>
				{children}
			</span>
			{optional && (
				<span
					style={{
						...mono,
						fontSize: 10,
						letterSpacing: "0.04em",
						textTransform: "uppercase",
						color: "var(--text-disabled)",
						marginLeft: 8,
					}}
				>
					optional
				</span>
			)}
		</span>
	);
}

/** Props for {@link ContactForm}. Every field is optional; the bare form opens on a product demo. */
export interface ContactFormProps {
	/** The topic the form opens on. */
	topic?: ContactTopic;
	/**
	 * The preset the enterprise page's embedded form still passes (`type="enterprise"`).
	 * It names a topic in the old two-value vocabulary and maps onto `topic`; `topic`
	 * wins when both are given. Kept only because that page belongs to another change —
	 * switch it to `topic="enterprise"` and delete this prop.
	 */
	type?: "sales" | "enterprise";
	/** Overrides the topic's own submit label. */
	submitLabel?: string;
	/**
	 * Show the topic picker. The contact page does; a form embedded in a page that is
	 * already about one topic (the enterprise trial) does not, and posts its preset.
	 */
	showTopic?: boolean;
	/** The ISO alpha-2 country the country and phone fields open on. Defaults to {@link DEFAULT_COUNTRY}. */
	defaultCountry?: string;
}

/** The topic a legacy `type` preset names: the old "sales" page was the demo request. */
function topicFromType(type: "sales" | "enterprise" | undefined): ContactTopic | undefined {
	if (type === "enterprise") return "enterprise";
	if (type === "sales") return "demo";
	return undefined;
}

/**
 * The one contact form on the site. Wires react-hook-form + the shared zod
 * schema into our UI kit, posts to the public `submitContactLead` server action,
 * and swaps to a success card on success. The topic decides which of the
 * company-size and product-interest fields are asked, and what the button says.
 */
export function ContactForm({ topic, type, submitLabel, showTopic = false, defaultCountry }: ContactFormProps) {
	// The visitor's country when the phone field supports it, else the schema default.
	const openingCountry = defaultCountry && isPhoneCountry(defaultCountry) ? defaultCountry : DEFAULT_COUNTRY;
	const [sent, setSent] = useState(false);
	const [pending, startTransition] = useTransition();
	const initialTopic = topic ?? topicFromType(type) ?? DEFAULT_CONTACT_TOPIC;

	const form = useForm<ContactLeadInput>({
		resolver: zodResolver(contactLeadSchema),
		mode: "onChange",
		defaultValues: {
			topic: initialTopic,
			email: "",
			name: "",
			country: openingCountry,
			phone: "",
			website: "",
			companySize: undefined,
			interest: undefined,
			message: "",
			consent: false,
			honeypot: "",
		},
	});

	const currentTopic = useWatch({ control: form.control, name: "topic" });
	const asksSize = topicAsksSize(currentTopic);
	const asksInterest = topicAsksInterest(currentTopic);

	/**
	 * Submit via the server action; show success card or toast the error. A field
	 * the chosen topic does not ask is dropped first, so switching from "Product
	 * demo" to "Something else" does not mail a hidden company size along with it.
	 */
	function onSubmit(values: ContactLeadInput) {
		const lead: ContactLeadInput = {
			...values,
			companySize: topicAsksSize(values.topic) ? values.companySize : undefined,
			interest: topicAsksInterest(values.topic) ? values.interest : undefined,
		};
		startTransition(async () => {
			try {
				await submitContactLead(lead);
				setSent(true);
			} catch (err) {
				toast.error(
					err instanceof Error
						? err.message
						: "Something went wrong — please try again.",
				);
			}
		});
	}

	const firstName = form.getValues("name").trim().split(" ")[0];

	if (sent) {
		return (
			<div
				style={{
					border: "1px solid var(--border)",
					borderRadius: "var(--radius-xl)",
					background: "var(--surface)",
					boxShadow: "var(--shadow-md)",
					padding: "48px 40px",
					textAlign: "center",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
				}}
			>
				<span
					style={{
						display: "grid",
						placeItems: "center",
						width: 52,
						height: 52,
						borderRadius: "var(--radius-full)",
						border: "1px solid var(--border-strong)",
						background: "var(--surface-muted)",
						color: "var(--text-primary)",
						marginBottom: 22,
					}}
				>
					<Icon k="check" size={24} sw={2.2} />
				</span>
				<h3
					style={{
						...disp,
						fontSize: 24,
						fontWeight: 600,
						letterSpacing: "-0.03em",
						margin: "0 0 10px",
						color: "var(--text-primary)",
					}}
				>
					Thanks{firstName ? `, ${firstName}` : ""}.
				</h3>
				<p
					style={{
						fontSize: 14.5,
						color: "var(--text-tertiary)",
						margin: "0 0 26px",
						maxWidth: 340,
						lineHeight: 1.6,
					}}
				>
					Your message is in. We reply by email, to the address you gave.
				</p>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 9,
						...mono,
						fontSize: 11.5,
						color: "var(--text-disabled)",
					}}
				>
					<Icon k="lock" size={13} sw={1.7} />
					Prefer email?{" "}
					<a href={`mailto:${SALES_MAIL}`} style={{ color: "var(--text-secondary)" }}>
						{SALES_MAIL}
					</a>
				</div>
			</div>
		);
	}

	return (
		<Form {...form}>
			<form
				onSubmit={form.handleSubmit(onSubmit)}
				style={{
					border: "1px solid var(--border)",
					borderRadius: "var(--radius-xl)",
					background: "var(--surface)",
					boxShadow: "var(--shadow-md)",
					overflow: "hidden",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 10,
						padding: "16px 24px",
						borderBottom: "1px solid var(--border)",
						background: "var(--surface-muted)",
					}}
				>
					<Icon k="building" size={15} />
					<span style={{ ...disp, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
						Tell us about your team
					</span>
					<span style={{ ...mono, fontSize: 10, color: "var(--text-tertiary)", marginLeft: "auto" }}>
						2 min
					</span>
				</div>

				<div style={{ padding: "24px 24px 26px", display: "flex", flexDirection: "column", gap: 16 }}>
					{/* Honeypot — hidden from humans; bots that fill it are dropped server-side. */}
					<input
						{...form.register("honeypot")}
						type="text"
						tabIndex={-1}
						autoComplete="off"
						aria-hidden="true"
						style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
					/>

					{showTopic ? (
						<FormField
							control={form.control}
							name="topic"
							render={({ field }) => (
								<FormItem>
									{/* Native radios in a fieldset: a submitted form input, so a
									    radiogroup and not SegmentedControl's toggle buttons — and
									    four options, which is past what that control is for. */}
									<fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
										<legend style={{ padding: 0, marginBottom: 8 }}>
											<FieldLabel>What is this about?</FieldLabel>
										</legend>
										<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
											{CONTACT_TOPICS.map((option) => {
												const checked = field.value === option;
												return (
													<label
														key={option}
														className="flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] border px-3 py-2.5 transition-colors"
														style={{
															borderColor: checked ? "var(--border-strong)" : "var(--border)",
															background: checked ? "var(--surface-muted)" : "transparent",
															fontSize: 13,
															color: checked ? "var(--text-primary)" : "var(--text-secondary)",
														}}
													>
														<input
															type="radio"
															name={field.name}
															value={option}
															checked={checked}
															onChange={() => field.onChange(option)}
															onBlur={field.onBlur}
															style={{ accentColor: "var(--text-primary)", margin: 0, flexShrink: 0 }}
														/>
														{CONTACT_TOPIC_LABELS[option]}
													</label>
												);
											})}
										</div>
									</fieldset>
									<FormMessage className="text-[11px]" />
								</FormItem>
							)}
						/>
					) : null}

					<FormField
						control={form.control}
						name="email"
						render={({ field }) => (
							<FormItem>
								<FieldLabel>Company email</FieldLabel>
								<FormControl>
									<Input
										type="email"
										placeholder="you@company.com"
										autoComplete="email"
										{...field}
									/>
								</FormControl>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="name"
						render={({ field }) => (
							<FormItem>
								<FieldLabel>Your name</FieldLabel>
								<FormControl>
									<Input
										type="text"
										placeholder="Jordan Rivera"
										autoComplete="name"
										{...field}
									/>
								</FormControl>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="country"
						render={({ field, fieldState }) => (
							<FormItem>
								<FieldLabel>Country</FieldLabel>
								<FormControl>
									<CountrySelect
										value={field.value}
										onChange={field.onChange}
										invalid={!!fieldState.error}
									/>
								</FormControl>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="phone"
						render={({ field }) => (
							<FormItem>
								<FieldLabel optional>Phone number</FieldLabel>
								<FormControl>
									<PhoneInput
										value={field.value}
										onChange={field.onChange}
										onBlur={field.onBlur}
										defaultCountry={openingCountry}
										autoComplete="tel"
										placeholder="Enter phone number"
									/>
								</FormControl>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="website"
						render={({ field }) => (
							<FormItem>
								<FieldLabel optional>Company website</FieldLabel>
								<FormControl>
									<Input
										type="url"
										placeholder="https://company.com"
										style={mono}
										{...field}
									/>
								</FormControl>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					{asksSize || asksInterest ? (
						<div className={asksSize && asksInterest ? "grid grid-cols-1 gap-4 sm:grid-cols-2" : "grid grid-cols-1 gap-4"}>
							{asksSize ? (
								<FormField
									control={form.control}
									name="companySize"
									render={({ field }) => (
										<FormItem>
											<FieldLabel>Company size</FieldLabel>
											<Select value={field.value} onValueChange={field.onChange}>
												<FormControl>
													<SelectTrigger className="w-full">
														<SelectValue placeholder="Select a value" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													{SIZES.map((s) => (
														<SelectItem key={s} value={s}>
															{s}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<FormMessage className="text-[11px]" />
										</FormItem>
									)}
								/>
							) : null}
							{asksInterest ? (
								<FormField
									control={form.control}
									name="interest"
									render={({ field }) => (
										<FormItem>
											<FieldLabel>Primary product interest</FieldLabel>
											<Select value={field.value} onValueChange={field.onChange}>
												<FormControl>
													<SelectTrigger className="w-full">
														<SelectValue placeholder="Select a value" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													{INTERESTS.map((s) => (
														<SelectItem key={s} value={s}>
															{s}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<FormMessage className="text-[11px]" />
										</FormItem>
									)}
								/>
							) : null}
						</div>
					) : null}

					<FormField
						control={form.control}
						name="message"
						render={({ field }) => (
							<FormItem>
								<FieldLabel>How can we help?</FieldLabel>
								<FormControl>
									<Textarea
										rows={6}
										className="min-h-36"
										placeholder={MESSAGE_PLACEHOLDERS[currentTopic]}
										style={{ resize: "vertical" }}
										{...field}
									/>
								</FormControl>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="consent"
						render={({ field }) => (
							<FormItem>
								<label style={{ display: "flex", gap: 11, alignItems: "flex-start", cursor: "pointer", paddingTop: 2 }}>
									<input
										type="checkbox"
										checked={field.value}
										onChange={(e) => field.onChange(e.target.checked)}
										onBlur={field.onBlur}
										style={{ marginTop: 2, accentColor: "var(--text-primary)", width: 15, height: 15, flexShrink: 0 }}
									/>
									{/*
									  * RESPONSE-ONLY (#2371). This used to read "I agree to receive
									  * communications … I can withdraw consent at any time via the
									  * unsubscribe link in any email" — and there is no marketing
									  * list, no unsubscribe link and no email to withdraw from. A
									  * false promise inside a consent control is worse than no
									  * control: it is the one sentence a person is asked to rely on.
									  *
									  * What is collected is used to reply to this enquiry and for
									  * nothing else, so the box acknowledges that rather than
									  * consenting to marketing that does not exist.
									  */}
									<span style={{ fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.55 }}>
										I understand Alethia Labs will use these details only to
										reply to this enquiry, as described in the{" "}
										<Link
											href="/privacy"
											style={{ color: "var(--text-secondary)", textDecoration: "underline", textUnderlineOffset: 2 }}
										>
											Privacy Policy
										</Link>
										. We do not send marketing email and there is no mailing list
										to unsubscribe from.
									</span>
								</label>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>

					<Button
						type="submit"
						size="lg"
						disabled={pending}
						style={{ width: "100%", marginTop: 4 }}
					>
						{pending ? "Sending…" : (submitLabel ?? SUBMIT_LABELS[currentTopic])}
						{!pending && <Icon k="arrow" size={15} />}
					</Button>
				</div>
			</form>
		</Form>
	);
}
