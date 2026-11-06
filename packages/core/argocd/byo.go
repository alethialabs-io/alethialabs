// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"regexp"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"gopkg.in/yaml.v3"
)

// RenderByoAppProject renders a HARDENED per-project ArgoCD AppProject for bring-your-own charts.
// Unlike the wide-open "infra"/"apps" projects (clusterResourceWhitelist [*,*], destinations
// namespace "*"), a BYO project is default-deny:
//   - sourceRepos is locked to exactly the customer's chart repos (no other repo can sync here);
//   - destinations are pinned to the in-cluster server + the specific namespaces the charts target;
//   - clusterResourceWhitelist is EMPTY — no cluster-scoped resource (CRD, ClusterRole/Binding,
//     Namespace, ValidatingWebhook, …) may be created by an untrusted chart;
//   - namespaceResourceWhitelist is a CLOSED list of workload kinds (byoWorkloadKinds), so a
//     namespaced kind that is not on it — RBAC Role/RoleBinding, ServiceAccount, every
//     external-secrets.io kind, and any kind an installed operator serves — fails the sync;
//   - namespaceResourceBlacklist still names RBAC Role/RoleBinding, ServiceAccount and the
//     external-secrets groups (byoSecretSyncDenied). The whitelist already refuses all of them; the
//     blacklist is the second layer, so that a later widening of the whitelist (a wildcard group, say)
//     cannot readmit them. ArgoCD admits a namespaced kind only when it is whitelisted AND not
//     blacklisted.
//
// This is the AppProject half of the trust boundary; namespace PSA + an admission controller
// (Kyverno/Gatekeeper) are the pod-level half added before untrusted charts are allowed.
// The AppProject wire shape, MARSHALLED rather than templated (#2540).
//
// WHAT THE TEMPLATE DID. It interpolated `{{ . }}` into quoted YAML scalars for BOTH sourceRepos and
// destinations, and text/template does no escaping whatsoever. #2576 closed exactly this hole in
// RenderByoNamespaces but not here — and the caller is fail-soft, so a namespace its validator
// REFUSED still reached this function, which rendered it raw. A namespace of the form
//
//	x"\n---\n<an entire ClusterRoleBinding>\nswallow: |2 #
//
// closes the quoted scalar, opens a second document, and ends with a block scalar carrying an
// explicit indent indicator — whose `#` swallows the template's own closing quote and whose body
// absorbs every remaining line of the AppProject. The result is two VALID documents, the second a
// ClusterRoleBinding to cluster-admin, applied by the runner with the cluster's admin kubeconfig.
// That is precisely the cluster-scoped power the empty clusterResourceWhitelist below exists to
// deny an untrusted chart. Not flag-gated: prepareByoCharts runs on every deploy carrying any
// git-source add-on (provisioner/deploy.go, byo_charts.go).
//
// TYPED STRUCTS, not map[string]any: field ORDER is preserved (yaml.v3 sorts map keys, which would
// reshuffle the manifest on every render for no reason), and the shape is checked by the compiler
// rather than by whoever next reads the template.
type byoAppProject struct {
	APIVersion string         `yaml:"apiVersion"`
	Kind       string         `yaml:"kind"`
	Metadata   byoProjectMeta `yaml:"metadata"`
	Spec       byoProjectSpec `yaml:"spec"`
}

type byoProjectMeta struct {
	Name       string            `yaml:"name"`
	Namespace  string            `yaml:"namespace"`
	Labels     map[string]string `yaml:"labels"`
	Finalizers []string          `yaml:"finalizers"`
}

