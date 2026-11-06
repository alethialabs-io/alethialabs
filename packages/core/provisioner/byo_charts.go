// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// byoBindingState is what one deploy knows about its BYO chart binding ExternalSecrets, gathered by
// applyByoChartBindings and consumed by pruneByoChartBindings.
type byoBindingState struct {
	// Owner is the environment's owner-label value, stamped on every binding ExternalSecret and the
	// only owner the prune will delete for. Empty when the environment has no ID.
	Owner string
	// Declared is every binding ExternalSecret the configuration DECLARES — one per (chart namespace,
	// workload, bound target) with at least one credential facet — whether or not it rendered or
	// applied on this run. It is the prune's keep set.
	Declared []argocd.BindingSecretRef
	// Namespaces are the namespaces of every add-on that is a BYO chart or describes a workload —
	// where a binding lives or recently lived. The prune adds the namespaces carrying the owner label.
	Namespaces []string
	// Failures counts the binding ExternalSecrets that failed to render or apply on this run. Any
	// failure skips the prune for the whole deploy.
	Failures int
	// DBUsersFailed is set when this deploy's BYO users run was due and produced no trustworthy
	// result (runByoDBUsers). It skips the prune like Failures does; it is kept apart because the
	// declared set is still complete, so the BYO secret-sync sweep still runs.
	DBUsersFailed bool
	// Rendered is every binding ExternalSecret rendered on this run, keyed by its namespace and name:
	// exactly the documents the apply applied. The BYO secret-sync sweep holds each live binding to
	// its document (argocd.SweepByoSecretSyncObjects).
	Rendered map[argocd.BindingSecretRef]string
}

// byoBindingOwner is the environment's owner-label value: the same rendering of the environment ID
// that cloud.ClassificationLabels stamps on the BYO namespaces the runner creates, so the namespace
// lookup and the ExternalSecret selector agree by construction.
func byoBindingOwner(vc *types.ProjectConfig) string {
	return cloud.ClassificationLabels(vc)[argocd.ByoBindingOwnerLabel]
}

// keylessDBAuthEnabled is the keyless per-cloud DB auth flag (#722), dark by default. The service
// lane (generateAppManifests) and the BYO binding lane both read it here, so they cannot disagree.
func keylessDBAuthEnabled() bool {
	return os.Getenv("ALETHIA_KEYLESS_DB_AUTH_ENABLED") == "true"
}

// byoDBUsersEnabled is the per-binding database user flag (docs/adr/byo-binding-db-users.md), dark by
// default. With it on, each deploy runs the BYO users Job (runByoDBUsers), every BYO database
// credential facet reads its binding's own user, and only once the Job has provisioned that user,
// and an ExternalSecret an earlier deploy pointed at the administrative credential is withdrawn.
//
// It stays dark until an end-to-end test proves a chart connects as its own user (#6466's last work
// item), and on MySQL until that dialect ships (#6467): there every facet is unsatisfied.
func byoDBUsersEnabled() bool {
	return os.Getenv("ALETHIA_BYO_DB_USERS_ENABLED") == "true"
}

// customSecretNames reads the tofu output `custom_secret_names` — each `custom_secrets` key mapped to
// the secret's name in the environment's store — as a string map. An absent or malformed output is
// an empty map: no per-binding key then resolves, so the facets are unsatisfied, never guessed.
func customSecretNames(outputs map[string]interface{}) map[string]string {
	out := map[string]string{}
	switch m := outputs["custom_secret_names"].(type) {
	case map[string]interface{}:
		for k, v := range m {
			if s, ok := v.(string); ok && s != "" {
				out[k] = s
			}
		}
	case map[string]string:
		for k, v := range m {
			if v != "" {
				out[k] = v
			}
		}
	}
	return out
}

// serviceBindingSecretNames are the binding Secret names the first-class service lane renders into
// appNamespace: one per (service, bound target), the names writeBindingExternalSecrets and the
// workload's secretKeyRef use. Over-approximated on purpose (every bound target, credential facet or
// not), so a BYO binding can only be refused too often, never allowed onto a service's object.
func serviceBindingSecretNames(vc *types.ProjectConfig) map[string]bool {
	out := map[string]bool{}
	for _, s := range vc.Services {
		for _, b := range s.Bindings {
			out[manifests.BindingSecretName(s.Name, b.Target)] = true
		}
	}
	return out
}

// byoBindingPolicy is the resolver policy for one add-on in namespace ns (already defaulted). dbUsers
// is the per-binding-user state, nil when that mode is off.
func byoBindingPolicy(vc *types.ProjectConfig, ns, owner string, keylessOn bool, dbUsers *manifests.ByoDBUsers) manifests.ChartBindingPolicy {
	p := manifests.ChartBindingPolicy{KeylessDBAuth: keylessOn, DBUsers: dbUsers}
	if owner == "" {
		p.CredentialRefusal = "the environment has no ID, so its binding ExternalSecret could not carry an owner label and could never be pruned — not applied"
	}
	if ns == appNamespace {
		p.TakenSecretNames = serviceBindingSecretNames(vc)
	}
	return p
}

