# ZeroStress

**Open a suspicious link or attachment without opening it on your own machine.**

ZeroStress runs the target inside a disposable Firecracker micro-VM, drives a real browser through it, collects evidence of what the page actually does, and hands back a verdict with proof — a redirect chain, the certificate, the network requests, the forms and what they ask for, a screenshot. Nothing risky ever reaches your device, and nothing the page does ever reaches the host: the micro-VM is destroyed after every check.

Built for the [Vultr: Agent Rush](https://lablab.ai/ai-hackathons/vultr-hackathon/) hackathon, Track 1 ("Blast Radius Zero"), Pattern B: goal → plan → a real browser in a sandbox → a vision-capable model reviews what it saw → a human approves anything risky.

Live at **[zerostress.space](https://zerostress.space)**.

## What you get

Paste a link, an email or a file, and the report shows:

- **A verdict** (benign / suspicious / malicious) with proof: the redirect chain and why each hop happened, the TLS certificate, every request with its IP and country, the forms and what they ask for, the domain's age, a phone and a tablet view, a screenshot. It is built from deterministic rules first; a model may only raise it, never lower it.
- **A human in the loop.** A risky step the agent proposes inside the sandbox, such as downloading a file, waits for the explicit approval of the person who started the check; submitting a form is not a step it can propose at all.
- **Email and files, not only links.** An email is read in your browser and never sent; a file is read only inside a micro-VM.
- **A browser extension** (Chrome, Edge, Brave): right-click a link and check it in a sandbox from a side panel.
- **A tool for AI agents** ([MCP server](mcp/README.md)): an agent checks a link, an email's links or a file in the sandbox before it opens them. It can ask; it can never approve.
- **An "Explain" chat** that can only talk about the evidence already in the report.

All of it in detail: [docs/features.md](docs/features.md).

## A check, start to finish

An email brings a link that "confirms your delivery". Instead of clicking it, you paste it into [zerostress.space](https://zerostress.space). A fresh micro-VM boots and opens it; about 15 seconds later the report says *Dangerous*: the link went through three redirects to a two-day-old domain with a password and card-number form that posts to a third host, and the screenshot shows what the browser saw. If the agent wants to go further, say to download a file the page offers, it stops and waits for your approval. Then the micro-VM is destroyed and nothing of the page ever touched your device.

## Vultr services used

| Service | What it does here |
|---|---|
| **Vultr Cloud Compute** (one VM with nested virtualisation) | The whole backend: the Go supervisor that boots a fresh Firecracker microVM for every check, the unprivileged web layer and agent, and Caddy for TLS. `/dev/kvm` from nested virtualisation is what makes a microVM per task possible on a cloud VM. |
| **Vultr Serverless Inference** (OpenAI-compatible API) | Every model call the agent makes: reading the collected evidence, proposing the next safe step of a deep check, possibly raising the verdict, and the "Explain" chat. The model (`qwen3.8-27b`) was chosen by a benchmark on the live service. The key stays in the host's service environment and never enters a microVM. |

## How it works

1. A **gatekeeper** checks the address (scheme, size, no internal or cloud-metadata addresses) before anything runs.
2. A **Go supervisor** boots a one-shot Firecracker micro-VM for the check, as a user of its own for that slot, from a shared read-only image with an empty scratch disk of its own.
3. A **collector** inside the micro-VM (Node.js, Playwright over the Chrome DevTools Protocol) opens the target in an unprivileged, sandboxed Chromium and reports every request, redirect, form, download attempt and dialog.
4. **Deterministic rules** turn the evidence into signals; a Vultr Serverless Inference model may add to the plan or raise the verdict, never lower it. A risky step waits for the person who started the check.
5. The report is built from a fixed list of fields, untrusted text is escaped and marked as such, and the micro-VM is destroyed whatever happened.

More: [docs/architecture.md](docs/architecture.md).

## Containment

The hackathon's own containment checklist, the way this project meets it:

| Requirement | How |
|---|---|
| Process isolation | One Firecracker micro-VM per task; Chromium runs as an unprivileged guest user with its own sandbox enabled (no `--no-sandbox`). Firecracker itself runs as a user of its own per slot and sees nothing of the host but its binaries, the kernel and its run directory: an escape from the guest reaches neither the supervisor nor another micro-VM |
| Secret hygiene | API keys live only in the host's service environment; never copied into the guest image or a micro-VM |
| Resource limits | vCPU, memory, task time, and download size are capped per run; so is what a guest sends (2 MiB/s in Firecracker's network device), how fast it opens new connections, and what it can write to the host (its 1 GiB scratch disk); mail ports are closed |
| Lifecycle | Every task starts from the same clean image, attached read-only; what the guest writes is deleted with the run. The micro-VM is torn down after every run, including on error or timeout, and a slot whose VM did not end is not given to the next one |

The containment is tested from *inside* a real guest (`deploy/test/containment-e2e.sh`), and a model can only push a verdict up, never down. How it is verified, and the nine rules every change must keep: [docs/architecture.md](docs/architecture.md#containment-in-practice) and [docs/containment.md](docs/containment.md).

## Run it yourself

You need a Rocky Linux 10 host with `/dev/kvm` (on a cloud VM: nested virtualisation) and a Vultr Serverless Inference key. `git clone https://github.com/xhero-xandr/zerostress /zerostress && cd /zerostress`, then `sudo ./zs install host`, put the key in with `./zs config web`, then `sudo ./zs install` and `./zs verify --live`. Every step is idempotent; every download is checked against a pinned checksum in `deploy/versions.env`. To try the interface locally without KVM: `./zs dev`. Details: [docs/install.md](docs/install.md); every setting: [docs/configuration.md](docs/configuration.md). The installer runs as root (`sudo`); it also closes SSH passwords and root login, but only when a user besides root has an authorized key. A clean install was verified end to end on a fresh Vultr VM on 8 November 2026.

## Documentation

| | |
|---|---|
| [docs/install.md](docs/install.md) | Install, update and operate; the tests |
| [docs/configuration.md](docs/configuration.md) | Every setting |
| [docs/architecture.md](docs/architecture.md) | How a check runs, the stack, where things live |
| [docs/features.md](docs/features.md) | What a visitor gets: the report, the extension, email, files |
| [docs/containment.md](docs/containment.md) | The nine containment rules every change must keep |
| [docs/privacy.md](docs/privacy.md), [docs/terms.md](docs/terms.md) | Privacy policy and terms of use |
| [CHANGELOG.md](CHANGELOG.md) | Every version, with what changed |

## Status

Isolation, the supervisor, the collector, the injection-detection hooks, the agent and the web layer are implemented, tested in CI and on real micro-VMs, and running at [zerostress.space](https://zerostress.space). A clean install, from `git clone` to a live verdict, was verified end to end on a fresh Vultr VM (8 November 2026).

Known gaps: the guest image is still built as root (in a chroot, though each step runs in namespaces of its own); QR codes in files are not read.

## Releases

One version for the whole project, in [VERSION](VERSION); it stays below 1.0.0 until the project is stable. Every version, with what changed: [CHANGELOG.md](CHANGELOG.md) (0.1.0 to 0.8.0 were tagged afterwards on their milestone commits) and [GitHub releases](https://github.com/xhero-xandr/zerostress/releases) from 0.9.0, each with the browser extension of that version. How a release is made: [docs/install.md](docs/install.md#versions-and-releases).

## License

MIT — see [LICENSE](LICENSE).

Country and network data comes from [DB-IP Lite](https://db-ip.com/db/lite.php) (CC BY 4.0); the report credits it as "IP Geolocation by DB-IP".
How widely visited a site is comes from the top of the [Tranco](https://tranco-list.eu) list (Le Pochat et al., NDSS 2019), fetched by the installer and kept on the host; it is not redistributed here.
