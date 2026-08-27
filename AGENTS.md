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

**There is no test runner, linter, formatter, watcher, or build.** `package.json` has only
`start`. The validation loop is:

1. `node --check <file>` on every file you modified (`DEVELOPMENT_RULES.md` calls this `node -c`).
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

**The router chain**, identical in both branches:

```
checkPdfMergeSession → executePlugin → handlePdfCommands → handlePremiumCommand
  → handleFunCommand → handleMediaCommands → handleGroupMessage → handleCustomerMessage
```

- A handler **claims** a message by returning truthy; the chain then stops.
- `handleCustomerMessage` is terminal — its return value is never read.
- `groupAdminHandler` returning `false` (unknown command, or sender not admin) is precisely what
  lets a message reach `customerHandler`.
- Earlier handlers **shadow** later ones on a name collision. `funHandler` beats
  `handleMediaCommands`; `groupAdminHandler`'s `.cancel` beats `customerHandler`'s `.batal/.cancel`.
- The DM branch (`bot.js:3023-3054`) and the group branch (`bot.js:3055-3087`) are two
  hand-maintained copies. **Every routing change must be made twice.** This is the mechanical
  reason behind the owner's "test in DM and group" rule.
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

**Interactive buttons** (`sendInteractiveButtons`, `bot.js:221`) always send a plain text message
first, then best-effort a `nativeFlowMessage`. A button's `id` is a literal command string
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
  Midtrans, plus a third hand path when an admin types `.paid`. Message wording and warranty text
  must be changed in all of them.
- `.pay` / `.qris` on an already-WAITING_PAYMENT order calls `createPayment` again, inserting a
  second `payment_transactions` row and orphaning the first.
- `getPendingFulfillmentJobs` also reclaims jobs stuck in `PROCESSING` for longer than its
  `staleProcessingMs` (default 5 min). A job only reaches that state if the process died
  mid-delivery, and re-running is safe because `claimAndDeliverItems` looks for this order's USED
  items first. Do not narrow that query back to `PENDING`/`FAILED` — that silently strands paid
  orders forever.
- The worker DMs the owner (`settings.ownerNumber`) on stuck-job recovery and on `MANUAL_REVIEW`.
  There is still **no dashboard route** reading `fulfillment_jobs` — the DM is the only signal.

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

Since `.paid` is currently the only live delivery path (Casaku is unconfigured and Midtrans has no
server key), any regression here means paid orders are never fulfilled. Treat this call site as
load-bearing.

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

### 12a. Undercover (`src/games/undercover.js`) — the one game with a state machine

`activeUndercoverGames` is a fourth registry, but unlike the three above it **persists** to
`data/undercover_state.json` and is rehydrated by `restoreUndercoverSessions` from `bot.js`.

- **Phase machine** (`session.status`), in order:
  `LOBBY` → `CATEGORY_VOTE` → `CLUE_PHASE` → `DISCUSSION_PHASE` → `VOTING_PHASE` →
  (`MR_WHITE_GUESS`) → back to `CLUE_PHASE` for the next round. Round 1 runs **two** clue passes
  (`session.cluePass` 1 → 2) before discussion opens.
- **Never inline a phase transition.** Every path goes through `announceTurn` → `advanceTurn` →
  `finishCluePass` → `startDiscussionPhase` → `startVotingPhase` → `processUndercoverVotes` →
  `startNextUndercoverRound`. The old file hand-duplicated the "enter voting phase" block in six
  places and they drifted apart; that is what the refactor removed.
- **Timer safety is `session.turnSeq`, not player identity.** `announceTurn` increments it and the
  timeout closure bails unless `cur.turnSeq === seq`. Any new timer in the clue phase must capture
  and check it, otherwise a stale timer fires against the wrong speaker.
- **Deaths outside voting go through `killPlayer` + `resyncAfterDeath`.** `killPlayer` returns
  `{idx, wasCurrent}`; it fixes `turnIndex` when the victim sat before the current speaker, and
  `resyncAfterDeath` re-announces only when the current speaker actually died. Removing a player
  from `alivePlayers` by hand will hang the round.
- **The buy-in is deducted in `assignRolesAndStart`**, not when `.startundercover` is typed — a
  cancel or restart during category voting must not burn points. `refundUndercoverSession` returns
  both the buy-in (`session.buyInCharged`) and every card purchase (`session.cardPurchases`), and
  runs on `.undercover cancel` and lobby expiry.
- **Win parity excludes Mr. White**: impostors win on `aliveUndercover >= aliveCivilians`. Mr. White
  has his own solo-survival branch. Role pools are gated by player count — no Assassin/Mr. White
  below 5 players, no Saboteur below 6 — see `assignRolesAndStart`.
- **Stats** live in `undercover_stats` (schema.js) and are written only via
  `recordUndercoverResult` / `bumpUndercoverCounter` in `gamesDb.js`. The counter column name is
  whitelisted in `UNDERCOVER_COUNTERS` — never interpolate a caller-supplied column.
- **`.tukar` is the Power-Up shop** (see 12b). The Undercover turn-swap skill is `.tukargiliran`.

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
`commandRegistry.js` is the only place that may own the alias list. Note that `.menu full` renders
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
`CASAKU_PACKAGE_IDS` (`id.dana`) · `CASAKU_QR_EXPIRY_MINUTES` (15)

**Set by code, never by you:** `FFMPEG_PATH`, `YTDL_NO_UPDATE`

⚠️ `.env.example` is materially incomplete: it omits the **required** `ADMIN_PASSWORD_HASH` (so a
clone built from it cannot boot), plus `GEMINI_API_KEY`, `PAIRING_NUMBER`, `NODE_ENV`, `APP_URL`
and the whole `CASAKU_*` block. It also lists `OWNER_NUMBER`, which nothing in the runtime reads —
the owner number comes from the `settings` table seeded from `config.defaults.ownerNumber`.

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

- `bot.js:2677` `knownCmdList` — ~130 entries, never referenced. (verified)
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
