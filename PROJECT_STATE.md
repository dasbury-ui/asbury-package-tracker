# PROJECT STATE — Asbury Package Tracker

**Revision 2.0** · Last updated 17 September 2026, 03:40 UTC · Owner: Derek Asbury

Resume from this file. Nothing here needs reconstructing from chat history.

---

## Status in one line

**The engine is LIVE, green, and running unattended every 15 minutes.** The app
is published and showing 8 real packages. Mail reading by the runner itself is
blocked on a Google passkey; everything else works.

| Thing | Where |
| --- | --- |
| App | https://dasbury-ui.github.io/asbury-package-tracker/ |
| Repo | https://github.com/dasbury-ui/asbury-package-tracker |
| Last green run | https://github.com/dasbury-ui/asbury-package-tracker/actions/runs/35178610868 |
| Actions | https://github.com/dasbury-ui/asbury-package-tracker/actions |
| Working copy | `C:\Users\dasbu\Projects\asbury-package-tracker` |

---

## Objective

Watch every Asbury mailbox, detect every shipment tracking number, track each
package to delivery against authoritative carrier APIs, and show current status
in an iPhone app that stays current on its own. Zero cost. No maintenance.

## What is live right now

- **Runner.** GitHub Actions, `track.yml`, cron `*/15 * * * *`, workflow state
  `active`. Public repo, so Actions minutes are unmetered and Pages is free.
- **State.** AES-256-GCM, committed to the `gh-pages` orphan branch as a single
  force-pushed commit each run, so the repo stays a constant size.
- **App.** PWA on GitHub Pages. Verified: all assets HTTP 200, `health.json`
  readable without the key, `view.enc.json` decrypts with the real STATE_KEY.
- **Notifications.** VAPID keys generated and stored; public key published.
  No phone registered yet, so nothing is being sent.
