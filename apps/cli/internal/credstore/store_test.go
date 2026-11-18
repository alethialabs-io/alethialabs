// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package credstore

import (
	"errors"
	"testing"

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
