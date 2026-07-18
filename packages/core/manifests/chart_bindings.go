// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

// W5 Path A Lane 2b — resolve a BYO chart workload's W3 bindings into its Helm values at deploy.
//
// A described chart workload (project_chart_workloads) carries `bindings` (W3 ServiceBinding[]) and
// `value_paths` (logical knob → chart-values dot-path). Lane 2 (console) composed the STATIC overlay
// (replicas/env); the binding half is runtime — it needs the provision's tofu outputs and the Go
// `BindingSecretName` — so it lands here, on the runner, mirroring the first-class-service path
// (resolveBindings + writeBindingExternalSecrets in provisioner/manifests_gen.go).
//
// The contract (identical to a service binding, keyless):
//   - non-secret facet (endpoint/port) → a literal value from the tofu outputs, set at the value-path.
//   - credential facet (username/password/connection_string) → an `existingSecret` reference
//     (BindingSecretName) set at the value-path, PLUS an ExternalSecret that materializes that k8s
//     Secret keylessly (ESO ClusterSecretStore → secretKeyRef). A plaintext credential NEVER enters
//     the chart values (the ArgoCD render marshals values verbatim).
//   - a facet whose value-path is missing, or whose keyless Secret can't be materialized (no ESO
//     store for the cloud, no provisioned master-secret output), is reported Unsatisfied — never
//     guessed, never inlined, and (for a credential) never referenced (we must not point the chart
//     at an `existingSecret` that will not exist).

import (
	"sort"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ChartBindingResult is the resolved binding write-back for one chart workload.
type ChartBindingResult struct {
	// Patches maps a chart-values dot-path to the value to set there: an `existingSecret` name for a
	// credential facet, or a literal endpoint/port for a non-secret facet.
	Patches map[string]any
	// ExternalSecrets are the keyless ExternalSecrets to materialize (one per bound target that has
	// at least one satisfiable credential facet), rendered + applied pre-sync by the runner.
	ExternalSecrets []ExternalSecretParams
	// Unsatisfied lists value_paths knob keys (`bind:{kind}:{name}:{facet}`) that could not be
	// resolved — surfaced honestly rather than dropped or guessed.
	Unsatisfied []string
}

// ChartBindingKnob is the value_paths key for one binding facet — mirrors the console's convention
// (apps/console/lib/addons/chart-overlay.ts `bindingKnob`). The two sides MUST agree on this string.
func ChartBindingKnob(kind, name, facet string) string {
	return "bind:" + kind + ":" + name + ":" + facet
}

// chartCredentialSecretOutputKey maps a bound kind to the tofu output holding its provisioned
// master-credentials secret name/ARN (the ExternalSecret's RemoteKey). Mirrors the service path's
// credentialSecretOutputKey; "" → no provisioned credential secret, so the facet is unsatisfiable.
func chartCredentialSecretOutputKey(kind string) string {
	switch kind {
	case "database":
		return "rds_master_credentials_secret_name"
	default:
		return ""
	}
}

// ResolveChartWorkloadBindings resolves a workload's bindings against the runtime tofu `outputs`,
// keyed by the workload's `valuePaths`. It never inlines a credential and never references a Secret
// that can't be materialized. `namespace` is where the ExternalSecret (and the chart) live so the
// secretKeyRef reads the same namespace.
func ResolveChartWorkloadBindings(
	workloadName string,
	bindings []types.ServiceBinding,
	valuePaths map[string]string,
	outputs map[string]string,
	provider string,
	namespace string,
) ChartBindingResult {
	res := ChartBindingResult{Patches: map[string]any{}}

	// Accumulate satisfiable credential facets per target so one ExternalSecret carries all of them.
	type credAcc struct {
		target types.ServiceBindingTarget
		facets []string
	}
	credByTarget := map[string]*credAcc{}
	var credOrder []string

	store := StoreNameFor(provider)

	for _, b := range bindings {
		for _, inj := range b.Inject {
			knob := ChartBindingKnob(string(b.Target.Kind), b.Target.Name, string(inj.From))
			path := valuePaths[knob]
			if path == "" {
				res.Unsatisfied = append(res.Unsatisfied, knob)
				continue
			}
			if IsCredentialFacet(string(inj.From)) {
				remoteKey := outputs[chartCredentialSecretOutputKey(string(b.Target.Kind))]
				_, hasProperty := facetProperty(provider, string(inj.From))
				// Satisfiable only if the cloud has an ESO store, the resource exported a master
				// secret, and the facet maps to a remote property. Otherwise: no patch (never point
				// the chart at a Secret that won't exist), report unsatisfied.
				if store == "" || remoteKey == "" || !hasProperty {
					res.Unsatisfied = append(res.Unsatisfied, knob)
					continue
				}
				tkey := string(b.Target.Kind) + "|" + b.Target.Name
				acc, ok := credByTarget[tkey]
				if !ok {
					acc = &credAcc{target: b.Target}
					credByTarget[tkey] = acc
					credOrder = append(credOrder, tkey)
				}
				acc.facets = append(acc.facets, string(inj.From))
				// Reference the keyless Secret at the value-path (its name == BindingSecretName).
				res.Patches[path] = BindingSecretName(workloadName, b.Target)
				continue
			}
			// Non-secret facet: a literal from the tofu outputs.
			var value string
			switch string(inj.From) {
			case "endpoint":
				value = outputs[endpointOutputKey(provider, string(b.Target.Kind))]
			case "port":
				value = defaultPort(string(b.Target.Kind))
			}
			if value == "" {
				res.Unsatisfied = append(res.Unsatisfied, knob)
				continue
			}
			res.Patches[path] = value
		}
	}

	for _, tkey := range credOrder {
		acc := credByTarget[tkey]
		facets := dedupeSorted(acc.facets)
		res.ExternalSecrets = append(res.ExternalSecrets, ExternalSecretParams{
			ServiceName: workloadName,
			Namespace:   namespace,
			Target:      acc.target,
			Provider:    provider,
			RemoteKey:   outputs[chartCredentialSecretOutputKey(string(acc.target.Kind))],
			Facets:      facets,
		})
	}
	sort.Strings(res.Unsatisfied)
	return res
}

// SetByPath sets `value` at a dot-path (`"a.b.c"`) inside a Helm-values map, creating intermediate
// maps. An existing non-map at an intermediate segment is replaced with a map so the leaf can be
// placed. An empty path is a no-op. Mutates and returns `m`.
func SetByPath(m map[string]any, dotPath string, value any) map[string]any {
	segments := splitPath(dotPath)
	if len(segments) == 0 {
		return m
	}
	cursor := m
	for i := 0; i < len(segments)-1; i++ {
		key := segments[i]
		next, ok := cursor[key].(map[string]any)
		if !ok {
			next = map[string]any{}
			cursor[key] = next
		}
		cursor = next
	}
	cursor[segments[len(segments)-1]] = value
	return m
}

// splitPath splits a dot-path into non-empty segments.
func splitPath(dotPath string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(dotPath); i++ {
		if i == len(dotPath) || dotPath[i] == '.' {
			if i > start {
				out = append(out, dotPath[start:i])
			}
			start = i + 1
		}
	}
	return out
}

// dedupeSorted returns the distinct values of s, sorted, for deterministic rendering.
func dedupeSorted(s []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range s {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}
