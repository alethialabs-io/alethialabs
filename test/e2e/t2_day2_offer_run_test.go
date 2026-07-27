// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// DAY-2 OFFER orchestration (#1495) — the e2e_t2-tagged half that drives the pure classifier
// (t2_day2_offer.go, #1440) against a LIVE provisioned environment. Invoked from
// TestT2RealCloudProvisioning after the day-2 ACCESS assertion and BEFORE the guaranteed
// teardown, so every plan is taken against real state.
//
// #1440 shipped AnalyzeDay2 with nothing driving it: the classifier could say whether a plan
// was safe, but no plan was ever produced, so the gate had never run. This is that missing
// half — it proposes each day-2 change for real and hands tofu's own plan to the classifier.
//
// # How each op gets a real plan
//
//	update  — RunDeployV2 with DryRun, over a config whose backup retention moved by a day.
//	resize  — the same, over a config whose database instance class moved to the per-cloud
//	          target in day2ResizeClass.
//	destroy — RunDestroyPlan (provisioner), the plan-only teardown added for this lane. It
//	          never applies and never unregisters the cluster.
//
// The mutations run through the CLOUD-INDIFFERENT config (ProjectDatabaseConfig), so each
// provider's own ProviderTfvars translates them — the harness needs no per-cloud tfvar
// vocabulary, only the one thing that genuinely cannot be cloud-indifferent (a SKU to resize
// to).
//
// # Why nothing here can pass vacuously
//
//   - A mutation that changed nothing reports Applied=false and the op is recorded as SKIPPED,
//     never as a pass.
//   - AnalyzeDay2 itself hard-errors on an empty changeset, so a mutation that plans nothing
//     fails loudly rather than returning a safe posture over zero resources.
//   - offerVerdictPass fails a run in which NO posture executed at all.
//
// Real applies are main-gated: dispatched from a non-main ref the nightly provisions nothing,
// so this harness only proves itself on a `main` run whose proof lands in the e2e ledger
// (demos/proofs/provisioning-e2e-log.md).
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// day2OfferParams carries what the day-2 offer assertion needs from the deploy under test. The
// snapshot is the runner-facing config the deploy actually consumed — mutating a copy of it is
// what makes each proposed change a real one rather than a synthetic guess.
type day2OfferParams struct {
	provider     string
	cpURL        string
	jobID        string
	templatesDir string
	snapshot     map[string]any
}

// runT2Day2Offer drives the three day-2 ops against the live environment and asserts each
// posture is Safe. Opt-in via ALETHIA_E2E_DAY2_OFFER — unset ⇒ a clean skip, so the base T2
// proof is unchanged. A deferred writeOfferSummary persists the verdict to
// ALETHIA_E2E_DAY2_OFFER_SUMMARY when set.
func runT2Day2Offer(t *testing.T, ctx context.Context, p day2OfferParams) {
	t.Helper()
	if !Day2OfferEnabled() {
		t.Logf("day-2 offer: skipped (ALETHIA_E2E_DAY2_OFFER unset)")
		return
	}

	summary := OfferSummary{Enabled: true, Provider: p.provider}
	if path := os.Getenv("ALETHIA_E2E_DAY2_OFFER_SUMMARY"); path != "" {
		defer func() {
			summary.Verdict = offerSummaryVerdict(summary)
			if werr := writeOfferSummary(path, summary); werr != nil {
				t.Logf("day-2 offer: could not write summary to %s: %v", path, werr)
			}
		}()
	}

	// Bound every plan. A `tofu plan` against live state does real provider refreshes, so a
	// wedged cloud call would otherwise hang the nightly rather than fail it.
	planCtx, cancel := context.WithTimeout(ctx, Day2OfferTimeout())
	defer cancel()

	backend := &cloud.HTTPBackendConfig{ConsoleURL: p.cpURL, JobID: p.jobID, Token: "e2e-day2-offer"}

	// ── update ── a tunable moves; the stores must converge in place.
	if cfg, mut, err := day2MutatedConfig(p.snapshot, func(c *types.ProjectConfig) Day2Mutation {
		return applyDay2Update(c.Databases)
	}); err != nil {
		t.Fatalf("day-2 offer: build the update config: %v", err)
	} else {
		summary.Mutations = append(summary.Mutations, mut)
		if !mut.Applied {
			summary.Skipped = append(summary.Skipped, fmt.Sprintf("update: %s", mut.Detail))
			t.Logf("day-2 update: skipped — %s", mut.Detail)
		} else {
			summary.OffersExercised = append(summary.OffersExercised, "database (update)")
			posture := day2PlanAndAnalyze(t, planCtx, Day2Update, cfg, p, backend)
			summary.Postures = append(summary.Postures, posture)
		}
	}

	// ── resize ── the size axis moves; the endpoint must survive.
	if cfg, mut, err := day2MutatedConfig(p.snapshot, func(c *types.ProjectConfig) Day2Mutation {
		return applyDay2Resize(c.Databases, p.provider)
	}); err != nil {
		t.Fatalf("day-2 offer: build the resize config: %v", err)
	} else {
		summary.Mutations = append(summary.Mutations, mut)
		if !mut.Applied {
			summary.Skipped = append(summary.Skipped, fmt.Sprintf("resize: %s", mut.Detail))
			t.Logf("day-2 resize: skipped — %s", mut.Detail)
		} else {
			summary.OffersExercised = append(summary.OffersExercised, "database (resize)")
			posture := day2PlanAndAnalyze(t, planCtx, Day2Resize, cfg, p, backend)
			summary.Postures = append(summary.Postures, posture)
		}
	}

	// ── destroy ── the teardown must go cleanly to zero. No mutation: the plan-only destroy
	// asks what tearing down THIS environment, as it stands, would do.
	cfg, _, err := day2MutatedConfig(p.snapshot, func(*types.ProjectConfig) Day2Mutation {
		return Day2Mutation{Op: Day2Destroy, Applied: true, Detail: "no mutation — plans the teardown as-is"}
	})
	if err != nil {
		t.Fatalf("day-2 offer: build the destroy config: %v", err)
	}
	plan, err := provisioner.RunDestroyPlan(planCtx, provisioner.DestroyParams{
		DryRun:        true,
		ProjectConfig: cfg,
		Provider:      p.provider,
		TemplatesDir:  p.templatesDir,
		StateBackend:  backend,
		Stdout:        t2LogWriter{t},
		Stderr:        t2LogWriter{t},
	})
	if err != nil {
		t.Fatalf("day-2 destroy: could not plan the teardown: %v", err)
	}
	destroyPosture, err := AnalyzeDay2(Day2Destroy, plan)
	if err != nil {
		t.Fatalf("day-2 destroy: %v", err)
	}
	t.Logf("day-2 destroy: %s", destroyPosture.Verdict)
	summary.Postures = append(summary.Postures, destroyPosture)

	if !offerVerdictPass(summary) {
		t.Fatalf("day-2 offer assertion FAILED: %s", offerSummaryVerdict(summary))
	}
	t.Logf("day-2 offer postures proven: %s", offerSummaryVerdict(summary))
}

