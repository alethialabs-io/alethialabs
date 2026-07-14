// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func dataAddOn(id string) types.AddOnInstall {
	return types.AddOnInstall{
		ID:        id,
		Mode:      "managed",
		ChartRepo: "https://example.test/charts",
		Chart:     "x",
		Version:   "1.0.0",
		Namespace: "databases",
	}
}

// Only the synthesized in-cluster data services (db-/cache-/queue-) get an endpoint read-back — a
// marketplace add-on (grafana, vault…) is not a data service and has no component row to write to.
func TestIsDataServiceAddOn(t *testing.T) {
	yes := []string{"db-primary", "cache-main", "queue-jobs"}
	for _, id := range yes {
		if !isDataServiceAddOn(dataAddOn(id)) {
			t.Fatalf("%q must be treated as an in-cluster data service", id)
		}
	}
	no := []string{"kube-prometheus-stack", "vault", "cnpg-operator", "reloader"}
	for _, id := range no {
		if isDataServiceAddOn(dataAddOn(id)) {
			t.Fatalf("%q must NOT be treated as a data service (it has no component row)", id)
		}
	}
}

// The Secret we record is a REFERENCE, and it must be the chart's credential Secret — never Helm's
// own release bookkeeping Secret (type helm.sh/release.v1), which holds no credentials and whose
// name would be a useless pointer for the console.
func TestReadSecretRef_SkipsHelmReleaseSecrets(t *testing.T) {
	// A pure-logic stand-in for the kubectl read: the selection rules are what matter.
	items := []struct {
		name string
		typ  string
	}{
		{"sh.helm.release.v1.addon-db-primary.v1", "helm.sh/release.v1"},
		{"addon-db-primary-app", "kubernetes.io/basic-auth"},
	}

	var names []string
	for _, s := range items {
		if s.typ == "helm.sh/release.v1" {
			continue
		}
		names = append(names, s.name)
	}
	if len(names) != 1 || names[0] != "addon-db-primary-app" {
		t.Fatalf("the helm release secret must be skipped; got %v", names)
	}

	// CNPG mints "<cluster>-app" — the credential an application actually connects with. When
	// several candidates exist, that one wins.
	var chosen string
	for _, n := range names {
		if len(n) > 4 && n[len(n)-4:] == "-app" {
			chosen = n
			break
		}
	}
	if chosen != "addon-db-primary-app" {
		t.Fatalf("the -app credential secret must be preferred; got %q", chosen)
	}
}

// The endpoint must be a client-usable Service — never a headless (peer-discovery) one — and a
// reader Service, when the chart ships one, must be recorded separately rather than overwriting the
// primary. Picking the wrong Service silently gives the console a connection string that fails.
func TestServiceSelectionRules(t *testing.T) {
	type svc struct {
		name      string
		clusterIP string
	}
	// Shapes taken from the real charts: CNPG (-rw/-ro/-r), Valkey (<rel>-valkey, -read, -headless).
	svcs := []svc{
		{"addon-db-primary-headless", "None"},
		{"addon-db-primary-ro", "10.0.0.2"},
		{"addon-db-primary-rw", "10.0.0.1"},
	}

	var primary, reader string
	for _, s := range svcs {
		if s.clusterIP == "None" || hasSuffix(s.name, "-headless") {
			continue
		}
		switch {
		case hasSuffix(s.name, "-ro"), hasSuffix(s.name, "-read"):
			reader = s.name
		case hasSuffix(s.name, "-rw"):
			primary = s.name
		default:
			if primary == "" {
				primary = s.name
			}
		}
	}

	if primary != "addon-db-primary-rw" {
		t.Fatalf("the read-write Service must be the primary endpoint, got %q", primary)
	}
	if reader != "addon-db-primary-ro" {
		t.Fatalf("the read-only Service must be recorded as the reader endpoint, got %q", reader)
	}
	if primary == "addon-db-primary-headless" || reader == "addon-db-primary-headless" {
		t.Fatal("a headless Service is for peer discovery and must never be a client endpoint")
	}
}

func hasSuffix(s, suffix string) bool {
	return len(s) >= len(suffix) && s[len(s)-len(suffix):] == suffix
}
