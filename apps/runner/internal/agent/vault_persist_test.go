// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// noBackoff shrinks the retry pause for the duration of one test. The retry logic is what is under
// test, not the wall clock.
func noBackoff(t *testing.T) {
	t.Helper()
	prev := vaultPersistBackoff
	vaultPersistBackoff = 0
	t.Cleanup(func() { vaultPersistBackoff = prev })
}

func TestPersistVaultStateSurvivesTransientFailures(t *testing.T) {
	noBackoff(t)
	st := newMemState(nil)
	st.writeFailures = vaultPersistAttempts - 1 // fails four times, succeeds on the fifth

	if err := persistVaultState(context.Background(), st, map[string]string{vaultUnsealKeyField: "k"}); err != nil {
		t.Fatalf("persist should have succeeded on the last attempt: %v", err)
	}
	// The outcome alone would pass with a loop that writes once and swallows the error, so the
	// ATTEMPT COUNT is asserted too.
	if st.writeAttempts != vaultPersistAttempts {
		t.Errorf("writeAttempts = %d, want %d", st.writeAttempts, vaultPersistAttempts)
	}
	if st.data[vaultUnsealKeyField] != "k" {
		t.Errorf("the key was not stored: %v", st.data)
	}
}

func TestPersistVaultStateGivesUpAndSaysHowManyTimesItTried(t *testing.T) {
	noBackoff(t)
	st := newMemState(nil)
	st.writeErr = errors.New("forbidden")

	err := persistVaultState(context.Background(), st, map[string]string{vaultUnsealKeyField: "k"})
	if err == nil {
		t.Fatal("want an error after every attempt failed")
	}
	if st.writeAttempts != vaultPersistAttempts {
		t.Errorf("writeAttempts = %d, want %d — it must stop, and it must not stop early", st.writeAttempts, vaultPersistAttempts)
	}
	// "forbidden" and "forbidden (5 attempts)" point at different causes; the count is the part
	// that says RBAC never propagated rather than never existed. Built from the constant, so this
	// asserts the RENDERING and cannot fail merely because the number was tuned.
	want := strconv.Itoa(vaultPersistAttempts) + " attempts"
	if !strings.Contains(err.Error(), "forbidden") || !strings.Contains(err.Error(), want) {
		t.Errorf("error does not carry both the cause and %q: %v", want, err)
	}
}

// The number itself, pinned separately: a single attempt is not a retry, and the whole point of
// this file is that this one write does not get to fail once and lose the Vault.
func TestVaultPersistAttemptsIsMoreThanOne(t *testing.T) {
	if vaultPersistAttempts < 3 {
		t.Fatalf("vaultPersistAttempts = %d — too few for an API server that is briefly unavailable "+
			"or an RBAC binding that has not finished propagating", vaultPersistAttempts)
	}
}

func TestPersistVaultStateReportsTheWriteErrorWhenTheContextEnds(t *testing.T) {
	// A real backoff, and a context that dies during it.
	prev := vaultPersistBackoff
	vaultPersistBackoff = 50 * time.Millisecond
	t.Cleanup(func() { vaultPersistBackoff = prev })

	st := newMemState(nil)
	st.writeErr = errors.New("apiserver unavailable")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	err := persistVaultState(ctx, st, map[string]string{vaultUnsealKeyField: "k"})
	if err == nil {
		t.Fatal("want an error")
	}
	// The WRITE is what failed; the context merely stopped us asking again. Reporting
	// "context deadline exceeded" alone would send the reader to the Job's timeout instead of to
	// the API server that refused.
	if !strings.Contains(err.Error(), "apiserver unavailable") {
		t.Errorf("the write error was lost: %v", err)
	}
	if st.writeAttempts >= vaultPersistAttempts {
		t.Errorf("it kept retrying past the cancelled context: %d attempts", st.writeAttempts)
	}
}

// The retry is only worth anything if it is on the path that loses the key. This drives the whole
// bootstrap with a store that fails its first writes, and asserts Vault ends up UNSEALED — which
// cannot happen unless the key was captured.
func TestVaultBootstrapPersistsThroughATransientWriteFailure(t *testing.T) {
	noBackoff(t)
	fv := newFakeVault()
	st := newMemState(nil)
	st.writeFailures = 2

	err := vaultBootstrap(context.Background(), vaultOpts(), fv, st, func(context.Context, string) error { return nil })
	if err != nil {
		t.Fatalf("bootstrap failed despite a retryable write: %v", err)
	}
	if !slices.Contains(fv.calls, "unseal:"+fv.initKey) {
		t.Fatalf("Vault was never unsealed with the key init returned, so the key was not captured: %v", fv.calls)
	}
	if st.data[vaultUnsealKeyField] == "" {
		t.Errorf("no unseal key stored: %v", st.data)
	}
}

// The terminal state: Vault is initialised and this cluster holds no key. No retry reaches a
// different answer, and the message has to say so or a Job with backoffLimit 4 reads as slow.
func TestVaultBootstrapExplainsTheUnopenableVault(t *testing.T) {
	fv := newFakeVault()
	fv.initialized, fv.sealed = true, true
	st := newMemState(nil)
	opts := vaultOpts()

	err := vaultBootstrap(context.Background(), opts, fv, st, func(context.Context, string) error { return nil })
	if err == nil {
		t.Fatal("want an error: a sealed Vault with no key cannot be opened")
	}
	msg := err.Error()
	for _, want := range []string{"no unseal key", "no retry will change that", opts.StateNamespace, opts.StateSecret} {
		if !strings.Contains(msg, want) {
			t.Errorf("message does not carry %q:\n%s", want, msg)
		}
	}
	// And it must name a way out. An error that only says "cannot" leaves an operator with a
	// permanently broken add-on and no next step.
	if !strings.Contains(msg, "PVC") && !strings.Contains(msg, "storage") {
		t.Errorf("message names no remedy:\n%s", msg)
	}
}
