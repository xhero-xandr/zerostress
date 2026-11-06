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
| Resource limits | vCPU, memory, task time, and download size are capped per run |
| Lifecycle | A clean disk image per task; the micro-VM is torn down after every run, including on error or timeout |

Verified from *inside* a real guest, as the same unprivileged user the browser runs as (`deploy/test/containment-e2e.sh`): no write access outside the task, no secrets on disk or in any readable environment, no shared mounts, no route to the host, the cloud metadata address, or the host's gateway.

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
| `web/` | `hooks/` (injection detectors), `agent/` (rules, model client, verdict, report), `server/` (the Hono API: tasks, progress stream, report, chat, approvals; serves the built client) | **Host, unprivileged** — no access to Firecracker or the supervisor's socket beyond its own API |
| `web/client/` | The interface: React, React Router, TanStack Query, Tailwind; light and dark themes, or the system's | **In the visitor's browser**; only the built `dist/` reaches the host |
| `web/tools/` | Maintained dev tooling: mutation testing, the corpus check, model benchmarking, the DB-IP fetch script | Run by hand or in CI, never by the running service |
| `collector/` | Node.js + Playwright, driven over a raw CDP session | **Inside the guest micro-VM**, as an unprivileged user, once per task |
| `guest-image/` | The Go agent that runs inside the guest (`agent/`), plus the scripts that build and install the guest disk image | `agent/` runs **inside the guest**; the build scripts run on the host, but only to produce that image — not part of the running service |
| `deploy/` | Host setup scripts (numbered, run once each), end-to-end tests in `deploy/test/`; `deploy/helpers/` holds the root helpers `zsvm`/`zsnet`, `deploy/systemd/` the three unit files | **Host**, run by hand during setup or deployment, not by the service itself |
| `probes/` | One-off, throwaway probes used while deciding something (not part of any test suite or CI) | Run by hand, kept only for reference — don't confuse with `web/tools/` |
| `docs/` | Specs (one per decision), the live status, the architecture write-up, the backlog | Documentation only |

## Status

Core (isolation, supervisor, collector, injection-detection hooks, agent, web layer) is implemented and tested: see [docs/STATUS.md](docs/STATUS.md) for what's verified, what's measured, and what's still open — it's kept current, not a snapshot.

Design documents, one per decision, are in [docs/specs/](docs/specs/README.md). The overall architecture and the reasoning behind the stack choices are in [docs/PROJECT.md](docs/PROJECT.md). Planned work beyond the core chain is tracked in [docs/BACKLOG.md](docs/BACKLOG.md).

## Running it yourself

There is no one-click installer yet — deployment is a Rocky Linux 10 host with `/dev/kvm`, done by hand through the numbered scripts in `deploy/` and `guest-image/` (see `docs/SERVER.md` for the exact sequence). A guided installer is planned; until then, treat this as a reference implementation to read and adapt rather than something to `curl | bash`.

## License

MIT — see [LICENSE](LICENSE).

Country and network data comes from [DB-IP Lite](https://db-ip.com/db/lite.php) (CC BY 4.0); the report credits it as "IP Geolocation by DB-IP".
