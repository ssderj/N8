import React, { useState, useEffect, useMemo, useRef } from 'react';
import { storage } from '../lib/storage.js';
import { getPulledUserId } from '../lib/syncEngine.js';
import { fetchMyPublishedBooks, fetchPublishedAuthorNames, fetchPublishedBookContent, checkBookReadAccess, fetchAuthorRatingsSummary, fetchFollowerCount } from '../lib/library.js';
import { publishBookRemoteFlow, unpublishBookRemoteFlow, publishPackRemoteFlow, unpublishPackRemoteFlow, PublishFlowError, SOLD_BOOK_UNPUBLISHED_NOTICE, SOLD_PACK_UNPUBLISHED_NOTICE } from '../lib/publish-flow.js';
import { logBookRead } from '../lib/rising-stars.js';
import { syncFounderGuildMembership, leaveFounderGuildMembership, fetchMyGuildMembership } from '../lib/library-guild.js';
import { AlertDialog } from '../shared-ui/ui-primitives.jsx';
import { joinPlayerGuildByCode, leavePlayerGuildRemote, syncPlayerGuild } from '../lib/player-guild.js';
import { syncProfile, fetchVerifiedIds, fetchOwnProfileRow } from '../lib/profile.js';
import { fetchIsModerator, fetchIsPlatformAdmin, recordDeviceSignal } from '../lib/moderation.js';
import { formatNaira } from '../lib/payments.js';
import { ModerationQueue } from '../moderation/moderation-queue.jsx';
import { InkrootEventsAdmin } from '../admin/inkroot-events-admin.jsx';
import { ManualWithdrawalsAdmin } from '../admin/manual-withdrawals-admin.jsx';
import { ManageAdmins } from '../admin/manage-admins.jsx';
import { LinkedProfilesAdmin } from '../admin/linked-profiles-admin.jsx';
import { fetchMyLinkedProfiles } from '../lib/linked-profiles.js';
import { findSimilarName, isReservedName } from '../shared-utils/identity-safety.js';
import { useSync } from './sync-context.jsx';
import { founderGuildById, freshGuildMembership, guildCooldownRemainingMs, mergeServerGuildMembership, normalizeGuildMembership } from '../guild/guild-hall.jsx';
import { PublishedBookReader, buildLegacyBooksForReputation, computeAuthorReputation, meaningfulCompletedCountFor, myPublishedCountFor, reputationTitleFor, reviewReputationCountsFrom } from '../library/author-reputation.jsx';
import { AuthorsHallScreen } from '../library/authors-hall-screen.jsx';
import { GuildPublicProfileScreen } from '../guild/guild-public-profile-screen.jsx';
import { GuildEventDetailScreen } from '../guild/guild-event-detail-screen.jsx';
import { GuildEventJudgePanel } from '../guild/guild-event-judge-panel.jsx';
import { GrandLibraryScreen } from '../library/grand-library-screen.jsx';
import { LibraryAuthorLink, PublishingWizard, overlayServerPublishStatus, resolvePublishStatus } from '../library/publishing.jsx';
import { optimizeProjectImages } from '../shared-ui/image-utils.jsx';
import { GUILD_KEY, INDEX_KEY, LEGACY_KEY, PROFILE_KEY, projectKey, uuid } from '../shared-utils/storage-keys.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';
import { dateKey } from '../shared-utils/truncate.jsx';
import { HomeScreen } from './home-screen.jsx';
import { scrollPageToTop, useNav } from './nav-context.jsx';
import { packSummaryForIndex } from '../worldbuilding/book-cover.jsx';
import { buildPublishedBookContent, buildPublishedPackContent } from '../lib/publish-content.js';
import { aggregateWriterStats } from '../writing/achievements.jsx';
import { SCHEMA_VERSION, backupsKey, emptyProject, patchProjectDefaults, reclaimBackupSpace, restoreProject } from '../writing/project-schema-and-backups.jsx';
import { ProjectWorkspace } from '../writing/project-workspace.jsx';


// The signup trigger seeds profiles.display_name with a placeholder ("Writer 1a2b3c4d"). That is not a real
// name, so anything rebuilt or reverted from the server shows it as blank instead.
const serverProfileName = (n) => (n && !/^Writer [0-9a-f]{8}$/i.test(n.trim()) ? n : '');