type byoProjectSpec struct {
	Description  string           `yaml:"description"`
	SourceRepos  []string         `yaml:"sourceRepos"`
	Destinations []byoDestination `yaml:"destinations"`
	// MUST render as `[]`: ArgoCD admits a cluster-scoped kind only when this list is non-empty and
	// matches it. yaml.v3 marshals a nil slice as `[]` too, so the explicit empty slice below is for the
	// reader; what would change the statement is an `omitempty` tag, which drops the key. This is the
	// single field the whole hardening rests on, so its emptiness is asserted by a test rather than
	// left to whoever next edits this struct.
	ClusterResourceWhitelist []byoGroupKind `yaml:"clusterResourceWhitelist"`
	// MUST be present AND non-empty. ArgoCD reads an ABSENT namespaceResourceWhitelist (nil after
	// decoding) as "every namespaced kind is permitted" and an empty one as "none is"
	// (AppProject.IsGroupKindNamePermitted). yaml.v3 marshals a nil slice as `[]`, so leaving the
	// field unset renders a closed project. What would open it is an `omitempty` tag or deleting the
	// field, since either drops the key. TestByoAppProjectAdmitsOnlyWorkloadKinds asserts the rendered
	// YAML carries the list.
	NamespaceResourceWhitelist []byoGroupKind       `yaml:"namespaceResourceWhitelist"`
	NamespaceResourceBlacklist []byoGroupKind       `yaml:"namespaceResourceBlacklist"`
	OrphanedResources          byoOrphanedResources `yaml:"orphanedResources"`
}

type byoDestination struct {
	Namespace string `yaml:"namespace"`
	Server    string `yaml:"server"`
}

type byoGroupKind struct {
	Group string `yaml:"group"`
	Kind  string `yaml:"kind"`
}

type byoOrphanedResources struct {
	Warn bool `yaml:"warn"`
}

// encodeByoDocs marshals one or more documents into a single YAML stream at the indent this
// package uses everywhere.
//
// Shared by BOTH byo renderers rather than written out twice. Beyond the duplication, the encoder's
// two error arms are not reachable from either caller — a bytes.Buffer write does not fail and the
// values are plain structs and maps — so having a copy per renderer meant four defensive branches no
// test can enter. One copy is one pair, and it is the pair that would actually catch a future value
// yaml.v3 refuses to marshal.
func encodeByoDocs(what string, docs ...any) (string, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	for _, d := range docs {
		if err := enc.Encode(d); err != nil {
			return "", fmt.Errorf("render byo %s: %w", what, err)
		}
	}
	if err := enc.Close(); err != nil {
		return "", fmt.Errorf("render byo %s: %w", what, err)
	}
	return buf.String(), nil
}

// byoRepoUnsafe rejects the injection vector WITHOUT pretending to be a URL parser.
//
// Deliberately not a URL allowlist. BYO chart repos legitimately arrive as `https://`, `ssh://`,
// `git@host:path` and bare paths, and a wrong allowlist REFUSES a repo that would have worked —
// worse than the gap it closes, which is the trade-off dns-zone-support.ts settles the same way. A control
// character is part of none of those forms, and it is the only thing that lets a value leave its
// scalar. Marshalling already makes injection structurally impossible; this refuses the absurd
// value outright so it fails here rather than later and more confusingly.
var byoRepoUnsafe = regexp.MustCompile(`[\x00-\x1f\x7f]`)

// byoProjectPrefix is what an AppProject name for BYO charts starts with. It is part of the
// LENGTH BUDGET, which is why the slug below is capped against it rather than after the join.
const byoProjectPrefix = "byo-"

// ByoProjectName derives a stable ArgoCD AppProject name for a project's BYO charts:
// "byo-<segment>". `slug` is typically the project's free-text name; the fallback keeps the name
// non-empty and the cap keeps it inside 63 characters.
//
// The derivation is names.LegacyObjectSegment, which is FROZEN and is deliberately not
// names.Slugify — this name is the identity of an AppProject that is already applied. See that
// function for the four shapes where the two differ and for why closing the gap is a migration
// rather than a rename. The local copy of the regex is gone; the rule now has one definition.
func ByoProjectName(slug string) string {
	s := names.LegacyObjectSegment(slug)
	if s == "" {
		s = "project"
	}
	return names.Bounded(byoProjectPrefix + s)
}

