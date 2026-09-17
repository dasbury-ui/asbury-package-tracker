# Start here

Open a terminal in this folder and run:

```
node setup/setup.mjs
```

It asks you a handful of questions, does everything else itself, and finishes
by printing a link to open on your iPhone.

Safe to run again at any time — it reports what is already done and only
fills the gaps.

---

## The only things it cannot do for you

Every one of these is a case where the account provider will only accept the
action from you personally. Everything around them is automated.

1. **Sign in to GitHub.** The wizard opens the browser; you approve. It never
   sees a password.
2. **Create the Google service account and authorise it.** Google requires the
   Workspace admin to paste a client ID and scope list into the admin console.
   The wizard gives you the exact values and opens the exact page.
3. **Click "Allow" for the personal Gmail account.** Your consent, your click.
4. **Sign up for the carrier developer accounts** (UPS, FedEx, DHL). Each one
   makes you accept its terms as Asbury Cabinets & Millwork. The wizard opens
   each signup page and takes the credentials straight into encrypted storage.
5. **Add the app to your iPhone Home Screen and tap "allow notifications".**
   iOS does not permit notifications for a web app any other way.

That is the whole list.

## Afterwards

| I want to… | Run |
| --- | --- |
| Check it is working | `node setup/doctor.mjs` |
| See the app with sample data | `node setup/preview.mjs` |
| Understand how it works | `documentation/ARCHITECTURE.md` |
| Fix something that broke | `documentation/OPERATIONS.md` |

## What it will and will not tell you

A package's status is shown as fact **only** when a carrier's own API
confirmed it. Anything else is shown as **UNCONFIRMED**, with the reason in
plain English. The system never reads "your package was delivered" in an
email and believes it.

One consequence you should know about up front: **USPS changed its rules on
1 April 2026** so that free tracking access goes only to the shipper who owns
the Mailer ID in the barcode. For parcels your suppliers send you, USPS will
refuse to confirm anything, and those packages will sit in the Unconfirmed
tab with a link to check by hand. That is not a bug in this system and there
is no free way around it. `documentation/ARCHITECTURE.md` has the detail.
