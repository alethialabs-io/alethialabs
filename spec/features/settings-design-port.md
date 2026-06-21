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
- [ ] **Members** — refactor off `settings-design.module.css`, then delete the module.
- [ ] **Teams** — `teams-list.tsx` → design. Backend: `getTeams` + better-auth team CRUD.
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