// ByoChartNamespace is the namespace a BYO chart deploys into when none of its own is chosen:
// "byo-<chart id>" (#6446). The chart id is the add-on id the console derives (chartSlug), so this is
// the same name the console's attach form offers as the default (byoChartNamespace in
// apps/console/lib/validations/byo-charts.ts — the two are pinned to the same table of cases on each
// side).
//
// DISTINCT PER CHART, past the 63-character cap too. A plain cut would give two stored ids that
// share their first 59 characters the same namespace, so a name that does not fit is cut further
// and ends in "-" + 8 hex of the FNV-1a 32 hash of the WHOLE id. A new chart's id (at most 57
// characters) always fits, so the hash only ever appears for an id stored before that cap.
//
// A chart gets its own namespace rather than a shared one because the namespace is what isolates it:
// the hardened AppProject allows the namespaced kinds in its destinations, so two charts in one
// namespace can read each other's Secrets, and a chart in "default" sat beside the platform's own
// workloads. No reserved name or prefix starts with "byo-". A NEW attachment may not choose a "byo-"
// namespace other than its own (the console's attach schema). A chart that chose one before that rule
// keeps it; only if it is another chart's derived name in the same environment does the runner refuse
// one of the two (provisioner.byoNamespaceCollisions).
func ByoChartNamespace(chartID string) string {
	full := byoProjectPrefix + chartID
	if len(full) <= names.SlugMaxLength {
		return full
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(chartID)) // a hash.Hash never returns an error from Write
	suffix := fmt.Sprintf("%08x", h.Sum32())
	head := strings.TrimRight(full[:names.SlugMaxLength-len(suffix)-1], "-")
	return head + "-" + suffix
}

// ByoLegacyDefaultNamespace is where a BYO chart attached before #6446 deployed when no namespace
// was chosen. It is now reserved for the platform, and such a chart is moved to ByoChartNamespace on
// its next deploy (provisioner.configureByoCharts).
const ByoLegacyDefaultNamespace = "default"

// byoSecretSyncDenied are the kinds a BYO chart may not declare because they sync secret material:
// the whole external-secrets.io group (ExternalSecret, SecretStore, PushSecret, and the
// cluster-scoped ClusterSecretStore and ClusterExternalSecret, which the empty
// clusterResourceWhitelist denies as well) and the whole generators.external-secrets.io group, whose
// kinds mint credentials for an ExternalSecret or PushSecret that references them, plus any other
// subgroup of external-secrets.io a later ESO release adds.
//
// A chart reads only the secret material its declared bindings give it. Those bindings are
// ExternalSecrets the RUNNER applies with its own kubeconfig (provisioner.applyByoChartBindings),
// outside ArgoCD, so this list does not reach them. It has to be the AppProject that refuses a
// chart's own: the platform's ClusterSecretStores admit the chart's namespace on purpose, because the
// runner's binding ExternalSecrets live there, and an ESO store condition can only select a
// NAMESPACE, never an object within one (see externalSecretsStoreTemplate).
//
// Kind "*" rather than a list of today's kinds: ArgoCD matches each entry with filepath.Match, so a
// kind a later ESO release adds to any of these groups is denied without anyone editing this list.
// "*.external-secrets.io" also matches the generators group; that group stays named because it is
// the one ESO 0.9.20 ships.
//
// The deny stops new objects only. SweepByoSecretSyncObjects removes the ones an earlier sync left.
var byoSecretSyncDenied = []byoGroupKind{
	{Group: "external-secrets.io", Kind: "*"},
	{Group: "generators.external-secrets.io", Kind: "*"},
	{Group: "*.external-secrets.io", Kind: "*"},
}

