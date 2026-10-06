// purge-storage-queue — removes files queued by purge_expired_account_deletions() (migration 205).
// Why: deleting rows from storage.objects is blocked by Supabase and would leave the real files behind.
// Files must be removed through the Storage API, which this function does with the service key.
//
// Deploy:  supabase functions deploy purge-storage-queue --no-verify-jwt
// Secret:  supabase secrets set PURGE_STORAGE_SECRET=<long random string>
// Run:     POST with header  x-purge-secret: <that string>   (manually, or from a daily cron like migration 199)
// Safe to run any time: it only touches rows in storage_deletion_queue, 100 files per call, and a file is
// forgotten from the queue only after the Storage API confirmed it was removed.

import { createClient } from 'jsr:@supabase/supabase-js@2';

// Constant-time comparison, same as paystack-reconcile: a plain !== leaks (via timing) how many leading
// characters of a guess were right.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const secret = Deno.env.get('PURGE_STORAGE_SECRET');
  if (!secret) return json({ error: 'Not configured' }, 500);
  if (!timingSafeEqual(req.headers.get('x-purge-secret') ?? '', secret)) return json({ error: 'Not authorized' }, 401);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: rows, error } = await db
    .from('storage_deletion_queue')
    .select('bucket_id, name')
    .order('queued_at', { ascending: true })
    .limit(100);
  if (error) return json({ error: error.message }, 500);
  if (!rows || rows.length === 0) return json({ removed: 0, remaining: 0 });

  const byBucket = new Map<string, string[]>();
  for (const r of rows) byBucket.set(r.bucket_id, [...(byBucket.get(r.bucket_id) ?? []), r.name]);

  let removed = 0;
  const failed: string[] = [];
  for (const [bucket, names] of byBucket) {
    const { error: rmErr } = await db.storage.from(bucket).remove(names);
    if (rmErr) { failed.push(`${bucket}: ${rmErr.message}`); continue; }
    const { error: delErr } = await db.from('storage_deletion_queue').delete().eq('bucket_id', bucket).in('name', names);
    if (delErr) { failed.push(`${bucket} queue cleanup: ${delErr.message}`); continue; }
    removed += names.length;
  }
  const { count } = await db.from('storage_deletion_queue').select('*', { count: 'exact', head: true });
  return json({ removed, remaining: count ?? 0, failed });
});