// declaredByoBindings returns the binding ExternalSecrets vc declares and the namespaces the prune
// should look in, read from the configuration alone — no tofu output, render or apply result enters it, so a
// binding that failed on this run is still declared and still kept. A binding to a keyless database
// (keylessOn) declares no ExternalSecret: it gets no password secret, so any earlier one is not kept.
//
// A BYO chart in refused (#6439) declares NO binding, so a refused chart's binding secrets are
// withdrawn with it: its namespace is still LOOKED IN, and the owner-scoped prune finds and removes
// what an earlier deploy bound there. The chart's Application and the rest of what it deployed are
// left untouched — which means its RUNNING workloads lose that credential: a Secret mounted as a
// volume disappears at once, and an env value sourced from it on the next pod restart. That is
// deliberate: the platform does not keep a live credential in a namespace it has refused, for a chart
// whose Application can no longer sync anyway.
//
// With dbUsersOn, a database binding is declared with the db-user source: the prune keeps its live
// object only when that object reads the binding's own user, so one an earlier deploy pointed at the
// administrative credential is withdrawn even though the binding is still declared. The source is a
// function of the configuration and the flag, so this is still read from the configuration alone.
func declaredByoBindings(vc *types.ProjectConfig, keylessOn, dbUsersOn bool, refused []byoRefusal) ([]argocd.BindingSecretRef, []string) {
	skip := byoRefusedIDs(refused)
	var refs []argocd.BindingSecretRef
	var namespaces []string
	seenNS := map[string]bool{}
	for _, a := range vc.AddOns {
		if len(a.Workloads) == 0 && !a.IsByo() {
			continue
		}
		ns := a.Namespace
		if ns == "" {
			ns = "default" // the renderer's default, so the ref names the object it creates
		}
		// The namespace is looked in even when no binding is declared there any more: that is
		// exactly the case of a binding just removed from a chart that is still installed.
		if !seenNS[ns] {
			seenNS[ns] = true
			namespaces = append(namespaces, ns)
		}
		if a.IsByo() && skip[a.ID] {
			continue
		}
		for _, w := range a.Workloads {
			for _, b := range w.Bindings {
				if len(manifests.CredentialFacetNames(b)) == 0 {
					continue
				}
				if keylessOn && manifests.KeylessDBTarget(b.Target, vc.Databases) {
					continue
				}
				ref := argocd.BindingSecretRef{Namespace: ns, Name: manifests.BindingSecretName(w.Name, b.Target)}
				if dbUsersOn && b.Target.Kind == types.ServiceBindingKindDatabase {
					ref.Source = argocd.ByoBindingSourceDBUser
				}
				refs = append(refs, ref)
			}
		}
	}
	return refs, namespaces
}

// applyByoChartBindings resolves each BYO chart workload's W3 bindings (W5 Lane 2b) against the
// provision's tofu `outputs` and writes them into the chart's Values BEFORE its Application renders:
// a non-secret facet (endpoint/port) becomes a literal at its value-path; a credential facet becomes
// a keyless `existingSecret` reference backed by a runner-seeded ExternalSecret applied pre-sync via
// direct kubectl apply. The runner applies it, not the chart's Application, because the hardened BYO
// AppProject admits only a closed list of namespaced workload kinds and denies every
// external-secrets.io kind (argocd byoWorkloadKinds, byoSecretSyncDenied) — the same pattern as
// EnsureAddOnSecrets. Never inlines a plaintext credential; a facet that can't be resolved keylessly
// is logged and skipped, never referenced. Non-fatal — a bad binding must not fail an
// otherwise-healthy deploy. Mutates each addon's Values in place.
//
// Each ExternalSecret carries the binding marker and the environment's owner label. The returned
// state carries the DECLARED bindings (the prune's keep set), how many failed on this run, and the
// documents rendered for them. Nothing is provisioned: with the per-binding flag on, every database
// credential facet is unsatisfied (applyByoChartBindingsExcept takes the BYO users run's outcome).
func applyByoChartBindings(vc *types.ProjectConfig, outputs map[string]interface{}, provider string, stdout, stderr io.Writer) byoBindingState {
	return applyByoChartBindingsExcept(vc, outputs, provider, nil, byoDBUsersOutcome{}, stdout, stderr)
}

// applyByoChartBindingsExcept is applyByoChartBindings that writes NOTHING for the BYO charts in
// refused — the ones configureByoCharts refused, whose namespace the runner must not write into —
// and declares none of their bindings, so the prune that follows withdraws any an earlier deploy
// applied (see declaredByoBindings). users is this deploy's BYO users run (runByoDBUsers): the users
// it provisioned, the reason the others are not, and whether it failed — a failed run is a binding
// failure, so the prune is skipped.
func applyByoChartBindingsExcept(vc *types.ProjectConfig, outputs map[string]interface{}, provider string, refused []byoRefusal, users byoDBUsersOutcome, stdout, stderr io.Writer) byoBindingState {
	keylessOn := keylessDBAuthEnabled()
	dbUsersOn := byoDBUsersEnabled()
	st := byoBindingState{Owner: byoBindingOwner(vc), Rendered: map[argocd.BindingSecretRef]string{}}
	st.Declared, st.Namespaces = declaredByoBindings(vc, keylessOn, dbUsersOn, refused)
	st.DBUsersFailed = dbUsersOn && users.Failed

	docs, failures := renderByoChartBindings(vc, outputs, provider, refused, users.Provisioned, users.Refusal, true, stdout, stderr)
	st.Failures = failures
	for _, d := range docs {
		st.Rendered[d.Ref] = d.YAML
		if err := argocd.ApplyManifest(d.YAML, stdout, stderr); err != nil {
			st.Failures++
			fmt.Fprintf(stderr, "Warning: BYO binding ExternalSecret apply failed (%s/%s): %v\n", d.AddOnID, d.Workload, err)
		}
	}
	return st
}

