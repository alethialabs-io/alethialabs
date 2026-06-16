# Landing Page Specification

Section-by-section design spec for the Trellis landing page. Inspired by [ai-sdk.dev](https://ai-sdk.dev/). Lives as a public route at `apps/trellis/app/page.tsx`.

---

## Current State

The existing `page.tsx` has 5 sections:
1. Header (logo + nav)
2. Hero (badge + headline + terminal snippet)
3. How It Works (3 steps)
4. Features (6 cards, AWS-only messaging)
5. Install CTA + minimal footer

Problems: AWS-only copy, no multi-cloud story, no code examples, no stats, no ecosystem section, minimal footer.

---

## Target: 9 Sections

```
┌─────────────────────────────────────────────────┐
│  1. HEADER                                       │
│     Logo   Features  CLI  Docs  GitHub   Sign In │
├─────────────────────────────────────────────────┤
│  2. HERO                                         │
│     Badge: "Multi-Cloud Infrastructure Platform" │
│     Headline + Subheadline                       │
│     Terminal snippet                             │
│     Provider logos: AWS | GCP | Azure             │
├─────────────────────────────────────────────────┤
│  3. HOW IT WORKS                                 │
│     Design → Bootstrap → Ship (3 columns)        │
├─────────────────────────────────────────────────┤
│  4. FEATURE CARDS                                │
│     3x3 grid of 9 feature cards                  │
├─────────────────────────────────────────────────┤
│  5. CODE EXAMPLES                                │
│     Tabbed terminal: Quick Start | Workflow | Worker │
├─────────────────────────────────────────────────┤
│  6. INFRASTRUCTURE STACK                         │
│     Grid: services per cloud (12 categories)     │
├─────────────────────────────────────────────────┤
│  7. STATS STRIP                                  │
│     3 Clouds | 11 Sections | 12 Components | ... │
├─────────────────────────────────────────────────┤
│  8. INSTALL CTA                                  │
│     brew install alethia + docs link               │
├─────────────────────────────────────────────────┤
│  9. FOOTER                                       │
│     Product | Developers | Community              │
│     Made by Borislav Borisov · Open Source         │
└─────────────────────────────────────────────────┘
```

---

## Section 1: Header

**Component**: Sticky top nav, transparent on hero, solid on scroll.

| Element | Content | Behavior |
|---------|---------|----------|
| Left | Trellis logo + wordmark | Link to `/` |
| Center nav | Features · CLI · Docs · GitHub | Anchor scroll for Features/CLI; external link for Docs (Vintner URL); external link for GitHub |
| Right | "Sign In" (unauthenticated) or "Dashboard" (authenticated) | Link to `/auth/signin` or `/dashboard` |

**Design notes**: Match ai-sdk.dev's clean header. No dropdown menus. Theme toggle optional (dark/light).

---

## Section 2: Hero

**Layout**: Centered text, terminal block below, provider strip at bottom.

### Badge
```
Multi-Cloud Infrastructure Platform
```
Small pill/badge above headline. Muted color.

### Headline
```
Configure in the browser.
Deploy from the terminal.
```
Large, bold, two lines. This is the core message.

### Subheadline
```
Design production infrastructure across AWS, GCP, and Azure with a visual form.
Deploy with a single CLI command. Zero credentials stored. GitOps by default.
```
Muted text, 1-2 sentences. Hits the three pillars: visual config, zero-credential, GitOps.

### Terminal Snippet
Dark terminal block with syntax highlighting:
```bash
$ brew install alethia
$ alethia login
  ✓ Authenticated as borislav@tovr.eu
$ alethia config create --provider aws
  ┌ Plant a Vine ─────────────────────┐
  │ Project:     api-backend          │
  │ Environment: production           │
  │ Region:      eu-west-1            │
  │ Cluster:     EKS 1.31             │
  │ Database:    Aurora PostgreSQL     │
  │ Cost:        ~$847/mo             │
  └───────────────────────────────────┘
$ alethia harvest
  ✓ 47 resources provisioned in 12m 34s
```

### CTA Buttons
| Button | Style | Link |
|--------|-------|------|
| "Get Started" | Primary (filled) | `/auth/signin` |
| "Read the Docs" | Secondary (outline) | Vintner docs URL |

### Provider Strip
Three cloud provider logos in a row below the CTA:
```
[AWS logo]  [GCP logo]  [Azure logo]
```
Muted/grayscale, small. Caption: "Full feature parity across all three clouds."

---

## Section 3: How It Works

**Layout**: 3 columns with step numbers, icons, and descriptions.

### Step 1: Design
- **Icon**: Form/layout icon
- **Title**: "Design in Trellis"
- **Description**: "Configure infrastructure with an 11-section guided form. Network, Kubernetes, databases, caches, messaging, DNS, secrets — all with real-time cost estimation. No YAML. No HCL."

### Step 2: Bootstrap
- **Icon**: Terminal/CLI icon
- **Title**: "Bootstrap with Alethia"
- **Description**: "One command provisions your entire stack. VPC, Kubernetes cluster, databases, ArgoCD — all generated as production Terraform and deployed by a secure worker in your cloud account."

### Step 3: Ship
- **Icon**: Rocket/deploy icon
- **Title**: "Ship with GitOps"
- **Description**: "ArgoCD is installed and configured automatically. Git is your source of truth. Infrastructure changes flow through plan, review, and apply — with full audit trail."

---

## Section 4: Feature Cards

**Layout**: 3x3 responsive grid. Each card has an icon, title, and 2-sentence description.

| # | Title | Icon | Description |
|---|-------|------|-------------|
| 1 | Multi-Cloud | Cloud icon | AWS, GCP, and Azure with full feature parity. Same form, three clouds — switch providers with a ribbon selector. |
| 2 | Visual Configuration | Layout icon | 11 infrastructure sections in a guided form. Network, cluster, databases, caches, NoSQL, messaging, DNS, secrets, registries, repos. |
| 3 | Zero-Credential Security | Shield icon | No static cloud keys stored. Cross-account IAM roles (AWS), Workload Identity Federation (GCP), Federated Identity (Azure). |
| 4 | GitOps by Default | Git icon | ArgoCD bootstrapped automatically. Git as audit trail. Plan-review-apply workflow for every change. |
| 5 | CLI + Web, Unified | Terminal icon | Same state, two interfaces. Design in the browser with the 11-section form or from the terminal with Alethia's interactive TUI. |
| 6 | Real-Time Cost Estimation | Dollar icon | See monthly cost as you configure. The sidebar updates with every form change. Powered by cloud pricing APIs and Infracost. |
| 7 | Worker-Based Execution | Server icon | Secure workers run in your cloud account. ECS Fargate or self-hosted. Job queue with real-time log streaming. |
| 8 | Interactive TUI | Sparkles icon | Alethia's CLI uses Charmbracelet forms — not flag soup. A 6-step wizard guides you through infrastructure design in the terminal. |
| 9 | Safe Teardown | Trash icon | Clean resource cleanup. Disable ArgoCD healing, drain load balancers, terraform destroy — no orphaned resources. |

---

## Section 5: Code Examples

**Layout**: Tab bar at top, syntax-highlighted terminal block below. Inspired by ai-sdk.dev's code showcase.

### Tab 1: Quick Start
```bash
# Install Alethia CLI
brew install alethia

# Authenticate with Trellis
alethia login

# Design infrastructure interactively
alethia config create

# Deploy to your cloud
alethia harvest
```

### Tab 2: Full Workflow
```bash
# Create a workspace
alethia vineyard create "production"

# Configure a complete stack (6-step TUI wizard)
alethia config create
  # Step 1: Vineyard & basics (name, region, provider)
  # Step 2: Platform (EKS/GKE/AKS, instance types, autoscaling)
  # Step 3: Git repositories
  # Step 4: Network & advanced (VPC, DNS, WAF)
  # Step 5: Data services (databases, caches, queues)
  # Step 6: Review with cost estimate

# Preview the Terraform plan
alethia harvest
  # ► 47 resources to create
  # ► Estimated cost: $847.23/mo
  # ► Confirm? (y/N)
```

### Tab 3: Worker Setup
```bash
# Register a worker with Trellis
alethia worker register --name "prod-worker" --mode cloud-hosted

# Start the worker daemon
alethia worker start
  # ✓ Connected to Trellis
  # ✓ Polling for jobs every 10s
  # ✓ Heartbeat every 30s

# Worker assumes cloud credentials at runtime
# No static keys. Short-lived sessions.
```

---

## Section 6: Infrastructure Stack

**Layout**: Grid showing supported services organized by category. Three columns (AWS / GCP / Azure) with cloud-native service names.

```
                  AWS                    GCP                     Azure
Container     ┌──────────┐         ┌──────────┐          ┌──────────┐
Orchestration │   EKS    │         │   GKE    │          │   AKS    │
              └──────────┘         └──────────┘          └──────────┘

Networking    ┌──────────┐         ┌──────────┐          ┌──────────┐
              │   VPC    │         │ VPC Net  │          │  VNet    │
              └──────────┘         └──────────┘          └──────────┘

Database      ┌──────────┐         ┌──────────┐          ┌──────────┐
              │  Aurora  │         │ CloudSQL │          │ Azure DB │
              └──────────┘         └──────────┘          └──────────┘

Cache         ┌──────────┐         ┌──────────┐          ┌──────────┐
              │ElastiCach│         │Memorystr │          │Azure Cach│
              └──────────┘         └──────────┘          └──────────┘

NoSQL         ┌──────────┐         ┌──────────┐          ┌──────────┐
              │ DynamoDB │         │Firestore │          │ CosmosDB │
              └──────────┘         └──────────┘          └──────────┘

Messaging     ┌──────────┐         ┌──────────┐          ┌──────────┐
              │ SQS/SNS  │         │ Pub/Sub  │          │ServiceBus│
              └──────────┘         └──────────┘          └──────────┘

DNS           ┌──────────┐         ┌──────────┐          ┌──────────┐
              │ Route 53 │         │Cloud DNS │          │Azure DNS │
              └──────────┘         └──────────┘          └──────────┘

Registry      ┌──────────┐         ┌──────────┐          ┌──────────┐
              │   ECR    │         │ Artifact │          │   ACR    │
              └──────────┘         └──────────┘          └──────────┘

Secrets       ┌──────────┐         ┌──────────┐          ┌──────────┐
              │ Secrets  │         │ Secret   │          │Key Vault │
              │ Manager  │         │ Manager  │          │          │
              └──────────┘         └──────────┘          └──────────┘
```

**Design**: Clean grid with subtle borders. Cloud provider logos as column headers. Service logos or icons for each cell. Purpose: show breadth and cloud-native depth.

Plus a row at the bottom for cross-cutting tools:
```
Terraform    ArgoCD    Helm    Infracost
```

---

## Section 7: Stats Strip

**Layout**: Horizontal row of 4 highlighted numbers. Centered, large font.

| Stat | Value | Label |
|------|-------|-------|
| Cloud Providers | **3** | AWS, GCP, Azure |
| Infrastructure Sections | **11** | In the Plant a Vine form |
| CLI Commands | **16** | Shipped in Alethia |
| Git Providers | **3** | GitHub, GitLab, Bitbucket |

**Design**: Similar to ai-sdk.dev's stats strip (13M downloads, 24.6K stars, etc.). Bold number, small label below.

---

## Section 8: Install CTA

**Layout**: Centered, dark background block.

### Headline
```
Get started in under a minute.
```

### Terminal Block
```bash
brew install alethia && alethia login
```
With copy button.

### Secondary
```
Or design your infrastructure visually at trellis.tovr.eu
```

### Links
| Link | Destination |
|------|-------------|
| "Read the Documentation" | Vintner docs URL |
| "View on GitHub" | GitHub repository URL |

---

## Section 9: Footer

**Layout**: Multi-column footer with branding. Matches ai-sdk.dev's comprehensive footer style.

### Columns

**Product**
- Features (anchor: #features)
- CLI Reference (anchor: #cli)
- Dashboard (link: /dashboard)
- Pricing (link: future, or omit)

**Developers**
- Documentation (external: Vintner URL)
- GitHub (external: repository URL)
- API Reference (link: future, or omit)
- Changelog (link: future, or omit)

**Community**
- Open Source (external: GitHub)
- Contributing (external: GitHub contributing guide)

### Bottom Bar
```
© 2026 Trellis                    Made by Borislav Borisov · Open Source
```

Left: copyright. Right: attribution per requirement.

---

## Technical Implementation Notes

### File structure
The landing page currently lives at `apps/trellis/app/page.tsx`. For the expanded 9-section page, extract each section into its own component:

```
apps/trellis/components/landing/
  header.tsx
  hero.tsx
  how-it-works.tsx
  feature-cards.tsx
  code-examples.tsx
  infrastructure-stack.tsx
  stats-strip.tsx
  install-cta.tsx
  footer.tsx
```

### Existing components to reuse
- `@/components/ui/badge` — for hero badge
- `@/components/ui/button` — for CTAs
- `@/components/ui/card` — for feature cards
- `@/components/ui/tabs` — for code examples section

### Design system
- Follow existing Tailwind + shadcn/ui patterns from the Trellis app
- Dark hero background with light text (current pattern)
- Card-based sections on light/neutral background
- Responsive: full grid on desktop, stacked on mobile

### Data sources
- Provider data: hardcoded (3 providers, stable)
- Stats: hardcoded (change infrequently)
- Code examples: static strings
- No server-side data fetching needed for the landing page

### Animation considerations
- Subtle fade-in on scroll for sections (intersection observer)
- Terminal typing animation for hero snippet (optional, adds delight)
- Provider logo hover effects (optional)
- Keep it fast — no heavy animation libraries