// byoWorkloadKinds is the closed list of namespaced kinds a BYO chart may create. Each entry is an
// exact group and kind: no wildcard, because ArgoCD matches each entry with filepath.Match and a "*"
// here would admit every kind an installed operator serves in that group. The core group is "".
//
// A kind earns a place by being something an ordinary application chart ships to run itself, and by
// granting nothing beyond the chart's own namespace. This list decides which KINDS a chart may
// declare; what a container inside an admitted pod may do is the pod-level half described on
// byoAppProject, not something this list can express.
//
// Absent ON PURPOSE, so refused: ServiceAccount, Role and RoleBinding (a chart may not mint an
// identity or grant one permissions); every external-secrets.io kind (a chart reads only the secrets
// its bindings give it — byoSecretSyncDenied); Endpoints and EndpointSlice (a Service's backends are
// chosen by its selector, not written by hand); ResourceQuota and LimitRange (the namespace's limits
// are the platform's to set); NetworkPolicy, as in the namespace-tenant and preview projects (a policy
// governs every pod its selector matches in the namespace, and nothing guarantees that namespace holds
// only this chart); and every kind served by a CustomResourceDefinition, because what such
// an object can make its operator do is that operator's rule, not this project's. To admit another
// kind, add it here with its reason and a case in TestByoAppProjectAdmitsOnlyWorkloadKinds.
var byoWorkloadKinds = []byoGroupKind{
	// Workload controllers — the chart's own processes.
	{Group: "apps", Kind: "Deployment"},  // the usual stateless workload
	{Group: "apps", Kind: "StatefulSet"}, // a workload with stable identity and its own volumes
	{Group: "apps", Kind: "DaemonSet"},   // one pod per node, for node-local agents
	{Group: "apps", Kind: "ReplicaSet"},  // what a Deployment manages; a chart may declare one directly
	{Group: "batch", Kind: "Job"},        // run-to-completion work, including Helm hook jobs
	{Group: "batch", Kind: "CronJob"},    // scheduled Jobs
	{Group: "", Kind: "Pod"},             // a bare pod, as Helm test hooks declare
	// Configuration and storage the workload reads.
	{Group: "", Kind: "ConfigMap"},             // non-secret configuration
	{Group: "", Kind: "Secret"},                // the chart's own secrets; bindings' secrets are the runner's
	{Group: "", Kind: "PersistentVolumeClaim"}, // a claim on storage the cluster's StorageClasses provide
	// Networking inside and into the namespace.
	{Group: "", Kind: "Service"},                  // a stable address for the chart's pods
	{Group: "networking.k8s.io", Kind: "Ingress"}, // HTTP routing through the cluster's ingress controller
	// Availability.
	{Group: "autoscaling", Kind: "HorizontalPodAutoscaler"}, // scales a workload in the namespace on load
	{Group: "policy", Kind: "PodDisruptionBudget"},          // limits voluntary evictions of pods in the namespace
}

// RenderByoAppProject renders the hardened AppProject YAML locking BYO charts to their own repos
// + namespaces. Empty inputs are tolerated (an empty sourceRepos/destinations project simply
// admits nothing) so a mis-built snapshot fails closed rather than wide-open. commonLabels are the
// classification/sweep labels stamped onto the AppProject (BYOC B1.4); pass nil to add none.
func RenderByoAppProject(name string, sourceRepos, namespaces []string, commonLabels map[string]string) (string, error) {
	repos := dedupeNonEmpty(sourceRepos)
	ns := dedupeNonEmpty(namespaces)

	for _, r := range repos {
		if byoRepoUnsafe.MatchString(r) {
			return "", fmt.Errorf("render byo AppProject: source repo %q contains a control character", r)
		}
	}
	dests := make([]byoDestination, 0, len(ns))
	for _, n := range ns {
		// The SAME validator RenderByoNamespaces uses, so the two cannot disagree about what is
		// acceptable — which was the stated argument for refusing rather than normalising, and which
		// only holds once BOTH renderers actually apply it.
		if err := validateByoNamespace(n); err != nil {
			return "", fmt.Errorf("render byo AppProject: %w", err)
		}
		dests = append(dests, byoDestination{Namespace: n, Server: "https://kubernetes.default.svc"})
	}

	proj := byoAppProject{
		APIVersion: "argoproj.io/v1alpha1",
		Kind:       "AppProject",
		Metadata: byoProjectMeta{
			Name:       name,
			Namespace:  "argocd",
			Labels:     map[string]string{"alethia.io/managed-by": "byo-charts"},
			Finalizers: []string{"resources-finalizer.argocd.argoproj.io"},
		},
		Spec: byoProjectSpec{
			Description:                "Bring-your-own Helm charts (hardened, default-deny)",
			SourceRepos:                repos,
			Destinations:               dests,
			ClusterResourceWhitelist:   []byoGroupKind{}, // non-nil — see the field comment
			NamespaceResourceWhitelist: append([]byoGroupKind{}, byoWorkloadKinds...),
			NamespaceResourceBlacklist: append([]byoGroupKind{
				{Group: "rbac.authorization.k8s.io", Kind: "Role"},
				{Group: "rbac.authorization.k8s.io", Kind: "RoleBinding"},
				{Group: "", Kind: "ServiceAccount"},
			}, byoSecretSyncDenied...),
			OrphanedResources: byoOrphanedResources{Warn: true},
		},
	}

	rendered, err := encodeByoDocs("AppProject", proj)
	if err != nil {
		return "", err
	}
	labeled, err := InjectCommonLabels(rendered, commonLabels)
	if err != nil {
		return "", fmt.Errorf("label byo AppProject: %w", err)
	}
	return labeled, nil
}

