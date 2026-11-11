// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// The pod- and object-level half of a BYO namespace's boundary (#6495). The hardened AppProject
// (RenderByoAppProject) decides which KINDS a chart may declare; it cannot see the fields inside an
// admitted kind. Two admission layers do that:
//
//   - Pod Security Admission labels on the namespace (byoPodSecurityLabels), which decide what a pod
//     may ask of its node;
//   - a ValidatingAdmissionPolicy (RenderByoAdmissionPolicy), which refuses four object shapes the
//     AppProject admits by kind but that reach past the chart's own namespace.
//
// # Report first, refuse only where nothing already runs
//
// Either layer, enforced on a namespace whose chart is already running, refuses that chart's NEXT
// pod or object update: a restart, a rollout, a node drain. That is an outage caused by a rule the
// chart never broke when it was attached. So each BYO namespace carries an admission mode
// (ByoAdmissionModeLabel), and the mode decides both layers at once:
//
//   - "enforce": PSA enforce=baseline, and the policy's Deny binding selects the namespace;
//   - "warn": no PSA enforce label (the cluster's own default stays in force), and the policy's
//     Warn+Audit binding selects it instead.
//
// Both modes carry PSA warn=restricted and audit=restricted.
//
// The RUNNER chooses the mode (DecideByoAdmission), from the history of the charts in the namespace
// (#6541): a namespace holding only charts that have never run in this environment starts in
// "enforce"; one holding a chart that has run here, or one a #6446 move brings a chart into, starts in
// "warn"; a namespace that already carries a mode keeps it. A namespace that exists and is not a BYO
// namespace of this environment is refused to a new chart. The runner never moves a namespace from
// "warn" to "enforce" because of what it finds: that step is the environment's setting
// (types.ByoAdmissionConfig.Enforce), which a person turns on in the console, or an explicit relabel
// of the namespace. The runner reports what "warn" lets through on every deploy
// (ByoAdmissionViolations, PreviewByoPodSecurity), so a user knows before the step is taken.

// ByoAdmissionModeLabel is the namespace label carrying a BYO namespace's admission mode. The
// policy bindings select on it, and RenderByoNamespaces renders the PSA labels from it. Namespace
// is cluster-scoped, so a chart cannot change it: the hardened AppProject's clusterResourceWhitelist
// is empty.
//
// A KNOWN TRANSIENT, accepted until every runner on a cluster is at least this version: namespaces
// are applied with client-side `kubectl apply`, so a runner built before #6495 re-applying the same
// Namespace (two environments sharing one, or a rollback) computes its three-way merge against the
// last-applied annotation this runner wrote and REMOVES this label and the PSA labels. The namespace
// then matches neither binding, and the next deploy by a current runner finds it existing with no
// mode and sets "warn". That fails open, never into an outage; it stops once old runners are gone.
const ByoAdmissionModeLabel = "alethia.io/byo-admission"

// ByoAdmissionMode is one value of ByoAdmissionModeLabel.
type ByoAdmissionMode string

const (
	// ByoAdmissionEnforce refuses: PSA enforce=baseline and the policy's Deny binding.
	ByoAdmissionEnforce ByoAdmissionMode = "enforce"
	// ByoAdmissionWarn reports only: no PSA enforce label and the policy's Warn+Audit binding.
	ByoAdmissionWarn ByoAdmissionMode = "warn"
)

// valid reports whether m is one of the two modes the bindings select.
func (m ByoAdmissionMode) valid() bool { return m == ByoAdmissionEnforce || m == ByoAdmissionWarn }

// The Pod Security Admission labels (https://kubernetes.io/docs/concepts/security/pod-security-admission/).
const (
	psaLabelPrefix         = "pod-security.kubernetes.io/"
	psaEnforceLabel        = "pod-security.kubernetes.io/enforce"
	psaEnforceVersionLabel = "pod-security.kubernetes.io/enforce-version"
	psaWarnLabel           = "pod-security.kubernetes.io/warn"
	psaWarnVersionLabel    = "pod-security.kubernetes.io/warn-version"
	psaAuditLabel          = "pod-security.kubernetes.io/audit"
	psaAuditVersionLabel   = "pod-security.kubernetes.io/audit-version"
)

// byoPodSecurityEnforceLevel is "baseline", not "restricted", and the reason is evidence rather
// than taste:
//
//   - Baseline forbids exactly the host-reaching fields: privileged containers, host namespaces
//     (hostNetwork, hostPID, hostIPC), hostPath volumes, hostPorts, added capabilities beyond the
//     default set, and unconfined seccomp/AppArmor/SELinux/procMount/sysctls. A pod that sets no
//     securityContext at all passes it — the upstream standard describes it as allowing "the
//     default (minimally specified) Pod configuration".
//   - Restricted additionally REQUIRES fields: runAsNonRoot, allowPrivilegeEscalation=false,
//     capabilities drop ALL, a RuntimeDefault seccomp profile. Most public charts leave those to
//     the user, so restricted refuses an ordinary chart that asks for nothing from its node.
//   - Talos, which every hetzner cluster runs, already enforces baseline on every namespace but
//     kube-system, and BYO charts there run under it today (#2837, addon_podsecurity_test.go). The
//     platform's own namespace-tenant and preview namespaces enforce baseline too.
//
// Restricted is still the target the chart is told about: warn and audit report against it.
const (
	byoPodSecurityEnforceLevel = "baseline"
	byoPodSecurityReportLevel  = "restricted"
)

// byoPodSecurityVersion pins the PSA policy version to the oldest Kubernetes minor the platform
// supports (packages/core/compat/matrix.json: aws, gcp, azure and alibaba 1.33-1.35; hetzner 1.35),
// rather than "latest". With "latest", a cluster upgrade can change what is refused without anyone
// deploying anything. A pinned version newer than an older cluster's API server (a local kind
// cluster, say) is evaluated as that server's latest, so the pin is never itself a failure.
// Raising it is a decision, made when the oldest supported minor moves.
const byoPodSecurityVersion = "v1.33"

