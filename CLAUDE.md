# Listboard - project instructions

## Keep README.md current
Whenever features are added, changed, or removed, update README.md in the same
commit so it accurately describes the app. Check especially the feature
bullets, the "Run it" file table, and the keyboard table.

## Deploys
- The site is GitHub Pages from this repo (listboard.github.io).
- **Never push to main.** Every change goes on a short topically named branch
  (`due-dates`, `mobile-drag`), gets pushed, and lands through a pull request.
  Merging the PR is what publishes.
- Before pushing more commits to an existing PR's branch, check that the PR is
  still open. If it has been merged or closed, branch again from the updated
  main and open a new PR.
- Commits are authored as `dangeratio
  <7716602+dangeratio@users.noreply.github.com>`, set in this repo's local git
  config, so they are attributed to the account rather than to the machine's
  stale global identity.
- Bump the `?v=N` query on the css/js links in index.html on every deploy that
  changes those files (cache busting).

## Conventions
- Plain HTML/CSS/vanilla JS only; no frameworks and no build step. ES5-flavoured
  JS (`var`, `function`), matching the sibling repos.
- The accent is yellow: `#facc15` in dark, `#a16207` in light, because the
  bright yellow is around 1.6:1 on white and unreadable. Anything sitting on the
  accent uses `--accent-ink`, never plain white. **Dark is the default**; light
  is opt-in and stored under `lb-theme`.
- Layout follows the sibling thetricktionary.github.io and
  charactergenerator.github.io shell: a sticky left rail on desktop, a fixed
  bottom bar on phones (≤700px), with the rail's foot collapsing into a More
  sheet. New tabs must work in both, and the bottom bar has room for four
  buttons plus More.
- Every text colour must clear WCAG AA (4.5:1) against what it actually sits on,
  in **both** themes. Check the pairing, not just the token.

## Never lose a user's tasks
There is no server and no account, so a lost task is lost for good. This is the
one kind of bug the project cannot take back, and it has guards rather than
good intentions.

- **A deploy never clears data.** localStorage is scoped to the origin, not to
  any file or `?v=`, and there is no service worker. Do not add one that
  touches storage.
- **Never rename `lb-data`.** A rename orphans every board at once.
- **Never write over what you could not read.** `loadData()` copies an
  unparseable value to `lb-data-rescued` before doing anything else. Keep that
  ordering.
- **Every write is verified.** `storageSet()` reads back what it wrote, and a
  failure surfaces in the toast and on the Settings page rather than passing
  silently. Keep both.
- **Import merges, it never replaces.** An incoming task only overwrites a
  local one when its `updated` stamp is newer, so restoring an old backup can
  never undo today's work. Unknown projects are added, nothing is removed.
- **Destructive actions need a way back.** Deleting a task offers Undo;
  deleting a project keeps its tasks under *No project*; the two Danger zone
  buttons confirm (twice, for Delete everything) and say what cannot be undone.

## Data model
One blob under `lb-data`: `{ schema, projects: [Project], tasks: [Task] }`.
Every task passes through `normalizeTask()` on load and on import, so the rest
of the code can assume the fields exist and are the right type.

- **Status ids are permanent.** `new` / `doing` / `done` are written into
  stored data. Changing a *label* in `STATUSES` is free; changing an *id* is a
  data migration and needs one written.
- `order` is dense within a (project, status) lane and renumbered by
  `moveTask()` on every drop, so it never drifts into fractions.
- Anything that changes a task calls `touch()` so the List page's sort and the
  import merge both stay honest.

## Drag and drop
Pointer events, not HTML5 drag-and-drop, because the HTML5 API never fires for
touch. One code path serves mouse and finger: mouse drags start after 6px of
movement, touch drags after a 380ms long press, and a touch that moves before
the timer fires is treated as a scroll and cancelled. Keep that distinction if
you touch `onPointerDown`/`onPointerMove` - without it, the board becomes
impossible to scroll on a phone.

Cross-lane dragging on a phone only reaches lanes that are actually on screen,
which is why the task drawer's status picker exists. Do not remove it.
