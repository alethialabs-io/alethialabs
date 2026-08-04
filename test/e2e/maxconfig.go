// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The MAX-CONFIG surface — one legible table that IS the answer to "what are the 11 kinds,
// and what does each one become on each of the five clouds?"
//
// The maintainer's FULLY-TESTED bar requires a real apply that provisions EVERY resource kind a
// managed cloud supports (apps/console/lib/cloud-providers/unsupported-kinds.ts: cluster · network ·
// database · cache · queue · topic · nosql · dns · secrets · bucket · registry). The base T2 deploy
// snapshot (t2BaseSnapshot) populates only add-ons — every kind array is empty — so a real apply
// proves cluster+network and NOTHING else.
//
// Rather than hand-author another opaque config_snapshot JSON blob, the whole surface lives in ONE
// slice below: MaxConfigKinds. Read it and you know, per kind, (a) the ProjectConfig field that
// populates it, and (b) per CLOUD, one MaxConfigCell carrying the verdict for that (kind × cloud)
// pair: the tfvars a provider MUST emit — proven FREE, every-PR, by maxconfig_pure_test.go against
// the real cloud.ProviderTfvars — and the tofu resource a real apply MUST create, asserted in the
// maintainer-gated nightly (t2_provision_test.go). No generated blob, no drift from a second source
// of truth: the table is typed against the ProjectConfig struct the runner actually consumes, so a
// schema change is a compile error here.
//
// WHY THE CELL IS A TYPED VERDICT AND NOT A BARE RESOURCE STRING. The table used to carry
// AWSResource/GCPResource/AzureResource and nothing else, and ResourceFor() returned "" for every
// other cloud. AssertMaxConfigKindsInState reported those cells as "unmapped" with a t.Logf and
// then logged "all mapped kinds present" anyway — so a hetzner or alibaba max-config run asserted
// ZERO of its 11 kinds and printed a success line. Twenty-two cells were structurally unassertable
// and read as merely pending. MaxConfigCarriage closes that escape: every cell states one of four
// verdicts, its zero value is INVALID, and an unhandled (kind, cloud) pair is now a hard error.
//
// The four verdicts are two ways of being PROVEN (CarriedByTofu, CarriedInCluster) and two ways of
// being EXCLUDED (CloudCeiling, DeferredInProduct). The exclusions are kept apart because they are
// different facts: a ceiling is about the cloud, deferral is about us, and a shared reason string
// once let two chart-backed kinds on hetzner claim "no chart or cloud service backs it" while the
// charts that back them were installing in the same run.
//
// Opt-in via ALETHIA_E2E_MAX_CONFIG=1 (the nightly turns it on together with ALETHIA_E2E_ALL_ADDONS
// and a heavy node shape): all 11 kinds + all 18 add-ons need a node sized for them, so the lean
// default tier stays fast and cheap.

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/compat"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// MaxConfigCarriage is HOW one cloud delivers one kind — the verdict for a (kind × cloud) cell.
// A closed set of exactly four; the zero value is deliberately NOT one of them, so a cell nobody
// filled in fails loudly instead of reading as "pending" (the defect this type exists to kill).
type MaxConfigCarriage string

const (
	// CarriedByTofu — the cloud's own IaC creates a resource for this kind, and a real apply must
	// leave a countable instance of MaxConfigCell.Resource in the deploy's tofu state.
	CarriedByTofu MaxConfigCarriage = "tofu"
	// CarriedInCluster — the kind is genuinely DELIVERED, but not by cloud IaC: it is an in-cluster
	// chart the runner installs as an ArgoCD Application. Nothing lands in tofu state, so the proof
	// is MaxConfigCell.ArgoApp reaching Healthy+Synced under the ArgoCD gate — asserted, never
	// assumed. (Hetzner's database/cache/queue: apps/console/lib/cloud-providers/hetzner-services.ts.)
	CarriedInCluster MaxConfigCarriage = "in_cluster"
	// CloudCeiling — the cloud genuinely cannot offer this kind: it has no such service, AND nothing
	// in this repo backs the kind in-cluster either. The product says so — the canvas hides it and
	// the deploy action rejects it (UNSUPPORTED_KINDS_BY_PROVIDER) — and the reason lives in
	// MaxConfigCell.Why, so it is a documented exclusion and never a silent gap ([[cloud-parity-rule]]).
	//
	// Read the second half of that sentence literally. "The cloud cannot" is a fact about the CLOUD;
	// if a chart in this repo demonstrably delivers the kind and is merely not wired to it, that is a
	// fact about US and the verdict is DeferredInProduct instead.
	CloudCeiling MaxConfigCarriage = "ceiling"
	// DeferredInProduct — the product does not offer this kind on this cloud today, exactly as for a
	// CloudCeiling (hidden on the canvas, rejected at deploy), but for a DIFFERENT reason: a chart
	// this repo already ships demonstrably backs the kind, and the missing piece is the mapping. That
	// is DEBT, not a ceiling, and it must read as debt.
	//
	// The distinction is not pedantry. It used to be one shared "the cloud does not offer this kind …
	// no chart or cloud service backs it" reason string on all four of Hetzner's excluded kinds, with
	// "(Vault is a marketplace add-on…)" and "(Harbor is a marketplace add-on…)" appended to two of
	// them — a sentence contradicting its own parenthesis. The table's own semantics made it
	// incoherent too: database/cache/queue establish that an in-cluster chart IS delivery on this
	// cloud, so "a chart exists but isn't wired" cannot simultaneously mean the cloud cannot offer it.
	// A ceiling is closed; debt is a backlog item, and burying one inside the other is how it stops
	// being counted. MaxConfigCell.Chart must name the chart, so the debt cannot be asserted vaguely.
	DeferredInProduct MaxConfigCarriage = "deferred"
)

// MaxConfigCell is ONE (kind × cloud) verdict. Build it with tofuCell / inClusterCell /
// ceilingCell so the field combination can never be half-filled; Validate is the read-back.
type MaxConfigCell struct {
	// Carriage is the verdict. Empty = the cell was never filled in ⇒ a hard error, not a skip.
	Carriage MaxConfigCarriage
	// Signals are the tfvar keys that must be present AND meaningful (truthy / non-empty) when this
	// kind is populated. For the nine optional kinds they are also the negative-test discriminators
	// (drop the kind ⇒ the signal goes empty), except where a row's comment says otherwise.
	// CarriedByTofu only — an in-cluster kind reaches no tfvar and a ceiling emits nothing.
	Signals []string
	// Resource is the tofu resource type a real apply must create, counted structurally in the
	// deploy's state. CarriedByTofu only. (Several kinds route through registry modules; state
	// carries the concrete type regardless of module nesting.)
	Resource string
	// ArgoApp is the ArgoCD Application name that proves an in-cluster kind actually converged
	// (packages/core/argocd.AddOnAppName = "addon-" + the install spec's id). CarriedInCluster only.
	ArgoApp string
	// Chart names the chart this repo already ships that demonstrably backs the kind, and which the
	// product has simply not wired to it. Required for DeferredInProduct and forbidden elsewhere:
	// it is the evidence that turns "we haven't got round to it" into a debt item somebody can pick
	// up, and requiring it stops the verdict from becoming a softer synonym for CloudCeiling.
	Chart string
	// Why is the documented reason for a non-tofu verdict. Required for CarriedInCluster,
	// CloudCeiling and DeferredInProduct: an exclusion nobody can read is indistinguishable from an
	// oversight.
	Why string
}

// tofuCell declares a cell the cloud's IaC provisions: the state resource type plus the tfvar
// signals that carry the kind into the template.
func tofuCell(resource string, signals ...string) MaxConfigCell {
	return MaxConfigCell{Carriage: CarriedByTofu, Resource: resource, Signals: signals}
}