// byoPodSecurityLabels are the PSA labels for a namespace in mode m. An unknown mode is treated as
// "warn": a mode the runner did not decide must never be read as permission to refuse.
func byoPodSecurityLabels(m ByoAdmissionMode) map[string]string {
	out := map[string]string{
		psaWarnLabel:         byoPodSecurityReportLevel,
		psaWarnVersionLabel:  byoPodSecurityVersion,
		psaAuditLabel:        byoPodSecurityReportLevel,
		psaAuditVersionLabel: byoPodSecurityVersion,
	}
	if m == ByoAdmissionEnforce {
		out[psaEnforceLabel] = byoPodSecurityEnforceLevel
		out[psaEnforceVersionLabel] = byoPodSecurityVersion
	}
	return out
}

// ByoAdmissionSourceLabel marks a namespace whose "enforce" comes from the environment's setting
// (types.ByoAdmissionConfig.Enforce, #6541) rather than from the namespace's own history. It is what
// makes the setting reversible: with the setting turned off, a namespace carrying it returns to
// "warn", the mode it had before the setting moved it; a namespace in "enforce" without it — one
// created for a new chart, or one a person relabelled — stays in "enforce". The bindings do not read
// it; only DecideByoAdmission does.
const ByoAdmissionSourceLabel = "alethia.io/byo-admission-source"

// byoAdmissionSourceSetting is ByoAdmissionSourceLabel's one value.
const byoAdmissionSourceSetting = "environment-setting"

// ByoAdmissionReason is why DecideByoAdmission chose a namespace's mode, or refused its charts. The
// Deploy tab shows it, so the values are a closed vocabulary rather than prose.
type ByoAdmissionReason string

const (
	// ByoAdmissionReasonKept: the namespace already carried a mode, and keeps it.
	ByoAdmissionReasonKept ByoAdmissionReason = "kept"
	// ByoAdmissionReasonSetting: the environment's setting puts the namespace in "enforce".
	ByoAdmissionReasonSetting ByoAdmissionReason = "environment-setting"
	// ByoAdmissionReasonSettingOff: the setting had put the namespace in "enforce" and is now off,
	// so it returns to "warn".
	ByoAdmissionReasonSettingOff ByoAdmissionReason = "environment-setting-off"
	// ByoAdmissionReasonHistory: a chart in the namespace has run in this environment — its ArgoCD
	// Application exists, or the console last read it in a state with resources (types.ByoAdmissionConfig),
	// or a #6446 move brings it in — so something of it may run there, or will, on its next sync.
	ByoAdmissionReasonHistory ByoAdmissionReason = "chart-history"
	// ByoAdmissionReasonOwned: no chart in it has run before, but the namespace is already one of this
	// environment's BYO namespaces — what a detached chart left there may still run.
	ByoAdmissionReasonOwned ByoAdmissionReason = "environment-namespace"
	// ByoAdmissionReasonNew: a namespace created on this deploy for charts that have never run.
	ByoAdmissionReasonNew ByoAdmissionReason = "new-namespace"
	// ByoAdmissionReasonForeign: REFUSED — a namespace that exists, is not a BYO namespace of this
	// environment, and in which no chart of this environment's Application already deploys.
	ByoAdmissionReasonForeign ByoAdmissionReason = "not-this-environments-namespace"
)

// ByoAdmissionInput is everything DecideByoAdmission reads. It is only ever built from a cluster
// that WAS read: the runner fails the deploy when the namespaces or the charts' Applications cannot
// be read (decideByoAdmission), so there is no "unknown" input here to decide on.
type ByoAdmissionInput struct {
	// Namespaces are the accepted BYO namespaces this environment renders (never one another
	// environment holds, #6562).
	Namespaces []string
	// Live maps every namespace that exists on the cluster to its labels (ReadByoNamespaceLabels).
	Live map[string]map[string]string
	// RunsHere marks a namespace into which the live ArgoCD Application of one of its charts already
	// deploys. It is read from the cluster on this deploy and is the ONLY thing that lets a chart into
	// an existing namespace that is not this environment's: what a chart has run elsewhere, or what
	// the console remembers, never does.
	RunsHere map[string]bool
	// History marks a namespace holding a chart that has run in this environment by any signal —
	// RunsHere, an Application with another destination, the console's record, or a #6446 move. It
	// only chooses "warn" over "enforce"; it never lifts a refusal.
	History map[string]bool
	// Owner is this environment's owner-label value (ByoBindingOwnerLabel). Empty means no namespace
	// can be shown to be this environment's.
	Owner string
	// Enforce is the environment's setting.
	Enforce bool
}

// ByoAdmissionDecision is one namespace's outcome.
type ByoAdmissionDecision struct {
	// Mode is the mode to render. Meaningless when Refused.
	Mode ByoAdmissionMode
	// BySetting is set when Mode is "enforce" only because of the environment's setting; the
	// namespace is then rendered with ByoAdmissionSourceLabel.
	BySetting bool
	// Previous is the namespace's live mode before this deploy, "" when it had none.
	Previous ByoAdmissionMode
	// Reason is why.
	Reason ByoAdmissionReason
	// Refused is set when the namespace's charts must not be deployed (ByoAdmissionReasonForeign).
	Refused bool
}

