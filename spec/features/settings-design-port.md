# Settings — authored design port (React, no CSS modules)

Porting the authored claude.ai/design settings sections (`console/settings.html` + `console/billing.html`)
into the console, **1 by 1**, composing the shared settings primitives (`components/settings/settings-ui.tsx`)
built from shadcn/ui + Tailwind token-utilities. **No `*.module.css`.** Each page wires the real backend
that already exists; anything the design wants that the backend lacks is logged here — never invented.

## Foundation
- [x] Expose Alethia semantic tokens as Tailwind utilities (`app/globals.css` `@theme`): `bg-surface`,
      `bg-surface-sunken`, `text-text-primary/secondary/tertiary/disabled`, `border-border-strong`,
      `bg-ink`, `text-ink-foreground`, …
- [x] Shared primitives (`components/settings/settings-ui.tsx`): `SettingsPageHead`, `SettingsSection`,
      `SettingsPanel`, `SettingsField`, `SettingsCardFoot`, `SettingsDangerRow`, `StatStrip`/`StatCell`,
      `settingsControl`/`settingsControlSize`.

## Pages
- [x] **General** — `components/settings/general/org-general.tsx`. Off the module. Backend: `getOrgSettings`
      + `authClient.organization.update/delete`.
- [x] **Members** — off the module (now deleted). Reusable primitives added: `SettingsTabs`,
      `SettingsSearch`, `SettingsSelect`, `SettingsTableCard`/`Foot`, `settingsTh/Td/TableRows`.
      Backend: `getMembers`/`getInvitations`/`setMemberSuspended` + better-auth role/remove/cancel.
- [x] **Teams** — card-grid design via primitives. `getTeams` extended with `members[]` (avatar stack +
      grouped count); create/delete/manage via better-auth. Stats: Teams / Members grouped / Largest team.
- [x] **Roles** — IAM-style master-detail (`roles-manager.tsx`): rail (Built-in + Custom) + detail with
      `permission-matrix` (new `readOnly` prop) + template gallery. Custom CRUD via `roles.ts`, gated on
      `customRoles`. Built-in roles read-only from `registry`. Deleted `custom-roles` + `role-editor-dialog`.
- [x] **Access** — grants design (`access-manager.tsx`): inheritance note + stat strip (Grants/Org/Zone/
      Spec) + toolbar + **inline grant builder** (live preview) + grants table (Principal/Role/Scope/reach/
      Granted/revoke). Wired to `grants.ts`; Enterprise-gated. Deleted `access-table` + `grant-access-dialog`.
- [x] **SSO** — multi-card IdP design (`sso-manager.tsx`): status card + SP details (derived URLs + copy) +
      IdP details (issuer/SSO URL/cert fingerprint — `getSsoProviders` extended to parse saml/oidc config) +
      attribute mapping + register dialog. SCIM + enforcement rendered as honest "coming soon" cards.
      Deleted `sso-providers.tsx`.
- [ ] **Audit** — Backend: `audit.ts` (`getAuditLog` + export).
- [ ] **Billing** — refactor off `billing-design.module.css`, then delete the module.

## Design wants X, backend lacks Y (gap log)
- **General · Logo upload** — design shows Upload/Remove; no avatar storage pipeline. Stubbed (toast).
- **General · Transfer ownership** — design shows it; no ownership-transfer action. Stubbed (toast).
- **General · Data region / Default env / Terraform version** — stored in org metadata; not yet enforced
      downstream (no consumer reads them at provision time).
- **Billing · Zones meter / Runner-minutes meter** — design shows usage meters; no zone-count-per-org or
      runner-minute metering. Shown as "metering coming soon".
- **Billing · Plan history** — design shows a full timeline; no billing event log. Derived minimally
      (org created + current plan).
- **Teams · description / stored slug** — design shows a per-team description + slug; the `team` table has
      neither (better-auth team = id/name/orgId). Slug derived from name for display; description omitted.
- **Teams · zone-access chips / role-tag** — design shows each team's Zone grants + a role tag; no
      team→Zone grant read wired here (grants exist in Access, but not surfaced per team). Omitted.
- **Teams · "Zones covered" stat** — needs team→Zone coverage; not available. Dropped (3 real stats shown).
- **Access · effective-reach exact counts** — design shows "flows to N Specs"; no zone→spec map wired.
      Shown qualitatively ("This Zone & its Specs"). **grantedBy** not stored → relative date only.
      Team principal member-count not surfaced on the row tag (shows "Team").
- **SSO · SCIM provisioning** — design shows base URL + bearer token + last-sync; **no SCIM backend**.
      Rendered as a "coming soon" card.
- **SSO · Enforcement** (require-SSO toggle, auto-assign role) — **no backend**; "coming soon" (disabled).
- **SSO · Test connection / Re-upload metadata / Rotate token** — no backend → toast stubs.
- **SSO · SP detail URLs** — derived from org slug + `NEXT_PUBLIC_APP_URL` on the better-auth SSO convention;
      verify against the deployed SSO plugin routes when enterprise SSO is stood up. No `connected` date
      (no `createdAt` on `sso_provider`).
