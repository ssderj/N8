import { supabase, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// The Living Universe Feed's real backend (migration 84, fix-tracker item 19) — same thin
// client-wrapper shape as lib/notifications.js: one RPC call, rows already enriched
// server-side (author/reviewer/follower/joiner names, book titles) so the caller never needs a
// second round-trip per row.
//
// Public — no auth.uid() filtering happens here or in the function itself, unlike
// fetchNotifications(). Every source table this reads is already publicly readable in full (see
// the migration's own header), so this works the same whether or not anyone is signed in.
//
// Migration 213: this public feed now carries only 'release' and 'guild' rows. Follows and reviews are personal and
// come from fetchMyUniverseActivity() below, scoped to the signed-in owner.
//
// Returns newest-first. `kind` is one of 'release' | 'guild' — see
// inbox-and-living-universe.jsx's luAdaptRealFeedEntry() for how each maps onto the Chronicle
// entry shape ({ id, ts, seal, color, title, sub, tag, kind }) the rest of that screen already
// renders.
export async function fetchLivingUniverseFeed({ limit = 60 } = {}) {
  const { data, error } = await supabase.rpc('list_living_universe_feed', { p_result_limit: limit });
  if (error) throw sanitizeError(error);
  return (data || []).map((row) => ({
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    payload: row.payload || {},
  }));
}

// The signed-in writer's OWN activity: people who started following them and reviews on books they wrote
// (migration 213, list_my_universe_activity). The server derives "me" from the session, so there is nothing to pass
// and nobody else's rows can be asked for. Same row shape as the public feed (kind 'follow' | 'review').
// Returns [] when signed out, and null when the fetch itself failed (so the caller can tell "nothing yet" from
// "couldn't reach it").
export async function fetchMyUniverseActivity({ limit = 30 } = {}) {
  const user = await currentUser();
  if (!user) return [];
  try {
    const { data, error } = await supabase.rpc('list_my_universe_activity', { p_result_limit: limit });
    if (error) throw sanitizeError(error);
    return (data || []).map((row) => ({
      id: row.id,
      kind: row.kind,
      createdAt: row.created_at,
      payload: row.payload || {},
    }));
  } catch (e) {
    console.warn('Inkroot: fetchMyUniverseActivity failed', e);
    return null;
  }
}