// DecideByoAdmission decides each BYO namespace's admission mode from the history of the charts in it
// (#6541), and refuses the charts of a namespace that a new chart may not take over.
//
// # The rule
//
// The property is: a BYO namespace refuses (enforce) whenever nothing already runs in it that the
// refusal could break. Whether the namespace EXISTS is a poor stand-in for that, wrong both ways
// (#6541): a chart whose namespace is new to the cluster may have run before — its namespace was
// changed in the console, the cluster was re-provisioned, or the namespace was deleted and recreated —
// and a brand-new chart may target a namespace that exists and holds something else entirely. So, in
// this order:
//
//  1. A namespace that exists, is not a BYO namespace of this environment (managed-by=byo-charts AND
//     this environment's owner label), and into which no chart's live Application already deploys
//     (RunsHere) is REFUSED (ByoAdmissionReasonForeign) — whatever labels it carries.
//  2. A namespace that already carries a mode keeps it, unless that "enforce" came from the
//     environment's setting (ByoAdmissionSourceLabel) and the setting is now off: it returns to "warn".
//  3. A namespace holding a chart that has run in this environment (History) gets "warn".
//  4. A namespace that does not exist gets "enforce"; one that is this environment's own BYO
//     namespace gets "warn", since a detached chart's objects may remain.
//  5. With the environment's setting on, every namespace that would otherwise be in "warn" is put in
//     "enforce", marked BySetting. The setting does not lift a refusal.
//
// # Why only the live Application lifts the refusal
//
// The refusal exists so that a chart cannot take over a namespace that is someone else's. What
// lifts it must therefore prove the chart ALREADY RUNS in that very namespace, which only the
// cluster can say: its Application exists with that destination. A console record cannot (it is
// written from a health read that may name an Application that does not exist), and neither can an
// Application deploying somewhere else (attach in your own namespace, then change it to a foreign
// one). Both still count as history for choosing "warn" over "enforce", where being wrong costs a
// refused pod, not a takeover.
//
// # Why a foreign namespace is refused, and not started in "enforce"
//
// Both stop the chart running unrefused, but "enforce" is applied to the NAMESPACE, not the chart:
// Pod Security baseline and the Deny binding would then refuse the next pod and the next update of
// everything already in it — workloads this environment did not put there and cannot see. That is the
// outage the "warn" mode exists to prevent, imposed on someone else. Taking the namespace over would
// also stamp it with managed-by, the owner label and the secret-store stamp, which admits whatever
// already runs there to the platform's ClusterSecretStores. Refusing breaks nothing: no Application of
// the chart deploys there, and the warning tells the user to pick another namespace (a blank one gives
// byo-<chart id>). It is also the rule a namespace placement follows for its own namespace (#6551),
// and it is a superset of #6562's refusal of a namespace another environment or a placement holds,
// which runs first and leaves those namespaces out of Namespaces.
func DecideByoAdmission(in ByoAdmissionInput) map[string]ByoAdmissionDecision {
	out := make(map[string]ByoAdmissionDecision, len(in.Namespaces))
	for _, ns := range in.Namespaces {
		labels, exists := in.Live[ns]
		live := ByoAdmissionMode(labels[ByoAdmissionModeLabel])
		d := ByoAdmissionDecision{}
		if live.valid() {
			d.Previous = live
		}
		owned := isEnvironmentByoNamespace(labels, in.Owner)
		switch {
		case exists && !owned && !in.RunsHere[ns]:
			out[ns] = ByoAdmissionDecision{Previous: d.Previous, Reason: ByoAdmissionReasonForeign, Refused: true}
			continue
		case live == ByoAdmissionEnforce && labels[ByoAdmissionSourceLabel] == byoAdmissionSourceSetting:
			// The setting's own "enforce": underneath it the namespace was in "warn".
			d.Mode, d.Reason = ByoAdmissionWarn, ByoAdmissionReasonSettingOff
		case live.valid():
			d.Mode, d.Reason = live, ByoAdmissionReasonKept
		case in.History[ns] || in.RunsHere[ns]:
			d.Mode, d.Reason = ByoAdmissionWarn, ByoAdmissionReasonHistory
		case !exists:
			d.Mode, d.Reason = ByoAdmissionEnforce, ByoAdmissionReasonNew
		default: // exists and owned
			d.Mode, d.Reason = ByoAdmissionWarn, ByoAdmissionReasonOwned
		}
		if in.Enforce && d.Mode == ByoAdmissionWarn {
			d.Mode, d.BySetting, d.Reason = ByoAdmissionEnforce, true, ByoAdmissionReasonSetting
		}
		out[ns] = d
	}
	return out
}

// isEnvironmentByoNamespace reports whether a namespace's labels make it a BYO namespace of the
// environment whose owner-label value is owner: the managed-by marker RenderByoNamespaces stamps AND
// that environment's owner label. Either alone is not enough — the owner label is a classification
// label the platform stamps on other namespaces too, and managed-by alone is any environment's.
func isEnvironmentByoNamespace(labels map[string]string, owner string) bool {
	return owner != "" && labels[byoNamespaceManagedByLabel] == byoNamespaceManagedByValue && labels[ByoBindingOwnerLabel] == owner
}

// ByoAdmissionModes is the mode of every namespace decisions does not refuse.
func ByoAdmissionModes(decisions map[string]ByoAdmissionDecision) map[string]ByoAdmissionMode {
	out := make(map[string]ByoAdmissionMode, len(decisions))
	for ns, d := range decisions {
		if !d.Refused {
			out[ns] = d.Mode
		}
	}
	return out
}

// ByoAdmissionNamespaceStatus is one BYO namespace as a deploy left it (#6541). It rides
// GitopsStatus.ByoAdmission, so the console's Deploy tab can show each namespace's mode and what
// changed, and the environment's admission setting can show what turning it on would refuse BEFORE
// a person turns it on. It carries no secret: names, modes, and the report's findings (object kinds,
// names and fields, and Pod Security's pod summaries). Mirrors the TS ByoAdmissionNamespaceReport
// in apps/console/types/jsonb.types.ts.
type ByoAdmissionNamespaceStatus struct {
	// Namespace is the BYO namespace.
	Namespace string `json:"namespace"`
	// Charts are the ids of the charts in it, sorted.
	Charts []string `json:"charts"`
	// Mode is "enforce", "warn", or ByoAdmissionStatusRefused when its charts were not deployed.
	Mode string `json:"mode"`
	// Previous is the mode the namespace had before this deploy, "" when it had none.
	Previous string `json:"previous,omitempty"`
	// Reason is the ByoAdmissionReason the mode was chosen for.
	Reason string `json:"reason"`
	// Findings are what the rules refuse, or would refuse once the namespace is in "enforce": each
	// live object's kind, name and field, then Pod Security baseline's pod summaries.
	Findings []string `json:"findings,omitempty"`
	// PolicyUnavailable is why the cluster runs no admission policy, or "".
	PolicyUnavailable string `json:"policy_unavailable,omitempty"`
	// Checks say, per kind, whether this deploy checked the namespace: one entry for each of
	// ByoAdmissionObjectKinds and one for "PodSecurity". Empty for a refused namespace, which was not
	// deployed. A report with any "failed" check is INCOMPLETE: its findings are not the whole answer.
	Checks []ByoAdmissionCheck `json:"checks,omitempty"`
}

