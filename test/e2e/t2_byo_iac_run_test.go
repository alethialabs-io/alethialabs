// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// T2 BRING-YOUR-OWN IaC continuous-proof leg (#1765) — the ORCHESTRATION half, driven against the
// live control plane + the still-running runner via *testing.T. Compiled only under the e2e_t2
// tag; the pure helpers it calls live in the untagged t2_byo_iac.go so they stay unit-testable
// without a cloud.
//
// Invoked from TestT2RealCloudProvisioning AFTER the base cluster assertions and BEFORE the test
// returns, so the guaranteed teardown still runs. Opt-in via ALETHIA_E2E_BYO_IAC; unset ⇒ a clean
// skip (base T2 unchanged).
//
// # Why this layers onto a cluster run it does not use
//
// It needs exactly two things the base run already stood up: a MIGRATED control plane with a
// recording http state proxy, and a RUNNING runner that will claim jobs. It uses neither the
// cluster nor the kubeconfig — a BYO module emits no cluster_name, so there is nothing to talk to.
// Layering costs one extra tiny cloud resource per leg rather than a second whole T2 job.
//
// # The six jobs, in order
//
//  1. DEPLOY  → iac/blocked      MUST FAIL   (the gate has teeth)
//  2. DEPLOY  → iac/drift/<p>    SUCCESS     (clone-at-pin → gate → receipt → apply → state)
//  3. DETECT_DRIFT               in_sync     (baseline over the deploy's real state)
//     ── out-of-band mutation, via the cloud's own CLI, not tofu ──
//  4. DETECT_DRIFT               DRIFTED     (the posture flips, on the probe resource)
//  5. DEPLOY  (heal)             SUCCESS     (same pinned commit, re-converges)
//  6. DETECT_DRIFT               in_sync     (and it healed)
//  7. DESTROY                    SUCCESS     (state cleared ⇒ nothing left to orphan)
package e2e

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// byoIacParams carries what the leg needs from the completed base provision.
type byoIacParams struct {
	project  string
	env      string
	provider string
	region   string
	// owner is the SeedRunner owner. Every job MUST be seeded into it or the self-runner claim
	// (j.org_id = v_runner_org_id, #392) never matches and the job sits QUEUED until the wait
	// times out — which reads like a product failure rather than a harness bug.
	owner string
	// cpURL is the control plane's base URL, used by the in-process destroy fallback.
	cpURL string
	// receiptPub verifies the runner's signed receipt over the CUSTOMER's plan.
	receiptPub ed25519.PublicKey
}

