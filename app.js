/**
 * Asbury Packages - the phone app.
 *
 * Reads two files published by the tracker:
 *   data/health.json    plaintext, no business data. Lets the app say "this
 *                       feed is stale" even before it has the key.
 *   data/view.enc.json  AES-256-GCM. Decrypted in the browser with a key that
 *                       never leaves the phone.
 *
 * The rule the UI enforces: a package is only ever shown as a fact when the
 * tracker marked it API_CONFIRMED. Anything else is drawn as UNCONFIRMED with
 * the reason in plain English. There is no code path that renders a guess as
 * a status.
 */

const KEY_STORAGE = 'asbury.tracker.key.v1';
const STALE_MINUTES = 45;

const $ = (id) => document.getElementById(id);
const state = { key: null, view: null, health: null, filter: 'active' };

// ------------------------------------------------------------- crypto ----

function b64ToBytes(b64) {
  const s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importKey(b64) {
  const raw = b64ToBytes(b64);
  if (raw.length !== 32) throw new Error('That key is the wrong length.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function decryptEnvelope(key, envelope) {
  if (!envelope || envelope.v !== 1 || envelope.alg !== 'AES-256-GCM') {
    throw new Error('Unrecognised data format.');
  }
  const iv = b64ToBytes(envelope.iv);
  const ct = b64ToBytes(envelope.ct);
  const tag = b64ToBytes(envelope.tag);
  const joined = new Uint8Array(ct.length + tag.length);
  joined.set(ct, 0);
  joined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, joined);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function encryptForRepo(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const buf = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 }, key, data,
  ));
  const ct = buf.slice(0, buf.length - 16);
  const tag = buf.slice(buf.length - 16);
  return {
    v: 1,
    alg: 'AES-256-GCM',
    iv: btoa(String.fromCharCode(...iv)),
    tag: btoa(String.fromCharCode(...tag)),
    ct: btoa(String.fromCharCode(...ct)),
  };
}

// -------------------------------------------------------------- data ----

async function loadHealth() {
  try {
    const res = await fetch(`data/health.json?t=${Date.now()}`, { cache: 'no-store' });
    state.health = res.ok ? await res.json() : null;
  } catch {
    state.health = null;
  }
}

async function loadView() {
  const res = await fetch(`data/view.enc.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not fetch the data file (HTTP ${res.status}).`);
  const envelope = await res.json();
  state.view = await decryptEnvelope(state.key, envelope);
}

// ------------------------------------------------------------ render ----

function minutesSince(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 60000 : Infinity;
}

