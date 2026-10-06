# Server-truth audit (v135) — what is done, what is left

## Done in v135 (steps 1, 4, 5)
1. **Sign-in gate** (`src/main.jsx`, `syncEngine.js: hasLocalCacheFor`). Signed in + no usable local copy of this account ->
   "Loading your account..." until the first server pull lands; 20s or a failed pull -> "Couldn't load your account" with
   Try again / Sign out. Signed in WITH a local copy of the same account -> opens at once, refreshes in the background.
2. **No invented blank records** (`ink-root.jsx`, `profile.js: fetchOwnProfileRow`). A signed-in account with no local
   profile record gets one rebuilt from its `profiles` row and sign-up date. (v133 already stops blank profile/guild/index
   writes before the pull; migration 212 refuses them on the server.)
3. **Wipe on sign-out** (`sync-context.jsx`, `syncEngine.js: wipeLocalDataIfFullySynced`). After a completed sign-out, if
   the outbox and conflict backups are both empty, IndexedDB is emptied and the page reloads. Anything unsent keeps the
   old behaviour (local data stays).

## NOT done — needs its own build (steps 2 and 3)
Findings from reading the code:
- **Published status is a field on the local project record** (`publishStatus`, `resolvePublishStatus` in
  `library/publishing.jsx`), not derived from `published_books`. "My published books" = local projects whose field says
  'inkroot'. Server-truth means listing the account's own `published_books` rows and matching them to projects by id.
- **Guild membership is a local record (`GUILD_KEY`) that mirrors the server.** `guildProfile` is read in 75 places across
  `ink-root.jsx`, `home-screen.jsx`, `guild-hall.jsx`, `project-workspace.jsx`. Server truth lives in
  `founder_guild_members` / `player_guild_members` / `player_guilds`. No lib function fetches "my memberships" yet — one
  RPC (`get_my_guild_membership`) is needed, then the loader rebuilds `guildProfile` from it instead of from kv.
- **Name/pen name** is written locally first and pushed to `profiles` 600ms later (`saveProfile` -> `syncProfile`). Server
  first means awaiting `syncProfile` before updating the screen, and surfacing a failure instead of a notice.
- **Joining/leaving a guild** already awaits the server for leave; join-by-code awaits; founder join and own-guild entry
  write locally first. Those two need to await the server call.
- `writerProfile` is read in 39 places across 7 files; all read state, so reading identity from `profiles` only changes the
  two loaders and `saveProfile`.
Suggested order: guild membership RPC + loader, then published-books list, then server-first saves.
