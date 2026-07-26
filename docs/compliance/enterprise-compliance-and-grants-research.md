<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Enterprise compliance and grants research

Last checked: 2026-07-23, Europe/Sofia.

This is a founder operating memo, not legal, audit, tax, or grant-application advice. Treat all costs as
planning ranges until quotes are received from a CPA firm, an accredited ISO certification body, counsel,
and the relevant Bulgarian or EU programme contact.

## Executive decision

Alethia should optimize for **SOC 2 first**, then reuse the same control system for **ISO/IEC 27001:2022**.
For large enterprise SaaS buyers, SOC 2 Type II is the faster procurement unblocker. ISO/IEC 27001 is still
worth pursuing because Alethia is European, infrastructure-adjacent, and aimed at larger companies, but the
right move is to avoid building two compliance programmes.

Recommended order:

1. Start SOC 2 readiness immediately.
2. If a specific enterprise deal needs near-term evidence, issue a SOC 2 Type I bridge report.
3. Start the SOC 2 Type II observation window as soon as the control set is stable.
4. Layer ISO/IEC 27001:2022 on top once the SOC 2 operating evidence is flowing.

Recommended first SOC 2 scope:

- Trust Services Criteria: **Security, Availability, Confidentiality**.
- In scope: hosted Alethia control plane, managed runner service, CI/CD, production infrastructure,
  production data stores, support access, incident response, vendor management, and customer-facing
  security commitments.
- Out of scope unless a buyer demands it: Privacy TSC, Processing Integrity TSC, customer-owned cloud
  environments, and unlaunched experimental managed-BYO-IaC sandbox paths.

Budget to reserve:

| Path | External cash range | When to choose it |
| --- | ---: | --- |
| Minimum credible SOC 2 Type II only | USD 35k-90k | No urgent deal requires Type I; accept 3-6 months before report. |
| SOC 2 Type I bridge plus Type II | USD 50k-120k | A deal needs evidence in 60-90 days. |
| SOC 2 plus ISO/IEC 27001 integrated | USD 75k-160k | EU enterprise/security buyers explicitly ask for both. |
| Bare-minimum DIY | USD 20k-55k | Only if cash is the hard constraint and founder time is abundant. |
| Fastest route | USD 90k-200k+ | Only if a large contract depends on it this quarter. |

The lean credible budget for Alethia is **USD 50k-120k over the first 12 months** for SOC 2 Type I + Type II,
including tooling, auditor, pentest, and some legal/policy support. ISO/IEC 27001 adds likely **USD
20k-60k incremental** if done after SOC 2 groundwork, or **USD 35k-80k+** if treated as a separate first-year
project.

## What enterprise buyers will require

For board-driven enterprise procurement, assume the checklist will include the following:

- SOC 2 Type II report, or at least Type I plus active Type II observation.
- ISO/IEC 27001:2022 certificate for EU/global procurement, especially if buyers are in regulated sectors.
- Recent penetration test, remediation letter, and vulnerability-management process.
- Security questionnaire answers mapped to evidence, not marketing claims.
- DPA, SCC transfer language, subprocessor list, retention schedule, and data-residency answer.
- SSO over SAML/OIDC, RBAC, audit logs, MFA enforcement, and ideally SCIM for lifecycle automation.
- Incident response process, breach notification terms, backup/restore testing, RTO/RPO, and business
  continuity plan.
- Secure SDLC: code review, CI checks, dependency scanning, secrets scanning, release approvals, and change
  traceability.
- Support-access controls: who can access customer data, when, with what approval, and how it is logged.
- Vendor risk management: cloud providers, email, billing, analytics, error tracking, AI providers, support
  tools, and any subprocessors.
- Security ownership: named control owner, regular access reviews, policy acknowledgement, training, and
  termination/offboarding process.

Alethia's current posture is better than a generic early SaaS company because the product already has security
architecture that maps naturally to SOC 2. The procurement problem is that buyers will not accept "we designed
for it" as equivalent to an issued report.

## Current Alethia readiness

Strong evidence already present in the repo:

- `docs/compliance/soc2-e2e-matrix.md` maps Alethia tests to SOC 2 criteria and correctly distinguishes
  regression tests from audit evidence.