// byoNamespaceTmpl renders the target namespaces for BYO charts.
//
// WHY THE RUNNER MUST CREATE THESE, and why `CreateNamespace=true` cannot.
//
// A BYO Application is rendered with the `CreateNamespace=true` sync option, which asks ArgoCD to
// create the destination namespace as part of the sync. Against a HARDENED BYO AppProject that can
// never work: `clusterResourceWhitelist` is empty, and a Namespace is a cluster-scoped resource —
// the byoAppProject comment above names Namespace in that list explicitly. So ArgoCD is asked
// to create a namespace it is simultaneously forbidden from creating, and every BYO chart whose
// namespace does not already exist fails its sync with
//
//	one or more objects failed to apply, reason: namespaces "<ns>" not found
//
// leaving the Application health=Missing sync=OutOfSync forever. That is not a race and no wait
// fixes it. It is what the BYO-IaC dimension did on its first ever real execution (gcp, #2490's
// sibling): `apps` and `external-secrets-operator` converged, `addon-byo-e2e` did not.
//
// The resolution is NOT to relax the AppProject — the whole point is that an untrusted chart may
// not create cluster-scoped objects. It is for the RUNNER, which is a trusted actor holding the
// cluster's admin kubeconfig, to create the namespace itself before the chart syncs into it. The
// trust boundary is unchanged: the chart still cannot create one.
//
// Pod-level hardening (Pod Security Admission labels + an admission controller) is deliberately NOT
// applied here. byoAppProject's comment scopes that as the separate pod-level half of the
// boundary, and inventing a PSA level here would silently change what customer charts are permitted
// to run — a security posture worth deciding explicitly rather than acquiring as a side effect of a
// bug fix.
// dns1123Label is Kubernetes' own rule for a Namespace name: lowercase alphanumerics and '-',
// starting and ending alphanumeric, at most 63 characters. Matched in FULL — an unanchored pattern
// would accept a valid prefix followed by anything at all, which is the whole attack.
//
// One definition, generated from apps/console/lib/validations/names.ts (#3665). These names stay
// as package-local aliases so the many call sites in this package and preview_validate.go read
// unchanged.
var dns1123Label = names.NamespacePattern

const dns1123LabelMaxLen = names.NamespaceMaxLength

