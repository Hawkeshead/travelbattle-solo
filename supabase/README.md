# Online play database

Supabase project `field-command` (London, free plan). Created and managed
through the Supabase connector; the schema below is the source of truth for
what was applied.

`public.matches` holds one row per match: who sits on each side, the status,
the game version both phones must match, whose turn it is, an action counter
and the latest full battle snapshot. Only the two players in a match can read
or update it. Nobody else can see it exists.

`create_match(side, name, version)` and `join_match(code, name, version)` are
the only ways to take a seat. Joining goes through a function because the
joiner cannot read the row until they are in it. Codes are six characters
without 0/O or 1/I.

Live moves travel on private Realtime channels named `match:<id>`, using
Broadcast for actions and Presence for who is online. Policies on
`realtime.messages` admit only that match's two players, to send or receive.

`public.heartbeat` and `keepalive()` exist only so the GitHub workflow
`supabase-keepalive.yml` can stop the free project pausing after 7 idle days.

Verified on creation, as four simulated users in a rolled-back transaction:
the creator sees their match, the invitee sees nothing until joining with the
code and then sees it, and a stranger sees nothing throughout.
