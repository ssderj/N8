// F3: safety net for a missed Paystack webhook. Called every 15 minutes by pg_cron (migration 199),
// authenticated with a shared secret (deploy with --no-verify-jwt, like paystack-webhook). For each
// payment still 'pending' after 5 minutes (and younger than 48 hours) it asks Paystack what really
// happened. If Paystack says 'success', it hands a signed charge.success event to paystack-webhook,
// so the grant, the over-limit handling and the amount check all run through the one existing code
// path — nothing here writes a payment status itself. Anything else (abandoned, failed, unknown) is
// left alone. A payment held for an amount mismatch is skipped until a human approves it (see
// migration 198).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const MIN_AGE_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_REFS = 50;
const DEADLINE_MS = 100_000;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function alertOps(tag: string, detail: Record<string, unknown>) {
  console.error(tag, JSON.stringify(detail));
  try {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_CHAT_ID');
    if (!token || !chatId) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `\u26a0\ufe0f ${tag}\n${JSON.stringify(detail)}` }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('paystack-reconcile: alert delivery failed', String(e));
  }
}

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(Deno.env.get('PAYSTACK_SECRET_KEY')!),
    { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const secret = Deno.env.get('RECONCILE_SECRET');
  if (!secret || !Deno.env.get('PAYSTACK_SECRET_KEY')) {
    console.error('paystack-reconcile: RECONCILE_SECRET or PAYSTACK_SECRET_KEY is not set');
    return new Response('Server error', { status: 500 });
  }
  if (!timingSafeEqual(req.headers.get('x-reconcile-secret') ?? '', secret)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const started = Date.now();
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const olderThan = new Date(Date.now() - MIN_AGE_MS).toISOString();
  const newerThan = new Date(Date.now() - MAX_AGE_MS).toISOString();

  // Same status rules as the webhook: purchases and hosting fees accept a late success on a 'failed'
  // row too, but only once a human has approved a held one; an event entry is only ever 'pending'.
  const sources: Array<{ table: string; approvedStatuses: string[] }> = [
    { table: 'purchases', approvedStatuses: ['pending', 'failed'] },
    { table: 'guild_event_entries', approvedStatuses: ['pending'] },
    { table: 'guild_event_hosting_fee_payments', approvedStatuses: ['pending', 'failed'] },
  ];
  const refs = new Set<string>();
  try {
    for (const s of sources) {
      const fresh: any = await db.from(s.table).select('paystack_reference')
        .eq('status', 'pending').is('amount_mismatch_at', null)
        .lt('created_at', olderThan).gt('created_at', newerThan)
        .order('created_at', { ascending: true }).limit(MAX_REFS);
      if (fresh.error) throw new Error(`${s.table}: ${fresh.error.message}`);
      const approved: any = await db.from(s.table).select('paystack_reference')
        .in('status', s.approvedStatuses).not('amount_mismatch_approved_at', 'is', null).limit(MAX_REFS);
      if (approved.error) throw new Error(`${s.table} approved: ${approved.error.message}`);
      for (const r of [...(fresh.data ?? []), ...(approved.data ?? [])]) {
        if (r.paystack_reference) refs.add(r.paystack_reference);
      }
    }
  } catch (e) {
    console.error('paystack-reconcile: could not list pending payments', String(e));
    return new Response('Server error', { status: 500 });
  }

  const summary = { checked: 0, applied: 0, held: 0, not_success: 0, errors: 0, skipped_deadline: 0 };
  const webhookUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/paystack-webhook`;

  for (const reference of [...refs].slice(0, MAX_REFS)) {
    if (Date.now() - started > DEADLINE_MS) { summary.skipped_deadline++; continue; }
    summary.checked++;
    try {
      const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${Deno.env.get('PAYSTACK_SECRET_KEY')}` },
        signal: AbortSignal.timeout(15000),
      });
      const body: any = await res.json().catch(() => null);
      if (!res.ok && /not found/i.test(String(body?.message || ''))) { summary.not_success++; continue; }
      if (!res.ok || !body?.data?.status) throw new Error(`verify ${res.status}`);
      if (body.data.status !== 'success' || body.data.reference !== reference) { summary.not_success++; continue; }

      // Paystack itself just told us this payment succeeded, so replay it as a signed charge.success.
      const payload = JSON.stringify({ event: 'charge.success', data: body.data });
      const hook = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-paystack-signature': await sign(payload) },
        body: payload,
        signal: AbortSignal.timeout(20000),
      });
      if (!hook.ok) throw new Error(`webhook ${hook.status}`);
      if ((await hook.text()) === 'held') { summary.held++; continue; } // amount mismatch: webhook already alerted
      summary.applied++;
      await alertOps('PAYSTACK_RECONCILED_MISSED_WEBHOOK', {
        reference, amount: body.data.amount ?? null, currency: body.data.currency ?? null,
      });
    } catch (e) {
      summary.errors++;
      console.error('paystack-reconcile: failed for', reference, String(e));
    }
  }

  console.log('paystack-reconcile', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
