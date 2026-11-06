// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

// renderedByoBindings renders, without applying anything or writing any value-path, every binding
// ExternalSecret applyByoChartBindingsExcept applies for this configuration, keyed by its namespace
// and name. The BYO secret-sync sweep holds each live binding to exactly this object
// (argocd.SweepByoSecretSyncObjects).
//
// It walks the same add-ons, with the same refusals, policy, renderers and labels as
// applyByoChartBindingsExcept. That function renders and applies in one loop and has no seam to
// hand its documents out, so the walk is restated here.
// TestRenderedByoBindings_MatchesWhatTheBindingApplyApplies holds the two to the same bytes, so a
// change to one that is not made to the other fails the suite. A document that does not render, or
// whose name cannot be read back, is left out: the sweep then compares nothing for that name and
// leaves the live object as it is.
func renderedByoBindings(vc *types.ProjectConfig, outputs map[string]interface{}, provider string, refused []byoRefusal) map[argocd.BindingSecretRef]string {
	keylessOn := keylessDBAuthEnabled()
	dbUsersOn := byoDBUsersEnabled()
	skip := byoRefusedIDs(refused)
	owner := byoBindingOwner(vc)
	var dbUsers *manifests.ByoDBUsers
	if dbUsersOn {
		dbUsers = &manifests.ByoDBUsers{Environment: owner, SecretNames: customSecretNames(outputs), Provisioned: provisionedByoDBUsers(vc)}
	}
	strOutputs := make(map[string]string, len(outputs))
	for k, v := range outputs {
		if s, ok := v.(string); ok {
			strOutputs[k] = s
		}
	}

	out := map[argocd.BindingSecretRef]string{}
	add := func(doc string) {
		var head struct {
			Metadata struct {
				Name      string `yaml:"name"`
				Namespace string `yaml:"namespace"`
			} `yaml:"metadata"`
		}
		if doc == "" || yaml.Unmarshal([]byte(doc), &head) != nil || head.Metadata.Name == "" {
			return
		}
		out[argocd.BindingSecretRef{Namespace: head.Metadata.Namespace, Name: head.Metadata.Name}] = doc
	}
	for i := range vc.AddOns {
		a := vc.AddOns[i]
		if len(a.Workloads) == 0 || (a.IsByo() && skip[a.ID]) {
			continue
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
			for _, es := range res.ExternalSecrets {
				es.Labels = map[string]string{argocd.ByoBindingSecretLabel: "true", argocd.ByoBindingOwnerLabel: owner}
				if doc, _, err := manifests.RenderExternalSecret(es); err == nil {
					add(doc)
				}
			}
			for _, es := range res.DBUserSecrets {
				es.Labels = map[string]string{
					argocd.ByoBindingSecretLabel: "true",
					argocd.ByoBindingOwnerLabel:  owner,
					argocd.ByoBindingSourceLabel: argocd.ByoBindingSourceDBUser,
				}
				if doc, err := manifests.RenderByoDBUserExternalSecret(es); err == nil {
					add(doc)
				}
			}
		}
	}
	return out
}
