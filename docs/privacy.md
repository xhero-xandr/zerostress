# Privacy policy

ZeroStress opens a suspicious link for you inside a disposable sandbox and tells you what it found. This page says what that takes from you, where it goes, and how long it stays. It covers the site https://zerostress.space and the ZeroStress browser extension.

Last updated: 7 November 2026.

## The short version

- No accounts, no advertising, no analytics, no tracking cookies. We do not sell or share data for marketing.
- What you send is the link you want checked, and any question you ask about the result.
- A report lives for 24 hours, then it is deleted.
- An email you paste stays in your browser: it is read there. Only its links are sent, one you pick or all of them when you ask to check the whole email, never its text.

## What we receive

**The link you check.** We open it in a disposable microVM, a small virtual machine made for this one check and destroyed after it. The website behind the link sees a visit from our server, not from you.

**Questions you ask.** If you ask the agent about a result, your question is sent with the report to the language model that answers it.

**Your approvals.** In a deep check, the agent may propose a risky step, such as a download. Your Allow or Don't allow is recorded in that check's log.

**Your IP address.** It is used to apply fair-use limits (checks per hour and per day, questions per hour), counted in memory only and forgotten within a day. For IPv6 we count the /64 network, not the full address. Our web server's access log records the IP address and the time of each request, without the address of the page you checked; the log is kept for 14 days for security and troubleshooting.

## What a check creates

A report: the address you checked, where it redirected, screenshots of the page, the requests it made, its links, text found on it, and the verdict. Anyone who has the report's link can open it while it exists; the link contains a long random identifier and is not listed anywhere. Reports and screenshots are deleted 24 hours after the check.

Do not check a link that carries something private, such as a one-time sign-in link or a password reset link: its full address appears in the report for those 24 hours. Links into a webmail inbox are refused, because they only open with your password.

## Who else processes data

- **Vultr** hosts the service, and runs the language model (Vultr Serverless Inference). The model receives the report of a check and your questions about it. It does not receive your IP address.
- **Cloudflare** sits in front of the site as a network proxy and sees the traffic to it, as any such provider does.
- **Cloudflare URL Scanner** is asked on its own when our sandbox meets a bot check and cannot read the page. We first look for an existing public scan of the same address; otherwise we send a new scan as unlisted: it stays in our Cloudflare account and is not shown in Cloudflare's public search. Cloudflare's scanner then visits the address you checked.
- **The website you check** sees a visit from our sandbox, and whatever the page itself loads.

We do not send your data anywhere else.

## The browser extension

- It has no access to the pages you visit: no host permissions and no content scripts. It cannot read or change any website.
- **contextMenus**: adds "Check this link in a sandbox" to the right-click menu of a link, and "Check this page's address in a sandbox" to the menu of a page. Only that one address is taken, and only when you choose the item.
- **sidePanel**: shows the ZeroStress agent (https://zerostress.space/panel) in the browser's side panel.
- **storage**: keeps the link you right-clicked in the browser's session storage for the moment it takes the side panel to open, then removes it. Nothing is stored after you close the browser.
- An email you paste into the panel is read in your browser to find its links. The email is not sent to us; only the link you pick, or its links when you check the whole email, are sent. Unsubscribe links are left out.
- Its code is open: https://github.com/xhero-xandr/zerostress

## In your browser

The site keeps one setting in your browser's local storage: the light or dark theme you chose. It sets no cookies.

## Your choices

You do not need an account, and nothing ties a check to your identity. A report is deleted after 24 hours on its own; if you want one removed earlier, or have any question about this policy, write to devp.xandr@gmail.com or open an issue at https://github.com/xhero-xandr/zerostress/issues.

ZeroStress is not directed at children under 13.

## Changes

If this policy changes, the new version is published here with a new date. Its history is public in the project's repository.