// byoRenderedBinding is one binding ExternalSecret rendered for this deploy.
type byoRenderedBinding struct {
	AddOnID, Workload string
	Ref               argocd.BindingSecretRef
	YAML              string
}

// byoBindingRenderFailures counts the binding ExternalSecrets of this configuration that fail to
// render, as if every user in provisioned existed. Nothing is written or applied. The BYO users run
// reads it BEFORE its Job, to know whether the declared set is complete (a render failure means it
// is not, so nothing may be revoked).
func byoBindingRenderFailures(vc *types.ProjectConfig, outputs map[string]interface{}, provider string, refused []byoRefusal, provisioned map[string]bool) int {
	_, failures := renderByoChartBindings(vc, outputs, provider, refused, provisioned, "", false, io.Discard, io.Discard)
	return failures
}

// renderByoChartBindings is the one walk over the BYO chart bindings: it resolves every workload's
// bindings, writes the value-path patches into each add-on's Values when write is set, and returns
// every binding ExternalSecret it rendered, with its namespace and name, and how many failed to
// render. The apply above applies exactly these documents, and the BYO secret-sync sweep holds each
// live binding to them (byoBindingState.Rendered), so the two can never disagree.
//
// provisioned and dbRefusal are the BYO users run's outcome (ignored with the per-binding flag off).
// A database credential facet the resolver refused only because its user is not provisioned is
// reported with the cause the user can act on — a target other than the primary database
// (byoNonPrimaryReason), or dbRefusal when that is set — and never bound. An unsatisfied facet means
// the chart's Values render without its existingSecret patch on this deploy: when the cause is a
// transient BYO users Job failure, that is an availability cost to a chart already running, not only
// a binding not made (see runByoDBUsers' fail).
func renderByoChartBindings(vc *types.ProjectConfig, outputs map[string]interface{}, provider string, refused []byoRefusal, provisioned map[string]bool, dbRefusal string, write bool, stdout, stderr io.Writer) ([]byoRenderedBinding, int) {
	keylessOn := keylessDBAuthEnabled()
	skip := byoRefusedIDs(refused)
	owner := byoBindingOwner(vc)
	var dbUsers *manifests.ByoDBUsers
	if byoDBUsersEnabled() {
		dbUsers = &manifests.ByoDBUsers{Environment: owner, SecretNames: customSecretNames(outputs), Provisioned: provisioned}
	}
	notProvisioned := byoDBUserNotProvisionedReason()
	primary, hasPrimary := byoPrimaryDatabase(vc)
	strOutputs := stringOutputs(outputs)

	var docs []byoRenderedBinding
	failures := 0
	keep := func(a types.AddOnInstall, w types.ChartWorkloadBinding, target types.ServiceBindingTarget, doc string) {
		ns := a.Namespace
		if ns == "" {
			ns = "default" // the renderer's default
		}
		docs = append(docs, byoRenderedBinding{AddOnID: a.ID, Workload: w.Name,
			Ref: argocd.BindingSecretRef{Namespace: ns, Name: manifests.BindingSecretName(w.Name, target)}, YAML: doc})
	}
	for i := range vc.AddOns {
		a := &vc.AddOns[i]
		if len(a.Workloads) == 0 || (a.IsByo() && skip[a.ID]) {
			continue
		}
		if write && a.Values == nil {
			a.Values = map[string]interface{}{}
		}
		ns := a.Namespace
		if ns == "" {
			ns = "default" // the renderer's default
		}
		policy := byoBindingPolicy(vc, ns, owner, keylessOn, dbUsers)
		for _, w := range a.Workloads {
			res := manifests.ResolveChartWorkloadBindings(
				w.Name, w.Bindings, w.ValuePaths, strOutputs, provider, a.Namespace, vc.Databases, policy,
			)
			if write {
				for path, val := range res.Patches {
					manifests.SetByPath(a.Values, path, val)
				}
			}
			// The database target of each knob, for the primary-database rule below.
			knobTarget := map[string]string{}
			for _, b := range w.Bindings {
				if b.Target.Kind != types.ServiceBindingKindDatabase {
					continue
				}
				for _, inj := range b.Inject {
					knobTarget[manifests.ChartBindingKnob(string(b.Target.Kind), b.Target.Name, string(inj.From))] = b.Target.Name
				}
			}
			for _, knob := range res.Unsatisfied {
				reason := res.UnsatisfiedReasons[knob]
				if reason == notProvisioned {
					// The cause the user can act on, in place of the resolver's generic one.
					if target, isDB := knobTarget[knob]; isDB && hasPrimary && target != primary {
						reason = byoNonPrimaryReason(primary)
					} else if dbRefusal != "" {
						reason = dbRefusal
					}
				}
				if reason != "" {
					fmt.Fprintf(stdout, "BYO chart %s workload %s: binding %s unsatisfied (%s) — not written.\n", a.ID, w.Name, knob, reason)
					continue
				}
				fmt.Fprintf(stdout, "BYO chart %s workload %s: binding %s unsatisfied (no value-path or no keyless secret) — not written.\n", a.ID, w.Name, knob)
			}
			for _, es := range res.ExternalSecrets {
				// Mark it so PruneChartBindingSecrets can find + sweep it when the binding is removed
				// (it is applied outside ArgoCD, so nothing else prunes it), and name its owner so a
				// prune run by any OTHER environment on a shared host never selects it.
				// The owner is never empty here: an ownerless environment's credential facets are
				// refused by the policy, so no ExternalSecret is ever rendered without one.
				es.Labels = map[string]string{argocd.ByoBindingSecretLabel: "true", argocd.ByoBindingOwnerLabel: owner}
				yaml, skipped, err := manifests.RenderExternalSecret(es)
				if err != nil {
					failures++
					fmt.Fprintf(stderr, "Warning: BYO binding ExternalSecret render failed (%s/%s): %v\n", a.ID, w.Name, err)
					continue
				}
				for _, reason := range skipped {
					fmt.Fprintf(stdout, "BYO binding facet skipped (%s/%s): %s\n", a.ID, w.Name, reason)
				}
				if yaml == "" {
					continue
				}
				keep(*a, w, es.Target, yaml)
			}
			for _, es := range res.DBUserSecrets {
				// The same marker and owner as above, plus the source label the prune requires of a
				// declared database binding in this mode.
				es.Labels = map[string]string{
					argocd.ByoBindingSecretLabel: "true",
					argocd.ByoBindingOwnerLabel:  owner,
					argocd.ByoBindingSourceLabel: argocd.ByoBindingSourceDBUser,
				}
				yaml, err := manifests.RenderByoDBUserExternalSecret(es)
				if err != nil {
					failures++
					fmt.Fprintf(stderr, "Warning: BYO binding ExternalSecret render failed (%s/%s): %v\n", a.ID, w.Name, err)
					continue
				}
				keep(*a, w, es.Target, yaml)
			}
		}
	}
	return docs, failures
}