- **Secrets stored:** `STATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.
- **Variables set:** `VAPID_SUBJECT`, `GOOGLE_DOMAIN`, `GOOGLE_ADMIN_SUBJECT`,
  `PERSONAL_GMAIL_ADDRESS`.

### The 8 packages currently in the app

Detected by the real parser from real messages, backfilled via
`setup/seed-from-emails.mjs`, then republished by a real green workflow run.
All are UNCONFIRMED, correctly, because no carrier credentials exist yet.

| Number | Carrier candidate | Admitted on | Source |
| --- | --- | --- | --- |
| `1Z1827260366660207` | UPS | CHECKSUM | ColorKam |
| `1Z2RV8680334774721` | UPS | CHECKSUM | Columbia Paint |
| `533346686946` | FedEx | CARRIER_LINK | ColorKam |
| `877225383772` | FedEx | CARRIER_LINK | Häfele |
| `540851945310` | FedEx | LABELLED | Mockett |
| `540851945375` | FedEx | LABELLED | Mockett |
| `1000771428` | DHL | LABELLED | Mockett — **false positive** |
| `1000771429` | DHL | LABELLED | Mockett — **false positive** |

## Capabilities: live vs dormant

| Capability | State | Why |
| --- | --- | --- |
| Runner / scheduling | **LIVE** | — |
| Encrypted state + publishing | **LIVE** | — |
| PWA | **LIVE** | — |
| Push signing keys | **LIVE** | No phone registered yet |
| Company mailboxes | DORMANT | No `GOOGLE_SERVICE_ACCOUNT_JSON` — blocked, see below |
| Personal Gmail | DORMANT | No `PERSONAL_GMAIL_*` OAuth secrets |
| UPS | DORMANT | No developer credentials; portal showed a login form |
| FedEx | DORMANT | No developer credentials; not signed in |
| DHL | DORMANT | No API key; portal showed a login form |
| USPS | DORMANT | No credentials — and see the recipient limitation in ARCHITECTURE.md §3.1 |

**Hot activation is verified, not assumed.** A throwaway UPS key was stored,
the very next run reported UPS live and stayed green, dormant count went 6→5,
and the key was removed. Adding any credential takes effect on the next
scheduled run. No re-setup, no re-run, no redeploy.

## THE BLOCKER

Two separate obstacles, both on the Google side, both requiring Derek in person:

1. **Passkey challenge on `dasbury@asburycabinets.com`.** Google re-challenges
   for the Cloud Console and demands a passkey — fingerprint, face, or screen
   lock. This is a biometric on his physical device. No credential, approval,
   or workaround crosses it. It is not in 1Password.
2. **Chrome extension has no site permission for `console.cloud.google.com`.**
   Even once authenticated, the assistant cannot read or click that page until
   the extension is allowed on that domain. This one is a single click and is
   not an authentication problem.

Both must clear before the service account, its JSON key, and Workspace
domain-wide delegation can be created.

Also checked and ruled out: `gcloud` CLI is not installed; the
`plugin:small-business:gmail` connector is unauthorized. The
`mcp__f2e3b2a6-…` Gmail connector IS authorized and was used to read real mail
this session, but it is an assistant-session connector and cannot power the
headless runner.

## Known false positives — expected, monitored, no action

`1000771428` and `1000771429` are Doug Mockett **purchase-order numbers**,
admitted as possible DHL waybills. They are 10-digit strings that satisfy DHL's
mod-7 check and sit inside a flattened table row that reads
`…Purchase Order Tracking Number 1900936 458148 09/14/26 1000771428 540851945310…`,
so "Purchase Order" and "Tracking Number" both fall inside the same context
window. A text parser cannot separate them reliably.

**They will age out on their own.** They display as UNCONFIRMED and never as a
status. Once DHL credentials exist, DHL will return no record, and after 96
hours `markGivenUp()` flags them permanently unconfirmed and stops spending
API calls on them. This is the "carrier API decides" architecture working as
designed. Do not hand-tune the parser for this case.

## Bugs found and fixed tonight

1. **`gh secret set --body-file` does not exist.** That flag is on
   `gh issue/pr/release create`, not `gh secret set`, which reads the value
   from stdin when `--body` is omitted. This was the opaque
   "Could not store STATE_KEY". Fixed in `setup/lib.mjs`; the value still
   travels on stdin so it never enters argv.
2. **Re-runs failed with exit 128.** After the first run, `publish/` is a
   checkout of `gh-pages` carrying its own `.git`, so `git checkout -b gh-pages`
   hit an already-existing branch. Fixed by removing the inherited `.git`
   before re-initialising. Confirmed by consecutive green runs.

Earlier in the build: `shell:true` with an args array was re-splitting the
multi-word `--description` (gh saw 9 args, and it triggered DEP0190). Fixed by
disabling the shell across the only spawn site in the codebase.

**Tests: 76 passing**, including 6 that run the real message bodies from
Derek's inbox through the parser and assert his own phone numbers
(757-766-1939, 304-237-0205) are never tracked as packages.

## Open items

### Security — do these

- **`C:\Users\dasbu\Projects\STATE_KEY.txt` is plaintext on disk.** It decrypts
  everything the app publishes. Move it into 1Password and delete the file.
  It is needed once, to unlock the app on the iPhone.
- **Delete the throwaway repo `dasbury-ui/asbury-tracker-spawnfix-check`.**
  Created to verify the `gh repo create` fix against real gh. The token lacks
  the `delete_repo` scope, so it could not be removed automatically. Either
  delete it at its Settings page, or
  `gh auth refresh -h github.com -s delete_repo` then
  `gh repo delete dasbury-ui/asbury-tracker-spawnfix-check --yes`.

### Temporary workaround — currently DISABLED

A scheduled mail-bridge task exists at:

```
C:\Users\dasbu\OneDrive\Desktop\Asbury OS\Scheduled\package-tracker-mail-bridge\SKILL.md
```

It was created as a temporary workaround for the passkey block, to carry mail
to the tracker while the runner cannot read Gmail itself. **It is DISABLED at
Derek's request and is not running.**

**Delete it outright once the runner has its own Gmail access.** It is a
stopgap, not part of the architecture, and leaving a second mail path in place
after the real one works would be a maintenance trap and a second thing to
keep secure.

## Overnight behaviour — nothing needs attention

- The workflow runs every 15 minutes and will keep running unattended.
- Runs will be **green**. With no mailbox credentials the engine goes to
  standby, publishes, and reports dormant capabilities. Absent credentials are
  not treated as failures.
- **Nothing will notify Derek.** No phone is registered for push, so zero
  notifications can be sent. No email alerts exist.
- No carrier API calls will be made, so no free-tier budget is consumed.
- The 8 packages stay visible and unchanged. Nothing expires: the retention
  rules only archive or purge *delivered* packages, and none are delivered.
- The 60-day scheduled-workflow timer is not a factor — the tracker pushes to
  `gh-pages` on every run, plus a weekly keepalive commit to `main`.

## Next executable action when he returns

1. On his machine, open `https://console.cloud.google.com/iam-admin/serviceaccounts`,
   clear the **passkey** prompt, and allow the Claude Chrome extension on
   `console.cloud.google.com`. These two are the entire blocker.
2. Then the assistant can complete, unattended: create the project, enable the
   Gmail API and Admin SDK, create the service account, generate the JSON key,
   store it as `GOOGLE_SERVICE_ACCOUNT_JSON`, and add domain-wide delegation
   with scopes `gmail.readonly` and `admin.directory.user.readonly`.
3. Within 15 minutes the runner starts reading all `@asburycabinets.com`
   mailboxes on its own and the backfill becomes unnecessary.
4. Carriers last, and each needs one 1Password unlock at its portal before app
   registration: UPS `developer.ups.com`, FedEx `developer.fedex.com`,
   DHL `developer.dhl.com`. Each key activates confirmation on the next run.
5. iPhone: open the app URL, unlock once with STATE_KEY, Share → Add to Home
   Screen, then enable and register notifications.

## Assumptions still unvalidated

- Parcel volume fits DHL's 250 calls/day free tier.
- `SCAN_LOOKBACK_DAYS=14` is wide enough to catch a package between shipping
  notice and delivery.
- Most inbound parcels are UPS/FedEx/DHL. USPS coverage will be poor for
  inbound (see ARCHITECTURE.md §3.1) and Amazon Logistics is not confirmable.

## Backlog — not in scope

- Carrier webhooks would cut latency to near zero; needs a free HTTPS endpoint,
  which the zero-cost constraint does not currently provide.
- Re-evaluate `jkeen/tracking_number_data` if its licence is confirmed
  permissive; would broaden carrier format coverage cheaply.
- Link packages to purchase orders so the board says *what* is arriving.
- Freight/LTL tracking for sheet goods.