// inClusterCell declares a cell delivered by an in-cluster chart rather than cloud IaC, naming the
// ArgoCD Application that proves it and the reason it is not a tofu resource.
func inClusterCell(argoApp, why string) MaxConfigCell {
	return MaxConfigCell{Carriage: CarriedInCluster, ArgoApp: argoApp, Why: why}
}

// ceilingCell declares a documented ceiling — the cloud does not offer this kind at all, and
// nothing in this repo backs it in-cluster either.
func ceilingCell(why string) MaxConfigCell {
	return MaxConfigCell{Carriage: CloudCeiling, Why: why}
}

// deferredCell declares DEBT: the kind is hidden and rejected today, but `chart` — a chart this repo
// already ships — backs it, so what is missing is the mapping, not a capability.
func deferredCell(chart, why string) MaxConfigCell {
	return MaxConfigCell{Carriage: DeferredInProduct, Chart: chart, Why: why}
}

// Offered reports whether this cloud actually delivers the kind — i.e. whether the max-config
// fixture should populate it and the real-apply assertion should look for it. The two exclusion
// verdicts differ in WHY they exclude, never in what the harness does about them, so every "is this
// kind seeded / asserted?" decision asks this rather than testing a carriage by name (which is how a
// fourth verdict would otherwise have to be chased through five call sites).
func (c MaxConfigCell) Offered() bool {
	return c.Carriage == CarriedByTofu || c.Carriage == CarriedInCluster
}

// Validate reports why this cell is not a well-formed verdict (nil = it is). The invariants are
// what stop a half-filled cell from re-creating the empty-string escape: a tofu cell with no
// resource type would count nothing, an in-cluster cell with no Application would assert nothing,
// and a ceiling with no reason is an oversight wearing a verdict's clothes.
func (c MaxConfigCell) Validate() error {
	if c.Chart != "" && c.Carriage != DeferredInProduct {
		return fmt.Errorf("carriage %q must not name a Chart (%q) — only %q does, because only there is the chart's existence the whole claim",
			c.Carriage, c.Chart, DeferredInProduct)
	}
	switch c.Carriage {
	case CarriedByTofu:
		if c.Resource == "" {
			return fmt.Errorf("carriage %q needs a tofu Resource type to count in state", c.Carriage)
		}
		if len(c.Signals) == 0 {
			return fmt.Errorf("carriage %q needs at least one tfvar Signal — an unsignalled kind never reaches the template", c.Carriage)
		}
		if c.ArgoApp != "" {
			return fmt.Errorf("carriage %q must not name an ArgoApp (%q) — pick one carriage", c.Carriage, c.ArgoApp)
		}
	case CarriedInCluster:
		if c.ArgoApp == "" {
			return fmt.Errorf("carriage %q needs the ArgoCD Application name that proves it converged", c.Carriage)
		}
		if c.Resource != "" || len(c.Signals) > 0 {
			return fmt.Errorf("carriage %q must not name a tofu Resource/Signals — an in-cluster chart reaches neither", c.Carriage)
		}
		if c.Why == "" {
			return fmt.Errorf("carriage %q needs a Why — why cloud IaC does not carry it", c.Carriage)
		}
	case CloudCeiling:
		if c.Resource != "" || c.ArgoApp != "" || len(c.Signals) > 0 {
			return fmt.Errorf("carriage %q must be empty of Resource/ArgoApp/Signals — the cloud provisions nothing", c.Carriage)
		}
		if c.Why == "" {
			return fmt.Errorf("carriage %q needs a Why — a ceiling without a documented reason is a silent gap", c.Carriage)
		}
	case DeferredInProduct:
		if c.Resource != "" || c.ArgoApp != "" || len(c.Signals) > 0 {
			return fmt.Errorf("carriage %q must be empty of Resource/ArgoApp/Signals — the kind is rejected at deploy, so nothing is provisioned to assert", c.Carriage)
		}
		if c.Chart == "" {
			return fmt.Errorf("carriage %q needs a Chart — the claim IS that a shipped chart backs this kind, so an unnamed one makes it indistinguishable from %q",
				c.Carriage, CloudCeiling)
		}
		if c.Why == "" {
			return fmt.Errorf("carriage %q needs a Why — undocumented debt is a silent gap wearing a verdict's clothes", c.Carriage)
		}
	case "":
		return fmt.Errorf("no carriage: every (kind × cloud) cell must state a verdict — %q, %q, %q or %q. "+
			"An empty cell used to read as \"unmapped\" and was silently skipped, which is the defect this type exists to prevent",
			CarriedByTofu, CarriedInCluster, CloudCeiling, DeferredInProduct)
	default:
		return fmt.Errorf("unknown carriage %q", c.Carriage)
	}
	return nil
}

// MaxConfigKind declares ONE resource kind end to end, across every cloud.
type MaxConfigKind struct {
	// Kind is the canonical kind slug (matches unsupported-kinds.ts / the canvas NodeKind).
	Kind string
	// Doc is one line: what this kind is, plus any gotcha worth stating in place.
	Doc string
	// Foundational marks the two kinds every cluster must have (network, cluster). They are
	// asserted POSITIVELY only — "dropping" them from a max-config is nonsensical, and their
	// signals are not kind-exclusive (a VPC is provisioned even when no network block is given).
	// The nine optional kinds each carry a LOUD negative test instead (see the pure test).
	Foundational bool
	// Apply populates this kind on the shared max-config ProjectConfig (the typed source of truth).
	// It takes the target provider so the three shape-bearing kinds (cluster/database/cache) can emit
	// provider-VALID literals — the cloud provider passes instance/tier/version values through
	// verbatim, so AWS shapes (m5.large, db.r6g.large, 16.6) would fail a real GKE/Cloud SQL/ACK
	// apply. The other eight kinds are provider-agnostic (names/booleans) and ignore the argument.
	Apply func(pc *types.ProjectConfig, provider string)
	// Populated reports whether Apply actually took — the fail-closed guard in MaxConfigSnapshot
	// (a max-config run that silently drops a kind is the exact vacuous proof the bar forbids).
	Populated func(pc *types.ProjectConfig) bool

	// ── the per-cloud columns. Adding a cloud is a field here plus one row value per kind. ──

	// AWS is the AWS verdict for this kind (confirmed against infra/templates/project/aws/**).
	AWS MaxConfigCell
	// GCP is the GCP verdict (infra/templates/project/gcp/**). NOTE: queue and topic share
	// create_pubsub / pubsub_topics (both fold into the pubsub_topics map) and both map to
	// google_pubsub_topic, so they are NOT kind-exclusive — the negative test discriminates via the
	// pubsub_topics MAP KEY ("jobs"/"events"), and the per-kind state count cannot tell them apart.
	GCP MaxConfigCell
	// Azure is the Azure verdict (infra/templates/project/azure/**). UNLIKE GCP, Azure emits
	// DISTINCT service_bus_queues and service_bus_topics maps, so all nine optional kinds are
	// cleanly isolable and the negative test is a plain drop-and-check.
	Azure MaxConfigCell
	// Hetzner is the Hetzner/Talos verdict (infra/templates/project/hetzner/**). Hetzner is the one
	// cloud that uses all three carriages: it is a compute cloud with a real network/DNS/Object-
	// Storage API, three data services delivered as in-cluster charts, and four kinds it genuinely
	// does not have. The template renders NO helm_release at all (only `data "helm_template"`), so
	// nothing in-cluster is ever visible in tofu state.
	Hetzner MaxConfigCell
	// Alibaba is the Alibaba/ACK verdict (infra/templates/project/alibaba/**). A full managed stack:
	// all 11 kinds are CarriedByTofu. NOTE: create_mns is shared by queue and topic (the same shape
	// as GCP's create_pubsub), so the signals are the DISTINCT mns_queues / mns_topics maps — and
	// unlike GCP the two resource types differ, so state can tell them apart.
	Alibaba MaxConfigCell
}

