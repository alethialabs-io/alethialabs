// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The weekly cloud-spend report. Run by .github/workflows/spend-report.yml; see README.md.
 *
 * THE FAILURE CONTRACT. Every source degrades to "<Cloud>: not readable — <reason>" and the run goes
 * on. The run FAILS only when the email cannot be sent — and it fails loudly then, after the report
 * has already been written to the job summary, so a red run still carries the numbers.
 */

import { appendFileSync } from "node:fs";
import { render } from "@react-email/components";
import { createElement } from "react";
import { buildReport, parseThresholds } from "./aggregate";
import { reportWindow } from "./dates";
import { SpendReportEmail } from "./email";
import { fetchEcbRates } from "./fx";
import { renderText, subjectLine } from "./render-text";
import { readAlibaba } from "./sources/alibaba";
import { DEFAULT_AWS_TAG_KEYS, readAws, readVault, scanAwsLeaks, type AwsAccount } from "./sources/aws";
import { readAzure } from "./sources/azure";
import { readGcp } from "./sources/gcp";
import { readHetzner } from "./sources/hetzner";

/** Reads an env var, treating empty as unset. */
function env(name: string): string | undefined {
	const v = process.env[name];
	return v === undefined || v.trim() === "" ? undefined : v.trim();
}

/** Sets an env var for @repo/email's config reader, which reads process.env at send time. */
function setEnv(name: string, value: string): void {
	process.env[name] = value;
}

/** The SES values the send needs from the vault — the alethia-email account's sender (the same keys
 * the hosted deploy emits; scripts/ci/check-email-provider-keys.sh). */
interface SesSendEnv {
	ALETHIA_SES_REGION: string;
	ALETHIA_SES_ACCESS_KEY_ID: string;
	ALETHIA_SES_SECRET_ACCESS_KEY: string;
	ALETHIA_SES_GENERAL_CONFIG_SET: string;
}

/** Picks the SES send keys out of the vault, throwing with every missing name at once. */
function sesSendEnv(vault: Record<string, string>): SesSendEnv {
	const pick = (k: keyof SesSendEnv): string => vault[k] ?? "";
	const out: SesSendEnv = {
		ALETHIA_SES_REGION: pick("ALETHIA_SES_REGION"),
		ALETHIA_SES_ACCESS_KEY_ID: pick("ALETHIA_SES_ACCESS_KEY_ID"),
		ALETHIA_SES_SECRET_ACCESS_KEY: pick("ALETHIA_SES_SECRET_ACCESS_KEY"),
		ALETHIA_SES_GENERAL_CONFIG_SET: pick("ALETHIA_SES_GENERAL_CONFIG_SET"),
	};
	const missing = Object.entries(out)
		.filter(([, v]) => v === "")
		.map(([k]) => k);
	if (missing.length > 0) throw new Error(`${missing.join(", ")} missing or empty in the vault`);
	return out;
}

/** Splits a comma-separated env var. */
function list(name: string, fallback: string[]): string[] {
	const v = env(name);
	return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback;
}

/** Appends to the GitHub job summary when running in Actions. */
function summary(markdown: string): void {
	const path = env("GITHUB_STEP_SUMMARY");
	if (path) appendFileSync(path, `${markdown}\n`);
}