- `docs/compliance/security-e2e-matrix.md` maps tenant isolation, authorization parity, sandbox hardening,
  secret non-leakage, and fail-closed gates to evidence.
- `apps/docs/content/docs/standards/security-and-compliance.mdx` states the right external posture: Alethia is
  built for SOC 2 readiness but is not SOC 2 certified.
- `apps/docs/content/docs/concepts/security.mdx` documents the zero-static-cloud-credential model, OIDC
  issuer, workload identity, state proxy, least-privilege connector roles, and tenant isolation.
- `ee/README.md` and `apps/docs/content/docs/access-control/sso.mdx` show Enterprise SSO/RBAC/OpenFGA
  direction, including offline license verification for self-managed customers.
- `docs/ops/incident-response-runbook.md` already contains incident-response, break-glass, DR, trace
  correlation, and audit-ledger concepts.

Material gaps before a credible audit:

- Legal entity details are incomplete. `packages/brand/src/legal.ts` still has TODOs for company registration
  number and VAT.
- Privacy and terms pages still contain placeholders for hosting region, subprocessors, transfer mechanisms,
  retention periods, DPO/data protection contact, pricing terms, SLA, liability cap, and dispute venue.
- The docs currently acknowledge that the activity/audit log has no dedicated RLS policy or WORM retention
  guarantee. That should be closed or explicitly scoped before SOC 2 fieldwork.
- `demos/DEMO-READINESS.md` states that the newer multi-cloud work is not yet hosted and real cloud apply is
  still unproven. A SOC 2 auditor will sample production operation, not planned architecture.
- Formal company controls are not visible in the repo: risk register, asset inventory, vendor register, access
  review records, policy approvals, employee/contractor onboarding, offboarding, training, background-check
  decision, business continuity, backup restore tests, incident tabletop tests, and vulnerability SLAs.
- SCIM is not evidenced as shipped. If a buyer asks for automated deprovisioning, answer "planned" unless the
  implementation exists.
- AI/data handling must be explicitly scoped. If AI features are enabled in the hosted product, document the
  provider list, prompts/log retention, customer-data use, no-training commitments, and opt-out controls. If
  they are not production features, exclude them from the first audit scope.

## Compliance roadmap

### Days 0-14: scope and quote

- Name one compliance owner. For now this can be the founder, but procurement materials need a named owner.
- Freeze the first audit boundary: hosted control plane, managed runners, support operations, CI/CD, production
  infrastructure, and company process controls.
- Decide whether to pursue Type I. Default: **yes only if a deal needs it**. Otherwise go straight to Type II
  with a 3-month observation window.
- Request quotes from:
  - 3 CPA SOC 2 auditors.
  - 2 GRC platforms.
  - 2 ISO/IEC 27001 certification bodies.
  - 2 pentest firms.
  - 1 privacy/SaaS counsel for DPA, SCCs, subprocessors, privacy policy, terms, and enterprise MSA template.
- Build the first evidence inventory: map each existing Alethia control to source, owner, frequency, evidence
  artifact, and audit sample location.

### Days 15-45: make the company auditable

- Complete legal placeholders in the brand/legal source and public legal pages.
- Create a subprocessor register and vendor-risk file for every external service in production.
- Write or adopt policies: information security, acceptable use, access control, password/MFA, change
  management, incident response, vulnerability management, vendor management, data retention, encryption, BCP/DR,
  secure SDLC, asset management, and risk management.
- Document production data flow and trust boundaries: browser, CLI, control plane, database, object storage,
  runner, customer cloud accounts, support/admin tooling, email, billing, analytics, and error tracking.
- Define evidence frequencies:
  - Continuous: CI checks, dependency scans, logging/monitoring, alerting.
  - Monthly: vulnerability review, backup check, vendor/security exceptions.
  - Quarterly: access reviews, risk review, incident tabletop, BCP/DR review.
  - Per change: PR approval, deployment record, rollback plan, migration review.
- Run a pentest against the hosted production-equivalent environment and track remediation.
- Close or scope the audit-log WORM/RLS gap before claiming tamper-resistant operational evidence.

### Days 46-90: Type I or Type II start

