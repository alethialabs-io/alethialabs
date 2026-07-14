// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The FULL add-on surface.
//
// The provisioning tiers seed ONE lean add-on by default (reloader — see seedAddOns), which is
// enough to give the ArgoCD health assertion teeth but is nowhere near the maintainer's
// FULLY-TESTED bar: "every single add-on we have available" must install and converge.
//
// AllCatalogAddOns loads all 19, from the GENERATED fixture `fixtures/addon_catalog.json` — which
// is produced from apps/console/lib/addons/catalog.ts (the SSOT) via the real `resolveAddOnInstall`
// (`pnpm -F console export:addon-catalog`), and kept honest by catalog-export.test.ts, which reds CI
// if the fixture drifts from the catalog. Re-typing the chart coordinates here in Go would have gone
// stale the first time someone bumped a chart — and the drift would only have surfaced as a red
// nightly against a real cloud.
//
// Opt-in via ALETHIA_E2E_ALL_ADDONS=1: the full surface pulls ~19 charts (several heavy —
// kube-prometheus-stack, harbor, minio, vault, loki, tempo, velero) and needs a node sized for them,
// so the default lean tier stays fast and cheap. The nightly real-apply run turns it on.

// AllAddOnsEnabled reports whether this run should seed the FULL add-on surface.
func AllAddOnsEnabled() bool {
	return os.Getenv("ALETHIA_E2E_ALL_ADDONS") == "1"
}

// addonCatalogFixture is the generated all-add-ons fixture (see the package comment).
func addonCatalogFixture() (string, error) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("cannot locate the e2e package directory")
	}
	return filepath.Join(filepath.Dir(thisFile), "fixtures", "addon_catalog.json"), nil
}

// AllCatalogAddOns returns every marketplace add-on as the runner-facing install spec the console
// would emit. Fail-closed: a missing/empty/short fixture is an ERROR, never a silent fallback to a
// smaller set — a full-surface run that quietly installed 1 add-on and reported green would be the
// exact vacuous proof the FULLY-TESTED bar exists to prevent.
func AllCatalogAddOns() ([]types.AddOnInstall, error) {
	path, err := addonCatalogFixture()
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read add-on catalog fixture: %w (regenerate: pnpm -F console export:addon-catalog)", err)
	}
	var addons []types.AddOnInstall
	if err := json.Unmarshal(raw, &addons); err != nil {
		return nil, fmt.Errorf("parse add-on catalog fixture: %w", err)
	}
	if len(addons) < expectedCatalogSize {
		return nil, fmt.Errorf(
			"add-on catalog fixture holds %d add-ons, expected %d — the full-surface run would be vacuous (regenerate: pnpm -F console export:addon-catalog)",
			len(addons), expectedCatalogSize,
		)
	}
	for i, a := range addons {
		if a.ID == "" || a.ChartRepo == "" || a.Chart == "" || a.Version == "" {
			return nil, fmt.Errorf("add-on catalog fixture entry %d is incomplete: %+v", i, a)
		}
	}
	return addons, nil
}

// expectedCatalogSize mirrors the console's B0.3 SSOT count guard (ADDON_CATALOG.length === 19).
// A fixture with fewer entries means the export is stale or partial — fail rather than under-test.
const expectedCatalogSize = 19

// SeedAddOnsForSurface returns the add-ons a provisioning tier should seed: the full catalog when
// ALETHIA_E2E_ALL_ADDONS=1, else the lean single seed (fast default).
func SeedAddOnsForSurface(lean []types.AddOnInstall) ([]types.AddOnInstall, error) {
	if !AllAddOnsEnabled() {
		return lean, nil
	}
	return AllCatalogAddOns()
}
