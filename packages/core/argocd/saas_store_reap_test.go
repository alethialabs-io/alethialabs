// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/categories"
)

// TestAllSaaSStoreNamesCoversEveryTemplateBranch is the tripwire #2038 needed.
//
// The cleanup re-listed the SaaS store names by hand and was missing secretstore-infisical, so
// switching away from Infisical left its ClusterSecretStore orphaned in a permanently-broken state.
// It is easy to miss because the template never spells the names literally — it renders
// `{{ .SecretsSaaS.StoreName }}` — so grepping the template for a name finds nothing to compare a
// hand-written list against.
//
// This closes that by comparing the derived list to the template's own `eq .SecretsSaaS.Kind "…"`
// branches, which IS the render gate.
func TestAllSaaSStoreNamesCoversEveryTemplateBranch(t *testing.T) {
	kindRe := regexp.MustCompile(`eq \.SecretsSaaS\.Kind "([a-z0-9-]+)"`)
	matches := kindRe.FindAllStringSubmatch(externalSecretsStoreTemplate, -1)
	if len(matches) == 0 {
		t.Fatal("no `eq .SecretsSaaS.Kind` branches found — the tripwire is reading the wrong template and would pass vacuously")
	}

	renderedKinds := map[string]bool{}
	for _, m := range matches {
		renderedKinds[m[1]] = true
	}

	// Every name the cleanup enumerates must belong to a kind the template renders...
	names := categories.AllSaaSStoreNames()
	if len(names) == 0 {
		t.Fatal("AllSaaSStoreNames is empty")
	}

	// ...and every rendering kind must be reachable from at least one enumerated name. `vault` backs
	// two names (vault + generic), so this is a coverage check per KIND, not a 1:1 count.
	coveredKinds := map[string]bool{}
	for _, n := range names {
		slug := strings.TrimPrefix(n, "secretstore-")
		switch slug {
		case "vault", "generic":
			coveredKinds["vault"] = true
		default:
			coveredKinds[slug] = true
		}
	}

	for kind := range renderedKinds {
		if !coveredKinds[kind] {
			t.Errorf("the template renders a %q SaaS store but AllSaaSStoreNames enumerates no name for it — a store of that kind would be orphaned on switch-away, which is exactly #2038", kind)
		}
	}
	for kind := range coveredKinds {
		if !renderedKinds[kind] {
			t.Errorf("AllSaaSStoreNames enumerates a %q store the template never renders — the cleanup would try to delete a store that cannot exist", kind)
		}
	}
}

// TestSaaSStoreNamesIncludeInfisical is the specific regression, stated plainly so a future reader
// sees the name that was missing rather than only the general property above.
func TestSaaSStoreNamesIncludeInfisical(t *testing.T) {
	var found bool
	for _, n := range categories.AllSaaSStoreNames() {
		if n == "secretstore-infisical" {
			found = true
		}
	}
	if !found {
		t.Errorf("secretstore-infisical is not enumerated: %v", categories.AllSaaSStoreNames())
	}
}

// TestOnePasswordRendersNoStore pins the documented exclusion. 1Password's ESO provider is
// Connect-server-only, which a bare Service-Account token cannot satisfy, so no branch renders and
// there is never a store of that name to reap. If that changes, this fails and points at the
// enumeration rather than letting the cleanup go quietly stale.
func TestOnePasswordRendersNoStore(t *testing.T) {
	if strings.Contains(externalSecretsStoreTemplate, `.SecretsSaaS.Kind "onepassword"`) {
		t.Error("the template now renders a onepassword store — add its slug to saaSStoreSlugs so the cleanup can reap it")
	}
	for _, n := range categories.AllSaaSStoreNames() {
		if strings.Contains(n, "onepassword") {
			t.Errorf("AllSaaSStoreNames includes %q, but no template branch renders it", n)
		}
	}
}
