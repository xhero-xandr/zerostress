# Changelog

Every release of ZeroStress: the site, the web layer, the supervisor, the guest image and the browser extension share
one version, kept in `VERSION`. A release is a tag `vX.Y.Z` on `main`; its notes are its section below, and the browser extension is
attached to it as `zerostress-extension-X.Y.Z.zip`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/).

How to make one: [docs/install.md](docs/install.md#versions-and-releases). Below 1.0.0 until the project is stable: fixes raise the last number, new capabilities the middle one.

Versions 0.1.0 to 0.8.0 were tagged afterwards, on 7 November 2026, on the commits where each milestone was reached
(the project had no tags before); they have no GitHub release and no extension, which first appeared in 0.9.0.

## [Unreleased]

### Added

- A file's own words are read for what it can do, without running it: a macro that starts programs, fetches files from the internet, binds keys or types keystrokes; a program that names functions to write into other programs or to watch the keyboard; a miner's pool or algorithm in a program, script or page; AutoHotkey and AutoIt files count as scripts. Each is a signal of its own weight in the report.
- The host measures how much processor time each microVM used (systemd's accounting of its unit, read once a second and once more before the VM stops), keeps it in the run's record (`vm_cpu`: total and last three seconds) and the agent's log shows it under "Behind the scenes". The guest cannot influence it. It is only recorded for now: what counts as a busy page (a coin miner keeps the processor busy) is decided after looking at real runs.

- The report says when the final address is the home of a widely visited website (among the 1,000, 10,000 or 100,000 most visited), from the top of the [Tranco](https://tranco-list.eu) list kept on the host (`TRANCO_DIR`, fetched by the installer, refreshed when older than six days). It is a remark that costs no points and never lowers a verdict: it says whose address it is, not that the page is safe. A name on a site (`docs.google.com`, `x.s3.amazonaws.com`) and a name on a free hosting service are not counted, and nothing leaves the machine at lookup time. The list is not in git (the site states no licence for it).

- An MCP server for AI agents ([mcp/](mcp/README.md), no dependencies, over standard input and output): `zerostress_check_link`, `zerostress_check_email_links`, `zerostress_check_file` and `zerostress_get_result`. An agent gets the verdict, our advice for it, the signals and the report link before it opens, fetches or recommends something. It cannot approve a risky action (the task key is never returned or sent and the checks offered never ask for a decision); what a page, a sender or the model said comes back only under `untrusted_text`; files are sent only from the one folder the person names, at most 10 MiB, with links that lead out refused. 33 mutations, a test against the official client of the protocol.
- The model is told that `popular_site` says whose address it is, not that the page is safe: it had begun to give it as a reason for a benign verdict.
- The terms have a short section for owners of the sites we open: where to write if a site wants to be left alone.
- The web layer's shared plumbing (answers, bodies read up to a limit, the same-page check, asks a minute) lives in `web/server/http.ts`, and the three routes that start a run share their two refusals; behaviour is unchanged. Three mutation checks of the chat (a running task, the two kinds of kept explanation) had stopped matching the code and were not applied; they match again and are caught, and nine more cover the new file.

### Security
- The guest image is attached read-only and shared by every microVM; a run writes only to an empty scratch disk of its own (`SUP_SCRATCH_MIB`, 1024 by default), which the guest lays over the image at boot (`zerostress-init`, overlayfs) and which is deleted with the run. Before, every run copied the 5 GiB image and could write up to about 3.5 GiB to the host; now a run writes at most its scratch disk, and starts faster with no copy. `containment-e2e.sh` fills the disk to the end. The installed image is replaced by a rename, never in place.
- The guest image is built reproducibly: packages from a pinned snapshot of the Ubuntu archive (`GUEST_UBUNTU_SNAPSHOT`, the installed list kept as `packages.txt`), Chrome Headless Shell checked against a pinned hash, and every build step in namespaces of its own with a private `/dev` of a few devices instead of the host's.
- Firecracker no longer runs as the supervisor's user. Each slot has a user of its own (`zerostress-vm0` to `zerostress-vm3`), which owns nothing but its run directory (handed to the slot's group by the supervisor before boot) and its tap; the microVM's unit shows it an empty `/zerostress` with only the binaries, the kernel and that directory, and `ProtectProc=invisible`. Before, an escape into the Firecracker process reached the supervisor's API (and could approve its own risky commands), other microVMs' directories, the supervisor's state and settings, and could signal the supervisor. `deploy/test/zsvm-isolation.sh` checks all of it from inside the very sandbox Firecracker gets; `./zs verify` checks the users.
- A microVM whose unit does not end when stopped keeps its slot until it does: the next run of the slot (same user, since Firecracker runs as the slot's user) waits instead. `/v1/health` counts such slots (`quarantined`) and is no longer always `ok`; `./zs verify` checks it.
- The injection detectors tell a text they could not inspect from one that spoke to a model. A thread that ran out of time or died, or a string or event too large to inspect, still keeps the text and the model apart (rules only), but it no longer counts as an injection attempt: no signal raises the verdict, and the report says that part of the page could not be checked, not that it addressed an automated reader. Findings of a thread that had to be replaced are kept.
- Every text of ours that goes through the detectors (the dossier, the model's words, chat questions and answers, a second opinion's title) is scanned in a worker thread with a deadline, like the page's events; before, they were scanned in the web layer's own thread with no limit, where a runaway pattern could hold every request.
- `./zs install host` closes SSH to keys only, with no root login (`deploy/files/etc/ssh/sshd_config.d/00-zerostress-harden.conf`), but only when a user besides root has an authorized key, so a fresh host cannot lock its owner out; `./zs verify` checks the effective settings.

### Changed
- One vCPU per microVM by default (`SUP_VCPU=1`, was 2). Measured with the real collector on heavy sites: with three checks at once on the 2-vCPU host a check finishes 3 to 7 seconds sooner and boots faster, a single check on an idle host is 5 to 15% slower, and one guest can no longer take both host CPUs from the site and the other microVMs.
- The Chrome Web Store's own id frames the panel too, alongside the one the manifest's public key fixes: the store strips that key, so it assigns the extension an id of its own.
- The deep-check box is now "Let the agent explore the page" and says how it differs from a normal check, on the home page and in the extension's side panel.
- The rules, the report and the model's dossier read three things the same way: a blocked request (a reason given as text), the other sites a visit contacted (distinct hosts, not the page's own) and a password form that sends to another site (compared by site; the collector's flag only when there is nothing to compare). Before, the signal and the report could disagree.
- `./zs install` prepares what the browser check of the whole thing needs (`web/tools/panel-check.mjs`): Chromium's system libraries, Playwright's Chromium for the code owner and the extension build; `./zs verify` checks them. The host step gives the administrators (members of the group `wheel` or `sudo`, or `ADMIN_USER`) access to the checkout by ACL and sets the repository's author; no login name is guessed.
- The shapes of the site's HTTP API live in one file, `web/shared/api-types.ts`: the server builds every success answer from them and the client reads them, so a field renamed on one side stops the type check on the other. Before, the client kept its own copies of the stage, the status, the demo, the sender, the file verdict, the chat answer and the pending decisions.

### Fixed
- `./zs install host` now installs `squashfs-tools` (its `unsquashfs` is not part of a minimal Rocky 10 install, and the guest image build needs it) and adds the project directory to git's `safe.directory`, so the image manifest's `repo_commit` is a real commit instead of `"unknown"` when the build runs as root. Verified end to end on a clean Vultr instance; both had only ever been fixed by hand on the long-lived server.
- The tests follow the code: the containment test takes the vCPU count from `SUP_VCPU`, `collector-e2e` expects a downloaded file to stay in the guest, and `supervisor-sessions-e2e` reads the log file the service really writes (two of its checks passed on an empty journal). `deploy/test/supervisor-suite.sh` runs the three supervisor suites in one go and puts everything back.
- The Go mutation checks cover 58 protective steps instead of 13 (approvals, command risk and size, slot quarantine, session slots and ranges, settings checks, hard timeout, request limits, run ids, how a record is written, and the guest agent's process groups, kill sweeps, limits and environment); a new test pins the mode of the records and their replacement by rename. Seven stale entries of the web layer's mutation list were rewritten, and the mutation tool handles code that exists in several copies. `deploy/test/constants-check.sh` checks that the values several parts repeat (slots, vsock port, session limits, artifact size, deadlines) agree.

## [0.9.1] - 2026-11-08

### Added
- One field on the home page and in the side panel for a link, an email or a file (dropped, pasted or picked; an `.eml` is read as an email). What it is, is told in the browser by fixed rules and said ("Understood as: …") before anything is sent; the three tabs are gone. The home page's texts say what is checked now: emails, files, Cloudflare and the reputation sources.
- Files: an email's attachment, or a file picked on the home page ("A file"), is checked. Its SHA-256 is computed in the browser and only the hash is sent first, to ask VirusTotal (one lookup a minute is kept for files). "Open in a sandbox" sends the file: the server holds it in memory only, under a one-time address, until the microVM fetches it (at most five minutes), and keeps no copy; the download into the sandbox is approved by that click and by nothing else. Inside the microVM the collector reads it: its real type by content, a name that hides it, macros and macros that start on opening, remote templates, DDE, embedded objects, PDF code, actions, launches, embedded files and forms, programs and locked archives, disk images, shortcuts, HTML smuggling, SVG code, and in an attached page a sign-in form, a form or redirect to another site, hidden code; the addresses written in it are asked of Google Safe Browsing. An attached web page is also opened in the sandbox as a page (served once, in a `sandbox` CSP without this site's origin), with every rule and the vision model. The report shows the file, what was found, the names inside an archive and the addresses in it as text. A file downloaded in a deep check is read the same way and no longer copied out of the sandbox.
- What others already know, asked without opening anything: Google Safe Browsing (the address and where it led), Spamhaus DBL and VirusTotal (the domain, also an email sender's). A listing adds a signal that can only raise the verdict; the report shows each source; a page behind a wall that nobody knows anything bad about, and that Cloudflare saw clean, is said to be so.
- Who sent an email: the sender's domain (only the domain is sent) is looked up for its age, its DMARC policy and SPF, whether it imitates a brand or is a free mailbox; the email warns when the sender calls itself a brand it does not write from, when the domain is a lookalike or brand-new, or publishes no mail policy.
- `web/tools/quality.mjs`: the quality of the analysis on real walled sites and live phishing (OpenPhish), through the whole pipeline.
- "Check all links in one sandbox" for an email: one microVM opens our page that lists the email's links (each through the gate; unsubscribe links left out; at most ten), the agent opens each in turn with safe commands only, takes a screenshot, comes back for the next, and each link is judged on its own by the rules and the vision model. The report is the worst link, with every link listed (verdict, where it led, password forms, downloads, redirects, its screenshot). Only the links are sent, never the email.
- Examples under the address field include Google's phishing test page and "A file to approve", which ticks "Let the agent act on the page" so the Allow / Don't allow step can be seen (`WEB_DEMOS` takes `label|url|deep`).
- A page behind a bot wall gets Cloudflare's second opinion on its own, with nothing to press: a recent public scan of the same address, or else a new unlisted scan (not in Cloudflare's public search, so nobody's consent is needed). The report and the side panel update when it answers.
- A bare address (`google.com`, `vk.com/id1`) is taken as a link in the side panel and on the home page.
- Email checks, in the browser: the source of an email ("Show original") is read as MIME (base64, quoted-printable, charsets, attachments, forwarded emails), and the email itself is checked: what the receiving server recorded about the sender (SPF, DKIM, DMARC), replies to another domain, a sender name that shows another address, risky attachments (programs, web pages, macros, archives), links whose text shows another site. The side panel takes a pasted email with its line breaks.
- A privacy policy and terms of use, at `/privacy` and `/terms` (from `docs/privacy.md` and `docs/terms.md`), linked from the footer.
- A safe demo page, `/demo/shared-file`, that offers a harmless text file: a deep check of it has a download to ask the owner about (Pattern B on camera).

### Changed
- Small fixes from the review of 7 November: an API answer for something that does not exist says `not_found`, not `bad_request`; the nonce around untrusted data is random bytes; the limiter forgets clients whose windows have all run out; two people opening the explanation of one report at once share one model call; the agent's log says "could not be checked in time" apart from "text aimed at an AI"; a run record changes in memory only once it is on disk; the supervisor's health tells an image installed while it runs; leftover microVMs are stopped when the supervisor stops.
- The owner's key leaves the address bar as soon as the report opens and is kept by the tab (sessionStorage), so an address copied by hand no longer carries the right to decide; a link with the key still works when opened, and where the tab cannot keep it, the key stays in the address.
- The browser extension says what it checks now: its name and description name emails and files, which the side panel takes (pasted, dropped or picked) since the panel became one field.
- The code and every build belong to a new account, `zerostress`, with no sudo and no login, instead of the server's administrator; `./zs install` and `./zs update` give back any file written as root, and `./zs verify` checks both. The logs are root's only. `web/tools/panel-check.mjs` runs a deep check through the extension.
- In a deep check the model is asked to propose a download when a page offers a file (the person still decides), so that the file itself becomes evidence.

### Fixed
- A file handed over is named as one: the model is told it was uploaded (it spoke of "the link" that led to it), the page in an attached file "is a file someone sent, not Microsoft's site" instead of naming our address, and an uploaded `.docm` is judged by what is in it, not as "offered for download".
- A site that kept the sandbox out, about which Google, Spamhaus and VirusTotal know nothing bad and whose page Cloudflare saw clean, is headed "Nothing known against it" instead of "Could not check"; the verdict itself stays "could not check".
- A name of one's own on a hosting service (alice.github.io, x.vercel.app, y.pages.dev, a blogspot or HostGator site) is a site of its own, and a country's usual second level (com.et, co.th) is a suffix: the domain's age and Google, Spamhaus, VirusTotal and urlscan.io were asked about the whole service (vercel.app is years old and has other people's scans) instead of the site. Such a name belongs to no brand, so paypal.vercel.app is not PayPal's own site.
- A brand's name in such a name (instagram-clone-x.vercel.app, paypal-verify.netlify.app) is a reason (`brand_on_shared_host`, medium), whatever the page shows that time; one name alone on github.io (an organisation's project pages) is not.
- A site that moves the visitor to a verification page of its own (temu.com's `/bgn_verification.html`, `/captcha/`, `/challenge`) with nothing else on it, or titled "Security verification", is a wall, not a page the model judges as blank; invisible characters (zero-width spaces) do not count as text.
- wellsfargo.com was "malicious": a password sent to another host of the same site (connect.secure.wellsfargo.com) counted as "another site", and "purchase" in the page text named Chase. Forms are compared by site; brand names in the text are whole words; a brand's own site may name other brands.
- Bot walls in other languages are recognised (VK's "Проверяем, что вы не робот", Cloudflare's translated "Just a moment"), so such a page is "could not check" with Cloudflare's second opinion, not a verdict on a captcha. One owner's sites under two top-level domains (vk.com and vk.ru) are not "a phone sent elsewhere". The side panel tells a second opinion that was ready before the report was read.
- A sign-in form that only phones see no longer makes a big site "malicious" (tiktok.com was): it counts as cloaking when the form sends the password to another site, the phone lands elsewhere, or the domain is young; on an old domain with the form on the site itself it is told (`mobile_sign_in`, info) and not counted.
- The agent log no longer says the model "proposes" an action after the microVM is gone (the last verdict has nothing to act on).
- The home page said a form submit waits for approval; a download does, and a form is never sent.
- The extension’s description fits the Chrome Web Store limit (132 characters), and a release also carries a store package without the manifest’s `key`, which the store refuses.
- A report with no rule finding said "Nothing unusual was recorded" next to a verdict the model or Cloudflare had raised; it now says who raised it.
- The home page said a deep check waits for approval before "sending a form"; the model can never send a form, and a download is what waits for approval.

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
- The explanation of a benign report was mostly our fixed text: the model wrote "the verdict is benign", which the detectors set aside (3 of 4 answers on a real report); both prompts now ask for the verdict in plain words (0 of 4).
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
