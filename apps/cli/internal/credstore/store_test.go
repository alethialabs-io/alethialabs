// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package credstore

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/zalando/go-keyring"
)

// TestKeyring_RoundTrip drives the three operations against the library's in-memory store, which
// stands in for the operating system's.
func TestKeyring_RoundTrip(t *testing.T) {
	keyring.MockInit()
	store := Keyring()
	const account = "console.example.test"

	if _, err := store.Get(account); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get on an empty store = %v, want ErrNotFound", err)
	}
	if err := store.Delete(account); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete on an empty store = %v, want ErrNotFound", err)
	}

	if err := store.Set(account, "first"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := store.Set(account, "second"); err != nil {
		t.Fatalf("Set over an existing entry: %v", err)
	}
	got, err := store.Get(account)
	if err != nil || got != "second" {
		t.Fatalf("Get = %q, %v; want the replaced secret", got, err)
	}

	if err := store.Delete(account); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := store.Get(account); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after Delete = %v, want ErrNotFound", err)
	}
}

// TestKeyring_FilesEntriesUnderTheService pins the name an entry is stored under, because an entry
// written under one name cannot be read back under another.
func TestKeyring_FilesEntriesUnderTheService(t *testing.T) {
	keyring.MockInit()
	if err := Keyring().Set("acct", "s3cret"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, err := keyring.Get("alethia", "acct")
	if err != nil || got != "s3cret" {
		t.Fatalf("the entry is not under service %q: %q, %v", Service, got, err)
	}
}

// TestKeyring_AnUnavailableStoreReportsItsOwnError pins that an error other than not-found reaches
// the caller unchanged, so the caller can tell a missing entry from a store it cannot use.
func TestKeyring_AnUnavailableStoreReportsItsOwnError(t *testing.T) {
	unavailable := errors.New("no keyring on this host")
	keyring.MockInitWithError(unavailable)
	t.Cleanup(keyring.MockInit)
	store := Keyring()

	if _, err := store.Get("acct"); !errors.Is(err, unavailable) || errors.Is(err, ErrNotFound) {
		t.Errorf("Get = %v, want the store's own error", err)
	}
	if err := store.Set("acct", "x"); !errors.Is(err, unavailable) {
		t.Errorf("Set = %v, want the store's own error", err)
	}
	if err := store.Delete("acct"); !errors.Is(err, unavailable) {
		t.Errorf("Delete = %v, want the store's own error", err)
	}
}

// fakeStore is a Store whose answers a test writes down.
type fakeStore struct {
	secret string
	err    error
	block  chan struct{}
}

// Get returns the fake's secret and error, after block is closed when one is set.
func (f fakeStore) Get(string) (string, error) {
	if f.block != nil {
		<-f.block
	}
	return f.secret, f.err
}

// Set returns the fake's error, after block is closed when one is set.
func (f fakeStore) Set(string, string) error {
	if f.block != nil {
		<-f.block
	}
	return f.err
}

// Delete returns the fake's error, after block is closed when one is set.
func (f fakeStore) Delete(string) error {
	if f.block != nil {
		<-f.block
	}
	return f.err
}

// TestBounded_PassesAnAnswerThrough pins that a store that answers in time is not changed by the
// deadline: the secret and the error arrive as the inner store returned them.
func TestBounded_PassesAnAnswerThrough(t *testing.T) {
	store := Bounded(fakeStore{secret: "s3cret"}, time.Second)
	if got, err := store.Get("acct"); err != nil || got != "s3cret" {
		t.Errorf("Get = %q, %v", got, err)
	}
	if err := store.Set("acct", "x"); err != nil {
		t.Errorf("Set = %v", err)
	}
	if err := store.Delete("acct"); err != nil {
		t.Errorf("Delete = %v", err)
	}

	missing := Bounded(fakeStore{err: ErrNotFound}, time.Second)
	if _, err := missing.Get("acct"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get = %v, want ErrNotFound", err)
	}
}

// TestBounded_AStoreThatNeverAnswersTimesOut pins the deadline on all three operations.
func TestBounded_AStoreThatNeverAnswersTimesOut(t *testing.T) {
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	store := Bounded(fakeStore{secret: "s3cret", block: block}, 10*time.Millisecond)

	if got, err := store.Get("acct"); !errors.Is(err, ErrTimeout) || got != "" {
		t.Errorf("Get = %q, %v; want ErrTimeout and no secret", got, err)
	}
	if err := store.Set("acct", "x"); !errors.Is(err, ErrTimeout) {
		t.Errorf("Set = %v, want ErrTimeout", err)
	}
	if err := store.Delete("acct"); !errors.Is(err, ErrTimeout) {
		t.Errorf("Delete = %v, want ErrTimeout", err)
	}
}

// TestScrub_RemovesTheSecretFromAnErrorsText pins that an error which quotes the secret is rewritten
// without it, and that one which does not is returned unchanged.
func TestScrub_RemovesTheSecretFromAnErrorsText(t *testing.T) {
	const secret = "tok-canary-123"
	got := scrub(errors.New("could not store "+secret+" in the store"), secret)
	if got == nil || strings.Contains(got.Error(), secret) {
		t.Errorf("the secret survived: %v", got)
	}
	if !strings.Contains(got.Error(), redacted) {
		t.Errorf("the error does not mark what was removed: %v", got)
	}

	plain := errors.New("no keyring on this host")
	if scrub(plain, secret) != plain {
		t.Error("an error without the secret must be returned as it came")
	}
	if scrub(nil, secret) != nil {
		t.Error("nil must stay nil")
	}
}

// TestUseMemoryAndUseUnavailable pins the two switches other packages' tests use: an empty working
// store, and one whose every operation fails with the given error.
func TestUseMemoryAndUseUnavailable(t *testing.T) {
	t.Cleanup(keyring.MockInit)

	UseMemory()
	if err := Keyring().Set("acct", "s3cret"); err != nil {
		t.Fatalf("Set on the in-memory store: %v", err)
	}
	UseMemory()
	if _, err := Keyring().Get("acct"); !errors.Is(err, ErrNotFound) {
		t.Errorf("UseMemory did not start empty: %v", err)
	}

	unavailable := errors.New("no keyring on this host")
	UseUnavailable(unavailable)
	if _, err := Keyring().Get("acct"); !errors.Is(err, unavailable) {
		t.Errorf("Get = %v, want the given error", err)
	}
}
