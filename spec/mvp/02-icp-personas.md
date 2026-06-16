# 02 — ICP & Personas

## Ideal Customer Profile

**Engineering teams (≈10–150 engineers, 0–2 dedicated platform engineers) who need to own their infrastructure stack** — for security, compliance, cost, or principle — and refuse to hand their cloud keys to a hosted SaaS or lock into one cloud.

Two converging pulls bring them to Alethia:
- **Pull-in:** they need production clusters + day-2 ops without a platform team (the platform-eng tax).
- **Pull-away:** a hosted PaaS (Qovery/Porter/Northflank) or IaC SaaS (Terraform Cloud/Spacelift) wants their credentials and/or runs only on the vendor's control plane.

Sovereignty/data-residency is a strong **buying trigger** for a subset — not the whole thesis. Ownership + zero-trust + open source is.

## Personas

### 1. The Platform / DevOps Engineer — *the user & champion*
Owns provisioning and day-2 for many app teams. Wants self-service infra without handing everyone Terraform or admin keys. **Jobs:** stand up clusters fast, keep credentials safe, not babysit YAML. **Why Alethia:** visual Spec + `alethia` CLI sharing state, zero stored credentials, GitOps by default, runs in their own account. **Objection:** "is this just another abstraction over Terraform?" → No — it generates real OpenTofu you own.

### 2. The Self-Hosting / Security / Compliance Buyer — *the economic & gatekeeper buyer*
CTO, head of security, or compliance lead who **cannot** put cloud keys in a third-party SaaS or must keep the control plane in-house (regulated data, air-gapped, sovereignty, procurement clause). **Jobs:** pass the audit, own the control plane, avoid extraterritorial/SaaS exposure. **Why Alethia:** AGPL self-host as ~4 containers, zero-credential model, enterprise SSO/RBAC/audit in `ee/`. **Trigger:** a new self-hosting/residency requirement, a credential-security audit, or a customer DPA clause.

### 3. The Cost / Lock-in Owner — *the founder-CTO / budget owner*
Feels the cloud bill and the lock-in. **Jobs:** cut spend, keep optionality across clouds. **Why Alethia:** multi-cloud + self-managed cluster strategies (cheap providers), real-time Infracost, no per-seat hosted-PaaS markup, no vendor lock-in. **Trigger:** a cloud bill spike or a re-platforming decision.

## Anti-personas (say no early)
- Teams happy to hand a hosted PaaS their keys for max convenience and zero ops — they'll find Alethia's ownership a cost, not a benefit.
- Pure hobbyists wanting one app on a single managed cluster — over-served.
- Hard-regulated buyers needing certifications (SOC2/SecNumCloud) a young company can't yet provide — court later via partners.

## Buying triggers (what to watch for in outbound)
- A self-hosting / data-residency / "no third-party holds our keys" requirement appears.
- A credential-leak incident or a security audit flags stored cloud keys.
- Cloud bill outgrows revenue; lock-in blocks a multi-cloud move.
- The platform team is 0–2 people serving many app teams (the tax is acute).

## Where they are
Hetzner/r/kubernetes/r/devops communities, the Talos/Cluster-API ecosystem, EU founder/CTO networks, GitOps/ArgoCD and OpenTofu communities, and the self-hosting (`r/selfhosted`, awesome-selfhosted) crowd.
