// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"context"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// Wave ordering for Helm add-on Applications.
//
// ArgoCD's `argocd.argoproj.io/sync-wave` annotation orders resources WITHIN one Application's
// sync. It does NOT order separate top-level Applications against each other — they are all
// applied at once and reconcile concurrently. So an operator Application (CloudNativePG) and an
// Application carrying a CR that needs the operator's schema (a CNPG `Cluster`) RACE: the CR's
// first sync fails with `no matches for kind "Cluster"` until the CRD is Established. ArgoCD's
// automated+selfHeal retry does converge eventually, but the deploy's health read runs long before
// that and records the failure — which is why a healthy Hetzner database could report Creating.
//
// So the runner orders the waves itself: apply every Application in wave N, wait for the CRDs the
// wave-N add-ons declare, then apply wave N+1.

// addonHealthPollInterval is how often the convergence wait re-reads ArgoCD health.
const addonHealthPollInterval = 10 * time.Second

// waveGroups buckets managed, ArgoCD-rendered add-ons by sync wave, ascending. Manifest-source
// add-ons are excluded — the runner kubectl-applies those (ApplyManifestAddOns) and they have no
// Application to apply here.
func waveGroups(addons []types.AddOnInstall) ([]int, map[int][]types.AddOnInstall) {
	byWave := map[int][]types.AddOnInstall{}
	for _, a := range addons {
		if a.Mode != "managed" || a.IsManifestSource() {
			continue
		}
		byWave[a.SyncWave] = append(byWave[a.SyncWave], a)
	}
	waves := make([]int, 0, len(byWave))
	for w := range byWave {
		waves = append(waves, w)
	}
	sort.Ints(waves)
	return waves, byWave
}

// ApplyAddOnsInWaves applies the rendered add-on Applications in ascending sync-wave order, waiting
// after each wave for the CRDs that wave's add-ons declare (AddOnInstall.CRDs) to become
// Established. `renderedDir` is RenderManagedAddOns' output — one `<AddOnAppName>.yaml` per add-on.
//
// This is what closes the operator→CR race for HELM operators (CloudNativePG), the way
// ApplyManifestAddOns closes it for manifest operators.
//
// Fail-soft, like the rest of the add-on stage: a wave that fails to apply is reported and the
// remaining waves still run (a bad add-on must not fail an otherwise-healthy cluster). A CRD that
// never establishes is a warning, not a hard error — the dependent CR will simply surface as
// unhealthy in the console, which is the honest outcome.
func ApplyAddOnsInWaves(addons []types.AddOnInstall, renderedDir string, stdout, stderr io.Writer) error {
	waves, byWave := waveGroups(addons)
	if len(waves) == 0 {
		return nil
	}

	var firstErr error
	for _, w := range waves {
		group := byWave[w]
		fmt.Fprintf(stdout, "Applying add-on wave %d (%d application(s))...\n", w, len(group))
		for _, a := range group {
			path := filepath.Join(renderedDir, AddOnAppName(a.ID)+".yaml")
			cmd := fmt.Sprintf("kubectl apply -f %s", path)
			if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
				fmt.Fprintf(stderr, "Warning: add-on %s failed to apply: %v\n", a.ID, err)
				if firstErr == nil {
					firstErr = err
				}
			}
		}
		// Before the next wave can sync a CR, the schema it needs must exist. An operator
		// Application declares the CRDs it establishes (e.g. the CNPG operator →
		// clusters.postgresql.cnpg.io); wait for them here.
		for _, a := range group {
			for _, crd := range a.CRDs {
				fmt.Fprintf(stdout, "  waiting for CRD %s (from %s)...\n", crd, a.ID)
				if err := waitForCRDEstablished(crd, stdout, stderr); err != nil {
					fmt.Fprintf(stderr, "Warning: %v — a CR that needs it may fail its first sync\n", err)
				}
			}
		}
	}
	return firstErr
}

// WaitAddOnsHealthy polls ArgoCD until every named Application is Healthy+Synced, or the timeout
// elapses. It returns the last health read either way — this is a BEST-EFFORT convergence wait, not
// a gate: an add-on that never converges is reported honestly to the console rather than failing an
// otherwise-healthy cluster.
//
// Without it the deploy read health the instant after `kubectl apply`, when every Application is
// still Progressing/Missing — so a database that was about to come up perfectly was persisted as
// "Creating", and nothing ever refreshed it (the day-2 refresh only touches project_addons rows,
// which the synthesized Hetzner data-service specs don't have).
func WaitAddOnsHealthy(ctx context.Context, names []string, timeout time.Duration, stdout, stderr io.Writer) map[string]AddOnHealth {
	if len(names) == 0 {
		return map[string]AddOnHealth{}
	}
	deadline := time.Now().Add(timeout)
	fmt.Fprintf(stdout, "Waiting up to %s for %d add-on(s) to converge...\n", timeout, len(names))

	var last map[string]AddOnHealth
	for {
		last = ReadAddOnHealth(names, stdout, stderr)
		if allHealthy(last) {
			fmt.Fprintln(stdout, "All add-ons Healthy + Synced.")
			return last
		}
		if time.Now().After(deadline) {
			fmt.Fprintf(stderr, "Add-on convergence wait timed out after %s: %s\n", timeout, pending(last))
			return last
		}
		select {
		case <-ctx.Done():
			return last
		case <-time.After(addonHealthPollInterval):
		}
	}
}

// allHealthy reports whether every add-on reads Healthy AND Synced.
func allHealthy(h map[string]AddOnHealth) bool {
	if len(h) == 0 {
		return false
	}
	for _, v := range h {
		if v.Health != "Healthy" || v.Sync != "Synced" {
			return false
		}
	}
	return true
}

// pending renders the add-ons that have not converged (for the timeout message).
func pending(h map[string]AddOnHealth) string {
	var out []string
	for name, v := range h {
		if v.Health != "Healthy" || v.Sync != "Synced" {
			out = append(out, fmt.Sprintf("%s(%s/%s)", name, v.Health, v.Sync))
		}
	}
	sort.Strings(out)
	if len(out) == 0 {
		return "none"
	}
	return fmt.Sprint(out)
}
