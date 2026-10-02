// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/kubeaccess"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The mint flow both `cluster kubeconfig` and `cluster token` run (#5284; design #5250, routes
// #5306, sealing #5292):
//
//  1. Generate a one-time X25519 key. Only its PUBLIC half leaves this process.
//  2. POST the request. The control plane checks exactly the requested tier's permission, queues a
//     MINT_KUBECONFIG job and answers 202 with the mint and its poll window.
//  3. Poll, backing off, until the mint is ready, failed or expired. A runner in the cluster's
//     network mints the credential and seals it to the public key; the console only ever holds
//     ciphertext, and serves a ready mint exactly once.
//  4. Open the ciphertext with the private key, binding it to this mint id and cluster id (the
//     HPKE AAD), so a sealed blob for another mint or another cluster does not open here.
//  5. Check the credential is the tier and shape that were asked for. No cloud may silently upgrade
//     a read-only request to admin, or downgrade an admin one.
//
// Nothing here prints, logs or wraps the credential: errors are built from statuses and fixed
// sentences, never from the plaintext or from a JSON decoder's view of it.

// kubeMintAPI is the part of *api.Client the mint flow uses.
type kubeMintAPI interface {
	RequestKubeconfigMint(clusterID string, req types.KubeconfigMintRequest) (*types.KubeconfigMintResponse, error)
	PollKubeconfigMint(clusterID, mintID string) (*types.KubeconfigMintPollResponse, error)
}

// kubeMintSpec is what to mint.
type kubeMintSpec struct {
	ClusterID  string
	Tier       types.KubeconfigMintTier
	Shape      types.KubeconfigMintShape
	TTLSeconds int
}

// kubeMinted is an opened, checked credential and whether the cluster's API endpoint is private.
type kubeMinted struct {
	Cred            types.KubeconfigMintCredential
	PrivateEndpoint bool
}

// The poll's backoff. The first poll comes quickly because a runner that is already idle mints in
// a second or two; the cap keeps a slow mint (a runner busy with a deploy) from being polled hard.
const (
	kubeMintPollFirst = 500 * time.Millisecond
	kubeMintPollMax   = 5 * time.Second
	// kubeMintPollCeiling bounds the whole wait on this machine's clock. The server ends a mint at
	// its own window (KUBECONFIG_MINT_REQUEST_WINDOW_SECONDS, 10 min) and then answers `expired`;
	// this is the backstop for a server that never does, a minute past that.
	kubeMintPollCeiling = 11 * time.Minute
)

// Seams for the poll loop, so a test drives every outcome without waiting on a real clock, and the
// key generator, whose failure arm is otherwise unreachable.
var (
	kubeMintSleep       = time.Sleep
	kubeNow             = time.Now
	kubeGenerateKey     = kubeaccess.GenerateClientKey
	errKubeMintExpired  = errors.New("the kubeconfig request expired before a runner completed it — check that a runner is online for this organization (`alethia runner list`), then try again")
	errKubeMintTimedOut = errors.New("timed out waiting for a runner to mint the kubeconfig — check that a runner is online for this organization (`alethia runner list`), then try again")
	// errKubeMintPoll marks a refusal of the POLL rather than of the request, whose statuses mean
	// different things: a 404 there is a mint already collected or swept, not a missing cluster.
	errKubeMintPoll = errors.New("polling the kubeconfig request failed")
)

// mintKubeCredential runs the whole flow for spec and returns the opened credential. Its errors
// are the control plane's (an *api.APIError the caller maps with kubeMintRefusal) or a sentence of
// its own; neither ever carries the credential.
func mintKubeCredential(c kubeMintAPI, spec kubeMintSpec) (*kubeMinted, error) {
	key, err := kubeGenerateKey()
	if err != nil {
		return nil, fmt.Errorf("could not generate the one-time key for the kubeconfig: %w", err)
	}
	req := types.KubeconfigMintRequest{
		Tier: spec.Tier, Shape: spec.Shape, TTLSeconds: spec.TTLSeconds, ClientPublicKey: key.PublicKey(),
	}
	if err := req.Validate(); err != nil {
		return nil, err
	}
	resp, err := c.RequestKubeconfigMint(spec.ClusterID, req)
	if err != nil {
		return nil, err
	}
	mint := resp.Mint
	// Mint-bind on the client side too: the mint we poll must be the one we asked for.
	if mint.ID == "" || mint.ClusterID != spec.ClusterID || mint.Tier != spec.Tier || mint.Shape != spec.Shape {
		return nil, errors.New("the control plane queued a different kubeconfig than was requested; refusing it")
	}

	deadline := kubeNow().Add(kubeMintPollCeiling)
	delay := kubeMintPollFirst
	for {
		kubeMintSleep(delay)
		poll, err := c.PollKubeconfigMint(spec.ClusterID, mint.ID)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", errKubeMintPoll, err)
		}
		switch poll.Status {
		case types.KubeconfigMintStatusPending:
			if !kubeNow().Before(deadline) {
				return nil, errKubeMintTimedOut
			}
			delay = min(delay*2, kubeMintPollMax)
		case types.KubeconfigMintStatusReady:
			return openKubeMint(key, mint.ID, spec, poll)
		case types.KubeconfigMintStatusFailed:
			// The reason is one of the console's fixed sentences (lib/kubeconfig-mint/reasons.ts),
			// never a cloud SDK's error text, so it is safe to show as it is.
			return nil, fmt.Errorf("the runner could not mint the kubeconfig: %s", poll.Reason)
		case types.KubeconfigMintStatusExpired:
			return nil, errKubeMintExpired
		}
	}
}

