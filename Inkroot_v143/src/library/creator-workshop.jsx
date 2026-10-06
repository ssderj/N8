import React from 'react';
import { InkIcon } from '../shell/ink-icon.jsx';
import { IdentityPlaque } from '../guild/guild-hall.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { CreatorAvatar, GrandLibraryAtmosphere } from './grand-library-cards.jsx';
import { WRITER_RANKS } from '../writing/health-checks.jsx';


// ---------- My Workshop ----------
// A purely visual re-skin of the old SaaS-card Creator Dashboard: instead of a grid of stat
// cards and a pill tab bar, the writer steps into their own workshop — shelves, a writing desk,
// a worktable, archive cabinets, a merchant counter, candlelight. Every station below is just a
// different-looking button wired to the exact same `tab` state / `onSelect(tab.key)` call the
// old CreatorTabBar pills used — no new routes, no new data, nothing backend-shaped changes here.
// The room itself reuses GrandLibraryAtmosphere (chandelier, window light, dust motes) so it
// shares one consistent "candlelit hall" language with the rest of Inkroot rather than inventing
// a second lighting system.
export const WORKSHOP_STATIONS = [
    { key: 'books', short: 'Books', icon: 'library', family: 'shelf', title: 'Bookshelf & Writing Desk', sub: 'Published Works \u00B7 Drafts' },
    { key: 'packs', short: 'World Packs', icon: 'package', family: 'table', title: 'The Worktable', sub: 'World Packs' },
    { key: 'templates', short: 'Templates', icon: 'puzzle', family: 'archive', title: 'Archive Shelves', sub: 'Templates' },
    { key: 'addons', short: 'Add-ons', icon: 'sparkle', family: 'archive', title: 'Archive Shelves', sub: 'Add-ons' },
    { key: 'earnings', short: 'Earnings', icon: 'coin', family: 'counter', title: 'The Merchant Counter', sub: 'Earnings' },
    { key: 'withdrawals', short: 'Withdrawals', icon: 'cash', family: 'counter', title: 'The Merchant Counter', sub: 'Withdrawals' },
];


// Secondary "ledger" facts — every existing analytics-shaped tab, kept fully intact but folded
// into the compact Creator Insights nook instead of getting equal top billing with the six
// hands-on stations above.
export const WORKSHOP_INSIGHT_TABS = [
    { key: 'analytics', icon: 'chart', label: 'Analytics' },
    { key: 'ratings', icon: 'star', label: 'Ratings' },
    { key: 'readers', icon: 'users', label: 'Readers' },
    { key: 'referrals', icon: 'gift', label: 'Referrals' },
];


