import React from 'react';
import { createRoot } from 'react-dom/client';
import { SyncProvider, useSync } from './shell/sync-context.jsx';
import InkrootApp from './App.jsx';
import { capturePendingReferralCodeFromUrl } from './lib/referrals.js';
import { hasLocalCacheFor, getPulledUserId, getPullFailed, fullResync } from './lib/syncEngine.js';

// Older browsers and some embedded WebViews don't have structuredClone (it only shipped widely
// in 2022) — carried over from the original single-file app's own polyfill, since the app's
// data is all plain JSON and this fallback is safe.
if (typeof structuredClone !== 'function') {
  window.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
}

// As early as possible, before anything else runs — a ?ref= link followed by "Continue with
// Google" sends the browser away and back via a full page redirect, which would otherwise strip
// the query string before sync-context.jsx ever gets a chance to see it. This only ever writes
// to localStorage; the actual redemption call happens later, once there's a real signed-in
// session to redeem it against (see sync-context.jsx).
capturePendingReferralCodeFromUrl();

// Session/auth logic itself now lives in SyncProvider (see shell/sync-context.jsx) so any
// screen inside the app can reach it via useSync() — previously this file rendered a fixed,
// always-on-top "Sync" badge that showed on every single screen regardless of relevance. The
// actual account control now lives only on the Home dashboard (see AccountSyncControl in
// shell/account-sync-control.jsx). SyncGate below preserves the original startup behavior
// exactly: the app doesn't render at all until the initial session check resolves.
// SERVER-TRUTH STEP 1 -- the sign-in gate. Signed out: open at once (local-only mode, as always). Signed in with
// a usable local copy of THIS account's data: open at once and let the background sync refresh it. Signed in
// with NO usable copy (a new device, cleared storage, the Home-Screen app vs Safari): do not open on an empty
// screen -- wait for the first server pull, then open on the real data. If that pull can't complete (offline,
// server down, 20s), say so with a Retry button rather than showing a blank account the writer might then edit.
const gateBox = { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, textAlign: 'center', background: '#17171B', color: '#EFE7D2', fontFamily: "'Inter', system-ui, sans-serif" };
const gateBtn = (primary) => ({ background: primary ? '#C89B3C' : 'transparent', color: primary ? '#17171B' : '#EFE7D2', border: primary ? 'none' : '1px solid #3A3A42', borderRadius: 8, padding: '10px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer' });

// FIX 8 (passkey sign-in flicker) -- signing in with a passkey on a device with no local copy (the normal case after
// a sign-out, which now empties the device) used to flash "Loading your account..." and then swap the whole app in
// with no transition. The gate logic below is unchanged (it is what protects a blank local copy from overwriting the
// real account); only how it LOOKS changed: the loading text fades in after a short delay (a fast pull shows
// nothing but the dark background), says "Signed in." when the person signed in during this page load, and on
// open a copy of the loading screen sits over the app and fades out instead of cutting. The app itself still mounts
// once, exactly as before.
const GATE_CSS = '@keyframes inkrootGateIn{from{opacity:0}to{opacity:1}}@keyframes inkrootGateOut{from{opacity:1}to{opacity:0}}'
  + '.inkroot-gate-in{animation:inkrootGateIn 250ms ease 250ms both}.inkroot-gate-out{animation:inkrootGateOut 300ms ease forwards}'
  + '@media (prefers-reduced-motion: reduce){.inkroot-gate-in,.inkroot-gate-out{animation:none}.inkroot-gate-out{opacity:0}}';

function GateLoading({ signedInNow, cover }) {
  return React.createElement('div', { className: cover ? 'inkroot-gate-out' : undefined, style: cover ? { ...gateBox, position: 'fixed', inset: 0, zIndex: 100001, pointerEvents: 'none' } : gateBox },
    React.createElement('style', null, GATE_CSS),
    React.createElement('div', { className: cover ? undefined : 'inkroot-gate-in', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 } },
      React.createElement('div', { style: { fontSize: 16, fontWeight: 600 } }, signedInNow ? 'Signed in. Loading your account\u2026' : 'Loading your account\u2026'),
      React.createElement('div', { style: { fontSize: 13, color: '#A6A6AD' } }, 'Fetching your profile, guild and books.')));
}

