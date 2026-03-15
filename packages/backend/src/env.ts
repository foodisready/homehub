/**
 * Validate required environment variables on startup.
 * Exits with a clear error message if anything is missing or still set to a
 * placeholder value from .env.example.
 */

const REQUIRED: { key: string; hint: string }[] = [
  { key: 'JWT_SECRET',         hint: 'openssl rand -base64 32' },
  { key: 'JWT_REFRESH_SECRET', hint: 'openssl rand -base64 32' },
  { key: 'ADMIN_PASSWORD',     hint: 'set to your admin password' },
  { key: 'INTERNAL_API_KEY',   hint: 'openssl rand -base64 32' },
];

const PLACEHOLDER_PREFIX = 'change-me';

export function validateEnv(): void {
  const problems: string[] = [];

  for (const { key, hint } of REQUIRED) {
    const val = process.env[key];
    if (!val) {
      problems.push(`  ${key} is not set  (${hint})`);
    } else if (val.startsWith(PLACEHOLDER_PREFIX)) {
      problems.push(`  ${key} is still the placeholder value  (${hint})`);
    }
  }

  if (problems.length > 0) {
    console.error(
      '\n[HomeHub] Cannot start — required environment variables are missing or unconfigured:\n' +
      problems.join('\n') +
      '\n\nCopy .env.example to .env and fill in all values before starting.\n'
    );
    process.exit(1);
  }
}
