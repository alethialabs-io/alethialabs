// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// The STARTER-TEMPLATES proof (#4113) — the cloud half. Every decision it makes is in the untagged
// t2_templates.go, where it is unit-tested; this file only observes a live cluster and records.
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// templatesParams is what runT2Templates needs from the base T2 run.
type templatesParams struct {
	commits     map[string]string
	charts      map[string]ociChartPin
	phaseAJobID string
	phaseA      map[string]any
	graph       *a05Graph
	owner       string
	clusterName string
}

// runT2Templates asserts phase A on the deploy the base test already converged, then redeploys the
// same environment at starter-apps and asserts phase B. The summary is written before anything is
// asserted (all NOT_RUN), after phase A, and after phase B — each write is the evidence as it stood,
// because a later t.Fatalf must not take the earlier phase's proof with it.
func runT2Templates(t *testing.T, ctx context.Context, cp *ControlPlane, kc string, p templatesParams) {
	t.Helper()
	summaryPath := os.Getenv(envTemplatesSummary)
	s := newTemplatesSummary(templatesProvider, p.clusterName, p.commits)
	write := func() {
		if err := writeTemplatesSummary(summaryPath, s); err != nil {
			// Never fatal — the verdict is the test's — but never silent.
			t.Logf("#4113: could not write the templates summary to %s: %v", summaryPath, err)
		}
	}
	write()

	// ── PHASE A: starter-ai (apps repo + BYO chart) and starter-chart (BYO chart). ──
	resultsA, errA := pollTemplateApps(ctx, kc, templatesPhaseAExpect(), p.commits, p.charts, templatesPhaseAApps)
	s.record(resultsA, errA, time.Now())
	if ai := s.template("ai"); ai != nil {
		// The bill of what the AI template needed, read while the servers exist. Recorded, never a
		// verdict: a price is evidence about the run, not about whether the template deployed.
		cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		cost, cerr := hcloudServerCosts(cctx, os.Getenv("HCLOUD_TOKEN"), p.clusterName)
		cancel()
		if cerr != nil {
			ai.CostUnmeasured = cerr.Error()
			t.Logf("#4113: server cost UNMEASURED — %v", cerr)
		} else {
			ai.Cost = cost
			t.Logf("#4113: %d server(s) provisioned, %s EUR/h net (%s gross)", len(cost.Servers), cost.TotalHourlyNetEUR, cost.TotalHourlyGross)
		}
	}
	write()
	if errA != nil {
		// ai/chart rows that never observed anything (a listing that never answered) fail with the
		// phase's reason; rows that did observe keep their own.
		s.fail([]string{"ai", "chart"}, errA.Error(), time.Now())
		s.fail([]string{"apps"}, "not reached: phase A failed first", time.Now())
		write()
		t.Fatalf("#4113 phase A (starter-ai + starter-chart): %v", errA)
	}
	t.Logf("#4113: phase A PROVEN — starter-ai and starter-chart, %d Application(s) Healthy+Synced at their template commits", len(resultsA))

	// ── PHASE B: the same environment, the apps repository re-pointed at starter-apps. ──
	snapB, err := templatesPhaseBSnapshot(p.phaseA)
	if err != nil {
		s.fail([]string{"apps"}, err.Error(), time.Now())
		write()
		t.Fatalf("#4113 phase B: %v", err)
	}
	jobB := newUUID()
	// Aliased BEFORE the row exists: the redeploy must plan against phase A's state (the same
	// cluster), never an empty slot (a second cluster).
	cp.AliasStateToJob(jobB, p.phaseAJobID)
	if _, err := seedT2DeployJobWithID(ctx, cp, jobB, snapB, p.graph, p.owner); err != nil {
		s.fail([]string{"apps"}, "seed the phase-B redeploy: "+err.Error(), time.Now())
		write()
		t.Fatalf("#4113 phase B: seed the redeploy: %v", err)
	}
	t.Logf("#4113: seeded phase-B REDEPLOY %s (apps repo → %s), state aliased to %s", jobB, starterAppsRepo, p.phaseAJobID)
	status, err := cp.WaitTerminal(ctx, jobB, templatesRedeployWait)
	if err == nil && status != "SUCCESS" {
		msg, _, _ := cp.JobFailureDetail(ctx, jobB)
		err = fmt.Errorf("redeploy terminal status %q: %s", status, t2Truncate(msg, 2000))
	}
	if err != nil {
		s.fail([]string{"apps"}, "phase-B redeploy: "+err.Error(), time.Now())
		write()
		t.Fatalf("#4113 phase B: %v", err)
	}
	// SAME cluster, or the phase proved a re-point on a cluster nobody asked for.
	if _, metaRaw, err := cp.JobState(ctx, jobB); err != nil {
		s.fail([]string{"apps"}, "read the redeploy's metadata: "+err.Error(), time.Now())
		write()
		t.Fatalf("#4113 phase B: %v", err)
	} else {
		var meta struct {
			ClusterName string `json:"cluster_name"`
		}
		if uerr := json.Unmarshal(metaRaw, &meta); uerr != nil || strings.TrimSpace(meta.ClusterName) != strings.TrimSpace(p.clusterName) {
			why := fmt.Sprintf("the redeploy reports cluster %q, not phase A's %q (decode err: %v) — it did not converge the same cluster", meta.ClusterName, p.clusterName, uerr)
			s.fail([]string{"apps"}, why, time.Now())
			write()
			t.Fatalf("#4113 phase B: %s", why)
		}
	}
	resultsB, errB := pollTemplateApps(ctx, kc, templatesPhaseBExpect(), p.commits, p.charts, templatesPhaseBConverge)
	s.record(resultsB, errB, time.Now())
	write()
	if errB != nil {
		t.Fatalf("#4113 phase B (starter-apps): %v", errB)
	}
	t.Logf("#4113: phase B PROVEN — starter-apps root + overlays Healthy+Synced at %s; all three templates %s", p.commits[starterAppsRepo], s.Verdict)
}

