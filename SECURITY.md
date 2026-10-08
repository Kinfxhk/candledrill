# Security policy

CandleDrill is a local, single-user tool with no login. Its protections:

- **Loopback only.** The server listens on `127.0.0.1` only. The single exception is
  the container image, which listens on `0.0.0.0` inside the container (only when
  `CANDLEDRILL_CONTAINER=1`) and must be published on the host's `127.0.0.1`.
- **DNS-rebinding guard.** Requests whose `Host` header is not `127.0.0.1` or
  `localhost` are refused.
- **Cross-origin (CSRF) guard.** Every state-changing request (POST, PUT, PATCH,
  DELETE) must carry `X-CandleDrill-Token`, a random 32-byte token generated at each
  launch and served at `GET /api/token` only to CandleDrill's own origin. If a request
  carries an `Origin` header, it must be exactly `http://<Host>`; foreign, `null` and
  other-port origins are refused, as are requests marked `Sec-Fetch-Site: cross-site`
  or `same-site`. No CORS headers are sent.
- Strict Content-Security-Policy and security headers. No stored credentials and no
  outbound network connections.

Loopback is not a sandbox: other programs running under your account can reach
`127.0.0.1`. Do not expose CandleDrill to a network.

Please report vulnerabilities privately through GitHub's "Report a vulnerability"
(security advisories) on the repository rather than in a public issue.