// ByoAdmissionCheck is one kind of check one deploy ran on a BYO namespace (#6541).
type ByoAdmissionCheck struct {
	// Kind is "Service", "Ingress", "Secret" or "PodSecurity".
	Kind string `json:"kind"`
	// State is ByoAdmissionCheckChecked, ByoAdmissionCheckFailed or ByoAdmissionCheckEnforced.
	State string `json:"state"`
}

// The states of a ByoAdmissionCheck.
const (
	// ByoAdmissionCheckChecked: the kind was read and checked; its findings are complete.
	ByoAdmissionCheckChecked = "checked"
	// ByoAdmissionCheckFailed: the kind could not be read or checked; nothing is known about it.
	ByoAdmissionCheckFailed = "failed"
	// ByoAdmissionCheckEnforced: Pod Security in an "enforce" namespace — the label already enforces
	// baseline, so there is no "what would enforcing refuse" to preview.
	ByoAdmissionCheckEnforced = "enforced"
)

// ByoAdmissionStatusRefused is ByoAdmissionNamespaceStatus.Mode for a namespace whose charts the
// decision refused.
const ByoAdmissionStatusRefused = "refused"

// ReadByoNamespaceLabels reads which of namespaces exist on the cluster, and their labels, in one
// call. A namespace missing from the result does not exist. An error means nothing is known, and
// the caller must not read it as "none exist" — that would put every existing namespace in
// "enforce".
func ReadByoNamespaceLabels(namespaces []string) (map[string]map[string]string, error) {
	namespaces = dedupeNonEmpty(namespaces)
	if len(namespaces) == 0 {
		return map[string]map[string]string{}, nil
	}
	for _, ns := range namespaces {
		if !k8sNameRe.MatchString(ns) {
			return nil, fmt.Errorf("refusing to read namespace %q: not a Kubernetes name", ns)
		}
	}
	out, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get namespace %s --ignore-not-found -o json", strings.Join(namespaces, " ")), ".", nil)
	if err != nil {
		return nil, fmt.Errorf("read BYO namespaces: %w", err)
	}
	return parseNamespaceLabels(out)
}

// liveNamespace is the slice of a Namespace (or a List of them) parseNamespaceLabels reads.
type liveNamespace struct {
	Kind     string `json:"kind"`
	Metadata struct {
		Name   string            `json:"name"`
		Labels map[string]string `json:"labels"`
	} `json:"metadata"`
	Items []liveNamespace `json:"items"`
}

// parseNamespaceLabels reads `kubectl get namespace … --ignore-not-found -o json`. kubectl prints
// nothing when no named namespace exists, a List for several, and may print the bare object for
// one; all three are read.
func parseNamespaceLabels(raw string) (map[string]map[string]string, error) {
	out := map[string]map[string]string{}
	if strings.TrimSpace(raw) == "" {
		return out, nil
	}
	var doc liveNamespace
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		return nil, fmt.Errorf("parse BYO namespaces: %w", err)
	}
	items := doc.Items
	if doc.Kind == "Namespace" {
		items = []liveNamespace{doc}
	}
	for _, it := range items {
		if it.Metadata.Name != "" {
			out[it.Metadata.Name] = it.Metadata.Labels
		}
	}
	return out, nil
}

// ---- The ValidatingAdmissionPolicy ----

// Name PREFIXES of the policies and their bindings; each policy is named <prefix>-<resource>
// (ByoAdmissionPolicyNames).
//
// Separate REPORT and ENFORCE policies, not one with two bindings, because failurePolicy belongs to
// the policy: the reporting ones are "Ignore", so that a policy the API server cannot evaluate never
// refuses an object in a namespace that is only meant to be warned; the refusing ones are "Fail", so
// that the same failure does not quietly admit everything.
//
// And one policy PER KIND, because the API server type-checks every expression of a policy against
// every kind the policy matches. With all three kinds in one policy, a Service expression was
// checked against Secret and Ingress and status.typeChecking reported "ERROR: undefined field
// 'spec'" for it (measured on Kubernetes 1.33.4 by byo-admission-kind.yml). The kind guard made that
// harmless at runtime, but an operator reading the policy's status sees ERROR and concludes it is
// broken. Matched to one kind, each expression is checked only against the object it reads.
const (
	ByoAdmissionEnforcePolicy = "alethia-byo-admission-enforce"
	ByoAdmissionReportPolicy  = "alethia-byo-admission-report"
)

// byoAdmissionKinds are the kinds the rules read and the resource each is matched as.
var byoAdmissionKinds = []struct{ Kind, Group, Resource string }{
	{"Service", "", "services"},
	{"Secret", "", "secrets"},
	{"Ingress", "networking.k8s.io", "ingresses"},
}

// ByoAdmissionPolicyNames are the names of every policy (and of its binding, which shares it) that
// RenderByoAdmissionPolicy renders: report first, then enforce, each in byoAdmissionKinds order.
func ByoAdmissionPolicyNames() []string {
	var out []string
	for _, prefix := range []string{ByoAdmissionReportPolicy, ByoAdmissionEnforcePolicy} {
		for _, k := range byoAdmissionKinds {
			out = append(out, prefix+"-"+k.Resource)
		}
	}
	return out
}