- If Type I is needed, schedule fieldwork after control design is complete and evidence is organized.
- If skipping Type I, start the Type II observation window when production controls are operating.
- Ensure every control has an owner, evidence source, frequency, and exception process.
- Create a customer-facing trust package:
  - SOC 2 status statement.
  - Security architecture summary.
  - Pen test executive summary or attestation letter.
  - DPA and subprocessor list.
  - Standard security questionnaire answers.
  - Roadmap dates for SOC 2 Type II and ISO/IEC 27001.

### Months 3-9: operate the controls

- Keep evidence collection boring: weekly compliance review, monthly exceptions review, quarterly access review.
- Record incident response tabletop and restore-test evidence even if there are no real incidents.
- Keep production-change evidence tied to PRs, CI, deploy records, and rollback notes.
- Run one real-cloud proof path and keep the artifact bundle. The existing demo-readiness doc makes clear this
  is a current evidence weakness.

### Months 6-12: ISO/IEC 27001 overlay

- Define the ISMS scope and interested parties.
- Build the risk assessment and risk treatment plan.
- Produce the Statement of Applicability for ISO/IEC 27001:2022 Annex A controls.
- Run an internal audit and management review before certification body Stage 1.
- Schedule Stage 1 and Stage 2 with an accredited certification body.

## Cost model

Planning ranges from 2026 public market data:

| Cost item | Lean range | Notes |
| --- | ---: | --- |
| GRC platform | USD 7.5k-25k/year | Vanta, Drata, Secureframe, Sprinto, Strike Graph, Scytale, or equivalent. Multi-framework costs more. |
| SOC 2 Type I audit | USD 7.5k-25k | Point-in-time design report. Useful as a sales bridge. |
| SOC 2 Type II audit | USD 15k-60k | Observation period commonly 3-12 months. Budget toward the higher half for multi-cloud/runners. |
| Pentest | USD 8k-25k | Web app, API, auth, runner/control-plane boundaries, and cloud/IaC workflows. |
| Readiness consultant | USD 0-40k+ | Keep low if founder-led; spend only where it saves calendar time. |
| Legal/privacy package | USD 3k-15k | DPA, SCCs, subprocessors, privacy, terms, MSA/security addendum. |
| ISO certification body | USD 8k-25k | Stage 1 and Stage 2 audit for a startup-sized scope. |
| ISO implementation support | USD 10k-50k+ | Lower if SOC 2 controls and evidence are reused. |

Do not let vendors sell the tool as the audit. A GRC platform can automate evidence collection, but an
independent CPA firm issues SOC 2. For ISO/IEC 27001, an accredited certification body issues the certificate.

Vendor quote checklist:

- What exact systems, subsidiaries, environments, and criteria are included?
- Can the auditor handle a SaaS product with managed runners, customer-cloud federation, and self-hosted
  enterprise deployments?
- Is the quote Type I, Type II, or Type I plus Type II?
- What observation window is assumed for Type II?
- What Trust Services Criteria are priced?
- Does the auditor require a pentest? If yes, what scope and recency?
- Does the GRC platform support GitHub, cloud, IdP, endpoint/MDM, HRIS, ticketing, and custom evidence upload?
- Can the tool map one control set to SOC 2 and ISO/IEC 27001 without duplicate evidence?
- Can evidence be exported if Alethia changes platforms?
- Are there conflicts between the compliance platform and the auditor? The AICPA has explicitly warned service
  organizations and CPA firms to evaluate SOC tool-provider relationships carefully.

## Funding shortlist

The strongest non-dilutive path is to position Alethia as **secure, sovereign, auditable cloud automation for
European enterprises**, not as generic DevOps tooling.