// Cell returns the (kind × cloud) verdict for provider. ok=false means this cloud has NO column —
// the caller must fail, never skip: a cloud the table cannot describe is a cloud the harness cannot
// prove anything about.
func (k MaxConfigKind) Cell(provider string) (MaxConfigCell, bool) {
	switch provider {
	case "aws":
		return k.AWS, true
	case "gcp":
		return k.GCP, true
	case "azure":
		return k.Azure, true
	case "hetzner":
		return k.Hetzner, true
	case "alibaba":
		return k.Alibaba, true
	}
	return MaxConfigCell{}, false
}

// The component names the max-config fixture uses. They are constants because Hetzner's in-cluster
// ArgoCD Application names are DERIVED from them ("addon-db-<name>", hetzner-services.ts), so
// renaming a component here moves the assertion with it instead of leaving a hand-synced literal
// that silently stops matching.
const (
	maxConfigDatabaseName = "appdb"
	maxConfigCacheName    = "sessions"
	maxConfigQueueName    = "jobs"
	maxConfigTopicName    = "events"
)

// hetznerNoManagedService is the shared reason for Hetzner's three in-cluster data services: the
// template renders no helm_release (see cilium.tf's note on `tofu plan -out`), so these arrive as
// ArgoCD Applications synthesized by the console and applied by the runner. The harness seeds the
// same specs, from the generated fixture — see hetzner_data_services.go.
const hetznerNoManagedService = "Hetzner has no managed equivalent; the console synthesizes an in-cluster chart " +
	"(hetzner-services.ts) which the runner installs as an ArgoCD Application — nothing reaches tofu state"

// hetznerKindHiddenAndRejected is what is TRUE of all four of Hetzner's excluded kinds, and only
// that: the canvas hides them and the deploy action rejects them outright
// (UNSUPPORTED_KINDS_BY_PROVIDER.hetzner = ["topic","nosql","registry","secret"],
// apps/console/lib/cloud-providers/unsupported-kinds.ts). It deliberately does NOT say why — the two
// whys are different verdicts, and one shared sentence claiming "no chart or cloud service backs it"
// was false for two of the four cells that used it.
const hetznerKindHiddenAndRejected = "hidden on the canvas and REJECTED at deploy " +
	"(unsupported-kinds.ts UNSUPPORTED_KINDS_BY_PROVIDER.hetzner)"

// hetznerNoServiceNoChart is the CEILING reason — the strong claim, made only where it holds:
// Hetzner has no such cloud service, and no chart in this repo is offered for the kind either.
// unsupported-kinds.ts states it for exactly these two: "topic (SNS) and nosql (DynamoDB) have no
// clean single-chart OSS equal and are deferred (hidden on the canvas)".
const hetznerNoServiceNoChart = "Hetzner has no such service, and this repo offers no chart for the kind either " +
	"(unsupported-kinds.ts: \"no clean single-chart OSS equal\") — " + hetznerKindHiddenAndRejected

// hetznerChartExistsNotWired is the DEBT reason, for the two kinds a shipped marketplace chart
// demonstrably delivers and the product has simply not mapped. unsupported-kinds.ts says both parts
// itself — "the Harbor marketplace add-on covers registry in-cluster", and of `secret`: "In-cluster
// secrets (Vault add-on + an ESO ClusterSecretStore over a Vault backend) is a real feature with its
// own init/unseal design, not a silent no-op; until it lands, reject the kind honestly." "Until it
// lands" is the definition of debt, and it is what the old shared ceiling sentence hid.
const hetznerChartExistsNotWired = "Hetzner has no cloud service for this kind, but a chart in the marketplace catalog " +
	"DOES back it — it is simply not mapped to the kind, so this is DEBT, not a ceiling. Today the kind is " +
	hetznerKindHiddenAndRejected