// runT2ByoIac drives the BYO-IaC continuous-proof leg. A no-op (clean skip) unless
// ALETHIA_E2E_BYO_IAC is truthy. On any failure it t.Fatalf's; a deferred summary write persists
// whatever was proven so far to ALETHIA_E2E_BYO_IAC_SUMMARY for the proof capture.
func runT2ByoIac(t *testing.T, ctx context.Context, cp *ControlPlane, p byoIacParams) {
	t.Helper()

	if !byoIacEnabled() {
		t.Logf("byo-iac: SKIPPED (%s unset) — base T2 proof unchanged", envByoIac)
		if sp := os.Getenv(envByoIacSummary); sp != "" {
			_ = writeByoIacSummary(sp, ByoIacSummary{Enabled: false, Provider: p.provider, Verdict: "byo-iac: skipped"})
		}
		return
	}

	summary := &ByoIacSummary{Enabled: true, Provider: p.provider}
	defer func() {
		summary.Verdict = byoIacSummaryVerdict(*summary)
		if sp := os.Getenv(envByoIacSummary); sp != "" {
			if werr := writeByoIacSummary(sp, *summary); werr != nil {
				t.Logf("byo-iac: failed to write summary to %s: %v", sp, werr)
			}
		}
		t.Logf("byo-iac summary: %s", summary.Verdict)
	}()

	// ── Resolve the customer module + PIN the commit, ONCE. Every job below carries this exact
	//    sha, never the moving ref: that is the TOCTOU property the BYO path is built around, and
	//    resolving it per-job would quietly re-introduce the race the pin exists to close. ──
	if _, wired := byoIacProbeResourceType[strings.ToLower(strings.TrimSpace(p.provider))]; !wired {
		t.Fatalf("byo-iac: no drift module is wired for provider %q — enable it only on a cloud whose module and out-of-band mutation both exist, or the leg would report a green pass having induced nothing", p.provider)
	}
	repo, ref, path := byoIacRepo(p.provider), byoIacRef(p.provider), byoIacPath(p.provider)
	summary.Repo, summary.Ref, summary.Path = repo, ref, path

	sha := byoIacResolvePinnedSHA(t, ctx, repo, ref)
	summary.PinnedSHA = sha
	src := byoIacSource{RepoURL: repo, Ref: ref, Path: path, CommitSHA: sha}
	if err := src.validate(); err != nil {
		t.Fatalf("byo-iac: %v", err)
	}
	t.Logf("byo-iac: customer module %s (ref %q) path %q pinned at %s", repo, ref, path, sha)

	wait := byoIacTimeout()

	// ── (1) THE GATE HAS TEETH. Same repo, same pinned commit, a module declaring a provider that
	//        is NOT on DefaultProviderAllowlist. It must FAIL — before tofu init resolves anything,
	//        so this costs no cloud time and creates nothing. Run FIRST: if the gate is not
	//        fail-closed, nothing below is worth measuring. ──
	byoIacAssertGateBlocks(t, ctx, cp, p, src, wait, summary)

	// ── GUARANTEED teardown, registered BEFORE the deploy. The in-process RunDestroy runs even if
	//    an assertion below fails and even after the runner process is killed — it needs only tofu,
	//    the ambient cloud credentials and the still-live control plane (whose Close is registered
	//    EARLIER, so LIFO cleanup order puts it after this one). Step (7) is the real DESTROY proof
	//    through a job; this is the safety net for every path that never reaches it. ──
	deployJobID := newUUID()
	t.Cleanup(func() {
		dctx, dcancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer dcancel()
		if derr := byoIacDestroyInProcess(dctx, p, src, deployJobID, t2LogWriter{t}); derr != nil {
			t.Logf("byo-iac: fallback RunDestroy failed (the probe resource may need a manual sweep): %v", derr)
		} else {
			t.Log("byo-iac: fallback RunDestroy completed (a no-op when step 7 already destroyed)")
		}
	})

	// ── (2) THE REAL DEPLOY: clone at the pinned sha → fail-closed gate → plan → signed receipt
	//        over the CUSTOMER's own plan JSON → apply → state to Alethia's proxy. ──
	snap := buildByoIacSnapshot(p.project, p.env, p.provider, p.region, src)
	if err := byoIacSeedJob(ctx, cp, deployJobID, "DEPLOY", snap, p.owner); err != nil {
		t.Fatalf("byo-iac: seed BYO DEPLOY job: %v", err)
	}
	t.Logf("byo-iac: seeded QUEUED BYO DEPLOY job %s", deployJobID)

	status, err := cp.WaitTerminal(ctx, deployJobID, wait)
	if err != nil {
		t.Fatalf("byo-iac: waiting for the BYO DEPLOY job: %v\n%s", err, jobFailureDump(ctx, cp, deployJobID))
	}
	summary.DeployStatus = status
	if status != "SUCCESS" {
		t.Fatalf("byo-iac: BYO DEPLOY terminal status = %q, want SUCCESS\n%s", status, jobFailureDump(ctx, cp, deployJobID))
	}

	// (2a) The runner's OWN account of what it did, read back from the SHIPPED logs. Asserting the
	//      harness's intent proves nothing; these two lines are the runner saying it checked out
	//      the pinned commit and that the fail-closed gate ran and passed on this module.
	logCount, logContent, err := cp.JobLogs(ctx, deployJobID)
	if err != nil {
		t.Fatalf("byo-iac: read job logs: %v", err)
	}
	if logCount == 0 {
		t.Fatal("byo-iac: no job_logs rows for the BYO deploy — the log-shipping path did not reach the DB, so the runner's own account is unavailable")
	}
	summary.CloneAtPinnedLogged = strings.Contains(logContent, "at pinned commit "+sha)
	if !summary.CloneAtPinnedLogged {
		t.Fatalf("byo-iac: the shipped logs never record cloning at the pinned commit %s — the deploy may have run a moving ref:\n%s", sha, t2Truncate(logContent, 4000))
	}
	summary.GatePassedLogged = strings.Contains(logContent, "BYO IaC static gate: OK")
	if !summary.GatePassedLogged {
		t.Fatalf("byo-iac: the shipped logs never record the static gate passing — the fail-closed gate may have been bypassed:\n%s", t2Truncate(logContent, 4000))
	}

	// (2b) The BYO post-apply contract: NO cluster, and a signed receipt that is real evidence.
	_, metaRaw, err := cp.JobState(ctx, deployJobID)
	if err != nil {
		t.Fatalf("byo-iac: read BYO deploy metadata: %v", err)
	}
	var meta struct {
		ClusterName   string          `json:"cluster_name"`
		ClusterReady  bool            `json:"cluster_ready"`
		VerifyResult  json.RawMessage `json:"verify_result"`
		VerifyReceipt json.RawMessage `json:"verify_receipt"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		t.Fatalf("byo-iac: decode BYO deploy execution_metadata: %v\nraw: %s", err, metaRaw)
	}
	if meta.ClusterName != "" {
		t.Fatalf("byo-iac: the BYO deploy reported cluster_name=%q — the Alethia post-apply spine must be SKIPPED for a customer module, and this probe must never provision a cluster", meta.ClusterName)
	}
	if meta.ClusterReady {
		t.Fatal("byo-iac: the BYO deploy reported cluster_ready — the reachability gate must not run for a customer module")
	}
	if len(meta.VerifyResult) == 0 {
		t.Fatal("byo-iac: verify_result is absent — the verification gate did not run on the CUSTOMER's plan JSON")
	}
	receiptSHA, err := VerifySignedReceipt(meta.VerifyReceipt, p.receiptPub)
	if err != nil {
		t.Fatalf("byo-iac: signed receipt over the customer's own module: %v", err)
	}
	summary.ReceiptPlanSHA = receiptSHA
	t.Logf("byo-iac: signed receipt over the CUSTOMER's plan, sealed to sha256 %s", receiptSHA)

	// (2c) State lives on ALETHIA's proxy, holds real resources, and does NOT emit a cluster_name.
	state := cp.StateSnapshot(deployJobID)
	resCount, err := tfstateResourceCount(state)
	if err != nil {
		t.Fatalf("byo-iac: the proxy holds no readable state after apply (%v) — the http backend override did not take effect, so state may be on the runner's local disk", err)
	}
	if resCount == 0 {
		t.Fatal("byo-iac: the proxy state records 0 managed resources — apply wrote nothing real, and every drift assertion below would be vacuous")
	}
	summary.StateOnProxy, summary.StateResources = true, resCount

	outputs, err := parseTfstateOutputs(state)
	if err != nil {
		t.Fatalf("byo-iac: parse the proxy state's outputs: %v", err)
	}
	if err := assertNoClusterNameOutput(outputs); err != nil {
		t.Fatalf("byo-iac: %v", err)
	}
	summary.NoClusterNameOutput = true

	wantCtx := p.project + "/" + p.env
	gotCtx, err := outputs.outputString("alethia_context")
	if err != nil {
		t.Fatalf("byo-iac: %v — the frozen TF_VAR_alethia_* contract cannot be shown to have reached the customer module", err)
	}
	if gotCtx != wantCtx {
		t.Fatalf("byo-iac: alethia_context = %q, want %q — the runner's TF_VAR_alethia_* injection did not reach the module (it silently used the variables' defaults)", gotCtx, wantCtx)
	}
	summary.AlethiaContextEcho = gotCtx

	marker, err := outputs.outputString("drift_marker")
	if err != nil {
		t.Fatalf("byo-iac: %v", err)
	}
	if marker != byoIacBaselineMarker {
		t.Fatalf("byo-iac: drift_marker = %q right after apply, want the module baseline %q — the probe is not at a known starting point, so a later 'it drifted' could mean anything", marker, byoIacBaselineMarker)
	}
	target, err := outputs.outputString("drift_target")
	if err != nil {
		t.Fatalf("byo-iac: %v — without it the leg would have to GUESS what to mutate", err)
	}
	summary.DriftTarget = target
	t.Logf("byo-iac: apply wrote %d managed resource(s) to the proxy; drift target %q at baseline, context %q", resCount, target, gotCtx)

	// ── (3) BASELINE posture: in_sync over the deploy's real state, before anything is touched. ──
	posture := byoIacDriftCheck(t, ctx, cp, p, snap, deployJobID, wait, "baseline")
	if !posture.InSync || posture.Drifted != 0 {
		t.Fatalf("byo-iac: the baseline posture is not in-sync right after a clean apply: in_sync=%t drifted=%d details=%v",
			posture.InSync, posture.Drifted, posture.types())
	}
	summary.BaselineInSync = true

	// ── (4) INDUCE REAL DRIFT, out of band. This is the step #1765's open question was decided on:
	//        re-proving an unchanged commit re-proves the pipeline, but only a change made behind
	//        Alethia's back can show the posture FLIP. ──
	newMarker := fmt.Sprintf("drifted-%d", time.Now().UTC().Unix())
	argv, err := byoIacMutationArgv(p.provider, target, newMarker, byoIacMutationOpts{
		Region:  p.region,
		Account: t2AmbientAccountID(p.provider),
	})
	if err != nil {
		t.Fatalf("byo-iac: %v", err)
	}
	mctx, mcancel := context.WithTimeout(ctx, 3*time.Minute)
	defer mcancel()
	cmd := exec.CommandContext(mctx, argv[0], argv[1:]...)
	cmd.Env = os.Environ()
	if out, merr := cmd.CombinedOutput(); merr != nil {
		t.Fatalf("byo-iac: the out-of-band mutation failed (%v) — without it the drift assertion below would be vacuous\ncommand: %s\noutput: %s",
			merr, strings.Join(argv, " "), t2Truncate(string(out), 2000))
	}
	summary.MutationApplied = true
	t.Logf("byo-iac: mutated %q OUT OF BAND to %q via %s (no tofu involved)", target, newMarker, argv[0])

	// ── (5) THE POSTURE MUST FLIP — and on OUR resource, not on something unrelated. ──
	posture = byoIacDriftCheck(t, ctx, cp, p, snap, deployJobID, wait, "post-mutation")
	summary.DriftedCount = posture.Drifted
	summary.DriftedTypes = posture.types()
	if posture.InSync || posture.Drifted == 0 {
		t.Fatalf("byo-iac: DETECT_DRIFT still reports in_sync AFTER a real out-of-band change to %q — this is the drift detector failing, not a flaky probe. It is the single most important negative this leg exists to catch.", target)
	}
	summary.DriftedIsProbe = byoIacDriftedProbe(p.provider, summary.DriftedTypes)
	if !summary.DriftedIsProbe {
		t.Fatalf("byo-iac: the posture drifted (%d resource(s): %v) but NONE of them is this provider's probe resource %q — something else moved, and crediting it as the induced drift would be a false pass",
			posture.Drifted, summary.DriftedTypes, byoIacProbeResourceType[p.provider])
	}
	t.Logf("byo-iac: posture FLIPPED to drifted — %d resource(s) %v, including the probe resource", posture.Drifted, summary.DriftedTypes)

	// ── (6) HEAL: re-apply the SAME pinned commit. Detection without convergence is half a claim. ──
	healJobID := newUUID()
	if err := byoIacSeedJob(ctx, cp, healJobID, "DEPLOY", snap, p.owner); err != nil {
		t.Fatalf("byo-iac: seed the heal DEPLOY job: %v", err)
	}
	cp.AliasStateToJob(healJobID, deployJobID)
	healStatus, err := cp.WaitTerminal(ctx, healJobID, wait)
	if err != nil {
		t.Fatalf("byo-iac: waiting for the heal DEPLOY job: %v\n%s", err, jobFailureDump(ctx, cp, healJobID))
	}
	summary.HealStatus = healStatus
	if healStatus != "SUCCESS" {
		t.Fatalf("byo-iac: heal DEPLOY terminal status = %q, want SUCCESS\n%s", healStatus, jobFailureDump(ctx, cp, healJobID))
	}

	posture = byoIacDriftCheck(t, ctx, cp, p, snap, deployJobID, wait, "post-heal")
	if !posture.InSync || posture.Drifted != 0 {
		t.Fatalf("byo-iac: the environment did NOT heal — after re-applying the same pinned commit the posture is still drifted (in_sync=%t drifted=%d %v)",
			posture.InSync, posture.Drifted, posture.types())
	}
	summary.HealedInSync = true
	t.Log("byo-iac: healed — the same pinned commit re-converged the out-of-band change and the posture is in-sync again")

	// ── (7) DESTROY through a real job, and the state is CLEARED ⇒ nothing left to orphan, so
	//        detaching the BYO source is safe. ──
	destroyJobID := newUUID()
	if err := byoIacSeedJob(ctx, cp, destroyJobID, "DESTROY", snap, p.owner); err != nil {
		t.Fatalf("byo-iac: seed the DESTROY job: %v", err)
	}
	cp.AliasStateToJob(destroyJobID, deployJobID)
	destroyStatus, err := cp.WaitTerminal(ctx, destroyJobID, wait)
	if err != nil {
		t.Fatalf("byo-iac: waiting for the DESTROY job: %v\n%s", err, jobFailureDump(ctx, cp, destroyJobID))
	}
	summary.DestroyStatus = destroyStatus
	if destroyStatus != "SUCCESS" {
		t.Fatalf("byo-iac: DESTROY terminal status = %q, want SUCCESS\n%s", destroyStatus, jobFailureDump(ctx, cp, destroyJobID))
	}
	// OpenTofu's http backend rewrites an EMPTIED state on destroy rather than DELETE-ing it, so
	// the honest assertion is "a state object exists and manages nothing", not "no state object".
	postState := cp.StateSnapshot(deployJobID)
	if len(postState) == 0 {
		t.Fatal("byo-iac: the proxy holds no state object after destroy — expected an emptied state, not a missing one")
	}
	postCount, err := tfstateResourceCount(postState)
	if err != nil {
		t.Fatalf("byo-iac: parse the post-destroy proxy state: %v", err)
	}
	if postCount != 0 {
		t.Fatalf("byo-iac: the post-destroy proxy state still records %d managed resource instance(s) — destroy did not clear live infrastructure, so detaching the BYO source would orphan it", postCount)
	}
	summary.StateCleared = true

	t.Logf("byo-iac PROVEN on %s: pinned clone → gate (blocks the bad module, passes this one) → signed receipt over the customer's own plan → apply → state on Alethia's proxy → induced out-of-band change → posture flipped → healed → destroyed → state cleared", p.provider)
}

// byoIacResolvePinnedSHA resolves the module repo's ref to a full commit id with `git ls-remote`.
//
// The harness must do this itself: the T2 control plane seeds jobs by direct SQL, so nothing ever
// runs the console's attachIacSource / scanIacSource, which is where a real tenant's commit_sha
// comes from. Resolving it ONCE here and reusing it for every job reproduces the same property the
// scan writeback gives a tenant — one pinned commit for the whole lifecycle.
func byoIacResolvePinnedSHA(t *testing.T, ctx context.Context, repo, ref string) string {
	t.Helper()
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	out, err := exec.CommandContext(cctx, "git", "ls-remote", repo, ref).CombinedOutput()
	if err != nil {
		t.Fatalf("byo-iac: git ls-remote %s %s failed: %v\n%s", repo, ref, err, t2Truncate(string(out), 2000))
	}
	sha, perr := parseLsRemoteSHA(string(out), ref)
	if perr != nil {
		t.Fatalf("byo-iac: %v", perr)
	}
	return sha
}

// byoIacSeedJob enqueues one QUEUED job of the given type carrying the BYO config_snapshot. It
// mirrors seedT2DriftJob's INSERT shape: the `provider` column is left NULL so the atomic claim's
// provider filter passes, and owner MUST equal the SeedRunner owner or the self-runner claim never
// matches (#392) and the job sits QUEUED until the wait times out.
//
// jobType is a fixed, harness-chosen literal (never user input), and the three call sites pass
// only DEPLOY / DESTROY / DETECT_DRIFT — the enum values types.JobType already defines.
func byoIacSeedJob(ctx context.Context, cp *ControlPlane, jobID, jobType string, snap map[string]any, owner string) error {
	if strings.TrimSpace(owner) == "" {
		return fmt.Errorf("seed %s job: empty owner — the job would be unclaimable (the self-runner claim is org-scoped, #392)", jobType)
	}
	switch types.JobType(jobType) {
	case types.JobTypeDeploy, types.JobTypeDestroy, types.JobTypeDetectDrift:
	default:
		return fmt.Errorf("seed job: %q is not a job type this leg drives", jobType)
	}
	snapshot, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	_, err = cp.pool.Exec(ctx, `
		INSERT INTO public.jobs
		  (id, user_id, org_id, job_type, config_snapshot, status, provider)
		VALUES ($1, $2, $2, $3::public.provision_job_type, $4::jsonb, 'QUEUED', NULL)`,
		jobID, owner, jobType, string(snapshot))
	if err != nil {
		return fmt.Errorf("seed %s job: %w", jobType, err)
	}
	return nil
}

// byoIacPosture is the drift posture a DETECT_DRIFT job persisted, plus the drifted resource types
// the non-vacuity check needs.
type byoIacPosture struct {
	InSync  bool
	Drifted int
	Details []struct {
		Address string `json:"address"`
		Type    string `json:"type"`
		Kind    string `json:"kind"`
	}
}

// types returns the drifted resources' types, for the "it drifted on OUR resource" assertion.
func (p byoIacPosture) types() []string {
	out := make([]string, 0, len(p.Details))
	for _, d := range p.Details {
		out = append(out, d.Type)
	}
	return out
}

// byoIacDriftCheck seeds + drives ONE real DETECT_DRIFT job whose state slot is aliased onto the
// deploy's, so its refresh-only plan reconciles the deploy's REAL recorded state, and returns the
// posture the runner persisted. It asserts the mechanics (SUCCESS, a non-empty state read, a
// persisted posture) but NOT the verdict — the three call sites want different verdicts, and a
// helper that decided for them could not express "must be in_sync" and "must be drifted" both.
func byoIacDriftCheck(t *testing.T, ctx context.Context, cp *ControlPlane, p byoIacParams, snap map[string]any, deployJobID string, wait time.Duration, label string) byoIacPosture {
	t.Helper()

	driftJobID := newUUID()
	if err := byoIacSeedJob(ctx, cp, driftJobID, "DETECT_DRIFT", snap, p.owner); err != nil {
		t.Fatalf("byo-iac %s drift: seed DETECT_DRIFT job: %v", label, err)
	}
	cp.AliasStateToJob(driftJobID, deployJobID)

	status, err := cp.WaitTerminal(ctx, driftJobID, wait)
	if err != nil {
		t.Fatalf("byo-iac %s drift: waiting for DETECT_DRIFT: %v\n%s", label, err, jobFailureDump(ctx, cp, driftJobID))
	}
	if status != "SUCCESS" {
		t.Fatalf("byo-iac %s drift: DETECT_DRIFT terminal status = %q, want SUCCESS\n%s", label, status, jobFailureDump(ctx, cp, driftJobID))
	}
	// A refresh-only run that never READ non-empty state would report in_sync over an empty slot —
	// a pass that means nothing. Assert the read happened, for every one of the three checks.
	if reads := cp.StateReadsNonEmpty(driftJobID); reads == 0 {
		t.Fatalf("byo-iac %s drift: DETECT_DRIFT never read a non-empty state object — the posture would be vacuous", label)
	}

	_, metaRaw, err := cp.JobState(ctx, driftJobID)
	if err != nil {
		t.Fatalf("byo-iac %s drift: read drift metadata: %v", label, err)
	}
	var meta struct {
		DriftPosture *byoIacPosture `json:"drift_posture"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		t.Fatalf("byo-iac %s drift: decode drift execution_metadata: %v\nraw: %s", label, err, metaRaw)
	}
	if meta.DriftPosture == nil {
		t.Fatalf("byo-iac %s drift: no drift_posture in execution_metadata — the drift path did not persist a posture\nraw: %s", label, metaRaw)
	}
	t.Logf("byo-iac %s drift: job %s SUCCESS — in_sync=%t drifted=%d %v",
		label, driftJobID, meta.DriftPosture.InSync, meta.DriftPosture.Drifted, meta.DriftPosture.types())
	return *meta.DriftPosture
}