// byoForbiddenServiceTypes are the Service types a BYO chart may not declare. Each one opens a port
// on the cluster's NODES (NodePort) or provisions a cloud load balancer (LoadBalancer, which also
// allocates node ports): the Service then answers outside the chart's namespace and outside the
// cluster, and a LoadBalancer is billed to the customer's cloud account. A chart reaches the
// outside through an Ingress, which goes through the platform's ingress controller.
//
// "Unless the project allows it": no project setting allows it today, so the rule is unconditional.
// An allowance would be a per-namespace exemption the runner stamps from such a setting; it is not
// added before the setting exists.
var byoForbiddenServiceTypes = []string{"LoadBalancer", "NodePort"}

// byoServiceAccountTokenSecretType is the Secret type the token controller fills with a token for
// the ServiceAccount the Secret names. What the rule prevents is that token's LIFETIME, not access
// to the identity: a pod in the namespace already receives the ServiceAccount's projected token
// (unless automount is off), but that token is short-lived, bound to the pod and rotated by the
// kubelet. The Secret's token never expires and is stored, so it outlives the pod and anything that
// can read the Secret can use it indefinitely.
const byoServiceAccountTokenSecretType = "kubernetes.io/service-account-token"

// byoSnippetMarker is what an Ingress annotation key contains when it hands the ingress controller
// raw configuration: ingress-nginx's configuration-, server-, auth- and stream-snippet, NGINX Inc's
// server- and location-snippets, HAProxy's config-snippets. A snippet runs inside the controller,
// which serves every namespace and holds every namespace's TLS keys, so it is configuration of the
// platform rather than of the chart. Matched case-insensitively anywhere in the key, so a
// controller's next snippet annotation is refused without editing this.
const byoSnippetMarker = "snippet"

// byoAdmissionRule is one rule of the policy: its CEL expression, the message the API server
// returns, and the Go predicate the runner uses to REPORT the same rule against live objects.
//
// Both halves are built from the same data (the variables above), so a forbidden value cannot be
// added to one and not the other. The CEL half is not executed by this package's tests — there is
// no CEL evaluator in this module's graph — so TestByoAdmissionPolicyExpressionsNameTheirData pins
// each expression's guard, field and values; what the API server makes of it is the cluster's to
// show.
type byoAdmissionRule struct {
	ID         string
	Kind       string
	Expression string
	Message    string
	// Violates says what o does that the rule refuses ("spec.type is LoadBalancer"), or "".
	Violates func(o ByoAdmissionObject) string
}

// celStringList renders a CEL list literal of single-quoted strings. The values are this file's
// constants, none of which contains a quote.
func celStringList(vs []string) string {
	q := make([]string, len(vs))
	for i, v := range vs {
		q[i] = "'" + v + "'"
	}
	return "[" + strings.Join(q, ", ") + "]"
}

// byoAdmissionRules are the policy's rules, in the order they render.
var byoAdmissionRules = []byoAdmissionRule{
	{
		ID:   "service-exposure",
		Kind: "Service",
		Expression: "request.kind.kind != 'Service' || !has(object.spec.type) || !(object.spec.type in " +
			celStringList(byoForbiddenServiceTypes) + ")",
		Message: "a bring-your-own chart may not declare a Service of type " + strings.Join(byoForbiddenServiceTypes, " or ") +
			": it would answer outside the chart's namespace. Use type ClusterIP and an Ingress.",
		Violates: func(o ByoAdmissionObject) string {
			if o.Kind != "Service" {
				return ""
			}
			for _, t := range byoForbiddenServiceTypes {
				if o.ServiceType == t {
					return "spec.type is " + t
				}
			}
			return ""
		},
	},
	{
		ID:         "service-external-ips",
		Kind:       "Service",
		Expression: "request.kind.kind != 'Service' || !has(object.spec.externalIPs) || size(object.spec.externalIPs) == 0",
		Message:    "a bring-your-own chart may not set spec.externalIPs on a Service: it would capture traffic the cluster's nodes receive for those addresses.",
		Violates: func(o ByoAdmissionObject) string {
			if o.Kind == "Service" && len(o.ExternalIPs) > 0 {
				return "spec.externalIPs is set"
			}
			return ""
		},
	},
	{
		ID:   "service-account-token-secret",
		Kind: "Secret",
		Expression: "request.kind.kind != 'Secret' || !has(object.type) || object.type != '" +
			byoServiceAccountTokenSecretType + "'",
		Message: "a bring-your-own chart may not declare a Secret of type " + byoServiceAccountTokenSecretType +
			": it stores a ServiceAccount token that never expires. Pods already receive short-lived projected tokens without it.",
		Violates: func(o ByoAdmissionObject) string {
			if o.Kind == "Secret" && o.SecretType == byoServiceAccountTokenSecretType {
				return "type is " + byoServiceAccountTokenSecretType
			}
			return ""
		},
	},
	{
		ID:   "ingress-snippet-annotation",
		Kind: "Ingress",
		Expression: "request.kind.kind != 'Ingress' || !has(object.metadata.annotations) || " +
			"object.metadata.annotations.all(k, !k.lowerAscii().contains('" + byoSnippetMarker + "'))",
		Message: "a bring-your-own chart may not set an Ingress annotation that configures the ingress controller with a snippet: " +
			"a snippet runs inside the controller, which serves every namespace.",
		Violates: func(o ByoAdmissionObject) string {
			if o.Kind != "Ingress" {
				return ""
			}
			var keys []string
			for k := range o.Annotations {
				if strings.Contains(strings.ToLower(k), byoSnippetMarker) {
					keys = append(keys, k)
				}
			}
			if len(keys) == 0 {
				return ""
			}
			sort.Strings(keys)
			return "annotation " + strings.Join(keys, ", ") + " configures the ingress controller with a snippet"
		},
	},
}

