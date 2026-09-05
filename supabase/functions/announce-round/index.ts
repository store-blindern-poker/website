/* Store Blindern Poker: tell this semester's players the next round is open.
 *
 * WHO GETS IT: everybody with an entry in ANY night of the CURRENT SEASON,
 * including the Welcome Round and one-off side events. Somebody whose only
 * night was the welcome is exactly the person worth inviting back. Because
 * the list is derived from season_id every time it is sent, it resets itself
 * each semester and there is no list anywhere to forget to clear.
 *
 * The same two rules as the reminder in notify-unreported: the console never
 * sees an address, and the recipient list is derived here from the night id
 * rather than accepted from a client, so a tampered request cannot turn this
 * into a way of mailing the whole world.
 *
 * WHERE THIS DIFFERS: the reminder is transactional, one person, about their
 * own night, and it ignores the opt-out because going quiet on "your night is
 * about to be recorded as a loss" would cost that person points. This is an
 * announcement to the whole room, so it SKIPS anyone who has opted out and
 * carries an unsubscribe link and the List-Unsubscribe headers that let a
 * mail client offer its own unsubscribe button.
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

/* THE ONLY PROVIDER-SPECIFIC CODE, same shape as the reminder's. The headers
 * argument is what carries List-Unsubscribe, which is per recipient because
 * every member's token is their own. */
async function sendOne(
  apiKey: string, from: string, to: string, subject: string,
  text: string, html: string, headers: Record<string, string>,
): Promise<string | null> {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, text, html, headers }),
  })
  if (r.ok) return null
  let detail = ''
  try {
    const body = await r.json()
    detail = body?.message || body?.error?.message || ''
  } catch { /* a non-JSON error body is still an error */ }
  return `${r.status}${detail ? ': ' + detail : ''}`
}

interface Person {
  member_id: string
  pseudonym: string
  email: string
  token: string
}

