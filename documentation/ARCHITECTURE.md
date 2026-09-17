# Architecture

**Revision 1.0** — initial issue, 16 September 2026
**System:** Asbury Package Tracker
**Owner:** Derek Asbury

---

## 1. The one job

Watch every Asbury mailbox, detect every shipment tracking number, track each
package until delivery against an authoritative carrier source, and show
current status on an iPhone. Nothing else.

## 2. Accuracy model

This is the part everything else serves.

### 2.1 Three gates before anything is shown

```
  email text ──▶ [1] admission ──▶ [2] carrier probe ──▶ [3] status mapping ──▶ phone
                      │                    │                      │
                 checksum /          authoritative API      structured code
                 carrier link          response only          only, never
                 / label                                     free text
```

**Gate 1 — admission.** A candidate string is admitted for lookup only if:

| Basis | Condition |
| --- | --- |
| `CHECKSUM` | Its check digit verifies against a **self-identifying** format — one with a real prefix (1Z, 94/95, 96, TBA, S10 letters) |
| `CARRIER_LINK` | It was lifted out of a carrier's own tracking URL |
| `LABELLED` | It sits within 60 characters of a tracking label *and* matches a carrier-specific shape |

Anything else is rejected and logged with a reason. A string that looks like a
tracking number but fails its checksum is rejected, not tracked.

**Weak checksums do not stand alone.** DHL Express waybills are "any 10–11
digits divisible by 7" and FedEx Express is "any 12 digits passing mod 11".
Roughly one phone number in seven satisfies the DHL rule. Those formats are
marked `requiresContext`, so a passing checksum is not enough on its own —
they need a carrier link or a tracking label too. Without that rule, a phone
number in a signature block becomes a tracked "DHL package". Rejections of
this kind are logged as `WEAK_CHECKSUM_NO_CONTEXT`.

**Gate 2 — carrier confirmation.** Admission is not tracking. Candidate
carriers are probed in order, and the package's carrier is `unknown` until one
of them returns a real record. Only then is the carrier pinned.

**Gate 3 — status mapping.** Stage comes from the carrier's own structured
status code, mapped through an explicit table. An unmapped code yields
`UNKNOWN` and the carrier's wording is passed through verbatim rather than
guessed at. `DELIVERED` is reachable from exactly one place: a carrier status
code that means delivered.

### 2.2 Confidence is a first-class field

Every package carries `confidence`, which is either `API_CONFIRMED` or
`UNCONFIRMED`. The app has no code path that renders an `UNCONFIRMED` package
as a status. It renders the reason instead, in plain English, with a link to
check by hand.

### 2.3 What happens when a lookup fails

A previously confirmed status is **not** discarded because one lookup failed.
The last authoritative answer stands, tagged with when it was obtained, and
the app shows its age. Revoking a true "delivered" because of a transient HTTP
500 would be less accurate, not more.

### 2.4 When the checksum and the carrier disagree

The carrier wins — it is the authoritative source; our arithmetic is not. The
disagreement is logged so the algorithm can be corrected.

## 3. Carrier reality, verified September 2026

| Carrier | Free authoritative API | Notes |
| --- | --- | --- |
| UPS | Yes | OAuth client credentials, free developer account |
| FedEx | Yes | OAuth; 100k Track requests/day, 30 numbers per call |
| DHL | Yes | API key; **250 calls/day**, 1 call per 5s — the binding constraint |
| USPS | **Effectively no** | See below |
| Amazon Logistics | No | No public API for TBA numbers |
| OnTrac / LaserShip | No | No free public API |

### 3.1 The USPS problem, stated plainly

On **1 April 2026** USPS tied tracking-API access to the Mailer ID embedded in
the package barcode. Free access goes to the *shipper* who owns that MID, and
to platforms the shipper authorises. A recipient looking up a parcel a
supplier sent them falls into "Service Providers and Others", which is **paid**
and needs an Enterprise Payment System account plus a signed IP agreement.

Source: <https://www.usps.com/business/api-access.htm>

Asbury receives far more than it ships, so most USPS parcels have **no
zero-cost authoritative source**. The client is still implemented and still
attempted on every USPS candidate, because Derek may own the MID on parcels he
ships himself, and because the API's response — not our assumption — should
decide. When USPS declines, the package is shown as UNCONFIRMED with reason
`USPS_RECIPIENT_NOT_AUTHORISED` and a link.

This was not designed around. It was discovered during research and reported.

### 3.2 Staying inside the free tiers

A per-carrier daily budget is persisted in state (`src/budget.mjs`). DHL is
capped at 200 of its 250 free calls. Polling is adaptive:

| Package state | Re-check every |
| --- | --- |
| Out for delivery | 15 minutes |
| Exception | 1 hour |
| In transit / pre-transit | 2 hours |
| Unconfirmed | Each run, backing off 20 min per consecutive failure |
| Delivered | Never again |