// validateByoNamespace REFUSES a namespace Kubernetes itself would refuse, rather than normalising
// it.
//
// Normalising would be the more forgiving choice and it is the wrong one here, for a reason specific
// to this call site: the SAME string is also written into the hardened AppProject's `destinations`
// list. Silently rewriting it in one place and not the other would produce a project whose
// destination never matches the namespace the chart syncs into, and the failure would surface as an
// ArgoCD permission error naming neither cause.
//
// It also REFUSES a reserved platform namespace (#6439) — see byoReservedNamespaceReason. The shape
// checks run first so a hostile value is reported as malformed, never echoed back as "reserved".
func validateByoNamespace(ns string) error {
	if len(ns) > dns1123LabelMaxLen {
		return fmt.Errorf("namespace %q is %d characters; Kubernetes allows at most %d", ns, len(ns), dns1123LabelMaxLen)
	}
	if !dns1123Label.MatchString(ns) {
		return fmt.Errorf("namespace %q is not a valid DNS-1123 label (lowercase alphanumerics and '-', starting and ending alphanumeric)", ns)
	}
	if reason := byoReservedNamespaceReason(ns); reason != "" {
		return fmt.Errorf("namespace %q is reserved for the platform: %s. Choose a namespace of your own", ns, reason)
	}
	return nil
}

// ValidateByoNamespace is validateByoNamespace for the runner's deploy step, which refuses a BYO
// chart per chart (provisioner.configureByoCharts) before either renderer sees its namespace.
func ValidateByoNamespace(ns string) error { return validateByoNamespace(ns) }

// byoReservedNamespacesJSON is the ONE list of namespaces a BYO chart may never target (#6439).
//
// WHY A BYO CHART MUST NOT SHARE A PLATFORM NAMESPACE. The hardened AppProject denies cluster-scoped
// objects, and admits only a closed list of namespaced workload kinds (byoWorkloadKinds) in its
// destinations. Those kinds include Secret, ConfigMap and Service, so a chart's isolation from the
// platform still rests on the namespace itself. These are the namespaces on the
// platform's side of that line.
//
// The console's BYO form refuses the same names up front from a mirrored copy
// (apps/console/lib/validations/byo-reserved-namespaces.ts) whose parity test deep-equals this file;
// how each group is checked against its source (and which parts are hand-kept) is stated in the JSON's
// own $comment; the Go pins are the TestByoReserved_* tests in byo_test.go. "default" is reserved
// (#6446): it holds the platform's first-class workloads, their binding Secrets and service accounts.
// A chart with no namespace of its own lands in ByoChartNamespace instead. Preview namespaces are not
// reserved either: their prefix is a per-project setting (project_preview_config.namespace_prefix),
// not a fixed platform name.
//
//go:embed byo_reserved_namespaces.json
var byoReservedNamespacesJSON []byte

// byoReservedNamespaceList is the shape of byo_reserved_namespaces.json.
type byoReservedNamespaceList struct {
	Comment string `json:"$comment"`
	Groups  []struct {
		ID         string   `json:"id"`
		Reason     string   `json:"reason"`
		Namespaces []string `json:"namespaces"`
	} `json:"groups"`
	Prefixes []struct {
		Prefix string `json:"prefix"`
		Reason string `json:"reason"`
	} `json:"prefixes"`
}

// byoReservedPrefix is one reserved namespace prefix and why it is reserved.
type byoReservedPrefix struct{ prefix, reason string }

// byoReserved holds the parsed list: exact names → reason, plus the prefixes.
var byoReserved = mustParseByoReserved(byoReservedNamespacesJSON)

// byoReservedIndex is byo_reserved_namespaces.json flattened for lookup.
type byoReservedIndex struct {
	exact    map[string]string
	prefixes []byoReservedPrefix
}

// mustParseByoReserved parses the embedded list, PANICKING on a malformed one. The file is compiled
// into the binary, so a parse failure is a build defect, and every test in this package reds on it —
// an empty list would instead have silently reserved nothing. Unknown fields are refused too, so a
// group added to the JSON in a shape this struct does not read cannot quietly reserve nothing.
func mustParseByoReserved(raw []byte) byoReservedIndex {
	var list byoReservedNamespaceList
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&list); err != nil {
		panic(fmt.Sprintf("byo_reserved_namespaces.json: %v", err))
	}
	idx := byoReservedIndex{exact: map[string]string{}}
	for _, g := range list.Groups {
		if g.ID == "" || g.Reason == "" || len(g.Namespaces) == 0 {
			panic(fmt.Sprintf("byo_reserved_namespaces.json: group %q needs an id, a reason and at least one namespace", g.ID))
		}
		for _, n := range g.Namespaces {
			// A name in two groups keeps the FIRST group's reason; the order is the file's.
			if _, seen := idx.exact[n]; !seen {
				idx.exact[n] = g.Reason
			}
		}
	}
	for _, p := range list.Prefixes {
		if p.Prefix == "" || p.Reason == "" {
			panic("byo_reserved_namespaces.json: every prefix needs a prefix and a reason")
		}
		idx.prefixes = append(idx.prefixes, byoReservedPrefix{prefix: p.Prefix, reason: p.Reason})
	}
	return idx
}

