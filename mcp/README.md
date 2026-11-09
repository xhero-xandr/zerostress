# ZeroStress for AI agents (MCP)

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent check a link, an email's links or a file in
ZeroStress's disposable sandbox **before** it opens, fetches or recommends anything. The agent asks; a microVM
opens the thing and reports what it did; the agent gets a verdict and the signals behind it.

It runs on your computer, speaks MCP over standard input and output, has no dependencies (Node 18 or newer) and
runs nothing it is sent: it only talks to the ZeroStress service over HTTPS.

## Connect it

Claude Code:

```sh
claude mcp add zerostress -- node /path/to/zerostress/mcp/server.mjs
```

Any client that takes a command (Claude Desktop, Cursor, and others):

```json
{
  "mcpServers": {
    "zerostress": {
      "command": "node",
      "args": ["/path/to/zerostress/mcp/server.mjs"],
      "env": { "ZEROSTRESS_FILES_DIR": "/home/me/to-check" }
    }
  }
}
```

| Variable | Default | Meaning |
|---|---|---|
| `ZEROSTRESS_URL` | `https://zerostress.space` | The service. Must be `https` (or `http` on this computer, for your own installation). |
| `ZEROSTRESS_FILES_DIR` | empty | The one folder whose files may be sent for a check. **Without it the file tool is off.** |
| `ZEROSTRESS_WAIT_S` | `90` | How long a tool waits for the answer before it hands back a "running" result (at most 300). |

## Tools

| Tool | What it does |
|---|---|
| `zerostress_check_link` | Opens one link in a microVM. Returns the verdict and signals. |
| `zerostress_check_email_links` | Opens up to 10 links of one email in one microVM; a verdict for each, and for the whole. Send the links only, never the email. |
| `zerostress_check_file` | Reads a file inside a microVM without running it on your computer: macros, scripts, archives, programs, web pages. Files from `ZEROSTRESS_FILES_DIR` only. |
| `zerostress_get_result` | The result of a check that was still running when the first call returned (reports are kept 24 hours). |

The result carries `verdict` (`benign`, `suspicious`, `malicious` or `unknown`), `confidence`, `advice` (our sentence for the
verdict: `benign` is never "safe", `unknown` means the page could not be read), `signals` (fixed ids and levels), `report_url`
(the full report for a person), and for emails and files a part for each link or for the file.

## What an agent cannot do through it

- **Approve anything risky.** The checks offered here never ask for a decision, the key that decides a task is never returned
  and never sent, and there is no tool or argument that could pass one. Anything that needs a person (a download from a page,
  a form) is not offered; a person decides on the report page.
- **Read your files.** Only a plain file inside `ZEROSTRESS_FILES_DIR`, resolved with its links followed, at most 10 MiB. `..`, a
  link that leads out, a folder or a pipe are refused. A prompt-injected agent cannot send `~/.ssh` anywhere.
- **Pass instructions from a page to itself.** Everything a page, a sender or a model said about it comes back in one block,
  `untrusted_text`, cut short and stripped of control characters; the rest is numbers and fixed words of ours. The tool
  descriptions and the server's instructions tell the agent to treat that block as data. A verdict of `injection_attempt` says the
  page tried to speak to an automated reader.

## Privacy and limits

The address, the links or the file you send go to the ZeroStress service, which opens them in a disposable microVM and keeps
the report for 24 hours ([privacy](../docs/privacy.md), [terms](../docs/terms.md)). Leave out links that carry personal tokens.
The service limits the checks per address like any visitor's; a refused call says how long to wait.

## Tests

```sh
cd mcp
npm test                  # against a fake service, through standard input and output
node test/mutate.mjs      # breaks one protective step at a time; every break must fail a test
```