// The policy's wire shape. Typed structs, marshalled, for the reasons byoAppProject gives.
type byoAdmissionMeta struct {
	Name        string            `yaml:"name"`
	Labels      map[string]string `yaml:"labels"`
	Annotations map[string]string `yaml:"annotations"`
}

// ByoAdmissionSchemaAnnotation carries the version of the rule set a runner applied, on each of the
// twelve cluster-scoped policy objects (six policies and their bindings).
//
// WHY. The objects are shared by every environment on the cluster, and every runner re-applies its
// own copy on every deploy, so the last writer wins. While rules are only ever added that is
// harmless. Once a rule is removed or loosened, an OLDER runner still deploying to the same cluster
// (another environment not yet upgraded, or a rollback) would put it back on every one of its
// deploys. So a runner reads the live version first and never replaces a newer one; it reports
// instead (ByoAdmissionPolicyNewerLive).
const ByoAdmissionSchemaAnnotation = "alethia.io/byo-admission-schema"

// byoAdmissionSchemaVersion is this runner's rule-set version. Raise it with ANY change to the
// rendered policies or bindings — a rule, a message, a selector, a failurePolicy — so that a runner
// built before the change cannot undo it.
const byoAdmissionSchemaVersion = 1

type byoAdmissionPolicy struct {
	APIVersion string                 `yaml:"apiVersion"`
	Kind       string                 `yaml:"kind"`
	Metadata   byoAdmissionMeta       `yaml:"metadata"`
	Spec       byoAdmissionPolicySpec `yaml:"spec"`
}

type byoAdmissionPolicySpec struct {
	FailurePolicy    string              `yaml:"failurePolicy"`
	MatchConstraints byoMatchConstraints `yaml:"matchConstraints"`
	Validations      []byoValidation     `yaml:"validations"`
}

type byoMatchConstraints struct {
	ResourceRules []byoResourceRule `yaml:"resourceRules"`
}

type byoResourceRule struct {
	APIGroups   []string `yaml:"apiGroups"`
	APIVersions []string `yaml:"apiVersions"`
	Operations  []string `yaml:"operations"`
	Resources   []string `yaml:"resources"`
}

type byoValidation struct {
	Expression string `yaml:"expression"`
	Message    string `yaml:"message"`
	Reason     string `yaml:"reason"`
}

type byoAdmissionBinding struct {
	APIVersion string                  `yaml:"apiVersion"`
	Kind       string                  `yaml:"kind"`
	Metadata   byoAdmissionMeta        `yaml:"metadata"`
	Spec       byoAdmissionBindingSpec `yaml:"spec"`
}

type byoAdmissionBindingSpec struct {
	PolicyName        string            `yaml:"policyName"`
	ValidationActions []string          `yaml:"validationActions"`
	MatchResources    byoMatchResources `yaml:"matchResources"`
}

type byoMatchResources struct {
	NamespaceSelector byoLabelSelector `yaml:"namespaceSelector"`
}

type byoLabelSelector struct {
	MatchLabels map[string]string `yaml:"matchLabels"`
}

// RenderByoAdmissionPolicy renders the BYO ValidatingAdmissionPolicies and their bindings: for each
// of the two modes, one policy per kind (byoAdmissionKinds) carrying that kind's rules, each bound
// once under its own name. The two modes' policies carry the same rules and differ in failurePolicy
// and in the mode their binding selects:
//
//   - the report bindings: validationActions [Warn, Audit], namespaces in mode "warn";
//   - the enforce bindings: validationActions [Deny], namespaces in mode "enforce".
//
// Each binding selects BOTH the managed-by marker and an explicit mode value. A namespace with no
// mode — "default" stamped by a runner before #6446, say — is selected by none, so no binding
// reaches a namespace this runner did not decide.
//
// The policies match CREATE and UPDATE only. An object already in the cluster is untouched until
// something changes it, which is when the next ArgoCD sync of a changed chart would be refused.
//
// They carry NO environment's classification labels, unlike the AppProject. The objects are
// cluster-scoped and shared by every environment whose charts run on the cluster, so stamping one
// environment's owner on them would let that environment's teardown sweep remove the policy from
// under the others.
func RenderByoAdmissionPolicy() (string, error) {
	meta := func(name string) byoAdmissionMeta {
		return byoAdmissionMeta{
			Name:        name,
			Labels:      map[string]string{byoNamespaceManagedByLabel: byoNamespaceManagedByValue},
			Annotations: map[string]string{ByoAdmissionSchemaAnnotation: strconv.Itoa(byoAdmissionSchemaVersion)},
		}
	}
	var docs []any
	for _, mode := range []struct {
		prefix, failure string
		actions         []string
		selects         ByoAdmissionMode
	}{
		{ByoAdmissionReportPolicy, "Ignore", []string{"Warn", "Audit"}, ByoAdmissionWarn},
		{ByoAdmissionEnforcePolicy, "Fail", []string{"Deny"}, ByoAdmissionEnforce},
	} {
		for _, k := range byoAdmissionKinds {
			var validations []byoValidation
			for _, r := range byoAdmissionRules {
				if r.Kind == k.Kind {
					validations = append(validations, byoValidation{Expression: r.Expression, Message: r.Message, Reason: "Forbidden"})
				}
			}
			name := mode.prefix + "-" + k.Resource
			docs = append(docs, byoAdmissionPolicy{
				APIVersion: "admissionregistration.k8s.io/v1",
				Kind:       "ValidatingAdmissionPolicy",
				Metadata:   meta(name),
				Spec: byoAdmissionPolicySpec{
					FailurePolicy: mode.failure,
					MatchConstraints: byoMatchConstraints{ResourceRules: []byoResourceRule{{
						APIGroups: []string{k.Group}, APIVersions: []string{"v1"}, Operations: []string{"CREATE", "UPDATE"}, Resources: []string{k.Resource},
					}}},
					Validations: validations,
				},
			}, byoAdmissionBinding{
				APIVersion: "admissionregistration.k8s.io/v1",
				Kind:       "ValidatingAdmissionPolicyBinding",
				Metadata:   meta(name),
				Spec: byoAdmissionBindingSpec{
					PolicyName:        name,
					ValidationActions: mode.actions,
					MatchResources: byoMatchResources{NamespaceSelector: byoLabelSelector{MatchLabels: map[string]string{
						byoNamespaceManagedByLabel: byoNamespaceManagedByValue,
						ByoAdmissionModeLabel:      string(mode.selects),
					}}},
				},
			})
		}
	}
	return encodeByoDocs("admission policy", docs...)
}