// ---------- App root: routes between home and a project ----------
export function InkRoot() {
    const sync = useSync();
    const sessionUserId = sync && sync.session ? sync.session.user.id : null;
    const [projects, setProjects] = useState(null);
    // True when reading the local project index threw (storage error, unreadable JSON). While set,
    // `projects` stays null and nothing may write INDEX_KEY: writing over an index we failed to read
    // would replace the real list with a near-empty one and sync that to every device.
    const [indexLoadError, setIndexLoadError] = useState(false);
    const [currentId, setCurrentId] = useState(null);
    const [openTab, setOpenTab] = useState('hub'); // which tab ProjectWorkspace should land on next open
    const [writerProfile, setWriterProfile] = useState(null); // the writer's identity — separate from any project
    // Surfaced when a quick publish/unpublish action from Author Studio (setPublishStatus /
    // setPackPublishStatus below — the two that fire directly from a book/pack card, with no
    // PublishingWizard around them to show an inline error of its own) fails against Supabase.
    // Wizard-driven publishes (publishBookWithDetails / publishPackWithDetails) instead throw
    // back to the wizard itself, which has its own inline idle/publishing/error state — see
    // PublishingWizard in library/publishing.jsx — so this dialog is only for the two quick
    // actions that have nowhere else to show a failure. See lib/publish-flow.js for why a
    // failure here means nothing was left half-published.
    const [publishNotice, setPublishNotice] = useState(null); // { title, message }
    // Anti-impersonation: every published author's { id, name }, fetched once and reused for the
    // lookalike-name warning in saveProfile below (see shared-utils/identity-safety.js). A stale
    // list for the rest of the session is an acceptable tradeoff — this is a soft warning, not a
    // security boundary, and re-fetching on every keystroke of a name field would be wasteful.
    const [publishedAuthorNames, setPublishedAuthorNames] = useState([]);
    // Inline feedback for the name/pen name fields on the Writer Identity Card — nameError blocks
    // (a reserved name was rejected), nameWarning doesn't (a lookalike name was flagged but still
    // saved). Both cleared on save unless the new value re-triggers them.
    const [profileNameError, setProfileNameError] = useState(null);
    const [profileNameWarning, setProfileNameWarning] = useState(null);
    // FIX 4 -- name / pen name / avatar / motto save to the server FIRST (signed-in accounts). Typing stays
    // instant (the fields edit an in-memory draft), but the draft is written to the local record, and so
    // reaches the sync store and the writer's other devices, only after `profiles` accepted it. This pair
    // tells the Writer Identity Card what to show:
    //   profileSaveState  null | 'saving' | 'saved' | 'held' | 'failed' | 'reverted'
    //   profileSyncNotice the sentence that goes with 'held' / 'failed' / 'reverted'
    // 'held'     = the server could not be reached; the draft waits in memory and is retried when the
    //              browser comes back online, the tab becomes visible again, or Retry is pressed.
    // 'failed'   = the server answered and refused (name taken / reserved / other). The draft stays on
    //              screen only while the writer is still in the field; once they leave the field or the
    //              screen it is replaced by what the server actually has ('reverted').
    // Signed-out editing is untouched: local-only, no status line.
    const [profileSyncNotice, setProfileSyncNotice] = useState(null);
    const [profileSaveState, setProfileSaveState] = useState(null);
    // Anti-impersonation piece 2 — whether the signed-in writer's own account carries the
    // verified badge (schema.sql's `profiles.verified`, see lib/profile.js's fetchVerifiedIds).
    // Re-checked whenever the session user changes; there's no in-app way to flip this (see the
    // migration's comment), so it isn't re-checked on every profile edit — only sign-in.
    const [selfVerified, setSelfVerified] = useState(false);
    // Trust-and-safety moderation — whether the signed-in writer's own account is a moderator
    // (schema.sql's `profiles.is_moderator`, see lib/moderation.js's fetchIsModerator). Gates
    // whether the Moderation Queue entry point even shows up (see WriterIdentityCard below) —
    // real enforcement is server-side RLS regardless of what this says, same caveat as
    // selfVerified above.
    const [isModerator, setIsModerator] = useState(false);
    const [showModerationQueue, setShowModerationQueue] = useState(false);
    // Same shape as isModerator/showModerationQueue immediately above, for the separate
    // is_platform_admin trust flag (see 43_migration_inkroot_events_admin.sql) — gates whether
    // the Inkroot Events admin screen's entry point even shows up. Real enforcement is still
    // server-side (is_inkroot_admin()) regardless of what this says.
    const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
    const [showInkrootEventsAdmin, setShowInkrootEventsAdmin] = useState(false);
    // Same shape again, but ungated — see author-identity.jsx's own comment on why this button
    // has no role-flag check: any verified author can be seated on a panel.
    const [showGuildEventJudging, setShowGuildEventJudging] = useState(false);
    const [showManualWithdrawalsAdmin, setShowManualWithdrawalsAdmin] = useState(false);
    const [showManageAdmins, setShowManageAdmins] = useState(false);
    // Same shape again, for the Linked Profiles screen (see linked-profiles-admin-only-spec.md).
    // Creating a profile stays admin-only, but the screen's entry point also shows for any account
    // that HAS links: a linked profile is a separate account that doesn't inherit is_platform_admin,
    // so gating the entry point on that flag alone stranded you on the secondary with no way back
    // or across. hasLinkedProfiles / onLinkedProfile come from list_my_linked_profiles() (migration
    // 190), are only ever used to decide what the signed-in account's OWN screens draw, and fail
    // closed (false) — so an ordinary account, which has no links, still sees nothing new.
    const [showLinkedProfilesAdmin, setShowLinkedProfilesAdmin] = useState(false);
    const [hasLinkedProfiles, setHasLinkedProfiles] = useState(false);
    const [onLinkedProfile, setOnLinkedProfile] = useState(false);
    const [guildProfile, setGuildProfile] = useState(null); // the writer's Guild — also separate from any project
    // Surfaced when leaveCurrentGuild's remote leave call (leavePlayerGuildRemote /
    // leaveFounderGuildMembership) fails — same {title, message}-via-AlertDialog contract as
    // publishNotice above, kept as its own state since it's a different action with its own
    // failure copy. On failure guildProfile is left untouched (see leaveCurrentGuild) so the
    // writer isn't shown a false "left" state while still actually seated in the guild.
    const [guildLeaveNotice, setGuildLeaveNotice] = useState(null); // { title, message }
    // FIX 5 -- same {title, message}-via-AlertDialog contract, for joinFounderGuild / enterOwnGuild failing
    // against the server. Nothing local has changed when this shows (see those two functions).
    const [guildJoinNotice, setGuildJoinNotice] = useState(null); // { title, message }
    // Surfaced when syncPlayerGuild (founding or editing your own Player Guild) fails remotely.
    // Previously this was a console.warn no one ever saw: local state still flipped to
    // guildType: 'player' with a locally-generated id, so the "Host a Guild Event" button and
    // every other owner-only control rendered normally, but player_guilds never actually got a
    // matching row (or the row's owner_id never matched this id) server-side. Every event/
    // treasury RPC re-checks ownership server-side via is_guild_officer() — a guild that never
    // synced fails that check exactly like "you're not the owner" does, so this was showing up
    // as a confusing "Only the guild owner can host a guild event" error to the actual owner.
    // Same {title, message}-via-AlertDialog contract as guildLeaveNotice above; retry re-runs
    // the same sync rather than generating a new local id, so it converges on the same guild
    // row instead of orphaning yet another id.
    const [guildSyncNotice, setGuildSyncNotice] = useState(null); // { title, message }
    // Reputation earned inside a guild (published books, completed guild quests, Fireside posts) —
    // computed once in the Guild Hall and shared here so it also shows up on the Writer Profile.
    const [writerReputation, setWriterReputation] = useState(null);
    // Which author's Author's Hall (if any) is currently showing. null = not showing one. Any
    // string (including '') identifies the pen name being viewed — resolved to either the private
    // (isSelf) or public view further down, depending on whether it matches this device's own
    // writer identity.
    const [viewingAuthorName, setViewingAuthorName] = useState(null);
    // The real account id behind whichever Hall is open, when one is actually known —
    // anti-impersonation piece 5 (see lib/profile.js's fetchPublicProfile). Only ever set from a
    // surface that carries a genuine author_id (Fireside, Guild Bookshelf — see
    // guild-book-feedback-modal.jsx's onOpenAuthor calls); every other caller of openAuthorHall
    // (the local-only Grand Library, Author Studio) has no real account behind its author-name
    // strings at all, so this stays null there and AuthorsHallScreen falls back to its existing
    // local-name-matching behavior for that Hall.
    const [viewingAuthorId, setViewingAuthorId] = useState(null);
    // Whether the Hall currently open is this device's own, decided once at navigation time in
    // openAuthorHall — NOT recomputed from a live name comparison on every render. It used to be
    // re-derived by comparing viewingAuthorName against the writer's current name each render,
    // which meant editing your own name (which updates writerProfile live, keystroke by keystroke)
    // made the comparison stop matching mid-edit and flip you onto the read-only "someone else's
    // Hall" view — a forced remount that looked like being kicked to another profile while typing.
    const [viewingIsSelf, setViewingIsSelf] = useState(false);
    // Lets "Open Creator Dashboard" (on the Author's Hall) land Author Studio's segmented switch
    // straight on 'studio' instead of the default 'reader' mode — see GrandLibraryScreen's
    // initialMode prop, which only reads this once per mount, same pattern as ProjectWorkspace's
    // initialTab below.
    const [libraryInitialMode, setLibraryInitialMode] = useState('reader');
    const [lifetimeStats, setLifetimeStats] = useState({ totalWords: 0, chapters: 0, completedCount: 0 }); // feeds Guild Quests' real progress bars, and the completed-project shelf badge
    // The same quality-gated "completed projects" count Author's Hall uses for Reputation (see
    // meaningfulCompletedCountFor in author-reputation.jsx) — deliberately separate from
    // lifetimeStats.completedCount above, which stays the raw "marked complete" tally other UI
    // (the Home stat tile) still wants. writerRank below reads this one, not the raw one, so the
    // Rank shown on Home matches the Rank shown on this writer's own Author's Hall.
    const [ownReputationCompletedCount, setOwnReputationCompletedCount] = useState(0);
    // Which of Home's three tabs ('home' | 'guild' | 'library') is showing. Owned here rather than
    // inside HomeScreen because HomeScreen itself unmounts and remounts every time the writer opens
    // a project or their Writer Profile and comes back — InkRoot never unmounts, so this is the one
    // place the value (and the undo closures the nav stack holds onto for it) can stay valid for as
    // long as the nav stack itself remembers being on the Guild Hall or Grand Library.
    const [homeActiveTab, setHomeActiveTab] = useState('home');
    // The reader-facing counterpart to currentId/ProjectWorkspace below: set when a reader taps a
    // book in the Grand Library or a Guild's bookshelf. Kept entirely separate from currentId so
    // there is no code path from a published book into the author's full project workspace —
    // readingBookProject only ever holds what PublishedBookReader is given (chapters, title,
    // author), fetched fresh from storage rather than reusing any in-memory author session state.
    const [readingBookId, setReadingBookId] = useState(null);
    const [readingBookProject, setReadingBookProject] = useState(null);
    // True once we've established the book genuinely can't be opened — neither this device's
    // own local copy (the author's device) nor the public published_book_content mirror (every
    // other device) has anything for this id. Lets the render branch below show a real
    // "book unavailable" state instead of hanging on "Opening book…" forever, which is what
    // happened before published_book_content existed (see 70_migration_published_book_content.sql).
    const [readingBookError, setReadingBookError] = useState(false);
    // True once we've established the book is real and reachable but priced, and this reader
    // hasn't paid for it (see lib/library.js's checkBookReadAccess) — a distinct state from
    // readingBookError above so the reader sees an honest "buy this to read it" screen instead
    // of a generic "couldn't be opened" one. Carries the price along so that screen can show it.
    const [readingBookLocked, setReadingBookLocked] = useState(null);
    // Whether THIS book's author opted it into PDF/EPUB download (published_books.downloadable —
    // see the publishing wizard's Step 3 toggle). Set alongside readingBookProject on both the
    // local (author's own device) and remote (published_book_content mirror) load paths below, so
    // PublishedBookReader can show a download control only when the author actually turned it on.
    const [readingBookDownloadable, setReadingBookDownloadable] = useState(false);
    // Tracks which book id the most recent openReaderBook call is actually for, so a slower
    // lookup that was already in flight when the reader backed out and opened a different book
    // can detect it's stale and quietly no-op instead of overwriting the newer book's state.
    const readingBookIdRef = useRef(null);
    // Reader-facing navigation onto another guild's public profile / a single Guild Event's
    // detail page — e.g. from Living Universe's Guild Events, Guilds on the Rise, or Best/Most
    // Read cards (see lib/guild-rankings.js's fetchPublicGuildProfile and lib/guild-events.js's
    // fetchPublicGuildEvents). Kept entirely separate from guildProfile (this device's OWN guild
    // membership state) — viewing someone else's guild never touches or reinterprets that.
    const [viewingGuildId, setViewingGuildId] = useState(null);
    const [viewingEventId, setViewingEventId] = useState(null);
    const nav = useNav();
    const openProject = (id, tab) => {
        const proj = (projects || []).find((p) => p.id === id);
        scrollPageToTop(); // a full screen opens at its top
        nav.push({ label: (proj && proj.title) || 'Project', undo: () => setCurrentId(null) });
        setOpenTab(tab || 'hub'); setCurrentId(id);
    };
    const openReaderBook = (id) => {
        const meta = (projects || []).find((p) => p.id === id);
        scrollPageToTop(); // a full screen opens at its top
        nav.push({ label: (meta && meta.title) || 'Book', undo: () => { setReadingBookId(null); setReadingBookProject(null); setReadingBookError(false); setReadingBookLocked(null); setReadingBookDownloadable(false); } });
        setReadingBookProject(null); // clear any previous book while the new one loads
        setReadingBookError(false);
        setReadingBookLocked(null);
        setReadingBookDownloadable(false);
        setReadingBookId(id);
        // Fire-and-forget toward Rising Star's real "recent readers" signal (see
        // supabase/history/38_migration_rising_star_scoring.sql) — never blocks or affects this
        // read either way. log_book_read's own insert policy already excludes a book's own
        // author from counting as one of its "recent readers" regardless.
        logBookRead(id);
        // A request token so a slower, superseded lookup (the reader backed out and opened a
        // different book before this one resolved) can't clobber state for the book actually
        // on screen now — checked before every setReadingBook* call below.
        const requestId = id;
        const isStale = () => requestId !== readingBookIdRef.current;
        readingBookIdRef.current = id;
        storage.get(projectKey(id)).then((res) => {
            if (isStale())
                return;
            if (res) {
                try {
                    const localProj = JSON.parse(res.value);
                    setReadingBookProject(patchProjectDefaults(localProj));
                    setReadingBookDownloadable(!!localProj.downloadable);
                    return;
                }
                catch (e) { /* fall through to the remote mirror below */ }
            }
            // Not on this device — true for every reader who isn't the book's own author.
            // Fall back to the public mirror written at publish time (see
            // publishBookContentRemote / 70_migration_published_book_content.sql). A hard
            // timeout guards against a network stall leaving this on "Opening book…" forever,
            // same failure mode the mirror itself was built to fix.
            const withTimeout = (promise, ms) => Promise.race([
                promise,
                new Promise((resolve) => setTimeout(() => resolve(null), ms)),
            ]);
            // Gate on price/purchase before ever fetching the actual content — this is the
            // book's own author's *other* device, or another reader entirely, so unlike the
            // local branch above there's no guarantee this device has paid for it. Free books
            // (price 0, the writer's own choice in the publishing wizard) and the author's own
            // account always pass straight through; see checkBookReadAccess for the full rule.
            withTimeout(checkBookReadAccess(id), 15000).then((access) => {
                if (isStale())
                    return;
                if (!access) {
                    setReadingBookError(true); // the access check itself timed out/failed
                    return;
                }
                if (!access.allowed) {
                    setReadingBookLocked({ price: access.price || 0 });
                    return;
                }
                setReadingBookDownloadable(!!access.downloadable);
                withTimeout(fetchPublishedBookContent(id), 15000).then((content) => {
                    if (isStale())
                        return;
                    if (content)
                        setReadingBookProject(patchProjectDefaults(content));
                    else
                        setReadingBookError(true);
                });
            });
        });
    };
    // The single entry point every clickable author name/avatar/rank in the app routes through —
    // published books, the Grand Library, Author Studio listings, guilds, guild feedback, and book
    // pages alike (see LibraryAuthorLink and its call sites). A blank/omitted name means "open my
    // own Hall"; any other name opens that pen name's Hall, which the render logic below resolves
    // to either the private (isSelf) or public view depending on whether it matches this device's
    // own writer identity.
    const openAuthorHall = (name, authorId = null) => {
        const trimmed = (name || '').trim();
        const selfName = (writerProfile && (writerProfile.penName || writerProfile.name) || '').trim();
        // A real author_id that happens to be this device's own signed-in account also counts as
        // self, same as a name match — opens the private (editable) view instead of a read-only
        // public one of your own Hall.
        const isSelf = !trimmed || (selfName && trimmed.toLowerCase() === selfName.toLowerCase()) || (authorId && authorId === sessionUserId);
        scrollPageToTop(); // a full screen opens at its top
        nav.push({ label: isSelf ? "Your Author's Hall" : trimmed, undo: () => { setViewingAuthorName(null); setViewingAuthorId(null); setViewingIsSelf(false); } });
        setViewingAuthorName(isSelf ? selfName : trimmed);
        setViewingAuthorId(isSelf ? null : authorId);
        setViewingIsSelf(isSelf);
    };
    const openProfile = () => openAuthorHall(null);
    // Opens a real Player Guild's public profile by id — never a Founder Guild (those have no
    // real backing row to look up, and no reader-facing page exists for one yet), so callers
    // should only pass a guild_id that actually came from real backend data (compute_guilds_on_rise,
    // list_public_guild_events, etc.), never a Founder Guild's local string id like 'fantasy'.
    const openGuildProfile = (guildId) => {
        if (!guildId) return;
        setViewingEventId(null); // mutually exclusive with the event detail screen below
        scrollPageToTop(); // a full screen opens at its top
        nav.push({ label: 'Guild profile', undo: () => setViewingGuildId(null) });
        setViewingGuildId(guildId);
    };
    // Opens a single Guild Event's detail page by id. GuildEventDetailScreen resolves the event's
    // own guildId itself before ever letting "View guild" navigate anywhere.
    const openGuildEvent = (eventId) => {
        if (!eventId) return;
        setViewingGuildId(null); // mutually exclusive with the guild profile screen above
        scrollPageToTop(); // a full screen opens at its top
        nav.push({ label: 'Event details', undo: () => setViewingEventId(null) });
        setViewingEventId(eventId);
    };
    // From the Author's Hall's "Open Creator Dashboard" button: leaves the Hall, lands on Home with
    // the Grand Library tab active and Author Studio's segmented switch pre-set to 'studio' — the
    // same place Author Studio has always lived, just reached in one tap from the Hall now too.
    const openCreatorDashboard = () => {
        setLibraryInitialMode('studio');
        setHomeActiveTab('library');
        setViewingAuthorName(null);
        // Same undo every other route onto the Grand Library tab carries (see changeHomeTab in
        // home-screen.jsx) — without it, Back/breadcrumb navigation away from this screen had
        // nothing to call, so the stack would correctly shrink to Home while homeActiveTab stayed
        // stuck on 'library': the breadcrumb/Back button would vanish (nothing left to pop) but
        // the screen kept showing the Grand Library, with no way back except the separate bottom
        // tab bar's own direct setActiveTab('home') call.
        nav.resetTo({ label: 'Grand Library', key: 'library:' + Date.now(), undo: () => setHomeActiveTab('home') });
    };
    const openModerationQueue = () => {
        scrollPageToTop(); // a full screen opens at its top
        nav.push({ label: 'Moderation queue', undo: () => setShowModerationQueue(false) });
        setShowModerationQueue(true);
    };
    const openGuildEventJudging = () => {
        scrollPageToTop(); // a full screen opens at its top
        nav.push({ label: 'Judging queue', undo: () => setShowGuildEventJudging(false) });
        setShowGuildEventJudging(true);
    };
    const openInkrootEventsAdmin = () => {
        scrollPageToTop(); // a full screen opens at its top
        nav.push({ label: 'Inkroot Events admin', undo: () => setShowInkrootEventsAdmin(false) });
        setShowInkrootEventsAdmin(true);
    };
    const openManualWithdrawalsAdmin = () => {
        scrollPageToTop(); // a full screen opens at its top
        nav.push({ label: 'Manual Withdrawals admin', undo: () => setShowManualWithdrawalsAdmin(false) });
        setShowManualWithdrawalsAdmin(true);
    };
    const openManageAdmins = () => {
        scrollPageToTop(); // a full screen opens at its top
        nav.push({ label: 'Manage Admins', undo: () => setShowManageAdmins(false) });
        setShowManageAdmins(true);
    };
    const openLinkedProfilesAdmin = () => {
        scrollPageToTop(); // a full screen opens at its top
        nav.push({ label: 'Linked Profiles', undo: () => setShowLinkedProfilesAdmin(false) });
        setShowLinkedProfilesAdmin(true);
    };
    useEffect(() => {
        if (!projects || !projects.length) {
            setLifetimeStats({ totalWords: 0, chapters: 0, completedCount: 0 });
            setOwnReputationCompletedCount(0);
            return;
        }
        let cancelled = false;
        (async () => {
            const full = [];
            for (const meta of projects) {
                try {
                    const res = await storage.get(projectKey(meta.id));
                    if (res)
                        full.push(patchProjectDefaults(JSON.parse(res.value)));
                }
                catch (e) { /* skip a project that fails to parse rather than blocking the tally */ }
            }
            if (!cancelled) {
                // aggregateWriterStats used to also return .rank/.level (Writer Level) here —
                // removed along with it; see writerRank below, computed from Reputation instead.
                setLifetimeStats(aggregateWriterStats(full));
                // Same per-project quality gate Author's Hall's own legacyBooks/meaningfulCompletedCount
                // apply (see buildLegacyBooksForReputation/meaningfulCompletedCountFor) — built from
                // the same `full` project bodies already loaded above rather than a second pass.
                setOwnReputationCompletedCount(meaningfulCompletedCountFor(buildLegacyBooksForReputation(full)));
            }
        })();
        return () => { cancelled = true; };
    }, [projects]);
    // Writer Rank — used to be tallied alongside Writer Level in the effect above (lifetime level
    // -> writerRankForLevel). Now it's just Reputation's own tier (reputationTitleFor), built from
    // the exact same shared inputs authors-hall-screen.jsx uses for isSelf (see
    // myPublishedCountFor/meaningfulCompletedCountFor/reviewReputationCountsFrom in
    // author-reputation.jsx) — published and completed counts held to the real quality gates, the
    // real server-side follower count (see fetchFollowerCount in lib/library.js — same source
    // Author's Hall's own followerCount now reads, not a local device-only signal), the real
    // review/positive-rating counts across this writer's own published books, and this device's
    // own tracked guild contribution (writerReputation state, fed by HomeScreen's
    // onReputationChange).
    const [ownFollowerCount, setOwnFollowerCount] = useState(0);
    useEffect(() => {
        if (!sessionUserId) { setOwnFollowerCount(0); return; }
        let cancelled = false;
        fetchFollowerCount(sessionUserId).then((n) => { if (!cancelled) setOwnFollowerCount(n); }).catch((e) => console.warn('Inkroot: fetchFollowerCount failed', e));
        return () => { cancelled = true; };
    }, [sessionUserId]);
    // Real reviews/ratings received across this writer's own published books — same
    // fetchAuthorRatingsSummary + reviewReputationCountsFrom pairing authors-hall-screen.jsx uses
    // for the isSelf case, built from this device's own published 'inkroot' listings.
    // Server truth for published books: the account's own published_books rows laid over the local projects.
    // `publishedProjects` is for screens that count or list published books; `projects` stays local-only because it
    // is also what gets saved to the index. null rows (signed out, or the fetch failed) = local status as before.
    const [myPublishedRows, setMyPublishedRows] = useState(null);
    const loadMyPublishedRows = () => {
        if (!sessionUserId) { setMyPublishedRows(null); return Promise.resolve(); }
        return fetchMyPublishedBooks()
            .then((rows) => setMyPublishedRows(rows))
            .catch((e) => { console.warn('Inkroot: fetchMyPublishedBooks failed', e); setMyPublishedRows(null); });
    };
    useEffect(() => { loadMyPublishedRows(); }, [sessionUserId]);
    const publishedProjects = React.useMemo(
        () => overlayServerPublishStatus(projects, myPublishedRows, (writerProfile && (writerProfile.penName || writerProfile.name)) || ''),
        [projects, myPublishedRows, writerProfile]);
    const ownPublishedBookIds = publishedProjects.filter((p) => resolvePublishStatus(p) === 'inkroot').map((p) => p.id);
    const [ownReviewCounts, setOwnReviewCounts] = useState({ reviewCount: 0, ratingCount: 0 });
    useEffect(() => {
        if (!ownPublishedBookIds.length) { setOwnReviewCounts({ reviewCount: 0, ratingCount: 0 }); return; }
        let cancelled = false;
        fetchAuthorRatingsSummary(ownPublishedBookIds)
            .then((summary) => { if (!cancelled) setOwnReviewCounts(reviewReputationCountsFrom(summary)); })
            .catch((e) => console.warn('Inkroot: fetchAuthorRatingsSummary failed', e));
        return () => { cancelled = true; };
    }, [ownPublishedBookIds.join(',')]);
    // A useMemo rather than its own state — it only ever needs to be recomputed when its actual
    // inputs change, never independently.
    const writerRank = useMemo(() => reputationTitleFor(computeAuthorReputation({
        followCount: ownFollowerCount,
        publishedCount: myPublishedCountFor(publishedProjects),
        completedCount: ownReputationCompletedCount,
        guildContribution: writerReputation || 0,
        reviewCount: ownReviewCounts.reviewCount,
        ratingCount: ownReviewCounts.ratingCount,
    })), [projects, ownReputationCompletedCount, ownFollowerCount, ownReviewCounts, writerReputation]);
    // FIX (sign-out/sign-in data loss) -- "has this account's data been pulled onto this device yet?".
    // The profile, guild and project-index loaders below used to run ONCE on mount. On a device that has
    // nothing local yet (first sign-in here, a browser that cleared its storage, the Home-Screen app vs
    // Safari, signing back in after a wipe) they found nothing, created a blank default, saved it and kept
    // it in memory -- while the real record was still on its way from Supabase. The pull then correctly put
    // the real record into IndexedDB, but nothing re-read it into state, so the screen stayed blank, and the
    // writer's next edit (a name, joining a guild) was built on that blank state and pushed over the real
    // server row at the current version -- accepted as a normal update. That is the "I log back in and it is
    // a new account" report. Now: while signed in and not yet pulled, an EMPTY local read creates/saves
    // nothing (it waits); every loader re-runs when the pull lands (pullTick), so the real data is shown;
    // and a blank default is only created once the pull has confirmed there is genuinely nothing remote.
    // If the pull never lands (offline, server down) a 10s fallback shows an in-memory-only blank so the app
    // stays usable; it is NOT written to storage, and the real data replaces it as soon as a pull succeeds.
    const [pullTick, setPullTick] = useState(0);
    const [pullWaitGaveUp, setPullWaitGaveUp] = useState(false);
    useEffect(() => {
        const handler = (e) => {
            if (!e.detail || e.detail.userId === sessionUserId) setPullTick((n) => n + 1);
        };
        window.addEventListener('inkroot:account-pulled', handler);
        window.addEventListener('inkroot:sync-pulled', handler);
        return () => {
            window.removeEventListener('inkroot:account-pulled', handler);
            window.removeEventListener('inkroot:sync-pulled', handler);
        };
    }, [sessionUserId]);
    useEffect(() => {
        setPullWaitGaveUp(false);
        if (!sessionUserId) return undefined;
        const t = setTimeout(() => setPullWaitGaveUp(true), 10000);
        return () => clearTimeout(t);
    }, [sessionUserId]);
    // True when an empty local read is untrustworthy: signed in, and this account's data has not landed yet.
    const waitingForPull = () => !!sessionUserId && getPulledUserId() !== sessionUserId;
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const res = await storage.get(PROFILE_KEY);
            if (cancelled) return;
            if (res) {
                // An unsent / held / refused draft is newer than the local record; a pull landing must not erase it.
                if (profileUnsettled()) return;
                const loaded = JSON.parse(res.value);
                writerProfileRef.current = loaded;
                setWriterProfile(loaded);
                // FIX 7 (step A) -- this local record is only an offline cache now (it is no longer synced through
                // kv_store), so a signed-in account refreshes it from its own `profiles` row, which is what makes a
                // name changed on another device show up here. Offline / read failure: keep showing the cache.
                if (sessionUserId) {
                    const row = await fetchOwnProfileRow().catch(() => null);
                    if (cancelled || !row || profileUnsettled()) return;
                    const srvName = serverProfileName(row.display_name);
                    if (srvName || row.pen_name || row.motto || row.avatar_url) {
                        // A photo that exists only on this device (a data: URL is never pushed to `profiles`) is kept.
                        const deviceOnlyAvatar = typeof loaded.avatar === 'string' && loaded.avatar.startsWith('data:') ? loaded.avatar : null;
                        const merged = { ...loaded, name: srvName, penName: row.pen_name || '', motto: row.motto || '', avatar: row.avatar_url || deviceOnlyAvatar || null };
                        if (JSON.stringify(merged) !== JSON.stringify(loaded)) {
                            await storage.set(PROFILE_KEY, JSON.stringify(merged));
                            if (cancelled || profileUnsettled()) return;
                            writerProfileRef.current = merged;
                            setWriterProfile(merged);
                        }
                    } else if (loaded.name || loaded.penName || loaded.motto) {
                        // The account has no details of its own yet but this device does (set up while signed
                        // out): give them to the account once, so they are no longer only on this device.
                        syncProfile({ name: loaded.name, penName: loaded.penName, avatar: loaded.avatar, motto: loaded.motto })
                            .catch((e) => console.warn('Inkroot: could not give this device\'s profile to the account', e));
                    }
                }
                return;
            }
            let fresh = { name: '', penName: '', motto: '', avatar: null, joinDate: new Date().toISOString() };
            if (waitingForPull()) {
                // Nothing saved, nothing shown, until the pull lands -- unless it never does (see above).
                if (pullWaitGaveUp) { writerProfileRef.current = fresh; setWriterProfile(fresh); }
                return;
            }
            // Server truth: a signed-in account with no local profile record gets one rebuilt from the account's
            // own `profiles` row and sign-up date, not an invented blank "joined today" record. The signup
            // trigger's placeholder name ("Writer 1a2b3c4d") is not a real name, so it is left blank.
            if (sessionUserId) {
                const row = await fetchOwnProfileRow().catch(() => null);
                if (cancelled) return;
                if (row) {
                    const realName = serverProfileName;
                    fresh = {
                        name: realName(row.display_name), penName: row.pen_name || '', motto: row.motto || '',
                        avatar: row.avatar_url || null,
                        joinDate: (sync && sync.session && sync.session.user.created_at) || fresh.joinDate,
                    };
                }
            }
            await storage.set(PROFILE_KEY, JSON.stringify(fresh));
            if (cancelled) return;
            writerProfileRef.current = fresh;
            setWriterProfile(fresh);
        })();
        return () => { cancelled = true; };
    }, [sessionUserId, pullTick, pullWaitGaveUp]);
    useEffect(() => {
        fetchPublishedAuthorNames().then(setPublishedAuthorNames);
    }, []);
    useEffect(() => {
        if (!sessionUserId) { setSelfVerified(false); return; }
        fetchVerifiedIds([sessionUserId]).then((ids) => setSelfVerified(ids.has(sessionUserId))).catch(() => setSelfVerified(false));
    }, [sessionUserId]);
    useEffect(() => {
        if (!sessionUserId) { setIsModerator(false); return; }
        fetchIsModerator(sessionUserId).then(setIsModerator).catch(() => setIsModerator(false));
    }, [sessionUserId]);
    useEffect(() => {
        if (!sessionUserId) { setIsPlatformAdmin(false); return; }
        fetchIsPlatformAdmin(sessionUserId).then(setIsPlatformAdmin).catch(() => setIsPlatformAdmin(false));
    }, [sessionUserId]);
    useEffect(() => {
        // Does this account have any linked profiles, and is it itself one? Best-effort and silent
        // on failure (also the case before migration 190 is applied) — a miss just leaves the entry
        // point hidden, exactly as before this existed.
        if (!sessionUserId) { setHasLinkedProfiles(false); setOnLinkedProfile(false); return; }
        let cancelled = false;
        fetchMyLinkedProfiles()
            .then((r) => {
                if (cancelled) return;
                setOnLinkedProfile(!!r.asSecondary);
                setHasLinkedProfiles(!!r.asSecondary || r.asMain.length > 0);
            })
            .catch(() => { if (!cancelled) { setHasLinkedProfiles(false); setOnLinkedProfile(false); } });
        return () => { cancelled = true; };
    }, [sessionUserId]);
    useEffect(() => {
        // Ban-evasion signal, piece 6 — see shared-utils/device-signal.js for what this is and
        // isn't. Best-effort, no-op when signed out; recordDeviceSignal itself is silent on
        // failure.
        if (sessionUserId) recordDeviceSignal(sessionUserId);
    }, [sessionUserId]);
    // Anti-impersonation checks — see shared-utils/identity-safety.js. Runs on every keystroke
    // (name/penName are controlled inputs that call onSaveProfile directly on onChange — see
    // WriterIdentityCard), but both checks are cheap: isReservedName is a plain Set-style lookup,
    // and findSimilarName runs against an already-fetched, small in-memory list rather than
    // hitting the network — so per-keystroke validation here doesn't add any real cost.
    // L6: the storage write and the network sync used to run INSIDE the setWriterProfile updater.
    // React may call an updater more than once (StrictMode, concurrent rendering), so a keystroke
    // could fire duplicate writes/requests, and nothing ordered the requests — a slow older response
    // could land after a newer one. Now: the latest profile lives in a ref (so the next keystroke
    // builds on it synchronously, not on a possibly-stale render), the local write happens once per
    // call, and the remote sync is debounced (~600 ms) and SERIALIZED — only one profiles update is
    // ever in flight, and when it finishes the newest pending snapshot is sent, so the last thing
    // the server sees is always the last thing the writer typed. A superseded attempt never touches
    // the notice: only the newest one decides whether "couldn't save" shows.
    const writerProfileRef = useRef(null);
    useEffect(() => { writerProfileRef.current = writerProfile; }, [writerProfile]);
    // FIX 4 plumbing. Everything below reads refs only, so the closures registered once in the effects
    // further down stay correct for the life of the component.
    const sessionIdRef = useRef(sessionUserId);
    sessionIdRef.current = sessionUserId;
    const profileSyncTimerRef = useRef(null);
    const profileSyncInFlightRef = useRef(false);
    // The newest snapshot not yet accepted by the server. While `profileHeldRef` is true it is the one
    // waiting for the network; it is never cleared by a failed attempt, only by success or an account change.
    const pendingProfileSyncRef = useRef(null);
    const profileHeldRef = useRef(false);
    // True after the server REFUSED a snapshot and the draft on screen has not been reverted yet.
    const profileFailedRef = useRef(false);
    const profileFailReasonRef = useRef('');
    // Set when the writer leaves a field or the screen: a refusal that lands now (or is already waiting)
    // replaces the draft with the server's values instead of leaving the two disagreeing.
    const profileRevertOnFailRef = useRef(false);
    const profileStateTimerRef = useRef(null);
    const profileSnapshotOf = (p) => ({ name: p.name, penName: p.penName, avatar: p.avatar, motto: p.motto });
    const profileUnsettled = () => !!(pendingProfileSyncRef.current || profileSyncInFlightRef.current || profileFailedRef.current);
    const setSaveState = (s) => {
        if (profileStateTimerRef.current) { clearTimeout(profileStateTimerRef.current); profileStateTimerRef.current = null; }
        setProfileSaveState(s);
        if (s === 'saved' || s === 'reverted') {
            profileStateTimerRef.current = setTimeout(() => setProfileSaveState((cur) => (cur === s ? null : cur)), s === 'saved' ? 2500 : 9000);
        }
    };
    // Replace the on-screen draft (and the local record) with what `profiles` really holds. Never runs while a
    // newer edit exists, and never for another account.
    const revertProfileToServer = async () => {
        const uid = sessionIdRef.current;
        if (!uid) return;
        const reason = profileFailReasonRef.current || 'Something went wrong on our side.';
        profileRevertOnFailRef.current = false;
        const row = await fetchOwnProfileRow().catch(() => null);
        if (sessionIdRef.current !== uid || pendingProfileSyncRef.current || profileSyncInFlightRef.current) return;
        if (!row) {
            // Can't read the server right now, so there is nothing true to show instead. Keep the refusal
            // visible and try the revert again the next time the writer leaves a field or the screen.
            profileFailedRef.current = true;
            setProfileSyncNotice('Not saved. ' + reason + " We couldn't reload your saved details just now.");
            setSaveState('failed');
            return;
        }
        profileFailedRef.current = false;
        let stored = null;
        try { const r = await storage.get(PROFILE_KEY); stored = r ? JSON.parse(r.value) : null; } catch (e) { stored = null; }
        if (sessionIdRef.current !== uid || pendingProfileSyncRef.current || profileSyncInFlightRef.current) return;
        const base = writerProfileRef.current || stored || { joinDate: new Date().toISOString() };
        // A photo that exists only on this device (a data: URL is never pushed to `profiles`) is not a
        // disagreement with the server, so it survives the revert.
        const deviceOnlyAvatar = stored && typeof stored.avatar === 'string' && stored.avatar.startsWith('data:') ? stored.avatar : null;
        const reverted = {
            ...base, name: serverProfileName(row.display_name), penName: row.pen_name || '', motto: row.motto || '',
            avatar: row.avatar_url || deviceOnlyAvatar || null,
        };
        writerProfileRef.current = reverted;
        setWriterProfile(reverted);
        storage.set(PROFILE_KEY, JSON.stringify(reverted));
        setProfileNameWarning(null);
        setProfileSyncNotice("That change wasn't saved. " + reason + ' Showing your saved details instead.');
        setSaveState('reverted');
    };
    // Sends the newest pending snapshot. One request in flight at a time, so the last thing the server sees
    // is the last thing the writer typed. `opts.revertOnFail` is passed when the writer leaves a field or
    // the screen.
    const flushProfileSync = async (opts) => {
        if (opts && opts.revertOnFail) profileRevertOnFailRef.current = true;
        if (profileSyncTimerRef.current) { clearTimeout(profileSyncTimerRef.current); profileSyncTimerRef.current = null; }
        if (profileSyncInFlightRef.current) return; // the in-flight attempt re-checks pending when it finishes
        if (!pendingProfileSyncRef.current) {
            // Nothing to send. A refusal that was waiting for the writer to leave the field is applied now.
            if (profileRevertOnFailRef.current && profileFailedRef.current) revertProfileToServer();
            return;
        }
        const snapshot = pendingProfileSyncRef.current;
        pendingProfileSyncRef.current = null;
        profileHeldRef.current = false;
        profileSyncInFlightRef.current = true;
        const uid = sessionIdRef.current;
        setSaveState('saving');
        // 'saved' = the server accepted it; 'local' = no session any more (local-only, as signed out);
        // 'held' = the server could not be reached; 'failed' = the server answered and refused.
        let outcome = 'saved';
        let reason = '';
        try {
            const r = await syncProfile(snapshot);
            if (r === null) outcome = 'local';
        } catch (e) {
            console.warn('Inkroot: profile sync failed', e);
            if (e && e.code === 'PROFILE_NAME_REJECTED') {
                // Reserved / already-taken name: syncProfile's message is written to be shown to the writer.
                outcome = 'failed';
                reason = e.message || 'That name is not available.';
            } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                outcome = 'held';
            } else {
                // syncProfile hides the difference between "no connection" and "the server said no" behind
                // one generic error, so ask the one question that tells them apart: can the server be read?
                const row = await fetchOwnProfileRow().catch(() => null);
                if (row) { outcome = 'failed'; reason = 'Something went wrong on our side.'; }
                else outcome = 'held';
            }
        }
        profileSyncInFlightRef.current = false;
        // The account changed (or signed out) while this was in flight: the reset effect below has already
        // cleared everything, and nothing here belongs to the new session.
        if (sessionIdRef.current !== uid) return;
        const newer = pendingProfileSyncRef.current; // an edit made while this one was in flight
        if (outcome === 'saved' || outcome === 'local') {
            profileFailedRef.current = false;
            // Only server-accepted values reach the local record (and so the sync store and other devices).
            storage.set(PROFILE_KEY, JSON.stringify({ ...(writerProfileRef.current || {}), ...snapshot }));
            if (!newer) { profileRevertOnFailRef.current = false; setSaveState(outcome === 'saved' ? 'saved' : null); }
        } else if (outcome === 'held') {
            if (!newer) {
                pendingProfileSyncRef.current = snapshot;
                profileHeldRef.current = true;
                setProfileSyncNotice("Not saved yet \u2014 we can't reach your account right now. We'll save it when you're back online. Closing the app before then will lose this change.");
                setSaveState('held');
            }
        } else if (!newer) {
            profileFailedRef.current = true;
            profileFailReasonRef.current = reason;
            setProfileSyncNotice('Not saved. ' + reason + (reason === 'Something went wrong on our side.' ? ' Your account still has your previous details.' : ''));
            setSaveState('failed');
        }
        if (pendingProfileSyncRef.current && !profileHeldRef.current) flushProfileSync();
        else if (outcome === 'failed' && !newer && profileRevertOnFailRef.current) revertProfileToServer();
    };
    // "Retry" on the status line: send the draft as it is now.
    const retryProfileSave = () => {
        const p = writerProfileRef.current;
        if (!p || !sessionIdRef.current) return;
        profileFailedRef.current = false;
        profileRevertOnFailRef.current = false;
        if (!pendingProfileSyncRef.current) pendingProfileSyncRef.current = profileSnapshotOf(p);
        flushProfileSync();
    };
    // Don't sit on an unsent edit when the tab is hidden/closed or this screen unmounts; and try a held edit
    // again when the network or the tab comes back.
    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') flushProfileSync();
            else if (pendingProfileSyncRef.current && profileHeldRef.current) flushProfileSync();
        };
        const onOnline = () => { if (pendingProfileSyncRef.current && profileHeldRef.current) flushProfileSync(); };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('online', onOnline);
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('online', onOnline);
            flushProfileSync();
        };
    }, []);
    // A different account (or none) must never inherit the previous account's unsent draft.
    useEffect(() => {
        if (profileSyncTimerRef.current) { clearTimeout(profileSyncTimerRef.current); profileSyncTimerRef.current = null; }
        pendingProfileSyncRef.current = null;
        profileHeldRef.current = false;
        profileFailedRef.current = false;
        profileRevertOnFailRef.current = false;
        setProfileSyncNotice(null);
        setSaveState(null);
    }, [sessionUserId]);
    const saveProfile = (patch) => {
        const prev = writerProfileRef.current;
        const base = prev || { name: '', penName: '', motto: '', avatar: null, joinDate: new Date().toISOString() };
        const safePatch = { ...patch };
        let nameErr = null;
        // Hard block: a reserved name (Inkroot, Support, Staff, Admin, …) never saves at all
        // — the field is dropped from the patch, leaving the previous value in place, so the
        // rejected keystroke simply doesn't take effect rather than silently applying anyway.
        for (const field of ['name', 'penName']) {
            if (field in safePatch && isReservedName(safePatch[field])) {
                nameErr = "That name isn't available \u2014 it reads as an official Inkroot name, which no individual account can use.";
                delete safePatch[field];
            }
        }
        setProfileNameError(nameErr);
        const next = { ...base, ...safePatch };
        writerProfileRef.current = next;
        setWriterProfile(next);
        if (!sessionUserId) {
            // Signed out: local-only, exactly as before.
            storage.set(PROFILE_KEY, JSON.stringify(next));
        } else if (Object.keys(safePatch).length > 0) {
            // Signed in: the edit lives in the on-screen draft only; the server decides. Debounced so the
            // server isn't asked about every prefix of a name (migration 142 refuses a prefix that happens
            // to be someone else's exact name), and flushed at once when the writer leaves the field.
            profileFailedRef.current = false;
            profileRevertOnFailRef.current = false;
            profileHeldRef.current = false;
            pendingProfileSyncRef.current = profileSnapshotOf(next);
            setSaveState('saving');
            if (profileSyncTimerRef.current) clearTimeout(profileSyncTimerRef.current);
            profileSyncTimerRef.current = setTimeout(() => flushProfileSync(), 1000);
        }
        // Soft warning: doesn't block the save (real people legitimately share names, so a
        // hard block here would lock people out over coincidence) — just flags that the name
        // now closely resembles a real published author, in case this wasn't intentional.
        const effectiveName = (next.penName || next.name || '').trim();
        if (('name' in safePatch || 'penName' in safePatch) && effectiveName) {
            const match = findSimilarName(effectiveName, publishedAuthorNames, { excludeId: sessionUserId });
            setProfileNameWarning(match ? `This name is very close to an existing published author, "${match.name}." If that's not you, please choose a different name.` : null);
        } else if (!effectiveName) {
            setProfileNameWarning(null);
        }
    };
    useEffect(() => {
        let cancelled = false;
        (async () => {
            // Server truth: a signed-in account's guild seat comes from the server (get_my_guild_membership), with
            // the local record as the offline cache. Any failure here falls through to the local-only path below.
            let serverGuild = null;
            if (sessionUserId) {
                serverGuild = await fetchMyGuildMembership().catch((e) => { console.warn('Inkroot: guild membership fetch failed', e); return null; });
                if (cancelled) return;
            }
            const res = await storage.get(GUILD_KEY);
            if (cancelled) return;
            if (serverGuild) {
                let local = null;
                try { local = res ? JSON.parse(res.value) : null; } catch (e) { local = null; }
                const { membership, pendingFounderUpload } = mergeServerGuildMembership(serverGuild, local);
                setGuildProfile(membership);
                // Keep the offline cache in step, but never write a fully blank record over a saved one
                // (migration 212 refuses that on the server, and it would just bounce back).
                const isBlank = (m) => !m.guildType && !m.founderGuildId && !m.playerGuild && !m.joinedGuild && !m.leftAt;
                const localNorm = local ? normalizeGuildMembership(local) : null;
                const same = localNorm && JSON.stringify(localNorm) === JSON.stringify(membership);
                if (!same && !(local && isBlank(membership) && !isBlank(localNorm)) && !(waitingForPull() && isBlank(membership))) {
                    await storage.set(GUILD_KEY, JSON.stringify(membership));
                }
                // A Founder seat that exists only on this device (joined while signed out or offline) is uploaded;
                // a seat the server already dropped is not resurrected.
                if (pendingFounderUpload && membership.founderGuildId) {
                    syncFounderGuildMembership(membership.founderGuildId).catch((e) => console.warn('Inkroot: founder guild membership sync failed', e));
                }
                return;
            }
            if (res) {
                const loaded = normalizeGuildMembership(JSON.parse(res.value));
                setGuildProfile(loaded);
                // Backfill: a Founder Guild seat taken before Phase 8 (or on a device that
                // joined one while signed out) only ever existed locally — push it to
                // founder_guild_members now so this account's Fireside/Bookshelf reads and
                // writes for that guild aren't rejected by the membership-scoped RLS added in
                // schema_phase8.sql. No-ops quietly if not signed in yet; see also
                // sync-context.jsx, which does the same check right after sign-in.
                if (loaded.guildType === 'founder' && loaded.founderGuildId) {
                    syncFounderGuildMembership(loaded.founderGuildId).catch((e) => console.warn('Inkroot: founder guild membership sync failed', e));
                }
                return;
            }
            const fresh = freshGuildMembership();
            if (waitingForPull()) {
                // Same rule as the profile loader above: never save a blank guild record while this
                // account's real one may still be on its way down.
                if (pullWaitGaveUp) setGuildProfile(fresh);
                return;
            }
            await storage.set(GUILD_KEY, JSON.stringify(fresh));
            if (cancelled) return;
            setGuildProfile(fresh);
        })();
        return () => { cancelled = true; };
    }, [sessionUserId, pullTick, pullWaitGaveUp]);
    // FIX 5 plumbing for the two "take a seat" actions below (joinFounderGuild, enterOwnGuild). Both now wait for
    // the server before touching local state, the way joinGuildByCode and leaveCurrentGuild already do.
    const guildProfileRef = useRef(null);
    guildProfileRef.current = guildProfile;
    const guildActionBusyRef = useRef(false); // one seat-taking action at a time (a second tap is ignored)
    const ownGuildDraftIdRef = useRef(null);  // a first-time guild keeps ONE id across failed attempts (see enterOwnGuild)
    // What to tell the writer when the server call failed. A deliberately-written server message (name reserved,
    // already seated, suspended...) passes through sanitizeError untouched and is shown as is.
    const guildFailureMessage = (e, whatDidNotHappen) => {
        if (typeof navigator !== 'undefined' && navigator.onLine === false)
            return "You appear to be offline, so " + whatDidNotHappen + " Nothing was changed. Reconnect and try again.";
        if (e && e.message && e.message !== 'Something went wrong. Please try again.')
            return e.message;
        return "Something unexpected went wrong reaching Inkroot, so " + whatDidNotHappen + " Nothing was changed on your account or on this device. Please try again in a moment.";
    };
    // After a failed seat-taking call: does the server say this account already holds a seat (another device, or a
    // request that succeeded but whose answer never arrived)? If so that seat is the truth, so show it instead of an
    // error. Returns the membership now showing, or null when the server has no seat / can't be read.
    const adoptServerGuildIfSeated = async () => {
        if (!sessionIdRef.current) return null;
        const serverGuild = await fetchMyGuildMembership().catch(() => null);
        if (!serverGuild) return null;
        let local = null;
        try { const r = await storage.get(GUILD_KEY); local = r ? JSON.parse(r.value) : null; } catch (e) { local = null; }
        const { membership } = mergeServerGuildMembership(serverGuild, local);
        if (!membership.guildType) return null;
        setGuildProfile(membership);
        storage.set(GUILD_KEY, JSON.stringify(membership));
        return membership;
    };
    // Takes a seat in one of the ten permanent Founder Guilds — required before a writer can go
    // on to found a Guild of their own. A writer belongs to only one Guild at a time, so this is a
    // no-op if they're already in a guild or still cooling down from having left one.
    // Server first (FIX 5): a signed-in account's seat is written to founder_guild_members and the app only shows
    // the seat once that succeeded; on failure guildProfile is left exactly as it was and guildJoinNotice says why.
    // Signed out, the call is a no-op that returns null and the seat stays local, as before (it is uploaded on
    // sign-in by the loader above). Resolves true when the writer is now seated, false when nothing changed.
    const joinFounderGuild = async (founderGuildId) => {
        if (guildActionBusyRef.current) return false;
        const base = guildProfileRef.current || freshGuildMembership();
        if (base.guildType || guildCooldownRemainingMs(base) > 0)
            return false;
        guildActionBusyRef.current = true;
        try {
            try {
                await syncFounderGuildMembership(founderGuildId);
            }
            catch (e) {
                console.warn('Inkroot: founder guild membership sync failed', e);
                const adopted = await adoptServerGuildIfSeated();
                if (adopted) {
                    if (!(adopted.guildType === 'founder' && adopted.founderGuildId === founderGuildId))
                        setGuildJoinNotice({ title: "You already hold a guild seat", message: "Your account already has a seat in another guild, so that's the one now showing. Leave it first if you want to join a different guild." });
                    return true;
                }
                setGuildJoinNotice({ title: "Couldn't join guild", message: guildFailureMessage(e, "you haven't joined that guild.") });
                return false;
            }
            // Only reached once the server has accepted the seat (or there is no session: local-only).
            const cur = guildProfileRef.current || freshGuildMembership();
            if (cur.guildType)
                return true; // the loader seated this account while the request was out; nothing to add
            const next = { ...cur, guildType: 'founder', founderGuildId, founderJoinedDate: new Date().toISOString() };
            storage.set(GUILD_KEY, JSON.stringify(next));
            setGuildProfile(next);
            return true;
        }
        finally {
            guildActionBusyRef.current = false;
        }
    };
    // Leaves whichever guild the writer currently holds a seat in (Founder, Player, or Joined)
    // and starts the cooldown before another can be joined. The guild itself isn't affected —
    // Founder Guilds are permanent regardless, and a Player Guild's data (owned or the record of
    // which guild was joined) is kept so the writer can return to it later, once the cooldown
    // has passed.
    // A 'joined' or 'founder' membership has a real founder_guild_members/player_guild_members
    // row server-side, so leaving here is awaited and local state only flips to "left" once that
    // remote delete actually succeeds — otherwise the writer would see themselves as having left
    // (and start the cooldown) while still genuinely seated in the guild server-side. On failure
    // guildProfile is left exactly as it was and guildLeaveNotice surfaces the failure instead.
    //
    // guildType 'player' (owning your own guild) is NOT a local-only case — create_or_get_own_guild
    // gives the owner a real player_guilds row (owner_id) AND a real player_guild_members row,
    // same as anyone else's membership. There is no disband/transfer-ownership flow anywhere in
    // this app yet, so an owner has nothing to actually leave to: falling through to the same
    // "flip guildType to null locally" reset the other two branches use would just desync local
    // state from the server (still the real owner/member, but the UI claims otherwise), which is
    // exactly the bug this guard exists to prevent. GuildBanner already hides the "Leave Guild"
    // button for this case (see its own comment), so reaching this function with guildType
    // 'player' should only happen via some other, currently-nonexistent path — this is the
    // server-truth backstop for that, not a route the UI is expected to take.
    const leaveCurrentGuild = async () => {
        const base = guildProfile || freshGuildMembership();
        if (!base.guildType)
            return;
        if (base.guildType === 'player') {
            setGuildLeaveNotice({
                title: "Can't leave your own guild yet",
                message: "There's no way to disband a guild or hand off ownership yet, so as the founder you can't leave. This is coming in a future update.",
            });
            return;
        }
        try {
            if (base.guildType === 'joined' && base.joinedGuild && base.joinedGuild.id) {
                await leavePlayerGuildRemote(base.joinedGuild.id);
            }
            else if (base.guildType === 'founder' && base.founderGuildId) {
                await leaveFounderGuildMembership(base.founderGuildId);
            }
        }
        catch (e) {
            setGuildLeaveNotice({
                title: "Couldn't leave guild",
                message: "Something unexpected went wrong reaching Inkroot. Please try again in a moment.",
            });
            return;
        }
        // Only reached once the remote leave above has actually succeeded.
        const next = { ...base, guildType: null, leftAt: new Date().toISOString() };
        storage.set(GUILD_KEY, JSON.stringify(next));
        setGuildProfile(next);
    };
    // Takes the seat in the writer's own Player Guild — founding it on first use, or simply
    // returning to it later. Like joining a Founder Guild, this requires not currently being in a
    // guild and not still cooling down from having left one. Founding for the first time also
    // requires a name: GuildWelcomeScreen only calls this with one once the writer has actually
    // typed something (see its own name-entry step), but this is re-checked here too, so a guild
    // can never actually exist — even for a moment, even locally — with no name at all.
    // Server first (FIX 5): create_or_get_own_guild runs BEFORE any local state changes, so the app never shows a
    // seat (or an owner) the server does not have. On failure nothing changes locally and guildJoinNotice says why;
    // the old "show it as founded, then warn it didn't save" path (and its half-synced `synced: false` window) is
    // gone for signed-in accounts. Signed out, syncPlayerGuild returns null and the guild stays local with
    // synced: false, exactly as before. Resolves true when the writer is now seated, false when nothing changed.
    // (The Return button used to pass its click event in as `name`; anything that is not a string is now ignored.)
    const enterOwnGuild = async (nameArg) => {
        if (guildActionBusyRef.current) return false;
        const base = guildProfileRef.current || freshGuildMembership();
        if (base.guildType || guildCooldownRemainingMs(base) > 0)
            return false;
        const isFirstFounding = !base.playerGuild;
        const cleanName = typeof nameArg === 'string' ? nameArg.trim() : '';
        if (isFirstFounding && !cleanName)
            return false;
        // A first-time guild's id is made once and kept across failed attempts. If an attempt reached the server but
        // its answer was lost, a retry with a NEW id would be refused ("You already own a Player Guild"); the same id
        // just converges on the row that is already there.
        if (isFirstFounding && !ownGuildDraftIdRef.current)
            ownGuildDraftIdRef.current = uuid();
        const existingPlayer = base.playerGuild || { id: ownGuildDraftIdRef.current, name: cleanName, crest: null, motto: '', createdDate: new Date().toISOString(), synced: false };
        guildActionBusyRef.current = true;
        try {
            let row = null;
            try {
                row = await syncPlayerGuild(existingPlayer.id, { name: existingPlayer.name, motto: existingPlayer.motto, crestUrl: existingPlayer.crest });
            }
            catch (e) {
                console.warn('Inkroot: guild sync failed', e);
                const adopted = await adoptServerGuildIfSeated();
                if (adopted) {
                    if (adopted.guildType !== 'player')
                        setGuildJoinNotice({ title: "You already hold a guild seat", message: "Your account already has a seat in another guild, so that's the one now showing. Leave it first if you want to take a different seat." });
                    return true;
                }
                setGuildJoinNotice({
                    title: isFirstFounding ? "Couldn't found your guild" : "Couldn't return to your guild",
                    message: guildFailureMessage(e, isFirstFounding ? "your guild wasn't founded." : "you haven't returned to your guild."),
                });
                return false;
            }
            // Only reached once the server has accepted (or there is no session: local-only).
            const cur = guildProfileRef.current || freshGuildMembership();
            if (cur.guildType)
                return true; // the loader seated this account while the request was out; nothing to add
            ownGuildDraftIdRef.current = null;
            const player = row
                ? { ...existingPlayer, synced: true, ...(row.invite_code ? { inviteCode: row.invite_code } : {}) }
                : existingPlayer;
            const next = { ...cur, guildType: 'player', playerGuild: player };
            storage.set(GUILD_KEY, JSON.stringify(next));
            setGuildProfile(next);
            setGuildSyncNotice(null);
            return true;
        }
        finally {
            guildActionBusyRef.current = false;
        }
    };
    // Re-attempts the sync for the writer's own Player Guild after a failure surfaced via
    // guildSyncNotice — same call enterOwnGuild/saveOwnGuild already make, just re-run on demand
    // instead of left to fail silently. Reuses the existing local playerGuild.id rather than
    // generating a new one, so a retry converges onto the same guild row instead of orphaning
    // another id (see create_or_get_own_guild's "you already own a Player Guild" check).
    const retryOwnGuildSync = () => {
        const player = guildProfile && guildProfile.playerGuild;
        if (!player) { setGuildSyncNotice(null); return; }
        syncPlayerGuild(player.id, { name: player.name, motto: player.motto, crestUrl: player.crest })
            .then((row) => {
                setGuildSyncNotice(null);
                if (row) {
                    const patch = { synced: true };
                    if (row.invite_code && row.invite_code !== player.inviteCode)
                        patch.inviteCode = row.invite_code;
                    saveOwnGuild(patch);
                }
            })
            .catch((e) => {
                console.warn('Inkroot: guild sync retry failed', e);
                setGuildSyncNotice({
                    title: "Still couldn't save your guild",
                    message: (e && e.message) ||
                        "Something went wrong saving your guild to your account. Please check your connection and try again.",
                });
            });
    };
    // Edits the writer's own Player Guild (name, motto, crest) once they're seated in it.
    const saveOwnGuild = (patch) => {
        setGuildProfile((prev) => {
            const base = prev || freshGuildMembership();
            const existingPlayer = base.playerGuild || { id: uuid(), name: '', crest: null, motto: '', createdDate: new Date().toISOString(), synced: false };
            const next = { ...base, playerGuild: { ...existingPlayer, ...patch } };
            storage.set(GUILD_KEY, JSON.stringify(next));
            // Only push name/motto/crest edits remotely, never inviteCode itself (that field is
            // server-generated and only ever written locally as a mirror of what came back from
            // syncPlayerGuild above — pushing it back up would be redundant, not wrong, but
            // there's no reason to).
            if ('name' in patch || 'motto' in patch || 'crest' in patch) {
                syncPlayerGuild(existingPlayer.id, {
                    name: patch.name != null ? patch.name : existingPlayer.name,
                    motto: patch.motto != null ? patch.motto : existingPlayer.motto,
                    crestUrl: patch.crest != null ? patch.crest : existingPlayer.crest,
                })
                    .then(() => {
                        setGuildSyncNotice(null);
                        // Confirms synced here too — covers an edit made while a founding sync
                        // was still pending or had failed; this success is just as much proof
                        // the row exists server-side as enterOwnGuild's own sync is.
                        if (!existingPlayer.synced)
                            saveOwnGuild({ synced: true });
                    })
                    .catch((e) => {
                        console.warn('Inkroot: guild sync failed', e);
                        setGuildSyncNotice({
                            title: "Your guild changes didn't save",
                            message: (e && e.message) ||
                                "Something went wrong saving your guild to your account. Your changes are kept on this device, but other devices and readers won't see them yet, and owner-only actions may be rejected by the server until this resolves.",
                        });
                    });
            }
            return next;
        });
    };
    // Joins another writer's Player Guild by invite code. Requires being signed in (the remote
    // call itself enforces this) and not currently seated in — or cooling down from — a guild.
    const [joinCodeError, setJoinCodeError] = useState('');
    const joinGuildByCode = async (code) => {
        setJoinCodeError('');
        if (guildProfile && (guildProfile.guildType || guildCooldownRemainingMs(guildProfile) > 0))
            return;
        try {
            const guild = await joinPlayerGuildByCode(code);
            setGuildProfile((prev) => {
                const base = prev || freshGuildMembership();
                const next = {
                    ...base, guildType: 'joined',
                    joinedGuild: { id: guild.id, name: guild.name, motto: guild.motto, crest: guild.crest_url, ownerId: guild.owner_id, joinedDate: new Date().toISOString() },
                };
                storage.set(GUILD_KEY, JSON.stringify(next));
                return next;
            });
        }
        catch (e) {
            setJoinCodeError(e.message || 'Could not join that guild.');
        }
    };
    const loadProjectIndex = async () => {
            try {
                const res = await storage.get(INDEX_KEY);
                if (res) {
                    const parsed = JSON.parse(res.value);
                    if (!Array.isArray(parsed))
                        throw new Error('project index is not a list');
                    setProjects(parsed);
                    setIndexLoadError(false);
                    return;
                }
                // Migrate a pre-multi-project save, if one exists, so nobody loses work.
                const legacy = await storage.get(LEGACY_KEY);
                if (legacy) {
                    const data = patchProjectDefaults(JSON.parse(legacy.value));
                    const id = uuid();
                    await storage.set(projectKey(id), JSON.stringify(data));
                    const total = data.chapters.reduce((s, c) => s + wordCount(c.text), 0);
                    const index = [{ id, title: data.title, subtitle: data.subtitle || '', seriesName: data.seriesName || '', author: data.author || '', cover: data.cover || null, wordCount: total, updatedAt: Date.now() }];
                    await storage.set(INDEX_KEY, JSON.stringify(index));
                    setProjects(index);
                    setIndexLoadError(false);
                    return;
                }
                // FIX (sign-out/sign-in data loss) -- an empty local index is only "no projects" once this
                // account's pull has landed. Until then `projects` stays null (the loading screen) so a
                // project created in that window can't be saved over the real index; the pulled/account-
                // pulled events below re-run this, and the 10s fallback covers a pull that never lands.
                if (waitingForPull() && !pullWaitGaveUp)
                    return;
                setProjects([]);
                setIndexLoadError(false);
            }
            catch (e) {
                // Not "no projects": the read itself failed. Leave `projects` null and block every
                // index write until a retry succeeds (see indexLoadError above).
                console.error('Could not load the project index', e);
                setIndexLoadError(true);
            }
    };
    useEffect(() => {
        loadProjectIndex();
    }, []);
    // Re-run once the pull has landed (covers an empty-but-successful pull, which fires no 'sync-pulled'),
    // and once more if the wait gave up, so the loading screen can never hang on a pull that never arrives.
    useEffect(() => {
        if (pullTick > 0 || pullWaitGaveUp) loadProjectIndex();
    }, [pullTick, pullWaitGaveUp]);
    // FIX — re-reads the project index once this account's initial post-sign-in pull has actually
    // finished (see sync-context.jsx's runPostSwitchSteps). The effect above only ever runs once,
    // on mount, which races ahead of that pull: SyncGate renders the app as soon as the session is
    // known, not once its data has been pulled down, so the very first loadProjectIndex() call can
    // read local IndexedDB before anything's there yet and land on an empty list — including any
    // published books, which render from this same local project list (see publishing.jsx). Filters
    // on sessionUserId so a stale event from a previous/different account's pull (e.g. one still
    // resolving right as a fast sign-out-then-sign-in-as-someone-else happens) can't re-trigger a
    // reload for whoever is actually signed in by the time it arrives.
    useEffect(() => {
        const handler = (e) => {
            if (e.detail && e.detail.userId === sessionUserId) loadProjectIndex();
        };
        window.addEventListener('inkroot:sync-pulled', handler);
        return () => window.removeEventListener('inkroot:sync-pulled', handler);
    }, [sessionUserId]);
    const saveIndex = (next) => {
        if (projects === null)
            return; // index never loaded — writing now could overwrite the real list
        setProjects(next);
        storage.set(INDEX_KEY, JSON.stringify(next));
    };
    const handleCreate = () => {
        if (projects === null)
            return; // index never loaded — see indexLoadError
        const id = uuid();
        const fresh = emptyProject();
        storage.set(projectKey(id), JSON.stringify(fresh));
        const entry = { id, title: fresh.title, subtitle: '', seriesName: '', author: '', cover: fresh.cover, wordCount: 0, updatedAt: Date.now() };
        saveIndex([...(projects || []), entry]);
        scrollPageToTop(); // a full screen opens at its top
        nav.push({ label: fresh.title || 'Project', undo: () => setCurrentId(null) });
        setOpenTab('hub');
        setCurrentId(id);
    };
    const handleMeta = (id, meta) => {
        setProjects((prev) => {
            if (prev === null)
                return prev; // index never loaded — writing [] here would wipe the stored list
            const next = prev.map((p) => (p.id === id ? { ...p, ...meta } : p));
            storage.set(INDEX_KEY, JSON.stringify(next));
            return next;
        });
    };
    // Builds the payload for published_book_content — the public reader-facing mirror written
    // alongside every publishBookRemote call (see lib/library.js's publishBookContentRemote and
    // 70_migration_published_book_content.sql). Shaped exactly like what PublishedBookReader
    // (author-reputation.jsx) expects, so openReaderBook can hand a fetched row straight to
    // patchProjectDefaults with no further lookup. Chapters are trimmed to only the fields a
    // reader ever sees — never the author's own project-only fields (notes, backups, etc.).
    // The guild id guild_published_books'/published_books'/published_book_content's own
    // guild-membership RLS actually keys off (see 92_migration_player_guild_book_publishing.sql)
    // — a Founder Guild's fixed slug (founder_guild_members.guild_id) for a Founder Guild, or the
    // real player_guilds.id (player_guild_members.guild_id) for a self-founded ('player') or
    // joined ('joined') Player Guild. Deliberately NOT the same value as home-screen.jsx's own
    // activeGuildRemoteId, which uses a Founder Guild's backendGuildId (migration 69) instead —
    // that id space backs Guild Order/Anthology/Events, not the Bookshelf, and
    // guild_published_books has never used it. Returns null when there's no active guild to
    // publish a book to, same as the founderGuildId-only check this replaces.
    const activeBookshelfGuildId = () => {
        if (!guildProfile || !guildProfile.guildType)
            return null;
        if (guildProfile.guildType === 'founder')
            return guildProfile.founderGuildId || null;
        if (guildProfile.guildType === 'joined')
            return (guildProfile.joinedGuild && guildProfile.joinedGuild.id) || null;
        if (guildProfile.guildType === 'player')
            return (guildProfile.playerGuild && guildProfile.playerGuild.id) || null;
        return null;
    };
    // buildPublishedBookContent / buildPublishedPackContent moved to lib/publish-content.js
    // (publishing reliability pass, fix-tracker item 27) so Author Studio here and a project's
    // own Publishing Hub (project-workspace.jsx) build the exact same published_book_content /
    // published_pack_content shape instead of each keeping a private copy.
    const authorDisplayName = () => (writerProfile && (writerProfile.penName || writerProfile.name)) || '';
    // Grand Library > Author Studio: sets a completed project's publish destination ('none',
    // 'inkroot', or 'guild') from outside the project itself. The full project object (not just
    // the index entry) is the source of truth — same reasoning as `completed` elsewhere in the
    // app (Legacy Shelf, Guild XP, Guild Reputation) — so this loads it, sets the one field, and
    // saves it back, then patches the index via handleMeta so Home and the Grand Library reflect
    // it immediately without needing to open the project. Promoting a Guild publication to
    // Inkroot is just this same call with 'inkroot' — the project record never gets duplicated.
    // Publishing reliability (fix-tracker item 27): the local write that flips this UI to
    // "Published"/"Unpublished" now happens ONLY after the remote flow below has actually
    // resolved — never before, never in parallel with it. See lib/publish-flow.js for the full
    // rationale and for why a content-publish failure now rolls its own listing back instead of
    // leaving a half-published book standing. A failure here (this is a quick-action call site,
    // not the Wizard, so there's no inline error surface of its own) shows publishNotice and
    // returns without touching local state — the project keeps whatever status it already had,
    // which is always the truthful one since nothing changed remotely.
    const setPublishStatus = async (id, status) => {
        const res = await storage.get(projectKey(id));
        if (!res) {
            // A book that is published on the server but whose draft is not on this device (see
            // overlayServerPublishStatus): the only thing that can be done from here is unpublish it.
            if (status === 'none') {
                try {
                    const flow = await unpublishBookRemoteFlow(id);
                    await loadMyPublishedRows();
                    if (flow && flow.mode === 'hidden')
                        setPublishNotice(SOLD_BOOK_UNPUBLISHED_NOTICE);
                }
                catch (e) {
                    setPublishNotice({
                        title: "Couldn't unpublish",
                        message: e instanceof PublishFlowError ? e.message : "Something unexpected went wrong reaching Inkroot. Please try again in a moment.",
                    });
                }
            }
            return;
        }
        let proj;
        try {
            proj = JSON.parse(res.value);
        }
        catch (e) {
            return;
        }
        const publishedAt = status !== 'none' ? Date.now() : null;
        // Computed once, up front — used by both the published_books push below AND the guild
        // push further down, so a book's real word count is consistent between the two (and
        // available for real-author-accounts display even when it's never guild-published — see
        // lib/library.js's publishBookRemote and fetchPublishedBooksByAuthor).
        const totalWords = (proj.chapters || []).reduce((s, c) => s + wordCount(c.text), 0);
        const activeGuildId = activeBookshelfGuildId();
        // Set when the server kept the listing (hidden, not deleted) because readers have already
        // bought the book — see unpublishBookRemoteFlow. Surfaced once the local status is saved.
        let soldBookHidden = false;
        try {
            if (status === 'none') {
                const flow = await unpublishBookRemoteFlow(id);
                soldBookHidden = !!(flow && flow.mode === 'hidden');
            }
            else {
                await publishBookRemoteFlow({
                    id,
                    listing: {
                        id, title: proj.title, subtitle: proj.subtitle, seriesName: proj.seriesName, cover: proj.cover,
                        blurb: proj.blurb, genre: proj.genre, tags: proj.tags, wordCount: totalWords,
                        price: proj.price, destination: status, publishedAt,
                    },
                    content: buildPublishedBookContent(proj, authorDisplayName()),
                    destination: status,
                    guildId: activeGuildId,
                });
            }
        }
        catch (e) {
            setPublishNotice({
                title: status === 'none' ? "Couldn't unpublish" : "Couldn't publish",
                message: e instanceof PublishFlowError ? e.message : "Something unexpected went wrong reaching Inkroot. Please try again in a moment.",
            });
            return;
        }
        // Only reached once the remote steps above have actually succeeded (or there's no
        // signed-in account to push to at all — the same local-only fallback this always had).
        proj.publishStatus = status;
        proj.publishedAt = publishedAt;
        await storage.set(projectKey(id), JSON.stringify(proj));
        handleMeta(id, { publishStatus: status, publishedAt });
        loadMyPublishedRows();
        if (soldBookHidden)
            setPublishNotice(SOLD_BOOK_UNPUBLISHED_NOTICE);
    };
    // Same idea as setPublishStatus above, but for a single Worldbuilding Pack inside a project
    // rather than the project's own book publication. Lets the Grand Library's Author Studio
    // unpublish a pack directly, without opening the project that owns it — the project file is
    // still the source of truth, this just loads it, updates the one pack, saves it back, and
    // re-mirrors every pack's summary onto the index (see packSummaryForIndex) so what the
    // Library shows stays current.
    // Same publishing-reliability contract as setPublishStatus above, applied to a single
    // Worldbuilding Pack — the local write only lands once the remote listing+content pair has
    // actually succeeded (see publishPackRemoteFlow in lib/publish-flow.js).
    const setPackPublishStatus = async (projectId, packId, status) => {
        const res = await storage.get(projectKey(projectId));
        if (!res)
            return;
        let proj;
        try {
            proj = JSON.parse(res.value);
        }
        catch (e) {
            return;
        }
        const patched = patchProjectDefaults(proj);
        const pack = patched.worldbuildingPacks.find((p) => p.id === packId);
        if (!pack)
            return;
        // The composite id ("<projectId>:<packKey>") matches what grand-library-screen.jsx
        // already computes locally as `selectedPackKey`.
        const remotePackId = `${projectId}:${packId}`;
        const publishedAt = status !== 'none' ? (pack.publishedAt || Date.now()) : null;
        // True when the server kept the pack off-offer (owners exist) instead of deleting it.
        let soldPackHidden = false;
        try {
            if (status === 'none') {
                const flow = await unpublishPackRemoteFlow(remotePackId);
                soldPackHidden = !!(flow && flow.mode === 'hidden');
            }
            else {
                const summary = packSummaryForIndex(patched, pack);
                await publishPackRemoteFlow({
                    id: remotePackId,
                    listing: {
                        id: remotePackId, projectId, packKey: packId, title: summary.title, subtitle: summary.subtitle,
                        description: summary.description, genre: summary.genre, tags: summary.tags,
                        coverImageUrl: summary.coverImageUrl, price: summary.price, categories: summary.categories,
                        totalEntries: summary.totalEntries, publishedAt,
                    },
                    content: buildPublishedPackContent(patched, pack),
                });
            }
        }
        catch (e) {
            setPublishNotice({
                title: status === 'none' ? "Couldn't unpublish pack" : "Couldn't publish pack",
                message: e instanceof PublishFlowError ? e.message : "Something unexpected went wrong reaching Inkroot. Please try again in a moment.",
            });
            return;
        }
        pack.publishStatus = status;
        pack.publishedAt = publishedAt;
        pack.updatedAt = Date.now();
        await storage.set(projectKey(projectId), JSON.stringify(patched));
        handleMeta(projectId, { worldbuildingPacks: patched.worldbuildingPacks.map((pk) => packSummaryForIndex(patched, pk)) });
        if (soldPackHidden)
            setPublishNotice(SOLD_PACK_UNPUBLISHED_NOTICE);
    };
    // Confirm handlers for the Publishing Wizard (see PublishingWizard) when it's opened from
    // Author Studio, which — unlike a project's own Settings tab — doesn't have the project
    // loaded, only its index entry. Same read-modify-write pattern as setPublishStatus /
    // setPackPublishStatus just above, just also writing the listing fields Step 3 collected
    // (title, description, genre, tags, price, and — for a pack — its cover) rather than only
    // the publish status, and mirroring the same fields onto the index afterward.
    // Called from PublishingWizard's onPublishBook — unlike setPublishStatus above, this is
    // awaited by the Wizard itself (see PublishingWizard's own idle/publishing/error state in
    // library/publishing.jsx), so a failure here is re-thrown rather than shown via
    // publishNotice: the Wizard has its own inline error surface and stays open on its confirm
    // step so the writer can retry without re-filling the form. Same "local write only after the
    // remote flow resolves" contract as setPublishStatus either way.
    const publishBookWithDetails = async (id, destination, details) => {
        const res = await storage.get(projectKey(id));
        if (!res)
            return;
        let proj;
        try {
            proj = JSON.parse(res.value);
        }
        catch (e) {
            return;
        }
        const publishedAt = Date.now();
        const nextProj = { ...proj };
        nextProj.title = details.title || proj.title;
        nextProj.genre = details.genre;
        nextProj.blurb = details.description;
        nextProj.tags = details.tags;
        nextProj.price = details.priceMode === 'paid' ? details.price : 0;
        nextProj.downloadable = !!details.downloadable;
        if (details.storyFormat === 'series' || details.storyFormat === 'book')
            nextProj.storyFormat = details.storyFormat;
        // Computed once, up front — same reasoning as setPublishStatus's totalWords above.
        const totalWords = (proj.chapters || []).reduce((s, c) => s + wordCount(c.text), 0);
        const activeGuildId = activeBookshelfGuildId();
        await publishBookRemoteFlow({
            id,
            listing: {
                id, title: nextProj.title, subtitle: nextProj.subtitle, seriesName: nextProj.seriesName, cover: nextProj.cover,
                blurb: nextProj.blurb, genre: nextProj.genre, tags: nextProj.tags, wordCount: totalWords,
                price: nextProj.price, destination, publishedAt, storyFormat: nextProj.storyFormat || 'book',
                downloadable: nextProj.downloadable,
            },
            content: buildPublishedBookContent(nextProj, authorDisplayName()),
            destination,
            guildId: activeGuildId,
        }); // throws PublishFlowError on failure — nothing below runs, nothing local changes
        nextProj.publishStatus = destination;
        nextProj.publishedAt = publishedAt;
        await storage.set(projectKey(id), JSON.stringify(nextProj));
        handleMeta(id, { publishStatus: destination, publishedAt, title: nextProj.title, genre: nextProj.genre, blurb: nextProj.blurb, tags: nextProj.tags, price: nextProj.price, storyFormat: nextProj.storyFormat || 'book', downloadable: nextProj.downloadable });
    };
    // Called from PublishingWizard's onPublishPack — same "awaited by the Wizard, throws on
    // failure instead of using publishNotice" contract as publishBookWithDetails above.
    const publishPackWithDetails = async (projectId, packId, destination, details) => {
        const res = await storage.get(projectKey(projectId));
        if (!res)
            return;
        let proj;
        try {
            proj = JSON.parse(res.value);
        }
        catch (e) {
            return;
        }
        const patched = patchProjectDefaults(proj);
        const pack = patched.worldbuildingPacks.find((p) => p.id === packId);
        if (!pack)
            return;
        const nextPack = { ...pack };
        nextPack.title = details.title || pack.title;
        nextPack.description = details.description;
        nextPack.genre = details.genre;
        nextPack.tags = details.tags;
        nextPack.coverImageUrl = details.coverImageUrl;
        nextPack.price = details.priceMode === 'paid' ? details.price : 0;
        const publishedAt = Date.now();
        const remotePackId = `${projectId}:${packId}`;
        const summary = packSummaryForIndex(patched, nextPack);
        await publishPackRemoteFlow({
            id: remotePackId,
            listing: {
                id: remotePackId, projectId, packKey: packId, title: summary.title, subtitle: summary.subtitle,
                description: summary.description, genre: summary.genre, tags: summary.tags,
                coverImageUrl: summary.coverImageUrl, price: summary.price, categories: summary.categories,
                totalEntries: summary.totalEntries, publishedAt,
            },
            content: buildPublishedPackContent(patched, nextPack),
        }); // throws PublishFlowError on failure — nothing below runs, nothing local changes
        nextPack.publishStatus = destination;
        nextPack.publishedAt = publishedAt;
        nextPack.updatedAt = Date.now();
        const packIdx = patched.worldbuildingPacks.findIndex((p) => p.id === packId);
        patched.worldbuildingPacks[packIdx] = nextPack;
        await storage.set(projectKey(projectId), JSON.stringify(patched));
        handleMeta(projectId, { worldbuildingPacks: patched.worldbuildingPacks.map((pk) => packSummaryForIndex(patched, pk)) });
    };
    const handleDelete = (id) => {
        storage.delete(projectKey(id));
        storage.delete(backupsKey(projectKey(id)));
        saveIndex((projects || []).filter((p) => p.id !== id));
    };
    const handleDeleteCurrent = (id) => {
        storage.delete(projectKey(id));
        storage.delete(backupsKey(projectKey(id)));
        saveIndex((projects || []).filter((p) => p.id !== id));
        // The project this trail was pointing at no longer exists, so restart from Home rather
        // than trying to "undo" back into a screen that's now gone.
        nav.resetTo(null);
        setCurrentId(null);
    };
    // Storage quota is shared across every project in this browser, not allocated per-project —
    // so a project can still fail to save even after its own images are optimized, if other
    // projects (or their old backups, from before backups stripped heavy media) are what's using
    // up the room. This sweeps every project on the device, not just the one currently open.
    const handleOptimizeAllStorage = async () => {
        let totalFreed = 0, touchedProjects = 0;
        for (const meta of (projects || [])) {
            const res = await storage.get(projectKey(meta.id));
            if (!res)
                continue;
            let proj;
            try {
                proj = JSON.parse(res.value);
            }
            catch (e) {
                continue;
            }
            const before = res.value.length;
            const { project: optimized, freedBytes } = await optimizeProjectImages(proj);
            const backupFreed = await reclaimBackupSpace(projectKey(meta.id));
            const serialized = JSON.stringify(optimized);
            if (serialized.length < before) {
                try {
                    await storage.set(projectKey(meta.id), serialized);
                    touchedProjects++;
                }
                catch (e) { }
            }
            totalFreed += freedBytes + backupFreed;
        }
        return { totalFreed, touchedProjects };
    };
    const handleExportAll = async () => {
        const bundle = { exportedFrom: 'inkroot', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), projects: [] };
        for (const meta of (projects || [])) {
            const res = await storage.get(projectKey(meta.id));
            if (res)
                bundle.projects.push(JSON.parse(res.value));
        }
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `inkroot-backup-${dateKey(new Date())}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };
    const handleImportFile = (file) => new Promise((resolve) => {
        const reader = new FileReader();
        reader.onerror = () => resolve('Could not read that file.');
        reader.onload = () => {
            try {
                const parsed = JSON.parse(reader.result);
                const incoming = Array.isArray(parsed.projects) ? parsed.projects : (parsed.chapters ? [parsed] : null);
                if (!incoming || incoming.length === 0) {
                    resolve('That file doesn\'t look like an Inkroot backup.');
                    return;
                }
                const newEntries = incoming.map((raw) => {
                    // restoreProject (not just patchProjectDefaults) so we also get back which, if
                    // any, schema migrations ran for this specific project being restored.
                    const { data, log } = restoreProject(raw);
                    const id = uuid();
                    storage.set(projectKey(id), JSON.stringify(data));
                    const total = data.chapters.reduce((s, c) => s + wordCount(c.text), 0);
                    return { id, title: data.title, subtitle: data.subtitle || '', seriesName: data.seriesName || '', author: data.author || '', cover: data.cover || null, wordCount: total, updatedAt: Date.now(), migrated: log.length > 0 };
                });
                saveIndex([...(projects || []), ...newEntries]);
                const migratedCount = newEntries.filter((e) => e.migrated).length;
                const migratedNote = migratedCount > 0
                    ? ` (${migratedCount} upgraded from an older backup format — see console for details)`
                    : '';
                resolve(`Imported ${newEntries.length} project${newEntries.length === 1 ? '' : 's'}${migratedNote}.`);
            }
            catch (e) {
                resolve('Could not read that file — is it an Inkroot backup?');
            }
        };
        reader.readAsText(file);
    });
    if (projects === null && indexLoadError) {
        return React.createElement("div", { style: { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, textAlign: 'center', background: '#17171B', color: '#EFE7D2', fontFamily: 'ui-sans-serif, system-ui' } },
            React.createElement("div", { style: { fontSize: 18, fontWeight: 600 } }, "Couldn\u2019t load your projects on this device"),
            React.createElement("div", { style: { fontSize: 14, color: '#A8A8B0', maxWidth: 420, lineHeight: 1.5 } }, "Nothing has been changed or deleted. Please try again \u2014 and if it keeps happening, close other Inkroot tabs or restart the browser before creating anything new."),
            React.createElement("button", { onClick: () => { setIndexLoadError(false); loadProjectIndex(); }, style: { marginTop: 4, padding: '10px 18px', borderRadius: 10, border: '1px solid #E8C468', background: 'transparent', color: '#E8C468', fontSize: 14, fontWeight: 600, cursor: 'pointer' } }, "Try again"));
    }
    if (projects === null) {
        return (React.createElement("div", { style: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#17171B', color: '#EFE7D2', fontFamily: 'ui-sans-serif, system-ui' } }, "Opening Inkroot\u2026"));
    }
    if (showModerationQueue) {
        return React.createElement("div", { key: "moderation-queue", className: "ink-page-in" },
            React.createElement(ModerationQueue, { onBack: () => { nav.pop(); setShowModerationQueue(false); } }));
    }
    if (showGuildEventJudging) {
        return React.createElement("div", { key: "guildevent-judging", className: "ink-page-in" },
            React.createElement(GuildEventJudgePanel, null));
    }
    if (showInkrootEventsAdmin) {
        return React.createElement("div", { key: "inkroot-events-admin", className: "ink-page-in" },
            React.createElement(InkrootEventsAdmin, { onBack: () => { nav.pop(); setShowInkrootEventsAdmin(false); } }));
    }
    if (showManageAdmins) {
        return React.createElement("div", { key: "manage-admins", className: "ink-page-in" },
            React.createElement(ManageAdmins, { onBack: () => { nav.pop(); setShowManageAdmins(false); } }));
    }
    if (showManualWithdrawalsAdmin) {
        return React.createElement("div", { key: "manual-withdrawals-admin", className: "ink-page-in" },
            React.createElement(ManualWithdrawalsAdmin, { onBack: () => { nav.pop(); setShowManualWithdrawalsAdmin(false); } }));
    }
    if (showLinkedProfilesAdmin) {
        return React.createElement("div", { key: "linked-profiles-admin", className: "ink-page-in" },
            React.createElement(LinkedProfilesAdmin, { isPlatformAdmin, onBack: () => { nav.pop(); setShowLinkedProfilesAdmin(false); } }));
    }
    if (currentId) {
        return React.createElement("div", { key: "workspace-" + currentId, className: "ink-page-in" },
            React.createElement(ProjectWorkspace, { projectId: currentId, onBack: () => nav.pop(), onMeta: handleMeta, onDeleteProject: handleDeleteCurrent, initialTab: openTab, guildProfile: guildProfile, writerProfile: writerProfile, activeBookshelfGuildId: activeBookshelfGuildId }));
    }
    if (readingBookId) {
        return React.createElement("div", { key: "reader-" + readingBookId, className: "ink-page-in" },
            readingBookProject
                ? React.createElement(PublishedBookReader, { project: readingBookProject, bookId: readingBookId, downloadable: readingBookDownloadable, onBack: () => nav.pop() })
                : readingBookLocked
                    ? React.createElement("div", { style: { minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', justifyContent: 'center', background: '#17171B', color: '#EFE7D2', fontFamily: 'ui-sans-serif, system-ui', padding: 24, textAlign: 'center' } },
                        React.createElement("div", { style: { fontSize: 16, fontWeight: 600 } }, "This book is only for readers who've bought it"),
                        React.createElement("div", { style: { fontSize: 13, color: '#A8A0A8', maxWidth: 320 } }, `The author priced this at ${formatNaira(readingBookLocked.price)}. Buy it from the Grand Library to read the full book.`),
                        React.createElement("button", { onClick: () => nav.pop(), style: { marginTop: 8, background: 'none', border: '1px solid #4A3D22', color: '#E8C468', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' } }, "Go back"))
                    : readingBookError
                        ? React.createElement("div", { style: { minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', justifyContent: 'center', background: '#17171B', color: '#EFE7D2', fontFamily: 'ui-sans-serif, system-ui', padding: 24, textAlign: 'center' } },
                            React.createElement("div", { style: { fontSize: 16, fontWeight: 600 } }, "This book couldn't be opened"),
                            React.createElement("div", { style: { fontSize: 13, color: '#A8A0A8', maxWidth: 320 } }, "It may have been unpublished, or something went wrong loading it. Please try again in a moment."),
                            React.createElement("button", { onClick: () => nav.pop(), style: { marginTop: 8, background: 'none', border: '1px solid #4A3D22', color: '#E8C468', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' } }, "Go back"))
                        : React.createElement("div", { style: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#17171B', color: '#EFE7D2', fontFamily: 'ui-sans-serif, system-ui' } }, "Opening book\u2026"));
    }
    if (viewingEventId !== null) {
        return React.createElement("div", { key: "guildevent-" + viewingEventId, className: "ink-page-in" },
            React.createElement(GuildEventDetailScreen, { eventId: viewingEventId, onOpenGuild: openGuildProfile, isAdmin: isPlatformAdmin }));
    }
    if (viewingGuildId !== null) {
        return React.createElement("div", { key: "guildprofile-" + viewingGuildId, className: "ink-page-in" },
            React.createElement(GuildPublicProfileScreen, { guildId: viewingGuildId, onOpenEvent: openGuildEvent }));
    }
    if (viewingAuthorName !== null && writerProfile) {
        const selfName = ((writerProfile.penName || writerProfile.name) || '').trim();
        const isSelf = viewingIsSelf;
        const authorHallGuildName = (() => {
            if (!guildProfile || !guildProfile.guildType)
                return null;
            if (guildProfile.guildType === 'player')
                return (guildProfile.playerGuild && guildProfile.playerGuild.name) || 'my guild';
            const fg = founderGuildById(guildProfile.founderGuildId);
            return (fg && fg.name) || 'my guild';
        })();
        return React.createElement("div", { key: "authorhall-" + (isSelf ? 'self' : (viewingAuthorId || viewingAuthorName)), className: "ink-page-in" },
            React.createElement(AuthorsHallScreen, {
                isSelf, authorName: isSelf ? selfName : viewingAuthorName, authorId: isSelf ? sessionUserId : viewingAuthorId,
                profile: writerProfile, projects: projects, publishedProjects: publishedProjects, onSaveProfile: saveProfile,
                nameError: profileNameError, nameWarning: profileNameWarning, profileSyncNotice, profileSaveState, onRetryProfileSave: retryProfileSave, onFlushProfileSave: flushProfileSync, selfVerified,
                isModerator, onOpenModerationQueue: openModerationQueue,
                isPlatformAdmin, onOpenInkrootEventsAdmin: openInkrootEventsAdmin,
                onOpenManualWithdrawalsAdmin: openManualWithdrawalsAdmin,
                onOpenManageAdmins: openManageAdmins,
                onOpenLinkedProfilesAdmin: openLinkedProfilesAdmin,
                hasLinkedProfiles, onLinkedProfile,
                onOpenGuildEventJudging: openGuildEventJudging,
                onBack: () => nav.pop(), onOpenProjectHall: (id) => openProject(id, 'achievements'),
                guildReputation: writerReputation, writerGuildName: authorHallGuildName,
                onOpenCreatorDashboard: openCreatorDashboard, onRead: openReaderBook,
            }));
    }
    return React.createElement("div", { key: "home", className: "ink-page-in" },
        React.createElement(HomeScreen, { projects: projects, publishedProjects: publishedProjects, onOpen: (id, tab) => openProject(id, tab || 'hub'), onReadBook: openReaderBook, onOpenHealth: (id) => openProject(id, 'health'), onOpenPacks: (id) => openProject(id, 'packs'), onCreate: handleCreate, onDelete: handleDelete, onExportAll: handleExportAll, onImportFile: handleImportFile, onOptimizeAll: handleOptimizeAllStorage, writerProfile: writerProfile, onOpenProfile: openProfile, writerRank: writerRank, writerReputation: writerReputation, guildProfile: guildProfile, isPlatformAdmin: isPlatformAdmin, onJoinFounderGuild: joinFounderGuild, onLeaveGuild: leaveCurrentGuild, onEnterOwnGuild: enterOwnGuild, onSaveOwnGuild: saveOwnGuild, onJoinGuildByCode: joinGuildByCode, joinCodeError: joinCodeError, lifetimeStats: lifetimeStats, onReputationChange: setWriterReputation, onSetPublishStatus: setPublishStatus, onSetPackPublishStatus: setPackPublishStatus, onPublishBookWithDetails: publishBookWithDetails, onPublishPackWithDetails: publishPackWithDetails, activeTab: homeActiveTab, setActiveTab: setHomeActiveTab, onOpenAuthor: openAuthorHall, onOpenGuild: openGuildProfile, onOpenEvent: openGuildEvent, libraryInitialMode: libraryInitialMode }),
        publishNotice && React.createElement(AlertDialog, { title: publishNotice.title, message: publishNotice.message, onClose: () => setPublishNotice(null) }),
        guildLeaveNotice && React.createElement(AlertDialog, { title: guildLeaveNotice.title, message: guildLeaveNotice.message, onClose: () => setGuildLeaveNotice(null) }),
        guildJoinNotice && React.createElement(AlertDialog, { title: guildJoinNotice.title, message: guildJoinNotice.message, onClose: () => setGuildJoinNotice(null) }),
        // closeLabel doubles as the retry action here (see retryOwnGuildSync) rather than a
        // plain dismiss — leaving this unresolved is exactly the state that used to show up
        // downstream as a confusing "Only the guild owner can…" error, so there's no reason to
        // let it sit dismissed without at least one more attempt.
        guildSyncNotice && React.createElement(AlertDialog, { title: guildSyncNotice.title, message: guildSyncNotice.message, closeLabel: 'Try again', onClose: retryOwnGuildSync }));
}
