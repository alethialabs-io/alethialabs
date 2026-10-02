// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The runner's half of the kubeconfig mint channel (#5281's routes, #5292's contract):
//
//	GET  /api/jobs/:id/kubeconfig-mint — what to mint and whom to seal it to (no secret);
//	POST /api/jobs/:id/kubeconfig-mint — the ONE-SHOT result: ciphertext, or a fixed-vocabulary failure.
//
// It is a separate interface from JobAPI on purpose: every JobAPI fake in this package would otherwise
// have to grow two methods it has no use for, and a fake that does NOT implement it makes a
// MINT_KUBECONFIG job fail closed (executeMintKubeconfig), which is the safe default.

// kubeconfigMintAPI is the result channel a MINT_KUBECONFIG job needs. RunnerAPIClient implements it.
type kubeconfigMintAPI interface {
	// FetchKubeconfigMintSpec reads the spec of the mint this job serves.
	FetchKubeconfigMintSpec(jobID string) (types.RunnerKubeconfigMintSpec, error)
	// PostKubeconfigMintResult posts the sealed result (or the failure) and, on the console side,
	// completes the job in the same transaction.
	PostKubeconfigMintResult(jobID string, result types.RunnerKubeconfigMintResult) error
}

// The console's refusals, by status code (apps/console/app/api/jobs/[id]/kubeconfig-mint/route.ts).
// Each one ends the job cleanly: there is nothing to retry and nothing to mint.
var (
	// errMintWindowClosed is a 410: the mint's 10-minute poll window closed. No client is waiting.
	errMintWindowClosed = errors.New("the kubeconfig mint's window closed before the runner could deliver it; nothing was minted for it")
	// errMintSettled is a 409: the mint already has a result. Another post landed first.
	errMintSettled = errors.New("the kubeconfig mint already has a result")
	// errMintNotFound is a 404: the job or its mint row is gone (swept, or the job does not exist).
	errMintNotFound = errors.New("the kubeconfig mint for this job was not found")
)

// mintSpecMaxBytes bounds the spec answer: it is a handful of short fields.
const mintSpecMaxBytes = 16 << 10

// mintStatusError maps the console's refusal codes onto the sentinels above. A 403 is the job no
// longer being this runner's (not the owner, not executing, or a mint_id mismatch), which the
// dispatcher already knows how to treat: ErrJobNotOwned stops the job without a terminal post.
// Any other non-2xx is a plain error carrying only the code — never the body.
func mintStatusError(op string, code int) error {
	switch code {
	case http.StatusGone:
		return errMintWindowClosed
	case http.StatusConflict:
		return errMintSettled
	case http.StatusNotFound:
		return errMintNotFound
	case http.StatusForbidden:
		return fmt.Errorf("%s: %w", op, ErrJobNotOwned)
	default:
		return fmt.Errorf("%s returned status %d", op, code)
	}
}

// FetchKubeconfigMintSpec reads GET /api/jobs/:id/kubeconfig-mint and validates the spec before any
// mint work starts. The spec holds no secret (the client's PUBLIC key), but it is still decoded with
// a bound and never echoed into an error.
func (c *RunnerAPIClient) FetchKubeconfigMintSpec(jobID string) (types.RunnerKubeconfigMintSpec, error) {
	var spec types.RunnerKubeconfigMintSpec
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/jobs/%s/kubeconfig-mint", c.baseURL, jobID), nil)
	if err != nil {
		return spec, err
	}
	c.setRunnerHeaders(req)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return spec, fmt.Errorf("fetch kubeconfig mint spec request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return spec, mintStatusError("fetch kubeconfig mint spec", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, mintSpecMaxBytes)).Decode(&spec); err != nil {
		return spec, errors.New("the kubeconfig mint spec was not the expected JSON")
	}
	if err := spec.Validate(); err != nil {
		return spec, fmt.Errorf("the kubeconfig mint spec is invalid: %w", err)
	}
	return spec, nil
}

// PostKubeconfigMintResult posts the one-shot result. The body is the ciphertext or a fixed sentence,
// and it is validated before it leaves (types.RunnerKubeconfigMintResult.Validate): a ready result
// carries sealed only, a failed one a bounded reason only. Neither the body nor the answer is ever
// put into an error.
func (c *RunnerAPIClient) PostKubeconfigMintResult(jobID string, result types.RunnerKubeconfigMintResult) error {
	if err := result.Validate(); err != nil {
		return fmt.Errorf("refusing to post an invalid kubeconfig mint result: %w", err)
	}
	body, err := json.Marshal(result)
	if err != nil {
		return errors.New("could not encode the kubeconfig mint result")
	}
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/jobs/%s/kubeconfig-mint", c.baseURL, jobID), bytes.NewReader(body))
	if err != nil {
		return err
	}
	c.setRunnerHeaders(req)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("post kubeconfig mint result request failed: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, mintSpecMaxBytes))
	if resp.StatusCode != http.StatusOK {
		return mintStatusError("post kubeconfig mint result", resp.StatusCode)
	}
	return nil
}
