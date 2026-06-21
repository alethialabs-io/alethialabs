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
- [ ] **Roles** — IAM-style. Backend: `roles.ts` (`listCustomRoles`/`deleteRole`) + built-in roles.
- [ ] **Access** — Backend: `grants.ts` (`listAccessGrants`/`getGrantOptions`/`revokeGrant`).
- [ ] **SSO** — Backend: `sso.ts` (`getSsoProviders` + register dialog).
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