// ByoAdmissionPolicyNewerLive reads the live BYO policy objects (by their managed-by label) and
// says whether any of them carries a NEWER rule-set version than this runner's, naming it. A runner
// that finds one must not apply its own (see ByoAdmissionSchemaAnnotation). An error means the
// live objects could not be read, and the caller must not apply blind either.
func ByoAdmissionPolicyNewerLive() (string, error) {
	out, err := utils.ExecuteCommandWithOutput(fmt.Sprintf(
		"kubectl get validatingadmissionpolicies.admissionregistration.k8s.io,validatingadmissionpolicybindings.admissionregistration.k8s.io -l %s=%s -o json",
		byoNamespaceManagedByLabel, byoNamespaceManagedByValue), ".", nil)
	if err != nil {
		return "", fmt.Errorf("read the live BYO admission policy: %w", err)
	}
	return byoAdmissionNewerLive(out, byoAdmissionSchemaVersion)
}

// byoAdmissionNewerLive reads a `kubectl get … -o json` List and returns a description of the first
// object whose schema version is newer than ours, or "". An object with no annotation predates the
// annotation, so it is older. An annotation that is not a whole number was not written by any runner
// this code knows, so it is treated as newer: replacing what cannot be read is the unsafe direction.
func byoAdmissionNewerLive(raw string, ours int) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", nil
	}
	var list struct {
		Items []struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name        string            `json:"name"`
				Annotations map[string]string `json:"annotations"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return "", fmt.Errorf("parse the live BYO admission policy: %w", err)
	}
	for _, it := range list.Items {
		v, ok := it.Metadata.Annotations[ByoAdmissionSchemaAnnotation]
		if !ok {
			continue
		}
		n, err := strconv.Atoi(v)
		if err != nil || n > ours {
			return fmt.Sprintf("%s %s carries rule-set version %q, newer than this runner's %d", it.Kind, it.Metadata.Name, v, ours), nil
		}
	}
	return "", nil
}

// ByoAdmissionPolicyAvailability says whether the cluster serves ValidatingAdmissionPolicy at
// admissionregistration.k8s.io/v1 — GA in Kubernetes 1.30 — and, when it does not, why. Asked of
// the API server's discovery document rather than inferred from a version number: every minor the
// platform provisions (1.33-1.35) serves it, but a local kind cluster or an attached cluster may be
// older, and a version string says nothing about a disabled API. The caller skips the policy on
// such a cluster with the reason, and still reports violations, rather than failing the deploy.
func ByoAdmissionPolicyAvailability() (bool, string) {
	out, err := utils.ExecuteCommandWithOutput("kubectl get --raw /apis/admissionregistration.k8s.io/v1", ".", nil)
	if err != nil {
		return false, fmt.Sprintf("could not read the cluster's admission APIs: %v", err)
	}
	return admissionPolicyServed(out)
}

// admissionPolicyServed reads an APIResourceList for the policy and binding resources.
func admissionPolicyServed(raw string) (bool, string) {
	var list struct {
		Resources []struct {
			Name string `json:"name"`
		} `json:"resources"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return false, "could not read the cluster's admission APIs: the discovery document did not parse"
	}
	served := map[string]bool{}
	for _, r := range list.Resources {
		served[r.Name] = true
	}
	if !served["validatingadmissionpolicies"] || !served["validatingadmissionpolicybindings"] {
		return false, "the cluster does not serve ValidatingAdmissionPolicy at admissionregistration.k8s.io/v1 (Kubernetes 1.30 or later)"
	}
	return true, ""
}

// ---- Reporting what the rules refuse ----

// ByoAdmissionObject is the slice of a live Service, Secret or Ingress the rules read. It never
// carries a Secret's data: ReadByoAdmissionObjects lists only the names of the Secrets the rule
// refuses.
type ByoAdmissionObject struct {
	Kind        string
	Name        string
	ServiceType string
	ExternalIPs []string
	SecretType  string
	Annotations map[string]string
}

// ByoAdmissionViolation is one live object one rule refuses.
type ByoAdmissionViolation struct {
	Rule   string
	Kind   string
	Name   string
	Detail string
}

// String is the violation as the Deploy tab names it: kind, name and field.
func (v ByoAdmissionViolation) String() string {
	return fmt.Sprintf("%s %q: %s", v.Kind, v.Name, v.Detail)
}

// ByoAdmissionViolations runs every rule over objs and returns what they refuse, in rule order and
// then object order.
func ByoAdmissionViolations(objs []ByoAdmissionObject) []ByoAdmissionViolation {
	var out []ByoAdmissionViolation
	for _, r := range byoAdmissionRules {
		for _, o := range objs {
			if d := r.Violates(o); d != "" {
				out = append(out, ByoAdmissionViolation{Rule: r.ID, Kind: o.Kind, Name: o.Name, Detail: d})
			}
		}
	}
	return out
}