export function CreatorWorkshopStyles() {
    return React.createElement("style", null, `
      /* The six stations: a 3 x 2 grid of tiles on a phone (all six visible, no sideways scroll), one row of
         six once there's room. Icon over a short label; the long furniture names live in the panel header. */
      .cw-scene-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      @media (min-width: 720px) { .cw-scene-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
      .cw-station {
        position: relative; cursor: pointer; font-family: inherit; text-align: center;
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
        min-height: 72px; padding: 10px 6px; border-radius: 12px; border: 1px solid #3A3020;
        background: linear-gradient(180deg, #2A2115 0%, #1E170D 55%, #17110A 100%);
        box-shadow: inset 0 1px 0 rgba(232,196,104,0.08);
        transition: border-color var(--ink-dur) var(--ink-ease), background var(--ink-dur) var(--ink-ease);
      }
      .cw-station:hover { border-color: #4A3D22; }
      .cw-station.active { border-color: #C89B3C; background: linear-gradient(180deg, #33281A, #241B10); }
      .cw-station-label { font-size: 12.5px; font-weight: 600; color: #B5B0A5; line-height: 1.2; }
      .cw-station.active .cw-station-label { color: #F4EEDD; }
      .cw-station-badge {
        position: absolute; top: 6px; right: 8px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
        background: linear-gradient(160deg, #E8C468, #C89B3C); color: #17130E; font-size: 12px; font-weight: 700;
        display: flex; align-items: center; justify-content: center;
      }

      .cw-surface {
        position: relative; margin-top: 16px; border-radius: 16px; padding: 20px 18px;
        background: #16161A;
        border: 1px solid #3A3020;
        color: #EFE7D2;
      }
      .cw-surface::before {
        content: ''; position: absolute; left: 0; right: 0; top: 0; height: 6px; border-radius: 16px 16px 0 0;
        background: linear-gradient(180deg, #5C3F26, #3A2814);
      }
      .cw-surface-header {
        display: flex; align-items: center; gap: 10px; margin-bottom: 14px; padding-bottom: 12px;
        border-bottom: 1px solid #3A3020;
      }
      .cw-surface-header-icon {
        width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
        background: linear-gradient(160deg, #3A2F1C, #241E12); color: #E8C468; border: 1px solid #4A3D22;
      }
      .cw-surface-header-title { font-family: 'Fraunces', Georgia, serif; font-size: 15px; font-weight: 600; color: #EFE7D2; }
      .cw-surface-header-sub { font-size: 13px; color: #A39C8C; margin-top: 1px; }

      .cw-insights {
        margin-top: 22px; border-radius: 14px; border: 1px dashed #3A3020; padding: 14px 16px 16px;
        background: linear-gradient(180deg, #1C170F, #141009);
      }
      .cw-insights-toggle {
        width: 100%; display: flex; align-items: center; gap: 9px; background: none; border: none; cursor: pointer;
        padding: 0; font-family: inherit; color: inherit; text-align: left;
      }
      .cw-insights-toggle-icon {
        width: 26px; height: 26px; border-radius: 7px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
        background: rgba(232,196,104,0.08); border: 1px solid #3A3020; color: #C89B3C;
      }
      .cw-insights-title { font-family: 'Fraunces', Georgia, serif; font-size: 13.5px; font-weight: 600; color: #C9BE8D; }
      .cw-insights-caption { font-size: 12px; color: #8A8A92; margin-top: 1px; }
      .cw-insights-chevron { margin-left: auto; color: #8A8A92; font-size: 12px; transition: transform var(--ink-dur) var(--ink-ease); flex-shrink: 0; }
      .cw-insights-chevron.open { transform: rotate(180deg); }
      .cw-insights-stats {
        display: flex; gap: 16px; flex-wrap: wrap; margin-top: 14px; padding-top: 14px; border-top: 1px solid #2A2417;
      }
      .cw-insights-stat { display: flex; align-items: center; gap: 6px; }
      .cw-insights-stat-icon { color: #8A8A92; display: flex; }
      .cw-insights-stat-value { font-family: 'Fraunces', Georgia, serif; font-size: 13px; font-weight: 600; color: #C9BE8D; }
      .cw-insights-stat-label { font-size: 12px; letter-spacing: 0.05em; text-transform: uppercase; color: #84848C; margin-left: 3px; }
      .cw-insights-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
      .cw-insights-body { margin-top: 14px; padding-top: 14px; border-top: 1px solid #2A2417; }
    `);
}


// The workshop nameplate up top: same avatar + Rank/Reputation plaques the old
// CreatorDashboardHeader showed (so a writer's standing still reads identically everywhere),
// just framed as a hanging sign over the workshop door instead of a SaaS header bar.
export function CreatorWorkshopHeader({ profile, rank, reputation }) {
    const name = (profile && (profile.penName || profile.name)) || 'Unnamed Writer';
    const rk = rank || WRITER_RANKS[0];
    const hasReputation = reputation !== null && reputation !== undefined;
    return React.createElement("div", { style: {
            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[16], flexWrap: 'wrap',
            background: 'radial-gradient(ellipse at 50% 0%, rgba(200,155,60,0.14), transparent 65%), linear-gradient(160deg, #241D12, #171209)',
            border: '1px solid #4A3D22', borderRadius: RADIUS_SCALE[16], padding: '18px 20px', marginBottom: 16,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 26px rgba(0,0,0,0.32)',
        } },
        React.createElement(CreatorAvatar, { avatar: profile && profile.avatar, size: 52 }),
        React.createElement("div", { style: { flex: '1 1 160px', minWidth: 0 } },
            React.createElement("div", { style: {
                    fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[20], fontWeight: 600, color: '#EFE7D2',
                } }, "My Workshop"),
            React.createElement("div", { style: {
                    fontSize: TYPE_SCALE[13], color: '#A6926A', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                } }, name, "\u2019s creative hall")),
        React.createElement("div", { style: { display: 'flex', alignItems: 'stretch', gap: SPACE_SCALE[4], flex: '2 1 260px', minWidth: 0 } },
            React.createElement(IdentityPlaque, { icon: rk.icon, label: "Rank", value: rk.name, valueColor: rk.color }),
            // Reputation only appears once there is a real number; "\u2014 / not yet chronicled" was dead space.
            hasReputation && React.createElement("div", { style: { width: 1, background: '#2E2818', margin: '2px 0' } }),
            hasReputation && React.createElement(IdentityPlaque, { icon: "hourglass", label: "Reputation", value: reputation, valueColor: '#8A8A92' })));
}


