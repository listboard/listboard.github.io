# Listboard

### ▶ [listboard.github.io](https://listboard.github.io)

A kanban board for project tasks that runs entirely in your browser. No
account, no server, no build step: one HTML file, one stylesheet, one script.

Open the link above and start typing; there is nothing to install and nothing
to sign up for.

## What it does

- **Projects.** Each project gets its own board, plus an *All projects* view
  that shows everything at once. Archiving a project hides it without touching
  a single task.
- **Tasks that are just a note.** A note is the only thing a task needs. Title,
  tags, due date and priority are all optional.
- **Three lanes.** New → In progress → Closed, with drag-and-drop between them
  and reordering inside them. Dragging works with a mouse and with a finger
  (long press to pick a card up).
- **Drop things in.** Drag text, a link, an image or a file from anywhere
  onto a lane and it becomes a task there. Text becomes the note (with any
  `#tags` picked out), a link or image becomes its URL, and the link text or
  image alt text becomes the title. Several links at once become several
  tasks.
- **Bulk moves.** Shift-click (or ctrl/cmd-click) cards to select several,
  then send the whole group to a lane, archive it, or drag any one card and
  the rest come with it. The Closed lane also has an **Archive all** button.
- **Your own lanes.** New, In progress and Closed ship with every board and
  cannot be removed, though they can be renamed and recoloured. Add your own
  in Settings for anything else: a Backlog in front, a Blocked in the middle,
  a Cancelled at the end. Lanes travel with an export, so a backup restores
  the board you actually had.
- **Example tasks.** Settings can fill a sample project with tasks spread
  across the lanes, to see how the board behaves. Removed again in one click.
- **Comments.** Every task keeps a running thread of comments, plus a history
  of when it was created, moved, archived and commented on.
- **An archive, not a bin.** Archiving is how a task leaves a board. It keeps
  its lane, comments and history, and lives at **List → Status → Archived**,
  where one click reopens it back into the lane it left. Permanent deletion
  exists, but only for something already archived.
- **Tags.** Type `#tag` straight into the quick-add box, or manage tags in the
  task panel. The Tags page renames a tag across every task at once.
- **`@project` to file it.** `fix the nav @listboard #ui` files the task under
  Listboard wherever you are. Case, spaces and punctuation are ignored when
  matching, an unknown name creates the project (with an undo), and naming an
  archived one brings it back. Works in dropped text too.
- **Search and filter.** The board filters by project pills, tag pills and
  free text, and the filter box takes the same sigils as quick add, so
  `@alpha #ui` narrows to one project and one tag without touching the pills.
  The List page searches every task everywhere, by project, status and tag.
- **Backups.** Export the whole board as one JSON file, named
  `listboard-YYYY-MM-DD-HHMMSS.json`. Import merges a file back in and never
  deletes; drop the file onto Settings, or use the picker. On iPad and iPhone
  the export goes through the share sheet, which is the only way Safari keeps
  the filename.
- **Dark by default,** yellow accent, light mode opt-in. Both themes clear
  WCAG AA on every piece of text.

## Run it

Anything that serves static files will do:

```bash
npx --yes http-server listboard.github.io -p 8124 -c-1
```

Then open http://localhost:8124. The files are:

| File | What is in it |
| --- | --- |
| `index.html` | The whole shell: nav, five tab pages, the task drawer |
| `css/style.css` | Palette, the rail/bottom-bar layout, board and card styling |
| `js/app.js` | Data model, storage, rendering, drag-and-drop, backup |
| `favicon.svg` | The small mark: three solid lanes, in the accent yellow |
| `favicon.ico` | 16/32/48 fallback, because Safari ignores SVG favicons |
| `assets/icon-512.png` | 512px square for manifests, previews, anywhere else |
| `assets/icon-192.png` | 192px square |
| `assets/apple-touch-icon.png` | 180px, for iOS home screens |
| `tools/make-icons.py` | Redraws every raster icon from one geometry, by hand |

## Where your tasks live

In this browser, under the `lb-data` key in localStorage, and nowhere else.
That means:

- Tasks do not follow you to another browser, another device, or a private
  window. Export/import is the way across.
- Clearing site data deletes them. So does a browser that evicts script-written
  storage, which Safari does after about seven days without a visit.
- **No task ever leaves your browser.** Nothing you type is sent anywhere, and
  the app makes no network call of its own after the page loads.
- The page does carry a [Statcounter](https://statcounter.com/) tag for visit
  counts. It measures page views, not content: it has no access to your tasks,
  which never leave localStorage. It is the one third-party request on the
  page, and it does not load at all with JavaScript disabled.

Three things push back on that, none of which replaces a real backup:

- **Persistent storage.** Settings can ask the browser to exempt Listboard
  from evicting data to reclaim space. Chrome usually grants it outright,
  Firefox asks, Safari does not implement it.
- **Install it.** Add to Home Screen on iPhone or iPad, or install it from
  the browser on desktop. In mobile Safari an installed web app is exempt
  from the roughly seven-day purge of script-written storage, which is the
  single biggest risk to a board you do not open every week.
- **A backup that says its age.** Settings shows how long it has been since
  the last export, and says so loudly once it is over a fortnight.

Clearing site data by hand still wipes everything, and no web API can prevent
that. The exported file is the only copy that survives it.

The app tries hard not to lose anything: every write is read back and verified,
data that cannot be parsed is copied to `lb-data-rescued` instead of being
overwritten, tasks are archived rather than deleted, archiving offers an undo
(in bulk too), and deleting a project keeps its tasks and files them under
*No project*. The Settings page reports what storage
is actually doing.

## Keyboard

| Key | Does |
| --- | --- |
| <kbd>n</kbd> | New task on the current board |
| <kbd>/</kbd> | Jump to the search box |
| <kbd>Esc</kbd> | Close the task panel or the More sheet, or clear the selection |
| <kbd>Shift</kbd>/<kbd>Ctrl</kbd>+click | Add a card to the selection on the board |
| <kbd>Enter</kbd> | In quick add, files the task. <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> | In the comment box, posts the comment |

## Layout

A sticky left rail on desktop and tablet, a fixed bottom bar on phones (≤700px)
with the rail's foot collapsing into a More sheet. On a phone the three lanes
become a snapping horizontal carousel, and the task drawer becomes a full-height
sheet that stops above the bottom bar.

## Deep links

- `#board`, `#list`, `#projects`, `#tags`, `#settings` open a tab
- `#task/<id>` opens a task directly (the Link button in the task panel copies one)
- `#project/<id>` switches the board to a project

## Test it locally

Double-click `serve.cmd` on Windows, or run the http-server command above,
then open <http://localhost:8124>. Tasks you add while testing are stored
against `localhost:8124`, so they stay separate from the live site.