// ReadByoAdmissionObjects reads the live Services, Ingresses and Secrets in namespace ns, as much of
// each as the rules need. Secrets are listed by NAME, with a field selector on the one type the
// rule refuses (--field-selector type=… -o name): the API server does the selecting, so kubectl
// never receives an ordinary Secret at all, and only names are printed — no secret value reaches
// the runner's memory or its logs.
//
// Live objects, not the chart's rendered manifests: ArgoCD renders the chart, not the runner. What
// is live is what a "warn" namespace runs today, and what the next sync of a changed chart would
// re-submit, so it is the set an "enforce" step would start refusing.
func ReadByoAdmissionObjects(ns string) ([]ByoAdmissionObject, error) {
	objs, errs := ReadByoAdmissionObjectsByKind(ns)
	for _, k := range ByoAdmissionObjectKinds {
		if err := errs[k]; err != nil {
			return nil, err
		}
	}
	return objs, nil
}

// ByoAdmissionObjectKinds are the kinds ReadByoAdmissionObjectsByKind reads, in its order.
var ByoAdmissionObjectKinds = []string{"Service", "Ingress", "Secret"}

// ReadByoAdmissionObjectsByKind is ReadByoAdmissionObjects one kind at a time (#6541): the objects of
// every kind that WAS read, and the error of each kind that was not, keyed by kind. A report built
// from it can then say exactly which kind went unchecked, rather than read a failed kind as clean.
func ReadByoAdmissionObjectsByKind(ns string) ([]ByoAdmissionObject, map[string]error) {
	errs := map[string]error{}
	if !k8sNameRe.MatchString(ns) {
		err := fmt.Errorf("refusing to read namespace %q: not a Kubernetes name", ns)
		for _, k := range ByoAdmissionObjectKinds {
			errs[k] = err
		}
		return nil, errs
	}
	var objs []ByoAdmissionObject
	for _, res := range []struct{ kind, resource string }{{"Service", "services"}, {"Ingress", "ingresses.networking.k8s.io"}} {
		raw, err := utils.ExecuteCommandWithOutput(fmt.Sprintf("kubectl get %s -n %s -o json", res.resource, ns), ".", nil)
		if err != nil {
			errs[res.kind] = fmt.Errorf("read %s in %s: %w", res.resource, ns, err)
			continue
		}
		got, err := parseAdmissionObjects(res.kind, raw)
		if err != nil {
			errs[res.kind] = fmt.Errorf("parse %s in %s: %w", res.resource, ns, err)
			continue
		}
		objs = append(objs, got...)
	}
	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get secrets -n %s --field-selector type=%s -o name", ns, byoServiceAccountTokenSecretType), ".", nil)
	if err != nil {
		errs["Secret"] = fmt.Errorf("read secrets in %s: %w", ns, err)
	} else {
		objs = append(objs, parseSecretNames(raw, byoServiceAccountTokenSecretType)...)
	}
	return objs, errs
}

// parseAdmissionObjects reads a `kubectl get <kind> -o json` List. Empty output is no objects.
func parseAdmissionObjects(kind, raw string) ([]ByoAdmissionObject, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name        string            `json:"name"`
				Annotations map[string]string `json:"annotations"`
			} `json:"metadata"`
			Spec struct {
				Type        string   `json:"type"`
				ExternalIPs []string `json:"externalIPs"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, err
	}
	out := make([]ByoAdmissionObject, 0, len(list.Items))
	for _, it := range list.Items {
		o := ByoAdmissionObject{Kind: kind, Name: it.Metadata.Name, Annotations: it.Metadata.Annotations}
		if kind == "Service" {
			o.ServiceType = it.Spec.Type
			o.ExternalIPs = it.Spec.ExternalIPs
		}
		out = append(out, o)
	}
	return out, nil
}

// parseSecretNames reads the `secret/<name>` lines of `kubectl get secrets --field-selector
// type=<typ> -o name`. Every listed Secret has type typ, because the API server selected it on that
// field; the type is recorded so the rule's own predicate still decides what is reported.
func parseSecretNames(raw, typ string) []ByoAdmissionObject {
	var out []ByoAdmissionObject
	for _, line := range strings.Split(raw, "\n") {
		name, ok := strings.CutPrefix(strings.TrimSpace(line), "secret/")
		if !ok || name == "" {
			continue
		}
		out = append(out, ByoAdmissionObject{Kind: "Secret", Name: name, SecretType: typ})
	}
	return out
}

// PreviewByoPodSecurity asks the API server what PSA enforce=baseline would refuse in namespace ns,
// WITHOUT setting it: a server-side dry-run of the label. Setting an enforce level makes the API
// server evaluate every existing pod in the namespace against it and return a warning per group of
// offending pods ("web-7d9 (and 2 other pods): hostPath volumes"), and a dry run returns the same
// warnings without persisting anything. The evaluator is the cluster's own PSA, so this report and
// the eventual enforcement cannot disagree.
//
// It sees pods that exist now. A pod that does not run at the moment — a CronJob between runs —
// is not in it.
func PreviewByoPodSecurity(ns string) ([]string, error) {
	if !k8sNameRe.MatchString(ns) {
		return nil, fmt.Errorf("refusing to label namespace %q: not a Kubernetes name", ns)
	}
	out, err := utils.ExecuteCommandWithOutput(fmt.Sprintf(
		"kubectl label namespace %s %s=%s %s=%s --overwrite --dry-run=server 2>&1",
		ns, psaEnforceLabel, byoPodSecurityEnforceLevel, psaEnforceVersionLabel, byoPodSecurityVersion), ".", nil)
	if err != nil {
		return nil, fmt.Errorf("preview Pod Security %s in %s: %w", byoPodSecurityEnforceLevel, ns, err)
	}
	return parsePodSecurityWarnings(out), nil
}

// parsePodSecurityWarnings keeps the per-pod lines of PSA's dry-run warnings, dropping the header
// line ("existing pods in namespace … violate the new PodSecurity enforce level …") and kubectl's
// own output.
func parsePodSecurityWarnings(raw string) []string {
	var out []string
	for _, line := range strings.Split(raw, "\n") {
		w, ok := strings.CutPrefix(strings.TrimSpace(line), "Warning: ")
		if !ok || w == "" || strings.HasPrefix(w, "existing pods in namespace") {
			continue
		}
		out = append(out, w)
	}
	return out
}