// MaxConfigKinds is the full 11-kind surface across all five clouds. Adding a cloud is a per-cloud
// column plus a row value — never a new opaque artifact.
var MaxConfigKinds = []MaxConfigKind{
	{
		Kind:         "network",
		Doc:          "the VPC/network the cluster lives in — provisioned in-template.",
		Foundational: true,
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.Network = types.ProjectNetworkConfig{ProvisionNetwork: true, CIDRBlock: "10.0.0.0/16", SingleNatGateway: true}
		},
		Populated: func(pc *types.ProjectConfig) bool { return pc.Network.ProvisionNetwork },
		AWS:       tofuCell("aws_vpc", "provision_vpc", "vpc_cidr"),
		GCP:       tofuCell("google_compute_network", "provision_network", "network_cidr"),
		// Azure: provision_vnet is forced true when no NetworkID is brought; vnet_cidr always carries
		// a value. Foundational ⇒ positive-only, so non-kind-exclusivity is fine.
		Azure: tofuCell("azurerm_virtual_network", "provision_vnet", "vnet_cidr"),
		// Hetzner: hcloud_network is created on the greenfield path (provision_network); the subnet
		// resource exists on both paths, so the NETWORK is the discriminating resource.
		Hetzner: tofuCell("hcloud_network", "provision_network", "network_cidr"),
		Alibaba: tofuCell("alicloud_vpc", "provision_network", "network_cidr"),
	},
	{
		Kind:         "cluster",
		Doc:          "the Kubernetes cluster (EKS/GKE/AKS/ACK — and self-managed Talos on Hetzner).",
		Foundational: true,
		Apply: func(pc *types.ProjectConfig, provider string) {
			disk := 50
			// The k8s minor comes from the compat matrix, NEVER a literal. Every managed cloud
			// retires old minors on its own schedule — GKE delists them (1.32 is already gone), an
			// aged version fails an AKS create with K8sVersionNotSupported, and EKS is guarded
			// fail-closed by COMPAT-001 (infra/templates/project/<cloud>/checks_compat.tf) against
			// this same matrix. A hardcoded version therefore rots silently: it was bumped for gcp
			// and azure as each cloud rejected it, and left stale for aws/alibaba/hetzner until the
			// aws apply gate caught it (#1259). Tracking matrix.json's own default keeps the harness
			// and the gate in lockstep by construction; TestMaxConfigClusterVersionTracksMatrix
			// fails on every PR if they ever diverge again. (Hetzner DISCARDS ClusterVersion — Talos
			// installs the version verbatim as an image tag and needs a concrete patch — so the
			// matrix value is inert there, not wrong.)
			k8sCloud, ok := compat.MustLoad().Cloud(provider)
			if !ok {
				// No silent fallback: a provider the matrix has no data for must be loud, not
				// quietly provisioned on someone else's version.
				panic(fmt.Sprintf("maxconfig: compat matrix has no k8s_cloud entry for provider %q", provider))
			}
			// instanceTypes stay per-cloud — these are genuinely cloud-specific SKUs (m5.large is an
			// EC2 type both GKE and AKS reject), unlike the version. Every literal here is a value
			// the product catalog actually offers (packages/core/catalog/catalog.json `compute`), so
			// the harness never proves a shape the console cannot emit.
			instanceTypes := []string{"m5.large"}
			switch provider {
			case "gcp":
				instanceTypes = []string{"e2-standard-2"}
			case "azure":
				instanceTypes = []string{"Standard_D2s_v3"}
			case "hetzner":
				// cx33 (x86, 4 vCPU/8 GB). NOT a cax* type: those are Ampere ARM, hetznerServerArch
				// flips the whole Talos image to arm64, and a chart shipping an amd64-only image then
				// CrashLoops — the fleet runner-arch churn class. m5.large used to land here and be
				// passed straight to hcloud_server.server_type, which is not a Hetzner SKU at all.
				instanceTypes = []string{"cx33"}
			case "alibaba":
				// ecs.g6.large (2 vCPU/8 GB) — the catalog default, ACK's analogue of e2-standard-2.
				// m5.large used to land in ack_instance_types, which ACK rejects.
				instanceTypes = []string{"ecs.g6.large"}
			}
			pc.Cluster = types.ProjectClusterConfig{
				ClusterVersion:  k8sCloud.Default,
				InstanceTypes:   instanceTypes,
				NodeMinSize:     2,
				NodeMaxSize:     5,
				NodeDesiredSize: 2,
				NodeDiskSizeGB:  &disk,
				ClusterAdmins:   []any{},
				ProviderConfig:  map[string]any{},
			}
		},
		Populated: func(pc *types.ProjectConfig) bool {
			return len(pc.Cluster.InstanceTypes) > 0 || pc.Cluster.NodeSize != nil
		},
		AWS: tofuCell("aws_eks_cluster", "eks_instance_types", "eks_ng_desired_size"),
		GCP: tofuCell("google_container_cluster", "provision_gke", "gke_instance_types"),
		// Azure: aks_instance_types / aks_node_desired_size are added only when the cluster block is
		// populated (kind-exclusive), unlike the always-true provision_aks bool.
		Azure: tofuCell("azurerm_kubernetes_cluster", "aks_instance_types", "aks_node_desired_size"),
		// Hetzner: there is no managed-cluster resource. talos_machine_bootstrap is the exactly-one
		// "the control plane came up" resource — hcloud_server counts nodes, and talos_cluster_kubeconfig
		// is produced by the same bootstrap, so the bootstrap is the honest cluster proof.
		//
		// ⚠️ THE SIGNALS BELOW ARE UNCONDITIONAL, unlike azure's and alibaba's above — and that is
		// stated here rather than left for a reader to discover. hetznerProvider.ProviderTfvars emits
		// all four on every call with defaults (worker_count ⇒ 1, worker_server_type ⇒ "cpx22",
		// control_plane_count ⇒ 1, control_plane_server_type ⇒ the resolved worker type), so this
		// cell's positive proof would pass on an EMPTY Cluster block. Azure and Alibaba route around
		// exactly that trap by picking their conditionally-emitted node-shape keys; hetzner has no such
		// key to pick, because there is no "provision the cluster" toggle at all — a Talos deploy IS
		// the cluster, so every cluster tfvar is always present.
		//
		// Tolerated, not overlooked, for two reasons: `cluster` is Foundational, so no negative test
		// depends on these being kind-exclusive (dropping the cluster from a max-config is nonsensical
		// — the same reason `network` is exempt); and the load-bearing proof is the tofu Resource, not
		// the signals — talos_machine_bootstrap cannot appear in state without a control plane that
		// actually bootstrapped. If Hetzner ever gains a conditionally-emitted cluster tfvar, prefer it.
		Hetzner: tofuCell("talos_machine_bootstrap", "worker_count", "worker_server_type", "control_plane_count", "control_plane_server_type"),
		// Alibaba: provision_ack is HARDCODED true in alibaba_provider.go (the same trap as Azure's
		// provision_aks), so the signals are the two conditionally-emitted node-shape keys.
		Alibaba: tofuCell("alicloud_cs_managed_kubernetes", "ack_instance_types", "ack_node_desired_size"),
	},
	{
		Kind: "database",
		Doc:  "a managed SQL database. NOTE: AWS reads only databases[0] — one entry exercises the kind.",
		Apply: func(pc *types.ProjectConfig, provider string) {
			min, max := 0.5, 4.0
			port, backup := 5432, 7
			iam := true
			// Aurora takes a FULL minor, and it must be one AWS still offers — pinning a withdrawn
			// one fails the apply outright ("Cannot find version 16.6 for aurora-postgresql", the
			// break this constant was introduced to end). Sourced from packages/core/cloud so the
			// nightly can never test a version the provisioner does not default to.
			engineVersion, instanceClass := cloud.DefaultAuroraPostgresVersion, "db.r6g.large"
			switch provider {
			case "gcp":
				// Cloud SQL composes POSTGRES_<version> — bare "16" is valid, a full minor is not;
				// and db.r6g.large is an RDS class (Cloud SQL wants a db-* tier).
				engineVersion, instanceClass = "16", "db-f1-micro"
			case "azure":
				// PostgreSQL Flexible Server takes a bare major version ("16") and a B_/GP_/MO_ SKU
				// name — a full minor and the RDS class db.r6g.large are both rejected.
				engineVersion, instanceClass = "16", "B_Standard_B1ms"
			case "alibaba":
				// ApsaraDB RDS PostgreSQL versions are MAJOR.0 ("16.0" — catalog `database.alibaba`
				// offers 17.0/16.0/15.0/14.0, and nothing else), and the instance class is an
				// ApsaraDB class, not an RDS one. pg.n2.small.2c is the template's own default
				// (infra/templates/project/alibaba/variables.tf rds_instance_type).
				engineVersion, instanceClass = "16.0", "pg.n2.small.2c"
			case "hetzner":
				// Hetzner's database is CloudNativePG in-cluster: engine_version becomes the CNPG
				// image TAG (ghcr.io/cloudnative-pg/postgresql:<v>) and there is no instance class at
				// all — sizing is storage GiB + replicas. Emitting an RDS class here would be a
				// literal that no code path can consume.
				engineVersion, instanceClass = "16", ""
			}
			pc.Databases = []types.ProjectDatabaseConfig{{
				Name: maxConfigDatabaseName, EngineFamily: "postgres", EngineVersion: engineVersion,
				InstanceClass: instanceClass, MinCapacity: &min, MaxCapacity: &max,
				Port: &port, BackupRetentionDays: &backup, IamAuth: &iam,
			}}
		},
		Populated: func(pc *types.ProjectConfig) bool { return len(pc.Databases) > 0 },
		AWS:       tofuCell("aws_rds_cluster", "create_rds", "rds_config"),
		GCP:       tofuCell("google_sql_database_instance", "create_cloud_sql"),
		Azure:     tofuCell("azurerm_postgresql_flexible_server", "create_azure_db"),
		// Hetzner: CloudNativePG. Two Applications land — addon-cnpg-operator (sync-wave 0, the CRD
		// the Cluster CR needs) and addon-db-<name> (sync-wave 1, the Cluster itself). The per-database
		// one is the assertion: the operator alone proves an operator, not a database.
		Hetzner: inClusterCell("addon-db-"+maxConfigDatabaseName, hetznerNoManagedService+" (CloudNativePG `cluster` chart, behind addon-cnpg-operator)"),
		Alibaba: tofuCell("alicloud_db_instance", "create_rds"),
	},
	{
		Kind: "cache",
		Doc:  "a managed Redis/Valkey cache. NOTE: AWS reads only caches[0].",
		Apply: func(pc *types.ProjectConfig, provider string) {
			nodes := 2
			multiAz := true
			cache := types.ProjectCacheConfig{
				Name: maxConfigCacheName, EngineVersion: "7.1", NodeType: "cache.t3.medium",
				NumCacheNodes: &nodes, MultiAz: &multiAz,
			}
			switch provider {
			case "gcp":
				// ElastiCache values break Memorystore (redis version "7.1" wants the enum
				// REDIS_7_0; cache.t3.medium is not a Memorystore type). Leave both empty so the
				// template's valid defaults apply; NumCacheNodes>1 ⇒ the STANDARD_HA tier. The
				// ProjectConfig↔Memorystore shape wiring (memory-size/tier vs the emitted
				// memorystore_instance_type) is a tracked gap — see #1085.
				cache = types.ProjectCacheConfig{Name: maxConfigCacheName, NumCacheNodes: &nodes, MultiAz: &multiAz}
			case "azure":
				// azurerm_managed_redis has no version/family/capacity args (default_database block),
				// so redis "7.1" and cache.t3.medium have no mapping. Leave both empty: NumCacheNodes>1
				// ⇒ azure_cache_sku="Standard" ⇒ the template resolves Balanced_B1 (a valid Managed-
				// Redis SKU; floor Balanced_B0). The ProjectConfig NodeType↔Managed-Redis SKU wiring is
				// a tracked gap — see #1091.
				cache = types.ProjectCacheConfig{Name: maxConfigCacheName, NumCacheNodes: &nodes, MultiAz: &multiAz}
			case "alibaba":
				// ApsaraDB for Redis: the tier is a redis.master.*.default class (catalog
				// `cache.alibaba`) and the engine version is 7.0 — 7.1 does not exist there, and
				// cache.t3.medium is an ElastiCache node type.
				cache = types.ProjectCacheConfig{
					Name: maxConfigCacheName, EngineVersion: "7.0", NodeType: "redis.master.small.default",
					NumCacheNodes: &nodes, MultiAz: &multiAz,
				}
			case "hetzner":
				// Hetzner's cache is the upstream Valkey chart in-cluster: no SKU, no ElastiCache
				// engine version. Leave both empty so the chart's own defaults apply.
				cache = types.ProjectCacheConfig{Name: maxConfigCacheName, NumCacheNodes: &nodes, MultiAz: &multiAz}
			}
			pc.Caches = []types.ProjectCacheConfig{cache}
		},
		Populated: func(pc *types.ProjectConfig) bool { return len(pc.Caches) > 0 },
		AWS:       tofuCell("aws_elasticache_replication_group", "create_elasticache_redis"),
		GCP:       tofuCell("google_redis_instance", "create_memorystore"),
		Azure:     tofuCell("azurerm_managed_redis", "create_azure_cache"),
		Hetzner:   inClusterCell("addon-cache-"+maxConfigCacheName, hetznerNoManagedService+" (upstream valkey-io/valkey-helm chart)"),
		Alibaba:   tofuCell("alicloud_kvstore_instance", "create_kvstore"),
	},
	{
		Kind: "queue",
		Doc: "a message queue — SQS / Pub-Sub / Service Bus queue / MNS queue, and an in-cluster " +
			"RabbitMQ on Hetzner. Per-cloud gotcha: AWS's signal is sqs_queues, NOT provision_sqs (topics set that too).",
		Apply: func(pc *types.ProjectConfig, provider string) {
			ordered := true
			vis, ret := 30, 345600
			pc.Queues = []types.ProjectQueueConfig{{
				Name: maxConfigQueueName, Ordered: &ordered, VisibilityTimeout: &vis, MessageRetention: &ret,
				ProviderConfig: map[string]any{"delay_seconds": 5},
			}}
		},
		Populated: func(pc *types.ProjectConfig) bool { return len(pc.Queues) > 0 },
		AWS:       tofuCell("aws_sqs_queue", "sqs_queues"),
		// GCP: the queue folds into pubsub_topics["jobs"]. create_pubsub/pubsub_topics are NOT
		// kind-exclusive (topic sets them too), so the negative test keys off the "jobs" map entry.
		GCP: tofuCell("google_pubsub_topic", "create_pubsub", "pubsub_topics"),
		// Azure: distinct service_bus_queues map (NOT the shared create_service_bus bool, which topics
		// also set) — cleanly kind-exclusive, so the negative test needs no GCP-style discriminator.
		Azure:   tofuCell("azurerm_servicebus_queue", "service_bus_queues"),
		Hetzner: inClusterCell("addon-queue-"+maxConfigQueueName, hetznerNoManagedService+" (RabbitMQ, cloudpirates-io chart)"),
		// Alibaba: mns_queues is the discriminator — create_mns is len(Queues)>0 || len(Topics)>0,
		// exactly the GCP create_pubsub shape, so it is NOT kind-exclusive.
		Alibaba: tofuCell("alicloud_message_service_queue", "mns_queues"),
	},
	{
		Kind: "topic",
		Doc: "a pub/sub topic with a subscription — SNS / Pub-Sub / Service Bus topic / MNS topic. " +
			"The one kind Hetzner neither has a service for nor offers a chart for.",
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.Topics = []types.ProjectTopicConfig{{
				Name: maxConfigTopicName,
				Subscriptions: []types.TopicSubscription{
					{Protocol: "sqs", Endpoint: "arn:aws:sqs:us-east-1:000000000000:jobs"},
				},
			}}
		},
		Populated: func(pc *types.ProjectConfig) bool { return len(pc.Topics) > 0 },
		AWS:       tofuCell("aws_sns_topic", "sns_topics"),
		// GCP: the topic folds into pubsub_topics["events"] (same google_pubsub_topic type as queue).
		GCP: tofuCell("google_pubsub_topic", "create_pubsub", "pubsub_topics"),
		// Azure: distinct service_bus_topics map (separate from the queue's service_bus_queues).
		Azure: tofuCell("azurerm_servicebus_topic", "service_bus_topics"),
		// Hetzner: a genuine ceiling, unlike `secrets`/`registry` below. RabbitMQ is installed here
		// for the `queue` kind and its exchanges would be the obvious substrate — but nothing in this
		// repo offers a topic on it (hetzner-services.ts has no topic branch, and RabbitMQ is not a
		// marketplace add-on a user can pick), and the console SSOT states the position outright: "no
		// clean single-chart OSS equal". Re-verdicting this as debt would need a chart the product
		// actually offers for the kind, not a broker that happens to be running.
		Hetzner: ceilingCell(hetznerNoServiceNoChart),
		// Alibaba: unlike GCP, MNS topics are a DISTINCT resource type from queues, so state can tell
		// the two kinds apart.
		Alibaba: tofuCell("alicloud_message_service_topic", "mns_topics"),
	},
	{
		Kind: "nosql",
		Doc: "a NoSQL table — DynamoDB / Firestore / Cosmos DB container / Tablestore. " +
			"Hetzner has neither a service nor an offered chart for it.",
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.NosqlTables = []types.ProjectNosqlConfig{{
				Name: "items", PartitionKey: "pk", PartitionKeyType: "S",
				SortKey: "sk", SortKeyType: "S", TableType: "standard",
				CapacityMode: "on_demand", PointInTimeRecovery: true,
			}}
		},
		Populated: func(pc *types.ProjectConfig) bool { return len(pc.NosqlTables) > 0 },
		AWS:       tofuCell("aws_dynamodb_table", "ddb_create", "ddb_table_configuration"),
		GCP:       tofuCell("google_firestore_database", "create_firestore"),
		// Azure: the per-table container (account/db parents are shared, one each).
		Azure:   tofuCell("azurerm_cosmosdb_sql_container", "create_cosmos_db"),
		Hetzner: ceilingCell(hetznerNoServiceNoChart),
		// Alibaba: the per-table Tablestore resource (alicloud_ots_instance is the shared parent).
		Alibaba: tofuCell("alicloud_ots_table", "create_ots", "ots_tables"),
	},
	{
		Kind: "secrets",
		Doc: "a generated secret in the cloud secret store — Secrets Manager / Secret Manager / " +
			"Key Vault / KMS. Hetzner has none, and its in-cluster substitute (Vault) is unwired DEBT.",
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.Secrets = []types.ProjectSecretConfig{{
				Name: "api-key", Generate: true, Length: 32, SpecialChars: true,
			}}
		},
		Populated: func(pc *types.ProjectConfig) bool { return len(pc.Secrets) > 0 },
		AWS:       tofuCell("aws_secretsmanager_secret", "custom_secrets"),
		GCP:       tofuCell("google_secret_manager_secret", "custom_secrets"),
		Azure:     tofuCell("azurerm_key_vault_secret", "custom_secrets"),
		// Hetzner has no cloud secret store and hetznerProvider.ProviderTfvars never emits
		// custom_secrets — so far, a ceiling's shape. But Vault ships in the marketplace catalog and
		// the full-bar run INSTALLS it (addon_catalog.json holds `vault`); what is missing is the
		// ESO ClusterSecretStore over it, plus the init/unseal design. unsupported-kinds.ts says so in
		// the same breath: "a real feature with its own init/unseal design … until it lands, reject
		// the kind honestly". That is debt with a date on it, not a limit of the cloud.
		Hetzner: deferredCell("vault (marketplace catalog; the full-bar run already installs it)",
			hetznerChartExistsNotWired+". Missing: an ESO ClusterSecretStore over the Vault backend, and the init/unseal design"),
		Alibaba: tofuCell("alicloud_kms_secret", "custom_secrets"),
	},
	{
		Kind: "bucket",
		Doc:  "an object-storage bucket (S3).",
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.StorageBuckets = []types.ProjectStorageBucketConfig{{
				Name: "assets", Versioning: true, EncryptionEnabled: true, PublicAccess: false,
				CorsOrigins: []string{"https://example.com"},
			}}
		},
		Populated: func(pc *types.ProjectConfig) bool { return len(pc.StorageBuckets) > 0 },
		AWS:       tofuCell("aws_s3_bucket", "s3_create", "bucket_configuration"),
		GCP:       tofuCell("google_storage_bucket", "create_cloud_storage", "cloud_storage_buckets"),
		// Azure: the per-bucket container (the storage account parent is shared).
		Azure: tofuCell("azurerm_storage_container", "create_storage_account"),
		// Hetzner: a REAL Hetzner product (Object Storage), driven through the aminueza/minio provider
		// in s3_compat_mode — NOT an in-cluster MinIO, which is the easy mis-filing. `buckets` is always
		// emitted (empty ⇒ the provider is declared but never exercised), so meaningful() len>0 gives
		// the signal teeth.
		//
		// This cell needs a SECOND credential pair that no other Hetzner cell does:
		// HETZNER_S3_ACCESS_KEY / HETZNER_S3_SECRET_KEY, which Hetzner has no API to mint (the customer
		// generates them by hand) and which hetzner_provider.go emits the tfvars from. That is now a
		// PRE-SPEND gate, not this comment: the hetzner row's credsPresent (t2_providers.go) requires
		// both whenever ALETHIA_E2E_MAX_CONFIG is on, so a full-bar run without them fails before it
		// provisions anything instead of dying at the bucket after ~20 minutes of apply.
		Hetzner: tofuCell("minio_s3_bucket", "buckets"),
		Alibaba: tofuCell("alicloud_oss_bucket", "create_oss", "oss_buckets"),
	},
	{
		Kind: "registry",
		Doc: "a container image registry — ECR / Artifact Registry / ACR / CR EE. Hetzner has none, " +
			"and its in-cluster substitute (Harbor) is unwired DEBT. Per-cloud gotcha: AWS emits " +
			"provision_ecr as a plain boolean (the registry NAME is unused there).",
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.ContainerRegistries = []types.ProjectContainerRegistryConfig{{Name: "app-images"}}
		},
		Populated: func(pc *types.ProjectConfig) bool { return len(pc.ContainerRegistries) > 0 },
		AWS:       tofuCell("aws_ecr_repository", "provision_ecr"),
		GCP:       tofuCell("google_artifact_registry_repository", "provision_artifact_registry"),
		Azure:     tofuCell("azurerm_container_registry", "provision_acr"),
		// Hetzner has no registry product — but Harbor ships in the marketplace catalog, the full-bar
		// run installs it, and unsupported-kinds.ts states the substitution itself: "the Harbor
		// marketplace add-on covers registry in-cluster". So the kind is rejected while the capability
		// is running in the same cluster: what is missing is the mapping (a canvas `registry` node →
		// a Harbor project + robot account + the pull-secret binding), not a chart. Debt, not a ceiling.
		Hetzner: deferredCell("harbor (marketplace catalog; the full-bar run already installs it)",
			hetznerChartExistsNotWired+". Missing: a mapping from the `registry` kind to a Harbor project + robot account + pull-secret binding"),
		// Alibaba: the per-repo resource is the pushable thing — alicloud_cr_ee_instance/_namespace are
		// the shared parents, and a project used to get a PAID EE instance with nowhere to push (#1837).
		//
		// ⚠️ COST WARNING — READ BEFORE DRIVING AN ALIBABA FULL BAR. Reaching alicloud_cr_ee_repo
		// forces its parent alicloud_cr_ee_instance, which the module creates with
		// payment_type = "Subscription", period = 1 (infra/templates/project/alibaba/modules/cr/main.tf):
		// the ONLY subscription resource in the whole alibaba module tree. A prepaid instance is not
		// released by `tofu destroy` the way a pay-as-you-go one is, so EVERY alibaba full-bar run
		// leaves a standing monthly CR EE Basic instance behind, and the teardown reports clean.
		// Recorded, not "fixed": the cell is CORRECT — the repo IS the pushable resource and this is
		// what the product provisions today. Changing the payment type is a template decision with a
		// blast radius outside this harness. Also in docs/testing/provisioning-e2e-parity.md.
		Alibaba: tofuCell("alicloud_cr_ee_repo", "provision_cr", "cr_repos"),
	},
	{
		Kind: "dns",
		Doc:  "cloud-native DNS (Route 53). cloud_dns_enabled fires only when enabled AND no zone_id is brought.",
		Apply: func(pc *types.ProjectConfig, provider string) {
			pc.DNS = types.ProjectDNSConfig{
				Enabled: true, DomainName: MaxConfigDomain(), ZoneID: "",
				// ACM is OFF. See MaxConfigDomain: a DNS-validated certificate cannot be
				// issued for a zone nothing on the public internet delegates to us, so this
				// is an EXPLICIT, documented exclusion rather than a silent one.
				ProviderConfig: map[string]any{"acm_certificate": false},
			}
		},
		Populated: func(pc *types.ProjectConfig) bool { return pc.DNS.Enabled },
		AWS:       tofuCell("aws_route53_zone", "cloud_dns_enabled"),
		GCP:       tofuCell("google_dns_managed_zone", "cloud_dns_enabled"),
		Azure:     tofuCell("azurerm_dns_zone", "azure_dns_enabled"),
		// Hetzner: the Cloud API grew Zones in 2025 (GA in the hcloud provider at 1.56), so DNS here is
		// a first-class tofu resource like Route 53 — not the in-cluster story its TLS exclusion tells.
		Hetzner: tofuCell("hcloud_zone", "cloud_dns_enabled", "dns_main_domain"),
		// Alibaba: alidns_enabled is config.DNS.Enabled ALONE — unlike aws/hetzner it does not also
		// require an empty ZoneID.
		Alibaba: tofuCell("alicloud_alidns_domain", "alidns_enabled", "alidns_domain"),
	},
}

