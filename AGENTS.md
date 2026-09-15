# AGENTS.md

Instructions for any AI coding agent working on this repository (Claude Code, Codex, Cursor,
Gemini CLI, Copilot, …). `CLAUDE.md` points here — this file is the single source of truth.

Read this file **before** opening source files. It exists so you do not have to grep 14,000 lines
to learn how the bot is wired.

Line anchors are written `file:line`. They drift as the code changes — if a line does not match,
grep for the quoted symbol instead of assuming the fact is stale.

---

## 1. What this project is

A WhatsApp bot that sells digital products (accounts, licences, top-ups) with an Express admin
dashboard. One Node process, ESM (`"type": "module"`), Baileys + Express 5 + sqlite3.

- ~14,000 lines of runtime code in ~25 files. No framework, no TypeScript, no tests, no build step.
- All user-facing text and code comments are **Indonesian**. Function names and columns mix
  English verbs with Indonesian nouns (`getProductByKode`, `products.stok`, `customers.nomor`).
- Owner-issued procedure lives in `DEVELOPMENT_RULES.md`. Section 3 below distils it; that
  document is binding and takes precedence over your own preferences.

## 2. Run, stop, validate

```bash
npm start          # === node index.js, from the project root
node index.js      # same thing
start-bot.bat      # Windows: node index.js + pause
```

Dashboard: `http://localhost:3000` (`PORT` env, default 3000). Login page `/login.html`.

**There is no test runner, linter, formatter, watcher, or build.** `package.json` carries `start`
plus a handful of standalone smoke tests (`npm run test:tcg`, `test:identity`, `test:produk`,
`test:katalog`, `test:saldo`, `test:jebakan`). The validation loop is:

1. `node --check <file>` on every file you modified (`DEVELOPMENT_RULES.md` calls this `node -c`).
   **`node --check` only checks syntax.** Two very common mistakes here pass it and then throw at
   runtime, which in this bot means the customer gets no reply at all. `npm run test:jebakan`
   (`scripts/runtimeTrapTest.mjs`) catches both across the whole repo — run it after any edit that
   touches message text or adds a helper. See §15a.
2. Kill the old process **completely** — `taskkill /F /IM node.exe` on Windows. Nothing handles
   SIGINT and `index.js` never exits on error, so a half-dead process keeps holding port 3000 and
   the next boot fails with `EADDRINUSE`.
3. Restart and watch the terminal while the bot answers a real message.
4. Exercise the change in **both** a private chat and a group. The two paths are separate code.

Nothing hot-reloads — not plugins, not handlers, not settings. Every `.js` edit needs a restart.

## 3. MANDATORY rules (owner-issued, from DEVELOPMENT_RULES.md)

- Restart the bot after every `.js` change; never assume it is still running your new code.
- Run `node --check` on every modified file before declaring anything done.
- Read the terminal log for `ReferenceError` / `TypeError` while the bot actually responds.
  `index.js` swallows uncaught errors (log only, no exit), so a fatal bug shows up as *silence*,
  not a crash.
- Test every feature in DM **and** in a group.
- Keep DM-only commands (`checkout`, `riwayat`, `keranjang`) from leaking data into groups —
  redirect to DM instead.
- Verify owner/admin-only commands are refused for non-privileged senders.
- Guard all point/economy arithmetic: `isNaN()` checks, `parseInt`/`Math.floor` coercion,
  `points || 0` defaults.
- Wrap every `setInterval` / cron body in `try…catch` so one failed item cannot kill the bot.
- Any ON/OFF toggle must be **per-group** via the `group_settings` table, never a global setting —
  unless it is an owner-level feature.
- Implement in this order: DAO query in `database.js` → handler logic → wire into the `bot.js` router.
- A task is not done until the Owner confirms the bot responds without error in DM and group.
- Once the Owner confirms **no bugs**, push to https://github.com/Bar1965/Bot.git

## 4. Boot order (load-bearing — do not reorder)

`index.js` → `startServer()` → `startBot(onSocketReady)` → `startScheduler(sock)`

- `startServer()` is the **only** caller of `db.initDb()` (`server.js:1705`). It creates every
  table and seeds `config.defaults` into the `settings` table. Booting `bot.js` alone gives you a
  bot querying a schema that does not exist.
- `server.js` also `mkdir`s `./public/uploads/chat_media` at module scope; `bot.js` later writes
  there with no mkdir of its own.
- `startScheduler` is **not** called by `index.js` directly — it is the `onSocketReady` callback
  passed into `startBot`, so cron only starts once WhatsApp actually connects. "Backups stopped
  running" is usually a WhatsApp connection problem, not a scheduler problem.
- `startServer()` does not reject on `EADDRINUSE` — it only logs. You can end up with a working
  bot and no dashboard, and one line of console noise.
- `startBot` is re-entrant. It is called from `index.js:51`, from its own reconnect timer
  (`bot.js:919`), and from the dashboard session-reset route (`server.js:1230`). Each call
  rebuilds `ctx` and every handler closure but does **not** remove the old socket's listeners.

## 5. The message pipeline — read this before touching bot.js

One giant `messages.upsert` listener at `bot.js:2520-3092` does everything. Order matters
absolutely; anything you add in the wrong position silently never runs.

**Pre-router stages, in order:**

| # | Stage | Anchor |
|---|---|---|
| 0 | `if (type !== 'notify') return` — the only inbound filter | `bot.js:2522` |
| 1 | anti-delete cache write + revoke detection | `bot.js:2528` |
| 2 | field normalization: `jid`, `isGroup`, `sender`, `senderNormalized`, `isFromMe`, `msgText`, `isPrefixCmd` | `bot.js:2558` |
| 3 | `if (isFromMe && !isPrefixCmd) continue` — this is what makes self-bot commands work | `bot.js:2575` |
| 4 | LID-aware owner/admin resolution — **mutates `senderNormalized`** | `bot.js:2582-2661` |
| 5 | ban check (`continue`) | `bot.js:2664` |
| 6 | global registration gate + `exemptCommands` | `bot.js:2703-2719` |
| 7 | AFK return / mention replies | `bot.js:2722` |
| 8 | chat XP + level-up card (detached async IIFE, groups only) | `bot.js:2776` |
| 9 | anti-spam / anti-link (groups only) — can delete + kick before any handler | `bot.js:2820` |
| 10 | group auto-downloader for bare TikTok/IG links | `bot.js:2825` |
| 11 | admin-takeover lookup (`conversation_state === 'ADMIN'`) | `bot.js:2873` |
| 12 | `ent.activeGames` free-text answer check (tebakgambar / `_angka` / `_susunkata`) | `bot.js:2881` |
| 13 | **the router chain** | `bot.js:3023` (DM) / `bot.js:3055` (group) |

**The router chain** now lives in ONE function, `dispatchBotMessagePipeline` (`bot.js:1207`):

```
checkPdfMergeSession → checkStoreWizardSession → executePlugin → handlePdfCommands
  → handlePremiumCommand → handleFunCommand → handleMediaCommands
  → handleGroupMessage → handleCustomerMessage
```

- A handler **claims** a message by returning truthy; the chain then stops.
- `handleCustomerMessage` is terminal — its return value is never read.
- `groupAdminHandler` returning `false` (unknown command, or sender not admin) is precisely what
  lets a message reach `customerHandler`.
- Earlier handlers **shadow** later ones on a name collision. `funHandler` beats
  `handleMediaCommands`; `groupAdminHandler`'s `.cancel` beats `customerHandler`'s `.batal/.cancel`.
- The DM and group branches used to be two hand-maintained copies of the chain. They are not any
  more: both now call the single `dispatchBotMessagePipeline`, differing only in the flags they
  pass (`isGroup`, and `isTakenOver` which is forced to `false` for groups). A routing change is
  made **once**. The owner's "test in DM *and* group" rule still stands — the flags, the admin
  resolution and the per-group feature toggles diverge even though the chain no longer does.
- The two handlers at the head of the chain are **session interceptors**, not command handlers:
  `checkPdfMergeSession` and `checkStoreWizardSession` exist to catch messages that carry no
  prefix at all (an uploaded PDF, the answer "Netflix 1 Bulan"). Every handler after them returns
  early on non-prefixed text, so anything conversational has to be caught here or not at all. Both
  return `false` immediately when the sender has no open session, which is the case for virtually
  every message — do not add work to that path.
- There is **no inbound deduplication**. The same message can be processed twice after a
  reconnect — anything touching money or points must be idempotent on its own.

**Command parsing** is re-derived independently in every module, never shared:

```js
const args     = text.trim().split(/\s+/);
const rawCmd   = args[0].toLowerCase();
const cleanCmd = rawCmd.replace(/^[./#]/, '');   // strips ONE leading . / or #
```

Prefixes are exactly `.` `/` `#`. Matching is strict equality via `['a','b'].includes(cleanCmd)` —
the array *is* the alias mechanism. There is no alias table and no `startsWith` matching.
`args[0]` is the command token itself, so the first real argument is `args[1]`
(`pdfHandler` is the one exception — it reads `args[0]`).

**Handler signatures are inconsistent by design.** Do not copy a call site between modules:

```js
handleCustomerMessage(jid, sender, messageObj, text, isFromGroup, actor)
handleGroupMessage   (jid, sender, messageObj, text, isGroupAdmin, isPrefixCmd, actor)
//                                                   ^ param 5 means something DIFFERENT here
handlePdfCommands(sock, m, sender, jid, cmd, args, isFromGroup, groupSettings, isPrefixCmd, isAdmin, isOwner)
handleFunCommand    ({ sock, jid, senderNumber, messageObj, text, args, cleanCmd, isFromGroup, isAdmin, isOwner, isPrefixCmd })
handlePremiumCommand({ sock, jid, senderNumber, messageObj,       args, cleanCmd, isAdmin, isOwner, isPrefixCmd })
executePlugin(cleanCmd, { sock, jid, senderNumber, m, msgText, args, cleanCmd, isAdmin, isOwner })
```

The raw message is `messageObj` in fun/premium/customer but `m` in plugins/pdf; the text field is
`text` in fun/customer but `msgText` in plugins.

**`ctx`** (`bot.js:2493-2516`) is *not* a per-message object. It is a construction-time bag passed
once to `createCustomerHandler(ctx)` / `createGroupAdminHandler(ctx)`, holding `sock`,
`botSettings`, `userPushNamesMap`, `messageCache`, `formatPhoneNumber`, `checkIsUserInGroup`,
`sendQris`, `logToSystem`, `sendInteractiveButtons`, `react`. Adding a key here reaches only those
two handlers.

**Outbound sends are queued.** `sock.sendMessage` is monkey-patched at `bot.js:866-870`; the
original is stashed as `sock.rawSendMessage`. Every send goes through one global FIFO
(`processOutgoingQueue`, `bot.js:740-799`) that fires a `composing` presence, sleeps
`min(1200, max(400, textLen*8 + rand(200)))` ms, sends, then `paused`. Consequences:

- `await sock.sendMessage(...)` waits for the real network send **plus** the typing delay. A loop
  of ten awaited sends stalls the whole bot's outbound stream for seconds.
- You cannot make a send fast by changing the call site.
- Reactions (`{ react: … }`) skip the delay. `humanDelayEnabled === 'false'` disables the layer.
- Failed sends retry 3× (1s/3s/5s). If disconnected, the queue holds and flushes on reconnect.
- `sock.rawSendMessage` bypasses the connection guard, retries and anti-ban delay — only
  `processOutgoingQueue` should use it.

**Interactive buttons** (`sendInteractiveButtons`) send **one plain text message and nothing else**.
Grep confirms it: `nativeFlowMessage`, `buttonsMessage`, `listMessage` and `templateMessage` appear
**zero times** in `bot.js`. Nothing this bot sends is tappable — `buttons` and `sections` are
rendered into text naming the command to type. Do not write a footer saying "klik tombol/dropdown
di bawah"; there is nothing to click, and customers hunt for it. The receiving half is ready
whenever someone wants to switch the sender on: `extractInteractiveReply` already parses button,
list and nativeFlow replies, and the installed Baileys (6.7.23) carries all four protos.

Because it is all text, `buttons`/`sections` are not free decoration — they lengthen every message.
The live 7-brand catalogue message was 1 821 characters, 781 of them (43%) the fake buttons, with
the product list printed twice and "Ketik" appearing ten times. The helper now collapses reply
buttons onto one line, drops section rows whose title already appears in the text, and skips the
title block when the caller already opened with it: 885 characters for the same catalogue.

A button's `id` is a literal command string
(`id: '.checkout'`); tapping it re-enters the same pipeline as if the user typed it. Making a
button work requires nothing beyond pointing its `id` at an existing command. The plain-text send
carries `mentions` when the caller passes them (`send()` in `src/games/helpers.js` forwards the
array) — before that it silently dropped them, so any button message naming players by `@number`
tagged nobody.

## 6. Adding a command — full checklist

1. **Pick the owning handler** by consulting the chain order in §5. Whatever runs earlier wins.
2. **Add the string to that handler's allowlist array**, or the branch is dead code:
   - `funHandler.js:363` `knownFunCmds`
   - `bot.js:1117` `knownMediaCmds` (for `handleMediaCommands`, which lives *inside* `startBot`)
   - `premiumHandler.js:120` `knownPremCmds`
   - `pdfHandler.js:17` `PDF_COMMANDS`
   - `groupAdminHandler.js:33-49` `adminStoreCommands` / `groupModerationCommands` / `banCommands`
3. **Write the branch**: `if (['cmd','alias'].includes(cleanCmd)) { …; return true; }`
4. **Register it in `commandRegistry.js`** — append `['.cmd <args>', 'Deskripsi Indonesia']` to the
   `items` array of the right group inside `categories.<key>.groups`. Keep the description under
   ~45 characters: WhatsApp uses a proportional font on a narrow screen, and anything longer wraps
   and makes the whole list look broken. A follow-up command that only works while a session is
   running (`.hit`, `.serang`, `.vote`) belongs in that group's `inGame` array instead, not as its
   own bullet. This is presentation only, but it is the *sole* reason a command appears in `.menu`.
   An unregistered command is invisible to users.
5. **Check both branches** of the router if you touched `bot.js` routing.
6. If it must work pre-registration, add it to the relevant `exemptCommands` lists — there are
   several (`bot.js:2703`, `bot.js:1135`, `premiumHandler.js:132`, `customerHandler.js:162`).
7. If it is premium-gated, add the inline block yourself; there is no decorator:
   ```js
   const tier = await db.getPremiumTier(senderNumber);
   if (tier === 'Free' && !isAdmin && !isOwner) { /* reply */ return true; }
   ```
   Forgetting `&& !isAdmin && !isOwner` locks out the owner.
8. If it should reply privately when typed in a group, add its name to `isPrivateCommand`
   (`customerHandler.js:183`) — otherwise it leaks the customer's cart into the buyer group.

**Do NOT add it to `knownCmdList` (`bot.js:2677`).** That ~130-entry array looks like the master
registry but is declared and never referenced anywhere in `bot.js` (verified). It is dead code.

## 7. Data layer (`database.js`, ~213 exports, 56 tables)

**Three promise wrappers, no fourth:**

```js
runQuery(sql, params)  // INSERT/UPDATE/DELETE/DDL → { lastID, changes }
getQuery(sql, params)  // one row or undefined
allQuery(sql, params)  // array of rows
```

`runQuery` uses a non-arrow `function (err)` callback specifically so `this.lastID` / `this.changes`
bind correctly. Writing an arrow callback or a new ad-hoc wrapper silently loses them — and every
optimistic-concurrency guard in the file (`if (result.changes === 0) …`) depends on that shape.

**`withTransaction(callback)`** is the only transaction mechanism. It serializes *all* transactions
process-wide through a module-level promise queue with `BEGIN IMMEDIATE`, and is re-entrant via an
`inTransaction` flag so nested wrapped DAOs are safe. **Never `await` a network call, a
`sock.sendMessage`, or a sleep inside a transaction body** — it blocks every other write in the
process.

**Conventions:**

- Every DAO is a top-level `export async function`. No classes, no default export.
- Consumers always `import * as db from './database.js'` and call `db.fnName()`.
- Naming: `get*`/`getAll*`/`getOrCreate*`, `add*`/`create*`, `update*`/`set*`, `delete*`/`remove*`,
  `is*`/`has*`. English verbs, Indonesian nouns.
- SQL is always inline with `?` positional params. Never concatenate — this is the only injection
  defence in the layer.
- Business failures return `{ success: false, reason: 'SCREAMING_SNAKE', message: '<Indonesian>' }`
  rather than throwing. Throwing is reserved for infrastructure failure and pure validation.
- Sanitize numeric input with `Math.floor(Number(x))` + `isNaN`/`isFinite`; points clamp at
  `MAX_POINTS` (1,000,000) and `awardGamePoints` truncates any single award above 1000.
- Every state change appends `await addLog(TYPE, '<Indonesian message>')`, TYPE ∈
  SYSTEM | ORDER | ADMIN | CUSTOMER | MODERATION | BALANCE.
- The file is organised by `// --- FUNGSI <AREA> ---` banners. Put new functions in their section.

**Adding a column is a TWO-place edit** — there is no migration runner:

```js
// 1) in the CREATE TABLE IF NOT EXISTS body  → fresh installs
// 2) try { await runQuery("ALTER TABLE x ADD COLUMN y") } catch (e) {}  → existing shop.db
```

The empty catch *is* the "already migrated" signal, so doing only one of the two fails silently.

**The user primary key is a full JID string, not a phone number** — `628xxx@s.whatsapp.net`, or
`xxxxx@lid` for LID-era group senders. The same human can produce two different keys, splitting
balance, points and registration state. `bot.js:2617` is the single point where an `@lid` is
resolved back to a phone JID (by reassigning `senderNormalized` mid-pipeline). **Any DB read or
write keyed on the sender must happen after that line.** Re-deriving the sender from
`m.key.participant` inside a handler keys state under the `@lid` and creates an orphaned customer.
The fuzzy fallback is `normalizePhoneDigits` + `isPhoneMatch`.

**Never `UPDATE orders SET status` directly.** `updateOrderStatus` (`database.js:2164`) owns coupon
redemption, MANUAL-product stock decrement/restore, RESERVED `product_items` release, and loyalty
accrual. It whitelists exactly: `CART`, `WAITING_PAYMENT`, `WAITING_CONFIRMATION`, `PAID`,
`COMPLETED`, `CANCELLED`. A cart *is* an order row with `status='CART'`.

**Stock is reserved at checkout, not at payment.** AUTO products flip `product_items` READY →
RESERVED; MANUAL products decrement `products.stok` under a `WHERE stok >= ?` guard.
`products.stok` is authoritative **only** for MANUAL products — for AUTO it is a mirror recomputed
from `getAvailableItemsCount()` and any direct write gets clobbered.

**Timestamps are mixed per column.** Original columns are SQLite `DATETIME` text; everything added
by the Casaku migration is INTEGER epoch-ms — including two different styles inside `orders`.
Check the `CREATE TABLE` before writing a comparison; the wrong form returns wrong rows silently.

Money lives in three unrelated tables keyed by the same JID: `customers.balance` (IDR),
`game_profiles.points` (Akbar Poin, + `bank_points`), and a legacy `loyalty.points`. Mutations use
guarded UPDATE + audit insert (`financial_logs` for IDR, `point_logs` for poin) inside one
`withTransaction`.

`PRAGMA foreign_keys` is never turned on, so declared FOREIGN KEYs are not enforced and orphan
rows are possible. DB file is `./shop.db`, resolved against the process CWD.

## 8. Settings and per-group toggles

Two completely different systems:

**Global — `settings` table** (EAV: `key TEXT PRIMARY KEY, value TEXT`)

- Valid keys are defined by `config.defaults` in `config.js`, not by the schema. `initDb` seeds any
  missing key. A key absent from `config.defaults` is never seeded and `getSetting` returns null.
- **Values come back as STRINGS.** `"false"` is truthy in JS. Always compare explicitly:
  `botSettings.antiDelete === 'true'`. Only `lowStockLimit` and `broadcastDelay` are parseInt-ed.
- **Changing a value in `config.js` has zero effect on an already-seeded `shop.db`** — the row
  already exists and overlays the default. This is the #1 source of "I changed config.js and
  nothing happened". Adding a brand-new key *does* work.
- `database.js` holds no cache. The cache is `bot.js`'s module-level `botSettings`, refreshed only
  by `reloadBotSettings()` — which **only** `POST /api/settings` calls (`server.js:918`).
  `reloadBotSettings` *reassigns* the object, so `ctx.botSettings` and the handlers' copies go
  stale until the next `startBot`. From bot-side code, use
  `Object.assign(botSettings, await db.getSettings())` — mutate in place, never reassign.

**Per-group — `group_settings` table** (`jid TEXT PRIMARY KEY`, one column per toggle)

`getGroupSettings(jid)` never returns null — it synthesizes defaults when no row exists. No cache,
so no invalidation needed. Adding a per-group toggle (the owner-mandated way) is a **four-place**
edit: CREATE TABLE body, the try/catch ALTER, the no-row defaults object in `getGroupSettings`,
**and both the column list and the value list in `updateGroupSettings`** (`database.js:2593`).

