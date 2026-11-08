# ZeroStress

**Open a suspicious link or attachment without opening it on your own machine.**

ZeroStress runs the target inside a disposable Firecracker micro-VM, drives a real browser through it, collects evidence of what the page actually does, and hands back a verdict with proof — a redirect chain, the certificate, the network requests, the forms and what they ask for, a screenshot. Nothing risky ever reaches your device, and nothing the page does ever reaches the host: the micro-VM is destroyed after every check.

Built for the [Vultr: Agent Rush](https://lablab.ai/ai-hackathons/vultr-hackathon/) hackathon, Track 1 ("Blast Radius Zero"), Pattern B: goal → plan → a real browser in a sandbox → a vision-capable model reviews what it saw → a human approves anything risky.

Live at **[zerostress.space](https://zerostress.space)**.

## What you get

Paste a link, and the report shows:

- **A verdict** (benign / suspicious / malicious) with a confidence level, built from deterministic rules first; a model may only raise that verdict, never lower it.
- **Network evidence**: the redirect chain and why each hop happened, the TLS certificate, every request with its IP, country and network (ASN), third-party hosts.
- **The domain's age** (via RDAP) — a domain registered days ago is treated differently from one registered a decade ago.
- **Forms and what they ask for** (password, card number, one-time code, ...) and where the data actually goes, in plain words, not the page's own.
- **A phone and a tablet view**, captured next to the desktop one — some pages serve a password prompt or a different site only to a mobile device.
- **A screenshot**, as proof of what the browser actually saw.
- **An "Explain" button and a chat** about the finished report — the assistant can only talk about evidence that is already in the report; it has no access to the sandbox, the model that produced the verdict, or any action that changes anything.

A risky action a human asks the agent to take — submit a form, download a file — always waits for that human's explicit approval first; the agent never approves itself.

## Vultr services used

| Service | What it does here |
|---|---|
| **Vultr Cloud Compute** (one VM with nested virtualisation) | The whole backend: the Go supervisor that boots a fresh Firecracker microVM for every check, the unprivileged web layer and agent, and Caddy for TLS. `/dev/kvm` from nested virtualisation is what makes a microVM per task possible on a cloud VM. |
| **Vultr Serverless Inference** (OpenAI-compatible API) | Every model call the agent makes: reading the collected evidence, proposing the next safe step of a deep check, possibly raising the verdict, and the "Explain" chat. The model (`qwen3.8-27b`) was chosen by a benchmark on the live service. The key stays in the host's service environment and never enters a microVM. |

## A walk-through

1. You get an email with a link that "confirms your delivery". Instead of clicking it, you paste it into [zerostress.space](https://zerostress.space).
2. A gatekeeper checks the address, and a fresh microVM boots. Progress streams to the page stage by stage.
3. About 15 seconds later (the average on live phishing links) the report is ready. In this example it says *Dangerous*, because the link went through three redirects to a two-day-old domain hosting a password and card-number form that posts to a third host. The screenshot shows what the browser saw; the phone view shows the same form.
4. "Explain" opens a chat that answers in plain words from that evidence only, and points at the signals it relies on.
5. With a deep check, the agent may go one step further inside the same microVM, for example by trying the form with dummy data. A risky step like that pauses until *you* approve it, using the private link only the task's owner holds; a shared report link can read but never approve.
6. Whatever happened, the microVM is destroyed. Nothing from the page touched your device or the host.

## Browser extension, email and files

- **The agent in your browser** ([web/extension/](web/extension/), Manifest V3, Chrome, Edge, Brave): right-click a suspicious link and choose *Check this link in a sandbox*. A side panel opens with the agent: it starts the check on ZeroStress (the same microVM, the same rules and model), tells you step by step what happens in the sandbox, **stops and asks Allow / Don't allow before any risky action**, gives the verdict and explains it, and answers your questions about it. The agent is the page `/panel` of the site, so it updates with the site; the extension is only the menu and the frame, has no host permission and reads no page you visit. Install: download `zerostress-extension-X.Y.Z.zip` from the [release](https://github.com/xhero-xandr/zerostress/releases) of the version you run (the site's home page links to its own), unzip it, then `chrome://extensions` → *Developer mode* → *Load unpacked*.
- **Email**: on the home page choose *An email* and paste the email's text or its source. It is read in your browser and never sent anywhere. A link whose text shows another site is marked, and Safe Links / Google / Facebook redirects are unwrapped to where a click really goes. The sender's domain (only the domain) is looked up: its age, its DMARC and SPF, whether it imitates a brand or is a free mailbox. Check one link, or all of them at once: one microVM opens them one after another, each judged on its own.
- **Files**: an email's attachment, or a file you pick (*A file*, up to 10 MB). Its SHA-256 is computed in your browser and only that is sent first, to ask VirusTotal. *Open in a sandbox* sends the file; the server holds it in memory, never on disk, until the microVM fetches it once (five minutes at most), and the file is read only inside the microVM: its real type, a disguised name, macros that start on opening, remote templates, DDE, PDF code and actions, programs or locked archives, HTML smuggling, SVG code, the addresses in it. An attached web page is also opened in the sandbox as a page, with every rule and the vision model. Only the findings leave the sandbox.
- **What others already know**: Google Safe Browsing, Spamhaus DBL, VirusTotal and urlscan.io are asked about the address, its domain and an email sender's domain. A listing can raise the verdict, never lower it.
- **Second opinion**: when a bot check keeps our sandbox out, ZeroStress does not try to get past it: it asks Cloudflare's URL Scanner on its own. A recent public scan of exactly that link is looked up first; otherwise a new scan is sent as unlisted (it stays in our Cloudflare account, out of Cloudflare's public search). Its "malicious" may raise our verdict, never lower it.
- **Behind the scenes**: every report has the agent's log, live during the check: the microVM booting (vCPUs, memory, guest image), the browser's steps, the injection detectors, each model call (vision, time, tokens), the gatekeeper's decisions, your approvals, the microVM's destruction.

## How it works

1. A gatekeeper checks the submitted address (scheme, size, no internal or cloud-metadata addresses) before anything runs.
2. A Go supervisor starts a one-shot Firecracker micro-VM from a prebuilt, read-only disk image.
3. A collector inside the micro-VM (Node.js, Playwright, driven over the Chrome DevTools Protocol so client-side redirects aren't invisible) opens the target in a sandboxed, unprivileged Chromium and reports every request, redirect, form, download attempt, and dialog as it happens.
4. Deterministic rules turn that evidence into signals; a Vultr Serverless Inference model may add to the plan or raise the verdict, never lower it below what the rules found.
5. The report is built from a fixed list of fields — anything the page, the submitter, or the model wrote is escaped and clearly marked as untrusted text, never trusted as a size, a boolean, or a command.
6. The micro-VM is destroyed, whatever happened.

## Containment

The hackathon's own containment checklist, the way this project meets it:

| Requirement | How |
|---|---|
| Process isolation | One Firecracker micro-VM per task; Chromium runs as an unprivileged guest user with its own sandbox enabled (no `--no-sandbox`) |
| Secret hygiene | API keys live only in the host's service environment; never copied into the guest image or a micro-VM |
| Resource limits | vCPU, memory, task time, and download size are capped per run; so is what a guest sends (2 MiB/s in Firecracker's network device) and how fast it opens new connections; mail ports are closed |
| Lifecycle | A clean disk image per task; the micro-VM is torn down after every run, including on error or timeout |

Verified from *inside* a real guest, as the same unprivileged user the browser runs as (`deploy/test/containment-e2e.sh`): no write access outside the task, no secrets on disk or in any readable environment, no shared mounts, no route to the host, the cloud metadata address, or the host's gateway.

The full set of nine rules every change must keep is in [docs/containment.md](docs/containment.md).

Untrusted input (page text, OCR, file names) is treated as data a model reads, never as instructions it follows; a model can only push a verdict up, never down; deterministic hooks scan every piece of untrusted text before and after a model call and can fall back to rules-only on their own.

## Stack

| Layer | Choice |
|---|---|
| Host | Rocky Linux 10, Firecracker, KVM, SELinux Enforcing |
| Guest image | Ubuntu 24.04, Node.js 24, Playwright 1.65.0, Chrome Headless Shell |
| Supervisor (privileged) | Go, standard library only — microVM lifecycle, queueing, sessions, artifacts, over a Unix socket |
| Collector (in the guest) | Node.js, Playwright + a raw CDP session |
| Web layer and agent (unprivileged) | Node.js 24, TypeScript (type-stripping, no build step), [Hono](https://hono.dev/) |
| Interface | React 19, React Router 8, TanStack Query, Tailwind CSS 4, built with Vite; strict CSP, no inline scripts or styles |
| Model | Vultr Serverless Inference, OpenAI-compatible, a thin `fetch` client with a strict response schema — no SDK |
| Proxy / TLS | Caddy |

## Where things live

The directory a piece of code sits in tells you its privilege level and where it actually runs — that's the organizing rule, not the language:

| Directory | What's in it | Where it runs |
|---|---|---|
| `supervisor/` | Go, standard library only: microVM lifecycle, the queue, sessions, artifacts | **Host, privileged** — the only thing allowed to touch Firecracker, cgroups and the guest network |
| `web/` | `hooks/` (injection detectors, rules as data), `agent/` (rules, model client, verdict, report), `server/` (the Hono API: tasks, progress stream, report, chat, approvals; serves the built client) | **Host, unprivileged** — no access to Firecracker or the supervisor's socket beyond its own API |
| `web/client/` | The interface: React, React Router, TanStack Query, Tailwind; light and dark themes, or the system's | **In the visitor's browser**; only the build reaches the host |
| `web/extension/` | The browser extension (Manifest V3): the agent in a side panel, built with the client's tools; reads no page | **In the visitor's browser** |
| `web/tools/` | Dev tooling: mutation testing, the corpus check, model benchmarking, the DB-IP fetch script | Run by hand or in CI, never by the running service |
| `guest/` | `agent/` (the Go job receiver, over vsock), `collector/` (Node.js + Playwright over a raw CDP session), `image/` (builds the guest disk image) | `agent/` and `collector/` run **inside the guest micro-VM** as an unprivileged user; `image/` runs on the host only to build the image |
| `config/` | `web.env` (holds the model key) and `supervisor.env`, git-ignored; their `*.example` templates are in git | Read by systemd for the services |
| `deploy/` | `steps/` (what `./zs install` runs), `versions.env` (every pinned version and checksum), `files/` (the few system files: units, sudoers, sysctl, udev, logrotate), `helpers/` (`zsvm`, `zsnet`), `test/` (tests on real micro-VMs) | **Host**, at install time |
| `docs/` | [Install and operate](docs/install.md), [configuration](docs/configuration.md), [containment rules](docs/containment.md), [privacy policy](docs/privacy.md), [terms of use](docs/terms.md) | Documentation only |
| `build/` | Everything generated (binaries, the built client, check screenshots); git-ignored | — |

On a server the checkout lives at `/zerostress` and everything else lives next to it, git-ignored: `bin/` (Firecracker, the root helpers, Caddy, the supervisor), `runtime/` (Node, Go), `images/` (the guest image), `data/`, `logs/`, `run/`. One command, `./zs`, installs, updates, starts, shows logs, edits settings and verifies.

## Status

Isolation, the supervisor, the collector, the injection-detection hooks, the agent and the web layer are implemented, tested in CI and on real microVMs, and running at [zerostress.space](https://zerostress.space).

Not done yet: when a page sits behind a "verify you are human" wall, the report says it could not check the page but does not yet show what was collected before the wall; an install on a clean machine has not been verified end to end.

## Running it yourself

You need a Rocky Linux 10 host with `/dev/kvm` (on a cloud VM: nested virtualisation) and a Vultr Serverless Inference key. `git clone https://github.com/xhero-xandr/zerostress /zerostress && cd /zerostress`, then `sudo ./zs install host`, put the key in with `./zs config web`, then `sudo ./zs install` and `./zs verify --live`. Every step is idempotent; every download is checked against a pinned checksum in `deploy/versions.env`. To try the interface locally without KVM: `./zs dev`. Details: [docs/install.md](docs/install.md); every setting: [docs/configuration.md](docs/configuration.md). A clean-machine install has not been verified yet.

## Releases

One version for the whole project, in [VERSION](VERSION); it stays below 1.0.0 until the project is stable. Every version, with what changed: [CHANGELOG.md](CHANGELOG.md) (0.1.0 to 0.8.0 were tagged afterwards on their milestone commits) and [GitHub releases](https://github.com/xhero-xandr/zerostress/releases) from 0.9.0, each with the browser extension of that version. How a release is made: [docs/install.md](docs/install.md#versions-and-releases).

## License

MIT — see [LICENSE](LICENSE).

Country and network data comes from [DB-IP Lite](https://db-ip.com/db/lite.php) (CC BY 4.0); the report credits it as "IP Geolocation by DB-IP".