| Programme | Status on 2026-07-23 | Fit | Funding signal | Recommended action |
| --- | --- | ---: | --- | --- |
| EIC Accelerator Open 2026 | Open; remaining full-proposal batching dates are 2026-09-02 and 2026-11-04 if the short proposal gets a GO. | 8/10 | Grant below EUR 2.5m plus possible EUR 1m-10m equity. | Submit short proposal immediately. Realistic target is November full proposal unless a short-proposal GO is already available. |
| Horizon Europe HORIZON-CL3-2026-02-CS-ECCC-01 | Open; deadline 2026-09-15, 17:00 CEST. | 7/10 | Topic budget EUR 20m for security in software/hardware development and assessment. | Pursue only with consortium partners. Pitch Elench as security-by-design, formal verification, AI-driven security testing, and certification evidence. |
| Horizon Europe SecureAI, HORIZON-CL3-2026-02-CS-ECCC-02 | Open; deadline 2026-09-15. | 4/10 | Topic budget EUR 21.2m. | Only apply if Alethia has a concrete AI-system security module, not just AI-assisted product UX. |
| Horizon Europe HACS/crypto, HORIZON-CL3-2026-02-CS-ECCC-03 | Open; deadline 2026-09-15. | 5/10 | Topic budget EUR 15m. | Possible angle: tamper-evident infrastructure evidence and high-assurance cryptographic receipts. Weak unless expanded toward formal crypto/evidence systems. |
| Eurostars-3 Call 11 via Bulgaria NIF | Open 2026-07-09 to 2026-09-10, 14:00 CEST. | 7/10 | Bulgaria NIF page lists EUR 200k budget for Call 11; confirm Bulgarian participant ceiling in national rules. | Feasible if an international R&D partner is found fast. Good for a 24-36 month joint R&D project around multi-cloud compliance verification. |
| Programme Competitiveness and Innovation in Enterprises 2021-2027, Bulgaria | Active programme; specific calls vary. | 5/10 | Supports innovation, R&D, digitalisation, cybersecurity, and data privacy for Bulgarian enterprises. | Track future national calls. Current LAG/MIG innovation call is likely poor fit for a Sofia-based startup unless Alethia qualifies geographically. |
| BG16RFPR001-1.012 Digitalization of Enterprises | Closed for application; implementation/contracts active in 2026. | 3/10 | Prior call offered BGN 5k-50k grants for micro/small enterprises, including cybersecurity/data-security ICT. | Track next round only. Better for Alethia's internal compliance tooling than core product R&D. |
| Research, Innovation and Digitalisation for Smart Transformation, Bulgaria | Programme active; specific calls vary. | 5/10 | Focuses science-business links, innovation, digital technologies, and technology transfer. | Monitor small innovative grants and Technology Transfer Fund activity. Better with a university/research partner. |
| Bulgarian Development Bank innovation/digitalisation finance | Open loan/guarantee product. | 4/10 | Up to BGN 4.3m/EUR 2.2m, combined loans up to BGN 5m/EUR 2.56m. | Use only if debt is acceptable and Alethia meets positive-equity/no-arrears criteria. Not a grant. |
| Enterprise Innovation Fund Bulgaria | Financial instrument under PCIE. | 4/10 | EUR 32.17m budget for equity/quasi-equity innovation support. | Track as financing, not non-dilutive grant. Useful if venture-style capital is acceptable. |
| NATO DIANA | 2027 challenge applications are closed as of this check; dynamic challenges may appear. | 5/10 | Selected innovators receive EUR 100k, with potential follow-on funding up to EUR 300k. | Track only if Alethia wants a dual-use/security operations positioning. This is not an EU grant. |
| NLnet/NGI open-source grants | Regular broad calls temporarily paused; only Taler and Fediversity are open until 2026-08-01. | 3/10 now, 6/10 later | Typical grants EUR 5k-50k for free/libre/open-source work. | Revisit after summer 2026 for open-source components only, not proprietary enterprise features. |

Grant strategy:

- **EIC Accelerator:** best upside and best solo-founder/company path. The pitch must claim a hard technical
  innovation: deterministic multi-cloud infrastructure safety, formal/policy verification, signed compliance
  evidence, and sovereign/keyless cloud control. A generic "DevOps platform" will not score.
- **Horizon cybersecurity:** best for research credibility, but requires consortium work. Start partner search
  immediately through Bulgarian National Contact Points, ECCC/NCC channels, Sofia Tech Park/GATE, and EU
  cybersecurity labs.
- **Eurostars:** most practical smaller R&D grant if Alethia can find one foreign SME/research partner quickly.
  Build a project around Elench plus a pilot customer/partner, not broad platform engineering.
- **Bulgarian PCIE/RIDST:** monitor monthly. These are useful, but calls are procedural and often narrow.
  Consider them opportunistic rather than core funding strategy.

