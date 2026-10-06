import { supabase } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// Terms & Privacy acceptance. The person ticks the box on the sign-in panel (account-sync-control.jsx); because
// Google sign-in leaves the page and comes back, the tick is parked in localStorage and recorded server-side
// (terms_acceptances, via record_terms_acceptance — see supabase/history/218_*) once a session exists.
// The server stamps accepted_at itself; the client never supplies a time.
//
// Bump TERMS_VERSION whenever the Terms or Privacy Policy change in a way people must re-accept: everyone
// then reads as "not accepted" for the new version and is shown the checkbox once.
export const TERMS_VERSION = 'v1';

const PENDING_KEY = 'inkroot:terms:pending';

export function markTermsPending() {
  try { localStorage.setItem(PENDING_KEY, TERMS_VERSION); } catch (_) { /* storage blocked: the signed-in prompt covers it */ }
}

// Returns true (once) if an acceptance was parked before sign-in, and clears it.
export function takePendingTerms() {
  try {
    const v = localStorage.getItem(PENDING_KEY);
    if (v === null) return false;
    localStorage.removeItem(PENDING_KEY);
    return v === TERMS_VERSION;
  } catch (_) { return false; }
}

export async function recordTermsAcceptance() {
  const { error } = await supabase.rpc('record_terms_acceptance', { p_version: TERMS_VERSION });
  if (error) throw sanitizeError(error);
}

// true/false: whether the signed-in person has accepted the CURRENT version. RLS limits this to their own rows.
export async function fetchHasAcceptedTerms() {
  const { data, error } = await supabase.from('terms_acceptances').select('version').eq('version', TERMS_VERSION).maybeSingle();
  if (error) throw sanitizeError(error);
  return !!data;
}
