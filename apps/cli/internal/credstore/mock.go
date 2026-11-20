// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package credstore

import "github.com/zalando/go-keyring"

// The two switches below point Keyring at the keyring library's own in-memory provider for the rest
// of the process. They exist for tests in other packages, which must never read or write the
// credential store of the machine they run on and must not import the library to avoid it.

// UseMemory replaces the operating system's store with an empty in-memory one.
func UseMemory() { keyring.MockInit() }

// UseUnavailable replaces the operating system's store with one whose every operation fails with
// err, which is how a host without a credential store behaves.
func UseUnavailable(err error) { keyring.MockInitWithError(err) }