// openKubeMint opens a ready poll's ciphertext and checks what came out.
func openKubeMint(key *kubeaccess.ClientKey, mintID string, spec kubeMintSpec, poll *types.KubeconfigMintPollResponse) (*kubeMinted, error) {
	plain, err := key.Open(poll.Sealed, mintID, spec.ClusterID)
	if err != nil {
		return nil, fmt.Errorf("the sealed kubeconfig did not open with this request's key: %w", err)
	}
	var cred types.KubeconfigMintCredential
	dec := json.NewDecoder(bytes.NewReader(plain))
	dec.DisallowUnknownFields()
	// The decoder's error is NOT wrapped: it describes the plaintext, which is a credential.
	if dec.Decode(&cred) != nil {
		return nil, errors.New("the opened kubeconfig is not a credential this CLI understands")
	}
	if err := cred.Validate(); err != nil {
		return nil, fmt.Errorf("the opened kubeconfig is malformed: %w", err)
	}
	if cred.Tier != spec.Tier || cred.Shape != spec.Shape {
		return nil, fmt.Errorf("the runner returned a %s %s credential for a %s %s request; refusing it",
			cred.Tier, cred.Shape, spec.Tier, spec.Shape)
	}
	if !cred.ExpiresAt.After(kubeNow()) {
		return nil, errors.New("the minted credential had already expired when it arrived; check this machine's clock, then try again")
	}
	return &kubeMinted{Cred: cred, PrivateEndpoint: poll.PrivateEndpoint != nil && *poll.PrivateEndpoint}, nil
}

// kubeMintStatus returns the HTTP status of a control-plane refusal, or 0 when err is not one.
func kubeMintStatus(err error) int {
	var apiErr *api.APIError
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode
	}
	return 0
}

// kubeMintRefusal turns a control-plane refusal into the sentence a person acts on. The server's
// own message is kept where it is the explanation (409, 422, 402); the status decides the next
// step. Any other error passes through unchanged.
func kubeMintRefusal(err error, tier types.KubeconfigMintTier) error {
	var apiErr *api.APIError
	if !errors.As(err, &apiErr) {
		return err
	}
	if errors.Is(err, errKubeMintPoll) {
		switch apiErr.StatusCode {
		case http.StatusNotFound:
			return errors.New("the kubeconfig request is gone (already collected, or expired and swept) — run the command again")
		case http.StatusForbidden:
			return errors.New("your role no longer allows collecting this kubeconfig (it changed after the request)")
		}
		return err
	}
	switch apiErr.StatusCode {
	case http.StatusUnauthorized:
		return errors.New("your session is not valid — run `alethia login`, then try again")
	case http.StatusPaymentRequired:
		return fmt.Errorf("your organization's plan does not allow another kubeconfig right now: %s (see `alethia usage`)", apiErr.Message)
	case http.StatusForbidden:
		if tier == types.KubeconfigMintTierAdmin {
			return errors.New("your role cannot mint an admin kubeconfig for this cluster (owners and admins can); drop --admin for read-only access")
		}
		return errors.New("your role cannot mint a kubeconfig for this cluster (owners, admins and operators can)")
	case http.StatusNotFound:
		return errors.New("the cluster was not found in the active organization (`alethia org switch`, or pass --org)")
	case http.StatusConflict:
		return fmt.Errorf("%s — deploy the environment first (`alethia project apply`)", apiErr.Message)
	case http.StatusUnprocessableEntity:
		return errors.New(apiErr.Message)
	case http.StatusTooManyRequests:
		wait := "a few minutes"
		if apiErr.RetryAfter > 0 {
			wait = format.Duration(apiErr.RetryAfter)
		}
		return fmt.Errorf("too many kubeconfig requests — try again in %s", wait)
	}
	return err
}