// maxConfigSnapshotKeys are the config_snapshot top-level keys the max-config table owns. Only these
// are merged onto the deploy snapshot — never the runtime identity fields (id/project/region/…),
// which the base snapshot already carries.
var maxConfigSnapshotKeys = []string{
	"network", "cluster", "dns",
	"databases", "caches", "queues", "topics", "nosql_tables",
	"secrets", "container_registries", "storage_buckets",
}

// maxConfigDomainSuffix is the zone the fixture's DNS name sits under. It is a domain Alethia
// actually owns, which matters for three independent reasons:
//
//   - AWS RESERVES example.com. `aws_route53_zone` refuses it outright
//     ("InvalidDomainName: example.com is reserved by AWS!"), so the full bar had never once
//     proven the `dns` kind on aws — it failed identically every Sunday (run 30738253176).
//   - A made-up name would squat on somebody's real registration. Route 53, Cloud DNS and Azure
//     DNS all create a public zone for ANY syntactically valid name without checking ownership.
//   - A reserved-for-testing TLD (.test, .invalid) avoids the squatting problem but trades a
//     verified fact for a guess: whether each cloud's zone API accepts it is not documented, and
//     the full bar is main-gated, so a wrong guess costs a whole week to discover.
//
// It is also the name we would DELEGATE if the ACM path is ever to be proven — see MaxConfigDomain.
const maxConfigDomainSuffix = "e2e.alethialabs.io"

