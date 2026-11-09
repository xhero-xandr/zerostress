# What ZeroStress does

The visitor's side of the project: what a report holds, a walk through one check, and the browser extension, email and file support. How it is built is in [architecture.md](architecture.md).

## What you get

Paste a link, and the report shows:

- **A verdict** (benign / suspicious / malicious) with a confidence level, built from deterministic rules first; a model may only raise that verdict, never lower it.
- **Network evidence**: the redirect chain and why each hop happened, the TLS certificate, every request with its IP, country and network (ASN), third-party hosts.
- **The domain's age** (via RDAP) — a domain registered days ago is treated differently from one registered a decade ago.
- **How widely visited the site is** (the top 100,000 of the [Tranco](https://tranco-list.eu) list, kept on the host, so no address is sent anywhere) — a remark, never a reason to lower a verdict: it says whose address it is, not that this page is safe. Only a site's own address counts, not a name on it (`docs.google.com`, a file on `s3.amazonaws.com`) or on a free hosting service.
- **Forms and what they ask for** (password, card number, one-time code, ...) and where the data actually goes, in plain words, not the page's own.
- **A phone and a tablet view**, captured next to the desktop one — some pages serve a password prompt or a different site only to a mobile device.
- **A screenshot**, as proof of what the browser actually saw.
- **An "Explain" button and a chat** about the finished report — the assistant can only talk about evidence that is already in the report; it has no access to the sandbox, the model that produced the verdict, or any action that changes anything.

A risky step the agent proposes inside the sandbox, such as downloading a file, waits for the explicit approval of the person who started the check; submitting a form is not a step it can propose at all, and it never approves itself.

## A walk-through

1. You get an email with a link that "confirms your delivery". Instead of clicking it, you paste it into [zerostress.space](https://zerostress.space).
2. A gatekeeper checks the address, and a fresh microVM boots. Progress streams to the page stage by stage.
3. About 15 seconds later (the average on live phishing links) the report is ready. In this example it says *Dangerous*, because the link went through three redirects to a two-day-old domain hosting a password and card-number form that posts to a third host. The screenshot shows what the browser saw; the phone view shows the same form.
4. "Explain" opens a chat that answers in plain words from that evidence only, and points at the signals it relies on.
5. With a deep check, the agent may go a few steps further inside the same microVM: open a link on the page, scroll, take another look. A risky step, such as downloading the file a page offers, pauses until *you* approve it, from the browser tab that started the check (the owner's key leaves the address bar at once, so a copied address cannot approve); a shared report link can read but never approve.
6. Whatever happened, the microVM is destroyed. Nothing from the page touched your device or the host.

## Browser extension, email and files

- **The agent in your browser** ([web/extension/](../web/extension/), Manifest V3, Chrome, Edge, Brave): right-click a suspicious link and choose *Check this link in a sandbox*. A side panel opens with the agent: it starts the check on ZeroStress (the same microVM, the same rules and model), tells you step by step what happens in the sandbox, **stops and asks Allow / Don't allow before any risky action**, gives the verdict and explains it, and answers your questions about it. The agent is the page `/panel` of the site, so it updates with the site; the extension is only the menu and the frame, has no host permission and reads no page you visit. Install: download `zerostress-extension-X.Y.Z.zip` from the [release](https://github.com/xhero-xandr/zerostress/releases) of the version you run (the site's home page links to its own), unzip it, then `chrome://extensions` → *Developer mode* → *Load unpacked*.
- **One field for all of it**: the home page and the side panel take a link, an email or a file in the same place, and say what they understood before anything is sent (decided in the browser by fixed rules, not by a model, so an email never leaves it).
- **Email**: paste the email's text or its source (or drop an `.eml`). It is read in your browser and never sent anywhere. A link whose text shows another site is marked, and Safe Links / Google / Facebook redirects are unwrapped to where a click really goes. The sender's domain (only the domain) is looked up: its age, its DMARC and SPF, whether it imitates a brand or is a free mailbox. Check one link, or all of them at once: one microVM opens them one after another, each judged on its own.
- **Files**: an email's attachment, or a file you drop, paste or pick (up to 10 MB). Its SHA-256 is computed in your browser and only that is sent first, to ask VirusTotal. *Open in a sandbox* sends the file; the server holds it in memory, never on disk, until the microVM fetches it once (five minutes at most), and the file is read only inside the microVM: its real type, a disguised name, macros that start on opening, remote templates, DDE, PDF code and actions, programs or locked archives, HTML smuggling, SVG code, the addresses in it. An attached web page is also opened in the sandbox as a page, with every rule and the vision model. Only the findings leave the sandbox.
- **What others already know**: Google Safe Browsing, Spamhaus DBL, VirusTotal and urlscan.io are asked about the address, its domain and an email sender's domain. A listing can raise the verdict, never lower it.
- **Second opinion**: when a bot check keeps our sandbox out, ZeroStress does not try to get past it: it asks Cloudflare's URL Scanner on its own. A recent public scan of exactly that link is looked up first; otherwise a new scan is sent as unlisted (it stays in our Cloudflare account, out of Cloudflare's public search). Its "malicious" may raise our verdict, never lower it.
- **Behind the scenes**: every report has the agent's log, live during the check: the microVM booting (vCPUs, memory, guest image), the browser's steps, the injection detectors, each model call (vision, time, tokens), the gatekeeper's decisions, your approvals, the microVM's destruction.
