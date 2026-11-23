// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// The runner verifies an apply against the reviewed plan's digest when the job carries one.
//
// A job that carries plan_sha256 names the plan it applies twice: by the plan job's id
// (plan_job_id) and by the SHA-256 of the plan file that job produced (the digest its evidence
// receipt records). The runner downloads the plan file, hashes it, and applies it only when the
// two digests are equal. Every other outcome is a refusal with a PlanBindingCode: there is no path
// from a job that carries a digest to an apply of a plan computed afterwards.
//
// A job that names a plan job must carry its digest: a named plan without one is refused too, and
// the apply never falls back to computing a plan of its own. A job that names no plan job is a
// system re-apply (auto-heal, the build chain) the console queues without a plan by design; it is
// not bound, and the runner plans it afresh.
//
// The rule reads the job, not who queued it, so it is the same for a job from the console, the
// CLI, an agent or git.

// PlanBindingCode names why an apply bound to a reviewed plan was refused. The values are stable:
// they are posted as `plan_binding_refusal` in the failed job's metadata.
type PlanBindingCode string

const (
	// PlanDigestMissing: the job names a plan job but carries no SHA-256 digest of it, so there is
	// nothing to compare the plan with.
	PlanDigestMissing PlanBindingCode = "plan_digest_missing"
	// PlanReferenceMissing: the job carries a plan digest but names no plan job to check it against.
	PlanReferenceMissing PlanBindingCode = "plan_reference_missing"
	// PlanJobUnavailable: the plan job could not be read.
	PlanJobUnavailable PlanBindingCode = "plan_job_unavailable"
	// PlanJobNotSucceeded: the plan job did not finish with SUCCESS.
	PlanJobNotSucceeded PlanBindingCode = "plan_job_not_succeeded"
	// PlanConfigurationChanged: the configuration differs from the one the plan was made from.
	PlanConfigurationChanged PlanBindingCode = "plan_configuration_changed"
	// PlanArtifactUnavailable: the stored plan file could not be fetched or read.
	PlanArtifactUnavailable PlanBindingCode = "plan_artifact_unavailable"
	// PlanDigestMismatch: the stored plan file is not the plan the job names.
	PlanDigestMismatch PlanBindingCode = "plan_digest_mismatch"
)

// planBindingMetadataKey is the terminal-metadata key a refusal's code is posted under.
const planBindingMetadataKey = "plan_binding_refusal"

// PlanBindingError is the refusal of an apply that could not be shown to run its reviewed plan.
// Message is written for the person reading the failed job; Err, when set, is the cause.
type PlanBindingError struct {
	Code      PlanBindingCode
	PlanJobID string
	Message   string
	Err       error
}

// Error returns the user-readable refusal, followed by its cause when there is one.
func (e *PlanBindingError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s (%v)", e.Message, e.Err)
	}
	return e.Message
}

// Unwrap returns the underlying cause, if any.
func (e *PlanBindingError) Unwrap() error { return e.Err }

// planBindingRefusal returns the refusal code err carries, if err is a plan-binding refusal.
func planBindingRefusal(err error) (PlanBindingCode, bool) {
	var pe *PlanBindingError
	if errors.As(err, &pe) {
		return pe.Code, true
	}
	return "", false
}

// refusePlan builds a PlanBindingError; every message ends by saying what to do next.
func refusePlan(code PlanBindingCode, planJobID string, cause error, format string, args ...any) *PlanBindingError {
	return &PlanBindingError{
		Code:      code,
		PlanJobID: planJobID,
		Message:   "Apply refused: " + fmt.Sprintf(format, args...) + " Nothing was changed. Run a new plan, review it, and apply that plan.",
		Err:       cause,
	}
}

// derefTrim returns the trimmed string s points at, or "" for nil.
func derefTrim(s *string) string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(*s)
}

// planBinding is the reviewed plan a job is bound to.
type planBinding struct {
	planJobID string
	digest    string // lowercase hex SHA-256 of the reviewed plan file
}