// MaxConfigDomain is the DNS zone name the max-config fixture provisions, scoped to this run so
// two runs never contend for one zone name. ALETHIA_E2E_ENV is the same run-scoped identifier the
// harness already uses for the project/environment pair; the constant fallback keeps the fixture
// deterministic for the pure unit tests, which run with no environment at all.
//
// WHY ACM IS OFF ALONGSIDE THIS. The fixture used to set acm_certificate: true, and the run's ACM
// timeout looked downstream of the Route 53 failure. It is not, and this is the part worth not
// assuming: modules/acm uses validation_method = "DNS" and aws_acm_certificate_validation BLOCKS
// until the certificate is issued, which requires the validation CNAME to be resolvable on the
// PUBLIC internet. Creating a zone is not the same as being delegated one — no infra/ stack
// delegates a zone to the e2e account today, so ACM can never issue here no matter which domain
// this returns. Fixing the name alone would have swapped one guaranteed 5-minute timeout for
// another and looked like progress.
//
// So the `dns` kind is proven and the cert path is an explicit exclusion. Delegating
// e2e.alethialabs.io (its NS records live on Cloudflare, with the control-plane stacks) into the
// e2e account would make ACM real; that is a maintainer step, tracked separately.
func MaxConfigDomain() string {
	if env := strings.TrimSpace(os.Getenv("ALETHIA_E2E_ENV")); env != "" {
		return env + "." + maxConfigDomainSuffix
	}
	return maxConfigDomainSuffix
}