// byoDBUserNotProvisionedReason is the resolver's own reason for a database credential facet whose
// user is not provisioned, read from the resolver itself (one synthetic binding, nothing
// provisioned), so the override above matches that refusal exactly and cannot drift from its text.
func byoDBUserNotProvisionedReason() string {
	t := types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "probe"}
	knob := manifests.ChartBindingKnob(string(t.Kind), t.Name, "password")
	res := manifests.ResolveChartWorkloadBindings("probe",
		[]types.ServiceBinding{{Target: t, Inject: []types.ServiceBindingInjection{{Env: "P", From: "password"}}}},
		map[string]string{knob: "probe"}, nil, string(types.CloudProviderAws), "probe", nil,
		manifests.ChartBindingPolicy{DBUsers: &manifests.ByoDBUsers{Environment: "probe"}})
	return res.UnsatisfiedReasons[knob]
}

// pruneByoChartBindings sweeps the environment's binding ExternalSecrets that its configuration no
// longer declares. It is skipped outright when any binding failed to render or apply on this run, or
// the BYO users Job failed:
// that deploy's view of the bindings is incomplete, and a live binding must never be removed
// because one run could not re-apply it. It is also skipped when the environment has no owner
// label to scope by.
func pruneByoChartBindings(st byoBindingState, stdout, stderr io.Writer) {
	if st.Failures > 0 {
		fmt.Fprintf(stderr, "Warning: skipping the BYO binding ExternalSecret prune: %d binding(s) failed to render or apply on this deploy\n", st.Failures)
		return
	}
	if st.DBUsersFailed {
		fmt.Fprintln(stderr, "Warning: skipping the BYO binding ExternalSecret prune: the BYO users Job did not provision its users on this deploy")
		return
	}
	argocd.PruneChartBindingSecrets(st.Owner, st.Namespaces, st.Declared, stdout, stderr)
}

// byoRefusal is one BYO chart the runner declined to configure on this deploy, and why.
type byoRefusal struct {
	// ID is the add-on id; the chart's Application name is argocd.AddOnAppName(ID).
	ID string
	// Namespace is the destination the chart asked for ("" already defaulted to "default").
	Namespace string
	// Reason is the validator's refusal, naming the namespace.
	Reason string
	// Shared is set when the refused namespace is still another chart's destination
	// (byoNamespaceCollisions): the AppProject keeps listing it for that chart.
	Shared bool
	// ProjectUpdated is whether this deploy re-applied the chart's AppProject without the refused
	// destination. False when that render or apply failed, in which case a destination an earlier
	// deploy granted is still there.
	ProjectUpdated bool
}

// warning is the deploy warning the console's Deploy tab shows for this refusal: what was not
// deployed, why, what is left on the cluster, and what the user changes. It is worded to be true
// whether or not an earlier deploy ever applied the chart, and whether or not the AppProject update
// succeeded. It carries no secret — an id, a namespace and the validator's text, which echoes only
// the namespace.
func (r byoRefusal) warning() string {
	left := "Anything an earlier deploy applied for it stays in place but can no longer sync, because its project no longer permits that namespace."
	if r.Shared {
		// The namespace stays a destination for the chart that keeps it, so nothing stops an
		// Application an earlier deploy applied from syncing; say only what is true.
		left = "Anything an earlier deploy applied for it stays in place, and may keep syncing into that namespace, which it then still shares with the chart that keeps it; this deploy did not update it."
	} else if !r.ProjectUpdated {
		left = "The runner could not update its project (see the deploy log), so an Application an earlier deploy applied for it may still sync into that namespace."
	}
	return fmt.Sprintf("BYO chart %q was not deployed: %s. This deploy applied nothing for it. %s "+
		"Its binding secrets are withdrawn whenever the binding prune runs, so its running workloads lose those "+
		"credentials (a mounted secret at once, an environment value on the next restart); this is deliberate. "+
		"Attach the chart again with a namespace of your own.", r.ID, r.Reason, left)
}