// jobPlanBinding reads the reviewed plan a job is bound to. bound is false only when the job names
// no plan job and carries no digest. A job that names a plan job must carry its digest, a job that
// carries a digest must name the plan job, and the digest must be well formed.
func jobPlanBinding(job *Job) (binding planBinding, bound bool, err error) {
	planJobID := derefTrim(job.PlanJobID)
	digest := strings.ToLower(derefTrim(job.PlanSHA256))
	switch {
	case digest == "" && planJobID == "":
		return planBinding{}, false, nil
	case digest == "":
		return planBinding{}, true, refusePlan(PlanDigestMissing, planJobID, nil,
			"this job names plan job %s but carries no digest of that plan, so it cannot be confirmed as the reviewed one.", planJobID)
	case planJobID == "":
		return planBinding{}, true, refusePlan(PlanReferenceMissing, "", nil,
			"this job carries a plan digest but names no plan job to check it against.")
	case !isSHA256Hex(digest):
		return planBinding{}, true, refusePlan(PlanDigestMissing, planJobID, nil,
			"the plan digest this job carries for plan job %s is not a SHA-256 digest.", planJobID)
	}
	return planBinding{planJobID: planJobID, digest: digest}, true, nil
}

// isSHA256Hex reports whether s is exactly 64 lowercase hex characters.
func isSHA256Hex(s string) bool {
	if len(s) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// checkPlanJob confirms the bound plan job can be read, finished with SUCCESS, and was made from
// the configuration this job applies (compared when both jobs record a configuration hash).
func (w *Runner) checkPlanJob(job *Job, b planBinding) error {
	planJob, err := w.api.GetJob(b.planJobID)
	if err != nil || planJob == nil {
		return refusePlan(PlanJobUnavailable, b.planJobID, err,
			"plan job %s could not be read, so its plan cannot be confirmed as the reviewed one.", b.planJobID)
	}
	if planJob.Status != "SUCCESS" {
		return refusePlan(PlanJobNotSucceeded, b.planJobID, nil,
			"plan job %s has status %s, expected SUCCESS.", b.planJobID, planJob.Status)
	}
	if job.ConfigurationHash != nil && planJob.ConfigurationHash != nil &&
		*job.ConfigurationHash != *planJob.ConfigurationHash {
		return refusePlan(PlanConfigurationChanged, b.planJobID, nil,
			"configuration changed since plan was generated (plan hash: %s, current: %s).",
			*planJob.ConfigurationHash, *job.ConfigurationHash)
	}
	return nil
}

// fetchReviewedPlan downloads the bound plan file into workDir and returns its path once its
// SHA-256 equals the digest the job carries. A file that cannot be fetched, cannot be read, is
// empty, or hashes to anything else is removed and refused.
func (w *Runner) fetchReviewedPlan(b planBinding, workDir string) (string, error) {
	dest := filepath.Join(workDir, "plan-apply.out")
	if err := w.api.DownloadPlanArtifact(b.planJobID, dest); err != nil {
		_ = os.Remove(dest)
		return "", refusePlan(PlanArtifactUnavailable, b.planJobID, err,
			"the saved plan from plan job %s could not be fetched.", b.planJobID)
	}
	got, err := fileSHA256(dest)
	if err != nil {
		_ = os.Remove(dest)
		return "", refusePlan(PlanArtifactUnavailable, b.planJobID, err,
			"the saved plan from plan job %s could not be read.", b.planJobID)
	}
	if got != b.digest {
		_ = os.Remove(dest)
		return "", refusePlan(PlanDigestMismatch, b.planJobID, nil,
			"the saved plan from plan job %s is not the plan that was reviewed (reviewed digest %s, saved plan digest %s).",
			b.planJobID, shortDigest(b.digest), shortDigest(got))
	}
	return dest, nil
}

// fileSHA256 returns the lowercase-hex SHA-256 of the file at path; an empty file is an error.
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", err
	}
	if n == 0 {
		return "", errors.New("the plan file is empty")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// shortDigest returns the first 8 characters of a digest, the prefix shown to people.
func shortDigest(d string) string {
	if len(d) <= 8 {
		return d
	}
	return d[:8]
}
