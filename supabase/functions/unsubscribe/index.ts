/* Store Blindern Poker: stop sending club announcements to one member.
 *
 * PUBLIC ON PURPOSE (verify_jwt is false). Somebody who wants out of a
 * mailing list must not have to sign in to a poker website to get out of it,
 * and the member who most wants out is exactly the one who never made an
 * account password they remember.
 *
 * The token is a bearer capability: whoever holds it can unsubscribe that one
 * member and do nothing else. It is a random uuid, never the member id, so a
 * link that leaks in a forwarded email cannot be turned into a lookup of who
 * that person is. This endpoint deliberately answers the SAME way for a good
 * token and a bad one, so it cannot be used to test whether a token is real.
 *
 * POST ONLY, and that is the whole defence against the classic bug here.
 * Corporate mail scanners and link-preview bots fetch every URL in an email,
 * so an unsubscribe that acts on GET silently unsubscribes people who never
 * clicked anything. The visible link in the mail goes to unsubscribe.html on
 * the site, which shows a button; the button POSTs here. Gmail's own
 * one-click unsubscribe also POSTs, via the List-Unsubscribe-Post header, so
 * that path works without a second page.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  // A GET is either a scanner or somebody pasting the link by hand. Neither
  // should change anything, so say what to do and change nothing.
  if (req.method === 'GET') {
    return json({ message: 'Open the unsubscribe link from your email and press the button there.' }, 405)
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  // The token arrives as ?t= from our own page, or in the body. Gmail's
  // one-click posts a form body of its own and keeps the query string, so
  // reading the query first covers both.
  const url = new URL(req.url)
  let token = url.searchParams.get('t') || ''
  if (!token) {
    try {
      const body = await req.json()
      token = String(body?.token || '')
    } catch { /* a form post from a mail client has no JSON body, which is fine */ }
  }

  // Shape-check before touching the database, so a junk value never becomes a query.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    // Same answer as an unknown token. See the note about probing above.
    return json({ ok: true })
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  // No select first, and nothing about the member is returned. The caller
  // learns only that the request was accepted, never whether the token
  // matched anybody or whose address it belongs to.
  const { error } = await admin
    .from('member_private')
    .update({ email_opt_out: true })
    .eq('unsubscribe_token', token)

  if (error) return json({ error: 'could not save that, please email it@storeblindernpoker.org' }, 500)
  return json({ ok: true })
})
