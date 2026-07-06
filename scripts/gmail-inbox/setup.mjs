// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// One-shot, idempotent setup of the alethialabs.io shared inbox in Gmail, via the
// Gmail API. Companion to Cloudflare Email Routing (infra/cp-hetzner/email-routing.tf,
// which forwards support@/sales@/… here) and the SES apex send-as identity
// (infra/email-ses). It:
//
//   1. creates nested labels (Alethia/Support, …),
//   2. creates filters that label incoming mail per address (+ never-spam),
//   3. creates "Send mail as" aliases routed through SES SMTP, so replies go out
//      *as* support@alethialabs.io etc. (DKIM-signed d=alethialabs.io → DMARC pass).
//
// Re-running is safe: existing labels/filters/aliases are detected and skipped.
//
// Prereqs (see ./README.md): a Google Cloud OAuth *Desktop* client downloaded to
// ./credentials.json, and SES SMTP creds in the environment:
//   SES_SMTP_USER, SES_SMTP_PASSWORD  (required for send-as)
//   SES_SMTP_HOST (default email-smtp.eu-central-1.amazonaws.com), SES_SMTP_PORT (587)
//
// Usage:  npm install && node setup.mjs
//
// Alias creation triggers a Google verification email per address; it routes back
// through Cloudflare into this same inbox — click each link once to finish.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { authenticate } from "@google-cloud/local-auth";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOMAIN = "alethialabs.io";
const CREDENTIALS_PATH = path.join(HERE, "credentials.json");
const TOKEN_PATH = path.join(HERE, "token.json");

// Gmail settings.basic covers labels + filters; settings.sharing is required to set
// a send-as alias that carries SMTP MSA credentials.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
];

// Per-address config. `label` → the Gmail label applied by the filter. `sendAs` →
// whether to also add a "Send mail as" alias (receive-only addresses like feedback@
// and the automated dmarc@ don't need one).
const ADDRESSES = [
  { local: "support", label: "Alethia/Support", display: "Alethia Support", sendAs: true },
  { local: "sales", label: "Alethia/Sales", display: "Alethia Sales", sendAs: true },
  { local: "legal", label: "Alethia/Legal", display: "Alethia Legal", sendAs: true },
  { local: "security", label: "Alethia/Security", display: "Alethia Security", sendAs: true },
  { local: "feedback", label: "Alethia/Feedback", display: "Alethia Feedback", sendAs: false },
  { local: "dmarc", label: "Alethia/DMARC", display: "Alethia DMARC", sendAs: false },
  { local: "borislav", label: "Alethia/Borislav", display: "Borislav Borisov", sendAs: true },
];

const smtp = {
  host: process.env.SES_SMTP_HOST || "email-smtp.eu-central-1.amazonaws.com",
  port: Number(process.env.SES_SMTP_PORT || 587),
  username: process.env.SES_SMTP_USER,
  password: process.env.SES_SMTP_PASSWORD,
};

/** Reuse a cached token.json if present, else run the loopback flow and cache it. */
async function authorize() {
  const saved = await readFile(TOKEN_PATH, "utf8")
    .then((raw) => google.auth.fromJSON(JSON.parse(raw)))
    .catch(() => null);
  if (saved) return saved;

  const client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });
  if (client.credentials?.refresh_token) {
    const keys = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8"));
    const key = keys.installed || keys.web;
    await writeFile(
      TOKEN_PATH,
      JSON.stringify({
        type: "authorized_user",
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
      }),
    );
  }
  return client;
}

/** Build an authenticated Gmail client. */
async function getGmail() {
  return google.gmail({ version: "v1", auth: await authorize() });
}

/** Create a (possibly nested) label if it doesn't already exist; return its id. */
async function ensureLabel(gmail, name, existing) {
  const found = existing.find((l) => l.name === name);
  if (found) {
    console.log(`  label exists: ${name}`);
    return found.id;
  }
  const res = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });
  console.log(`  label created: ${name}`);
  existing.push(res.data);
  return res.data.id;
}

/** Create a "to:<addr>" filter that labels the mail and keeps it out of spam. */
async function ensureFilter(gmail, addr, labelId, existingFilters) {
  const already = existingFilters.some(
    (f) => f.criteria?.to === addr && f.action?.addLabelIds?.includes(labelId),
  );
  if (already) {
    console.log(`  filter exists: to:${addr}`);
    return;
  }
  await gmail.users.settings.filters.create({
    userId: "me",
    requestBody: {
      criteria: { to: addr },
      // addLabelIds → tag it; removeLabelIds ['SPAM'] → never send to spam.
      action: { addLabelIds: [labelId], removeLabelIds: ["SPAM"] },
    },
  });
  console.log(`  filter created: to:${addr} → label`);
}

/** Add a Send-mail-as alias over SES SMTP (idempotent). Triggers verification. */
async function ensureSendAs(gmail, addr, display, existingAliases) {
  if (existingAliases.some((a) => a.sendAsEmail === addr)) {
    console.log(`  send-as exists: ${addr}`);
    return;
  }
  if (!smtp.username || !smtp.password) {
    console.log(`  send-as SKIPPED (${addr}): set SES_SMTP_USER / SES_SMTP_PASSWORD`);
    return;
  }
  await gmail.users.settings.sendAs.create({
    userId: "me",
    requestBody: {
      sendAsEmail: addr,
      displayName: display,
      treatAsAlias: true,
      smtpMsa: {
        host: smtp.host,
        port: smtp.port,
        username: smtp.username,
        password: smtp.password,
        securityMode: "starttls",
      },
    },
  });
  console.log(`  send-as created: ${addr} (verification email sent — click the link)`);
}

async function main() {
  const gmail = await getGmail();

  const [labelsRes, filtersRes, aliasesRes] = await Promise.all([
    gmail.users.labels.list({ userId: "me" }),
    gmail.users.settings.filters.list({ userId: "me" }),
    gmail.users.settings.sendAs.list({ userId: "me" }),
  ]);
  const labels = labelsRes.data.labels || [];
  const filters = filtersRes.data.filter || [];
  const aliases = aliasesRes.data.sendAs || [];

  for (const a of ADDRESSES) {
    const addr = `${a.local}@${DOMAIN}`;
    console.log(`\n${addr}`);
    const labelId = await ensureLabel(gmail, a.label, labels);
    await ensureFilter(gmail, addr, labelId, filters);
    if (a.sendAs) await ensureSendAs(gmail, addr, a.display, aliases);
  }

  console.log(
    "\nDone. Finish by clicking the verification link in each 'Gmail Confirmation' email" +
      ` that lands in ${process.env.GMAIL_USER || "your inbox"}.`,
  );
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
