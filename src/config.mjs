/**
 * Configuration, read entirely from environment (GitHub Actions secrets).
 * No credential is ever written to disk or committed.
 *
 * Every carrier is optional. A carrier without credentials is not an error -
 * its packages are simply reported as UNCONFIRMED with reason
 * CARRIER_NOT_CONFIGURED, which is the honest answer.
 */

const env = (name, fallback = null) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};

const num = (name, fallback) => {
  const v = Number(env(name));
  return Number.isFinite(v) ? v : fallback;
};

export const config = {
  // --- state ---
  stateKey: env('STATE_KEY'),
  dataDir: env('DATA_DIR', 'docs/data'),

  // --- Google Workspace: all @asburycabinets.com mailboxes ---
  google: {
    serviceAccountJson: env('GOOGLE_SERVICE_ACCOUNT_JSON'),
    // The Workspace admin whose authority is used to list domain users.
    adminSubject: env('GOOGLE_ADMIN_SUBJECT', 'dasbury@asburycabinets.com'),
    domain: env('GOOGLE_DOMAIN', 'asburycabinets.com'),
    // Optional explicit list; when unset, users are discovered via Admin SDK
    // so newly created mailboxes are picked up with no action from Derek.
    mailboxes: env('GOOGLE_MAILBOXES', '').split(',').map((s) => s.trim()).filter(Boolean),
  },

  // --- Personal Gmail (asburyderek@gmail.com) via OAuth refresh token ---
  personalGmail: {
    address: env('PERSONAL_GMAIL_ADDRESS', 'asburyderek@gmail.com'),
    clientId: env('PERSONAL_GMAIL_CLIENT_ID'),
    clientSecret: env('PERSONAL_GMAIL_CLIENT_SECRET'),
    refreshToken: env('PERSONAL_GMAIL_REFRESH_TOKEN'),
  },

  // --- Carriers ---
  carriers: {
    ups: {
      clientId: env('UPS_CLIENT_ID'),
      clientSecret: env('UPS_CLIENT_SECRET'),
      dailyBudget: num('UPS_DAILY_BUDGET', 5000),
    },
    fedex: {
      clientId: env('FEDEX_CLIENT_ID'),
      clientSecret: env('FEDEX_CLIENT_SECRET'),
      dailyBudget: num('FEDEX_DAILY_BUDGET', 5000),
    },
    usps: {
      clientId: env('USPS_CLIENT_ID'),
      clientSecret: env('USPS_CLIENT_SECRET'),
      dailyBudget: num('USPS_DAILY_BUDGET', 2000),
    },
    dhl: {
      apiKey: env('DHL_API_KEY'),
      // DHL grants 250 calls/day on the free tier. Stay clear of the ceiling.
      dailyBudget: num('DHL_DAILY_BUDGET', 200),
    },
  },

  // --- Web Push ---
  push: {
    publicKey: env('VAPID_PUBLIC_KEY'),
    privateKey: env('VAPID_PRIVATE_KEY'),
    subject: env('VAPID_SUBJECT', 'mailto:dasbury@asburycabinets.com'),
  },

  // --- Behaviour ---
  scan: {
    // How far back to look on a cold start or after a history gap.
    lookbackDays: num('SCAN_LOOKBACK_DAYS', 14),
    maxMessagesPerMailbox: num('SCAN_MAX_MESSAGES', 150),
  },

  poll: {
    // Minutes between authoritative lookups, by package state.
    unresolvedMinutes: num('POLL_UNRESOLVED_MIN', 0),
    inTransitMinutes: num('POLL_IN_TRANSIT_MIN', 120),
    outForDeliveryMinutes: num('POLL_OUT_FOR_DELIVERY_MIN', 15),
    exceptionMinutes: num('POLL_EXCEPTION_MIN', 60),
    // After this long with no carrier able to confirm, stop retrying and
    // leave the package visible as permanently UNCONFIRMED.
    giveUpUnresolvedHours: num('GIVE_UP_UNRESOLVED_HOURS', 96),
    // Keep delivered packages on the board this long, then archive.
    keepDeliveredDays: num('KEEP_DELIVERED_DAYS', 14),
  },

  retention: {
    // DHL's developer terms require tracking data to be deleted 30 days
    // after delivery. Applied to every carrier for simplicity and safety.
    purgeAfterDeliveryDays: num('PURGE_AFTER_DELIVERY_DAYS', 30),
    decisionLogEntries: num('DECISION_LOG_ENTRIES', 2000),
  },
};

export function configuredCarriers() {
  const c = config.carriers;
  return {
    ups: Boolean(c.ups.clientId && c.ups.clientSecret),
    fedex: Boolean(c.fedex.clientId && c.fedex.clientSecret),
    usps: Boolean(c.usps.clientId && c.usps.clientSecret),
    dhl: Boolean(c.dhl.apiKey),
    amazon: false,
    ontrac: false,
  };
}

/**
 * Establish what this run can actually do.
 *
 * ONLY STATE_KEY IS FATAL. Everything else is a capability that is either live
 * or dormant, and a run with dormant capabilities is a SUCCESSFUL run - it
 * publishes, it reports honestly what is asleep and why, and it wakes each
 * capability automatically the moment its secret appears. Crashing because a
 * carrier account has not been created yet would mean Derek cannot watch the
 * system come online one credential at a time, and would bury the real signal
 * in red runs.
 */
export function assertRunnable() {
  if (!config.stateKey) {
    throw new Error(
      'STATE_KEY is not set. Nothing can be stored or published without it. '
      + 'Run: node setup/setup.mjs',
    );
  }

  const hasWorkspace = Boolean(config.google.serviceAccountJson);
  const hasPersonal = Boolean(
    config.personalGmail.clientId
    && config.personalGmail.clientSecret
    && config.personalGmail.refreshToken,
  );
  return { hasWorkspace, hasPersonal };
}

/**
 * A machine-readable map of what is live and what is asleep, published in
 * health.json so both the phone and doctor.mjs can show it without guessing.
 */
export function capabilityReport() {
  const carriers = configuredCarriers();
  const cap = (live, reason, unlock) => ({ live, reason: live ? null : reason, unlock: live ? null : unlock });

  return {
    workspaceMail: cap(
      Boolean(config.google.serviceAccountJson),
      'No Google service-account key. The @asburycabinets.com mailboxes are not being read.',
      'Add the GOOGLE_SERVICE_ACCOUNT_JSON secret and authorise domain-wide delegation.',
    ),
    personalMail: cap(
      Boolean(config.personalGmail.refreshToken),
      'No personal Gmail OAuth token. That mailbox is not being read.',
      'Add the PERSONAL_GMAIL_* secrets.',
    ),
    ups: cap(carriers.ups, 'No UPS credentials.', 'Add UPS_CLIENT_ID and UPS_CLIENT_SECRET.'),
    fedex: cap(carriers.fedex, 'No FedEx credentials.', 'Add FEDEX_CLIENT_ID and FEDEX_CLIENT_SECRET.'),
    dhl: cap(carriers.dhl, 'No DHL API key.', 'Add DHL_API_KEY.'),
    usps: cap(carriers.usps, 'No USPS credentials.', 'Add USPS_CLIENT_ID and USPS_CLIENT_SECRET.'),
    push: cap(
      Boolean(config.push.publicKey && config.push.privateKey),
      'No VAPID keys, so no notifications can be sent.',
      'Re-run setup to generate them.',
    ),
  };
}
