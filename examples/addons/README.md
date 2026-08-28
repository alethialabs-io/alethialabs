<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Worked add-on configurations

The marketplace hands you a **chart at its defaults**. For several add-ons that is not a running
system — velero installs with no backup location, ExternalDNS runs with no credential — and the gap
between *installed* and *working* is a configuration nobody hands you.

This directory is that configuration. One file per `<add-on>/<cloud>.yaml`, holding the values you
would type into the configure form, with the reasoning next to each one.

**Copy from these; do not point at them.** They are a reference library, not a template repository —
nothing in the product reads this directory at runtime. What it *is* read by is a test
(`apps/console/tests/lib/addons/examples.test.ts`) that parses every file against that add-on's
`configSchema`, so a worked configuration the console would reject cannot sit here looking correct.

## What a file may and may not contain

| | |
|---|---|
| ✅ | every non-secret knob the add-on needs to actually work |
| ✅ | a `# why` comment on any value that is not self-evident |
| ❌ | **secrets.** A `type: "secret"` field is stored encrypted-at-rest and never appears here. Where one is required the file says so in prose and leaves the key out |

That last rule is why some files are incomplete on purpose: a token pasted into a public repository is
a leaked token, whatever the file is called.

## File names

A file is named for the **thing whose values it carries** — usually a cloud, occasionally not:

- `aws.yaml`, `gcp.yaml`, `azure.yaml`, `hetzner.yaml` — one cloud's values.
- `default.yaml` — *"the same everywhere"*. Most knobs are cloud-independent, and duplicating them
  five times is how they drift apart.
- `cloudflare.yaml`, under `external-dns/` — named for the **DNS provider**, because Cloudflare is
  where a great many teams keep DNS regardless of which cloud runs their cluster. Copy it anywhere.

The file name and the `provider:` value are not the same thing and are not meant to be:
`external-dns/gcp.yaml` sets `provider: google`, because that is what the chart calls it. The file is
named for the cloud you are on; the value is named for the API being called.

## An absent file is a documented ceiling — and it has to stay falsifiable

An add-on that genuinely **cannot** work on a cloud has no file for it, and that add-on's own README
says why. That absence is a fact, not work somebody forgot.

It is also a claim, and a claim can be wrong. Velero on hetzner was the standing example here: its
`provider` knob is `aws | gcp | azure`, so — the argument went — there was no valid selection. The
argument was false. Those are the names of velero's **plugins**, not of clouds, and the `aws` plugin
speaks S3 to any store that does, Hetzner Object Storage included. What was actually missing was a
place to put the endpoint. `examples/addons/velero/hetzner.yaml` exists now.

So a ceiling recorded here must name **which layer** it is a ceiling in — the cloud, the chart, or
our own offer — because a ceiling in the third is a to-do wearing a fact's clothes.