> ⚠️ `updateGroupSettings` issues an `INSERT OR REPLACE` with a hard-coded 10-column list, so any
> key you pass that has no column is **silently discarded**. `features_config` is currently written
> by `groupAdminHandler.js:980` and `funHandler.js:1039` and dropped on the floor, while four call
> sites read it. Verified — treat this as a known defect, not a pattern to copy.

Also note `updateGroupSettings` is read-modify-write with no lock and no transaction: two
concurrent toggle commands on the same group can lose one another's change.

## 9. Identity and authorization

Resolved once per message at `bot.js:2582-2661` and passed down as `actor = { isAdmin, isOwner }`.
`isOwnerSender` is true if **any** of: `m.key.fromMe`; match against stored `botSettings.ownerJid`;
`db.isPhoneMatch` on digits; a group-metadata participant whose digits match the owner; or a
`customers.role` of OWNER. Final `isAdmin = isOwner || isGroupAdmin || isStoreAdmin`.

`actor` now carries **three** flags — `{ isAdmin, isOwner, isStoreAdmin }`. `customerHandler` used to
receive only the first two, which is why `.setmemberstatus` could only gate on `actor.isAdmin` and
therefore let a WhatsApp admin of any rented group set a store customer to BANNED.

Caveats you must know:

- Store owner/admin are treated as admin in **every** group, even where they are not a WhatsApp
  group admin.
- `groupAdminHandler.js:108-149` **re-runs the whole cascade from scratch** instead of trusting
  `actor`. Fixing an auth rule in only one of the two places gives you a bot where a command works
  in one handler and not the other.
- Digit matching uses `endsWith` in both directions with only a `length > 6` floor, so a short or
  malformed entry in `botSettings.adminNumbers` matches far more senders than intended.