// pollTemplateApps polls the argocd namespace until every expected Application passes
// evaluateTemplateApps or the window closes, and returns the LAST observation's rows either way —
// a failing run records what it saw, not nothing.
func pollTemplateApps(ctx context.Context, kc string, expect []templateAppExpect, commits map[string]string, charts map[string]ociChartPin, window time.Duration) ([]templateAppResult, error) {
	deadline := time.Now().Add(window)
	var results []templateAppResult
	var lastErr error
	var lastRaw []byte
	for {
		raw, err := kubectlGetArgoApps(ctx, kc)
		if err != nil {
			lastErr = fmt.Errorf("list ArgoCD Applications: %w", err)
		} else if observed, perr := parseTemplateApps(raw); perr != nil {
			lastErr = fmt.Errorf("parse ArgoCD Applications: %w", perr)
		} else {
			lastRaw = raw
			results, lastErr = evaluateTemplateApps(expect, observed, commits, charts)
			if lastErr == nil {
				return results, nil
			}
		}
		if time.Now().After(deadline) {
			// The per-resource detail the base assertion prints, for the losers — what differs and
			// what is not Healthy — so a red run names its cause without a live cluster.
			if lastRaw != nil {
				if st, perr := parseArgoApps(lastRaw); perr == nil {
					var names []string
					for _, e := range expect {
						names = append(names, e.Application)
					}
					if _, detail := evaluateArgoApps(st, names); detail != nil {
						lastErr = fmt.Errorf("%w\n%v", lastErr, detail)
					}
				}
			}
			return results, fmt.Errorf("not proven within %s: %w", window, lastErr)
		}
		select {
		case <-ctx.Done():
			return results, fmt.Errorf("context cancelled (%v); last state: %w", ctx.Err(), lastErr)
		case <-time.After(argoPollInterval):
		}
	}
}
