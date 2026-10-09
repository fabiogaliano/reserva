# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately on GitHub: **Security → Report a vulnerability** on this repository. Only
the maintainers can see the thread. If you can't use that, contact the maintainer listed in
`package.json` and say only that you have a security report; details can follow privately.

Include the affected version, the impact, and the smallest reproduction you can manage. A proof
of concept against a local `examples/smoke-site` is ideal. Never test against someone else's
live deployment.

Expect an acknowledgement within a few days, then an assessment with a fix or a plan. There's no
bounty program, but reporters are credited in the release notes unless they'd rather not be.

## Supported versions

Reserva is pre-1.0. Only the latest minor of `@reservajs/astro` and `@reservajs/stripe` gets
security fixes.

## Scope

Reserva is self-hosted: the deployment, its Cloudflare account, database and secrets belong to
whoever runs it. In scope:

- Reading or changing a booking without its token.
- Getting a partner discount without a valid referral code, or changing the price or partner a
  booking was made with.
- Getting past `adminAuth` on the admin or operator routes, or past the same-origin and CSRF
  checks on admin forms.
- Forging or replaying a payment confirmation, a refund, or an outbound webhook signature.
- Leaking a secret, a raw booking token, a partner list, or another deployment's data through
  any response, log, error or page.
- Overselling capacity or losing a paid hold through a reachable race.

Known and documented, so not vulnerabilities:

- Manage tokens are bearer credentials: whoever has one can manage that booking. They're hashed
  at rest, expire, and the customer's is revoked on cancellation.
- Referral codes are public by design. Anyone with a partner's link gets that partner's offer.
- Without `RESERVA_CSRF_SECRET`, admin forms are protected by the Fetch-Metadata/Origin check
  alone. See [`docs/deployment.md`](./docs/deployment.md#admin-access).
- A custom `adminAuth` that lets anyone in, or a development bypass left on in production, is a
  deployment mistake, not a library flaw.
- Rate limiting for public endpoints belongs at the Cloudflare edge, not in the library.

## Dependencies

`bun run check` starts with `bun audit`, and CI runs it as a separate job, so a known advisory
in the dependencies fails the build.