// byoIacAssertGateBlocks proves the fail-closed iacsafety gate has teeth: the SAME repo at the SAME
// pinned commit, but a module declaring a provider that is not on DefaultProviderAllowlist, must
// produce a FAILED job whose error names the allowlist finding.
//
// Without this negative, "the BYO deploy succeeded" is the only evidence about the gate — and a
// gate that passes everything produces exactly that evidence. The fixture provisions nothing (the
// scan runs before `tofu init`), so this costs no cloud time and leaves nothing to clean up.
func byoIacAssertGateBlocks(t *testing.T, ctx context.Context, cp *ControlPlane, p byoIacParams, src byoIacSource, wait time.Duration, s *ByoIacSummary) {
	t.Helper()

	blocked := src
	blocked.Path = byoIacBlockedPath(p.provider)
	if blocked.Path == src.Path {
		t.Fatalf("byo-iac gate: the blocked fixture path %q equals the real module path — the negative case would test the same module and prove nothing", blocked.Path)
	}
	snap := buildByoIacSnapshot(p.project, p.env+"-gate", p.provider, p.region, blocked)

	jobID := newUUID()
	if err := byoIacSeedJob(ctx, cp, jobID, "DEPLOY", snap, p.owner); err != nil {
		t.Fatalf("byo-iac gate: seed the blocked-module DEPLOY job: %v", err)
	}
	status, err := cp.WaitTerminal(ctx, jobID, wait)
	if err != nil {
		t.Fatalf("byo-iac gate: waiting for the blocked-module job: %v", err)
	}
	if status != "FAILED" {
		t.Fatalf("byo-iac gate: a module declaring a NON-allowlisted provider reached terminal status %q, want FAILED — the fail-closed static gate did not block it, so every 'the gate passed' claim in this leg is vacuous", status)
	}
	errMsg, _, err := cp.JobFailureDetail(ctx, jobID)
	if err != nil {
		t.Fatalf("byo-iac gate: read the blocked job's failure detail: %v", err)
	}
	// FAILED alone is not enough: the job could have failed for an unrelated reason (a bad clone, a
	// missing credential) and still look like a working gate. The error must name the gate.
	if !strings.Contains(errMsg, "static gate BLOCKED") {
		t.Fatalf("byo-iac gate: the blocked-module job FAILED, but not at the static gate — its error was %q. A failure for an unrelated reason is not evidence the gate works.", t2Truncate(errMsg, 1500))
	}
	if !strings.Contains(errMsg, "not in the allowlist") {
		t.Fatalf("byo-iac gate: the gate blocked, but not on the provider allowlist rule this fixture exercises — error was %q", t2Truncate(errMsg, 1500))
	}
	// The gate runs BEFORE init/plan/apply, so a blocked module must have written no state at all.
	if len(cp.StateSnapshot(jobID)) != 0 {
		t.Fatal("byo-iac gate: the blocked module wrote state to the proxy — the gate did not run before tofu did")
	}
	s.GateBlockedNonAllowlisted = true
	t.Logf("byo-iac gate: a module at the same pinned commit declaring a non-allowlisted provider was REFUSED before any tofu ran")
}