// MaxConfigEnabled reports whether this run should provision the FULL 11-kind surface.
func MaxConfigEnabled() bool {
	return os.Getenv("ALETHIA_E2E_MAX_CONFIG") == "1"
}

// MaxConfigProjectConfig builds the typed max-config ProjectConfig by folding every kind's Apply.
// It is the single source both the free tfvar proof and the real-apply snapshot derive from.
//
// Kinds this cloud does not offer (CloudCeiling or DeferredInProduct — Cell.Offered) are NOT folded
// in. Seeding them would be a lie the snapshot then carries: hetzner's ProviderTfvars emits no tfvar
// for topic/nosql/secrets/registry, so they would be silently dropped and the run would still report
// green — and the console's own deploy action REJECTS those kinds on hetzner outright, so no user
// could ever produce this snapshot either. The max-config surface must be the biggest config the
// product can actually express on that cloud, not a superset nothing consumes. (Whether a kind is
// excluded because the cloud cannot or because we have not is a real distinction for the ledger, but
// not for the fixture: both are rejected at deploy today.)
func MaxConfigProjectConfig(provider string) *types.ProjectConfig {
	pc := &types.ProjectConfig{Provider: types.CloudProvider(provider)}
	for _, k := range MaxConfigKinds {
		cell, ok := k.Cell(provider)
		if !ok {
			panic(fmt.Sprintf("maxconfig: no column for provider %q on kind %q — add the per-cloud column to MaxConfigKind", provider, k.Kind))
		}
		if !cell.Offered() {
			continue
		}
		k.Apply(pc, provider)
	}
	return pc
}

// MaxConfigSnapshot merges the 11-kind surface onto a base deploy snapshot (the map the runner
// consumes). Fail-closed: if ANY kind that this cloud DOES offer did not populate, it errors rather
// than provision a partial surface that would report green — the vacuous proof #515's discipline
// exists to prevent. Kinds this cloud does not offer are exempt (they were never applied), and a
// provider that offers no kind at all is itself an error.
//
// It also seeds the IN-CLUSTER half of the surface: on a cloud whose data kinds are CarriedInCluster
// (hetzner), the console's buildConfigSnapshot appends synthesized chart install specs to `addons`,
// and without them the runner renders no Application, so those cells assert a name that cannot
// exist. Both halves are seeded HERE, in one function, so the kind blocks and the charts that
// deliver three of them can never be layered by two callers that disagree.
func MaxConfigSnapshot(base map[string]any, provider string) error {
	pc := MaxConfigProjectConfig(provider)
	var missing, offered []string
	for _, k := range MaxConfigKinds {
		cell, ok := k.Cell(provider)
		if !ok {
			return fmt.Errorf("max-config: no column for provider %q on kind %q", provider, k.Kind)
		}
		if !cell.Offered() {
			continue
		}
		offered = append(offered, k.Kind)
		if !k.Populated(pc) {
			missing = append(missing, k.Kind)
		}
	}
	if len(offered) == 0 {
		return fmt.Errorf("max-config: %q offers no kind at all (every cell is a ceiling or deferred) — the surface would be empty and the run vacuous", provider)
	}
	if len(missing) > 0 {
		return fmt.Errorf("max-config surface is incomplete — kinds not populated: %v (a partial max-config run would be vacuous)", missing)
	}

	raw, err := json.Marshal(pc)
	if err != nil {
		return fmt.Errorf("marshal max-config ProjectConfig: %w", err)
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(raw, &all); err != nil {
		return fmt.Errorf("unmarshal max-config ProjectConfig: %w", err)
	}
	for _, key := range maxConfigSnapshotKeys {
		v, ok := all[key]
		if !ok {
			return fmt.Errorf("max-config ProjectConfig did not serialize expected key %q", key)
		}
		var decoded any
		if err := json.Unmarshal(v, &decoded); err != nil {
			return fmt.Errorf("decode max-config key %q: %w", key, err)
		}
		base[key] = decoded
	}
	return maxConfigSeedInClusterAddOns(base, provider)
}

// maxConfigSeedInClusterAddOns appends the chart install specs that DELIVER this cloud's
// CarriedInCluster kinds onto the snapshot's `addons` — the console's own step, reproduced.
//
// On a Hetzner project, buildConfigSnapshot does `addons.push(...hetznerDataServicesToAddOns({
// databases, caches, queues }))` (apps/console/app/server/actions/projects.ts). The runner then
// renders one ArgoCD Application per spec and records it in execution_metadata.addon_status, which
// is what DeriveExpectedArgoApps reads and what the in-cluster cells assert. Without this the three
// cells named Applications that could never exist and a Hetzner full-bar run was red by
// construction.
//
// The specs are DERIVED, never re-typed: they come from the generated fixture (hetzner_data_services
// .go), whose generator runs the real TypeScript mapper. It is a no-op on every cloud whose kinds are
// all CarriedByTofu, so the other four clouds' seeded add-on set is untouched — the map is keyed on
// the provider, and a cloud absent from it appends nothing.
func maxConfigSeedInClusterAddOns(base map[string]any, provider string) error {
	inCluster := map[string]func() ([]types.AddOnInstall, error){
		"hetzner": HetznerDataServiceAddOns,
	}
	load, ok := inCluster[provider]
	if !ok {
		// Cross-check against the table rather than trusting the map: a cloud that GAINS an
		// in-cluster cell without gaining a loader here would silently reproduce the original defect.
		for _, k := range MaxConfigKinds {
			if cell, has := k.Cell(provider); has && cell.Carriage == CarriedInCluster {
				return fmt.Errorf(
					"max-config: kind %q on %q is %s (its proof is ArgoCD Application %q) but no in-cluster add-on loader is registered for that cloud — the deploy would carry no chart and the Application could never exist",
					k.Kind, provider, CarriedInCluster, cell.ArgoApp)
			}
		}
		return nil
	}
	specs, err := load()
	if err != nil {
		return fmt.Errorf("max-config: seeding %s's in-cluster data services: %w", provider, err)
	}
	// Normalize through JSON: `addons` arrives as []types.AddOnInstall from seedAddOns on the
	// synthetic path and as []any of maps on the A0.5 real-snapshot path, and the snapshot is
	// marshalled to JSON before it reaches the job either way.
	merged, err := appendJSONList(base["addons"], specs)
	if err != nil {
		return fmt.Errorf("max-config: merging %s's in-cluster add-ons into the snapshot: %w", provider, err)
	}
	base["addons"] = merged
	return nil
}

// appendJSONList appends `add` to `existing` in their JSON representation, so a heterogeneous
// snapshot value (a typed Go slice, a decoded []any, or absent entirely) merges without a type
// switch per shape.
func appendJSONList(existing any, add any) ([]any, error) {
	var out []any
	if existing != nil {
		raw, err := json.Marshal(existing)
		if err != nil {
			return nil, fmt.Errorf("marshal existing list: %w", err)
		}
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, fmt.Errorf("existing value is not a JSON list: %w", err)
		}
	}
	raw, err := json.Marshal(add)
	if err != nil {
		return nil, fmt.Errorf("marshal appended list: %w", err)
	}
	var tail []any
	if err := json.Unmarshal(raw, &tail); err != nil {
		return nil, fmt.Errorf("appended value is not a JSON list: %w", err)
	}
	return append(out, tail...), nil
}

