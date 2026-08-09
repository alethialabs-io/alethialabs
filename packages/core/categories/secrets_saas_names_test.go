// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"testing"
)

// TestAllSaaSStoreNames pins the enumeration the ClusterSecretStore cleanup reaps from (#2038).
//
// The authoritative check — that this list matches the template's own render branches — lives in
// packages/core/argocd, because that is where the template is. This one asserts the contract from
// the side that OWNS the names, so the derivation is covered where it is defined rather than only
// through its consumer.
func TestAllSaaSStoreNames(t *testing.T) {
	got := AllSaaSStoreNames()

	want := map[string]bool{
		"secretstore-vault":     false,
		"secretstore-generic":   false,
		"secretstore-doppler":   false,
		"secretstore-infisical": false, // the name that was missing from the hand-written cleanup
	}
	for _, n := range got {
		if _, known := want[n]; !known {
			t.Errorf("unexpected store name %q — if the template gained a branch, update this test WITH the reason", n)
			continue
		}
		want[n] = true
	}
	for n, seen := range want {
		if !seen {
			t.Errorf("AllSaaSStoreNames is missing %q; a store of that kind would be orphaned on switch-away", n)
		}
	}

	// `generic` is a second vault-KIND store with its own name — enumerating kinds instead of slugs
	// would silently drop it, so the count is part of the contract.
	if len(got) != len(want) {
		t.Errorf("AllSaaSStoreNames returned %d names, want %d: %v", len(got), len(want), got)
	}

	// 1Password is a documented runtime-read exclusion: ESO's provider is Connect-server-only, so no
	// branch renders and there is never a store of that name to reap.
	for _, n := range got {
		if n == "secretstore-onepassword" {
			t.Error("1Password has no ESO render branch; enumerating it would make the cleanup delete a store that cannot exist")
		}
	}
}

func TestSaaSStoreName(t *testing.T) {
	for slug, want := range map[string]string{
		"vault":     "secretstore-vault",
		"generic":   "secretstore-generic",
		"doppler":   "secretstore-doppler",
		"infisical": "secretstore-infisical",
	} {
		if got := SaaSStoreName(slug); got != want {
			t.Errorf("SaaSStoreName(%q) = %q, want %q", slug, got, want)
		}
	}
}

// TestSaaSStoreNameMatchesTheDescriptors is the half that stops a rename landing on one side only:
// the name the behaviors put on their descriptor must be the name the cleanup enumerates. A drift
// here is unobservable at runtime until a store is orphaned.
func TestSaaSStoreNameMatchesTheDescriptors(t *testing.T) {
	// vaultSaaSStore is the shared builder for the vault-kind slugs.
	for _, slug := range []string{"vault", "generic"} {
		s := vaultSaaSStore(ComponentContext{}, slug)
		if s.StoreName != SaaSStoreName(slug) {
			t.Errorf("vaultSaaSStore(%q).StoreName = %q but SaaSStoreName says %q", slug, s.StoreName, SaaSStoreName(slug))
		}
	}
}