function ago(iso) {
  const m = minutesSince(iso);
  if (!Number.isFinite(m)) return 'never';
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function renderHealth() {
  const el = $('health');
  const h = state.health;
  el.className = 'health';

  if (!h) {
    el.classList.add('failed');
    el.innerHTML = '<span class="dot"></span><span>No status file. The tracker has never published.</span>';
    return;
  }
  const mins = minutesSince(h.finishedAt || h.startedAt);
  // health.json is plaintext and unsigned, so everything from it is escaped,
  // and the run link is restricted to a github.com URL.
  const safeRunUrl = /^https:\/\/github\.com\/[\w./-]+$/.test(String(h.runUrl || ''))
    ? h.runUrl : null;
  const link = safeRunUrl ? ` <a href="${escapeHtml(safeRunUrl)}" style="color:inherit">run log</a>` : '';

  if (h.ok === false) {
    el.classList.add('failed');
    el.innerHTML = `<span class="dot"></span><span>Last run FAILED ${ago(h.finishedAt || h.startedAt)}`
      + `${h.error ? ` — ${escapeHtml(h.error)}` : ''}.${link}</span>`;
  } else if (mins > STALE_MINUTES) {
    el.classList.add('stale');
    el.innerHTML = `<span class="dot"></span><span>STALE — last successful run ${ago(h.finishedAt)}.`
      + ` Figures below may be out of date.${link}</span>`;
  } else {
    el.classList.add('live');
    el.innerHTML = `<span class="dot"></span><span>Up to date — checked ${ago(h.finishedAt)}</span>`;
  }

  renderDormant(h);
}

/**
 * Show what is switched off and why. A capability that is asleep because a
 * credential has not been added yet is normal, not a fault - but it must be
 * visible, or the board silently under-reports and looks like it is working.
 */
function renderDormant(h) {
  const box = $('dormant');
  if (!box) return;
  const items = Array.isArray(h?.dormant) ? h.dormant : [];
  if (!items.length) { box.hidden = true; return; }

  const label = {
    workspaceMail: 'Company mailboxes', personalMail: 'Personal Gmail',
    ups: 'UPS', fedex: 'FedEx', dhl: 'DHL', usps: 'USPS', push: 'Notifications',
  };
  box.hidden = false;
  box.innerHTML = `<strong>${items.length} not switched on yet</strong><ul>`
    + items.map((d) => `<li><b>${escapeHtml(label[d.capability] || d.capability)}</b> — ${escapeHtml(d.reason || '')}</li>`).join('')
    + '</ul>';
}

const STAGE_LABEL = {
  PRE_TRANSIT: 'LABEL CREATED',
  IN_TRANSIT: 'IN TRANSIT',
  OUT_FOR_DELIVERY: 'OUT FOR DELIVERY',
  DELIVERED: 'DELIVERED',
  EXCEPTION: 'PROBLEM',
  RETURNED: 'RETURNED',
  UNKNOWN: 'UNKNOWN',
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function matchesFilter(p, filter) {
  const confirmed = p.confidence === 'API_CONFIRMED';
  switch (filter) {
    case 'active':
      return confirmed && p.stage !== 'DELIVERED' && p.stage !== 'RETURNED';
    case 'problems':
      return confirmed && (p.stage === 'EXCEPTION' || p.stage === 'RETURNED');
    case 'unconfirmed':
      return !confirmed;
    case 'delivered':
      return confirmed && p.stage === 'DELIVERED';
    default:
      return true;
  }
}

function card(p) {
  const confirmed = p.confidence === 'API_CONFIRMED';
  const li = document.createElement('li');
  li.className = `card s-${p.stage}${confirmed ? '' : ' unconfirmed'}`;

  const stageText = confirmed ? (STAGE_LABEL[p.stage] || p.stage) : 'UNCONFIRMED';
  const stageClass = confirmed ? p.stage : 'UNCONFIRMED';

  // The carrier is only ever stated as fact when a carrier API confirmed it.
  // A carrier merely guessed from the number's shape is shown as a guess,
  // because guessing a carrier from a pattern is exactly what this system
  // promises not to present as truth.
  const carrier = p.carrierIsConfirmed
    ? p.carrier.toUpperCase()
    : (p.carrier ? `CARRIER UNKNOWN — possibly ${p.carrier.toUpperCase()}` : 'CARRIER UNKNOWN');

  let html = `
    <div class="row1">
      <span class="vendor">${escapeHtml(p.vendor || 'Unknown sender')}</span>
      <span class="stage ${escapeHtml(stageClass)}">${escapeHtml(stageText)}</span>
    </div>`;

  if (confirmed) {
    html += `<p class="status">${escapeHtml(p.carrierStatusText || STAGE_LABEL[p.stage] || '')}</p>`;
    const bits = [];
    if (p.lastEventLocation) bits.push(escapeHtml(p.lastEventLocation));
    if (p.lastEventAt) bits.push(ago(p.lastEventAt));
    if (p.estimatedDelivery) bits.push(`ETA ${escapeHtml(String(p.estimatedDelivery).slice(0, 16).replace('T', ' '))}`);
    if (bits.length) html += `<p class="meta">${bits.join(' · ')}</p>`;
    if (p.staleReason) {
      html += `<div class="banner stale">Last confirmed ${ago(p.lastConfirmedAt)}.
        The most recent check did not get through (${escapeHtml(p.staleReason)}),
        so this is the last thing the carrier actually said.</div>`;
    }
  } else {
    html += `<div class="banner"><strong>Not confirmed by a carrier.</strong>
      ${escapeHtml(p.reasonText || p.reason || '')}
      ${p.givenUp ? ' No further automatic attempts will be made.' : ''}</div>`;
  }

  html += `<p class="meta">${escapeHtml(carrier)} · ${escapeHtml(p.number)}`;
  if (p.mailbox) html += ` · seen in ${escapeHtml(p.mailbox)}`;
  if (p.sightingCount > 1) html += ` · ${escapeHtml(p.sightingCount)} emails`;
  html += '</p>';

  if (p.subject) html += `<p class="meta">${escapeHtml(p.subject)}</p>`;
  if (p.link) {
    const label = p.carrierIsConfirmed
      ? 'Open on the carrier site'
      : `Try checking it on ${escapeHtml(p.carrier.toUpperCase())} yourself`;
    html += `<a class="track" href="${escapeHtml(p.link)}" target="_blank" rel="noopener">${label}</a>`;
  }

  if (p.events?.length) {
    html += '<ul class="events">';
    for (const e of p.events.slice(0, 4)) {
      html += `<li>${escapeHtml(String(e.at || '').slice(0, 16).replace('T', ' '))} — ${escapeHtml(e.text)}${e.location ? ` (${escapeHtml(e.location)})` : ''}</li>`;
    }
    html += '</ul>';
  }
  if (p.attribution) html += `<p class="meta">${escapeHtml(p.attribution)}</p>`;

  li.innerHTML = html;
  return li;
}

function render() {
  renderHealth();
  if (!state.view) return;

  const c = state.view.counts || {};
  $('counts').textContent =
    `${c.outForDelivery || 0} out for delivery · ${c.inTransit || 0} in transit · `
    + `${c.problems || 0} problems · ${c.unconfirmed || 0} unconfirmed · ${c.delivered || 0} delivered`;

  const list = $('list');
  list.innerHTML = '';
  const items = (state.view.packages || []).filter((p) => matchesFilter(p, state.filter));
  for (const p of items) list.appendChild(card(p));
  $('empty').hidden = items.length > 0;

  $('footnote').textContent =
    `Data generated ${ago(state.view.generatedAt)}. Status is only shown as fact when a carrier's own API confirmed it.`;
}

// ------------------------------------------------------------- push ----

async function refreshPushUi() {
  const stateEl = $('pushState');
  const enableBtn = $('enablePush');
  const registerBtn = $('registerPush');
  const help = $('pushHelp');
  enableBtn.hidden = true;
  registerBtn.hidden = true;

  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    stateEl.textContent = 'This browser does not support notifications.';
    help.textContent = standalone ? '' :
      'On iPhone, notifications only work after you add this page to the Home Screen with Share → Add to Home Screen, then open it from there.';
    return;
  }
  if (!standalone) {
    stateEl.textContent = 'Notifications are not available in a Safari tab.';
    help.textContent = 'Tap Share → Add to Home Screen, then open Packages from your Home Screen and come back here.';
    return;
  }

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();

  if (Notification.permission !== 'granted' || !existing) {
    stateEl.textContent = 'Notifications are off.';
    enableBtn.hidden = false;
    help.textContent = '';
    return;
  }
  stateEl.textContent = 'Notifications are on for this phone.';
  registerBtn.hidden = false;
  help.textContent = 'If you are not receiving notifications, tap the button above to re-register this phone.';
}

async function enablePush() {
  const help = $('pushHelp');
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      help.textContent = 'Permission was not granted, so notifications stay off.';
      return;
    }
    const keyRes = await fetch('data/vapid-public-key.txt', { cache: 'no-store' });
    const vapid = (await keyRes.text()).trim();
    if (!vapid) throw new Error('No push key has been published yet.');

    const reg = await navigator.serviceWorker.ready;
    await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToBytes(vapid),
    });
    await refreshPushUi();
    help.textContent = 'Now tap "Finish registering this phone".';
  } catch (err) {
    help.textContent = `Could not turn on notifications: ${err.message}`;
  }
}

