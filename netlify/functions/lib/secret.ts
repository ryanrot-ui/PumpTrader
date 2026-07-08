/**
 * Shared secret protecting the engine-runner-background endpoint (it is
 * publicly routable like every Netlify Function). ENGINE_CRON_SECRET can be
 * set explicitly; NEXTAUTH_SECRET — always configured — is the default.
 */
export function engineRunnerSecret(): string {
  const secret = process.env.ENGINE_CRON_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      "ENGINE_CRON_SECRET or NEXTAUTH_SECRET must be set — the engine runner endpoint cannot be left unauthenticated."
    );
  }
  return secret;
}