/** Builds the report, publishes it to the job summary, and mails it. */
async function main(): Promise<number> {
	const w = reportWindow(new Date());
	const dryRun = env("SPEND_REPORT_DRY_RUN") === "1";
	const to = env("SPEND_REPORT_TO") ?? "borislav@alethialabs.io";
	const { thresholds, warnings } = parseThresholds(env("SPEND_REPORT_THRESHOLDS_EUR"));

	const awsReady = env("AWS_READY") === "true";
	const awsReason = env("AWS_REASON") ?? "AWS credentials were not configured";
	// Two accounts: the platform one through the ambient credentials (also the vault's), and the
	// dedicated e2e account through the named profile its credential step wrote. Cost Explorer in a
	// member account sees only that account, so neither reading covers the other.
	const awsAccounts: AwsAccount[] = [
		{ name: "platform", ready: awsReady, reason: awsReason },
		{
			name: "e2e",
			profile: env("AWS_E2E_PROFILE") ?? "spend-e2e",
			ready: env("AWS_E2E_READY") === "true",
			reason: env("AWS_E2E_REASON") ?? "AWS e2e-account credentials were not configured",
		},
	];
	const awsCfg = {
		tagKeys: list("SPEND_AWS_TAG_KEYS", DEFAULT_AWS_TAG_KEYS),
		groupByLinkedAccount: env("SPEND_AWS_GROUP_BY_LINKED_ACCOUNT") === "true",
		leakRegions: list("SPEND_AWS_LEAK_REGIONS", ["us-east-1"]),
	};

	const [aws, awsLeaks, azure, gcp, hetzner, alibaba, fx] = await Promise.all([
		readAws(w, awsCfg, awsAccounts),
		scanAwsLeaks(awsCfg, awsAccounts),
		readAzure(w, env("AZURE_SUBSCRIPTION_ID") ?? "", env("AZURE_READY") === "true", env("AZURE_REASON") ?? "Azure credentials were not configured"),
		readGcp(
			w,
			{ billingAccount: env("SPEND_GCP_BILLING_ACCOUNT") ?? "", subscription: env("SPEND_GCP_BUDGET_SUBSCRIPTION") ?? "" },
			env("GCP_ACCESS_TOKEN"),
			env("GCP_REASON") ?? "GCP credentials were not configured",
		),
		readHetzner(env("HCLOUD_TOKEN")),
		readAlibaba(w, {
			roleArn: env("E2E_ALIBABA_ROLE_ARN") ?? "",
			oidcProviderArn: env("E2E_ALIBABA_OIDC_PROVIDER_ARN") ?? "",
			bssEndpoint: env("SPEND_ALIBABA_BSS_ENDPOINT") ?? "business.ap-southeast-1.aliyuncs.com",
			oidcRequestUrl: env("ACTIONS_ID_TOKEN_REQUEST_URL"),
			oidcRequestToken: env("ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
		}),
		fetchEcbRates(),
	]);
	if (fx.warning) warnings.push(fx.warning);

	const report = buildReport({
		window: w,
		results: [aws, azure, gcp, hetzner.result, alibaba],
		leakResults: [...awsLeaks, hetzner.leaks],
		fx: fx.fx,
		thresholds,
		warnings,
	});
	const text = renderText(report);
	process.stdout.write(`${text}\n`);
	summary(`## Weekly cloud spend\n\n\`\`\`\n${text}\n\`\`\``);

	if (dryRun) {
		process.stdout.write("\nSPEND_REPORT_DRY_RUN=1 — not sending.\n");
		return 0;
	}

	// ── The send. Everything below FAILS the run. ──
	try {
		if (!awsReady) throw new Error(`the SES sender key lives in AWS Secrets Manager and AWS is not readable: ${awsReason}`);
		const vault = await readVault(env("ASM_SECRET_ID") ?? "alethia/prod/env", env("ASM_REGION") ?? "eu-central-1");
		const ses = sesSendEnv(vault);
		// Masked before anything else could print them.
		process.stdout.write(`::add-mask::${ses.ALETHIA_SES_ACCESS_KEY_ID}\n`);
		process.stdout.write(`::add-mask::${ses.ALETHIA_SES_SECRET_ACCESS_KEY}\n`);
		// @repo/email's sendEmail LOGS AND RETURNS instead of throwing unless NODE_ENV=production, and
		// logs instead of sending when no provider resolves. Both would turn a failed send into a green
		// run, so the provider is pinned and production is asserted, not assumed.
		if (process.env.NODE_ENV !== "production") throw new Error("NODE_ENV must be production for a real send (sendEmail swallows failures otherwise)");
		for (const [k, v] of Object.entries(ses)) setEnv(k, v);
		setEnv("EMAIL_PROVIDER", "ses");
		setEnv("ALETHIA_DEPLOYMENT_MODE", "hosted");
		const from = vault.EMAIL_FROM ?? vault.AUTH_EMAIL_FROM ?? "Alethia <no-reply@alethialabs.io>";
		const { sendEmail } = await import("@repo/email/send");
		const { getEmailConfig } = await import("@repo/email/config");
		const emailConfig = getEmailConfig();
		if (emailConfig.provider !== "ses") throw new Error("the email provider did not resolve to ses");
		await sendEmail({
			from,
			to,
			subject: subjectLine(report),
			react: createElement(SpendReportEmail, { report }),
			// The general stream's set, so a bounce of this report reaches the same suppression list.
			configurationSetName: emailConfig.configSet.general,
		});
		process.stdout.write(`\nSent "${subjectLine(report)}" to ${to}.\n`);
		summary(`\nSent to ${to}.`);
		return 0;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stdout.write(`::error::spend report NOT sent — ${msg}\n`);
		summary(`\n**NOT sent** — ${msg}`);
		return 1;
	}
}

/** Renders the email HTML to stdout without sending — `pnpm start -- --html` for a local look. */
async function previewHtml(): Promise<void> {
	const w = reportWindow(new Date());
	const report = buildReport({ window: w, results: [], leakResults: [], fx: { date: null, rates: { EUR: 1 } }, thresholds: parseThresholds(undefined).thresholds, warnings: [] });
	process.stdout.write(await render(createElement(SpendReportEmail, { report })));
}

if (process.argv.includes("--html")) {
	void previewHtml();
} else {
	main().then(
		(code) => process.exit(code),
		(err: unknown) => {
			process.stdout.write(`::error::spend report crashed — ${err instanceof Error ? err.message : String(err)}\n`);
			process.exit(1);
		},
	);
}