// byoIacDestroyInProcess is the fallback teardown: the REAL provisioner RunDestroy against the BYO
// source, reading state back from the control plane. It reconstructs the same ProjectConfig the
// deploy carried so the clone, the gate and the backend override all resolve identically.
//
// It is a no-op after a successful step (7) — destroy over an emptied state plans nothing.
func byoIacDestroyInProcess(ctx context.Context, p byoIacParams, src byoIacSource, jobID string, out interface{ Write([]byte) (int, error) }) error {
	vc := &types.ProjectConfig{
		ID:               "e2e-" + p.env + "-byoiac",
		ProjectName:      p.project,
		EnvironmentStage: types.EnvironmentStage(p.env),
		Region:           p.region,
		CloudAccountID:   t2AmbientAccountID(p.provider),
		IacSource: &types.ProjectIacSourceConfig{
			RepoURL:   src.RepoURL,
			Ref:       src.Ref,
			Path:      src.Path,
			CommitSHA: src.CommitSHA,
		},
	}
	return provisioner.RunDestroy(ctx, provisioner.DestroyParams{
		ProjectConfig: vc,
		Provider:      p.provider,
		StateBackend:  &cloud.HTTPBackendConfig{ConsoleURL: p.cpURL, JobID: jobID, Token: "e2e-byo-iac-teardown"},
		Stdout:        out,
		Stderr:        out,
	})
}
