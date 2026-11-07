# Changelog

Every release of ZeroStress: the site, the web layer, the supervisor, the guest image and the browser extension share
one version. A release is a tag `vX.Y.Z` on `main`; its notes are its section below, and the browser extension is
attached to it as `zerostress-extension.zip`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/).

How to make one: [docs/install.md](docs/install.md#releases).

## [Unreleased]

## [0.9.0] - 2026-11-07

The first tagged release: everything built for the Vultr: Agent Rush hackathon up to the day before submission.

### Added
- One disposable Firecracker microVM per check, booted from a clean read-only image and destroyed afterwards, driven by a Go supervisor that uses the standard library only.
- An evidence collector inside the guest (Playwright over a raw CDP session): redirects and why they happened, TLS, every request with its address, forms and what they ask for, downloads, dialogs, a phone and a tablet view, screenshots.
- A verdict from deterministic rules first; a model on Vultr Serverless Inference (`qwen3.8-27b`, with the screenshot) may only raise it.
- Deterministic prompt-injection detectors on every piece of untrusted text, as one latch for the whole task.
- A deep check where the agent acts inside the sandbox; every risky action waits for the owner's Allow / Don't allow.
- The agent log ("Behind the scenes"), live during the check and kept in the report: the microVM, the browser's steps, the detectors, each model call, the gatekeeper, the approvals, the microVM's destruction.
- A second opinion from Cloudflare's URL Scanner when a bot check keeps the sandbox out: a recent public scan of exactly that link first, a new public scan only with consent.
- Links from an email, found in the browser (the email is never sent), with a warning when a link's text shows another site, and Safe Links / Google / Facebook redirects unwrapped.
- A browser extension: right-click a link and the agent opens in the side panel; the agent itself is the page `/panel` of the site, so it updates with the site.
- An "Explain" chat over the finished report.
- One command, `./zs`, to install, update, configure and verify a host; all versions and checksums pinned in `deploy/versions.env`.

### Security
- The guest network is closed to the host, internal ranges and the cloud metadata address; its outgoing traffic is capped (2 MiB/s and 3000 frames/s in Firecracker's network device, 20 new connections a second on the host), and mail ports are closed.
- A guest process that leaves its process group no longer outlives its job or stretches its timeout.
- Request bodies are cut off while they are read; a start the supervisor refused costs no allowance.
- Isolation tested from inside a real guest: 19 of 19 walls hold (`deploy/test/containment-e2e.sh`).
