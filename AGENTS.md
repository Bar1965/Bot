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
button work requires nothing beyond pointing its `id` at an existing command.

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
`customers.role` of OWNER/ADMIN/MODERATOR. Final `isAdmin = isOwner || isGroupAdmin || isStoreAdmin`.

Caveats you must know:

- Store owner/admin are treated as admin in **every** group, even where they are not a WhatsApp
  group admin.
- `groupAdminHandler.js:108-149` **re-runs the whole cascade from scratch** instead of trusting
  `actor`. Fixing an auth rule in only one of the two places gives you a bot where a command works
  in one handler and not the other.
- Digit matching uses `endsWith` in both directions with only a `length > 6` floor, so a short or
  malformed entry in `botSettings.adminNumbers` matches far more senders than intended.
- `isFromMe` unconditionally grants owner rights (`bot.js:2591`).

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
- Nothing reclaims a fulfillment job stuck in `PROCESSING`; `MANUAL_REVIEW` and `FAILED` surface
  only as `console.error` — no dashboard route reads `fulfillment_jobs`.

`scheduler.js` is plain `setInterval`, no cron library, no persisted last-run times:
`processOrderAutomation` every 5 min (expiry + Casaku reconciliation + reminders + abandoned-cart),
`processAutoSholat` every 60 s, free-games alerts every 6 h, backup check hourly (copies when 24 h
elapsed), a 60 s ticker firing the daily sales report at 21:00 WIB, auto-quiz hourly. Every job
early-returns on `!sock || !botState.whatsappConnected`. `startScheduler` is idempotent via
`schedulerStarted` but assigns `schedulerSock` *before* the guard — that is what lets a reconnect
swap in a fresh socket without duplicating intervals. Do not capture `sock` in the closures.

## 11. Dashboard (`server.js`, ~70 `/api` routes)

- Routes are `app.VERB(path, authenticateJWT, authorizeRoles(...), handler)`. Roles are exactly
  `Owner` | `Admin` | `CS`. Some routes deliberately omit `authorizeRoles` and branch on
  `req.user.role` inside the handler instead (the orders action route does this).
- Auth is a 24 h JWT in an httpOnly cookie named `auth_token`. Frontend JS can never read it — any
  new fetch must pass `credentials:'same-origin'`. `localStorage` role is cosmetic only.
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
  Callers must try/catch. It uses `gemini-1.5-flash` over raw node `https` — no SDK, no retry, **no
  timeout**. `premiumHandler` echoes `err.message` straight to the WhatsApp user, so raw upstream
  API errors reach end users.
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
- `redeemPointsForCoupon` in `gamesDb.js` still exists but is dead **on purpose** — it turns points
  into checkout coupons. Do not wire it to a command.

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