Grant narrative to reuse:

> Alethia Labs is building a European, open-core infrastructure control plane that enables enterprises to
> provision multi-cloud infrastructure with no static cloud credentials, deterministic policy verification before
> changes take effect, and tamper-evident evidence receipts for audit and regulatory review.

Possible grant work packages:

- WP1: Formal cloud-risk model for infrastructure-as-code plans across AWS, GCP, Azure, Alibaba, and European
  cloud providers.
- WP2: Tamper-evident evidence receipts mapped to SOC 2, ISO/IEC 27001, NIS2, and Cyber Resilience Act
  obligations.
- WP3: AI-assisted security testing and mutation testing for IaC controls, with false-pass regression guards.
- WP4: Sovereign, keyless, customer-controlled cloud federation for critical-sector enterprises.
- WP5: Open-core dissemination: publish benchmarks, test corpora, control mappings, and interoperability
  guidance.

## Procurement grill

Use this section to prepare honest answers for enterprise sales calls.

| Buyer question | Answer today | Better answer after roadmap |
| --- | --- | --- |
| Do you have SOC 2 Type II? | No. Alethia has SOC 2 readiness mappings and security evidence design, but no issued report. | Yes, provide Type II report under NDA, plus bridge letter for current period. |
| Do you have ISO/IEC 27001? | No. ISO/IEC 27001:2022 should be planned after SOC 2 evidence starts flowing. | Yes, provide certificate, scope statement, and Statement of Applicability summary. |
| Where is customer data hosted? | Not finalized in public legal pages. The privacy page has a placeholder. | State exact regions, subprocessors, backup locations, and transfer mechanisms. |
| Do you store cloud credentials? | Alethia is designed not to store static cloud credentials; it uses OIDC/workload identity and short-lived sessions. | Same, backed by audit evidence and architecture review. |
| Can customers revoke your access? | Yes, by deleting or disabling the customer-side trust/role/identity. | Same, with documented revocation runbook and tested evidence. |
| How do you isolate tenants? | Postgres RLS plus PDP/RBAC/OpenFGA direction; regression tests exist. | Same, plus sampled production evidence and quarterly access review records. |
| Are audit logs immutable? | Signed verify receipts are tamper-evident; app activity/audit log still has a documented WORM/RLS limitation. | WORM/RLS gap closed or explicitly scoped, with retention and sampling evidence. |
| Can your staff access customer data? | Needs formal support-access policy and break-glass enablement decision. | Access is least-privilege, approved, time-boxed, logged, and reviewed. |
| What happens during an incident? | There is a runbook, but operating evidence must be produced. | Provide incident response policy, tabletop record, notification process, and sample evidence. |
| What is your RTO/RPO? | Not safely claimable until backup/restore tests and SLAs are documented. | Provide tested RTO/RPO, backup evidence, and DR test results. |
| Do you support SAML/OIDC SSO? | Enterprise docs indicate SAML/OIDC SSO support. | Provide SSO setup docs, test evidence, and SSO enforcement options. |
| Do you support SCIM? | Not evidenced as shipped. Do not claim it. | Add SCIM or state a roadmap date. |
| Do you use AI providers on customer data? | Must be explicitly scoped before sales answers. | Provide AI subprocessor/data-use terms, retention, no-training commitments, and opt-out controls. |
| Can we self-host or run air-gapped? | Enterprise license design supports offline verification; scope details need a customer runbook. | Provide self-hosted security model, update process, support boundary, and certification applicability statement. |

## Immediate next actions

This is the practical checklist for the next two weeks:

- Ask 3 SOC 2 auditors for quotes using the vendor checklist above.
- Ask 2 GRC platforms for quotes for SOC 2 plus ISO/IEC 27001, not SOC 2 alone.
- Ask 2 pentest firms for a scoped quote covering web app, API, auth, runner/control-plane boundary, and cloud
  federation.
- Fix the legal and privacy placeholders before any serious enterprise procurement process.
- Decide whether the first audit includes Availability and Confidentiality; recommended answer is yes.
- Decide whether to issue Type I. Default: only if a deal needs it.
- Build a `controls.csv` or GRC import with: control ID, framework mapping, owner, frequency, evidence source,
  system, and exception handling.
