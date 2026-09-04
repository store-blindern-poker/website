/* Store Blindern Poker: email the players who have not reported.
 *
 * One organiser presses one button in admin.html and everybody who still
 * owes a final chip count gets a mail with their own numbers in it.
 *
 * WHY THIS IS A SERVER FUNCTION AND NOT A FETCH FROM THE CONSOLE
 *   - The mail provider's API key would otherwise be in a browser tab.
 *   - Member email addresses are admin-only, and admin-only should mean the
 *     server rather than a laptop open on a table in a room of thirty-eight
 *     people. The console only ever sees pseudonyms and counts.
 *   - The recipient list is derived from the night id here, every time.
 *     Nothing accepts a list of people to mail from a client, so a tampered
 *     request cannot turn this into a way of mailing the whole club.
 *
 * AUTHORISATION is checked twice on purpose: the caller's own JWT has to
 * satisfy is_admin() before the service role is used for anything. The
 * service role can read every address in the database, so it is never
 * reached on the strength of a request body alone.
 *
 * Secrets, set with `supabase secrets set` or in the dashboard:
 *   RESEND_API_KEY  the provider key. Absent means this returns a clear
 *                   "no sender configured" rather than pretending to work.
 *   MAIL_FROM       e.g. Store Blindern Poker <nights@storeblindernpoker.org>
 *                   The domain must be verified with the provider first.
 *   SITE_URL        optional, defaults to https://storeblindernpoker.org
 *
 * Swapping provider is the sendOne() function and nothing else.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/* Oslo time, in the words the rest of the club uses. */
function osloWhen(iso: string | null): string {
  if (!iso) return 'tomorrow morning'
  try {
    const d = new Date(iso)
    const t = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d)
    const day = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Oslo', weekday: 'long',
    }).format(d)
    return `${t} on ${day}`
  } catch {
    return 'tomorrow morning'
  }
}

function fmt(n: number): string {
  return n.toLocaleString('en-GB')
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

/* THE ONLY PROVIDER-SPECIFIC CODE. Replace this body to move to Postmark,
 * SendGrid or anything else; nothing above or below it knows the
 * difference. Returns null on success, or a reason. */
async function sendOne(
  apiKey: string, from: string, to: string, subject: string,
  text: string, html: string,
): Promise<string | null> {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  })
  if (r.ok) return null
  let detail = ''
  try {
    const body = await r.json()
    detail = body?.message || body?.error?.message || ''
  } catch { /* a non-JSON error body is still an error */ }
  return `${r.status}${detail ? ': ' + detail : ''}`
}

interface Row {
  member_id: string
  pseudonym: string
  chips_taken: number
  points_if_silent: number
  email: string | null
  reminder_sent_at: string | null
}

