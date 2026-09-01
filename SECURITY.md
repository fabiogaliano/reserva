# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. That opens a private thread visible only to the
maintainers. If you cannot use it, contact the maintainer listed in `package.json` directly
and say only that you have a security report; details can follow on a private channel.

Please include what you have: affected version, a description of the impact, and the smallest
reproduction you can manage. A proof of concept against a local `examples/smoke-site` is ideal
— never test against someone else's live deployment.

You can expect an acknowledgement within a few days and an assessment with a fix or mitigation
plan after triage. Reserva is a small project; there is no bounty program, but reporters are
credited in the release notes unless they ask not to be.

## Supported versions

Reserva is pre-1.0. Only the latest published minor of each package
(`@reservajs/astro`, `@reservajs/stripe`) receives security fixes.

## Scope

Reserva is a self-hosted library: the deployment, its Cloudflare account, its D1 database, and
its secrets belong to whoever runs it. In scope for a report:

- Anything that lets an unauthenticated caller read or mutate a booking they do not hold a
  token for.
- Anything that bypasses the `adminAuth` gate on the admin or operator routes, or the
  same-origin/CSRF layer on admin mutations.
- Forging or replaying a payment confirmation, a refund, or an outbound webhook signature.
- Leaking a secret, a raw booking token, or another deployment's data through any response,
  log, error message, or rendered page.
- Overselling capacity or losing a paid hold through a reachable race.

Known and documented, so not vulnerabilities in themselves:

- Booking manage tokens are bearer credentials by design; whoever holds one has that role for
  that one booking. They are hashed at rest, expire, and are revoked on cancellation.
- Without `RESERVA_CSRF_SECRET` configured, the CSRF token layer is deliberately offline and
  admin mutations are protected by the Fetch-Metadata/Origin check alone. This is documented in
  the README.
- A custom `adminAuth` that returns an anonymous identity (or an unconditional development
  bypass left enabled in production) is a deployment configuration mistake, not a library
  flaw — the README calls both out.
- Rate limiting for public endpoints is expected at the Cloudflare edge, not in the library.

## Dependencies

`bun run check` starts with `bun audit`, and CI runs it as an independent job, so a known
advisory in the dependency tree fails the build rather than shipping quietly.
