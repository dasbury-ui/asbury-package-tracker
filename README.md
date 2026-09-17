# Asbury Package Tracker

Watches every Asbury mailbox, finds every shipment tracking number, tracks
each package to delivery against the carriers' own APIs, and shows it on an
iPhone. Runs itself. Costs nothing.

**→ [START-HERE.md](START-HERE.md) to set it up.**

---

## The rule this system is built around

**A status is only shown as fact when a carrier's own API confirmed it.**

Everything else is shown as UNCONFIRMED with the reason in plain English.
An email saying "your package was delivered" never marks a package delivered
— only a carrier's structured status code does. A string that looks like a
tracking number but fails its check digit is rejected, not tracked.

## How it works

```
Gmail (read-only) ─▶ extract + validate ─▶ carrier API ─▶ encrypted state ─▶ iPhone
                          │                     │
                    check digits           the only source
                    carrier links          of truth for status
```

- **Runner:** GitHub Actions, every 15 minutes. Does not need your computer on.
- **Mail:** all `@asburycabinets.com` mailboxes via a Workspace service
  account, discovered automatically so new mailboxes are picked up on their
  own; `asburyderek@gmail.com` via OAuth. Read-only — it cannot send or delete.
- **Carriers:** UPS, FedEx, DHL confirmed via API. USPS attempted. Amazon
  Logistics and OnTrac detected and flagged as unconfirmable.
- **Data:** AES-256-GCM encrypted. The repository is public so Pages and
  Actions are free; the data in it is not readable.
- **App:** a PWA on GitHub Pages, added to the Home Screen, with Web Push.

## Commands

```
node setup/setup.mjs      # set it up, or finish setting it up
node setup/doctor.mjs     # is it running? did it fail? why? how do I fix it?
node setup/preview.mjs    # see the app with sample data
node --test "test/**/*.test.mjs"   # 55 tests
```

## Documentation

| File | What is in it |
| --- | --- |
| [START-HERE.md](START-HERE.md) | Setup, and the short list of things only you can do |
| [documentation/ARCHITECTURE.md](documentation/ARCHITECTURE.md) | How it works and why, including the USPS limitation |
| [documentation/OPERATIONS.md](documentation/OPERATIONS.md) | Running, failing, diagnosing, recovering |
| [PROJECT_STATE.md](PROJECT_STATE.md) | Status, decisions, risks, next actions |

## Dependencies

None. No npm packages anywhere — the tracker and the app both use only what
is built into Node and the browser.