function buildMail(row: Row, nightTitle: string, deadline: string, siteUrl: string) {
  const subject = 'Your chips from tonight are not recorded yet'
  const reportUrl = `${siteUrl}/report`

  // The number is the whole point of writing to somebody individually
  // rather than posting a list. Silence is not zero, it is a loss, and
  // saying so plainly is the difference between a nudge and a nag.
  const lines = [
    `Hei ${row.pseudonym},`,
    '',
    `You checked in at ${nightTitle} tonight, but we do not have your final chip count.`,
    '',
    `You took ${fmt(row.chips_taken)} chips. If we do not hear from you before ${deadline}, tonight goes down as zero chips returned, which lands as ${fmt(row.points_if_silent)} points.`,
    '',
    `Report it here: ${reportUrl}`,
    '',
    'If you busted out, say so. It is one tap, and it is still worth doing: the attendance bonus is yours either way.',
    '',
    'Cheers,',
    'Store Blindern Poker',
  ]
  const text = lines.join('\n')

  const html = [
    `<p>Hei ${escapeHtml(row.pseudonym)},</p>`,
    `<p>You checked in at ${escapeHtml(nightTitle)} tonight, but we do not have your final chip count.</p>`,
    `<p>You took <strong>${fmt(row.chips_taken)}</strong> chips. If we do not hear from you before ${escapeHtml(deadline)}, tonight goes down as zero chips returned, which lands as <strong>${fmt(row.points_if_silent)}</strong> points.</p>`,
    `<p><a href="${escapeHtml(reportUrl)}">Report it here</a></p>`,
    '<p>If you busted out, say so. It is one tap, and it is still worth doing: the attendance bonus is yours either way.</p>',
    '<p>Cheers,<br>Store Blindern Poker</p>',
  ].join('\n')

  return { subject, text, html }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const apiKey = Deno.env.get('RESEND_API_KEY') || ''
  const from = Deno.env.get('MAIL_FROM') || ''
  const siteUrl = (Deno.env.get('SITE_URL') || 'https://storeblindernpoker.org').replace(/\/+$/, '')

  const auth = req.headers.get('Authorization') || ''
  if (!auth) return json({ error: 'not signed in' }, 401)

  // 1. The caller, as themselves. is_admin() reads auth.uid(), so this is
  //    the caller's own rights and nothing else.
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  })
  const { data: isAdmin, error: adminErr } = await asCaller.rpc('is_admin')
  if (adminErr) {
    // A caller with no EXECUTE on is_admin errors instead of returning
    // false. The anon role is exactly that, by design, and the gateway lets
    // an anon key through as a valid JWT. That refusal is an ANSWER, not a
    // fault: whoever this is, they are not an organiser. Anything else is a
    // real fault and still says so, because turning every failure into 403
    // would hide a database outage behind a permissions message.
    const code = (adminErr as { code?: string }).code || ''
    if (code === '42501' || /permission denied/i.test(adminErr.message || '')) {
      return json({ error: 'organisers only' }, 403)
    }
    return json({ error: 'could not check your access' }, 500)
  }
  if (!isAdmin) return json({ error: 'organisers only' }, 403)

  let body: { night_id?: string; force?: boolean } = {}
  try { body = await req.json() } catch { /* an empty body is a bad request */ }
  const nightId = String(body.night_id || '')
  if (!/^[0-9a-f-]{36}$/i.test(nightId)) return json({ error: 'night_id is required' }, 400)
  const force = body.force === true

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  const { data: night, error: nightErr } = await admin
    .from('nights')
    .select('id,title,night_no,reports_close_at,deleted_at,attendance_bonus')
    .eq('id', nightId)
    .single()
  if (nightErr || !night) return json({ error: 'no such night' }, 404)
  if (night.deleted_at) return json({ error: 'that night has been removed' }, 400)

  // 2. The recipient list, derived here, from the night id.
  const { data: entries, error: entErr } = await admin
    .from('entries')
    .select('member_id,buyin_chips,rebuy_chips,reported,voided_at,reminder_sent_at')
    .eq('night_id', nightId)
    .eq('reported', false)
    .is('voided_at', null)
  if (entErr) return json({ error: 'could not read the entries' }, 500)

  const memberIds = (entries || []).map((e) => e.member_id)
  if (!memberIds.length) {
    return json({ sent: 0, skipped: 0, no_address: 0, failed: [], message: 'Everybody has reported.' })
  }

  const { data: members } = await admin
    .from('members').select('id,pseudonym').in('id', memberIds)
  const { data: privates } = await admin
    .from('member_private').select('member_id,email').in('member_id', memberIds)

  const bonus = night.attendance_bonus ?? 0
  const nameOf = new Map((members || []).map((m) => [m.id, m.pseudonym]))
  const mailOf = new Map((privates || []).map((p) => [p.member_id, p.email]))

  const RECENT_MS = 30 * 60 * 1000
  const rows: Row[] = []
  let noAddress = 0
  let skipped = 0

  for (const e of entries || []) {
    const email = (mailOf.get(e.member_id) || '').trim()
    if (!email) { noAddress += 1; continue }
    // A second press of the button must not mail everybody twice. Anyone
    // nudged in the last half hour is left alone unless force is set.
    if (!force && e.reminder_sent_at &&
        Date.now() - new Date(e.reminder_sent_at).getTime() < RECENT_MS) {
      skipped += 1
      continue
    }
    const taken = (e.buyin_chips || 0) + (e.rebuy_chips || 0)
    rows.push({
      member_id: e.member_id,
      pseudonym: nameOf.get(e.member_id) || 'player',
      chips_taken: taken,
      points_if_silent: 0 - taken + bonus,
      email,
      reminder_sent_at: e.reminder_sent_at,
    })
  }

  if (!rows.length) {
    return json({
      sent: 0, skipped, no_address: noAddress, failed: [],
      message: skipped
        ? 'Everybody who still owes a number was emailed in the last half hour already.'
        : 'Nobody to email.',
    })
  }

  // Checked AFTER the work above so the console can still show an honest
  // count of who WOULD be mailed once a sender exists.
  if (!apiKey || !from) {
    return json({
      error: 'no_sender',
      would_send: rows.length,
      no_address: noAddress,
      message: 'No mail sender is set up yet, so nothing was sent. Add RESEND_API_KEY and MAIL_FROM to this function\'s secrets.',
    }, 503)
  }

  const nightTitle = night.title || `Night ${night.night_no}`
  const deadline = osloWhen(night.reports_close_at)

  const sentIds: string[] = []
  const failed: { pseudonym: string; reason: string }[] = []

  // One at a time, in sequence. Thirty-eight is a small number and a
  // provider that rate limits a burst would otherwise fail half of them
  // for no reason worth explaining to an organiser.
  for (const row of rows) {
    const mail = buildMail(row, nightTitle, deadline, siteUrl)
    const reason = await sendOne(apiKey, from, row.email!, mail.subject, mail.text, mail.html)
    if (reason === null) sentIds.push(row.member_id)
    else failed.push({ pseudonym: row.pseudonym, reason })
  }

  // Stamped only for mail that actually left, so a failed send is retried
  // by the next press rather than being silently treated as done.
  if (sentIds.length) {
    await admin.rpc('mark_reminded', { p_night_id: nightId, p_member_ids: sentIds })
  }

  return json({
    sent: sentIds.length,
    skipped,
    no_address: noAddress,
    failed,
  })
})
