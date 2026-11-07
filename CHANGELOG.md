# Changelog

Every release of ZeroStress: the site, the web layer, the supervisor, the guest image and the browser extension share
one version, kept in `VERSION`. A release is a tag `vX.Y.Z` on `main`; its notes are its section below, and the browser extension is
attached to it as `zerostress-extension-X.Y.Z.zip`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/).

How to make one: [docs/install.md](docs/install.md#versions-and-releases). Below 1.0.0 until the project is stable: fixes raise the last number, new capabilities the middle one.

Versions 0.1.0 to 0.8.0 were tagged afterwards, on 7 November 2026, on the commits where each milestone was reached
(the project had no tags before); they have no GitHub release and no extension, which first appeared in 0.9.0.

## [Unreleased]

## [0.9.0] - 2026-11-07

The agent in the browser, and releases.

### Added
- A browser extension: right-click a link and the agent opens in the side panel; the agent itself is the page `/panel` of the site, so it updates with the site. It has no host permission and reads no page.
- The side panel shows the main facts under its verdict, the screenshots of every device (opened over the panel) and a download of the report as JSON.
- An email pasted into the side panel is read there, as on the home page: its links are offered to check, the email is never sent. A link into one's own webmail inbox (Gmail, Outlook, …) is explained instead of checked: the sandbox would only see a sign-in page.
- The home page says how to get the browser agent: the extension of the site's own release and three steps to install it.
- Screenshots open over the report in a dialog (Esc or a click outside closes it) instead of taking the page away.
- Versions: one version in `VERSION` for the site, the supervisor, the packages and the extension (`deploy/release.sh set|check|tag`); the site and the supervisor report their build (`X.Y.Z`, or `X.Y.Z+N.gHASH` after a release); a release is a tag `vX.Y.Z` on `main` that publishes `zerostress-extension-X.Y.Z.zip` with its SHA-256.

### Security
- The second opinion sends at most 50 new public scans a day for the whole service, and a scan still running is polled on the next ask instead of being sent again.
- In an email, only Google's own domains count as its redirector: a link on `google.attacker.example/url?q=…` is no longer unwrapped to the address it carries.

### Fixed
- A report blamed the page for text addressed to AI assistants when only the model's own answer had tripped the detectors; the verdict still comes from the rules alone then, but the notice says what happened.
- A question typed into the panel while a check was still running was silently dropped (and so was a second link); the question is now answered after the verdict's explanation, and a second link is told to wait.
- A link right-clicked into the panel with "let the agent act" ticked ran a quick check instead of a deep one.
- After Cloudflare's "malicious" raised a verdict, the explanation still said the page had not been read; it is now asked again, and both the model and the plain explanation are told why.
- A link Cloudflare will not scan was answered with "try again shortly"; a full agent log no longer drops the second opinion's entries from the report.

## [0.8.0] - 2026-11-07

Seeing the agent work, and a way past bot walls.

### Added
- The agent log ("Behind the scenes"), live during the check and kept in the report: the microVM, the browser's steps, the detectors, each model call, the gatekeeper, the approvals, the microVM's destruction.
- A second opinion from Cloudflare's URL Scanner when a bot check keeps the sandbox out: a recent public scan of exactly that link first, a new public scan only with consent. Its "malicious" may raise the verdict, never lower it.
- Links from an email, found in the browser (the email is never sent), with a warning when a link's text shows another site, and Safe Links / Google / Facebook redirects unwrapped; `/?u=` fills the address field.

## [0.7.0] - 2026-11-07

Hardening after an architecture review.

### Security
- The guest's outgoing traffic is capped (2 MiB/s and 3000 frames/s in Firecracker's network device, 20 new connections a second on the host), and mail ports are closed to it.
- A guest process that leaves its process group no longer outlives its job or stretches its timeout.
- The injection detectors are one latch for the whole task: once they fire, no model is asked again and no action runs without approval.
- Request bodies are cut off while they are read; a start the supervisor refused costs no allowance.
- Isolation tested from inside a real guest: 19 of 19 walls hold (`deploy/test/containment-e2e.sh`).

### Fixed
- In a deep check each page is judged against its own address: a benign page no longer turned "malicious" because the agent opened a login page of another site.
- The collector waits for a page that refreshes itself (meta refresh, timers) to load before reading it.
- `./zs verify --live` requires a finished, benign run, not only a report.

## [0.6.0] - 2026-11-07

One directory, one command.

### Changed
- Everything lives in one project directory, the git checkout itself (`/zerostress`), driven by one command, `./zs`: install, update, configure, logs, verify, dev. All versions and checksums pinned in `deploy/versions.env`.
- Public documents in English (`README.md`, `docs/`), with the containment rules as a public document (`docs/containment.md`); internal notes leave the repository.

## [0.5.0] - 2026-11-06

The web client, and Pattern B on a live run.

### Added
- The web client: React pages on the main address, the server becomes an API, under a strict CSP.
- A deep check where the agent acts inside the sandbox: every risky action waits for the owner's Allow / Don't allow; shown on a live run end to end.
- CI on GitHub Actions for everything that does not need KVM.

## [0.4.0] - 2026-11-06

ZeroStress on the internet.

### Added
- The web layer on zerostress.space behind Caddy and Cloudflare: the address gatekeeper, limits per visitor, live progress, and a report in the spirit of Cloudflare Radar.
- Country and network of every server and the domain's age from local data; a phone and a tablet view; an "Explain" chat over the finished report.

## [0.3.0] - 2026-11-05

The agent.

### Added
- A verdict from deterministic rule signals first; a model on Vultr Serverless Inference (`qwen3.8-27b`, with the screenshot) may only raise it, and its answer is read strictly by its fields.
- The gatekeeper for the actions a model proposes, the task runner over the supervisor, and the report as a public and an owner view.
- The injection detectors run under a hard deadline in a worker thread, with their rules as checked data files.

## [0.2.0] - 2026-11-04

Evidence, and defences against the page talking to the model.

### Added
- The evidence collector inside the guest (Playwright over a raw CDP session): redirects and why they happened, TLS, every request with its address, forms and what they ask for, downloads, dialogs, screenshots.
- Artifacts handed over from the guest to the host and verified.
- Deterministic prompt-injection detectors on every piece of untrusted text: normalisation, decoding layers, cutting.

## [0.1.0] - 2026-11-04

The sandbox.

### Added
- One disposable Firecracker microVM per check, booted from a clean read-only image and destroyed afterwards, each as a systemd unit through a root helper.
- A reproducible guest image (Ubuntu, Chromium headless shell) and a small guest agent over vsock.
- The supervisor in Go on the standard library only: a queue, slots, interactive sessions, commands with a risk by type, and approvals bound to the command's hash.
- The guest network closed to the host, internal ranges and the cloud metadata address; two guests cannot see each other.