- Contact the Bulgarian Horizon/EIC National Contact Point and NIF about EIC Accelerator, Horizon
  HORIZON-CL3-2026-02-CS-ECCC, and Eurostars Call 11.
- Draft a one-page grant concept around "Elench Trust Evidence Engine" and use it to test partner/customer
  interest before writing a full proposal.

## Sources

- AICPA & CIMA, SOC suite of services:
  <https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services>
- NIST crosswalk for AICPA 2017 Trust Services Criteria with 2022 revised points of focus:
  <https://www.nist.gov/itl/applied-cybersecurity/privacy-engineering/american-institute-certified-public-accountants-aicpa>
- ISO, ISO/IEC 27001:2022 overview:
  <https://www.iso.org/standard/27001>
- SOC 2 startup cost benchmarks:
  <https://soc2auditors.org/insights/soc-2-compliance-for-startups/>
- SOC 2 Type II cost benchmarks:
  <https://soc2auditors.org/insights/soc-2-type-2-audit-cost/>
- SOC 2 audit cost benchmarks:
  <https://soc2auditors.io/resources/how-much-does-a-soc-2-audit-cost-in-2026>
- SOC 2 GRC platform pricing benchmarks:
  <https://soc2auditors.org/insights/best-soc-2-software-startups/>
- ISO/IEC 27001 startup cost benchmarks:
  <https://www.probo.com/hub/iso27001-certification-cost>
- EIC Accelerator 2026:
  <https://eic.ec.europa.eu/eic-funding-opportunities/eic-accelerator_en>
- EIC funding opportunities:
  <https://eic.ec.europa.eu/eic-funding-opportunities_en>
- EIC 2026 work programme:
  <https://eic.ec.europa.eu/eic-funding-opportunities/eic-2026-work-programme_en>
- Horizon Europe cybersecurity call HORIZON-CL3-2026-02-CS-ECCC:
  <https://cybersecurity-centre.europa.eu/funding-opportunities/calls-proposals/cybersecurity-horizon-cl3-2026-02-cs-eccc_en>
- Digital Europe work programmes:
  <https://digital-strategy.ec.europa.eu/en/activities/work-programmes-digital>
- SECURE project cybersecurity co-funding notice:
  <https://digital-strategy.ec.europa.eu/en/news/financial-support-small-businesses-improve-cybersecurity-products>
- Eurostars Call 11:
  <https://www.eurekanetwork.org/programmes-and-calls/eurostars/eurostars-call-for-projects-september-2026/>
- Bulgaria National Innovation Fund, Eurostars Call 11:
  <https://nif.government.bg/en/programs/36>
- Bulgaria Ministry of Innovation and Growth, business financial support:
  <https://www.mig.government.bg/finansova-podkrepa-za-biznesa/?lang=en>
- Bulgaria PCIE 2021-2027:
  <https://www.mig.government.bg/programa-konkurentosposobnost-i-inovaczii-v-predpriyatiyata/>
- PCIE Digitalization of Enterprises:
  <https://www.mig.government.bg/programa-konkurentosposobnost-i-inovaczii-v-predpriyatiyata/novini-proczeduri-pkip/bg16rfpr001-1-012-digitalizacziya-na-predpriyatiyata/>
- Bulgaria Research, Innovation and Digitalisation for Smart Transformation:
  <https://www.mig.government.bg/programa-nauchni-izsledvaniya-inovaczii-i-digitalizacziya-za-inteligentna-transformacziya/>
- Bulgaria 2026 Digital Decade country report:
  <https://digital-strategy.ec.europa.eu/en/factpages/bulgarias-2026-digital-decade-country-report>
- Bulgarian Development Bank innovation and digitalisation financing:
  <https://bbr.bg/en/lending/for-social-companies-innovation-and-digitalization/for-innovations-and-digitalization/>
- Enterprise Innovation Fund Bulgaria:
  <https://fmfib.bg/en/instrument/fond-inovacii-v-predpriiatiiata>
- NATO DIANA accelerator programme:
  <https://www.diana.nato.int/accelerator-programme.html>
- NATO DIANA challenges:
  <https://www.diana.nato.int/challenges.html>
- NLnet funding:
  <https://nlnet.nl/funding.html>
