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
	"strings"
	"time"

	"github.com/zalando/go-keyring"
)

// Service is the name every alethia entry is filed under in the operating system's store.
const Service = "alethia"

// ErrNotFound is returned by Get and Delete when the store holds nothing for the account.
var ErrNotFound = errors.New("no credential is stored for this account")

// ErrTimeout is returned by a Bounded store when the operating system's store did not answer within
// the limit: a keychain waiting for an unlock dialog nobody will see, or a secret service that never
// replies.
var ErrTimeout = errors.New("the credential store did not answer in time")

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

// Set stores secret for account. The secret is never part of the error it returns.
func (keyringStore) Set(account, secret string) error {
	return scrub(translate(keyring.Set(Service, account, secret)), secret)
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

// redacted stands in for a secret in an error's text.
const redacted = "[redacted]"

// scrub returns err with every occurrence of secret removed from its text. An error that does not
// carry the secret is returned as it came, so errors.Is still recognises it.
func scrub(err error, secret string) error {
	if err == nil || secret == "" || !strings.Contains(err.Error(), secret) {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), secret, redacted))
}

// Bounded returns a Store that gives inner at most limit to answer each call, and returns ErrTimeout
// when it does not. The abandoned call is left to finish on its own; its result is discarded.
func Bounded(inner Store, limit time.Duration) Store {
	return boundedStore{inner: inner, limit: limit}
}

// boundedStore is Store with a deadline on every operation.
type boundedStore struct {
	inner Store
	limit time.Duration
}

// answer is what one store operation returned.
type answer struct {
	secret string
	err    error
}

// within runs op and returns its answer, or ErrTimeout once the limit has passed.
func (b boundedStore) within(op func() (string, error)) (string, error) {
	done := make(chan answer, 1)
	go func() {
		secret, err := op()
		done <- answer{secret: secret, err: err}
	}()
	timer := time.NewTimer(b.limit)
	defer timer.Stop()
	select {
	case got := <-done:
		return got.secret, got.err
	case <-timer.C:
		return "", ErrTimeout
	}
}

// Get returns the secret stored for account, or ErrTimeout.
func (b boundedStore) Get(account string) (string, error) {
	return b.within(func() (string, error) { return b.inner.Get(account) })
}

// Set stores secret for account, or returns ErrTimeout.
func (b boundedStore) Set(account, secret string) error {
	_, err := b.within(func() (string, error) { return "", b.inner.Set(account, secret) })
	return err
}

// Delete removes the secret stored for account, or returns ErrTimeout.
func (b boundedStore) Delete(account string) error {
	_, err := b.within(func() (string, error) { return "", b.inner.Delete(account) })
	return err
}
