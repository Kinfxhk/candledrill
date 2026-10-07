# Security policy

CandleDrill is a local, single-user tool. The server only listens on `127.0.0.1`
and rejects requests whose `Host` header is not `127.0.0.1` or `localhost`
(DNS-rebinding guard). It stores no credentials and makes no outbound network
connections.

Please report vulnerabilities privately through GitHub's "Report a vulnerability"
(security advisories) on the repository rather than in a public issue.