function SyncGate() {
  const sync = useSync();
  const uid = sync && sync.session ? sync.session.user.id : null;
  const [gate, setGate] = React.useState('checking'); // checking | open | loading | failed
  const [attempt, setAttempt] = React.useState(0);
  const [cover, setCover] = React.useState(false); // the fading copy of the loading screen shown right after it
  const gateRef = React.useRef('checking');
  const sawSignedOutRef = React.useRef(false); // true once this page load has opened signed out: a later sign-in is in-session
  const showGate = (next) => {
    if (next === 'open' && gateRef.current === 'loading') setCover(true);
    gateRef.current = next;
    setGate(next);
  };
  React.useEffect(() => {
    if (!cover) return undefined;
    const t = setTimeout(() => setCover(false), 350);
    return () => clearTimeout(t);
  }, [cover]);
  React.useEffect(() => {
    if (!sync.ready) return undefined;
    if (!uid) { sawSignedOutRef.current = true; showGate('open'); return undefined; }
    let cancelled = false;
    let timedOut = false;
    const evaluate = async () => {
      let next;
      if (getPulledUserId() === uid || (await hasLocalCacheFor(uid))) next = 'open';
      else next = (timedOut || getPullFailed()) ? 'failed' : 'loading';
      if (!cancelled) showGate(next);
    };
    evaluate();
    const onEvent = () => { evaluate(); };
    window.addEventListener('inkroot:account-pulled', onEvent);
    window.addEventListener('inkroot:sync-pull-failed', onEvent);
    const timer = setTimeout(() => { timedOut = true; evaluate(); }, 20000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('inkroot:account-pulled', onEvent);
      window.removeEventListener('inkroot:sync-pull-failed', onEvent);
    };
  }, [sync.ready, uid, attempt]);
  if (!sync.ready || gate === 'checking') return null;
  // Always a Fragment with the app first, so the cover appearing or leaving never remounts the app.
  if (gate === 'open') return React.createElement(React.Fragment, null, React.createElement(InkrootApp, null), cover && React.createElement(GateLoading, { signedInNow: sawSignedOutRef.current, cover: true }));
  if (gate === 'loading') return React.createElement(GateLoading, { signedInNow: sawSignedOutRef.current, cover: false });
  return React.createElement('div', { style: gateBox },
    React.createElement('div', { style: { fontSize: 18, fontWeight: 600 } }, "Couldn't load your account."),
    React.createElement('div', { style: { fontSize: 14, color: '#A6A6AD', maxWidth: 360, lineHeight: 1.5 } },
      'Inkroot could not reach the server, and this device has no saved copy of your account yet. Nothing has been lost \u2014 check your connection and try again.'),
    React.createElement('button', { style: gateBtn(true), onClick: () => { showGate('loading'); setAttempt((n) => n + 1); fullResync(); } }, 'Try again'),
    React.createElement('button', { style: gateBtn(false), onClick: () => { sync.signOut(); } }, 'Sign out'));
}

