# Listboard

A kanban board for project tasks that runs entirely in your browser. No
account, no server, no build step: one HTML file, one stylesheet, one script.

Live at **https://listboard.github.io**

## What it does

- **Projects.** Each project gets its own board, plus an *All projects* view
  that shows everything at once. Archiving a project hides it without touching
  a single task.
- **Tasks that are just a note.** A note is the only thing a task needs. Title,
  tags, due date and priority are all optional.
- **Three lanes.** New → In progress → Closed, with drag-and-drop between them
  and reordering inside them. Dragging works with a mouse and with a finger
  (long press to pick a card up).
- **Comments.** Every task keeps a running thread of comments, plus a history
  of when it was created, moved and commented on.
- **Tags.** Type `#tag` straight into the quick-add box, or manage tags in the
  task panel. The Tags page renames a tag across every task at once.
- **Search and filter.** Filter one board by text or tag; search every task
  everywhere from the List page, filtered by project, status and tag.
- **Backups.** Export the whole board as JSON, import it back on another
  machine. Import merges and never deletes.
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
| `favicon.svg` | Three lanes, in the accent yellow |

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

The app tries hard not to lose anything: every write is read back and verified,
data that cannot be parsed is copied to `lb-data-rescued` instead of being
overwritten, deleting a task offers an undo, and deleting a project keeps its
tasks and files them under *No project*. The Settings page reports what storage
is actually doing.

## Keyboard

| Key | Does |
| --- | --- |
| <kbd>n</kbd> | New task on the current board |
| <kbd>/</kbd> | Jump to the search box |
| <kbd>Esc</kbd> | Close the task panel or the More sheet |
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
