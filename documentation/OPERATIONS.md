# Operations

**Revision 1.0** — initial issue, 16 September 2026
**System:** Asbury Package Tracker
**Owner:** Derek Asbury — no second operator required

---

## The one command

```
node setup/doctor.mjs
```

It answers all four questions below from the outside, changes nothing, and
tells you the exact command to fix whatever it finds.

---

## 1. How do I tell if it is running?

**From the phone.** The line under the title is the answer.

| What it says | Meaning |
| --- | --- |
| Green dot, "Up to date — checked N min ago" | Running normally |
| Amber, "STALE — last successful run …" | No successful run in 45+ minutes |
| Red, "Last run FAILED …" | It ran and failed; the reason is on the line |
| Red, "No status file" | It has never successfully published |

A gap of 20–30 minutes is normal — GitHub delays scheduled runs under load.
Past about an hour, something is wrong.

**From a computer.** `node setup/doctor.mjs`, or the Actions tab:
`https://github.com/<you>/asbury-package-tracker/actions`

## 2. How do I tell if it failed, and why?

```
gh run view --log-failed --repo <you>/asbury-package-tracker
```

Every failed run also writes a summary into the run page, and always leaves a
`health.json` behind with the error in it — a failure is never silent.

### Failure reasons you will actually see

| Symptom | Cause | Fix |
| --- | --- | --- |
| `STATE_KEY is not set` | Secret missing or deleted | `node setup/setup.mjs` |
| `Could not read existing state` | Wrong `STATE_KEY`, or a corrupt file | Restore from backup (§4). **Do not** rotate the key to make the error go away — that discards all history |
| `unauthorized_client` from Google | Domain-wide delegation not granted, or the scopes do not match exactly | Re-do step 5 of setup; the Client ID and both scopes must match character for character |
| `No mailbox could be scanned` | All mailbox credentials failed | Check the Google service account key has not been deleted in the Cloud console |
| `Directory listing unavailable` | Admin SDK scope not delegated | Add `admin.directory.user.readonly` to the delegation. Until then only the admin mailbox is scanned — and it says so |
| `CARRIER_AUTH_FAILED` | Carrier credentials expired or revoked | Re-run setup for that carrier |
| `BUDGET_EXHAUSTED` on DHL | More than 200 DHL lookups today | Nothing to do; it resumes at UTC midnight. If it happens daily, request a higher tier from DHL — it is free |
| No runs at all for days | GitHub disabled the schedule after 60 days idle | `gh workflow enable track.yml --repo <you>/asbury-package-tracker` |

## 3. How do I make it run right now?

```
gh workflow run track.yml --repo <you>/asbury-package-tracker
gh run watch --repo <you>/asbury-package-tracker
```

To re-scan the last two weeks of mail from scratch (after fixing a parser
problem, say):

```
gh workflow run track.yml --repo <you>/asbury-package-tracker -f full_rescan=true
```

## 4. How do I recover?

### The state file is corrupt or was lost

The run refuses to start rather than silently beginning again from nothing.
Restore the weekly backup:

1. Go to Actions → "Backup and keepalive" → the most recent run.
2. Download the `state-backup-…` artifact and unzip it.
3. Put `packages.enc.json` back on the `gh-pages` branch under `data/`:
   ```
   git clone --branch gh-pages <repo-url> restore && cd restore
   cp /path/to/packages.enc.json data/
   git commit -am "restore state from backup" && git push
   ```
4. Run the tracker.

**Worst case:** delete `data/packages.enc.json` and let it rebuild. You lose
history, not packages — it re-reads the last 14 days of mail and re-confirms
everything against the carriers. Delivered packages older than that are gone.

### The app will not unlock on the phone

The stored key is wrong. Open "Notifications and diagnostics" → "Forget key on
this phone", then re-open the install link from the setup output. If you no
longer have the key, `node setup/setup.mjs --new-key` issues a fresh one — but
that makes all existing stored data unreadable and it will rebuild.

### Notifications stopped

1. Confirm the app is opened from the **Home Screen icon**, not a Safari tab.
   iOS will not deliver Web Push to a tab.
2. Open "Notifications and diagnostics" → "Finish registering this phone".
3. Expired subscriptions are pruned automatically; re-registering is the fix.

## 5. Routine checks

| When | What | Why |
| --- | --- | --- |
| Whenever you open the app | The status line is green | 2 seconds, catches everything |
| Monthly | `node setup/doctor.mjs` | Catches expiring credentials and exhausted budgets |
| If a package seems wrong | "Show parse decisions" in the app | Every decision is logged with its reason |

## 6. Tracing a wrong result

Every candidate in every email produces a decision record. In the app, expand
"Notifications and diagnostics" → "Show parse decisions".

| Decision | Meaning |
| --- | --- |
| `ADMITTED_NEW` | Accepted as a new package, with the basis |
| `MERGED` | Recognised as an existing package |
| `REJECTED` | Not tracked, with the reason (e.g. `CHECKSUM_FAILED:ups=UPS_EXPECTED_4`) |
| `WEAK_CHECKSUM_NO_CONTEXT` | Bare digits that passed a weak checksum but had no tracking label or link — almost always a phone or account number |
| `LOOKUP` | A carrier was asked; shows which, and what it said |
| `GAVE_UP` | No carrier would confirm it within 96 hours |

**A package is missing.** Look for a `REJECTED` entry. `CHECKSUM_FAILED` means
the number in the email did not pass its check digit — usually the email was
truncated. `NO_KNOWN_FORMAT` means the carrier's format is not implemented.

**A package shows the wrong status.** The `LOOKUP` entry names the carrier and
the code it returned. The status shown is always what the carrier said; if it
is wrong, the carrier's own tracking page will show the same thing. Use the
"Open on the carrier site" link to confirm.

## 7. What this system will never do

Stated so nobody has to wonder:

- Send, delete or modify email. The Gmail scope is read-only.
- Show a status that a carrier did not confirm.
- Mark something delivered because an email said so.
- Cost money. Every tier in use is free with no card on file.
