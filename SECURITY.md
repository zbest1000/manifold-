# Security Policy

Manifold is a **control plane**, not a passive viewer: its API can publish to
brokers (including Sparkplug commands that actuate equipment), disconnect
connections, and run network scans. Treat every deployment accordingly.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for an
unpatched vulnerability.

- Use GitHub's **[Private vulnerability reporting](https://github.com/zbest1000/manifold/security/advisories/new)**
  (Security tab → "Report a vulnerability"), or
- open a regular issue that says only "security contact requested" with no
  details, and a maintainer will arrange a private channel.

Please include: affected version/commit, a description, reproduction steps or a
proof of concept, and the impact you observed. We aim to acknowledge within a
few days and to ship a fix or mitigation as fast as the severity warrants.

## Deploying Manifold safely

Manifold ships usable-by-default, not hardened-by-default. Before exposing an
instance beyond your own machine:

- **Set `MANIFOLD_AUTH_TOKEN`** (or `MANIFOLD_TOKENS` for named, revocable,
  per-user tokens). Without a token the server binds **loopback only** and warns
  loudly; exposing an unauthenticated instance off-host requires deliberately
  setting `MANIFOLD_HOST=0.0.0.0`.
- **Use a read-only viewer token** (`MANIFOLD_VIEWER_TOKEN`) for anyone who
  should not publish, actuate, or reconfigure.
- **Keep network targets scoped.** Outbound connections (the discovery scanner
  and the i3X/CESMII/broker-admin HTTP clients) are restricted by an egress
  guard: loopback, link-local (including cloud metadata `169.254.169.254`),
  multicast, and reserved ranges are always blocked; RFC1918/LAN targets require
  `MANIFOLD_ALLOW_PRIVATE_TARGETS=1`. Only enable that on a trusted network.
- **Protect the data directory.** `profiles.json` stores broker passwords and
  admin API keys (owner-readable `0600`); restrict the host and the file.
- **Put TLS and a reverse proxy in front** of any internet-facing instance, and
  prefer network segmentation for OT deployments (IEC 62443 zones/conduits).

## Supported versions

Security fixes target the `main` branch and the latest tagged release. Older
tags are not maintained.
