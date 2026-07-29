# Personal data breach runbook

Security channel: `security@alethialabs.io`

Privacy channel: `privacy@alethialabs.io`

A personal data breach is an accidental or unlawful destruction, loss,
alteration, unauthorized disclosure of, or access to personal data. Treat a
credible report as an incident even before impact is confirmed.

## First response

1. Page the security and privacy owners. Start a restricted incident record
   with discovery time, reporter, systems, tenants, data, evidence and actions.
2. Preserve relevant logs and evidence without spreading personal data.
3. Contain: revoke sessions/tokens, isolate a workload, block a route, rotate a
   key, suspend a vendor integration, or disable a feature as appropriate.
4. Do not destroy evidence, speculate publicly, or notify affected people before
   the facts and notification risk are assessed.

## Assessment

Document:

- confidentiality, integrity and availability impact;
- data categories, approximate people and records;
- sensitivity, identifiability and encryption;
- affected customers, countries, children or vulnerable people;
- likely consequences such as identity theft, fraud, discrimination, loss of
  control, secret exposure or infrastructure compromise;
- containment, recovery and residual risk;
- whether Alethia is controller or processor.

If Alethia is a processor, notify the controller without undue delay with the
available facts and continue updates. If Alethia is controller, assess whether
the breach is likely to risk people’s rights and freedoms.

## Notification

- Notify the competent supervisory authority without undue delay and, where
  feasible, within 72 hours after becoming aware when the breach is likely to
  create risk. If later, document the reason.
- Notify affected people without undue delay when high risk is likely, using
  clear language and concrete protective steps, unless a lawful exception
  applies.
- A notification should describe the nature of the breach, privacy contact,
  likely consequences, and measures taken or proposed.
- Coordinate law enforcement, insurers, customers, vendors and other
  authorities as appropriate. Counsel should review notifications when
  available, but lack of counsel must not silently consume the deadline.

## Recovery and closure

Eradicate the cause, restore from known-good state, rotate affected credentials,
validate tenant isolation, replay deletion obligations after any restore, and
monitor for recurrence. Complete a blameless review with root cause, control
gaps, owners and deadlines.

Record every personal data breach, including those not notified, with facts,
effects, remedial action and the notification decision. Store the register and
evidence in the restricted legal/security drive, never in this repository.
