# PROJECT STATE — Asbury Package Tracker

**Revision 1.0** · Last updated 16 September 2026 · Owner: Derek Asbury

This file exists so another session, agent or person can pick the project up
without reconstructing it from chat history.

---

## Objective

Watch every Asbury mailbox, detect every shipment tracking number, track each
package to delivery against authoritative carrier APIs, and show current
status in an iPhone app that stays current on its own. Zero cost. Zero
maintenance by Derek.

## Business problem

Packages arrive at Asbury from many suppliers across several mailboxes. There
is no single view of what is coming, what is late, and what has landed. The
cost is time spent hunting through email and chasing suppliers, and shop work
stalling on hardware nobody knew was delayed.

## Approved scope

**In:** parcel carriers (UPS, FedEx, USPS, DHL, plus detection of Amazon
Logistics and OnTrac); all `@asburycabinets.com` mailboxes and
`asburyderek@gmail.com`; an installable iPhone PWA with Web Push.

**Out:** LTL/freight tracking; purchasing or PO matching; inventory; any
write access to email; anything requiring payment.

## Current state — MILESTONE 1 VERIFIED COMPLETE, NOT YET DEPLOYED

The code is built and tested. It has **never run against a real mailbox or a
real carrier API**, because that requires credentials only Derek can create.

| Milestone | Status |
| --- | --- |
| M1 Build and offline verification | **VERIFIED COMPLETE** |
| M2 Credentials and first live run | **BLOCKED** — needs Derek (see below) |
| M3 Live accuracy validation over 2 weeks | Not started; blocked by M2 |

### M1 acceptance criteria and evidence

| Criterion | Evidence |
| --- | --- |
| Check digits verified, not assumed | 55 tests pass; UPS verified against `1Z999AA10123456784`, S10 against published vectors, all algorithms round-trip property-tested |
| Web Push encryption correct | Byte-for-byte match against the RFC 8291 §5 published test vector |
| No plaintext business data published | End-to-end test asserts tracking numbers, vendor names and mailboxes are absent from the written bytes |
| Email text never sets delivery | End-to-end test feeds "was delivered at 2pm" and asserts the package is NOT delivered |
| One number in 3 emails = 1 package | Asserted in the end-to-end test |
| Failures are visible, never silent | Verified by running with no credentials: exit 1, health file written with the reason |
| Free-tier caps enforced | Budget tests assert exhaustion is reported, not exceeded |
| App renders on a phone-sized screen | Rendered in Chrome against sample data; board, health banner and cards confirmed |

**Test command:** `node --test "test/**/*.test.mjs"` → **65 pass, 0 fail.**

### Independent QA pass — completed, defects fixed

An independent reviewer audited the source against the accuracy rule and
found 2 critical and 5 major defects. All are fixed and each has a regression
test in `test/qa-regressions.test.mjs`.

| Severity | Defect | Fix |
| --- | --- | --- |
| CRITICAL | The app displayed a carrier guessed from a number pattern as though it were confirmed, with a "carrier site" link — the exact rule the system promises to keep | `web/app.js` now reads `carrierIsConfirmed`; an unconfirmed carrier renders as "CARRIER UNKNOWN — possibly X" and the link is reworded as a suggestion |
| CRITICAL | Employee mailbox addresses were written to the plaintext `health.json`, published on Pages, and echoed into public Actions logs | `maskEmail()` applied at every site, plus a catch-all address redaction in `log.mjs` |
| MAJOR | `h.runUrl` from the unsigned plaintext health file was injected into `innerHTML` unescaped — XSS on the one unauthenticated input | Escaped and restricted to a `github.com` URL |
| MAJOR | A transient `gh-pages` checkout failure would force-push empty state over real state | The workflow now checks whether the branch exists first and refuses to publish if it exists but could not be read |
| MAJOR | Untrusted step output interpolated into a workflow `run:` block (script injection, owner-gated) | Passed via `env:` and quoted |
| MAJOR | Bare-digit checksums admitted packages with no context — ~1 phone number in 7 passes DHL's mod 7 | `requiresContext` formats now need a carrier link or a tracking label as well |
| MAJOR | Push-host allowlist used a bare suffix match, so `notweb.push.apple.com` would pass | Exact host or true subdomain match |

Minor findings (unescaped low-risk interpolations, a missing reason string, a
FedEx budget double-charge on batch failure, CI pinned to a Node version
whose `--test` does not accept globs, raw email subjects reaching
notification text, a missing filter guard) were also fixed.

