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
- The home page says how to get the browser agent: the latest release's zip and three steps to install it.
- An "Explain" chat over the finished report.
- One command, `./zs`, to install, update, configure and verify a host; all versions and checksums pinned in `deploy/versions.env`.

### Security
- The guest network is closed to the host, internal ranges and the cloud metadata address; its outgoing traffic is capped (2 MiB/s and 3000 frames/s in Firecracker's network device, 20 new connections a second on the host), and mail ports are closed.
- A guest process that leaves its process group no longer outlives its job or stretches its timeout.
- Request bodies are cut off while they are read; a start the supervisor refused costs no allowance.
- Isolation tested from inside a real guest: 19 of 19 walls hold (`deploy/test/containment-e2e.sh`).
- The second opinion sends at most 50 new public scans a day for the whole service, and a scan still running is polled on the next ask instead of being sent again.
- In an email, only Google's own domains count as its redirector: a link on `google.attacker.example/url?q=…` is no longer unwrapped to the address it carries.

### Fixed
- A report blamed the page for text addressed to AI assistants when only the model's own answer had tripped the detectors; the verdict still comes from the rules alone then, but the notice says what happened.
- A link right-clicked into the panel with "let the agent act" ticked ran a quick check instead of a deep one.
- After Cloudflare's "malicious" raised a verdict, the explanation still said the page had not been read; it is now asked again, and both the model and the plain explanation are told why.
- A link Cloudflare will not scan was answered with "try again shortly"; a full agent log no longer drops the second opinion's entries from the report.