// Production-readiness audit: nothing in the app caught a render-time exception, so any one
// component throwing (fix-tracker item 33 was exactly this — Publish from the Workshop) unmounted
// the entire React tree and left a blank dark screen with no way back. This is the smallest
// possible safety net, not a redesign: it changes nothing while everything renders normally, and
// on a crash shows a plain message with a reload button instead of nothing. Local data is
// untouched either way — everything is in IndexedDB (see lib/storage.js) and the outbox, so a
// reload picks up exactly where the writer left off. Error boundaries have to be class
// components; this one uses React.createElement like the rest of the repo.
// FIX 6 (diagnosis aid) -- the crash screen now also shows WHAT threw, so it can be read on a phone with no
// console: the error message, the first lines of the stack, and the component chain React was rendering. A
// "Copy details" button puts the same text on the clipboard to paste into a chat. Nothing else changed: the
// screen still appears only when a render throws, local data is untouched, and Reload works exactly as before.
// Once the cause is found and fixed, the details block can simply be removed (or hidden behind a tap).
function crashDetailsText(error, componentStack) {
  const lines = [];
  lines.push('Inkroot crash details');
  lines.push('Time: ' + new Date().toISOString());
  try { lines.push('Page: ' + window.location.pathname + window.location.search); } catch (e) { /* ignore */ }
  try { lines.push('Browser: ' + navigator.userAgent); } catch (e) { /* ignore */ }
  lines.push('');
  lines.push('Error: ' + ((error && (error.name ? error.name + ': ' : '') + (error.message || String(error))) || 'unknown'));
  const stack = error && error.stack ? String(error.stack).split('\n').slice(0, 8).join('\n') : '';
  if (stack) { lines.push(''); lines.push('Stack (first lines):'); lines.push(stack); }
  const comp = componentStack ? String(componentStack).split('\n').filter(Boolean).slice(0, 10).join('\n') : '';
  if (comp) { lines.push(''); lines.push('Rendering (innermost first):'); lines.push(comp); }
  return lines.join('\n');
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, error: null, componentStack: '', copied: false };
    this.copyDetails = this.copyDetails.bind(this);
  }
  static getDerivedStateFromError(error) {
    return { failed: true, error };
  }
  componentDidCatch(error, info) {
    const componentStack = (info && info.componentStack) || '';
    console.error('Inkroot: uncaught render error', error, componentStack);
    this.setState({ componentStack });
  }
  copyDetails() {
    const text = crashDetailsText(this.state.error, this.state.componentStack);
    const done = () => this.setState({ copied: true });
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => { this.legacyCopy(text); done(); });
        return;
      }
    } catch (e) { /* fall through to the legacy path */ }
    this.legacyCopy(text);
    done();
  }
  legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* nothing more can be done; the details are still on screen */ }
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const details = crashDetailsText(this.state.error, this.state.componentStack);
    const btn = (primary) => ({
      background: primary ? '#C89B3C' : 'transparent', color: primary ? '#17171B' : '#EFE7D2',
      border: primary ? 'none' : '1px solid #3A3A42', borderRadius: 8,
      padding: '10px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
    });
    return React.createElement('div', {
      style: {
        minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 14, padding: 24, textAlign: 'center', background: '#17171B', color: '#EFE7D2',
        fontFamily: "'Inter', system-ui, sans-serif",
      },
    },
      React.createElement('div', { style: { fontSize: 18, fontWeight: 600 } }, 'Something went wrong.'),
      React.createElement('div', { style: { fontSize: 14, color: '#A6A6AD', maxWidth: 360, lineHeight: 1.5 } },
        'Your saved work is kept on this device. Reload to pick up where you left off.'),
      React.createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' } },
        React.createElement('button', { onClick: () => window.location.reload(), style: btn(true) }, 'Reload'),
        React.createElement('button', { onClick: this.copyDetails, style: btn(false) }, this.state.copied ? 'Copied' : 'Copy details')),
      React.createElement('pre', {
        style: {
          margin: 0, maxWidth: 'min(92vw, 560px)', maxHeight: '38vh', overflow: 'auto', textAlign: 'left',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, lineHeight: 1.45, color: '#A6A6AD',
          background: '#1F1F25', border: '1px solid #2E2E36', borderRadius: 8, padding: 12,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        },
      }, details));
  }
}

createRoot(document.getElementById('root')).render(
  React.createElement(AppErrorBoundary, null,
    React.createElement(SyncProvider, null, React.createElement(SyncGate, null)))
);