/**
 * Hand the subscription to the repository. There is no free server to POST
 * to, so it travels as ciphertext in a GitHub issue that a workflow consumes
 * and closes. The issue body is unreadable to anyone without the key.
 */
async function registerPhone() {
  const help = $('pushHelp');
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) throw new Error('This phone is not subscribed yet.');

    const json = sub.toJSON();
    const envelope = await encryptForRepo(state.key, {
      endpoint: json.endpoint,
      keys: json.keys,
      label: 'iPhone',
    });

    const repo = await detectRepo();
    const body = `Encrypted push subscription. A workflow will consume and close this.\n\n\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\``;
    const url = `https://github.com/${repo}/issues/new?title=${encodeURIComponent('register-phone')}&body=${encodeURIComponent(body)}`;
    if (url.length > 7500) throw new Error('Registration payload is too large for this method.');
    window.open(url, '_blank', 'noopener');
    help.textContent = 'A GitHub page opened. Tap "Create" there and you are done.';
  } catch (err) {
    help.textContent = `Could not register: ${err.message}`;
  }
}

/** owner/repo, inferred from the github.io URL the app is served from. */
async function detectRepo() {
  const host = location.hostname;            // owner.github.io
  const owner = host.split('.')[0];
  const repo = location.pathname.split('/').filter(Boolean)[0] || `${owner}.github.io`;
  return `${owner}/${repo}`;
}

