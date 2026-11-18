// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package credstore is the CLI's door to the operating system's credential store: Keychain on
// macOS, the Secret Service on Linux, Credential Manager on Windows.
//
// It is deliberately thin. Store is the interface the rest of the CLI depends on, and Keyring is
// its one production implementation, so the keyring library is imported in this file and nowhere
// else. What is stored under which account, the order credentials are resolved in, and what
// happens when no keyring is available are decided by the callers.
package credstore

import (
	"errors"

	"github.com/zalando/go-keyring"
)

// Service is the name every alethia entry is filed under in the operating system's store.
const Service = "alethia"

// ErrNotFound is returned by Get and Delete when the store holds nothing for the account.
var ErrNotFound = errors.New("no credential is stored for this account")

// Store keeps one secret per account.
type Store interface {
	// Get returns the secret stored for account, or ErrNotFound.
	Get(account string) (string, error)
	// Set stores secret for account, replacing what was there.
	Set(account, secret string) error
	// Delete removes the secret stored for account, or returns ErrNotFound.
	Delete(account string) error
}

// Keyring returns the Store backed by the operating system's credential store.
func Keyring() Store { return keyringStore{} }

// keyringStore is Store over the keyring library, filing every entry under Service.
type keyringStore struct{}

// Get returns the secret stored for account.
func (keyringStore) Get(account string) (string, error) {
	secret, err := keyring.Get(Service, account)
	return secret, translate(err)
}

// Set stores secret for account.
func (keyringStore) Set(account, secret string) error {
	return translate(keyring.Set(Service, account, secret))
}

// Delete removes the secret stored for account.
func (keyringStore) Delete(account string) error {
	return translate(keyring.Delete(Service, account))
}

// translate maps the library's not-found error onto ErrNotFound, so a caller never has to import
// the library to recognise it. Every other error is returned as it came.
func translate(err error) error {
	if errors.Is(err, keyring.ErrNotFound) {
		return ErrNotFound
	}
	return err
}