// countManagedResources counts managed resource INSTANCES of a given type in a tofu state JSON
// (state format v4). Child-module resources live in the same flat "resources" array, each tagged
// with its own "type", so a type match works regardless of module nesting. Counting instances (not
// resource blocks) means a for_each'd module producing N of a type still counts as N.
func countManagedResources(stateBytes []byte, resType string) (int, error) {
	var st struct {
		Resources []struct {
			Mode      string `json:"mode"`
			Type      string `json:"type"`
			Instances []struct {
				// present per instance; we only need the count
			} `json:"instances"`
		} `json:"resources"`
	}
	if err := json.Unmarshal(stateBytes, &st); err != nil {
		return 0, fmt.Errorf("parse tofu state: %w", err)
	}
	n := 0
	for _, r := range st.Resources {
		if r.Mode == "managed" && r.Type == resType {
			if len(r.Instances) == 0 {
				n++ // a managed resource with no recorded instances still counts as present
				continue
			}
			n += len(r.Instances)
		}
	}
	return n, nil
}

// MaxConfigStateProof accounts for every one of the 11 kinds under exactly one verdict, so a caller
// cannot read a partial run as a full-surface proof. Missing is the only failure list; the other
// three are the positive/excluded ledger the nightly logs.
type MaxConfigStateProof struct {
	// ProvenInTofu are the kinds whose tofu resource type was counted in the deploy's state.
	ProvenInTofu []string
	// ProvenInCluster are the kinds whose ArgoCD Application was present in the converged set.
	ProvenInCluster []string
	// Excluded are the kinds at a documented CloudCeiling on this cloud — the cloud has no service
	// and this repo offers no chart, so there is nothing to assert and nothing to build.
	Excluded []string
	// Deferred are the kinds at DeferredInProduct — also unprovable today, but because the mapping
	// is missing, not the capability. Kept SEPARATE from Excluded on purpose: folding debt into the
	// ceiling list is how a backlog item stops being counted, and a run's verdict should be able to
	// say "3 kinds this cloud cannot do, 2 kinds we have not wired" rather than "5 excluded".
	Deferred []string
	// Missing are the kinds that SHOULD have landed and did not, each named with what was looked for.
	Missing []string
}

// AssertMaxConfigKindsInState proves every max-config kind genuinely landed — the real-apply half
// of the surface. Per-kind and fail-closed, with no escape hatch:
//
//   - CarriedByTofu ⇒ the resource type must have ≥1 managed instance in the deploy's state;
//   - CarriedInCluster ⇒ the kind's ArgoCD Application must be in argoApps, the set the caller has
//     already driven to Healthy+Synced (a tofu-state count can never see an in-cluster chart);
//   - CloudCeiling ⇒ recorded as a documented exclusion;
//   - DeferredInProduct ⇒ recorded as documented DEBT, in its own list.
//
// A cloud with no column, or a cell with no verdict, is an ERROR. That is the whole point of this
// change: the previous version returned "" for hetzner and alibaba and reported all 11 kinds as
// "unmapped" via t.Logf, then logged a success line having asserted nothing.
//
// argoApps is the caller's already-converged Application set (DeriveExpectedArgoApps), which is
// derived from execution_metadata.addon_status — one entry per add-on that RODE THE SNAPSHOT. That
// is why MaxConfigSnapshot seeds Hetzner's synthesized data-service charts (maxConfigSeedInCluster
// AddOns): the three in-cluster cells used to name Applications the deploy never carried, so they
// were Missing by construction on every run.
func AssertMaxConfigKindsInState(stateBytes []byte, provider string, argoApps []string) (MaxConfigStateProof, error) {
	var proof MaxConfigStateProof
	if len(stateBytes) == 0 {
		return proof, fmt.Errorf("empty tofu state — the deploy wrote nothing")
	}
	for _, k := range MaxConfigKinds {
		cell, ok := k.Cell(provider)
		if !ok {
			return MaxConfigStateProof{}, fmt.Errorf("max-config: cloud %q has no column in MaxConfigKinds (kind %q) — add the per-cloud column rather than skipping the cloud", provider, k.Kind)
		}
		if err := cell.Validate(); err != nil {
			return MaxConfigStateProof{}, fmt.Errorf("max-config: kind %q × cloud %q: %w", k.Kind, provider, err)
		}
		switch cell.Carriage {
		case CarriedByTofu:
			n, cerr := countManagedResources(stateBytes, cell.Resource)
			if cerr != nil {
				return MaxConfigStateProof{}, cerr
			}
			if n < 1 {
				proof.Missing = append(proof.Missing, fmt.Sprintf("%s (tofu resource %s absent from state)", k.Kind, cell.Resource))
				continue
			}
			proof.ProvenInTofu = append(proof.ProvenInTofu, k.Kind)
		case CarriedInCluster:
			if !containsString(argoApps, cell.ArgoApp) {
				proof.Missing = append(proof.Missing, fmt.Sprintf("%s (ArgoCD Application %s not in the converged set — %s)", k.Kind, cell.ArgoApp, cell.Why))
				continue
			}
			proof.ProvenInCluster = append(proof.ProvenInCluster, k.Kind)
		case CloudCeiling:
			proof.Excluded = append(proof.Excluded, k.Kind)
		case DeferredInProduct:
			proof.Deferred = append(proof.Deferred, k.Kind)
		}
	}
	if len(proof.ProvenInTofu)+len(proof.ProvenInCluster)+len(proof.Missing) == 0 {
		return MaxConfigStateProof{}, fmt.Errorf("max-config on %q asserted NOTHING: every kind is excluded or deferred, so the run proves nothing — that is not a cloud the full bar can be driven on", provider)
	}
	return proof, nil
}

// containsString reports whether ss contains want.
func containsString(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}

// meaningful reports whether a tfvar value is present AND carries signal — a true bool, a non-empty
// string/map/slice, a non-zero number. The kinds' create_* booleans are ALWAYS in the tfvar map (set
// to len(...)>0), so a mere presence check would pass even when a kind is absent; this is what gives
// both the positive proof and the negative test their teeth.
func meaningful(v any) bool {
	if v == nil {
		return false
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Bool:
		return rv.Bool()
	case reflect.String:
		return rv.String() != ""
	case reflect.Slice, reflect.Map, reflect.Array:
		return rv.Len() > 0
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return rv.Int() != 0
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return rv.Uint() != 0
	case reflect.Float32, reflect.Float64:
		return rv.Float() != 0
	case reflect.Ptr, reflect.Interface:
		return !rv.IsNil() && meaningful(rv.Elem().Interface())
	default:
		return true
	}
}