Unconfirmable packages are given up on after 96 hours: they stay visible,
permanently marked, and stop costing calls.

## 4. Runtime

```
GitHub Actions (cron */15)          Public repo, unmetered minutes
        │
        ├─ Gmail API (read-only)    Workspace service account, domain-wide
        │                           delegation; mailboxes discovered via
        │                           Admin SDK so new ones appear on their own.
        │                           Personal Gmail via OAuth refresh token.
        │
        ├─ Carrier APIs             Authoritative status
        │
        └─ force-push ▶ gh-pages    Encrypted state + the app
                            │
                       GitHub Pages ──▶ iPhone PWA ──▶ Web Push
```

### 4.1 Why the repository is public

GitHub Pages and unmetered Actions minutes are both free only on public
repositories. A private repo on the free plan gets 2,000 Actions minutes a
month, which a 15-minute schedule exceeds, and no Pages at all.

So the repository is public and **the data is encrypted instead**. Every file
containing Asbury information is AES-256-GCM ciphertext before it is
committed. The key lives in GitHub Actions secrets and in `localStorage` on
Derek's phone, and nowhere else. Code is public; data is not readable.

One file is deliberately plaintext: `data/health.json`. It holds run
timestamps and counts and no business data, so the phone can say "this feed is
stale" before it has the key.

### 4.2 Why state lives on a force-pushed orphan branch

At 96 runs a day, committing state normally would add ~35,000 commits and
several gigabytes a year. `gh-pages` is rewritten as a single orphan commit
each run, so the repository stays a constant size forever. The cost is no git
history for state, which is covered by the weekly backup artifact.

### 4.3 The 60-day scheduled-workflow rule

GitHub disables scheduled workflows on a public repository after 60 days with
no repository activity. Two defences: the tracker pushes to `gh-pages` on
every run, and a weekly workflow writes a dated `.keepalive` line to `main`
even if the tracker has been failing the whole time.

### 4.4 Scheduling honesty

GitHub delays scheduled runs under load and does not guarantee punctuality.
A 20–30 minute gap is normal. The app therefore shows the true age of the last
run rather than implying it is always current, and marks the feed STALE after
45 minutes.

## 5. Notifications

Web Push with VAPID, sent directly from the Action to Apple's push service.
Payload encryption is RFC 8291 `aes128gcm`, implemented in `src/crypto.mjs`
and verified against the RFC's published test vector in the test suite.

iOS only allows Web Push for a PWA added to the Home Screen (iOS 16.4+, still
true on iOS 26). Registration has an awkward step because there is no free
server to receive the subscription: the app encrypts it with the state key and
opens a pre-filled GitHub issue, which a workflow consumes and closes. The
issue body is ciphertext, and the workflow ignores issues from anyone but the
repository owner.

## 6. Dependencies

**None.** No npm packages, in the tracker or the app. Everything uses Node's
built-in `fetch`, `crypto` and `zlib`. This removes the supply-chain surface
entirely, removes install time from every run, and means nothing can break
because an upstream package changed.

`jkeen/tracking_number_data` was evaluated as a reuse candidate for the
checksum definitions — it is well maintained and widely ported. It was **not**
adopted because the licence could not be verified from the repository at the
time of the build, and the operating contract requires a verified licence
before adoption. The algorithms implemented here are published barcode
standards (UPU S10, GS1/USS Code 128 mod-10, UPS mod-10 alphanumeric) written
from specification and unit-tested against known vectors plus round-trip
property tests. If the licence is later confirmed permissive, adopting that
data set would broaden carrier coverage cheaply and is recorded in the backlog.

## 7. Security and retention

- Gmail scope is `gmail.readonly`. The system cannot send, delete or modify mail.
- Secrets are only ever in GitHub Actions secrets; the setup wizard pipes them
  over stdin and never writes them to disk or passes them as arguments.
- Logs are redacted, and tracking numbers are masked in public run logs.
- Delivered packages are archived after 14 days and **deleted after 30**,
  which satisfies DHL's developer terms requiring deletion 30 days after
  delivery. Applied to all carriers.
- DHL's required attribution is carried on DHL-sourced records and displayed.

## 8. Known limits

1. USPS inbound parcels cannot be confirmed for free (§3.1).
2. Amazon Logistics and OnTrac have no free API; those packages are detected
   and shown as UNCONFIRMED with a link.
3. DHL's 250 calls/day caps how many DHL packages can be watched closely.
4. Scheduled runs are best-effort, not punctual (§4.4).
5. Freight carriers (LTL, common carrier) are out of scope. Cabinet hardware
   arrives by parcel; lumber and sheet goods do not, and are not tracked here.