// One clickable furniture station. Wired to the exact same activeTab/onSelect contract the old
// CreatorTabBar pills used -- onSelect(t.key) is a plain setTab(key) call one level up.
function WorkshopStation({ station, active, badge, onSelect }) {
    return React.createElement("button", {
        className: `cw-station${active ? ' active' : ''}`, "aria-pressed": active, onClick: () => onSelect(station.key),
    },
        badge !== undefined && badge !== null && badge > 0 && React.createElement("span", { className: "cw-station-badge" }, badge),
        React.createElement(InkIcon, { name: station.icon, size: 22, color: active ? '#E8C468' : '#A39C8C' }),
        React.createElement("span", { className: "cw-station-label" }, station.short || station.sub));
}


// The room itself: candlelight, window glow and drifting dust (via GrandLibraryAtmosphere,
// unchanged) behind the six hands-on stations. Every station maps 1:1 onto an existing
// Creator Studio tab -- clicking one is exactly the old tab-pill click, just dressed as walking
// up to a piece of furniture.
export function CreatorWorkshopScene({ activeTab, onSelect, publishedBooksCount, publishedPacksCount }) {
    const badges = { books: publishedBooksCount, packs: publishedPacksCount };
    return React.createElement(GrandLibraryAtmosphere, null,
        React.createElement("div", { className: "cw-scene-grid" },
            WORKSHOP_STATIONS.map((s) => React.createElement(WorkshopStation, {
                key: s.key, station: s, active: activeTab === s.key, badge: badges[s.key], onSelect,
            }))));
}


// The parchment "surface" that the currently-selected station's real content is laid out on --
// same body content the old plain tab body rendered, just framed as a page pinned to the desk/
// worktable/counter instead of floating on a bare dark background.
export function CreatorWorkshopSurface({ station, children }) {
    return React.createElement("div", { className: "cw-surface" },
        station && React.createElement("div", { className: "cw-surface-header" },
            React.createElement("div", { className: "cw-surface-header-icon" }, React.createElement(InkIcon, { name: station.icon, size: 15 })),
            React.createElement("div", null,
                React.createElement("div", { className: "cw-surface-header-title" }, station.title),
                React.createElement("div", { className: "cw-surface-header-sub" }, station.sub))),
        children);
}


// One compact figure in the Insights strip -- the same honest "\u2014 / not tracked yet" values
// the old CreatorOverviewRow cards showed, just sized to sit quietly in a footer row instead of
// dominating the top of the screen.
function InsightStat({ icon, value, label }) {
    return React.createElement("div", { className: "cw-insights-stat" },
        React.createElement("span", { className: "cw-insights-stat-icon" }, icon),
        React.createElement("span", { className: "cw-insights-stat-value" }, value),
        React.createElement("span", { className: "cw-insights-stat-label" }, label));
}


// The Creator Insights nook: every ratings/readers/referrals/analytics/sales/revenue figure the
// old dashboard tracked, still fully present and fully real -- just folded into one collapsible
// ledger-book section below the workshop instead of top billing. Expanding it and picking a tab
// calls the exact same onSelect(tab.key) the six stations above do; `panel` is the same `body`
// element the parent already computed for that tab.
export function CreatorInsightsSection({ activeTab, onSelect, open, onToggleOpen, publishedWorksCount, panel }) {
    const activeInsightTab = WORKSHOP_INSIGHT_TABS.find((t) => t.key === activeTab);
    return React.createElement("div", { className: "cw-insights" },
        React.createElement("button", { className: "cw-insights-toggle", onClick: onToggleOpen },
            React.createElement("div", { className: "cw-insights-toggle-icon" }, React.createElement(InkIcon, { name: "chart", size: 14 })),
            React.createElement("div", null,
                React.createElement("div", { className: "cw-insights-title" }, "Creator Insights"),
                React.createElement("div", { className: "cw-insights-caption" }, "Ratings \u00B7 readers \u00B7 referrals \u00B7 sales & revenue")),
            React.createElement("span", { className: `cw-insights-chevron${open ? ' open' : ''}` }, "\u25BC")),
        open && React.createElement(React.Fragment, null,
            React.createElement("div", { className: "cw-insights-stats" },
                React.createElement(InsightStat, { icon: React.createElement(InkIcon, { name: "library", size: 13 }), value: publishedWorksCount, label: "Published Works" })),
            React.createElement("div", { className: "cw-insights-tabs" },
                WORKSHOP_INSIGHT_TABS.map((t) => React.createElement("button", {
                    key: t.key, className: `cd-tab-btn${activeTab === t.key ? ' active' : ''}`, onClick: () => onSelect(t.key),
                }, React.createElement(InkIcon, { name: t.icon, size: 12, style: { display: 'inline-block', verticalAlign: '-2px', marginRight: 4 } }), t.label))),
            activeInsightTab && panel && React.createElement("div", { className: "cw-insights-body" }, panel)));
}