// -------------------------------------------------------------- boot ----

async function unlockWith(keyB64) {
  state.key = await importKey(keyB64);
  await loadView();                           // proves the key is right
  localStorage.setItem(KEY_STORAGE, keyB64);
  $('unlock').hidden = true;
  $('board').hidden = false;
  render();
}

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  await loadHealth();
  renderHealth();

  // A key may arrive in the URL fragment from the setup wizard's install link.
  // Fragments are never sent to a server. It is consumed and stripped at once.
  const fragment = new URLSearchParams(location.hash.slice(1));
  const fromLink = fragment.get('k');
  const stored = localStorage.getItem(KEY_STORAGE);
  const candidate = fromLink || stored;

  if (candidate) {
    try {
      await unlockWith(candidate);
      if (fromLink) history.replaceState(null, '', location.pathname + location.search);
    } catch (err) {
      $('unlock').hidden = false;
      $('unlockError').hidden = false;
      $('unlockError').textContent = `Stored key did not work: ${err.message}`;
    }
  } else {
    $('unlock').hidden = false;
  }

  await refreshPushUi();
}

// events
$('unlockBtn').addEventListener('click', async () => {
  const err = $('unlockError');
  err.hidden = true;
  try {
    await unlockWith($('keyInput').value.trim());
  } catch (e) {
    err.hidden = false;
    err.textContent = e.message;
  }
});

$('refresh').addEventListener('click', async () => {
  await loadHealth();
  if (state.key) {
    try { await loadView(); } catch (e) { /* health banner already shows trouble */ }
  }
  render();
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.remove('is-active');
    tab.classList.add('is-active');
    state.filter = tab.dataset.filter;
    render();
  });
}

$('enablePush').addEventListener('click', enablePush);
$('registerPush').addEventListener('click', registerPhone);

$('showLog').addEventListener('click', () => {
  const el = $('log');
  el.hidden = !el.hidden;
  if (!el.hidden) {
    el.textContent = (state.view?.decisions || [])
      .map((d) => `${d.at}  ${d.decision.padEnd(12)} ${d.number || ''}  ${d.reason || d.outcome || d.basis || ''}`)
      .join('\n') || 'No decisions recorded yet.';
  }
});

$('forget').addEventListener('click', () => {
  localStorage.removeItem(KEY_STORAGE);
  location.reload();
});

// Refresh whenever the app comes back to the foreground.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.key) return;
  await loadHealth();
  try { await loadView(); } catch { /* keep showing the last good data */ }
  render();
});

boot();
