/* Which build of the game this is (match telemetry spec, 2 Oct 2026, 2.1).

   In the repo this always says commit 'dev'. The deploy job in
   .github/workflows/ci.yml rewrites this file with the commit being deployed
   (GITHUB_SHA) and the time, just before uploading the site, so the live game
   knows exactly which commit it is. A commit cannot contain its own SHA, so it
   has to be stamped at deploy rather than written here.

   version is the human label online play writes as game_version; both players
   must be on the same one to play each other. */
export const BUILD = { version: 'fc-online-1', commit: 'dev', builtAt: null };