// byoReservedNamespaceReason says why ns is reserved for the platform, or "" when a BYO chart may use
// it. An exact name wins over a prefix, because its reason is the more specific one.
func byoReservedNamespaceReason(ns string) string {
	if reason, ok := byoReserved.exact[ns]; ok {
		return reason
	}
	for _, p := range byoReserved.prefixes {
		if strings.HasPrefix(ns, p.prefix) {
			return p.reason
		}
	}
	return ""
}

// RenderByoNamespaces renders the destination namespaces for a project's BYO charts, so the runner
// can create them before the charts sync. Returns "" when there are none, which callers treat as
// "nothing to apply" rather than an error.
//
// # Why this is marshalled rather than templated (#2540)
//
// It used to interpolate the namespace RAW into hand-rolled YAML. Every other label-emitting path in
// this package round-trips through gopkg.in/yaml.v3 and is therefore quoted correctly; this one did
// not, and it is the one applied with the cluster's ADMIN kubeconfig as a standalone multi-document
// manifest. A namespace containing a newline and a `---` therefore yielded arbitrary top-level
// objects — a ClusterRoleBinding, say — created by the runner, which is precisely the cluster-scoped
// power the hardened AppProject exists to deny an untrusted chart. The fix that created the
// namespace to honour that boundary had opened a way around it.
//
// The value reaches here unvalidated: the console field is `z.string().trim().optional()` with no
// DNS-1123 check, and it lands in a plain `text()` column, so interior newlines survive to the
// runner.
//
// BOTH halves are kept. Marshalling makes injection structurally impossible — yaml.v3 quotes what
// needs quoting, so a hostile value becomes one absurd namespace NAME rather than a second document.
// Validation then refuses that absurd name outright, because a namespace Kubernetes would reject is
// a deploy that fails later and more confusingly. Either alone would close the hole; the pair also
// fails in the right direction.
func RenderByoNamespaces(namespaces []string, commonLabels map[string]string) (string, error) {
	ns := dedupeNonEmpty(namespaces)
	if len(ns) == 0 {
		return "", nil
	}

	labels := map[string]string{"alethia.io/managed-by": "byo-charts"}
	for k, v := range commonLabels {
		labels[k] = v
	}

	// Validate EVERY namespace before encoding any: a refusal must render nothing at all, not a
	// partial stream that happens to stop at the bad one.
	docs := make([]any, 0, len(ns))
	for _, n := range ns {
		if err := validateByoNamespace(n); err != nil {
			return "", fmt.Errorf("render byo namespaces: %w", err)
		}
		docs = append(docs, map[string]any{
			"apiVersion": "v1",
			"kind":       "Namespace",
			"metadata": map[string]any{
				"name":   n,
				"labels": labels,
			},
		})
	}
	return encodeByoDocs("namespaces", docs...)
}

// ByoRepoSecretName is the deterministic ArgoCD repository-Secret name for a BYO chart repo:
// "repo-byo-<12 hex of sha256(url)>". Per-repo (not the shared "repo-apps" name) so multiple
// BYO repos — and the apps-destination repo — never collide or read each other's credentials.
func ByoRepoSecretName(repoURL string) string {
	sum := sha256.Sum256([]byte(repoURL))
	return "repo-byo-" + hex.EncodeToString(sum[:])[:12]
}

// dedupeNonEmpty returns the input with blanks dropped and order-preserving de-duplication.
func dedupeNonEmpty(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}