- `isFromMe` unconditionally grants owner rights (`bot.js:2591`).
- **`.addmod` grants moderation only — never store admin.** A registered moderator (`moderators`
  table, or `customers.role = 'MODERATOR'`) sets `isModeratorBot`, **not** `isStoreAdmin`. Until
  Aug 27 2026 both bot.js and groupAdminHandler folded moderators into `isStoreAdmin`, so one
  `.addmod` silently handed out `.paid` (free licences, including to the moderator's own order),
  `.price`, `.stock`, `.broadcast`, and `.eval`. The allow-list is `perintahModerator` in
  `groupAdminHandler.js` — keep it and the `.addmod` confirmation text in sync, because that text
  is the contract the owner reads.

### 9a. A phone number cannot be turned into a JID — resolve it, never build it

191 of 194 rows in `customers.nomor` are `@lid`, and a LID contains **no phone number at all**.
Any code that does `digits + '@s.whatsapp.net'` is constructing an identity that matches nobody,
and every one of those call sites reported success anyway: `.ban 628xxx` printed "🚫 USER DI-BAN"
while the person kept using the bot, and `.setpremium 628xxx` printed "✅ Premium berhasil
diberikan!" while the tier never moved — after the money was taken.

Use **`db.resolveTargetJid(input)`**. It returns `{ jid, sumber, ditemukan }` and checks, in order:
a full JID (from a mention or reply) → a `customers` row whose stored number matches → the
`lid_phone_map` table. **`ditemukan: false` means refuse the command**; never fall back to a
constructed JID.

`lid_phone_map` is populated by `db.catatPetaLid()` from `bot.js`, at the one place both identities
are ever visible together: Baileys group metadata, where `participant.id` is the `@lid` and
`participant.jid` is the phone. It fills in gradually, so mention/reply remains the reliable path.

**Why almost every row is `@lid` in the first place.** In `bot.js` the group branch resolves the
sender to a phone JID with `if (pMatch.id && pMatch.id.endsWith('@s.whatsapp.net'))`. In a
LID-based group that condition is never true — the comment three lines below says so itself:
`pMatch.id` holds the `@lid` and the phone sits in `pMatch.jid`. Owner and admin matching does read
`pMatch.jid`; `senderNormalized` does not. So every ordinary customer keeps their `@lid` for the
whole message, and that is what lands in `customers`, `orders`, and `conversations`.

**Do not "fix" that by pointing `senderNormalized` at `pMatch.jid`.** Measured Sep 2026: 231 of 236
`customers` rows are `@lid`, `lid_phone_map` covers 99 pairs, and only **93 of those 231 can be
translated today**. Switching the identity would turn the other 138 into brand-new customers —
losing their order history, loyalty points and premium tier — with no error anywhere. It is a data
migration, not a code change, and it needs the owner's decision. The map does fill in on its own
from group metadata, so coverage rises over time.

Sending *to* an `@lid` works: `messages` shows 13 outbound admin replies addressed that way. So the
group→DM redirect (`responseJid = senderNumber` for private commands) does reach the customer, and
their replies in that thread stay `@lid`, which keeps the cart consistent. The mismatch bites when
the same person opens a DM from their contact list instead, arriving as `628…@s.whatsapp.net`.

**Never compare two customer identities with `===` / `!==`.** Use **`db.samaOrangnya(a, b)`**, which
tries exact match → both-are-phones via `isPhoneMatch` → `@lid` translated through `lid_phone_map`,
and returns `false` rather than guessing when a `@lid` has never been mapped. The same human is
`@lid` writing in a group and `628…@s.whatsapp.net` writing in DM, and **6 of the 7 rows in
`orders` are stored under `@lid`**. `.garansi` and `.review` both gated ownership on `!==` and so
told genuine buyers their own order "tidak ditemukan pada akun Anda" — `.garansi` most of all,
since the delivery message tells the buyer to type `.garansi <ORDER_ID>`, which is exactly the
branch that compares. Section 20 of `produkAdminSmokeTest.mjs` pins the accept *and* refuse cases.

### 9b. The bot has two identities too — `src/utils/botIdentity.js`

The same LID split applies to the bot's **own** account, and getting it wrong is worse than a failed
command. Read straight from the live session:

```
me.id  = 628xxxxxxxxx:NN@s.whatsapp.net   ← phone number
me.lid = NNNNNNNNNNNNNN:NN@lid            ← different digits entirely
```

`groupAdminHandler` guarded `.kick` against self-removal with
`targetJid.includes(sock.user.id.split(':')[0])` — phone digits only. In a LID group, tagging the
bot puts its **`@lid`** in `mentionedJid`, a LID contains no phone number, the guard evaluated
false, and `groupParticipantsUpdate(..., 'remove')` ran against the bot itself. The bot is an admin,
so the request succeeded: **`.kick @bot` made the bot leave the group.** Reported by the owner
Aug 2026.

Use **`adalahJidBot(sock, targetJid, participants?)`**. Two rules it encodes:

- **Compare every identity, not one.** `sock.user.id` *and* `sock.user.lid` are both the bot. The
  optional `participants` argument (from `getCachedGroupMetadata`) is a fallback for older sessions
  whose `creds.me.lid` is empty — the participant row matching either identity contributes its
  `id`/`jid`/`lid` as well.
- **Match exactly, never `includes()`.** That one call was wrong in both directions: it missed the
  LID, *and* it made any member whose number merely contains the bot's digits immune to `.kick`.

Every path that can remove a participant must go through it. There are exactly **three**
`groupParticipantsUpdate(..., 'remove')` call sites — anti-link and anti-spam in `bot.js` (both
covered by a single early `return false` at the top of `handleAntiSpamAndAntiLink`, so the bot never
moderates itself) and the `add`/`kick`/`promote`/`demote` handler. `scripts/botIdentityTest.mjs`
asserts that count and fails if a fourth appears unguarded.

The same phone-only comparison silently broke two other things, both fixed: `isReplyToBot` in
`bot.js` was always false in LID groups, and `.del` computed `fromMe: false` for the bot's own
messages so it took the "delete someone else's message" path.

### 9c. Who may kick whom — `src/utils/perisaiTarget.js`

`.kick` and `.demote` are open to anyone holding **WhatsApp group admin**, not just a store admin.
So any group admin could remove the bot's own owner from the owner's own group, or demote a store
admin, in one command — and the bot, being an admin, would carry it out. The hierarchy is now
enforced in one place:

```
Owner       → may touch anyone (except the bot itself, §9b)
Admin Toko  → anyone EXCEPT the Owner
Group admin → anyone EXCEPT the Owner and store admins
```

Only `kick` and `demote` are shielded. `promote` on the owner is harmless and `add` targets someone
who is not in the group yet.

Two rules that are easy to get backwards:

- **A LID is never a phone number.** `identitasTarget()` returns `nomor: null` for a bare `@lid` and
  only fills it from `participant.jid` or `lid_phone_map` (`db.cariNomorDariLid`). This matters
  because `isPhoneMatch` compares with `endsWith` once both sides are ≥7 digits — feed a 15-digit
  LID in as a phone and it can match a completely unrelated person's number. There is a test for
  exactly this (`@lid` ending in the owner's digits must not be shielded).
- **When the target cannot be resolved, ALLOW.** This is the opposite bias from `adalahJidBot`, and
  deliberately so. That guard compares against identities that are always present in `sock.user`, so
  it can refuse with confidence. Here, resolving `@lid` → phone depends on group metadata and a LID
  map that fills in gradually; refusing on every failed lookup would break `.kick` for ordinary
  members in LID groups, which is its normal use. The shield refuses only on a **positive** match,
  and the whole call is wrapped in `try/catch` in the handler — a shield that throws would take all
  group moderation down with it.

`putusanPerisai()` is the pure policy and `identitasTarget()` the pure resolver; both are unit-tested
without a database. Run `npm run test:identity` after touching any of this — 59 checks covering both
§9b and §9c, no database or network needed.

DM-vs-group is **not** a per-command flag. Three separate mechanisms:

1. `isPrivateCommand` (`customerHandler.js:183`) → reply is DM'd, with a public "check your DM" notice.
2. `groupAdminHandler` silently `return true`s for admin-store commands typed outside `adminGroupId`.
3. Individual `if (isGroup)` / `if (!isGroup)` guards inside single commands.

## 10. The money path

**Casaku QRIS is the live provider** whenever `CASAKU_LICENSE_KEY` and `CASAKU_QRIS_ID` are both
set. Only if that gate is false does checkout fall through to Midtrans, then to a static QRIS image
with manual proof upload. **In a Casaku deployment the entire Midtrans branch is dead code** —
debugging a payment issue against it is wasted effort.

```
checkout → db.checkoutCart (CART→WAITING_PAYMENT, reserve stock)
        → paymentService.createPayment → casakuProvider (POST api.casaku.id, x-license-key)
        → db.createCasakuTransaction (payment_transactions row + orders.qr_string/expired_at)
        → bot renders qr_string to PNG and sends it
   … customer pays; Casaku's Android helper watches e-wallet notifications on the merchant phone
   … Casaku POSTs webhook → server.js → webhookHandler (HMAC-SHA256 over the RAW body)
        → db.markTransactionPaid  ← the single atomic gate
        → db.createFulfillmentJob → fulfillmentWorker polls every 5s → claimAndDeliverItems → DM
```

- **Never add body-parsing middleware above `server.js:24`.** The two webhook routes are registered
  with `express.raw({type:'application/json'})` *before* `app.use(express.json())` because the HMAC
  must run on untouched bytes. Moving them silently breaks every signature with a 401.
- **`db.markTransactionPaid` is the only place** that owns idempotency (`WHERE payment_status =
  'PENDING'`, `changes === 0` ⇒ ALREADY_PAID), amount validation, deposit crediting, coupon
  redemption, points, and referral payouts. Adding a second write path to "paid" bypasses all of it.
- Webhook HTTP codes are **retry control, not error reporting**: 400 = unparseable, 401 = bad
  signature, 500 = DB failure (Casaku *should* retry), and **200 for every business rejection**
  including AMOUNT_MISMATCH. Changing a 200 to a 4xx puts Casaku into a retry loop.
- `claimAndDeliverItems` is retry-safe by design: it looks for USED items for this order first,
  then RESERVED, then any READY. That three-tier lookup is the only thing stopping a failed send
  from burning a second licence key on retry.
- `orders.status` is set to `COMPLETED` at payment, *before* delivery. Delivery progress lives in
  the separate `orders.fulfillment_status`. Reports filtered on `status='COMPLETED'` include
  undelivered orders.
- Delivery is implemented **twice** — the worker for Casaku, and inline in `server.js` for
  Midtrans, plus a third hand path when an admin types `.paid`. Message wording still has to be
  changed in each. **Warranty text no longer does:** it lives in `src/utils/pesanGaransi.js`
  (`barisGaransiAktif`, `barisKlaimGaransi`, `penutupGaransi`) and both live paths call it.
  That split existed for real — the worker told buyers their warranty date and how to claim it
  with `.garansi`, while `.paid` closed with "silakan hubungi admin" and named neither. Every
  buyer served by hand, which until Casaku is subscribed is *every buyer*, was sent back to the
  owner for something the bot already self-serves. `orders.warranty_until` was being written on
  both paths the whole time — only the message was missing.
- **`.pay` / `.qris` now reuses a live QRIS instead of minting a second one.** It used to call
  `createPayment` unconditionally, and `createCasakuTransaction` both INSERTs a fresh
  `payment_transactions` row *and* overwrites `orders.casaku_transaction_id` / `payment_amount` /
  `qr_string`. Since every QRIS carries its own unique code (Rp1.127 vs Rp1.456), a buyer who had
  already scanned the first QR paid an amount reconciliation was no longer looking for: money gone,
  order never settled. In a webhook deployment the orphan is still found by
  `provider_transaction_id`; in a polling-only deployment (§10, no public URL) it is invisible.
  Typing `.pay` twice is the most natural thing a waiting buyer does. The handler now re-renders
  the stored `qr_string` while `expired_at` is still in the future, and only mints a new
  transaction once it has lapsed. Section 18 of `produkAdminSmokeTest.mjs` pins the hazard.
- **`.pay` on a `CART` is refused.** It used to mint a QRIS straight from the cart, skipping
  `checkoutCart` entirely — no stock reserved, no premium discount, no coupon — while
  `createCasakuTransaction` still flipped the order to `WAITING_PAYMENT`. The buyer could pay for
  stock that was never set aside for them. It now tells the customer to `checkout` first.
- **A failed `createPayment` must cancel the order explicitly.** Casaku's dashboard has a
  *"Wajibkan Aplikasi Aktif"* toggle: with it on, Casaku **refuses to mint a transaction** while no
  listener device is online. That is the correct setting — it converts the catastrophic failure
  (customer pays, Casaku never sees it, order auto-cancels at 24 h with the money already gone)
  into a harmless refusal before any money moves. But `checkoutCart` has already reserved stock and
  set `WAITING_PAYMENT` by then, and `expired_at` is written by `createCasakuTransaction` — the call
  that just failed. It stays NULL, `expireStaleOrders`'s `expired_at < ?` never matches NULL, and
  the credential sits RESERVED until the 24-hour sweeper. The catch block in `customerHandler` now
  calls `updateOrderStatus(order_id, 'CANCELLED')`, DMs the owner, and keeps `err.message` out of
  the customer's message. Section 17 of `produkAdminSmokeTest.mjs` pins all of this down, including
  the NULL-comparison behaviour — if that test starts failing, this note is what changed.
- `getPendingFulfillmentJobs` also reclaims jobs stuck in `PROCESSING` for longer than its
  `staleProcessingMs` (default 5 min). A job only reaches that state if the process died
  mid-delivery, and re-running is safe because `claimAndDeliverItems` looks for this order's USED
  items first. Do not narrow that query back to `PENDING`/`FAILED` — that silently strands paid
  orders forever.
- The worker DMs the owner (`settings.ownerNumber`) on stuck-job recovery and on `MANUAL_REVIEW`.
  There is still **no dashboard route** reading `fulfillment_jobs` — the DM is the only signal.

**The webhook is an optimisation, not a requirement.** `scheduler.js:628` runs
`reconcileStaleOrders(45)` on its own 45-second interval, which asks Casaku's status API about every
order that has been PENDING for more than 45 seconds and then walks the same
`markTransactionPaid → createFulfillmentJob` path the webhook does. A deployment with no public URL
at all — `DASHBOARD_HOST` unset means Express binds `127.0.0.1`, so no external POST can ever land —
still delivers automatically, just 45-90 s later instead of ~1 s. `.status` / `.cekbayar` also force
an immediate check via `reconcileSingleOrder`. Do not tell the owner they need a tunnel before
payments can work; they need one only to make confirmation instant.

`scheduler.js` is plain `setInterval`, no cron library, no persisted last-run times:
`processOrderAutomation` every 5 min (expiry + Casaku reconciliation + reminders + abandoned-cart),
`processAutoSholat` every 60 s, free-games alerts every 6 h, backup check hourly (copies when 24 h
elapsed), a 60 s ticker firing the daily sales report at 21:00 WIB, auto-quiz hourly. Every job
early-returns on `!sock || !botState.whatsappConnected`. `startScheduler` is idempotent via
`schedulerStarted` but assigns `schedulerSock` *before* the guard — that is what lets a reconnect
swap in a fresh socket without duplicating intervals. Do not capture `sock` in the closures.

### 10a. `claimAndDeliverItems` returns a wrapper, not a product map

It returns `{ success, deliveredData, itemsText, manualItems, warrantyUntil }`. Callers must unwrap:
`const res = await db.claimAndDeliverItems(id); const deliveredData = res?.deliveredData || {};`

`server.js` (the Midtrans branch) always did this. `groupAdminHandler.js` `.paid` did **not** after
commit `0847227` (19 Aug 2026) changed the return shape, so `Object.keys()` yielded the five meta
keys and the first loop iteration hit `true.credentials.length` — a TypeError raised **after** the
function's transaction had already committed. The licence was marked `USED` and stock decremented,
while the customer received a "payment accepted" notice and no credentials. Retrying `.paid` failed
at the same point. Fixed; do not reintroduce.

`.paid` is the **fallback** delivery path, and it was the only live one for as long as
`CASAKU_QRIS_ID` stayed unset (§14) — Midtrans has no server key either, so nothing automatic could
fire. It stays reachable even with Casaku configured, because a customer who pays by some other
means still has to be settled by hand. Any regression here means those orders are never fulfilled.
Treat this call site as load-bearing.

### 10d. Three settlement paths, and every reward must be granted by exactly one function

An order can become paid three ways, and each one used to hand out a different subset of rewards:

| path | settles via | Akbar Poin | referral unlock | Poin Loyalty |
| --- | --- | --- | --- | --- |
| Casaku QRIS | `markTransactionPaid` (raw `UPDATE`) | yes, own copy of the SQL | yes | **no** |
| deposit balance | raw `UPDATE` in `customerHandler` | yes | **no** | **no** |
| `.paid` / dashboard | `updateOrderStatus` | **no** | **no** | yes |

Two separate point systems are involved and they are not interchangeable. **Akbar Poin** lives in
`game_profiles.points` and is the games/economy currency (§12b). **Poin Loyalty** lives in the
`loyalty` table alongside `total_spent` and a Bronze/Silver/Gold `tier`, and is granted *only* inside
`updateOrderStatus` on the unpaid→paid transition. The QRIS path deliberately never calls
`updateOrderStatus` — it needs the atomic `WHERE payment_status = 'PENDING'` guard — so it never
touched loyalty at all.

The failure mode arrives precisely when the automation starts working: every QRIS sale left
`loyalty.points`, `total_spent` and `tier` untouched, so the "Poin Loyalty" line on the customer
profile screen stays at 0 forever while the customer keeps buying. Symmetrically, `.paid` buyers —
the ones who waited longest, because a human had to verify their transfer — received zero Akbar
Poin, and their referrer's 50-point reward never unlocked, because `verifyAndRewardReferral` was
only ever called from the QRIS branch.

`awardPurchasePoints(customerNomor, nominal, orderId, { sertakanLoyalty })` in `gamesDb.js` is now
the single place all three are granted. Call it from any new settlement path. Pass
`sertakanLoyalty: false` **only** when the caller already went through `updateOrderStatus`, which
grants loyalty itself — otherwise loyalty double-counts. `markTransactionPaid` no longer carries its
own copy of the points SQL; the copy used `points = points + ?` without `COALESCE`, so a profile row
with `points` NULL came back NULL, wiping the customer's balance rather than merely failing to add
to it.

Deposit top-ups (`DEP-` order ids) must keep bypassing all of this — buying store credit is not a
purchase. That branch returns before the reward call in both `markTransactionPaid` and the
fulfilment worker.

### 10e. Casaku saying "paid" while we fail to settle is the one state that must never be silent

`markTransactionPaid` can return `success: false` after the provider has already confirmed the
money. Both callers — `reconcileStaleOrders` (every 45 s) and `reconcileSingleOrder` (`.status`,
`.cekbayar`, receipt upload) — used to check only `result.success` and otherwise do nothing at all.
The buyer's money was in, the product was not sent, and the reconciler re-attempted the same order
forever without producing a single signal anywhere.

`TRANSACTION_NOT_FOUND` is the realistic trigger: `orders.casaku_transaction_id` is set but the
matching `payment_transactions` row was never written, so the lookup by `provider_transaction_id`
fails permanently. `laporGagalSettle` in `paymentService.js` now DMs the owner and writes a
`PAYMENT` log, deduplicated per order id in memory so a stuck order alarms once rather than every
45 s. `ALREADY_PAID` is excluded — two overlapping reconciliations are normal.

Background modules have no socket of their own. `src/utils/notifOwner.js` holds the shared one, and
`startFulfillmentWorker` — already called with the live socket on every `connection.update` open —
wires it with `pasangSocketNotif(sock, () => db.getSettings())`. `notifOwner.js` imports nothing
outside `src/utils/`; the settings reader is injected rather than imported, to stay clear of §16.
`notifikasiOwner` returns `false` instead of throwing when no socket is attached yet, because every
caller sits on the money path and a failed notification must never fail a payment.

### 10f. Settlement invariants — four rules that hold the money path together

These were each broken in a different place, and each failure was silent.

**1. A paid order must always carry `payment_status = 'PAID'`.** `updateOrderStatus` used to write
only `status`, so an order settled by `.paid` or the dashboard stayed `payment_status = 'PENDING'` —
and that column is the *sole* idempotency guard in `markTransactionPaid`. A late webhook would then
settle the same order a second time: points, loyalty, `total_spent`, a second fulfillment job and a
second "payment received" DM. `updateOrderStatus` now sets it whenever the new status is PAID or
COMPLETED.

**2. The fulfillment job must be created inside the settling transaction.** It used to be created by
each caller *after* `markTransactionPaid` committed. If that INSERT failed — SQLITE_BUSY is routine,
four writers share the file — the order was orphaned permanently, not merely delayed:
`getPendingFulfillmentJobs` INNER JOINs `fulfillment_jobs` so there was no row to pick up, and
`getStalePendingOrders` requires `payment_status = 'PENDING' AND status = 'WAITING_PAYMENT'`, both of
which had just changed. Now it happens inside the transaction, so a failure rolls the settlement back
and the 45 s reconciler retries.

**3. `createFulfillmentJob` must be idempotent per order.** `job_id` used to embed `Date.now()`, so
`INSERT OR IGNORE` never ignored anything (`order_id` has no UNIQUE constraint) and two calls meant
two jobs — the buyer receiving their credentials twice. The id is now `FJ-<orderId>`.

**4. Coupon redemption goes through `tebusKupon` and never blocks a settlement.** Three settlement
paths existed; the QRIS one discarded the UPDATE's `changes` (so a `max_uses = 1` coupon staged in
two carts was honoured twice), the `.paid`/dashboard one returned `success: false` on `changes !== 1`
(holding hostage an order whose money the admin had already received), and the deposit-balance one
never redeemed at all — leaving `used_count` at 0 forever, so a single-use coupon could be reused
without limit. `tebusKupon` in `gamesDb.js` is now the only implementation; it reports
`habis: true` for an exhausted coupon and lets the settlement proceed, because the money is already
in and bookkeeping is not a reason to withhold a product.

`settleOrderWithBalance` in `storeDb.js` is the deposit-balance path. It exists because the handler
previously ran the deduction, the order update, the job creation and the points award in four
separate transactions; a crash between the first two (Antigravity restarts this bot on its own) left
the balance spent and the order still `WAITING_PAYMENT`, so the customer paid again by QRIS.

### 10g. Warranty length is parsed from the number and its unit — never from a substring

`claimAndDeliverItems` derives `orders.warranty_until` from `products.duration`. The old code matched
fragments in priority order (`d.includes('7')`, then `'14'`, then `'60' || '2 bulan'`, …), which is
wrong for four of the shop's real products:

| product | duration | old | correct |
| --- | --- | --- | --- |
| OFFICE | `12 Bulan` | 60 days | 360 |
| ADOBE | `12 Bulan` | 60 days | 360 |
| APPLEMUSIC | `6 Bulan` | 30 days | 180 |
| GEMINI | `18 Bulan` | 30 days | 540 |

`"12 bulan"` contains `"2 bulan"`, so the 60-day branch won and the `'12 bulan'` branch below it was
unreachable. A one-year Office account carried a two-month warranty: it dies in month five, `.garansi`
refuses the claim, and a buyer who is genuinely covered gets turned away.

Use `masaGaransiMs()` in `src/utils/pesanGaransi.js`. It reads the first number+unit pair
(hari/minggu/bulan/tahun and their abbreviations), caps at ten years, and falls back to 30 days for
text with no number — `Lifetime`, `Permanen`, empty. That fallback is the owner's policy question,
not the parser's, and is deliberately left as it was. An order with mixed durations takes the longest,
because `warranty_until` is one column per order; that favours the buyer, on purpose.

### 10b. Premium shop discount is applied in `checkoutCart`, and the percentages live in two files

`PREMIUM_TIERS[*].benefits.shopDiscountPct` (5 / 10 / 15) was advertised in nine places and used in
zero calculations — it appeared only inside display strings. Customers paid Rp5.000–25.000 for a
discount that never happened.

It is now applied in `storeDb.checkoutCart()`, which writes `orders.premium_discount` and calls
`updateOrderTotal()`. Three things to keep in mind:

- **`premium_discount` is a separate column from `discount_amount`.** `applyCouponToOrder` does
  `SET discount_amount = ?`, so sharing one column would make applying a coupon silently erase the
  premium discount. `updateOrderTotal` subtracts both.
- **The percentages are duplicated** in `DISKON_PREMIUM_PERSEN` (`storeDb.js`) because
  `premiumHandler.js` imports `database.js`; importing back would close a cycle (§16). Change both.
- It is recomputed from the item subtotal on every checkout, never accumulated, so a cart that is
  cancelled and checked out again cannot stack discounts.

`checkoutCart` returns `{ success, order, diskonPremium }`; `customerHandler` shows `diskonPremium`
to the customer, because a discount nobody can see is indistinguishable from one that isn't applied.

### 10c. Managing the shop from WhatsApp — `produkAdminDb.js` + `storeWizard.js`

The owner runs this shop from a phone. Everything a product needs can now be done in chat, and the
dashboard is optional rather than required.

| Command | Does |
|---|---|
| `.tokobaru` | Nine-step question-and-answer wizard; the easiest path |
| `.addproduk` / `.addproduct` | One-shot, pipe-separated; fields 6-8 (`MODE`, `KATEGORI`, `DURASI`) are optional |
| `.editproduk <kode> <field> <nilai>` | Partial edit of exactly one column |
| `.delproduk <kode>` | Shows the blast radius, then needs `.delproduk <kode> YA` |
| `.setgambar <kode>` | Attach or reply with a photo; saved to `public/uploads/products/` |

- **`updateProductFields` exists because `addProduct` is `INSERT OR REPLACE`.** Calling `addProduct`
  to "edit" a product blanks every column the caller did not resend. The WhatsApp path edits one
  field at a time, so it needs a real partial `UPDATE`. Column names come from the `FIELD_PRODUK`
  whitelist, never from the admin's text.
- **`.stock` now refuses AUTO products** (`setManualStock`). `products.stok` is authoritative only
  for MANUAL products: `addToCart` and `checkoutCart` both read `getAvailableItemsCount()` — the
  count of `product_items` rows with `status='READY'` — when `delivery_type='AUTO'`. Writing `10`
  into an AUTO product's `stok` therefore produced a catalogue that advertised stock and then
  refused the sale one tap later. `.out` and `.ready` are refused for the same reason, and `.out`
  additionally never actually stopped AUTO sales. Restock via `.addstock`, reduce via `.delstock`.
- Switching a product to `AUTO` through `.editproduk` re-derives `stok` from the credential count.
  Switching to `MANUAL` leaves the number alone.
- **`deleteProductWithItems` keeps `USED` items.** Those rows are the record of what was delivered
  to a buyer and what a warranty claim is checked against; only unsold `READY` credentials are
  destroyed. Deletion is refused outright while any `RESERVED` item or unfinished order
  (`CART`/`WAITING_PAYMENT`/`WAITING_CONFIRMATION`/`PROCESSING`) still references the code.
- **The wizard's session interceptor must stay at the head of the router chain** (§5).
  `groupAdminHandler` returns `false` on its first line for non-prefixed text, and wizard answers
  are ordinary sentences. A prefixed command arriving mid-wizard **cancels** the wizard and is
  passed through rather than swallowed — a wizard that traps the owner is worse than one that
  gives up too easily. Sessions are in-memory only and expire after 10 minutes of silence.
- `parseHargaIndonesia` accepts `50000`, `50.000`, `Rp 50.000`, `50rb`, `1jt`. Both the wizard and
  `.addproduk` go through it, so the two entry points cannot disagree about what a price is.
- `node scripts/produkAdminSmokeTest.mjs` (`npm run test:produk`) drives all of the above —
  including the whole wizard conversation through a fake `sock` — against a throwaway database in
  `os.tmpdir()`. 85 assertions, no WhatsApp session needed. It `chdir`s to the sandbox **before**
  importing the database layer; keep that order or it will write to the owner's live `shop.db`.

### 10j. The numbered catalogue — `src/handlers/katalogView.js`

The customer-facing shop is exactly two screens, and every number on them is bound to a **product
code**, never to a search term.

```
.list        → KATALOG screen: one line per brand, numbered
reply "1"    → PRODUK screen : description + every package of that brand, numbered
reply "1"    → into the cart
reply "0"    → back to the catalogue
```

- `katalogView.js` is **pure**: it takes rows and returns text. No `db`, no `sock`, no cart. That is
  why `npm run test:katalog` can drive the whole flow with 100 assertions and no WhatsApp session.
- **Nav sessions store exact SKU codes** (`{ type: 'KATALOG', entri: [{ brand, kodes }] }` and
  `{ type: 'PRODUK', kodes }`). They used to store the *brand name*, and pressing a number
  re-searched it with `LIKE '%brand%'` — so the number the customer pressed was not bound to the
  product they had just been shown, and a brand whose name is a substring of another ("OFFICE"
  also matches "LIBREOFFICE") could open, and sell, the wrong thing.
- On a dial, the code is taken from **the stored index**, then re-read with `getProductByKode`. If
  the owner deletes a product while the screen is open, the customer is told it is gone; the
  numbering never slides onto the neighbour. `getProductsByKodes(kodes)` returns rows **in the
  order asked for**, and drops codes that no longer exist — compare lengths, do not assume indexes.
- `getProductsByBrand` matches `brand_category` **exactly**, not with `LIKE`. It exists so that
  typing one SKU still shows all of that brand's packages.
- One stock badge (`badgeStok`) feeds every screen. Before, the catalogue, the detail view and the
  search results each had their own rule, so the same product could read "Ready" on one screen and
  "Sisa 2" on the next.
- Everything the customer sees comes from `STOK_ASLI` (READY `product_items` for AUTO products),
  which is the number `addToCart` enforces. `getAllProductsSummary` (the owner's `.listproduk`)
  uses it too, so admin and customer screens cannot disagree.
- `judulPaket` drops `variant_type` when it is itself a duration, because this shop has a product
  typed "1 Tahun" with duration "12 Bulan" and the naive join reads like a typo.

### 10k. Orphaned credentials — `.stokyatim`

`product_items` rows whose `produk_kode` has no `products` row. They are accounts the owner paid
for: invisible on every screen, unsellable, and — this is the dangerous part — **instantly treated
as sellable stock if the same code is ever created again**, because `addProduct` derives an AUTO
product's `stok` from the credential count. As of 2026-09-15 the live database holds 7 of them
(`GEMINI` ×3, `NET01` ×3, `ASEP01` ×1) left behind by the old delete path.

`.stokyatim` lists them; `.stokyatim hapus <KODE>` destroys them, and refuses if the product exists
(use `.delstock` for live products). `USED` rows are never included — those are warranty records.

### 10l. Stock integrity — one number, and it has to be true

`products.stok` is **only authoritative for MANUAL products**. For AUTO products it is a cached copy
of `COUNT(product_items WHERE status='READY')`, refreshed on restock and on delivery and at no other
time — so a checkout that moves a credential to `RESERVED` leaves it stale until the order settles.
Everything customer-facing already computes the real number via `STOK_ASLI`. Three things did not,
and each one failed in the owner's favour-less direction:

- **The daily sales report** read the raw column, so "Stok Menipis: sisa 1" could mean zero
  sellable, and a sold-out AUTO product never appeared under "Stok Habis". A shop running on 1–2
  units per product therefore never got a restock warning. It now uses real stock.
- **`.cekstok`** now reports drift explicitly (`kolomStok` vs `ready`) and **`.sinkronstok`**
  recomputes the column for every AUTO product and prints what it changed. That is the only repair
  path; nothing self-heals.
- **Duplicate credentials had no guard at all.** Both insert paths (`addProductItems` for the
  dashboard, `addProductItemsBatch` for `.addstock`) inserted every line blindly, so pasting the
  same account twice meant two buyers receiving the same account — the second one finds it already
  in use. The live database has proof: NET01 holds three byte-identical rows.

`saringKredensialBaru` now guards both paths, inside the transaction. It compares
`sidikKredensial(isi)`, not raw text:

| Credential shape (both real, from this shop) | Fingerprint |
|---|---|
| `https://music.apple.com/redeem?ctx=Music&code=HRKLN4JLRLNF` | `kode:hrkln4jlrlnf` |
| `vb3463@365offices.com \| G!a63gqK` | `akun:vb3463@365offices.com` |

**Do not "simplify" this to splitting on the first `|` or `:`.** Most credentials here are URLs, and
that split fingerprints every single one as `https` — every voucher would be rejected as a
duplicate. Verified against all 12 live credentials: 10 distinct fingerprints, the only collision
being NET01's three genuinely identical rows.

A credential already marked `USED` is rejected with its own reason (`SUDAH_DIKIRIM`) — re-adding it
would resell an account that is already in a buyer's hands. `.addstock` prints what it skipped and
why; silently dropping lines would leave the owner believing stock went up when it did not.

### 10m. `.testi` answers "is this shop a scam?", not "is the product good?"

This is the owner's own framing, and it changes what the screen is for: *"testi ini kayak bukti kalau
kita ga ngescam dan bener bener ngasih yang dijual. soalnya banyak yang minta testi takut ditipu."*
Buyers of digital goods do not ask whether the product is good. They ask whether they will be robbed.
Five stars do not answer that; a record of deliveries does.

So `.testi` (aliases `.ulasan`, `.rating`, `.bukti`) leads with **delivery proof**, and stars are a
secondary line:

```
✅ 47 pesanan sudah terkirim
⚡ Rata-rata 4 detik dari bayar sampai akun diterima
🕒 Pengiriman terakhir: 2 menit lalu
⭐⭐⭐⭐⭐ 4.8/5 dari 12 ulasan pembeli
📬 PENGIRIMAN TERAKHIR  …masked numbers + per-order delivery time
💬 KATA PEMBELI         …up to 3 real reviews
🔒 KENAPA TIDAK BISA DITIPU DI SINI  …structural guarantees
```

`getBuktiPengiriman` reads `fulfillment_jobs`, not `orders`, for two reasons: its `created_at`
(queued the moment payment settled) and `updated_at` (set when the status became DELIVERED) give the
true delivery duration, and the rows survive the owner clearing order history. `DEP-` top-ups and
non-DELIVERED jobs are excluded — a deposit is not a sale and a failed job is not proof.

**A shop with no deliveries must not invent numbers.** The zero state says so plainly and still
answers the fear with the guarantees that hold from day one (bot delivery, official QRIS rather than
a personal bank account, warranty, real stock). The test asserts no digit and no star appears there.

One subtlety worth keeping: the screen falls back to a review-only layout when the delivery counter
is zero *but reviews exist*. An order confirmed by hand with `.paid` does not always leave a
DELIVERED job, and hiding genuine customer reviews because a counter reads zero throws away the one
piece of evidence the buyers themselves wrote.

### 10n. Testimonials and sales proof — two things, deliberately not one

`src/handlers/testimoni.js` is pure text building, like `katalogView.js`. Two outputs, and the
separation is the point:

- **Bukti transaksi** — an automatic sales log posted to `buyerGroupId` after each delivery. Product,
  masked number (`628••••5678`), time, whether delivery was automatic. The bot wrote it and does not
  pretend otherwise. `susunBuktiTransaksi` contains no star and no quoted opinion, and
  `testimoniSmokeTest` asserts both.
- **Testimoni** — the buyer's own stars and words, and **only** if they actually reply. Nothing in
  this codebase may generate a rating or a comment on a customer's behalf. A shop whose testimonials
  are written by its own bot has no testimonials, including the genuine ones.

The `reviews` table and six DB functions already existed; five were dead and `.review` demanded that
the buyer type an Order ID (`.review ORD-20260726-4489 5 bagus`). Three months, zero reviews. Now the
worker asks right after delivery and the buyer replies `5` or `5 cepet banget`.

**The pending review is found in the database, not an in-memory session.** `getPesananMenungguUlasan`
looks for the buyer's most recent DELIVERED order, within 7 days, with no review yet — so a restart
between delivery and reply does not drop the rating on the floor. Ownership is matched with
`samaOrangnya`, because an order placed from a group is stored as `@lid` while the reply arrives from
DM as `@s.whatsapp.net`.

Three guards stop a bare number from becoming an accidental rating, all asserted by the test:

1. **DM only** — a bare number in a group is conversation, and the request is sent to DM anyway.
2. **No catalogue nav session** — while `.list` is open, `1` means product number one.
3. **An actual un-reviewed delivered order must exist.**

`addReview` now writes `produk_kode` instead of relying on a JOIN through `order_items`. The column
had existed unused, and without it every review loses its product the moment the owner clears old
orders — which owners do.

Posting the sales proof and asking for the review happen **outside** the money path, fired without
`await` from the worker after the job is already `DELIVERED`. A failure there must never mark a
delivered job as failed: retrying it would send a second set of credentials for one payment.

### 10h. Admin store commands — what each one must not destroy

`.addproduk` calls `addProduct`, which is `INSERT OR REPLACE`: **every column the caller does not
resend is blanked.** The handler used to pass `""` for `gambar`, `""` for `petunjuk` and `null` for
`variant_type`, so re-running `.addproduk` on an existing code silently deleted the image set by
`.setgambar` and the whole usage guide — which ships to the buyer alongside their credentials. It
also defaulted MODE to `MANUAL`, flipping an AUTO product holding 20 credentials over to manual and
taking its stock from a typed number. It now carries the old product's image, guide, variant type and
delivery mode forward. Stock is validated against `addProduct`'s own bounds (0–1 000 000) *before* the
call, because `-5` is not `NaN`, and the throw it caused reached only the top-level catch in
`bot.js` — the admin got no reply at all.

`.delstock` must refuse `RESERVED` and `USED` rows. RESERVED means the credential is locked to an
order awaiting payment; deleting it means the buyer pays and `claimAndDeliverItems` finds nothing.
USED is the only record of what was delivered, which is what a `.garansi` claim is checked against —
`.delproduk` deliberately preserves USED rows for exactly this reason (§10c), while `.delstock` was
deleting them one at a time.

`.flashsale` was the third price entrance still using raw `parseInt`: `.flashsale NET01 15.000` sold
the product for **Rp15**, and a negative price passed (`-50000` is not `NaN`) straight into
`setFlashSale`, which validates nothing — `addToCart` then uses it as `activePrice`, making the cart
subtotal negative and discounting the other items in the same cart. It now uses
`validasiFieldProduk('harga', …)` like `.price` and the wizard, rejects a price that is not below the
normal one, and bounds the duration.

`.takeover` / `.release` must resolve an identity, never assemble one. They wrote
`<digits>@s.whatsapp.net` while the bot reads conversation state under the sender's own identity,
which for ~98 % of customers is `@lid` (§9a) — so the bot kept auto-replying while the confirmation
said the chat had been taken over. Use `db.resolveTargetJid`.

Finally, a command being *referenced* in this file does not make it reachable: `acc`, `terima`,
`konfirmasi` and `selesai` were matched at their handlers but missing from `adminStoreCommands`, so
the gate returned first and all four were dead — including `.acc`, which `.paid`'s own help text
tells admins to use. `batal` is deliberately **not** in that list: it is the customer's
cancel-my-order command, and adding it would hijack the owner's own `.batal` when they shop.

### 10i. Deposit balance — the only path that can create money from nothing

Every other money movement in this bot relays value that already exists: checkout
deducts a balance the customer holds, `.paid` settles an invoice whose amount was
already recorded, `markTransactionPaid` acts on a provider's confirmation.
`.isisaldo` is different in kind — the bot simply trusts that the owner received
cash in the real world. Treat it accordingly.

The balance layer itself was already sound and should not be reworked:
`deductCustomerBalance` guards with `WHERE balance >= ?` inside a transaction, so
a balance can never go negative and cannot be double-spent; `financial_logs`
records every movement. `settleOrderWithBalance` (§10f) is the checkout path and
is already Priority 1 — a customer with enough balance never sees a QR at all.

What `src/handlers/saldoAdmin.js` adds is the *owner* side, with four guards the
owner chose explicitly:

**Owner only, checked independently.** `groupAdminHandler`'s own `isOwner` relaxes
itself with `.includes()` on JID fragments — acceptable for opening a menu, not
for minting money. `benarBenarOwner()` compares through `samaOrangnya` against
`ownerJid`/`ownerNumber` and refuses to guess. Store admins (including the second
number in `adminNumbers`) are refused; they keep `.paid`, which only confirms an
existing invoice.

**Always confirm, via a one-time code — not "YA".** A typed "YA" can fire from
muscle memory on a stale prompt and never forces anyone to read the resolved name.
The confirmation message prints the customer's name, the current balance, the
amount and the resulting balance, with a random 5-character code the owner must
copy back. Codes are single-use (deleted before execution), expire in two minutes,
and a new request replaces any pending one. Pending state is in memory on purpose:
if the bot restarts, the request is gone rather than executable by a command
nobody remembers issuing.

**Identity resolved, never assembled, and the customer must already exist.**
`extractTargetJid` is deliberately NOT used here — it builds `<digits>@s.whatsapp.net`,
a shape 231 of 236 customers do not have, and `resolveTargetJid` accepts any string
containing `@` as valid without checking that the account exists. Combined, that
would credit a ghost row while the bot answered "berhasil" — and
`addCustomerBalance` calls `getOrCreateCustomer`, so it would happily create that
row. `saldoAdmin` requires a matching `customers` row before it will proceed, and
accepts only typed input or a JID that came from WhatsApp itself (a reply's
`participant` or a `mentionedJid`).

**Withdrawals are logged honestly and the customer is told.** `tarikSaldoOwner`
exists rather than reusing `deductCustomerBalance` because that function stamps
every deduction as type `PURCHASE`, and a correction is not a purchase — mixing
them makes the financial log report sales that never happened. Corrections are
type `ADJUSTMENT`, carry `OWNER:<jid>` as the source, require a reason, and that
reason is forwarded to the customer. The same `balance >= ?` guard applies, so an
over-withdrawal fails rather than leaving a debt.

`scripts/saldoAdminSmokeTest.mjs` (63 assertions) checks each guard by reading the
balance *after* every refusal, not by trusting the reply text.

## 11. Dashboard (`server.js`, ~70 `/api` routes)

- Routes are `app.VERB(path, authenticateJWT, authorizeRoles(...), handler)`. Roles are exactly
  `Owner` | `Admin` | `CS`. Some routes deliberately omit `authorizeRoles` and branch on
  `req.user.role` inside the handler instead (the orders action route does this).
- Auth is a 24 h JWT in an httpOnly cookie named `auth_token`. Frontend JS can never read it — any
  new fetch must pass `credentials:'same-origin'`. `localStorage` role is cosmetic only.
- **Tokens are revocable, and `authenticateJWT` is `async`.** Signature verification alone left
  "Logout", password change, and account deletion purely cosmetic — the issued token stayed valid
  for its full 24 h. Every request now also (1) compares the token's `iatMs` claim against
  `auth_token_epochs.valid_after` for that username, and (2) re-reads `role` from the `users` table,
  so a downgrade takes effect immediately and a deleted account is rejected at once. It **fails
  closed**: a database error returns 503 rather than letting the request through.
  - `db.bumpTokenEpoch(username)` is the revoke switch. It is already called by `logout`,
    `updateUserPassword`, and `deleteUser` — call it from any new endpoint that should end sessions.
  - The epoch is stored in **milliseconds** and compared against a custom `iatMs` claim, *not*
    the standard `iat`. `iat` has one-second precision, so a token minted in the same second as the
    revocation slipped through — the end-to-end test caught exactly that.
  - `websocket.js` runs the same two checks. Skipping it there would leave a back door: that socket
    streams every customer conversation to the dashboard live.
  - Any token issued before this change lacks `iatMs`, so it is treated as age 0 and dies at the
    first revocation. One extra login after deploy is expected.
- **`server.js` binds `127.0.0.1` by default.** `listen(port)` with no host listened on every
  interface, putting the dashboard login on the LAN. Set `DASHBOARD_HOST=0.0.0.0` in `.env` to
  restore that — **required** before enabling Casaku/Midtrans webhooks, since those callbacks
  originate off-machine.
- **Destructive endpoints fail closed and are Owner-only.** `POST /api/orders/clear` used to accept
  role `Admin` — who cannot even *read* revenue via `/api/stats` — and defaulted an absent or
  misspelled `filter` to `'ALL'`, i.e. the most destructive option was the fallback. It now rejects
  unknown filters with 400 and requires `confirm: "HAPUS SEMUA RIWAYAT"` for `ALL`. When you add a
  destructive route, mirror that shape: narrowest role, explicit value, no default.
- **Owner login reads `ADMIN_PASSWORD_HASH` from `.env`** whenever the username equals
  `ADMIN_USER` — the `PUT /api/users/:username` password endpoint cannot change it. Rotating the
  owner password means editing `.env`.
- TOTP 2FA is hand-rolled in `server.js:101-156` (base32 + HMAC-SHA1, ±1 step). No library.
- **There is no `express.static('public')`.** Only `/uploads/products` and `/receipts` (authed) are
  mounted; `index.html`, `login.html`, `pay.html` each have explicit `res.sendFile` routes. A file
  dropped into `public/` is unreachable over HTTP until you add a route.
- `botState` (declared `server.js:159`, mutated almost exclusively by `bot.js`'s
  `connection.update`) is the single source of truth for WhatsApp reachability. Every HTTP-layer
  send must guard `if (botState.sock && botState.whatsappConnected)`. Note `botState.isReconnecting`
  is created dynamically and is not in the literal.
- Realtime always goes through `broadcastToAdmins(event, payload)` into the `admin` room — never
  `io.emit`. The dashboard's listener list is in `public/index.html:4071-4204`.
- **The QR code never reaches the dashboard.** It is printed to the terminal only. "Show the QR in
  the dashboard" means building the whole path.
- Adding a settings key is a four-place edit: `config.defaults`, a form input, the object literal
  in `handleSaveSettings` (`public/index.html` ~3400), and the consuming read.
- `GET /api/pay/:orderId` and `/pay/:orderId` are the only unauthenticated data endpoints besides
  login and the webhooks. The order ID is the sole access control — any field added to
  `getOrderPublicInvoice` becomes world-readable to anyone holding an ID.
- `chatManager.js` runs a **second, independent** outbound queue for dashboard-originated messages,
  and rewrites a message's primary key after send (`admin_<ts>_<rand>` → real WhatsApp id).

### 11a. Route hygiene — three rules the dashboard broke

**Every webhook route needs its own parser.** The webhook block is registered *above*
`app.use(express.json())` so Casaku can verify a signature against the raw body. The
`/api/payment/webhook/midtrans` route was given no parser at all and answers without calling
`next()`, so `req.body` was always `undefined` and **every** Midtrans notification got a 400. Midtrans
retries a while, gives up, and `expireStaleOrders` then cancels an order whose money arrived. It now
carries `express.json()` as route middleware (Midtrans signs `order_id + status_code + gross_amount +
serverKey`, not the raw body, so a JSON parser is safe there).

**Verify before you write.** `handleCasakuWebhook` used to call `logWebhookEvent` before
`verifySignature`, so anyone who could reach the port could insert an attacker-sized row into
`payment_webhooks` — unauthenticated, unthrottled, into the same SQLite file the money path uses.
Verification now runs first; a rejected request logs a marker, not its payload. `verifySignature`
itself was always sound (fails closed on a missing secret, rejects non-hex, length-checks before
`timingSafeEqual`) — only the ordering was wrong.

**Never return `err.message` to a client.** 57 catch blocks across nine route modules did. On
`/api/login` that client is unauthenticated: `POST /api/login` with `Content-Type: text/plain` left
`req.body` undefined, the destructure threw, and the response was
`"Cannot destructure property 'username' of 'req.body' as it is undefined."` The same shape returned
SQLite driver messages with table and column names. Use `pesanErrorAman(err, konteks)` from
`src/routes/responErr.js`, which logs the real cause server-side and returns a neutral sentence. The
remaining `err.message` responses are 400s from DB helpers that throw deliberately user-facing
validation text — those are intentional.

## 12. Features, games, media, AI

- **Three unrelated game-state registries**, all in-memory Maps, all lost on restart:
  `activeRounds` (funHandler — quiz/tebakemoji/tebakkata/tebaklagu/sambungkata),
  `activeGames` (entertainmentHandler — tebakgambar/tebakangka/susunkata, driven from `bot.js`),
  `activeWwGames` (werewolfGame). Do not add a fourth without a reason.
- `activeRounds` is keyed by group JID in a group and sender JID in DM — one shared round per group.
- Round teardown is hand-duplicated at every exit: set `isAnswered`, `clearTimeout(round.timeout)`,
  **and** `activeRounds.delete(key)`. Missing the clearTimeout later posts a bogus "waktu habis"
  with the answer; missing the delete blocks the next `.quiz`.
- **funHandler vs entertainmentHandler is split by capability, not theme.** entertainmentHandler
  functions are pure — plain values in, `{success, buffer|text}` out, never touching `sock` or
  `database.js` (that would create an import cycle). funHandler holds the socket, points, cooldowns
  and state. New pure generators → entertainmentHandler. Anything that pays points or sends a
  message → funHandler. Note roughly half of entertainmentHandler's exports are called from
  `bot.js`, not funHandler.
- **All point/XP writes go through `database.js` helpers** — `getGameProfile`, `addGamePoints`,
  `deductGamePoints`, `awardGamePoints`, `claimGameDaily`, `addMessageXp`, `bankDeposit`. Never
  `UPDATE game_profiles` from a handler. Betting idiom: `deductGamePoints(bet)` **first**, bail on
  `!success`, then `addGamePoints(payout)` only on a win.
- Level formula `Math.floor(xp / 100) + 1` is written out in three places in `database.js` plus a
  hardcoded `xp % 100` in `cardGenerator.js:397`. Changing the curve means four edits.
- Chat XP is granted **in groups only**, from a fire-and-forget IIFE, with a 30 s per-user cooldown
  held in an in-memory Map inside `database.js`.
- **Temp-file idiom:** `path.join(process.cwd(),'tmp')`, mkdir recursive, write
  `${prefix}_${Date.now()}_${rand}.ext`, unlink in **both** success and error branches. The safety
  net is `index.js`'s hourly sweep of anything older than 30 minutes — so never hold a tmp path
  across more than 30 minutes of async work.
- **Importing `mediaHandler.js` spawns `pip install -U yt-dlp` immediately** (module-level call).
  It also *writes* `process.env.FFMPEG_PATH` from the bundled binary, so setting that in `.env` is
  pointless. yt-dlp runs through Python (`python`/`py`/`python3` tried in order) — a hard external
  dependency. Importing `entertainmentHandler.js` reads `public/game-images/rebus/` from disk.
- Downloaders are hand-rolled sequential fallback chains returning
  `{success, buffer?, videoUrl?, title}`. A "download failed" report needs the whole chain checked,
  not one library. Check the `provider` field — a success may be the degraded local path, not the
  remote API.
- `geminiService.js` is the deliberate exception to the `{success:false}` contract: it **rejects**.
  Callers must try/catch. It uses `gemini-1.5-flash` over raw node `https` — no SDK, no retry. All
  three request paths arm `pasangTimeout` (30 s text, 60 s image/document), which calls
  `req.destroy(err)` so the hang surfaces as a normal `error` rejection. Any new request block must
  do the same, or a hung socket leaves a promise that never settles and a user who never gets a
  reply. `premiumHandler` shows customers a generic message and appends `err.message` only for
  admin/owner.
- `.ocr` does **not** use Gemini — it uses local tesseract.js + pdf-parse. Only `.ai` calls Gemini.
- Premium is `premium_users(jid, tier, expires_at)` with exactly `Silver` | `Gold` | `Diamond`;
  `getPremiumTier` returns the literal string `'Free'` when there is no unexpired row — compare
  against `'Free'`, not null. Adding a tier is a three-place edit (`PREMIUM_TIERS`, `validTiers` in
  `grantPremium`, and the `tierOrder` map at `premiumHandler.js:432`).
- Only `aiDailyLimit` and `monthlyVoucherRp` are actually enforced. `shopDiscountPct`,
  `resellerAccess` and `restockDmAlert` appear only in template strings — there is no discount code
  path in checkout at all.

### 12a. Undercover (`src/games/undercover/`) — the one game with a state machine

`src/games/undercover.js` is now a **barrel** (`export * from './undercover/index.js'`). Every old
import path still works; do not add logic to it. The game itself lives in `src/games/undercover/`:

| Module | Owns | May import |
|---|---|---|
| `constants.js` | timings, limits, `ROUND_MODIFIERS`, `CARD_DEFS`, `MISSION_DEFS` | nothing (leaf) |
| `state.js` | `activeUndercoverGames`, pure helpers, save-to-disk | constants, database |
| `flow.js` | the phase machine, voting, trial, win conditions, `finishGame` | state, stats, roles |
| `roles.js` | category vote, role dealing, secret missions, role guide | state, flow |
| `abilities.js` | DM skills, ghost whisper, black market | state, flow |
| `cards.js` | the action-card shop | state |
| `stats.js` | recap, Trust Score, mission scoring, leaderboard | state |
| `index.js` | `handleUndercover` router, lobby, session restore, re-exports | all |

`flow.js ↔ roles.js` and `abilities.js → flow.js` are deliberate ESM cycles. They work **only**
because every cross-module reference sits inside a function body (AGENTS.md §16). Never dereference
an imported binding at module-evaluation time in these files.

- **Phase machine** (`session.status`), in order:
  `LOBBY` → `CATEGORY_VOTE` → `CLUE_PHASE` (or `ANON_CLUE_PHASE`) → `DISCUSSION_PHASE` →
  `VOTING_PHASE` → (`TRIAL_PHASE`) → (`MR_WHITE_GUESS`) → back to `CLUE_PHASE` for the next round.
  Round 1 runs **two** clue passes (`session.cluePass` 1 → 2) before discussion opens.
- **Never inline a phase transition.** Every path goes through `announceTurn` → `advanceTurn` →
  `finishCluePass` → `startDiscussionPhase` → `startVotingPhase` → `processUndercoverVotes` →
  (`startTrialPhase` → `resolveTrial`) → `executeElimination` → `startNextUndercoverRound`. The old
  file hand-duplicated the "enter voting phase" block in six places and they drifted apart; that is
  what the refactor removed.
- **Timer safety is `session.turnSeq`, not player identity.** `announceTurn` increments it and the
  timeout closure bails unless `cur.turnSeq === seq`. Any new timer in the clue phase must capture
  and check it, otherwise a stale timer fires against the wrong speaker.
- **Deaths outside voting go through `killPlayer` + `resyncAfterDeath`.** `killPlayer` returns
  `{idx, wasCurrent}`; it fixes `turnIndex` when the victim sat before the current speaker, and
  `resyncAfterDeath` re-announces only when the current speaker actually died. It also unblocks
  `ANON_CLUE_PHASE` and `TRIAL_PHASE`, which would otherwise hang waiting on a dead player's
  submission or verdict. Removing a player from `alivePlayers` by hand will hang the round.
- **Round modifiers are matched on `modifier.key`, never on `modifier.name`.** Renaming a modifier's
  display text used to silently disable its rule. `pickRoundModifier` gates `ANON`/`ESTAFET` behind
  `MODIFIER_MIN_ROUND` / `MODIFIER_MIN_ALIVE` so they cannot land on the two-pass round 1.
- **Sidang Terakhir (trial)** runs only when `round < 4 && alivePlayers.length >= 4`. In the Zona
  Merah skip is already locked, so an acquittal there would be a skip in disguise; at 3 players it
  only drags out the endgame. The accused may not vote on themselves, and a tie acquits.
- **Si Mabuk (`DRUNK`)** is a Civilian holding a decoy word from a *different* pair in the same
  theme, dealt only at 7+ players and only half the time. `isCivilianRole` includes it on purpose —
  counting it outside the civilian camp would shift impostor parity. It is revealed **only** in the
  final recap: every mid-game surface (elimination announcement, Sheriff/Assassin kill, Saboteur
  hack, dead-chat board) uses `getPublicRoleBadge`, which reports `DRUNK` as a plain Civilian.
  Shooting the Drunk is treated as a **valid** Sheriff kill — target dies, Sheriff survives, no
  `sheriff_kills` credit. If it counted as a misfire, one comedy role would double as a bomb that
  removes two civilians at once.
- **Split Word:** at 6+ players there is a 25 % chance the second impostor gets `pair.undercover2`,
  a different word. Both still know each other. `session.pair` is a *copy* (`{...pair, undercover2}`)
  — never mutate an entry of `WORD_PAIRS`.
- **Ghost whispers** (`.bisik`) are the only channel a dead player has. They are capped per player
  and per round and rejected if they contain digits, `@`, any player's name fragment, or any secret
  word — the dead-chat intel dump would otherwise leak straight into the group.
- **Mr. White's bought letters live in `roleData.boughtLetters`, not `session.revealedLetters`.**
  The latter is the public Zona Merah reveal; merging them would broadcast a purchase he paid for
  privately.
- **The buy-in is deducted in `assignRolesAndStart`**, not when `.startundercover` is typed — a
  cancel or restart during category voting must not burn points. `refundUndercoverSession` returns
  both the buy-in (`session.buyInCharged`) and every card purchase (`session.cardPurchases`), and
  runs on `.undercover cancel` and lobby expiry.
- **Mission bonuses use `addGamePoints` + `grantXp`, never `awardGamePoints`** (§12i): the match is
  already recorded by `recordMatchStats`, and the bonus is paid outside the pot.
- **Win parity excludes Mr. White**: impostors win on `aliveUndercover >= aliveCivilians`. Mr. White
  has his own solo-survival branch. Role pools are gated by player count — no Assassin/Mr. White
  below 5 players, no Saboteur below 6 — see `assignRolesAndStart`.
- **Stats** live in `undercover_stats` (schema.js) and are written only via
  `recordUndercoverResult` / `bumpUndercoverCounter` in `gamesDb.js`. The counter column name is
  whitelisted in `UNDERCOVER_COUNTERS` — never interpolate a caller-supplied column. Trust Score,
  the "deadliest clue" panel and mission scoring are derived at `finishGame` time from
  `session.voteHistory` / `session.eliminations` / `clueLog` and are **not** persisted.
- **Command names collide with the rest of the bot; two were resolved deliberately:**
  `.anon` (not `.petunjuk`, which is customerHandler's tutorial) submits an anonymous-round clue,
  and `.misi` is split at runtime — a player holding an Undercover mission gets the Undercover
  screen, everyone else keeps the daily-mission board (same pattern as `.heal`). `.misirahasia`
  always means Undercover.
- **`.tukar` is the Power-Up shop** (see 12b). The Undercover turn-swap skill is `.tukargiliran`.
- **It is testable without WhatsApp.** `node scripts/undercoverSmokeTest.mjs` plays real games
  (lobby → roles → clues → trial → elimination → recap) against a sandboxed SQLite copy with a fake
  `sock`, and covers each new mechanic separately so the result does not depend on the modifier
  draw. Run it after any change here.

### 12b. Point economy policy — Akbar Poin has no rupiah value

Deliberate rule, decided by the owner: **`game_profiles.points` (Akbar Poin) must never convert
into anything worth money.** Points are score + in-game power-ups only. Everything with real value
is bought with real money through the deposit balance (`.deposit` → QRIS → `customers.balance`).

- **Premium is bought with `customers.balance`, not points.** `PREMIUM_TIERS[*].priceRp` (Silver
  5 000 / Gold 10 000 / Diamond 25 000, 30 days each) is deducted by `deductCustomerBalance` in
  `.upgradepremium`. There is no `pricePoin` any more. Diamond's `monthlyVoucherRp: 10000` is kept
  deliberately — it is safe only because Diamond costs more than the voucher pays out, so **never
  price a tier below its own `monthlyVoucherRp`**.
- **`.tukar` is the Power-Up shop**, not a coupon/premium exchange: XP Booster 2x (24 h),
  Daily Boost 3x (one use), Perisai Anti-Maling (24 h), Surat Bebas Penjara (instant). The
  Undercover turn-swap skill is `.tukargiliran`.
- Power-ups live in `user_buffs(jid, buff_type, multiplier, uses_left, expires_at)`, one row per
  pair, helpers `grantUserBuff` / `getActiveBuff` / `getBuffMultiplier` / `consumeBuffUse` /
  `listActiveBuffs` in `gamesDb.js`. A row counts as active while it has time left **or** uses
  left; `getActiveBuff` deletes it once neither holds. Enforcement hooks live in exactly three
  places: `addMessageXp` and `awardGamePoints` (`XP_BOOST`, multiplies XP only — never points),
  `.daily` in `src/games/index.js` (`DAILY_BOOST`, consumed only after a successful claim), and
  `handleStealHeist` in `rpgSystem.js` (`STEAL_SHIELD`, checked against both the mention JID and
  the resolved profile JID).
- Lucky Spin's 1 % grand prize used to mint a real 10 % coupon; it is a 25x point jackpot now.
- Cooldowns and steal immunity live in `user_cooldowns(scope, kind, expires_at)` — `scope` is a
  player JID or a group JID, `kind` a free label (`STEAL`, `STEAL_IMMUNITY`, `HEIST:<id>`).
  Helpers: `setCooldown` / `getCooldownMs` / `clearCooldown` / `listCooldowns` (use the last one
  for list screens instead of one query per row). They were in-memory Maps before, so a restart
  wiped every cooldown — players could wait out a restart to cancel their `.steal` ban or strip a
  victim's immunity. Never put a cooldown that guards points back into a Map.
- `redeemPointsForCoupon` in `gamesDb.js` still exists but is dead **on purpose** — it turns points
  into checkout coupons. Do not wire it to a command.

### 12m. Blackjack table rules (`src/games/blackjack.js`)

Every tunable number lives in one block at the top of the file (`TARUHAN_MIN`, `TARUHAN_MAX`,
`KEMBALI_NATURAL`, `KEMBALI_MENANG`, `DEALER_BERHENTI`, `BATAS_WAKTU_MS`). The table follows standard
casino rules; each of these replaced something that was actually wrong:

- **One shuffled 52-card deck per round, dealt without replacement.** `drawCard()` used to pick a
  random rank and suit on every draw — i.e. *with* replacement. Measured over 20 000 simulated
  rounds, **25.7 %** of them showed the same card twice. Card removal now also affects the odds, as
  it should.
- **Dealer peeks for a natural before the hitting phase.** A player natural used to pay 3:2 even when
  the dealer also had one; that is a push. Dealer-only natural now ends the round immediately instead
  of letting the player hit into a hand they cannot beat.
- **Natural is two cards only**, and it pays 3:2 (`KEMBALI_NATURAL = 2.5`, i.e. 2.5x returned in
  total). 2:1 does not exist in standard blackjack; the real-world drift is the other way (6:5).
- **`BONUS_21` — a Spanish 21 style ladder for hand-built 21s.** Standard rules pay a multi-card 21
  exactly 1:1, but Spanish 21 (Pontoon in Australia) pays more the more cards it took. We adopted a
  deliberately stingier version of that table, because Spanish 21 funds its bonuses by stripping all
  four 10s from the deck (48 cards) and we do not:

  | 21 made with | Total returned | Frequency at normal play |
  |---|---|---|
  | 2 cards (natural) | 2.5x | 4.6 % of rounds |
  | 3-4 cards | 2x | — |
  | 5 cards | 2.5x | 1 in 407 |
  | 6 cards | 3x | 1 in 4 938 |
  | 7+ cards | 4x | 1 in 100 000 |

  Measured cost over 400 000 rounds: RTP 94.40 % → **94.43 %**, i.e. **0.03 percentage points**,
  because multi-card 21s are rare. **Do not add a rung below 5 cards without re-running the
  simulation.** Paying every hit-built 21 a flat 2.5x was measured at **99.90 % RTP** — that erases
  blackjack as a point sink entirely, which is the whole reason this game is good for the economy.
  Chasing the bonus is not exploitable either: hitting below 19 pushes the bust rate to 46.8 % and
  drops RTP to ~82 %.
- **Double Down is restricted to the first two cards** (`session.sudahHit`). It used to be callable
  at any depth, so a player could hit to 20 and only then double. The second stake is taken from
  `session.taruhanAwal` rather than the running `session.bet`; the amount is identical for a single
  double, but it keeps the "Main Lagi" button offering the original stake.
- **Reaching exactly 21 auto-stands** so a player cannot bust a hand that already won.
- **Dealer stands on all 17, including soft 17** (S17, player-favourable). Unchanged.
- **90-second timeout auto-stands the hand.** There was no timeout at all: `session.timeout` was
  declared and never assigned, so abandoning a hand left the stake deducted and the player locked out
  of `.bj` ("kamu sedang memiliki game aktif") until the next restart.
- **Table limits 10–5 000.** `.bj all` is capped to `TARUHAN_MAX` too. Without a cap a single hand
  could swing 41 579 points — a third of the entire point supply at the time this was written.

Sessions are in-memory only and are **not** restored after a restart; the 90-second timeout keeps
that exposure window short. If you ever make hands longer, persist them.

Simulated over 400 000 rounds with naive play (hit below 17), RTP is **94.4 %** — blackjack is a
point *sink*, which is the point. Do not raise the payouts without re-running that simulation.

`resolveSenderProfile` bridges `@lid` and `@s.whatsapp.net` identities and is unique to this file.
Its old query was `LIKE '%digits%'`, which matches anywhere in the string, so a player with an empty
wallet could be attached to a *different* person's profile whose JID merely contained the same digit
run. It is now anchored to the local part and requires at least 9 digits, and it logs whenever it
remaps. If you find a canonical identity resolver elsewhere, replace this with it.

### 12i. `addGamePoints` vs `awardGamePoints` — pick the wrong one and you mint XP

`awardGamePoints(jid, points, won)` does **three** things at once: adds points, adds **XP equal to
the points**, and increments `games_played` (+ `games_won` when `won`). `addGamePoints(jid, points)`
only moves points.

So `awardGamePoints` is correct **only for an actual game payout**. Use `addGamePoints` for refunds,
escrow returns, gifts, and admin grants. Getting this wrong is not cosmetic — because level is
`floor(xp/100)+1`, a 37 000-point refund used to hand out **370 levels**. Three such leaks existed
and are now closed; do not reintroduce the pattern:

- `.batalmines` / Mines timeout refund (`minesGame.js`) — refunding the stake is not a win.
- `.bansos poin` (`bansos.js`) — a handout of 2 000 points to 62 players was +20 levels each.
- `.sambungkata` (`games/index.js`) — one accepted word was recorded as one game won, which is
  where the 97.8 % lifetime win rate in `game_profiles` came from. That column is still polluted by
  historical data; treat `games_won` as unreliable until it is reset.

Still-legitimate `won = false` payouts (leave them alone): the raid consolation prize
(`raidBoss.js`) and the auction compensation payout (`mysteryAuction.js`) — both are real rewards
for players who actually played and lost.

`.sambungkata` also gained three rules while this was fixed: minimum 4 letters, no repeating a word
already used in the round (`round.kataTerpakai`), and the turn guard now applies in DM too. It was
group-only before, so in DM one player could chain words against themselves forever.

**The same trap exists on the XP side: `grantXp` vs `addMessageXp`.**

- `grantXp(jid, amount)` — atomic (`xp = COALESCE(xp,0) + ?` inside `withTransaction`), no cooldown.
  **Every game module uses this.** All 23 call sites were switched over.
- `addMessageXp(jid, amount)` — `grantXp` plus a 30-second per-player cooldown. **Only the two chat
  hooks in `bot.js` (`:3010`, `:3132`) may call it.**

Game modules used to call `addMessageXp`, so its chat cooldown silently ate their rewards. It gets
worse: the chat XP hook runs *before* command dispatch and sets the cooldown synchronously, so a
player's own `.serang` / `.bid` burns their 30-second window a moment before the game tries to pay
them. For blackjack, jailbreak, quizTournament, duelRoulette, umaDerby and the auction XP loot, that
call was the *only* XP source — those rewards were mostly never landing. The old implementation also
did a read-modify-write (`SET xp = ?`) through plain queries outside any transaction, so it could
overwrite XP that `awardGamePoints` had just committed; `withTransaction` only serialises against
other transactions (`connection.js`), never against plain queries.

### 12k. Dates are WIB, and daily markers must survive a restart

Known sites that were fixed by switching to `db.tanggalWIB()` — check any new one against this list:
`.daily`, `.laporan` (header showed today, figures were yesterday's between 00:00–07:00 WIB), and
the AI quota (`getAiUsageToday` / `incrementAiUsage`, which reset at 07:00 WIB and could be drained
twice inside two minutes across that boundary). Note `getDailySalesReport` already filters with
`DATE(created_at, '+7 hours')`, so passing it a UTC date silently queried the wrong day.

**Displaying a stored timestamp is the other half, and it was wrong everywhere.** `created_at`
columns use SQLite `CURRENT_TIMESTAMP`, which writes **UTC** as `"2026-09-13 03:55:38"` — no zone
marker. V8 parses that shape as **local** time, so `new Date(row.created_at)` on a WIB machine is
off by exactly 7 hours in the wrong direction: an order placed 10:55 WIB was shown to the customer
as 03:55, and `toLocaleDateString` moved late-night orders back a whole day. Use
**`src/utils/waktu.js`** — `keWaktu()` to parse (handles the SQLite shape, epoch ms as number or
string, and zoned ISO), then `tanggalJamWib` / `tanggalWib` / `tanggalPanjangWib` to render, all
pinned to `Asia/Jakarta` rather than the machine's zone so a move to a UTC VPS changes nothing.
Fixed at `.status`, `.riwayat`, the review screen, `.listmod`, the `.garansi` fallback window, and
the `receipts/YYYY/MM` folder for payment proofs. Section 21 of `produkAdminSmokeTest.mjs` pins it.

`jamWib()` is the same treatment for the three QRIS invoices' "Berlaku hingga … WIB" line. Those
render `casakuPayment.expiredAt`, which is an epoch when the provider omits it but an API string
when it does not — and an unzoned API string lands in exactly the SQLite trap above. They also
rendered in the host's zone while the label already read "WIB", so the label would start lying the
day the bot moves off the owner's laptop. Section 22 pins it.

Database backups use the same pattern: `KUNCI_BACKUP` in `scheduler.js`. `lastBackupTime` was an
in-memory variable that reset to 0 on every start while `startScheduler()` also ran a backup on its
last line, so **every restart produced a backup**. Combined with `MAX_BACKUPS = 15` OR-ed against the
day cutoff, the promised 14-day retention was measured at **~1.7 days** (15 files spanning 25 Aug
17:33 → 27 Aug 10:30). The file cap is now 60 and exists only as a disk guard; retention is the day
cutoff, and the marker is written *after* a successful copy so a failed backup retries next hour.

The players and the owner are in WIB (UTC+7). `new Date().toISOString()` is UTC, so using it for a
"today" string moves the day boundary to **07:00 WIB**. `.daily` had this bug: anyone claiming
between midnight and 7 a.m. was told "already claimed today" although it was a new day for them.

Use `tanggalWIB()` (`gamesDb.js`). `tcgTanggalHariIni()` (`tcgDb.js`) is the same function under a
TCG-specific name — do not add a third.

Daily scheduled jobs in `scheduler.js` keep their "already ran today" marker in `settings`, not in a
module variable:

- `lastBankInterestDate` → settings key `lastBankInterestDate`
- `lastDailySalesReportDate` → settings key `lastDailySalesReportDate`

Both used to be in-memory `let` variables reset to `''` on every boot. Since backups (and therefore
restarts) are frequent, a restart inside the job's window ran it **twice**, and being down for the
whole window skipped it with no catch-up. Bank interest now also has a catch-up: if the 00:00–00:10
WIB window was missed, it pays once as soon as the bot is back that day. However many days were
missed, it still pays **once** — the marker is a date, not a counter. A fresh install (empty marker)
never triggers catch-up. The marker is written *before* the payout, deliberately: a failed payout
should cost one skipped day, not risk paying twice on the next minute's attempt.

### 12j. `.resetleaderboard` is the most destructive command in the bot

`resetGameLeaderboard(mode)` in `gamesDb.js` runs an `UPDATE game_profiles ... SET points = 0, xp = 0`
**with no `WHERE` clause**. It used to take no parameters at all, and its gate in
`groupAdminHandler.js` was `!isOwner && !isAdminUser` — where `isAdminUser = isAdminStore ||
isGroupAdmin || isOwner`. Any **WhatsApp group admin, in any group**, could wipe the whole economy
with one argument-less message. The location guard above it was dead too: it reads
`botSettings.adminGroupId || botSettings.transactionLogGroupId`, and neither key exists in
`settings` (the table has `transactionGroupId`, deliberately excluded per the comment there), so
`adminGroupId` resolved to `""` and the guard never fired.

Now: **owner only**, an explicit mode is required, and a `YA` token must follow after the real blast
radius has been shown on screen.

- `resetGameLeaderboard('bersih')` (the default, and where any unrecognised mode falls back) only
  deletes profiles belonging to users who never ran `.daftar`. Registered members are untouched.
- `resetGameLeaderboard('total')` also zeroes points/XP/level/streak for every registered member.
- `pratinjauResetLeaderboard()` is the read-only preview that feeds the confirmation screen.
- `bank_points` is **not** zeroed by either mode. That matches the old behaviour and is deliberate,
  but it means "reset total" leaves the bank balances standing — decide consciously before changing.

### 12c. Raid World Boss (`src/games/raidBoss.js`) — the second persisted game

`activeRaids` is a group-keyed registry. Like Undercover it **persists**, to `data/raid_state.json`
via `saveRaidSessions()`, and is rehydrated by `restoreRaidSessions(sock)` from the
`connection === 'open'` handler in `bot.js`. Only `status === 'BATTLE'` sessions are written; a
lobby is 60 seconds long and not worth resuming. Snapshots older than 15 minutes are discarded with
a message to the group instead of being resumed.

Balance facts that are easy to break by editing one number:

- **`baseHp` and `attack` in `BOSS_TEMPLATES` are calibrated for a 4-player party.** The live values
  are `boss.maxHp` / `boss.atk`, computed once in `startRaidBattle` from `faktorHp()` / `faktorAtk()`.
  Never read `baseHp`/`attack` during combat.
- **Rewards are per player (`poinPemain`), never a prizepool split.** Splitting a pot punished big
  groups twice, since the boss also scales up with party size.
- Every payout is multiplied by `rasioPartisipasi()` — actions actually sent over rounds actually
  present, floored at `PARTISIPASI_MIN`. KO'd and tentacle-gripped players are credited an action so
  the anti-leech rule only bites players who are alive and silent.
- **Skills are role-locked** through `SKILL_ROLE`, and `bolehAmbilRole()` caps one role at 60% of the
  party from 4 players up. Without both, the optimal party is all-DPS and the class system is
  decoration. The AFK fallback in `executeRoundResolution` must stay role-correct — a mage falling
  back to `serang` used to out-damage a mage who actually played.
- Shields have a cap (`SHIELD_CAP_RATIO`) and decay each round (`SHIELD_DECAY`). They used to stack
  forever, which made a single `.tameng` spammer functionally immortal for the whole party.
- The fight is bounded: `ENRAGE_ROUND` starts a per-round damage ramp and `MAX_ROUND` ends it as a
  defeat. Phase 2 (`PHASE2_RATIO`) buffs the boss and makes `.freeze` fail 35% of the time.
- Each boss owns a mechanic (`bara` / `lifesteal` / `chain` / `cengkeram`); `erebus` borrows a random
  one per round and rerolls its elemental weakness, so its `lemah`/`tahan` are only valid for the
  current round.
- **Stats** live in `raid_stats` (per player) and `raid_group_progress` (per group), written only via
  `recordRaidResult` / `recordRaidGroupKill` in `gamesDb.js`. Boss ids are whitelisted in
  `RAID_BOSS_IDS` because they become column names — never interpolate a caller-supplied id.
  `raid_group_progress.kill_leviathan` is what unlocks Nightmare Mode (`erebus`).
- Per-boss lobby cooldowns use `setCooldown(groupJid, 'RAID:<bossId>', ms)` — restart-proof by
  design (see 12b). A loss costs half the cooldown of a win.
- Card loot calls into the TCG module through dynamic imports inside a `try/catch` (`beriLoot`);
  arena failures must never block the point payout.

### 12d. Lelang Kotak Misteri (`src/games/mysteryAuction.js`) — the third persisted game

`activeAuctions` persists to `data/auction_state.json` and is rehydrated by `restoreAuctionSessions`
from `bot.js`. **This one is not optional.** Bids are escrowed: `placeBid` deducts the points
immediately and refunds the previous top bidder, so a session lost to a restart is a session where
real player points vanished. The restore path either resumes the auction or refunds the escrow —
never neither. Snapshots older than 10 minutes are refunded and dropped.

- **The loot is rolled when the auction OPENS**, not when the hammer falls. Three clues leak at
  30/20/10 seconds remaining, drawn from the winning loot's `sifat` tags. ~20% of clues are
  deliberately drawn from a loot the box does NOT contain; the opening card tells players this.
  `undiSifat` also forces the first two clues to be traits shared by ≥2 loots — a clue that points
  at a single outcome ends the game at second 10.
- **Traits must stay shared between good and bad outcomes.** When adding loot, give it `sifat` that
  already exist on an opposite-value item in the same pool. A trait unique to one loot is a spoiler.
- **Timing is two phases, not one timer.** `BID_PHASE_MS` then a hammer: SEKALI → DUA KALI →
  TERJUAL, `PALU_STEP_MS` apart. Any bid during the hammer resets it to zero until the auction
  passes `MAX_TOTAL_MS`, after which the hammer can no longer be reset.
- **Hidden reserve** (`TINGKAT_RESERVE`) is rolled per auction; 60% of the time it equals the open
  bid, so most auctions clear. The opening card always claims a reserve exists — that uncertainty is
  the point. Missing it withdraws the box, refunds the top bidder, and still charges board fees.
- **Board fee** (`BIAYA_PAPAN_RATE`, capped at `BIAYA_PAPAN_CAP`) is charged to every bidder who
  did not win. `cancelAuction` charges nobody and refunds in full — cancelling must never cost a
  player points.
- The old "winner has no points → jail 15 minutes for fraud" path is gone. It existed only because
  payment happened at the end; escrow removes the situation entirely. Do not reintroduce it.
- **Stats** live in `auction_stats`, written only via `recordAuctionResult` in `gamesDb.js`. The
  category (`jackpot`/`trap`/`zonk`) is whitelisted in `AUCTION_KATEGORI` because it becomes a
  column name. Net profit is not stored — it can be negative, while every column is clamped to ≥ 0
  on read; it is computed in the query and on screen.
- Per-box-type cooldowns use `setCooldown(groupJid, 'LELANG:<boxId>', ms)`, restart-proof by design.
- **Four modes**, all sharing one session shape and one event scheduler:
  - `TERBUKA` — open ascending bids, escrowed, hammer at the end.
  - `BUTA` — sealed bids arrive **through DM**; `handleAuctionCommand` routes `.bid` from a
    non-group chat to `placeSealedBid`, which finds the newest live blind auction. Every sealed bid
    is escrowed and revisable. Highest bidder wins but **pays the second-highest price** (Vickrey),
    raised to the reserve if the reserve sits above it. There is deliberately **no hammer phase**:
    nothing is public, so a countdown would only stall.
  - `KUTUK` — reverse auction on `KUTUK_BOX`. `currentHighestBid` means "the LOWEST offer so far"
    and bids must go *down*; nobody escrows anything because nobody pays. The winner receives the
    pot and then eats the curse — 15% of the pool is a dud, which is what makes the chicken game
    worth playing.
  - `GUDANG` — three lots chained by `lanjutkanGudang`, which re-enters `bukaLot` after a delay.
    Lot cooldowns are intentionally bypassed inside a chain, and the lobby cooldown is only set
    after the final lot.
- **Sabotage** (`.endus` / `.gertak` / `.sikut`) charges points up front. `.endus` sends a clue by
  DM that is **always truthful** — that honesty is exactly what the player paid for, and it must
  stay separate from the public clues that may lie. `.intip` was NOT used: Undercover owns it.
- Anything that is not points (shield hours, a free-jail ticket, XP, a jail sentence) must set
  `nonPoin` in `terapkanLoot`, or the profit line reports a win as a pure loss (or a jailing as a
  clean profit).

### 12f. Unified leaderboard (`src/games/leaderboard.js`)

`.lb [kategori]` (plus the legacy `.rank` / `.top` / `.leaderboard`) is the single entry point for
every ranking. `KATEGORI_PAPAN` maps a category id and its aliases to either a data source or a
delegation target.

- **Boards that already have their own handler are delegated, never redrawn.** `.lb raid` calls
  `handleRaidCommand(..., 'raidtop')`, `.lb lelang` calls `handleAuctionCommand(..., 'lelangtop')`,
  `.lb undercover` calls `handleUndercover(..., ['undercover','top'])`. Copying their formatting into
  this module would create a second place to update whenever a board changes.
- Profile-backed boards (`poin`, `level`, `kaya`, `menang`, `streak`) all run through
  `getProfileLeaderboard(mode, limit)` in `gamesDb.js`. `PAPAN_PROFIL` is a whitelist of ORDER BY
  fragments because they are concatenated into SQL — a mode name must never reach it unmapped.
- Every board fetches 50 rows but prints 10, so it can always tell the sender their own position.
  That line is the point of the feature for anyone outside the top ten.
- `chat` reads `group_chat_stats` and is group-only (`grupSaja`). `tcg` uses
  `getTcgLeaderboard` in `tcgDb.js` (distinct cards, then tower floor). Three more Arena boards live
  in `tcgMetaDb.js`: `tcgrank` (season Elo), `abadi` (endless-tower depth) and `tcgstreak` (daily
  streak).
- **Aliases are a flat namespace and the first definition wins.** `streak`/`beruntun`/`absen` were
  already taken by the `.daily` board, so the Arena streak board had to claim `tcgstreak` /
  `beruntunarena` / `absenarena` — reusing them would have made the new board unreachable, silently.
  There is a duplicate-alias check in the smoke-test scratchpad; run it after adding a board.
- Rows must expose the display name as **`customer_nama`** — that is the only column
  `namaTampil()` reads. A board that aliases it to anything else renders every row as a raw
  `@62…` mention.
- Category titles already carry their own emoji; the renderer must not prefix another one.

### 12n. Never build a recipient list from `getProfileLeaderboard()`

That function deliberately drops the owner **twice** — once via `c.role != 'OWNER'` in SQL, and
again by matching phone digits against `settings.ownerNumber` — so the owner cannot dominate their
own leaderboard. It also silently truncates at 100 rows (`Math.min(100, limit)`), so asking for 500
returns at most 100.

Both behaviours are correct for a leaderboard and wrong for anything else. `bansos.js` reused it to
pick who receives a handout, and the result was that **the owner never received their own bansos**:
production had 63 registered members and `bansos_log` recorded 62 recipients, twice in a row. The
100-row cap had not bitten yet only because fewer than 100 members are registered.

Use `getPenerimaBansos(limit)` for handouts — same join, no owner filter, no hidden cap.

### 12h. Bank economy — three rules that lock together

`BANK_BUNGA_RATE` / `BANK_BUNGA_TIER` / `BANK_BUNGA_CAP` / `BANK_ENDAP_MS` live at the top of the
bank block in `gamesDb.js`. Changing one without the others reopens a hole:

1. **Withdrawing your own money is not taxed** (`bankWithdraw` defaults `taxRate = 0`). Deposits were
   free while withdrawals cost 2%, so depositing 100 and withdrawing 100 returned 98. Combined with
   2%/day interest the bank became a one-way valve: at the time this was written 95% of all wealth
   in the bot sat in the bank and only ~5,800 points actually circulated across 134 wallets.
2. **Interest is tiered and hard-capped** — `applyDailyBankInterest` pays `rate` on the first `tier`
   points only, never more than `cap` per account per day, still as one atomic statement.
   Previously 93% of the ~2,400 points minted daily flowed to three accounts.
   *Note:* with the current numbers `tier * rate` equals `cap` exactly (5000 × 2% = 100), so the cap
   does not bind yet — lower `BANK_BUNGA_CAP` if you want it to actually bite.
   `hitungBungaHarian` is the same formula for display; keep the two in step.
3. **A settling period replaces the withdrawal tax as the brake.** A fresh deposit stays reachable by
   `.steal` for `BANK_ENDAP_MS` (`bank_pending` / `bank_pending_at` on `game_profiles`). Without it,
   removing the withdrawal tax would make the bank a perfect shield and kill `.steal` outright.
   `getSaldoRawan` is the read model and `curiSaldoKorban` the only writer that drains it — wallet
   first, then unsettled deposits, never settled bank balance. `rpgSystem.js` steal uses both.

### 12g. Arena energy and owner bansos

**Energy is split per activity.** `tcg_tower` now carries two independent pools: `stamina`
(Menara, cap `TCG_MAX_STAMINA_MENARA`) and `energi_gerbang` (Gerbang, cap
`TCG_MAX_ENERGI_GERBANG`), each with its own `*_at` timestamp. They previously shared one 5/day
column, which is exactly what players complained about in the group log: prepping a deck for the
tower and then discovering that farming the gate drained the same budget. Menara is one-way
progression (30 floors, it ends); Gerbang is repeatable daily farming. They must never share a
budget again. Sparring stays free with its own quota in `tcg_spar`.

*Since v3.0:* **Menara Abadi shares the Menara stamina pool on purpose** — it is the same activity
continued past floor 30, and by the time it unlocks the main tower no longer spends anything. That
is the one exception to the split above, and it is not a precedent for merging pools.

- **Refill is regen, not a midnight reset.** `hitungRegen` is computed lazily on read inside
  `tcgGetTower`. It deliberately keeps the remainder: 7 hours against a 6-hour interval consumes 6
  and carries 1 forward, otherwise players lose progress every time they check their status.
- `tcgGetEnergi` is the read model for every screen; `tcgPakaiStamina` / `tcgPakaiEnergiGerbang` are
  the only writers that spend, `tcgTambahEnergi` the only one that grants (and it clamps to the cap).
- **Ransum** (`TCG_RANSUM`, table `tcg_item`) is the only way to gain energy outside regen, and it
  is deliberately **not purchasable with Akbar Poin**. Energy that money can buy turns `.lb tcg` and
  the tower into a leaderboard of the richest player, not the most active. Sources are gameplay
  only: `.tcg daily` (guaranteed one) and Raid Boss victory (`beriRansum` in `raidBoss.js`).
- `tcgKlaimGratis` never touched stamina, but the daily message claimed it refilled it. That line is
  now a real ransum grant — do not reintroduce the claim.

**`.bansos`** (`src/games/bansos.js`) is the owner's mass-distribution tool — poin, Keping, energi,
ransum, kartu, a mixed `paket`, or a forced card `drop` across groups, each with an announcement
letter. It is owner-gated, every distribution is written to `bansos_log` (it mints value from
nothing, so it must be traceable), and per-distribution amounts are capped in `BATAS` so a stray
zero cannot wreck the economy in one command. Recipients come from `getProfileLeaderboard`, and the
group targets are shared with the release announcer via `daftarGrupPengumuman`.

### 12o. Moderation warnings expire, and forgiveness must exist

`addCustomerWarning` counted with a bare `COUNT(*)` — no time window at all. Warnings were therefore
**permanent**: once someone reached `kickAfterWarnings` (default 3) they sat at the kick threshold
forever, and every later slip ejected them instantly. There was no `.unwarn`, and
`clearCustomerWarnings()` existed in the data layer with **zero callers**. Measured on production:
8 of 194 customers were already at ≥3, one at 50.

That is not cosmetic here — `checkout` requires group membership, so being kicked costs the customer
the right to buy.

- `getCustomerWarningsCount()` counts only the last `warningWindowDays` days (setting, default 7).
- `.unwarn @user` clears all; `.unwarn @user 1` withdraws just the most recent.
- `.cekwarn` lists everyone at ≥2 active warnings; `.cekwarn @user` shows one person's active count,
  lifetime count, and last three reasons.
- Moderators may use `.unwarn`/`.cekwarn` — they are in `perintahModerator` (§9).

### 12p. Anti-link matches hosts, not substrings

Two bugs at once, in opposite directions:

- The old pattern required `http://` or `https://` for general URLs, so plain `bit.ly/promo` — which
  WhatsApp still renders as tappable — bypassed the filter completely.
- Matching used `lowerUrl.includes(dom)`, so the blocklist entry `t.me` also matched ordinary text
  like `chat.mereka`, and matched allowed sites whose path merely contained the fragment.

The scheme is now optional, and every candidate is reduced to its host (scheme, path, query, port
and credentials stripped) before comparison via `cocokDomain(host, dom)`: exact match, `.`-suffix
match, or — for dot-less entries like `tinyurl` — a whole-label match. Widening the *pattern* is
safe because the blocklist is the actual gate; widening the *comparison* is what is dangerous.
There is a 19-case test in the scratchpad; re-run it if you touch either half.

### 12q. Downloader commands are rationed — the brake lives in a wrapper

Media/downloader commands used to have **no brake at all**: no cooldown, no quota, no
concurrency cap, and no byte limit on the non-yt-dlp path. `.autodl` was worse — it fires on any
TikTok/IG link from anyone, skipped even the registration check that command handlers run, and
defaults to ON (`gSettings.auto_dl_enabled !== 0` passes when the group has no row).

The brake is a thin wrapper in `bot.js`, deliberately kept out of the command bodies:

- `PERINTAH_MEDIA_BERAT` lists only commands that actually pull bytes or spawn ffmpeg. Stickers,
  quotes, memes, weather, and translation stay free so ordinary chat never stalls.
- `handleMediaCommands` is now a wrapper; the original body was renamed
  **`handleMediaCommandsInti`**. The wrapper checks quota, then holds a slot for the whole call
  via `try/finally`. Add new heavy commands to the list — do not add checks inside handlers.
- **Quota is charged on request, not on success.** A failed download already spent bandwidth, RAM,
  and CPU — exactly what is being rationed — and free failures would make broken links an
  unlimited engine. Commands with no argument and no quoted/attached media are exempt, because
  they only ever produce a "wrong format" reply.
- `SLOT_UNDUH` caps concurrent heavy jobs at 2. The 3rd caller **waits**, it is not rejected; the
  slot is handed straight to the next waiter so `jalan` never drifts.
- Limits are premium benefits: `mediaDailyLimit` / `mediaCooldownSec` in `PREMIUM_TIERS`
  (Free 15/20s · Silver 30/15s · Gold 60/10s · Diamond 150/5s). Owner and store admins are exempt.
- `media_usage_logs` mirrors `ai_usage_logs` exactly (jid, usage_date, count) and uses WIB dates.
  `db.bersihkanPemakaianMediaLama()` prunes it from the 8-hour scheduler sweep.
- `mediaHandler.fetchBuffer` now sets `maxContentLength`/`maxBodyLength` to `BATAS_UNDUH_BYTE`
  (50 MB). It loads whole responses into RAM with `responseType: 'arraybuffer'`, and it is the
  path used by TikTok, Instagram, Facebook, Twitter and Pinterest — yt-dlp paths were already
  guarded by `--max-filesize`.

### 12r. TCG card stats come from rarity × role — never rarity alone

`statKartu()` reads **`STAT_RARITY[rarity]` × `PERAN[peran]`**. Before Aug 27 2026 it read rarity
only, so 44 cards had exactly **five** stat profiles: all 16 Commons were 100/500, all 12 Rares
117/585, and so on. Eight cards were *perfect twins* — same rarity, element and skill, therefore
zero difference in combat. Players asked directly in the group: "Apa cuma raritynya aja?"

- **Rarity is the budget; role only decides how it is spent.** Every role's `atk × hp` product sits
  within 0.5 % of 1.0. That is not cosmetic: in an alternating-turn duel A beats B exactly when
  `HP_A/ATK_B > HP_B/ATK_A`, i.e. when `ATK_A × HP_A > ATK_B × HP_B`. The product *is* the power.
  A first attempt gave Penyergap 1.50 × 0.60 = 0.90 reasoning that "killing faster means taking
  fewer hits" — a 46-card round-robin proved it wrong (41.4 % vs Penyerang's 56.5 %), because turn
  order here is decided by star cost, not speed. **Keep the products equal.**
- Role does **not** change star cost, so initiative in `battle.js` is unaffected.
- `PENGALI_UNGGUL`/`PENGALI_LEMAH` went 1.35/0.75 → **1.20/0.85**. The old 1.8× swing exceeded what
  rarity itself was worth: a Rare with element advantage (117 × 1.35 = 158) out-damaged a Mythic at
  disadvantage (190 × 0.75 = 143). Players called it "menang ele". Never hard-code the percentage
  in text — `battle.js` derives it from the constant.
- Every Legendary and Mythic now has a skill no other card uses, and **all five elements have a
  Mythic** (AIR and ANGIN previously had none, so two of five elements had no top card at all).
- **`regen` is a percentage of max HP**, so it explodes on high-HP roles: 8 % of a 1235 HP Penjaga
  is 99 HP/round, more than most Commons deal. That put one card at 96.7 %. Check any regen skill
  against the role it sits on.
- Changing any stat, role, or skill **requires bumping `VERSI_KARTU` in `gambar.js`** — rendered
  cards are cached to disk by `${id}_${lv}_v${VERSI_KARTU}.png` and would otherwise show stale
  numbers forever.
- The balance harness lives in the scratchpad: it lifts `duelSatuSlot` out of `battle.js` by source
  text (it is not exported), runs all cards against all cards, and A/B's against an emulated old
  system. Re-run it after any card edit.

### 12s. TCG retention layer — `tcgMetaDb.js` + `tcg/meta.js`

Added Aug 27 2026 (v3.0). The Arena had plenty of *content* and almost no *reasons to come back*:
`.tcg daily` paid a flat 50 Keping forever, duels left no trace, the tower ended at floor 30 with
nothing after it, and the three daily missions were the same three every day — one of which
(`MENARA`) became **impossible** once a player cleared floor 30, punishing exactly the most active
players.

**File split and the one-way import rule.** `tcgDb.js` owns the economy (Keping, cards, shards,
energy). `src/database/tcgMetaDb.js` owns everything that is a reason to return. `tcgMetaDb.js` may
import `tcgDb.js`; **`tcgDb.js` must never import `tcgMetaDb.js`** — in ESM that cycle shows up as
a silent `undefined`, not an error. `initTcgMetaSchema()` is called from `schema.js` *after*
`initTcgSchema()` because it `ALTER`s `tcg_profil`. Command bodies live in `src/games/tcg/meta.js`;
the router stays single, in `tcg/index.js`.

**`catatAksi(key, aksi, n)` in `meta.js` is the only way to report gameplay.** It feeds daily and
weekly missions at once. Call it wherever the action actually happens and do not pre-filter — daily
missions are drawn per day, so `tcgCatatProgresMisi` silently ignores an action that is not one of
today's three. Splitting the reporting across call sites is how one of the two systems ends up
missing an event.

**Daily missions rotate; weekly missions do not.** `MISI_KERANJANG` in `tcgDb.js` is three baskets —
solo / combat-social / collection — and `tcgMisiHariIni(owner, tanggal)` draws one from each with a
pure djb2 hash. Nothing is stored: the row table keeps progress only. Basket 1 is always doable
alone, which is what keeps a player in a quiet group from ever seeing three impossible missions.
Endless-tower wins record `MENARA` as well as `ABADI`, which is what repairs the post-floor-30 hole.
Weekly missions (`TCG_MISI_MINGGUAN`) are deliberately fixed — a weekly goal you cannot plan on
Monday is worthless. Week key is the **Monday date**, not an ISO week number, because dates compare
correctly as strings across a year boundary.

**Streak.** `tcgKlaimHarian` replaced `tcgKlaimGratis` and does the whole claim in **one**
transaction: the once-per-day guard on `tcg_pity.gratis_tanggal`, base Keping, streak bonus
(`+10/day`, capped `+100`), and milestone payouts at day 3/7/14/30 (day 30 repeats every 30).
A second transaction was considered and rejected — if it failed, the player would lose a day-30
milestone with the daily guard already spent. `tcgGetStreak` is a **read**: a stale streak is
reported as 0 without writing, otherwise merely typing `.tcg` could break someone's streak.

**Season ranking — "paid" and "announced" are two different flags.** `tcgGetRank` pays the previous
season's reward on *any* call, because a reward that only lands when the player happens to open the
right screen is not a reward. But it is also called from screens that print nothing about seasons
(menu header, duel challenge card, `tcgCatatLaga`). So payment sets `hadiah_diklaim` while the
announcement text is held behind `hadiah_diumumkan`, consumed only by callers passing
`{ umumkan: true }` — currently `tampilMenu`, `tampilSpar`, `tampilRank`. Pass it only from a screen
that will actually print `teksHadiahMusim()`.

- Elo: `TCG_K_DUEL` 28, `TCG_K_SPAR` 12. Winning always moves at least ±1 — a win worth 0 points
  reads as a bug.
- **Sparring never moves the shadow deck owner's rating.** They are not playing; only their rating
  is read as a strength reference. Otherwise an active player could tank someone else's season
  without that person ever pressing a key.
- Twin-account brakes: `TCG_RANK_MAKS_PASANGAN` (3 rated duels per pair per day, tracked in
  `tcg_rank_pasangan` with the pair stored **sorted** so A-vs-B and B-vs-A are one row) and
  `TCG_RANK_MAKS_SPAR` (5 rated sparrings/day, keyed against the literal string `'SPAR'`).
- Soft reset `tcgResetLunak` — half the distance from 1000, floor 800. **Do not write
  `Number(x) || TCG_POIN_AWAL` here**: 0 is a legitimate rating and `0 || 1000` silently rewards the
  worst possible season. The smoke test covers exactly this.

**Menara Abadi** (`dekAbadi` in `battle.js`). Floors are *generated from their number*, so they
never run out and add nothing to the card catalogue. Three properties are load-bearing:
deterministic (otherwise players re-roll for an easy draw and the leaderboard number means nothing),
element-rotating (so one deck cannot carry forever — two on-theme cards, one off-theme), and
**growing in power while the reward stays capped** (`TCG_ABADI_KEPING_MAKS`). Endless floors with
linear rewards are an endless Keping faucet; the thing that grows without bound is the floor number,
which is what people actually chase.

- `acakLantai` **must** use `Math.imul`. Plain `*` on two 32-bit numbers exceeds 2^53 in a double
  and the low bits — the only ones `% length` reads — round to zero. The first version did this and
  produced the identical floor name for every single floor.
- `buatPetarung` accepts `item.skala`, and it deliberately allows values **below 1**: guardians are
  worth 13★ against a player deck capped at 10★, so floor 1 needs damping or it is harder than the
  tower's final boss. `skala` multiplies ATK and HP equally so real power (ATK×HP, see §12r) grows
  without shifting the role balance.
- The curve is **measured, not guessed** — `scripts/tcgAbadiKalibrasi.mjs` searches the 31 390
  legal 10★ decks at level 5 for the best counter per floor and plays 400 matches against it:
  floor 1 → 100 %, 10 → 95 %, 20 → 96 %, 25 → 86 %, 30 → 59 %, 40 → 23 %, 50 → 2 %. Level steps
  every 12 floors, not every 5 — the first attempt stepped faster and produced a wall (floor 19 →
  85 %, floor 20 → 16 %). Re-run the harness after touching any of the three constants; ±5 points
  of run-to-run noise is normal.
- The harness's reference row is the *existing* tower's final boss: the best legal counter deck wins
  ~54 % there, so Abadi floor 30 (~59 %) sits at about the same difficulty and the real wall is
  around floors 40-50. Its candidate pool must include **both** raw-power and element-countering
  decks — an element-only pool missed the true best deck for floor 30 and under-reported it as
  29 % instead of ~54 %.

**Barter follows the duplicate rule from `.tcg jual` / `.tcg serpih`: only `qty > 1` moves.** That is
not just consistency. It means barter can never empty a collection into another account, can never
break an equipped deck, and turns duplicates — until now only sellable or shreddable — into a reason
to talk to someone. Card **level does not transfer**: level is the owner's shard grinding, and moving
it would make barter a shortcut for grinding rather than for cards. Group-only (the trade is public),
`TCG_BARTER_KUOTA_HARIAN` 3/day each side, every trade written to `tcg_barter_log`. Pending offers
live in memory like duels — an offer surviving a restart lets someone accept a trade they have
forgotten, with cards that have since changed.

**Gelar** are re-evaluated on every `.tcg gelar` against a `tcgPotretPemain` snapshot rather than
being granted by triggers scattered through the code, so no title can be missed by a path that
forgot to call a recorder. Seasonal titles (Diamond+) are dynamic ids, so `tcg_gelar` carries its own
`nama` column; `getGelarDef` returns null for them and the row's `nama` is used instead.

**Menu numbering changed:** the entries are now 1-10 with **`0`** for help (it used to be `8`).
`8` is now `.tcg rank`. Anything that documents the shortcuts has to move with it.

### 12t. Bulk salvage, auto-deck, and the unified wallet

Added Aug 27 2026. Three quality-of-life commands, all of which exist because the manual version
stopped scaling once a collection passed a few dozen duplicates.

**`.tcg serpihsemua [rarity]` / `.tcg jualsemua [rarity]` — `tcgSerpihSemua` / `tcgJualSemua`
(`tcgDb.js`).** Each runs as one `withTransaction`, and both reuse the duplicate rule of the single
commands: `minSisa = Math.max(1, inUse)` where `inUse` is the number of `tcg_deck` + `tcg_ekspedisi`
rows holding that card. A bulk call therefore can never empty a collection, never break an equipped
deck, and never recall a card that is out on expedition. The rarity argument accepts a `TCG_RARITY`
value or `semua`/`all`; **anything else returns `RARITY_TIDAK_VALID` instead of falling through to
"all"** — this command destroys cards, so an unrecognised filter must never widen the selection.
Two distinct failure reasons exist on purpose: `TIDAK_ADA_DUPLIKAT` (no `qty > 1` at all) versus
`TIDAK_ADA_DUPLIKAT_BEBAS` (duplicates exist but every one of them is locked in a deck or an
expedition) — collapsing them tells a player to go get duplicates they already have.
`tcgJualSemua` writes **one** `tcg_ledger` row (`sumber = 'JUAL_SEMUA'`, `ref = BULK_<n>_CARDS`) for
the whole batch, not one per card. Neither calls `catatAksi`, which matches the singles: there is no
SERPIH/JUAL mission type.

**`.tcg autodek` (aliases `bestdek`, `autodeck`, `pasangauto`) — `tcgAutoBuildDeck` (`tcgDb.js`).**
Brute-forces every 3-card combination whose total star cost fits `TCG_MAX_DECK_COST`, scoring
`power = atk×2.2 + hp×0.9 + kritis×500` per card and multiplying the trio's total by
`1 + 0.08 × jumlah sinergi`, so a slightly weaker trio that forms a synergy can and should win.
Availability is counted, not flagged: a card is usable while `qty > (jumlah baris ekspedisi)`, so
owning two copies and sending one on expedition still leaves one to equip. The rebuild `DELETE`s the
whole `tcg_deck` row set before inserting, which is why it must stay inside the transaction — a
failure halfway through would otherwise leave the player with no deck at all. If no legal trio
exists, the fallback fills slots with the cheapest cards that fit rather than returning an error.
The search is O(n³) over available cards; that is fine at the current pool size and is the first
thing to revisit if the card list grows a lot.

`hitungSinergi` has to be imported into `tcg/index.js` from `cards.js` for the result screen. It was
missing on the first cut and surfaced as a `ReferenceError` only when someone actually ran the
command — the router itself loaded fine.

**`.dompet` / `.wallet` / `.aset` / `.assets` / `.rekening` — `getUnifiedWalletData` (`gamesDb.js`),
handled in `src/games/index.js`.** One `Promise.all` across five domains that used to need five
separate commands: `customers` (IDR balance, role, name), `game_profiles` (points, bank, pending
deposit, level, XP, streak, jail), the TCG side (`tcg_wallet.keping`, unique/total cards, shards per
rarity, `tcg_profil.gelar_aktif`), today's `ai_usage_logs` / `media_usage_logs` counters, and the
premium tier — the AI quota line is `getPremiumBenefits(tier).aiDailyLimit`, so it moves with the
tier table instead of restating it.

Column names are the trap here, and every one of these was an actual bug during the build:
`customers` has **no `id` and no `created_at`** (registration time is `registered_at`),
`game_profiles` keys on **`customer_jid`**, not `jid`, and the equipped title on `tcg_profil` is
**`gelar_aktif`**, not `active_title`. Check `schema.js` before adding a join to this query.

The command takes an optional target — a mention, the participant of a quoted message, or a phone
number resolved through `resolveTargetJid` (never string-built into a JID; see §9a). It is not in
`isPrivateCommand`, so the card is printed in the group where it was typed. That is deliberate for
`.dompet @member`, but it does mean a member's rupiah balance is visible to the group, exactly like
`.saldo`. If that ever has to change, redirect the *self* lookup to DM and keep the targeted form
public — dropping the target is the more expensive fix.

### 12u. Bringing difficulty back — previews, floor modifiers, Gauntlet, group boss

Added Aug 27 2026 (v3.2). Context for why this exists at all: **the TCG battle has no player
decisions in it.** `simulate3v3` runs three slots to completion the moment it is called. Everything
the player can influence happens *before* the fight — which cards they own, what level those cards
are, and which three go into the deck. So the entire challenge surface of this game is deck
construction, and `.tcg autodek` (v3.1) solved deck construction mathematically. The five changes
below put decisions back without touching the combat engine's balance.

**Guardian previews (`ringkasPenjaga` / `elemenDek` / `saranCounter` in `battle.js`).** The 30-floor
tower used to print only the floor name and its reward. The guardian deck was hidden, so
counter-picking was impossible and a player learned the matchup only *after* stamina was spent. That
is difficulty by ignorance, not by design — it tests "have you already lost here once". Both
`kelolaMenara` and `kelolaAbadi` now list the guardian's three cards with level and star cost, plus
one hint line naming the **elements** that beat them. Naming elements rather than cards is
deliberate: it gives direction while leaving the choice inside the player's own collection.

**Floor modifiers (`MODIFIER_ABADI`, `modifierAbadi`, `periksaSyaratModifier`).** From Menara Abadi
floor `ABADI_MODIFIER_MULAI` (10) upward, every floor carries one of eight extra rules. Three
properties are load-bearing and must survive any future edit:

1. **Deterministic** — derived from the floor number, like the floor's name and guardian. Randomize
   it and players re-roll until they get an easy rule, which makes the depth leaderboard meaningless.
2. **Visible before the fight** — `.tcg abadi` prints the modifier and its effect. A hidden modifier
   reads as the bot cheating.
3. **One side only** — a modifier either weakens the player or strengthens the guardian, never both.
   Mixed modifiers make the measured Abadi win curve (see `ABADI_SKALA_AWAL`) unreadable.

`indeksModifier` walks the chain from floor 10 up so no two consecutive floors share a modifier. The
short version of that check — comparing only the two raw draws — was tried first and still produced
three identical floors in a row, because a floor whose draw was already shifted can land exactly on
the next floor's raw draw. The walk is ~0.1 ms even at floor 5000.

**Deck-construction rules are enforced outside the engine.** `laranganElemen`, `wajibElemen`, and
`batasBintang` are checked by `periksaSyaratModifier` in `kelolaAbadi` **before stamina is spent** —
breaking an entry rule is not a loss and must not consume a rationed resource. Only the combat
effects (`racunPemain`, `atkPemain`, `kritPemain`, `hpPenjaga`, `perisaiPenjaga`) reach the engine,
through `simulate3v3(..., { modifier })`.

Two engine details worth knowing before adding a modifier: **`racunLantai` is a separate field from
`racunMasuk`** because the `racun` skill *assigns* `racunMasuk` in `terapkanPukulan` and would wipe a
floor's poison; and `perisaiLantai` deliberately does **not** reduce super-effective hits — if it
blocked everything it would just be bonus HP and would teach nothing about countering.

**Gauntlet (`tcg_gauntlet`, `tcgTantanganDb.js`, `tantangan.js`).** The answer to "a player only ever
needs three good cards". Three fights per week; **cards that won a stage are locked for the rest of
that week's run**, so a full clear needs nine maintained cards. Enemy decks come from
`dekGauntlet(kunciPekan, tahap)` — deterministic per week, so everyone faces the same three opponents
and nobody can re-roll. Losing does **not** lock cards: one loss at stage 1 must not make the rest of
the week impossible. What is rationed is attempts (`TCG_GAUNTLET_PERCOBAAN`, 5/week), and the attempt
is spent only after the deck passes the no-reuse check. `tcgMenangGauntlet` takes the expected stage
number and re-checks it inside the transaction — without that, two `.tcg gauntlet lawan` messages
arriving together would both read stage 1 and both pay the stage-1 reward.

**Group boss (`tcg_bos`, `tcg_bos_kontribusi`, `tcg_bos_jatah`).** The only arena content whose
outcome is decided collectively; everything else can be played alone. One HP pool per group per week,
3 attacks/day/player, rewards split by damage share when it dies.

- **HP scales with participation**: `TCG_BOS_HP_DASAR` + `TCG_BOS_HP_PER_PENANTANG` added the first
  time each new player attacks, into *both* `hp` and `hp_maks` so already-dealt damage is never
  erased. A flat number fails twice over — unkillable in a quiet group, dead on day one in a busy one.
- **Elemental swing is much larger here** (`BOS_PENGALI_UNGGUL` 1.5 / `BOS_PENGALI_LEMAH` 0.7, versus
  1.13/0.89 in duels). The boss does not hit back, so "which cards do you bring" is the only decision
  left; at duel-sized swing it would not be felt at all.
- The daily quota is decremented **inside the same transaction** as the HP subtraction, or two
  near-simultaneous attacks both pass the quota check before either writes.
- `tcgBagiHadiahBos` gates on `hadiah_dibagi` inside its transaction, so the reward split is paid
  exactly once even if two messages land on the killing blow together.

**`tcgAutoBuildDeck(ownerJid, opts)` grew three options** so autodeck stays useful instead of being
the one answer to everything: `lawanElemen` (score by `power × pengaliElemen(...)` — build to *beat*
an element rather than to be strongest), `kecuali` (Gauntlet's locked cards), and `batasBintang` /
`laranganElemen` / `wajibElemen` (a floor's modifier). `.tcg autodek abadi` reads the next Abadi floor
and passes all of them at once. The raw `power` is still what gets displayed; the elemental weighting
lives in a separate `nilai` field so the number shown to players is not secretly seasoned.

**Import direction:** `tcgTantanganDb.js` may import `tcgDb.js` and `tcgMetaDb.js`; neither may import
it back. It also re-implements its own `bayarHadiah` instead of calling the `tcgDb` helpers, because
both modes pay out *inside* a larger transaction and those helpers open transactions of their own —
nested transactions in sqlite3 are not dependable.

**Testing:** `node scripts/tcgSmokeTest.mjs` covers all of this — 143 commands / 265 checks. It runs
against a temp SQLite database in a sandbox directory, so it is safe to run from the repo root, and
it is the only real test this project has. Run it after any TCG change.

### 12v. What the v3.2 audit found, and what changed in v3.3

An adversarial audit of the v3.2 release (22 agents, findings verified by independent refuters)
plus a follow-up review turned up six defects. They are recorded here because each one is a
*category* of mistake that is easy to repeat in this codebase.

**1. `saranCounter` recommended elements that lose.** The first version unioned `pengalahElemen`
over the *unique* element set of the guardian deck, which throws away the 2-themed + 1-outlier shape
that `dekAbadi` always produces, then filtered out any candidate sharing an element with the
guardian — which is exactly where the best counter often sits. Measured over floors 1-200: **147
floors (73.5%) suggested at least one net-losing element**, and 27% hid their own best answer. It
now scores every candidate across all three slots as a ratio (`avg pengaliElemen(kandidat → tiap
penjaga)` ÷ `avg pengaliElemen(tiap penjaga → kandidat)`) and only names candidates above 1.001;
when nothing qualifies it returns an empty string rather than misleading. `kelolaMenara`'s private
copy of the old formula is gone — one function now serves all three screens.

**2. The autodeck synergy multiplier never ran.** `hitungSinergi` returns
`{ atk, hp, sisaBintang, aktif }`, but both `tcgDb.js` and `index.js` read `sinergi.sinergi` — always
`undefined`. So `synergyMultiplier` was permanently 1.00 and the report permanently printed "no
synergy". Note the second half of the trap: synergy entries carry `syarat`, not `deskripsi`, so
renaming only the property would have shipped `undefined` into the player-facing message. **When a
field name is wrong, check every field on that object, not just the one that threw.**

**3. Gauntlet opponents ignored the star budget.** `dekGauntlet` picked from a rarity pool with no
cost cap and multiplied by `skala` up to 1.10, while players are capped at `MAKS_BIAYA_DEK` (10).
Measured: stage-3 decks were 12-14★, and on the week of 2026-08-24 the strongest deck that could
possibly exist (all 60 cards at Lv.5) won **10%**. Opponents now share the player's 10★ budget,
`skala` is back to 1.00 on all three stages, and difficulty comes from card level (3/4/5).

Two calibration lessons are baked into that fix. Enforcing the budget alone made stage 3 a **100%**
win for the best deck, because a random pick from a rarity pool is a bad deck — so the opponent now
draws from the strongest cards that fit, keeping weekly variety by picking among the top four.
And the honest measurement must enforce the **no-reuse rule**: measuring one optimal deck against all
three stages overstates the player badly. With the rule enforced, a complete Lv.5 collection wins
100% / 93-100% / 40-83%.

**4. Gauntlet accepted decks with empty slots.** `simulate3v3` concedes an empty slot but the match
is still won on majority, so a 2-card deck could win 2-1 and lock only two cards — clearing the mode
with six cards instead of the nine it exists to demand. Three filled slots are now required, and the
rejection happens *before* an attempt is consumed.

**5. `tcgAutoBuildDeck` claimed success while violating `wajibElemen`.** Only the main combination
loop enforced it; the `availableCards.length <= 3` shortcut and the cheapest-fit fallback did not.
The result was a loop the player could not escape: autodeck printed "Syarat dipatuhi", `kelolaAbadi`
rejected the deck, and the rejection message told them to run the same command again. **Any
constraint passed into that function must be enforced on all three paths.**

**6. Boss rewards could vanish two different ways.** Each new challenger added a flat
`TCG_BOS_HP_PER_PENANTANG` regardless of how much week was left — someone joining Sunday has 3
attacks and would need 10,000 damage each just to pay for the HP they brought (ceiling is ~6,900).
Casual participation therefore pushed the boss *further* from dying, and since rewards were paid
only by the killing blow, a boss that survived to Sunday paid **nothing to anyone**. The added HP is
now scaled by `tcgSisaHariPekan`, holding the break-even at ~1,429 damage/attack whenever you join.
Separately, `tcgBagiHadiahBos` no longer requires `status = 'TUMBANG'`: `tcgBosBelumDibereskan` finds
bosses that died without paying (the crash window between the two transactions) or whose week ended
alive, and `kelolaBos` settles them on sight — partial payouts scale by the fraction of HP removed.
There is no scheduler for TCG (`scheduler.js` does not mention it at all), so **a screen someone
actually opens is the only reliable trigger for weekly settlement.**

**Mission plumbing:** `catatAksi(key, 'GAUNTLET')` and `catatAksi(key, 'BOS')` were being called
against action ids no mission listed, so both were silently discarded. `GAUNTLET` joined `M_TEMPUR`
and a new `M_BOS` weekly mission was added. Gauntlet deliberately did **not** become a daily mission:
it is 3 stages per week, so a player finishing on Monday would stare at an impossible daily until
Sunday — the same trap §12s records for the MENARA daily after floor 30.

**Testing:** `scripts/tcgSmokeTest.mjs` is now 144 commands / 286 checks and has a section 9d that
locks each of these fixes. Writing those fixes also produced a `ReferenceError` in the tower defeat
screen that the smoke test caught — the exact failure mode §3 warns about, where a fatal bug shows up
as **silence** rather than a crash.

### 12w. Card naming — Indonesian names, English epithets

The catalogue is a deliberate ladder: ordinary animals at Common (`Katak Rawa`, `Tokek Batu`),
predators at Rare, half-myths at Epic, Nusantara legends at Legendary (`Nyi Blorong`,
`Batara Kala`), gods at Mythic (`Barong Agni`, `Sang Hyang Bayu`). **Do not translate card names
to English.**

The reason is structural, not aesthetic. The game's chrome is already English — rarity tiers,
`Gauntlet`, `Void` — while the creatures are local; that is the standard gacha formula. Translating
the names *inverts* the ladder, because the top two tiers are proper nouns with no translation:
`Batara Kala` stays `Batara Kala` while `Tikus Bara` becomes `Ember Rat`, so the cheap cards end up
sounding more premium than the endgame ones.

What carries the English flavour instead is `GELAR` in `cards.js` — a one-line epithet attached to
**Legendary and Mythic only**. Its absence on Common-Epic is a tier marker doing the same job as the
frame colour, so do not extend it downward. A loop at the bottom of the catalogue copies the map
onto `kartu.gelar`; every consumer must guard on it, since 45 of 60 cards have none. Each epithet is
anchored to that card's skill or stat (`Kala Rau` / *The Eclipse Devourer* has skill `GERHANA`;
`Kala Gledek` / *The Thunder That Splits Stone* has `GLEDEK_SELO`, and *selo* is Javanese for stone).

`MYT03` was renamed `Voidreaper` → `Kala Rau` in v3.5 for exactly this reason: it was the only pure
English name among 60 cards, and it sat in the tier where every other entry is a deity. The id did
not change, so collections, decks, and levels were untouched — but **`cariKartu` matches on the name
string**, so a rename does break `.tcg kartu <nama>` for anyone who memorised the old one.

**Renaming a card or touching the card layout means bumping `VERSI_KARTU` in `gambar.js`.** The
cache key is `<id>_<lv>_v<VERSI_KARTU>.png` with no content hash, so without the bump players are
served the old picture forever. `bersihkanCacheKartu()` exists but is called from nowhere and deletes
*every* PNG including the current version, so it is a purge, not a stale sweep — the version bump is
the mechanism, and stale files simply accumulate (`public/tcg-cards/` is gitignored, so they never
reach a commit).

Section 12 of the smoke test locks all of this: gelar confined to the two top tiers, no orphan ids,
epithets unique and ≤34 characters (longer ones get shrunk to mush by `tulisMuat` at 300px wide),
and — most importantly — that the epithet actually **reaches the screen**, since a populated map that
is never printed is precisely the silent failure §12v is about.

### 12x. Refine (R1-R5), Picis, and the tier watchdog

The owner asked for a gacha where some cards are must-pull and others are skippable. Measurement
showed that hierarchy **already existed** and was merely invisible: over a full same-rarity
round-robin (elemental exposure verified flat at 1.008-1.010, so the gap is not element luck),
MYTHIC ranged 41%-60%, LEGENDARY 45%-57%, EPIC 42%-54%. Cards of one rarity share an `atk x hp`
budget, so the entire spread comes from **skill quality**.

**R scales the skill, never the stats.** `skillEfektif(kartu, refine)` multiplies every numeric
coefficient by `REFINE_SKALA` (R1 x1.00 ... R5 x2.00) under per-coefficient caps in `BATAS_SKILL`.
Stats are untouched, so `periksaKeseimbangan()` stays green and the rarity budget promise in §12r
survives intact. The tier spread the owner wanted then emerges on its own: Gerhana's +60% opener
becomes +120%, while a flat `HP maks +10%` stays flat. **No hand-written tier list exists, and none
should** — the owner's instruction was that players judge for themselves and we only watch that
nothing gets too strong.

**`skillEfektif(kartu, 1)` must return the original `SKILL` object by identity**, not a copy. Every
measured calibration in this repo — the Menara Abadi curve, the Gauntlet numbers, boss HP — was
taken at R1 values. If R1 drifts, all of them drift silently. The smoke test and the tier meter
both assert identity, not equality.

Two traps, both caught by `scripts/tcgTierMeter.mjs` on its first run, both of which broke the
rarity ladder:

1. Skills that are a bare boolean (`bertahanMati`) have no number to scale, so R would be worthless
   for them. A `pulihSetelahMaut` rider was added — but giving it to *every* card with that flag
   handed Lahar Purba (Naga Merapi) a second reward on top of its already-scaling `tahan`, and it
   hit **67% against MYTHIC R1**. The rider now applies only when `punyaAngkaSkala()` is false.
2. The rider peaked at 0.26, which pushed Musang Gaib (RARE) to **63% against EPIC R1**. Lowered
   to 0.16. Both rungs now sit at 45% and 59%.

**The watchdog is the deliverable, not a tier list.** `node scripts/tcgTierMeter.mjs` fails with a
non-zero exit on three conditions: R1 identity drift, intra-rarity spread past `AMBANG_SEBARAN`,
and any R5 card beating the rarity above it past `AMBANG_NAIK_KELAS`. A card whose R is *weak* is
only ever a warning — that is a player's judgement to make, not the bot's. Run it after any change
to skill numbers, `BATAS_SKILL`, or the catalogue.

**Picis is the second currency, and it exists for one measured reason.** Levels used to cost Keping,
the same currency as gacha, and the production data showed who won that fight: **212 of 218
collection rows were still Lv.1**. The level system was dead. Picis separates the two decisions the
way Mora never competes with Primogems:

```
Keping   -> gacha, and only gacha
Picis    -> card levels (stats)
Serpihan -> card levels (per-rarity material)
Duplikat -> refine R1-R5 (skill)
```

The name survived the same Levenshtein collision check that killed `Manik` and `Koin` earlier:
`kepeng` is distance 1 from `keping`, `gobang` distance 2 from `gerbang`, `wang` distance 2 from
`rank`/`.bank`/`.ping`. `picis` is distance 5 from `keping` and collides with nothing.

Picis is credited from Gerbang and Ekspedisi, and **never written to `tcg_ledger.delta`** — that
column is summed by audit screens to compute Keping circulation, so putting Picis amounts in it
would poison the figure. `tcgAddPicis` records the trace with `delta = 0`.

Two migration facts worth keeping: existing wallets get `TCG_PICIS_WARISAN` exactly once, because
the grant sits *inside* the `try` block whose `ALTER TABLE` throws on every later boot. And new
players get `TCG_BONUS_STARTER_PICIS` — without it a fresh account has 0 Picis and cannot level
anything until its first Gerbang clear. The smoke test caught exactly that: every `.tcg naik` in the
suite failed with "Butuh 250 Picis, kamu punya 0".

`tcgRefineKartu` must never eat a duplicate that is on duty. A card can be standing in a deck slot
*and* away on an expedition at the same time, each holding one copy; checking only `qty > 1` would
let refine steal a card out from under the player's own deck.

### 12y. Banners, rate on/off, and the 50/50

`src/games/tcg/banner.js` is computed from the date, never stored. A 14-day period number derived
from days-since-epoch selects the featured MYTHIC from an explicit `GILIRAN` rotation, and the two
featured LEGENDARY are picked by rule: one sharing the mythic's element (so the banner has a
readable theme) and one from a different element (so a banner is never a trap for a player weak in
that element). This follows `dekAbadi` / `dekGauntlet` / `bosPekan` — **`scheduler.js` never touches
TCG**, so anything that must rotate on its own has to be derived from time, or it will silently stop
rotating the first time the bot is down at the changeover.

`GILIRAN` is written out explicitly rather than read from `KARTU` order: adding a Mythic to the
catalogue must not silently reshuffle a banner schedule that players are already planning around.

**Small pools need rotation, not randomness.** The first version picked the same-element Legendary
with a hash. With only two AIR legendaries, that produced Ratu Laut Selatan in 3 of 6 consecutive
banners — indistinguishable from a bug to a player. `p % seelemen.length` guarantees clean
alternation; the different-element pick is stepped by an odd multiple so the pool is walked before
anything repeats. Measured over 10 banners: all 10 Legendaries appear, 1-3 times each.

**Rate ON / rate OFF is a visibility requirement, not just a mechanic.** The owner's instruction was
that it be clearly visible. `.tcg banner` therefore states the featured cards, the exact percentage,
how many cards are rate-off, that rate-off cards **still drop**, and whether the player's guarantee
is lit. Pull results prefix featured cards with ⬆️. If you change the rates, change that screen in
the same commit — a probability the player cannot see is a probability they will assume is worse
than it is.

The 50/50 works the standard way: a non-featured card of that rarity sets `kalah_mythic` /
`kalah_legendary`, and the next card of that rarity is then forced to be featured. Mythic and
Legendary hold **separate** flags so one cannot consume the other's guarantee. The worst case is
provably two Mythics, and the smoke test asserts exactly that over 500 trials.

`tcg_banner` rows are keyed by `(owner_jid, banner_id)`, so an unused guarantee **does not carry**
into the next banner. That is deliberate — carrying it would remove any reason to pull now rather
than later. What is *not* reset is the global `tcg_pity` progress toward a Mythic at all; players
keep everything they have accumulated. Both facts are stated on the screen, because a gacha that
quietly resets progress is the fastest way to lose a player's trust.

`undiKartuBanner` mutates the `status` object in place and the caller must save it. `prosesTarikan`
reads it once, mutates through all ten pulls, and writes once — writing per pull would issue ten
round-trips for one outcome.

**Consecutive banners must not repeat a Legendary, and that cannot be done by looking backwards.**
Three attempts, all measured:

1. No ban at all -> 4 of 19 consecutive pairs shared a card (21%).
2. Ban the previous period's picks, computed one level back -> 3 of 23 (13%). Still wrong, because
   what it banned was "what period p-1 would have picked if it had no ban of its own", and p-1 did
   have one.
3. Two levels back -> **worse**, 10 of 59 (17%). The regress gets deeper, not shallower: knowing
   p-1 needs p-2, which needs p-3, forever. There is no fixed point.

The fix is to stop looking backwards. `JADWAL` computes one whole cycle (`GILIRAN.length * 5`
periods) front-to-back once at module load, so each period sees the previous period's **real**
picks, and the wrap from the last period back to the first is checked too. `bannerAktif` is then a
lookup at `p % SIKLUS`. Measured over 81 consecutive banners (3.1 years): zero repeats, zero
consecutive same-element mythics, all 10 Legendaries featured.

A second measurement trap in the same code: the featured non-matching Legendary was originally
picked by indexing the *filtered* pool. That pool changes membership every period (a different
element is excluded), so the same index means a different card each time and the results clump —
Naga Krakatau landed in 4 of the first 8 banners. Walking a **stable full-list order** with a stride
of 3 fixed it. When you index into a collection, check whether the collection itself is stable.

Elements holding two Mythics (PETIR, ANGIN, DARK) naturally feature their Legendaries more often
than AIR's, which holds one. That spread (8x-25x over 81 banners) is structural, not a defect.

### 12z. Liar's Dice (`src/games/liarsDice.js`)

Perudo for 2-6 players. Five secret dice each, sent by DM every round; 1 (⚀) is wild for every face
except 1 itself. Turn timer 45 s, lobby timeout 60 s, buy-in 20-100,000 like every other betting
game. Winner takes the pot via `addGamePoints` (not `awardGamePoints` — see §12i; a 600k pot would
be truncated to 1000).

- **`session.resolving` is the anti-double gate, and it is load-bearing.** Between the DUDO reveal
  and the 3-second pause before the next round, `status` is still `PLAYING` but nobody holds the
  turn. Without the flag a second `.dudo` in that window resolves the same bid twice: the loser
  drops two dice and `finishLiarsGame` can pay the pot twice. `startNewDiceRound` is the only place
  that clears it.
- **Two timers, two fields.** `session.timer` is the per-turn 45 s timer; `session.roundTimer` is
  the 3 s pause to the next round. Both must be cleared when the game ends — a stray `roundTimer`
  re-rolls dice for a session that no longer exists.
- **The turn after an elimination is the *seat* after the eliminated player**, computed from the
  index taken *before* the filter (`loserIdxSebelum % alivePlayers.length`). Falling back to index 0
  hands player #1 the opening bid every single round.
- **Crash-recovery row uses `db.sesiGameId('liarsdice', jid)`**, never the raw JID. See the comment
  above `sesiGameId` in `gamesDb.js` for what raw JIDs cost the last time.
- **The group gets one live board** (§12ab): a bid is a `catatJejak` line, not a message. The only
  real messages are the lobby, each round's dice reveal, and the winner. Secret dice go to DM every
  round — that is the notification the player who must act actually needs.
- **Pure rules live in exported functions** — `hitungDaduDiMeja`, `bidLebihTinggi`, `rollDice`,
  `formatDice`. `node scripts/liarsDiceSmokeTest.mjs` runs them for real, including 300 full tables
  played to a winner. Do not restate a rule inside the test.
- **Alias gating (`src/games/index.js`)**: `liar` / `bohong` / `cekdadu` / `daduku` are claimed only
  while a table exists in that group; `tebak` is stolen from Tebak Angka only when the sender is a
  live player at a `PLAYING` table; `bid` is deliberately **not** claimed at all — it belongs to
  Lelang Kotak Misteri, which can run in the same group. `.kartu` needs its own hook inside the
  poker/UNO gate higher up the file or `checkSecretDice` is unreachable.

### 12aa. Mancing & Harta Karun (`src/games/fishingExplorer.js`)

Three spots (Danau free, Laut 20 poin, Palung 50 poin), weighted catch table, chests opened
separately with `.bukapeti`. Works in DM and in groups.

- **This is the only point source in the bot that needs no opponent**, so it carries three brakes
  and all three are persisted — the owner restarts the bot after every code change, and an
  in-memory brake would hand everyone a fresh allowance each time:
  1. 60 s cooldown per cast → `user_cooldowns`, kind `MANCING`.
  2. 30 casts per WIB day → `fishing_baskets.casts_today` (+ `casts_date`, reset via `tanggalWIB()`).
  3. 18 % miss chance — **the cooldown and the daily quota are consumed before the roll**, so a
     failed strike still costs a cast. Rolling first would let players re-cast until they hit.
- **The catch table is weighted (`chance`), not uniform.** The first version picked with a flat
  `Math.random()` over the pool, which made a Mythic Putri Duyung exactly as likely as a Sepatu
  Butut and gave Palung an EV of ~4,400 poin per 50-poin cast.
- **Treasure entries carry `baseVal: 0` on purpose.** Their value is paid at `.bukapeti`; giving
  them a sale price too pays for the same chest twice. The smoke test asserts this.
- **`fishing_baskets` is the basket, the daily quota and the personal record in one row.** Read it
  with `getFishingState`, write it with `saveFishingState`; 60-item cap, oldest discarded first.
  Both `.jualikan` and `.bukapeti` write the emptied basket **before** crediting points — a failure
  mid-way costs one sale rather than allowing the same fish to be sold twice.
- **`keranjang` is NOT a fishing alias and must never become one.** It is the customer's shopping
  cart (`customerHandler.js`, and the `id: '.keranjang'` button in five places). funHandler runs
  earlier in the chain, so claiming it makes the "🛒 Lihat Keranjang" button answer with a bucket of
  fish. Use `ember` / `ikan` / `tangkapan` / `fishbasket` instead.
- `node scripts/fishingSmokeTest.mjs` guards the economy: it recomputes the expected value per cast
  from the live tables and fails if the free spot or the daily ceiling drifts upward.

### 12ab. The live board — one message that is edited, not N that pile up

`catatJejak` / `perbaruiPapan` / `lepasPapan` in `src/games/helpers.js`. **Every turn-based group
game must use these.** The pattern originated in `umaDerby.js`, was proven in `uno/index.js`, and is
now the shared default.

The problem it solves: each game used to send **two** messages per turn — a narration of the action
and the full board — tagging every player in both. Battleship averages ~40 shots a match, so one
game meant 80 long messages and 80 phone buzzes per player. The game worked; sitting in the group
was unbearable.

```js
catatJejak(session, `🌊 ${tag(p)} tembak *B3* — meleset`);  // one action = one line, max 3 kept
await perbaruiPapan(sock, jid, session, renderPapan, { mentions: pemain });
```

- `perbaruiPapan` sends once, keeps `session.papanKey`, then `edit: key` afterwards. **Editing does
  not notify**, so the group only rings for things that genuinely matter.
- It re-anchors as a fresh message every `JANGKAR_ULANG_TIAP` (12) updates, so the board does not
  end up buried under chat, and falls back to a fresh send whenever WhatsApp refuses the edit
  (messages older than ~15 minutes — a normal path, not a failure).
- `mentions` is passed on **every** edit. The board writes players as `@tag`; without the array the
  tags render as bare phone numbers. It costs no extra notifications.
- `lepasPapan(session)` at the end of a round/match so the next one gets its own board. It also
  clears `session.jejak`.
- **Keep as real messages only what must ring**: match start, a round resolving (a dice reveal, an
  elimination), a magazine reload, the winner. Everything else is a `catatJejak` line.
- The board render itself must be short — it is re-rendered on every turn, so each decorative
  `━━━━` line is paid dozens of times per match. Target 3-5 lines. Icons instead of names
  (`🎒🚬🔍` not `🎒 Item: 🚬 Rokok, 🔍 Kaca Pembesar`).

Converted so far: `uno/index.js` (own copy, tied to `mentionsManusia` — leave it), `battleship.js`,
`cutTheWire.js`, `buckshotRoulette.js`, `liarsDice.js`. Still on the old two-messages-per-turn
shape: `mysteryAuction.js`, `raidBoss.js`, `poker/texasHoldem.js`.

**Every smoke test in `scripts/` ends with `process.exit(0)`.** Game modules reach `bot.js` →
`mediaHandler.js`, which fires `pip install -U yt-dlp` at import; without the explicit exit a test
that already passed hangs until its timeout and reads as a failure in CI-style loops.

### 12e. Release announcements (`src/utils/startupAnnounce.js`)

`umumkanBotOnline(sock)` is called from the `connection === 'open'` handler in `bot.js`. Two guards
matter and both are load-bearing:

- `connection: 'open'` fires on **every reconnect**, not just cold start. A module-level
  `sudahDiumumkan` flag limits the work to once per process.
- The group broadcast only runs when `BOT_VERSION` differs from the `lastAnnouncedVersion` setting,
  so a restart on an unchanged version announces nothing to members. The owner always gets a status
  card either way — that is the split: owner needs "is it alive", groups need "is there anything new".

Targets are the intersection of groups the bot still participates in (`groupFetchAllParticipating`)
and groups with a `group_settings` row, minus any group in `bot_mode: 'self'`. Sends are spaced by
`JEDA_SIAR_MS` and the whole run is delayed `TUNDA_MULAI_MS` so it does not collide with the offline
message queue being flushed at connect time.

Settings keys: `lastAnnouncedVersion`, `updateAnnounceEnabled` (`on`/`off`, toggled by
`.update on|off`). `.update broadcast` re-sends manually. All three are owner-only, handled in
`src/games/index.js` under the `update`/`changelog` command.

`src/utils/changelog.js` is now structured data, not one string: `RIWAYAT_VERSI[0]` is the current
release, `sorotan` is the short list used by announcements, `rincian` the full list used by
`.update`. Adding a release means prepending an entry AND bumping `BOT_VERSION` — the version string
is what triggers the next broadcast.

### 12l. The `.menu` gate regex must not restate the command registry

`customerHandler.js` gates `.menu` / `.help` / `.bantuan` with a regex before handing the suffix to
`buildCommandMenu`. That regex used to spell out the accepted category aliases itself and drifted out
of sync: the registry has **9** categories but the regex only accepted `1-6`, so `.menu 7` (pdf),
`.menu 8` (hiburan), `.menu 9` (admin), `.menu full`, `.menu premium` and `.menu lengkap` matched
nothing and the bot answered with **complete silence** — while the menu home screen itself printed
`📚 Semua perintah: .menu full` and `📖 Buka kategori: .menu <number>`.

The regex now captures any single alphanumeric token and lets `resolveCategory` in
`commandRegistry.js` decide; an unknown suffix falls back to the menu home instead of silence.
`commandRegistry.js` is the only place that may own the alias list.

The same mistake had been made one layer down, in the two `includes([...])` guards that decide
whether a category is refused in a sales-mode group. Those arrays were written by hand and missed
**13** aliases — `gaming`, `arcade`, `play`, `mabar`, `permainan`, `tools`, `download`, `alat`,
`vip`, `ai`, `gemini`, `dokumen`, `ocr`. Typing `.menu gaming` in a sales group slipped past the
guard, `buildCommandMenu` returned `null` because the category is hidden in that mode, and the
handler fell through to **333 lines of hand-written legacy menu** — a second copy of the whole
command list, with a completely different layout, still advertising `.checkout` as a
"Link pembayaran QRIS/Midtrans" long after Casaku started sending a QR image. That block could only
ever be reached through the bug, yet it was edited every time a command was added.

Both guards now ask the registry (`resolveCategoryId` +
`kategoriDisembunyikanModeJualan`), `KATEGORI_MODE_JUALAN` is exported so the visible-category list
has one home, and the legacy block is gone — the fallback renders the registry's own index. Section
24 of `produkAdminSmokeTest.mjs` asserts that no alias leaks past the guard. Note that `.menu full` renders
~7 400 characters — long, but it is what the user asked for.

## 13. Plugins

One `.js` file per plugin in `./plugins`. Contract:

```js
export default {
  name: 'string',
  commands: ['cmd', 'alias'],          // prefix-stripped, lowercase
  handler: async ({ sock, jid, senderNumber, m, msgText, args, cleanCmd, isAdmin, isOwner }) => boolean
}
```

`plugins/info.js` is the reference implementation. Traps:

- A module missing `default.name` or `default.handler` is **silently dropped** — no warning.
- `executePlugin` treats a handler returning `undefined` as **handled** (`if (handled !== false)`).
  Always `return false` on the non-matching path or you swallow the command.
- Plugins can never claim bare-word commands — `executePlugin` bails unless the message is prefixed.
- Plugins run **first** in the chain, so a `commands` collision shadows a built-in globally. That
  is both the safest override mechanism and the easiest way to break something.
- `loadPlugins()` cache-busts its imports but is only called once, inside `startBot`. No hot reload.

## 14. Environment variables

**Required — `config.js` hard-exits at import time if any is missing:**
`JWT_SECRET`, `ADMIN_USER`, `ADMIN_PASSWORD_HASH`

**Optional:** `PORT` (3000) · `CORS_ORIGIN` (comma-separated; unset ⇒ `false`, all cross-origin
socket connections rejected) · `NODE_ENV` (only checked `=== 'production'` for the secure cookie) ·
`PAIRING_NUMBER` (switches first-time login from QR to an 8-digit pairing code — the only
headless-friendly way to link a session) · `BACKUP_RETENTION_DAYS` (14) · `GEMINI_API_KEY` ·
`APP_URL` · `CASAKU_LICENSE_KEY` · `CASAKU_WEBHOOK_SECRET` · `CASAKU_QRIS_ID` ·
`CASAKU_PACKAGE_IDS` (`id.dana`) · `CASAKU_QR_EXPIRY_MINUTES` (15) · `DASHBOARD_HOST` (`127.0.0.1`)

**Set by code, never by you:** `FFMPEG_PATH`, `YTDL_NO_UPDATE`

⚠️ **`CASAKU_QRIS_ID` is the single switch between an automatic shop and a manual one.** Checkout
takes the dynamic-QRIS branch only when `CASAKU_LICENSE_KEY` **and** `CASAKU_QRIS_ID` are both
non-empty (`customerHandler.js`, the `if (casakuKey && casakuQrisId)` gate). With the licence key
set but the QRIS id missing — the exact state this deployment was in until Sep 2026 — every
checkout silently falls through Midtrans (no server key) to a static QRIS image, the customer
uploads a screenshot, the order parks at `WAITING_CONFIRMATION`, and the owner has to type `.paid`
by hand. Nothing logs a warning about it. If the owner reports "the shop is too manual", check this
variable before reading any code.

⚠️ `.env.example` still omits the **required** `ADMIN_PASSWORD_HASH` (so a clone built from it
cannot boot), plus `GEMINI_API_KEY`, `PAIRING_NUMBER` and `NODE_ENV`. The `CASAKU_*` block and
`DASHBOARD_HOST` are documented there as of Sep 2026. It also lists `OWNER_NUMBER`, which nothing
in the runtime reads — the owner number comes from the `settings` table seeded from
`config.defaults.ownerNumber`.

⚠️ `.gitignore` ignores `.env.*` (with `!.env.example`) so that a stray `.env.bak` cannot reach
this public repo. Do not "simplify" that back to a bare `.env`.

⚠️ Three different config homes in one subsystem: `CASAKU_WEBHOOK_SECRET` is read from
`process.env` **only**; Casaku license/qrisId read env with a `config.casaku` fallback; Midtrans
keys come from the **DB settings table**. Check which one a value uses before "fixing" it.

## 15. Style and language

- **Every user-facing string, error message and code comment is Indonesian.** Match the existing
  tone: friendly-instructional, leading emoji, WhatsApp markdown (`*bold*`, `_italic_`, backticks
  for commands), `━━━` divider lines between sections. Rupiah via `toLocaleString('id-ID')`.
- Console logs use a bracketed uppercase tag: `[WATCHDOG]`, `[SOCKET_STATE]`, `[MSG_SEND]`,
  `[QUEUE]`, `[AUTH]`, `[PLUGIN_LOADER]`, `[WEBHOOK]`, `[FULFILLMENT]`, `[SCHEDULER]`, `[BACKUP]`,
  `[MEDIA_HANDLER]`. New logs without a tag are inconsistent with everything else.
- Order-ID prefixes: `ORD-` sales, `DEP-` deposits, `FJ-` fulfillment jobs, `PT-` payment
  transactions, `WH-` webhook rows.
- Long or slow work is fired as a detached IIFE: `(async () => { … })().catch(() => {})`.
- Heavy or cyclic dependencies use dynamic `await import()` at the point of use, not a top-level
  import. CommonJS-only packages (`pdf-parse`, `tesseract.js`) use `createRequire(import.meta.url)`.
- The exact string `Order ID: *<id>*` in notification templates is a **machine-readable contract** —
  `extractOrderIdFromMessage` regex-scrapes it so admins can reply-to-confirm. Reformatting an
  order notification breaks `.paid` / `.done` / `.cancel`.

### 15a. Two mistakes that pass `node --check` and then silence the bot

Both have already shipped to production here. Both are guarded by
`npm run test:jebakan` (`scripts/runtimeTrapTest.mjs`), which walks every tracked `.js`/`.mjs`/`.cjs`
via acorn. Run it before you commit message text or a new helper.

**1. A backtick inside a template literal that was never escaped.**

```js
const pesan = `Masuk keranjang. Ketik `.checkout` untuk bayar.`;   // ← looks fine
```

JavaScript reads that as a template, then `.checkout` on the resulting string (`undefined`), then a
**tagged template** call on `undefined` → `TypeError`. `node --check` is happy: tagged templates are
valid syntax. On 2026-09-15 there were **13 of these at once**, including the `.beli` confirmation,
the `.keranjang` total, the package-selection confirmation, and three scheduler reminders — so the
main buying path was dead and nobody could tell, because `bot.js`'s top-level catch only
`console.error`s and the customer simply never gets a reply. Write `\`` inside template literals.

**2. A `const` helper called before its own line has executed.**

```js
if (x) return await kirimNotice();        // line 400  → ReferenceError
const kirimNotice = async () => { … };    // line 640
```

`const` has a temporal dead zone; hoisting does not save you. `customerHandler.js` is 2,400 lines
with dozens of `const` helpers declared throughout the body, so "define it near where it is used"
silently creates this. The guard follows call chains too: a helper declared early that *calls* a
helper declared late is the same bug. **Declare shared helpers above every block that reaches them.**

## 16. Import cycles — the constraint behind several oddities

`bot.js ↔ server.js`, `bot.js ↔ handlers`, `bot.js ↔ funHandler`, `server.js ↔ scheduler.js`,
`server.js ↔ chatManager.js` are all real ESM cycles. They work **only** because every cross-module
reference is dereferenced at call time — hoisted function declarations, and `botState` read only
inside handlers.

Therefore: **adding a top-level statement that touches an imported binding at module-evaluation
time** (e.g. `const sock = botState.sock` at module scope, or a top-level `await`, or exporting a
`const`/class and importing it into a handler) **throws a TDZ/undefined error at boot.** That is
why so many call sites use dynamic `import()` instead.

## 17. Known dead code — do not "fix" by wiring it up without asking

- `bot.js:1483` `knownCmdList` — ~130 entries, never referenced. (re-verified Sep 2026; the gate
  right below it uses `isPrefixCmd`, not this list. New commands do **not** need adding here.)
- `src/utils/circuitBreaker.js` — all four functions imported by `mediaHandler.js:18`, **never
  called**. Nothing protects the Casaku HTTP calls either.
- `askGeminiOCR` — exported and imported, never called.
- `entertainmentHandler.removeBackground` / `enhanceImageHD` — never called; `.removebg`/`.nobg`
  and the audio-effect family are in `knownMediaCmds` with no implementing branch. The live HD path
  is `mediaHandler.enhanceImageHd` (lowercase d).
- The `_angka` / `_susunkata` games inside `bot.js` — shadowed by funHandler's versions except in
  sales-mode groups.
- The whole Midtrans branch, whenever Casaku env vars are set.
- `commandRegistry.getRegisteredCommands` — exported, called nowhere.
- `public/index.html:4087` listens for `order:created`, which nothing ever emits.
- Repo root one-off patch scripts, **not runtime**: `bot_backup.js` (5.5k lines), `fix.js`,
  `fix3–6.cjs`, `cleanup.cjs`, `patch_*.js`, `patch_*.cjs`, `update_*.cjs`, `restore_cust.js`.
  Ignore them when searching; `bot_backup.js` in particular produces misleading grep hits.

## 18. Runtime state is gitignored — a fresh clone has none of it

`session/` (live Baileys credentials), `*.db`, `backups/`, `tmp/`, `public/uploads/`,
`public/receipts/`, `ig_cookies.txt`, `.env`.

A fresh clone = unlinked WhatsApp account, empty database, missing QRIS image at
`./public/uploads/qris.png`. The schema self-creates on `db.initDb()`; the data and the linked
session never do. **Never commit any of it** — `session/` holds credentials that grant full control
of the WhatsApp account, and `.env` holds `JWT_SECRET` plus payment keys.
