/**
 * Sending settings for the email services most people use, so Settings →
 * Integrations → Email alerts can fill them in from the address. Each needs an
 * app password: these services refuse a normal password from apps.
 *
 * Outlook.com (and Hotmail, Live, MSN) and Proton Mail are listed so HomeHub
 * can say plainly that they won't work: Outlook.com accepts only an OAuth
 * sign-in from apps since 2024, and Proton only sends through its Bridge app
 * or business plans.
 */

export interface MailProvider {
  name: string;
  host?: string;
  port?: number;
  /** true: SSL from the start (465). false: STARTTLS (587). */
  secure?: boolean;
  /** Where the app password is made, and what's needed first. */
  passwordUrl?: string;
  passwordNote?: string;
  /** Set when the service can't be used from HomeHub. */
  unsupported?: string;
}

const GMAIL: MailProvider = {
  name: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true,
  passwordUrl: 'https://myaccount.google.com/apppasswords',
  passwordNote: 'Your Google account needs 2-Step Verification turned on first.',
};
const YAHOO: MailProvider = {
  name: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', port: 465, secure: true,
  passwordUrl: 'https://login.yahoo.com/account/security',
  passwordNote: 'Turn on 2-step verification there, then choose "Generate app password".',
};
const AOL: MailProvider = {
  name: 'AOL Mail', host: 'smtp.aol.com', port: 465, secure: true,
  passwordUrl: 'https://login.aol.com/account/security',
  passwordNote: 'Turn on 2-step verification there, then choose "Generate app password".',
};
const ICLOUD: MailProvider = {
  name: 'iCloud Mail', host: 'smtp.mail.me.com', port: 587, secure: false,
  passwordUrl: 'https://account.apple.com',
  passwordNote: 'Sign in, open Sign-In and Security, then App-Specific Passwords. The username is your full iCloud address.',
};
const OUTLOOK: MailProvider = {
  name: 'Outlook.com',
  unsupported: "Outlook.com, Hotmail and Live addresses can't send from HomeHub: Microsoft no longer accepts passwords from apps like it, even app passwords. Use a Gmail, Yahoo or iCloud address to send. Alerts can still go to your Outlook address as a recipient.",
};
const PROTON: MailProvider = {
  name: 'Proton Mail',
  unsupported: "Proton Mail addresses can't send from HomeHub without Proton's Bridge app or a business plan. Use a Gmail, Yahoo or iCloud address to send. Alerts can still go to your Proton address as a recipient.",
};

const BY_DOMAIN: Record<string, MailProvider> = {
  'gmail.com': GMAIL, 'googlemail.com': GMAIL,
  'yahoo.com': YAHOO, 'ymail.com': YAHOO, 'rocketmail.com': YAHOO,
  'yahoo.co.uk': YAHOO, 'yahoo.ca': YAHOO, 'yahoo.com.au': YAHOO, 'yahoo.fr': YAHOO, 'yahoo.de': YAHOO,
  'aol.com': AOL, 'aim.com': AOL,
  'icloud.com': ICLOUD, 'me.com': ICLOUD, 'mac.com': ICLOUD,
  'outlook.com': OUTLOOK, 'hotmail.com': OUTLOOK, 'live.com': OUTLOOK, 'msn.com': OUTLOOK,
  'hotmail.co.uk': OUTLOOK, 'outlook.co.uk': OUTLOOK, 'live.ca': OUTLOOK,
  'proton.me': PROTON, 'protonmail.com': PROTON, 'pm.me': PROTON,
};

/** The service an address belongs to, if it's one HomeHub knows. */
export function providerForAddress(address: string): MailProvider | null {
  const domain = address.trim().toLowerCase().split('@')[1];
  return (domain && BY_DOMAIN[domain]) || null;
}

/** The service whose server this is, for showing its app password note. */
export function providerForHost(host: string): MailProvider | null {
  const h = host.trim().toLowerCase();
  return Object.values(BY_DOMAIN).find((p) => p.host === h) ?? null;
}