// byoMove is one BYO chart this deploy moved out of the namespace it was attached with — "default",
// or none at all, which deployed into "default" — into its own byo-<chart id> namespace (#6446).
type byoMove struct {
	// ID is the add-on id; the chart's Application name is argocd.AddOnAppName(ID).
	ID string
	// From is the namespace the chart deployed into before: always "default".
	From string
	// To is the chart's new namespace, argocd.ByoChartNamespace(ID).
	To string
}

// warning is the deploy warning the console's Deploy tab shows for this move: where the chart now
// runs, what is left in "default" and why, and what the user does about it. It is worded to be true
// whether or not an earlier deploy ever applied the chart into "default". It carries no secret — an
// id and two namespaces.
func (m byoMove) warning() string {
	return fmt.Sprintf("BYO chart %q now deploys into its own namespace %q instead of %q, which is reserved for the platform. "+
		"Its project now permits only %q, so ArgoCD no longer manages anything an earlier deploy created for it in %q: "+
		"those resources are not deleted, not updated, and not removed if you detach the chart. "+
		"They keep running in the platform's namespace until you delete them. "+
		"Once the chart is running in %q, delete them yourself; ArgoCD marked each one with an %s annotation beginning %q. "+
		"Its binding secrets in %q are withdrawn, and applied again in %q. "+
		"To keep this namespace in the chart's settings, attach it again with this namespace or one of your own.",
		m.ID, m.To, m.From, m.To, m.From, m.To, "argocd.argoproj.io/tracking-id", argocd.AddOnAppName(m.ID)+":", m.From, m.To)
}

// withByoMoveSources adds each moved chart's old namespace to the binding prune's namespaces, once.
func withByoMoveSources(namespaces []string, moved []byoMove) []string {
	seen := make(map[string]bool, len(namespaces))
	for _, ns := range namespaces {
		seen[ns] = true
	}
	for _, m := range moved {
		if !seen[m.From] {
			seen[m.From] = true
			namespaces = append(namespaces, m.From)
		}
	}
	return namespaces
}

// byoNamespaceCollisions finds the BYO charts that must not deploy because they would share a
// namespace another chart owns, and says why for each.
//
// A chosen "byo-" namespace is allowed at deploy: a NEW attachment cannot choose one other than its
// own (the console's attach schema refuses it), but a chart attached before that rule keeps working.
// What is refused is the real collision, and ownership decides it, not ids:
//
//   - A namespace that is some chart's DERIVED default (argocd.ByoChartNamespace(id)) belongs to that
//     chart. Every OTHER chart in it chose it explicitly, and is refused; the owner keeps it, whatever
//     the ids. Two charts cannot both derive one name (the derivation is distinct per id), so this
//     never has to pick between owners.
//   - The case ownership cannot decide: two or more charts EXPLICITLY sharing a "byo-" namespace that
//     is nobody's derived default here (its owner deploys elsewhere, or no chart has that id). There
//     is no owner, so the charts are ordered by id — the one stable order the snapshot carries; its
//     add-on order is not guaranteed — and all but the first are refused. This is the ONLY place id
//     order decides anything.
//
// Two charts sharing a namespace outside the "byo-" prefix (both chose "payments") is not this rule's
// business: that was always allowed. Nothing is deleted: the caller treats each like any other refusal.
func byoNamespaceCollisions(addons []types.AddOnInstall) map[string]string {
	byNS := map[string][]string{}
	derivedBy := map[string]string{}
	for _, a := range addons {
		if !a.IsByo() {
			continue
		}
		derivedBy[argocd.ByoChartNamespace(a.ID)] = a.ID
		byNS[a.Namespace] = append(byNS[a.Namespace], a.ID)
	}
	out := map[string]string{}
	for ns, ids := range byNS {
		if len(ids) < 2 || !strings.HasPrefix(ns, "byo-") {
			continue
		}
		owner, derived := derivedBy[ns]
		ownerHere := false
		for _, id := range ids {
			if derived && id == owner {
				ownerHere = true
			}
		}
		if ownerHere {
			for _, id := range ids {
				if id != owner {
					out[id] = fmt.Sprintf("namespace %q is BYO chart %q's own default namespace, and two charts cannot share one; chart %q keeps it. "+
						"Attach chart %q again with another namespace", ns, owner, owner, id)
				}
			}
			continue
		}
		sort.Strings(ids)
		kept := ids[0]
		for _, id := range ids[1:] {
			out[id] = fmt.Sprintf("namespace %q is also the namespace of BYO chart %q, and two charts cannot share one; chart %q keeps it (the first by id, since neither chart owns that name). "+
				"Attach one of the two again with another namespace", ns, kept, kept)
		}
	}
	return out
}

// byoRefusedIDs is the set of refused add-on ids, for the filters below.
func byoRefusedIDs(refused []byoRefusal) map[string]bool {
	out := make(map[string]bool, len(refused))
	for _, r := range refused {
		out[r.ID] = true
	}
	return out
}