function buildMail(p: Person, nightTitle: string, siteUrl: string) {
  const subject = `Registration is open for ${nightTitle}`
  const seatUrl = `${siteUrl}/events`
  const stopUrl = `${siteUrl}/unsubscribe?t=${p.token}`

  const text = [
    `Hei ${p.pseudonym},`,
    '',
    'Thanks for being a member of our community.',
    '',
    'You have already played in this semester\'s tournament, so we are letting you know that registration for the next round is now open.',
    '',
    'Follow the link to save your seat at the table:',
    seatUrl,
    '',
    'Hope to see you there \u{1F642}',
    '',
    'Store Blindern Poker',
    '',
    'If you would rather not get these, unsubscribe here:',
    stopUrl,
  ].join('\n')

  const html = [
    `<p>Hei ${escapeHtml(p.pseudonym)},</p>`,
    '<p>Thanks for being a member of our community.</p>',
    "<p>You have already played in this semester's tournament, so we are letting you know that registration for the next round is now open.</p>",
    `<p><a href="${escapeHtml(seatUrl)}">Follow the link to save your seat at the table</a></p>`,
    '<p>Hope to see you there \u{1F642}</p>',
    '<p>Store Blindern Poker</p>',
    `<p style="color:#777;font-size:12px">If you would rather not get these, <a href="${escapeHtml(stopUrl)}" style="color:#777">unsubscribe here</a>.</p>`,
  ].join('\n')

  return { subject, text, html, stopUrl }
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
  const fnBase = `${url}/functions/v1`

  const auth = req.headers.get('Authorization') || ''
  if (!auth) return json({ error: 'not signed in' }, 401)

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  })
  const { data: isAdmin, error: adminErr } = await asCaller.rpc('is_admin')
  if (adminErr) {
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
    .select('id,title,night_no,season_id,status,counts_as_round,deleted_at,announced_at')
    .eq('id', nightId)
    .single()
  if (nightErr || !night) return json({ error: 'no such night' }, 404)
  if (night.deleted_at) return json({ error: 'that night has been removed' }, 400)
  if (night.status === 'settled' || night.status === 'void') {
    return json({ error: 'that night is already over' }, 400)
  }
  // Deliberately NOT gated on counts_as_round any more. The audience is
  // everybody who played ANY night this semester, the Welcome Round and side
  // events included, so refusing to announce those same kinds of night was an
  // arbitrary line: the people it would invite are already on the list.
  //
  // What IS enforced is the season, and that is the guard that matters. The
  // recipient list is built from this night's season_id, so pointing this at a
  // night from a finished semester would mail that semester's roster about a
  // round they cannot play. Checked here and not only in the console, because
  // the console is a browser and browsers are not a security boundary.
  const { data: season } = await admin
    .from('seasons').select('id,is_current').eq('id', night.season_id).single()
  if (!season || !season.is_current) {
    return json({ error: 'that night belongs to a season that is over' }, 400)
  }
  // Announcing twice would mail forty people twice. Deliberate re-sends go
  // through force, which the console asks about in plain words.
  if (night.announced_at && !force) {
    return json({
      error: 'already_announced',
      announced_at: night.announced_at,
      message: 'This round was already announced. Send it again only if you meant to.',
    }, 409)
  }

  // The season is read from the night, never from the request, so this cannot
  // be pointed at another semester's players.
  const { data: seasonNights } = await admin
    .from('nights').select('id').eq('season_id', night.season_id).is('deleted_at', null)
  const nightIds = (seasonNights || []).map((n) => n.id)
  if (!nightIds.length) return json({ sent: 0, no_address: 0, opted_out: 0, failed: [], message: 'No nights this season.' })

  const { data: entries } = await admin
    .from('entries').select('member_id').in('night_id', nightIds).is('voided_at', null)
  const memberIds = Array.from(new Set((entries || []).map((e) => e.member_id)))
  if (!memberIds.length) {
    return json({ sent: 0, no_address: 0, opted_out: 0, failed: [], message: 'Nobody has played yet this season.' })
  }

  const { data: members } = await admin
    .from('members').select('id,pseudonym').in('id', memberIds).is('deleted_at', null)
  const { data: privates } = await admin
    .from('member_private')
    .select('member_id,email,email_opt_out,unsubscribe_token')
    .in('member_id', memberIds)

  const privOf = new Map((privates || []).map((p) => [p.member_id, p]))
  const people: Person[] = []
  let noAddress = 0
  let optedOut = 0

  for (const m of members || []) {
    const p = privOf.get(m.id)
    const email = (p?.email || '').trim()
    if (p?.email_opt_out) { optedOut += 1; continue }
    if (!email) { noAddress += 1; continue }
    people.push({
      member_id: m.id,
      pseudonym: m.pseudonym,
      email,
      token: p!.unsubscribe_token,
    })
  }

  if (!people.length) {
    return json({ sent: 0, no_address: noAddress, opted_out: optedOut, failed: [], message: 'Nobody to email.' })
  }

  // Checked AFTER the work above so the console can still show an honest
  // count of who WOULD be mailed once a sender exists.
  if (!apiKey || !from) {
    return json({
      error: 'no_sender',
      would_send: people.length,
      no_address: noAddress,
      opted_out: optedOut,
      message: 'No mail sender is set up yet, so nothing was sent. ' + people.length + ' would have been emailed.',
    }, 503)
  }

  const nightTitle = night.title || `Round ${night.night_no}`
  const sentIds: string[] = []
  const failed: { pseudonym: string; reason: string }[] = []

  for (const person of people) {
    const mail = buildMail(person, nightTitle, siteUrl)
    // List-Unsubscribe gives Gmail and Outlook their own unsubscribe button,
    // which is what stops a member reaching for "report spam" instead. The
    // One-Click variant posts straight to the function, so it must be the
    // function URL and not the friendly page, which only renders a button.
    const reason = await sendOne(apiKey, from, person.email, mail.subject, mail.text, mail.html, {
      'List-Unsubscribe': `<${fnBase}/unsubscribe?t=${person.token}>, <mailto:it@storeblindernpoker.org?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
    if (reason === null) sentIds.push(person.member_id)
    else failed.push({ pseudonym: person.pseudonym, reason })
  }

  if (sentIds.length) {
    await admin.rpc('mark_announced', { p_night_id: nightId })
  }

  return json({
    sent: sentIds.length,
    no_address: noAddress,
    opted_out: optedOut,
    failed,
  })
})
