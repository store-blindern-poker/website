# Running a night

Print this. Keep it in the chip box. It assumes nothing except that you can sign in.

Nights run Fridays, 18:00 to 20:30. Reporting stays open until 09:00 the next morning,
so nothing has to be finished in the room.

---

## Before you leave home

1. Sign in at **storeblindernpoker.org/admin**. If it says "Organisers only", you are on the
   wrong account.
2. Find tonight in the **Nights** list. Check the status pill.
3. Press **Open night**. The pill must change to **OPEN**.
   **If you forget this, nobody can check in and the night stops before it starts.**
4. Press **Display code**. A full-screen QR and a 5-character code appear. That is what goes
   on the TV.
5. Glance at **stack size** and **attendance bonus** in the night row. Normally
   `10,000` and `5,000`. Lower the stack only if there are not enough chips, and do it now,
   not after people have checked in.

## At the doors

- Put the code on the TV, or on a printed sheet by the door.
- Players scan the QR or type the code. They show you a slip that says
  **GIVE (their name) N CHIPS**. Read the number off their screen and count out that many.
  It is usually 10,000, but not always: a short-stacked player gets less, and the slip is
  right, your habit is wrong.
- **Somebody cannot sign up?** Do not fight it. Take their pseudonym on paper and use
  **Report on behalf** later. They can create their account any time afterwards, claim the
  same pseudonym, and their points will be waiting. This is tested and works.
- **Somebody has no phone at all?** Same answer. Paper, then proxy.

## During the night

- Top-ups: the player shows a **TOP-UP** slip with a number. Count out that many chips.
  A slip marked **RE-SHOW** in red is an old one being shown again, not a new top-up.
- One top-up per player per night. The app enforces it; you do not have to remember.
- The paper sheet on each table is the real backup. Keep it up to date even when the app
  is working. It costs nothing and it has saved every club that ever did it.

## At the end

1. Watch the **Not reported yet** block. It is the loudest thing on the page for a reason.
2. Walk that list out loud before anyone leaves. For each name, either they report on their
   phone, or you type it in with **Report on behalf**.
3. **Check their phone actually said "Sent".** If it still says *Sending* or *Saved on this
   phone*, the number has not reached the server. Type it in yourself. Do not assume.
4. Press **Close reporting**. Then **Settle night**.
5. Look at the leaderboard. It should have moved.

Chips not balancing does **not** block settling. It is recorded and shown, and you fix it
during the week. Never hold up 40 people over a 300-chip discrepancy.

---

## When something goes wrong

**A player's name shows as "(unknown member)"**
They claimed their pseudonym after you opened the console. Press **Refresh**. If it is still
wrong, reload the page.

**You settled and then found a wrong number**
Press **Reopen for corrections** first. Fix the entry. Press **Settle night** again.
Editing a settled night without reopening it looks like it worked and changes nothing.

**Two of you are using the console at once**
Do not. One person drives, the other reads the paper sheet aloud. Simultaneous edits to the
same player silently overwrite each other.

**Someone cannot sign in, or gets an error about too many attempts**
The signup limit is per building, not per person. Wait a minute, or just take them on paper
and proxy them in. Do not let a queue form.

**A phone says "Couldn't send, show this to an organiser"**
It shows the numbers in large type. Type them in with **Report on behalf**. Done.

**The whole site is down**
Run the night entirely on the paper sheets. Nothing is lost: reporting is open until 09:00,
and an organiser can enter every result afterwards. Tell people to go home and check the
leaderboard in the morning. This is a normal outcome, not a disaster.

---

## Site is down: what to check, in order

1. **storeblindernpoker.org does not load at all** → Cloudflare. Check the Pages project is
   deployed and the custom domain is still attached.
2. **Page loads but nothing has data** → Supabase. Check the project is not paused. Free-tier
   projects pause after inactivity, most likely over the summer break. Restore it from the
   dashboard; nothing is lost.
3. **Login fails for everyone, error mentions rate limits** → Supabase, Authentication, Rate
   Limits. Raise the sign up / sign in limits.
4. **A recent change broke it** → Cloudflare Pages, Deployments, find the last good one and
   press **Rollback to this deployment**. Then fix the code properly and push again.

Nobody needs to be woken up for any of this. The paper sheets mean a night is never lost.
