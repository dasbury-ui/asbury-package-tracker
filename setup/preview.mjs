#!/usr/bin/env node
/**
 * Preview the app locally with realistic sample data.
 *
 *   node setup/preview.mjs
 *
 * Generates an encrypted sample view and serves web/ on localhost so the
 * screens can be checked without touching a real mailbox or carrier. Used
 * during development and useful for demonstrating the app to someone.
 */

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptJson, keyFromBase64 } from '../src/crypto.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const DEMO_KEY = Buffer.alloc(32, 7).toString('base64');
const PORT = Number(process.env.PORT || 8765);

const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

const VIEW = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  counts: { total: 5, outForDelivery: 1, inTransit: 2, problems: 1, delivered: 1, unconfirmed: 1 },
  packages: [
    {
      number: '1Z999AA10123456784', carrier: 'ups', carrierIsConfirmed: true,
      stage: 'OUT_FOR_DELIVERY', confidence: 'API_CONFIRMED', reason: null,
      carrierStatusText: 'Out For Delivery Today', carrierStatusCode: '012',
      lastEventAt: hoursAgo(2), lastEventLocation: 'Williamsburg, VA, US',
      estimatedDelivery: hoursAgo(-4), service: 'UPS Ground',
      vendor: 'A&M Supply', subject: 'Your order has shipped',
      mailbox: 'dasbury@asburycabinets.com', sightingCount: 2,
      lastCheckedAt: hoursAgo(0.2), lastConfirmedAt: hoursAgo(0.2),
      events: [
        { at: hoursAgo(2), text: 'Out For Delivery', location: 'Williamsburg, VA' },
        { at: hoursAgo(9), text: 'Arrived at Facility', location: 'Richmond, VA' },
      ],
      link: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
    },
    {
      number: '770123456789', carrier: 'fedex', carrierIsConfirmed: true,
      stage: 'IN_TRANSIT', confidence: 'API_CONFIRMED', reason: null,
      carrierStatusText: 'In transit', carrierStatusCode: 'IT',
      lastEventAt: hoursAgo(6), lastEventLocation: 'Greensboro, NC, US',
      estimatedDelivery: hoursAgo(-30), service: 'FedEx Ground',
      vendor: 'Richelieu Hardware', subject: 'Shipment notice',
      mailbox: 'shop@asburycabinets.com', sightingCount: 1,
      lastCheckedAt: hoursAgo(0.3), lastConfirmedAt: hoursAgo(0.3),
      events: [{ at: hoursAgo(6), text: 'In transit', location: 'Greensboro, NC' }],
      link: 'https://www.fedex.com/fedextrack/?trknbr=770123456789',
    },
    {
      number: '1234567890', carrier: 'dhl', carrierIsConfirmed: true,
      stage: 'EXCEPTION', confidence: 'API_CONFIRMED', reason: null,
      carrierStatusText: 'Delivery attempted - no one available',
      carrierStatusCode: 'failure',
      lastEventAt: hoursAgo(20), lastEventLocation: 'Norfolk, VA',
      vendor: 'Blum Inc', subject: 'Your hinges are on the way',
      mailbox: 'dasbury@asburycabinets.com', sightingCount: 1,
      lastCheckedAt: hoursAgo(1), lastConfirmedAt: hoursAgo(1),
      staleReason: null, events: [],
      attribution: 'Delivered by Deutsche Post DHL Group',
      link: 'https://www.dhl.com/us-en/home/tracking.html?tracking-id=1234567890',
    },
    {
      number: '9400111899223818747820', carrier: 'usps', carrierIsConfirmed: false,
      stage: 'UNKNOWN', confidence: 'UNCONFIRMED',
      reason: 'USPS_RECIPIENT_NOT_AUTHORISED',
      reasonText: 'USPS only gives free tracking to the shipper who owns the Mailer ID. '
        + 'Asbury is the recipient here, so USPS will not confirm this one.',
      givenUp: true, vendor: 'Woodworker Express', subject: 'Shipped via USPS',
      mailbox: 'dasbury@asburycabinets.com', sightingCount: 1,
      firstSeenAt: hoursAgo(50), lastCheckedAt: hoursAgo(5), events: [],
      link: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223818747820',
    },
    {
      number: '1Z999AA10123456791', carrier: 'ups', carrierIsConfirmed: true,
      stage: 'DELIVERED', confidence: 'API_CONFIRMED', reason: null,
      carrierStatusText: 'Delivered', carrierStatusCode: '011',
      lastEventAt: hoursAgo(28), lastEventLocation: 'Toano, VA, US',
      vendor: 'Hafele America', subject: 'Delivered',
      mailbox: 'shop@asburycabinets.com', sightingCount: 3,
      lastCheckedAt: hoursAgo(26), lastConfirmedAt: hoursAgo(26),
      events: [{ at: hoursAgo(28), text: 'Delivered - Front Door', location: 'Toano, VA' }],
      link: 'https://www.ups.com/track?tracknum=1Z999AA10123456791',
    },
  ],
  decisions: [
    { at: hoursAgo(0.2), decision: 'LOOKUP', number: '1Z******6784', outcome: 'CONFIRMED:ups:OUT_FOR_DELIVERY' },
    { at: hoursAgo(0.2), decision: 'LOOKUP', number: '94******7820', outcome: 'UNCONFIRMED:USPS_RECIPIENT_NOT_AUTHORISED' },
    { at: hoursAgo(1), decision: 'REJECTED', number: '1Z******6785', reason: 'CHECKSUM_FAILED:ups=UPS_EXPECTED_4' },
    { at: hoursAgo(1), decision: 'ADMITTED_NEW', number: '77******6789', basis: 'CARRIER_LINK' },
    { at: hoursAgo(3), decision: 'MERGED', number: '1Z******6784', basis: 'CHECKSUM' },
  ],
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

async function writeDemoData() {
  const dir = join(WEB, 'data');
  await mkdir(dir, { recursive: true });
  const key = keyFromBase64(DEMO_KEY);
  await writeFile(join(dir, 'view.enc.json'), JSON.stringify(encryptJson(key, VIEW)));
  await writeFile(join(dir, 'health.json'), JSON.stringify({
    schemaVersion: 1,
    startedAt: hoursAgo(0.2),
    finishedAt: hoursAgo(0.15),
    ok: true,
    stage: 'done',
    packages: { total: 5, active: 3, confirmed: 4, unconfirmed: 1, delivered: 1 },
    mailboxes: { scanned: 4, failed: 0, errors: [] },
    push: { subscriptions: 1, sent: 2, failed: 0 },
    budget: { dhl: { used: 12, limit: 200, denied: 0 } },
  }, null, 2));
  await writeFile(join(dir, 'vapid-public-key.txt'), '');
}

await writeDemoData();

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(WEB, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  if (!file.startsWith(WEB)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`\n  Preview running:  http://localhost:${PORT}/`);
  console.log(`  Demo unlock key:  ${DEMO_KEY}`);
  console.log(`  Direct link:      http://localhost:${PORT}/#k=${encodeURIComponent(DEMO_KEY)}`);
  console.log('\n  Sample data only. Ctrl+C to stop.\n');
});
