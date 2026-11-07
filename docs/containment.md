# Containment rules

These nine rules hold for every change to the project. Code comments refer to them by number ("containment rule 6").

1. **Process isolation.** Every task runs in its own Firecracker microVM. Chromium in the guest runs as an unprivileged user with its own sandbox enabled (`chromiumSandbox: true`, never `--no-sandbox`).
2. **Secrets.** Keys and tokens live only on the host, in the services' environment. Under no circumstances do they reach the guest image or a microVM.
3. **Limits.** Every run is capped: the microVM's vCPUs and memory, the task's time, the size of downloads, and what the guest sends: its outgoing bandwidth and packet rate (in Firecracker's network device) and how fast it opens new connections (in the host's firewall); mail ports are closed to it.
4. **Lifecycle.** A microVM is created for one task and destroyed after it, including on errors and timeouts. Every task gets a clean disk image.
5. **Guest network.** The guest cannot reach the host, internal ranges or the cloud metadata address (169.254.169.254); it can only reach the public internet.
6. **Privileged code.** The privileged supervisor (Go) uses the standard library only, no third-party modules. All other dependencies (Node, the collector in the guest) are pinned in a lock file and installed with `npm ci --ignore-scripts`.
7. **Untrusted output is data.** Page text, OCR, file names and SVG are data for the model, never instructions.
8. **The model can only raise risk.** It cannot lower a verdict below the threshold set by the rules. Admission decisions are made by gatekeeper code, not by the model.
9. **Injection detectors.** Deterministic hooks run on every input of untrusted content. When one fires, the fragment is cut out, the task continues without the model, and actions require approval. Every change to the hooks comes with tests against an injection page.

How the first five are tested from inside a real guest: `deploy/test/containment-e2e.sh`. The README's [Containment](../README.md#containment) section maps them to the hackathon's checklist.