// withoutByoRefusals returns the add-ons a deploy may RENDER, APPLY or seed into: every add-on
// except the refused BYO charts. It is deliberately NOT what the prune is given — see deploy.go: a
// refused chart stays in the prune's keep list, so its live Application is left alone rather than
// deleted (with the resources-finalizer cascade) as a "disabled" add-on.
func withoutByoRefusals(addons []types.AddOnInstall, refused []byoRefusal) []types.AddOnInstall {
	if len(refused) == 0 {
		return addons
	}
	skip := byoRefusedIDs(refused)
	out := make([]types.AddOnInstall, 0, len(addons))
	for _, a := range addons {
		if a.IsByo() && skip[a.ID] {
			continue
		}
		out = append(out, a)
	}
	return out
}

// prepareByoCharts is configureByoCharts for callers that only need to know whether any BYO chart
// was configured.
func prepareByoCharts(vc *types.ProjectConfig, token string, repoTokens map[string]string, commonLabels map[string]string, stdout, stderr io.Writer) bool {
	return configureByoCharts(vc, token, repoTokens, commonLabels, stdout, stderr).Configured
}

// configureByoCharts sets up the trust boundary for bring-your-own charts — git-source AND OCI
// (types.AddOnInstall.IsByo, #6445) — BEFORE the add-on renderer applies their ArgoCD Applications:
//  1. pins every BYO chart to a hardened, per-project "byo-<slug>" AppProject (mutating vc.AddOns
//     in place so RenderManagedAddOns places them there — the renderer refuses a BYO chart it was
//     not pinned for);
//  2. MOVES every chart whose namespace is empty or "default" — attached before #6446 made each
//     chart's default its own "byo-<chart id>" and reserved "default" — into that namespace, and
//     returns the moves (each becomes a deploy warning, and the binding prune looks in the old
//     namespace — see byoMove);
//  3. REFUSES, per chart, every chart whose namespace argocd.ValidateByoNamespace refuses — malformed,
//     or reserved for the platform (#6439) — and returns those refusals;
//  4. renders + applies that AppProject, locked to exactly the ACCEPTED charts' repos + namespaces
//     (default-deny cluster-scoped resources);
//  5. registers a per-repo ArgoCD repository credential for each accepted GIT chart's repo (isolated
//     Secret names so no BYO Application can read the apps repo's — or another tenant's — token). An
//     OCI chart's registry credential is the helm_registry connector's, seeded by the Helm repo
//     credential path; a git token is never registered against a registry URL.
//
// # Why per chart, and why the AppProject is re-applied even when every chart is refused (#6439)
//
// A refusal used to abandon the whole stage, which had two defects. One legacy chart froze the
// AppProject for every other chart in the project. And the AppProject an EARLIER deploy applied —
// still listing the now-refused destination — was left exactly as it was, while the refused chart's
// Application was rendered and applied regardless, so it went on syncing into that namespace. Now
// the AppProject is always re-applied from the accepted charts alone (kubectl apply of a custom
// resource replaces the `destinations` list wholesale), which is what makes ArgoCD refuse any further
// sync into a refused namespace; and the caller drops each refused chart from the render. Nothing
// live is deleted: the refused chart stays in the prune's keep list.
//
// # What a move or a change of project does on the cluster (#6445, #6446)
//
// The Application keeps its name (argocd.AddOnAppName(id)), so the re-apply changes it IN PLACE:
// the prune's keep list still names it and nothing deletes it. An OCI chart deployed before #6445
// sat in the catalogue's "infra" project with prune and self-heal on; its new spec carries the
// hardened project and prune OFF in the same object, so no sync ever runs with the new destination
// and the old prune setting. Resource tracking does not name the project, so the chart's objects
// in its destination namespace stay tracked. What the hardened project no longer permits — the old
// "default" namespace after a move, or any kind outside its closed list of namespaced workload kinds
// (every cluster-scoped kind, ServiceAccount, Role and RoleBinding among them) — is
// dropped from the Application's view by ArgoCD itself (controller/state.go filters live objects by
// IsLiveResourcePermitted, and finalizeApplicationDeletion deletes only permitted ones), so it is
// neither pruned, updated, nor cascaded on a later detach. It is LEFT IN PLACE, and the move's
// warning says so: the runner never deletes anything in "default", which holds the platform's own
// workloads.
//
// Marketplace (Helm-registry) add-ons are untouched: they keep Project=="" → the "infra" project.
// Best-effort like the rest of the add-on path — a failure here surfaces as an un-synced
// Application (fail-closed: no credential / no project ⇒ the chart simply doesn't deploy), never a
// failed cluster. Returns whether any BYO chart was configured, the refusals and the moves.
// commonLabels are the classification/sweep labels stamped onto the AppProject (BYOC B1.4); the BYO
// chart Applications themselves are labelled by RenderManagedAddOns.
// repoTokens maps a chart repo URL → its git token (for BYO charts on a different provider than the
// apps-destination repo); token is the fallback used when a repo has no dedicated entry.
func configureByoCharts(vc *types.ProjectConfig, token string, repoTokens map[string]string, commonLabels map[string]string, stdout, stderr io.Writer) byoConfigured {
	projName := argocd.ByoProjectName(vc.ProjectName)

	var repos, gitRepos, namespaces []string
	var refused []byoRefusal
	var moved []byoMove
	var leftProject []byoProjectChange
	hasByo := false
	// Which charts already hold each namespace as stored, so a move can see whether its target is
	// taken (see the move below).
	storedIn := map[string][]string{}
	for _, a := range vc.AddOns {
		if a.IsByo() {
			storedIn[a.Namespace] = append(storedIn[a.Namespace], a.ID)
		}
	}
	moveRefused := map[string]string{}
	for i := range vc.AddOns {
		a := &vc.AddOns[i]
		if !a.IsByo() {
			continue
		}
		hasByo = true
		// Pin the Application to the hardened project (the console leaves Project empty). A refused
		// chart is pinned too: if anything ever did render it, it would land in the hardened project,
		// never the wide-open default one.
		a.Project = projName
		if a.Namespace == "" || a.Namespace == argocd.ByoLegacyDefaultNamespace {
			to := argocd.ByoChartNamespace(a.ID)
			// The target is already another chart's — one that chose this name before the byo- rule.
			// The MOVE is refused, not that chart: moving in would make the two share a namespace, and
			// refusing the occupant would withdraw its bindings from under a running workload. The
			// legacy chart stays where it is stored and is refused like any chart in a reserved
			// namespace; the occupant is untouched.
			if occupants := storedIn[to]; len(occupants) > 0 {
				moveRefused[a.ID] = fmt.Sprintf("it is stored in namespace %q, which is reserved for the platform, and its own namespace %q is already used by BYO chart %q, so it was not moved there",
					argocd.ByoLegacyDefaultNamespace, to, occupants[0])
				continue
			}
			moved = append(moved, byoMove{ID: a.ID, From: argocd.ByoLegacyDefaultNamespace, To: to})
			a.Namespace = to
			fmt.Fprintf(stdout, "BYO chart %q: moving from namespace %q to %q\n", a.ID, argocd.ByoLegacyDefaultNamespace, to)
		}
	}
	collisions := byoNamespaceCollisions(vc.AddOns)
	for i := range vc.AddOns {
		a := &vc.AddOns[i]
		if !a.IsByo() {
			continue
		}
		ns := a.Namespace
		if reason, refusedMove := moveRefused[a.ID]; refusedMove {
			fmt.Fprintf(stderr, "Error: refusing BYO chart %q: %s\n", a.ID, reason)
			refused = append(refused, byoRefusal{ID: a.ID, Namespace: argocd.ByoLegacyDefaultNamespace, Reason: reason})
			continue
		}
		if err := argocd.ValidateByoNamespace(ns); err != nil {
			fmt.Fprintf(stderr, "Error: refusing BYO chart %q: %v\n", a.ID, err)
			refused = append(refused, byoRefusal{ID: a.ID, Namespace: ns, Reason: err.Error()})
			continue
		}
		if reason, collides := collisions[a.ID]; collides {
			fmt.Fprintf(stderr, "Error: refusing BYO chart %q: %s\n", a.ID, reason)
			refused = append(refused, byoRefusal{ID: a.ID, Namespace: ns, Reason: reason, Shared: true})
			continue
		}
		repos = append(repos, a.ChartRepo)
		if a.IsGitSource() {
			gitRepos = append(gitRepos, a.ChartRepo)
		} else if from := liveByoProject(a.ID, stderr); from != "" && from != projName {
			// An OCI chart an earlier deploy applied under another project (the catalogue's, before
			// #6445): this deploy moves it, and the user is told what that changes. A git chart has
			// always been pinned, so it is not read.
			leftProject = append(leftProject, byoProjectChange{ID: a.ID, From: from, To: projName})
		}
		namespaces = append(namespaces, ns)
	}
	if !hasByo {
		return byoConfigured{}
	}

	fmt.Fprintf(stdout, "Configuring %d bring-your-own chart(s) under hardened project %q (%d refused)\n", len(repos), projName, len(refused))

	// The destination namespaces, created by the RUNNER because the chart cannot create them.
	//
	// The Application carries `CreateNamespace=true`, but the hardened AppProject below has an empty
	// clusterResourceWhitelist and a Namespace is cluster-scoped — so ArgoCD is asked to create a
	// namespace it is forbidden to create, and the sync dies with `namespaces "<ns>" not found`,
	// health=Missing, forever. Creating them here (trusted runner, admin kubeconfig) is what makes
	// the hardening and the sync option coexist; it does not widen what the chart may do.
	//
	// Every namespace here has already passed the validator above, so a render error is not expected;
	// it is still not fail-soft (#2540): falling through would apply an AppProject built from a value
	// the renderer declined.
	//
	// Each namespace also carries the runner's secret-store stamp (argocd.SecretStoreAccessLabel): the
	// platform's ClusterSecretStores admit a namespace marked as a BYO chart's only while it carries
	// it. For the namespaces stamped here that changes nothing; it is a narrow label-level check, and
	// the line a chart cannot cross is the hardened project's external-secrets deny (see
	// argocd.secretStoreConditions).
	nsLabels := byoNamespaceLabels(commonLabels)
	if ns, err := argocd.RenderByoNamespaces(namespaces, nsLabels); err != nil {
		fmt.Fprintf(stderr, "Error: refusing to configure BYO charts: %v\n", err)
		return byoConfigured{Refused: refused, Moved: moved, ProjectChanges: leftProject}
	} else if ns != "" {
		if err := argocd.ApplyManifest(ns, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: could not create BYO namespace(s) %s — a chart targeting one will fail its sync with `namespaces not found`: %v\n",
				strings.Join(namespaces, ", "), err)
		}
	}

	// Hardened AppProject locked to the ACCEPTED repos + namespaces — applied even when that is none,
	// so a destination an earlier deploy granted is withdrawn (see the doc comment).
	projectUpdated := false
	if proj, err := argocd.RenderByoAppProject(projName, repos, namespaces, commonLabels); err != nil {
		fmt.Fprintf(stderr, "Warning: could not render BYO AppProject %s: %v\n", projName, err)
	} else if err := argocd.ApplyManifest(proj, stdout, stderr); err != nil {
		fmt.Fprintf(stderr, "Warning: could not apply BYO AppProject %s (charts will not sync until it exists): %v\n", projName, err)
	} else {
		projectUpdated = true
	}
	for i := range refused {
		refused[i].ProjectUpdated = projectUpdated
	}

	// Once every chart of this environment has left "default", the labels an earlier runner stamped on
	// it as a BYO namespace (RenderByoNamespaces: managed-by plus every one of commonLabels) are removed
	// — each only where its value is this environment's — so nothing keyed on them selects the
	// platform's namespace (ReleaseLegacyByoNamespaceLabels). Only when the AppProject no longer lists
	// it, and NOT while a chart whose move was refused is still stored there: that chart still belongs
	// to this environment and still has its objects in "default", so the labels stay true.
	if len(moved) > 0 && projectUpdated && len(moveRefused) == 0 {
		if owner := byoBindingOwner(vc); owner != "" {
			if _, err := argocd.ReleaseLegacyByoNamespaceLabels(argocd.ByoLegacyDefaultNamespace, owner, nsLabels, stdout); err != nil {
				fmt.Fprintf(stderr, "Warning: could not remove the BYO chart labels from namespace %q: %v\n", argocd.ByoLegacyDefaultNamespace, err)
			}
		}
	}

	// Every git token in play (shared + per-repo) — used to redact any of them from the credential
	// error text before it reaches the job log; the runner's metadata scrub is key-based and a
	// kubectl/git failure can echo a tokened URL (#948).
	allTokens := gitTokenValues(token, repoTokens)

	// Per-repo credentials. Each repo prefers its own token (repoTokens[repo], set when the chart
	// lives on a different provider than the apps-destination repo) and falls back to the shared
	// token. Without any token a private BYO Application can't clone — warn (public charts still
	// work) but don't fail the deploy.
	seen := map[string]bool{}
	for _, repo := range gitRepos {
		if repo == "" || seen[repo] {
			continue
		}
		seen[repo] = true
		repoToken := repoTokens[repo]
		if repoToken == "" {
			repoToken = token
		}
		if repoToken == "" {
			fmt.Fprintf(stderr, "Warning: no git access token for BYO repo %s — a private chart there will fail to sync (reconnect the git provider)\n", repo)
			continue
		}
		if err := argocd.ConfigureRepoCredentialsNamed(repo, repoToken, argocd.ByoRepoSecretName(repo), stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: could not configure credentials for BYO repo %s: %s\n", repo, argocd.RedactTokens(err.Error(), allTokens...))
		}
	}
	return byoConfigured{Configured: len(repos) > 0, Refused: refused, Moved: moved, ProjectChanges: leftProject}
}

