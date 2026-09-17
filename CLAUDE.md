# Asbury Package Tracker — session context

**Read `PROJECT_STATE.md` (Revision 2.0) first. It is the source of truth and
carries the full resumable state. Do not reconstruct anything from chat history.**

## Where things stand

- **Engine is live.** GitHub Actions in `dasbury-ui/asbury-package-tracker`,
  `track.yml`, 15-minute cadence, last runs green.
- **App is live** at https://dasbury-ui.github.io/asbury-package-tracker/ with
  8 real packages showing.

## Blocked — both must clear before the runner can read Gmail

1. Passkey challenge on `dasbury@asburycabinets.com`.
2. No Chrome extension site permission on `console.cloud.google.com`.

## Dormant capabilities

Company mailboxes, personal Gmail, UPS, FedEx, DHL, USPS.

## Accuracy rule — governs everything

Status comes **only** from carrier APIs. Email text never sets status. Anything
unconfirmable shows as `UNCONFIRMED` with a reason. Never a guess.

## Standing instruction from Derek

Workarounds were explicitly rejected. The temporary mail bridge was deleted on
his instruction. **Do not reintroduce one.** Clear the two blockers properly.