## BLOCKED ON — the unblock condition for M2

Derek runs `node setup/setup.mjs` and completes the five account actions
listed in `START-HERE.md`. Nothing else is outstanding. Everything the wizard
can do without him is already automated.

Partial completion is fine and expected: with GitHub plus any one mailbox
source the system runs and reports the rest as not-configured.

## Decisions made, and why

| Decision | Reason |
| --- | --- |
| Public repo + encrypted data | Pages and unmetered Actions minutes are free only on public repos; encryption preserves confidentiality. Chosen over a private repo, which gets 2,000 min/month and no Pages on the free plan |
| State on a force-pushed orphan branch | Avoids ~35,000 commits and several GB per year |
| Zero npm dependencies | No supply-chain surface, no install time, nothing upstream can break |
| Wrote checksum algorithms rather than vendoring `jkeen/tracking_number_data` | Licence could not be verified at build time; contract requires a verified licence before adoption |
| USPS client implemented despite the access restriction | Derek may own the MID on outbound parcels, and the API's answer should decide, not our assumption |
| Carrier wins over checksum on disagreement | The carrier is authoritative; our arithmetic is not |
| A failed lookup does not revoke a confirmed status | Discarding a true "delivered" over an HTTP 500 is less accurate, not more |
| Push registration via an encrypted GitHub issue | No free server exists to receive the subscription; the body is ciphertext and non-owner issues are ignored |

## Assumptions

1. Derek's GitHub account is on the Free plan. *(If it is Pro, a private repo
   with Pages becomes possible and the encryption could be relaxed — not
   recommended; it works and costs nothing.)*
2. Most inbound parcels are UPS, FedEx and DHL. USPS coverage will be poor
   and Amazon Logistics will not be confirmable.
3. Parcel volume is low enough that DHL's 250 calls/day is sufficient.
   *Unvalidated until M3.*
4. `SCAN_LOOKBACK_DAYS=14` is long enough to catch a package between a
   shipping email and delivery.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| USPS parcels largely unconfirmable | High, accepted | Shown honestly as UNCONFIRMED with a link. No free fix exists |
| Carrier APIs change without notice | Medium | Unmapped status codes yield UNKNOWN + verbatim carrier text and a warning in the log, rather than a wrong status |
| DHL daily cap reached in a busy week | Medium | Budget caps at 200/250 and reports; a free upgrade can be requested from DHL |
| Scheduled workflow disabled at 60 days | Medium | Weekly keepalive commit + the app shows staleness immediately |
| Checksum variants for rarer FedEx formats may be wrong | Low | Would cause rejection, which is logged as `CHECKSUM_FAILED` and traceable; carrier-link admission provides a second path |
| Gmail `historyId` expiry causes a scan gap | Low | Detected, logged, and falls back to a dated search |

## Next executable action

1. **Derek:** run `node setup/setup.mjs`.
2. **Then:** `node setup/doctor.mjs` to confirm the first run succeeded.
3. **Then (M3):** over two weeks, compare what the app shows against what
   actually arrives at the shop. Specifically check: any package that arrived
   but never appeared (parser miss — check the decision log), and any package
   shown UNCONFIRMED whose carrier *is* configured (a resolution gap).

## Backlog — not in scope, recorded so it is not lost

- Re-evaluate `jkeen/tracking_number_data` if its licence is confirmed
  permissive; would broaden carrier coverage cheaply.
- Carrier webhooks (UPS, FedEx and DHL all offer push) would cut latency to
  near-zero and collapse API usage. Needs a free HTTPS endpoint, which the
  current zero-cost constraint does not provide.
- Link packages to purchase orders, so the board says *what* is arriving and
  not just *who* sent it.
- Freight/LTL tracking for sheet goods.

## Files

See `documentation/ARCHITECTURE.md` §4 for the runtime diagram.

```
src/tracking/   checksums, formats, extraction + admission policy
src/carriers/   ups, fedex, usps, dhl clients + resolution rules
src/gmail/      service-account and OAuth auth, incremental scanning
src/            crypto, state, budget, publish, push, index (orchestrator)
web/            the iPhone PWA
setup/          setup wizard, doctor, preview, icon generator
test/           55 tests
.github/workflows/  track (*/15), ci, backup-and-keepalive, register-phone
```