// byoNamespaceLabels are the labels the runner stamps on a BYO chart's namespace beyond the
// managed-by marker RenderByoNamespaces adds: the classification labels, and the secret-store stamp.
// The same set is what ReleaseLegacyByoNamespaceLabels removes from "default", so nothing stamped
// there outlives the last chart that left it.
func byoNamespaceLabels(commonLabels map[string]string) map[string]string {
	out := make(map[string]string, len(commonLabels)+1)
	for k, v := range commonLabels {
		out[k] = v
	}
	out[argocd.SecretStoreAccessLabel] = argocd.SecretStoreAccessValue
	return out
}

// byoConfigured is what configureByoCharts did.
type byoConfigured struct {
	// Configured is whether any BYO chart was configured.
	Configured bool
	// Refused are the charts refused for their namespace.
	Refused []byoRefusal
	// Moved are the charts moved out of "default" (#6446).
	Moved []byoMove
	// ProjectChanges are the OCI charts whose live Application was under another project (#6445).
	ProjectChanges []byoProjectChange
}

// liveByoProject is the project of the chart's live Application, or "" when it has none or the read
// failed (logged): no warning is better than one that may be false.
func liveByoProject(id string, stderr io.Writer) string {
	p, err := argocd.LiveApplicationProject(argocd.AddOnAppName(id))
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not read the live project of BYO chart %q: %v\n", id, err)
		return ""
	}
	return p
}

// byoProjectChange is one OCI BYO chart whose Application an earlier deploy applied under another
// project — the catalogue's — and which this deploy moves to its hardened byo-<slug> project.
type byoProjectChange struct {
	ID, From, To string
}

// warning is the Deploy-tab warning for the change: what the chart now runs under, which of its
// kinds will fail to sync (anything outside the hardened project's closed list of workload kinds,
// argocd byoWorkloadKinds), and that what it created earlier is left in place.
func (c byoProjectChange) warning() string {
	return fmt.Sprintf("BYO chart %q now deploys under its hardened project %q instead of %q, like every chart you bring. "+
		"That project permits only a closed list of namespaced workload kinds in the chart's own namespace, so no cluster-scoped resource "+
		"and no ServiceAccount, Role or RoleBinding: a chart that declares a kind outside the list fails its sync, naming the resource. "+
		"Anything it created earlier that the project does not permit is left in place and no longer managed; delete it yourself if you no longer need it.",
		c.ID, c.To, c.From)
}