// day2MutatedConfig decodes the deploy's own config snapshot into a ProjectConfig and applies
// one mutation to it. Decoding fresh per op is deliberate: each op must start from the config
// the deploy actually ran, never from a config a previous op already moved.
func day2MutatedConfig(snapshot map[string]any, mutate func(*types.ProjectConfig) Day2Mutation) (*types.ProjectConfig, Day2Mutation, error) {
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return nil, Day2Mutation{}, fmt.Errorf("re-marshal config snapshot: %w", err)
	}
	var cfg types.ProjectConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, Day2Mutation{}, fmt.Errorf("decode config snapshot into ProjectConfig: %w", err)
	}
	return &cfg, mutate(&cfg), nil
}

// day2PlanAndAnalyze produces a REAL plan for a proposed day-2 change (a dry-run deploy, which
// plans without applying) and classifies it. Every failure is fatal: a day-2 op whose plan could
// not be produced or read has not been asserted, and reporting it as anything but a failure is
// how the gate would pass without gating.
func day2PlanAndAnalyze(t *testing.T, ctx context.Context, op Day2Op, cfg *types.ProjectConfig, p day2OfferParams, backend *cloud.HTTPBackendConfig) *Day2Posture {
	t.Helper()
	res, err := provisioner.RunDeployV2(ctx, provisioner.DeployParams{
		DryRun:        true,
		ProjectConfig: cfg,
		Provider:      p.provider,
		TemplatesDir:  p.templatesDir,
		StateBackend:  backend,
		Stdout:        t2LogWriter{t},
		Stderr:        t2LogWriter{t},
	})
	if err != nil {
		t.Fatalf("day-2 %s: dry-run plan failed: %v", op, err)
	}
	if res == nil {
		t.Fatalf("day-2 %s: dry-run returned no plan result", op)
	}
	plan, err := planFromMap(res.PlanJSON)
	if err != nil {
		t.Fatalf("day-2 %s: %v", op, err)
	}
	posture, err := AnalyzeDay2(op, plan)
	if err != nil {
		// An empty changeset lands here by design — the mutation reported itself as applied
		// but tofu planned nothing, which means the axis this op moves is not actually wired
		// through to the template on this cloud. That is a real finding, not a flake.
		t.Fatalf("day-2 %s: %v", op, err)
	}
	t.Logf("day-2 %s: %s", op, posture.Verdict)
	return posture
}
