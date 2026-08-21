# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read AGENTS.md first

**[AGENTS.md](AGENTS.md) is the source of truth for this repo** — architecture, the message
pipeline, the data layer, the money path, conventions, and the owner's mandatory rules. It is
shared with every other AI agent that works here, so keep it as the single place those facts live.
Do not duplicate its content into this file; add to AGENTS.md instead.

`DEVELOPMENT_RULES.md` is the owner's own procedure document, written in Indonesian. AGENTS.md §3
distils it, but read the original when you need the exact wording.

## Working effectively in this repo

**Files are large — never read them whole.** `database.js` is 4.5k lines, `bot.js` 3.1k,
`customerHandler.js` 2.2k, `server.js` 1.7k, `funHandler.js` 1.7k, `groupAdminHandler.js` 1.7k.
Use Grep to find the symbol, then Read with `offset`/`limit` around it.

**Exclude dead files from every search.** `bot_backup.js` (5.5k lines) is a stale copy of `bot.js`
and it will pollute grep results with plausible-looking but non-runtime matches. Same for
`fix*.js`, `fix*.cjs`, `patch_*.js`, `patch_*.cjs`, `update_*.cjs`, `cleanup.cjs`,
`restore_cust.js`. AGENTS.md §17 lists the full set.

**Verify before reporting.** Line anchors in AGENTS.md drift. When a fact matters to the change you
are making, confirm it against the current file rather than quoting the doc.

**You cannot test this project.** There is no test suite and no linter. The most you can do
unattended is `node --check <file>` on what you edited. Actually running the bot requires a linked
WhatsApp session that only the owner has, so **never claim a change works** — say what you verified
(syntax, code reading) and hand the runtime check to the owner, who must test in DM *and* in a group.

**Ask before restarting or killing anything.** The bot holds a live WhatsApp session and port 3000.
`taskkill /F /IM node.exe` kills the owner's running bot.

## Useful commands here

- `/code-review` — review the current diff before the owner tests it.
- `/security-review` — this repo handles payment webhooks, JWTs, and credential delivery.

## Language

Reply to the owner in Indonesian. Write user-facing bot strings and code comments in Indonesian to
match the codebase (AGENTS.md §15). Keep AGENTS.md itself in English — it is read by other models.
