/**
 * Validate required environment variables on startup.
 * Exits with a clear error message if anything is missing or still set to a
 * placeholder value from .env.example.
 *
 * loadSecrets() runs first and fills these from the data volume, so this only
 * fails if that couldn't happen. ADMIN_PASSWORD is optional: without it, the
 * first visit to HomeHub asks for an admin account.
 */

const HINT = 'normally generated in the data volume; check that HomeHub can write to it';
const REQUIRED: { key: string; hint: string }[] = [
  { key: 'JWT_SECRET',         hint: HINT },
  { key: 'JWT_REFRESH_SECRET', hint: HINT },
  { key: 'INTERNAL_API_KEY',   hint: HINT },
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
      '\n'
    );
    process.exit(1);
  }
}
