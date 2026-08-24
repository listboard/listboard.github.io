/* Listboard
   ---------
   A kanban board for project tasks, kept entirely in this browser.

   Everything lives in one localStorage blob under 'lb-data':

     { schema, projects: [Project], tasks: [Task] }

     Project = { id, name, created, archived }
     Task    = { id, project, title, note, tags[], status, order, archived,
                 created, updated, due, priority,
                 comments: [{ id, body, created }],
                 activity: [{ at, what }] }

   A task needs nothing but a note. Title, tags, due date and priority are all
   optional and absent rather than empty when unused.

   Archiving, not deleting, is how a task leaves the board. An archived task
   keeps its lane, its comments and its history; it is simply hidden from the
   board and from the List page until you ask for it by filtering Status to
   Archived, and it can be reopened straight back into the lane it left.
   Permanent deletion exists, but only for something already archived.

   No frameworks, no build step, no service worker. */

var KEY_DATA = 'lb-data';
var KEY_THEME = 'lb-theme';
var KEY_UI = 'lb-ui';
var KEY_RESCUED = 'lb-data-rescued';
var KEY_LAST_EXPORT = 'lb-last-export';
/* How long a board can go unbacked-up before the Settings page starts
   saying so, and a session gets one quiet reminder. */
var BACKUP_NAG_DAYS = 14;
var SCHEMA = 1;

/* The three lanes. The ids are written into storage, so they are permanent:
   renaming a label is free, renaming an id is a data migration. */
/* The lanes. The three built-ins ship with every board and their ids are
   written into stored data, so those ids are permanent: renaming a label is
   free, renaming an id is a data migration. Extra lanes can be added, renamed,
   recoloured, reordered and removed from Settings, and they travel with an
   export so a backup restores the board you actually had.

   `terminal` marks a lane as "finished work": it is left out of the open
   counts, it gets the Archive all button, and it is the one that only shows
   its most recent cards until asked for the rest. */
var STATUS_COLORS = ['slate', 'amber', 'green', 'blue', 'purple', 'red', 'teal', 'pink'];

var BUILTIN_STATUSES = [
  { id: 'new', label: 'New', color: 'slate', terminal: false },
  { id: 'doing', label: 'In progress', color: 'amber', terminal: false },
  { id: 'done', label: 'Closed', color: 'green', terminal: true }
];
var BUILTIN_IDS = BUILTIN_STATUSES.map(function (s) { return s.id; });

function defaultStatuses() {
  return BUILTIN_STATUSES.map(function (s) {
    return { id: s.id, label: s.label, color: s.color, terminal: s.terminal };
  });
}

function statuses() { return data.statuses; }
function statusIds() { return data.statuses.map(function (s) { return s.id; }); }

function statusById(id) {
  for (var i = 0; i < data.statuses.length; i++) {
    if (data.statuses[i].id === id) return data.statuses[i];
  }
  return null;
}
function statusLabel(id) {
  var s = statusById(id);
  return s ? s.label : id;
}
function statusHue(id) {
  var s = statusById(id);
  return s ? 'var(--st-' + s.color + ')' : 'var(--line)';
}
function isTerminal(id) {
  var s = statusById(id);
  return !!(s && s.terminal);
}
function isBuiltin(id) { return BUILTIN_IDS.indexOf(id) >= 0; }

/* Where a task goes when its lane is removed, or when stored data names a lane
   that no longer exists: the first one, which is never removable. */
function firstStatusId() {
  return data.statuses.length ? data.statuses[0].id : 'new';
}

/* Ids for lanes someone adds by hand. Derived from the label so an export is
   readable, and suffixed rather than replaced if it collides. */
function statusIdFor(label) {
  var base = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 24) || 'status';
  var id = base, n = 2;
  while (statusById(id)) { id = base + '-' + n; n++; }
  return id;
}

/* How many closed cards a column shows before it offers to show the rest.
   Closed is the lane that grows without bound; the other two are the work. */
var DONE_PREVIEW = 12;

/* ── Storage, defensively ─────────────────────────────────────────────
   Tasks only exist here, so a write that silently fails is the worst bug this
   app can have. Every write is read back, and unreadable data is copied aside
   before anything else touches it. */
var storageOK = true;
var rescued = false;

function storageGet(key) {
  try { return localStorage.getItem(key); } catch (e) { storageOK = false; return null; }
}

function storageSet(key, str) {
  try {
    localStorage.setItem(key, str);
    /* Read back rather than trusting the write: Safari's private mode has
       historically accepted setItem and thrown only on some paths, and a quota
       failure part-way through is worth catching now, not next load. */
    return localStorage.getItem(key) === str;
  } catch (e) {
    storageOK = false;
    return false;
  }
}

function loadJSON(key, fallback) {
  var raw = storageGet(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

function emptyData() { return { schema: SCHEMA, statuses: defaultStatuses(), projects: [], tasks: [] }; }

/* Reads the board without ever destroying what is there. */
function loadData() {
  var raw = storageGet(KEY_DATA);
  if (!raw) return emptyData();
  var parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
    /* Keep the unreadable original. It may still be recoverable by hand, and
       overwriting it would be the one truly unrecoverable move. */
    if (!storageGet(KEY_RESCUED)) storageSet(KEY_RESCUED, raw);
    rescued = true;
    return emptyData();
  }
  var d = emptyData();
  /* Lanes first: normalizeTask checks a task's status against them. A file
     with no statuses is one written before they were configurable, and gets
     the three built-ins. */
  d.statuses = normalizeStatuses(parsed.statuses);
  data = d;
  d.projects = (Array.isArray(parsed.projects) ? parsed.projects : [])
    .filter(function (p) { return p && p.id; })
    .map(function (p) {
      return {
        id: String(p.id),
        name: String(p.name || 'Untitled'),
        created: p.created || nowISO(),
        archived: !!p.archived
      };
    });
  d.tasks = parsed.tasks.filter(function (t) { return t && t.id; }).map(normalizeTask);
  return d;
}

/* Keeps the three built-ins present and in the stored order, drops anything
   malformed, and refuses to end up with an empty list. */
function normalizeStatuses(raw) {
  var out = [];
  var seen = {};
  (Array.isArray(raw) ? raw : []).forEach(function (s) {
    if (!s || !s.id) return;
    var id = String(s.id);
    if (seen[id]) return;
    seen[id] = true;
    out.push({
      id: id,
      label: String(s.label || id).slice(0, 40),
      color: STATUS_COLORS.indexOf(s.color) >= 0 ? s.color : 'slate',
      terminal: !!s.terminal
    });
  });
  /* A built-in that is missing from the file is put back rather than lost:
     tasks elsewhere in the same file may still be filed under it. */
  BUILTIN_STATUSES.forEach(function (b, i) {
    if (seen[b.id]) return;
    out.splice(Math.min(i, out.length), 0,
      { id: b.id, label: b.label, color: b.color, terminal: b.terminal });
  });
  return out.length ? out : defaultStatuses();
}

function normalizeTask(t) {
  return {
    id: String(t.id),
    project: t.project ? String(t.project) : '',
    title: typeof t.title === 'string' ? t.title : '',
    note: typeof t.note === 'string' ? t.note : '',
    tags: Array.isArray(t.tags) ? t.tags.map(cleanTag).filter(Boolean) : [],
    status: statusById(t.status) ? t.status : firstStatusId(),
    /* Archived is deliberately separate from status: a task keeps the lane it
       was in, so reopening puts it back where it was rather than at New. */
    archived: !!t.archived,
    order: typeof t.order === 'number' ? t.order : 0,
    created: t.created || nowISO(),
    updated: t.updated || t.created || nowISO(),
    due: t.due || '',
    priority: (t.priority === 'high' || t.priority === 'low') ? t.priority : 'normal',
    comments: Array.isArray(t.comments) ? t.comments.filter(function (c) { return c && c.body; }).map(function (c) {
      return { id: c.id || uid(), body: String(c.body), created: c.created || nowISO() };
    }) : [],
    activity: Array.isArray(t.activity) ? t.activity.slice(-50) : []
  };
}

var data = loadData();
var ui = loadJSON(KEY_UI, {}) || {};
if (typeof ui !== 'object') ui = {};

var warnedStorage = false;
function save() {
  var ok = storageSet(KEY_DATA, JSON.stringify(data));
  if (!ok) {
    storageOK = false;
    if (!warnedStorage) { warnedStorage = true; toast('This browser is not saving your tasks. See Settings.'); }
  }
  renderStorageStatus();
  /* A change worth storing is a change worth writing out. Debounced, so a
     drag does not thrash the disk. */
  autosaveSchedule();
  return ok;
}
function saveUI() { storageSet(KEY_UI, JSON.stringify(ui)); }

/* ── Small helpers ────────────────────────────────────────────────────── */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function nowISO() { return new Date().toISOString(); }
function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}
function cleanTag(s) {
  return String(s || '').trim().replace(/^#+/, '').replace(/\s+/g, '-').slice(0, 32).toLowerCase();
}
function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

function toast(msg, actionLabel, action) {
  var el = $('#toast');
  el.innerHTML = '<span></span>';
  el.firstChild.textContent = msg;
  if (actionLabel) {
    var b = document.createElement('button');
    b.textContent = actionLabel;
    b.addEventListener('click', function () {
      el.classList.remove('show');
      clearTimeout(toast._t);
      action();
    });
    el.appendChild(b);
  }
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.classList.remove('show'); }, actionLabel ? 7000 : 2600);
}

/* Dates are stored as ISO strings and shown in the reader's locale. */
function fmtDate(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtWhen(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function todayStr() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
/* Due dates are plain YYYY-MM-DD, compared as strings so no timezone can
   shift a date across midnight. */
function dueClass(due) {
  if (!due) return '';
  var t = todayStr();
  if (due < t) return 'overdue';
  if (due === t) return 'due-soon';
  return '';
}
function dueLabel(due) {
  var t = todayStr();
  if (due === t) return 'today';
  var d = new Date(due + 'T00:00:00');
  if (isNaN(d)) return due;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ── Model ────────────────────────────────────────────────────────────── */
function projectById(id) {
  for (var i = 0; i < data.projects.length; i++) if (data.projects[i].id === id) return data.projects[i];
  return null;
}
function projectName(id) {
  var p = projectById(id);
  return p ? p.name : 'No project';
}
function taskById(id) {
  for (var i = 0; i < data.tasks.length; i++) if (data.tasks[i].id === id) return data.tasks[i];
  return null;
}
function activeProjects() { return data.projects.filter(function (p) { return !p.archived; }); }

/* The board shows one project, or every project at once. '' means all. */
function currentProject() {
  if (ui.project === '' || ui.project === undefined) return '';
  return projectById(ui.project) && !projectById(ui.project).archived ? ui.project : '';
}

/* Everything that is still in play. The archive is only ever reached through
   the List page's Status filter, so every other count and view starts here. */
function liveTasks() {
  return data.tasks.filter(function (t) { return !t.archived; });
}
function archivedTasks() {
  return data.tasks.filter(function (t) { return t.archived; });
}

function tasksOf(projectId) {
  return liveTasks().filter(function (t) {
    if (projectId === '') {
      /* The all-projects board hides tasks filed under an archived project so
         archiving actually quiets the board down. */
      var p = projectById(t.project);
      return !p || !p.archived;
    }
    return t.project === projectId;
  });
}

function laneOf(projectId, status) {
  return tasksOf(projectId).filter(function (t) { return t.status === status; })
    .sort(function (a, b) { return a.order - b.order; });
}

function logActivity(t, what) {
  t.activity.push({ at: nowISO(), what: what });
  if (t.activity.length > 50) t.activity = t.activity.slice(-50);
}

function touch(t) { t.updated = nowISO(); }

function addTask(fields) {
  var t = normalizeTask({
    id: uid(),
    project: fields.project || '',
    title: fields.title || '',
    note: fields.note || '',
    tags: fields.tags || [],
    status: fields.status || 'new',
    created: nowISO(),
    updated: nowISO()
  });
  /* New work lands at the top of its lane, where you will see it. */
  var lane = laneOf(t.project, t.status);
  t.order = lane.length ? lane[0].order - 10 : 0;
  logActivity(t, 'Created');
  data.tasks.push(t);
  save();
  return t;
}

/* Moves a task to a lane, and optionally to a position within it. `beforeId`
   is the task it should land above, or null for the end of the lane. */
function moveTask(id, status, beforeId) {
  var t = taskById(id);
  if (!t) return;
  var from = t.status;
  t.status = status;
  if (from !== status) {
    logActivity(t, statusLabel(from) + ' → ' + statusLabel(status));
    touch(t);
  }
  /* Renumber the whole destination lane so orders stay dense and comparable
     however many times a card has been dragged. */
  var lane = laneOf(t.project, status).filter(function (x) { return x.id !== id; });
  var at = lane.length;
  if (beforeId) {
    for (var i = 0; i < lane.length; i++) if (lane[i].id === beforeId) { at = i; break; }
  }
  lane.splice(at, 0, t);
  lane.forEach(function (x, i) { x.order = i * 10; });
  save();
}

function setStatus(id, status) {
  var t = taskById(id);
  if (!t || t.status === status) return;
  /* Coming in from a button rather than a drag, so it goes to the top of the
     lane: it is the thing you just acted on. */
  var lane = laneOf(t.project, status);
  moveTask(id, status, lane.length ? lane[0].id : null);
}

/* ── Selection ────────────────────────────────────────────────────────────
   Shift-click (or ctrl/cmd-click) puts cards in a selection, which the lane
   buttons and a drag then act on together. It is board-only and deliberately
   not persisted: a selection is a thing you are doing right now, not state
   worth surviving a reload. */
var selection = [];

function isSelected(id) { return selection.indexOf(id) >= 0; }

function toggleSelect(id) {
  var i = selection.indexOf(id);
  if (i >= 0) selection.splice(i, 1); else selection.push(id);
  renderBoard();
}

function clearSelection(silent) {
  if (!selection.length) return;
  selection = [];
  renderBoard();
  if (!silent) toast('Selection cleared');
}

/* Selected tasks that are still on the board. A card can leave underneath a
   selection (archived from its panel, project switched), so every consumer
   reads through this rather than trusting the id list. */
function selectedTasks() {
  var onBoard = {};
  tasksOf(currentProject()).forEach(function (t) { onBoard[t.id] = t; });
  return selection.map(function (id) { return onBoard[id]; }).filter(Boolean);
}

/* Moves a whole selection into a lane, keeping the order the cards were in.
   Sequential single moves against the same anchor preserve that order: each
   one lands immediately above the anchor, so the group arrives in sequence. */
function moveMany(ids, status, beforeId) {
  var order = {};
  statuses().forEach(function (s) {
    laneOf(currentProject(), s.id).forEach(function (t, i) {
      order[t.id] = statusIds().indexOf(s.id) * 10000 + i;
    });
  });
  ids.slice().sort(function (a, b) { return (order[a] || 0) - (order[b] || 0); })
    .forEach(function (id) { moveTask(id, status, beforeId); });
}

/* Archiving is the ordinary way a task leaves the board, and it is completely
   reversible: nothing about the task changes except the flag. */
function archiveTask(id) {
  var t = taskById(id);
  if (!t || t.archived) return;
  t.archived = true;
  logActivity(t, 'Archived from ' + statusLabel(t.status));
  touch(t);
  save();
  renderAll();
  toast('Archived. Find it under List → Status → Archived.', 'Undo', function () {
    reopenTask(id, true);
  });
}

/* Archives a batch behind a single undo, so clearing a lane is one action to
   reverse rather than twenty. Takes tasks, not ids, because every caller has
   already filtered down to exactly what it means. */
function archiveMany(tasks, what) {
  var hit = tasks.filter(function (t) { return !t.archived; });
  if (!hit.length) return 0;
  hit.forEach(function (t) {
    t.archived = true;
    logActivity(t, 'Archived from ' + statusLabel(t.status));
    touch(t);
  });
  clearSelection(true);
  save();
  renderAll();
  toast(plural(hit.length, what || 'task') + ' archived', 'Undo', function () {
    hit.forEach(function (t) {
      t.archived = false;
      logActivity(t, 'Reopened into ' + statusLabel(t.status));
      touch(t);
    });
    save();
    renderAll();
    toast('Put back');
  });
  return hit.length;
}

/* Puts a task back in the lane it left. Silent when it is part of an undo, so
   the toast does not chase its own tail. */
function reopenTask(id, quiet) {
  var t = taskById(id);
  if (!t || !t.archived) return;
  t.archived = false;
  logActivity(t, 'Reopened into ' + statusLabel(t.status));
  touch(t);
  /* Back to the top of its lane: whatever its old neighbours were doing while
     it was away, this is the card you just acted on. */
  var lane = laneOf(t.project, t.status).filter(function (x) { return x.id !== id; });
  t.order = lane.length ? lane[0].order - 10 : 0;
  save();
  renderAll();
  if (!quiet) toast('Reopened into ' + statusLabel(t.status));
}

var lastDeleted = null;
function deleteTask(id) {
  var i = data.tasks.findIndex(function (t) { return t.id === id; });
  if (i < 0) return;
  lastDeleted = { task: data.tasks[i], index: i };
  data.tasks.splice(i, 1);
  save();
  renderAll();
  toast('Task deleted', 'Undo', function () {
    if (!lastDeleted) return;
    data.tasks.splice(Math.min(lastDeleted.index, data.tasks.length), 0, lastDeleted.task);
    lastDeleted = null;
    save();
    renderAll();
    toast('Task restored');
  });
}

function allTags() {
  var counts = {};
  liveTasks().forEach(function (t) {
    t.tags.forEach(function (g) { counts[g] = (counts[g] || 0) + 1; });
  });
  return Object.keys(counts).sort().map(function (g) { return { tag: g, n: counts[g] }; });
}

/* Pulls #hashtags out of typed text and returns the text without them. Used by
   quick add so a tag can be typed inline without leaving the box. */
/* Compares project names the way a person types them: case, spaces and
   punctuation all ignored, so "@listboard" finds "Listboard site" only if you
   spell it "@listboardsite", but "@Listboard" finds "listboard". */
function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* Turns an @token into a project id. Active projects win over archived ones,
   because an archived project is one you have deliberately put away. Returns
   null when nothing matches and creation was not asked for. */
function matchProject(token) {
  var want = normalizeName(token);
  if (!want) return null;
  var hit = null;
  data.projects.forEach(function (p) {
    if (normalizeName(p.name) !== want) return;
    if (!hit || (hit.archived && !p.archived)) hit = p;
  });
  return hit;
}

function parseEntry(text) {
  var tags = [];
  var projectToken = '';

  /* @project first, so a name containing a # cannot be eaten by the tag pass.
     Both patterns need whitespace or the very start in front of the sigil,
     which is what keeps "bob@example.com" and "issue#42" out of it. */
  var stripped = String(text).replace(/(^|\s)@([A-Za-z0-9][\w-]*)/g, function (m, pre, name) {
    /* A task belongs to one project, so the first @ wins and any others are
       left in the note as written. */
    if (projectToken) return m;
    projectToken = name;
    return pre;
  });

  stripped = stripped.replace(/(^|\s)#([A-Za-z0-9][\w-]*)/g, function (m, pre, tag) {
    var c = cleanTag(tag);
    if (c && tags.indexOf(c) < 0) tags.push(c);
    return pre;
  });

  stripped = stripped.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  /* If the note was nothing but sigils, keep what was typed: an empty note is
     worse than a redundant one. */
  return { note: stripped || String(text).trim(), tags: tags, projectToken: projectToken };
}

/* Kept as a thin wrapper so callers that only care about tags read cleanly. */
function extractTags(text) {
  var p = parseEntry(text);
  return { note: p.note, tags: p.tags };
}

/* ── Sigil autocomplete ───────────────────────────────────────────────────
   Typing #  or @ in the quick-add box or the board filter opens a list of the
   tags or projects that already exist, filtered as you type. Click one, walk
   it with the arrow keys, or press Tab or Enter to take the highlighted one,
   the way an editor completes code.

   Only what already exists is offered. This never invents a tag or a project,
   it only saves you retyping and misspelling one. */

var AC_MAX = 8;
var ac = { field: null, menu: null, items: [], idx: -1, from: 0, to: 0, sigil: '' };

/* The token being typed, if the caret is sitting at the end of one. Requires
   whitespace or the very start before the sigil, exactly like the parser, so
   an email address never opens a project menu.

   A leading minus is allowed to sit between the whitespace and the sigil,
   because an exclusion deserves the same help spelling a name as an inclusion.
   Only the sigil and what follows is replaced, so the minus stays where it was
   typed. Which of the two a field accepts depends on what it does with them:
   the quick-add box has no exclusions, the List box has nothing but. */
function acTokenAt(field) {
  if (typeof field.selectionStart !== 'number') return null;
  var caret = field.selectionStart;
  if (caret !== field.selectionEnd) return null;
  var before = field.value.slice(0, caret);
  var m = /(^|\s)(-?)([#@])([A-Za-z0-9][\w-]*|)$/.exec(before);
  if (!m) return null;
  var mode = field.getAttribute('data-ac-minus') || 'no';
  if (m[2] && mode === 'no') return null;
  if (!m[2] && mode === 'only') return null;
  return {
    sigil: m[3],
    prefix: m[4],
    from: caret - m[4].length - 1,   /* the sigil itself */
    to: caret
  };
}

function acCandidates(sigil, prefix) {
  var p = prefix.toLowerCase();
  if (sigil === '#') {
    return allTags().filter(function (g) { return g.tag.indexOf(p) === 0; })
      .slice(0, AC_MAX)
      .map(function (g) { return { insert: g.tag, label: g.tag, meta: plural(g.n, 'task') }; });
  }
  var want = normalizeName(prefix);
  return activeProjects().filter(function (pr) {
    return normalizeName(pr.name).indexOf(want) === 0;
  }).slice(0, AC_MAX).map(function (pr) {
    var n = liveTasks().filter(function (t) { return t.project === pr.id; }).length;
    return {
      /* Spaces would end the token, so they become hyphens. normalizeName
         strips those again when the text is parsed, so "@Beta-Site" still
         resolves to "Beta Site". */
      insert: pr.name.replace(/\s+/g, '-'),
      label: pr.name,
      meta: plural(n, 'task')
    };
  });
}

function acClose() {
  if (ac.menu && ac.menu.parentNode) ac.menu.parentNode.removeChild(ac.menu);
  ac.menu = null; ac.items = []; ac.idx = -1; ac.field = null;
}

function acOpen() { return !!ac.menu; }

function acRender() {
  ac.menu.innerHTML = ac.items.map(function (it, i) {
    return '<button type="button" class="ac-item' + (i === ac.idx ? ' on' : '') +
      '" data-i="' + i + '"><span class="ac-name">' + esc(ac.sigil + it.label) +
      '</span><span class="ac-meta">' + esc(it.meta) + '</span></button>';
  }).join('');
  var on = $('.ac-item.on', ac.menu);
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
}

function acPlace() {
  var r = ac.field.getBoundingClientRect();
  /* Fixed to the viewport rather than positioned inside a panel: the filter
     panels clip their overflow, and a menu that gets cut in half is worse
     than useless. */
  ac.menu.style.left = r.left + 'px';
  ac.menu.style.width = Math.max(180, Math.min(r.width, 320)) + 'px';
  var below = window.innerHeight - r.bottom;
  if (below < 180 && r.top > below) {
    ac.menu.style.top = 'auto';
    ac.menu.style.bottom = (window.innerHeight - r.top + 4) + 'px';
  } else {
    ac.menu.style.bottom = 'auto';
    ac.menu.style.top = (r.bottom + 4) + 'px';
  }
}

function acUpdate(field) {
  var tok = acTokenAt(field);
  if (!tok) { acClose(); return; }
  var items = acCandidates(tok.sigil, tok.prefix);
  if (!items.length) { acClose(); return; }

  if (!ac.menu) {
    ac.menu = document.createElement('div');
    ac.menu.className = 'ac-menu';
    /* mousedown, not click: the field must not lose focus before the pick
       lands, or the caret position goes with it. */
    ac.menu.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var b = e.target.closest('.ac-item');
      if (!b) return;
      ac.idx = parseInt(b.dataset.i, 10);
      acAccept();
    });
    document.body.appendChild(ac.menu);
  }
  ac.field = field;
  ac.items = items;
  ac.sigil = tok.sigil;
  ac.from = tok.from;
  ac.to = tok.to;
  /* Keep the highlight on the same entry while it survives the narrowing. */
  ac.idx = ac.idx >= 0 && ac.idx < items.length ? ac.idx : 0;
  acRender();
  acPlace();
}

function acAccept() {
  if (!acOpen() || ac.idx < 0) return false;
  var it = ac.items[ac.idx];
  var f = ac.field;
  var text = f.value.slice(0, ac.from) + ac.sigil + it.insert + ' ' + f.value.slice(ac.to);
  var caret = ac.from + 1 + it.insert.length + 1;
  var field = f;
  acClose();
  field.value = text;
  field.setSelectionRange(caret, caret);
  /* Let whatever owns the field react: the filter box refilters, the quick
     add box regrows. */
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.focus();
  return true;
}

function acKey(e) {
  if (!acOpen() || ac.field !== e.target) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    ac.idx = (ac.idx + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length;
    acRender();
    return;
  }
  if (e.key === 'Tab' || e.key === 'Enter') {
    /* Shift+Enter is a new line in the note box and must stay one. */
    if (e.key === 'Enter' && e.shiftKey) { acClose(); return; }
    e.preventDefault();
    /* Stops the quick-add box filing the task on the same Enter that took the
       completion, which would be a very annoying way to lose a keystroke. */
    e.stopImmediatePropagation();
    acAccept();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    acClose();
  }
}

/* Capture, so this runs before the field's own Enter handling. */
function wireAutocomplete(sel, minus) {
  var field = $(sel);
  if (!field) return;
  field.setAttribute('data-ac-minus', minus || 'no');
  field.addEventListener('keydown', acKey, true);
  field.addEventListener('input', function () { acUpdate(field); });
  field.addEventListener('click', function () { acUpdate(field); });
  field.addEventListener('blur', function () { setTimeout(acClose, 0); });
}

/* ── Filters ──────────────────────────────────────────────────────────── */
var boardFilter = { q: '', tag: '', project: null, not: noExclusions() };
var listFilter = blankListFilter();

/* The List page has three chips and a box, and three separate places reset it,
   so the shape lives in one function. Anything that rebuilds the object from
   scratch gets the exclusions cleared with everything else, which is what a
   reset should do. */
function blankListFilter(over) {
  var f = { q: '', project: '', status: '', tag: '', not: noExclusions() };
  if (over) for (var k in over) if (over.hasOwnProperty(k)) f[k] = over[k];
  return f;
}

function textOf(t) {
  return [t.title, t.note, t.tags.join(' '), projectName(t.project),
    t.comments.map(function (c) { return c.body; }).join(' ')].join(' ').toLowerCase();
}
function boardFiltered() {
  return !!(boardFilter.q || boardFilter.tag || boardFilter.project !== null ||
    hasExclusions(boardFilter.not));
}

function matchesBoard(t) {
  /* null is "every project"; '' is the real filter for tasks with no project
     at all, which is why this tests against null rather than falsiness. */
  if (boardFilter.project !== null && t.project !== boardFilter.project) return false;
  if (boardFilter.tag && t.tags.indexOf(boardFilter.tag) < 0) return false;
  if (boardFilter.q && textOf(t).indexOf(boardFilter.q) < 0) return false;
  if (excluded(t, boardFilter.not)) return false;
  return true;
}

/* ── Exclusions ───────────────────────────────────────────────────────────
   A leading minus takes something away, in either search box: `-#chore` drops
   everything tagged chore, `-@listboard` drops that project, and a bare
   `-draft` drops anything whose text mentions it.

   Exclusions are stripped before the positive sigils are read, and, like every
   other sigil in the app, a minus only counts after whitespace or at the very
   start. That is what keeps `well-known` and `2026-08-24` out of it.

   They stack: several of each is an and, so a task is out if it matches any
   one of them. */
function noExclusions() { return { terms: [], tags: [], projects: [] }; }

function hasExclusions(not) {
  return !!(not && (not.terms.length || not.tags.length || not.projects.length));
}

function addOnce(arr, v) { if (v && arr.indexOf(v) < 0) arr.push(v); }

function parseExclusions(raw) {
  var not = noExclusions();
  var rest = String(raw)
    .replace(/(^|\s)-@([A-Za-z0-9][\w-]*)/g, function (m, pre, name) {
      /* An unknown name excludes nothing, unlike the positive @name, which
         shows an empty board. There is no honest board to show for "everything
         except a project that does not exist" other than everything. */
      var hit = matchProject(name);
      if (hit) addOnce(not.projects, hit.id);
      return pre;
    })
    .replace(/(^|\s)-#([A-Za-z0-9][\w-]*)/g, function (m, pre, t) {
      addOnce(not.tags, cleanTag(t));
      return pre;
    })
    .replace(/(^|\s)-(\S+)/g, function (m, pre, term) {
      addOnce(not.terms, term.toLowerCase());
      return pre;
    })
    .replace(/\s{2,}/g, ' ').trim();
  return { rest: rest, not: not };
}

/* Read against the same text the positive search reads, so "matches" and
   "does not match" always mean the same thing. */
function excluded(t, not) {
  if (!hasExclusions(not)) return false;
  if (not.projects.indexOf(t.project) >= 0) return true;
  var i;
  for (i = 0; i < not.tags.length; i++) if (t.tags.indexOf(not.tags[i]) >= 0) return true;
  if (not.terms.length) {
    var text = textOf(t);
    for (i = 0; i < not.terms.length; i++) if (text.indexOf(not.terms[i]) >= 0) return true;
  }
  return false;
}

/* No project can ever have this id, so filtering to it shows an empty board.
   That is the honest answer to @nonsense: quietly ignoring an unmatched name
   would show a board that looks unfiltered. */
var NO_SUCH_PROJECT = '__no-such-project__';

/* The board's filter box understands the same sigils as quick add: #tag and
   @project drive the chips, and whatever is left is the free text search.

   parseEntry is deliberately not reused here. It keeps the original text when
   stripping would leave the note empty, which is right for a task and wrong
   for a filter: "@listboard" on its own would come back as a literal text
   search for "@listboard" and match nothing. */
function applyBoardSearch(raw) {
  var tag = '', proj = '';
  /* Exclusions come off first, so the positive passes below never see the
     @name in a -@name. */
  var cut = parseExclusions(raw);
  boardFilter.not = cut.not;
  var rest = cut.rest
    .replace(/(^|\s)@([A-Za-z0-9][\w-]*)/g, function (m, pre, name) {
      if (!proj) proj = name;
      return pre;
    })
    .replace(/(^|\s)#([A-Za-z0-9][\w-]*)/g, function (m, pre, t) {
      if (!tag) tag = cleanTag(t);
      return pre;
    })
    .replace(/\s{2,}/g, ' ').trim();

  boardFilter.q = rest.toLowerCase();
  boardFilter.tag = tag;
  if (proj) {
    var hit = matchProject(proj);
    boardFilter.project = hit ? hit.id : NO_SUCH_PROJECT;
  } else {
    boardFilter.project = null;
  }
  renderBoard();
}
/* Explicit "has none of these" filters. Empty string still means Any, so
   these need values of their own rather than reusing it. */
var NO_PROJECT = '∅project';
var NO_TAGS = '∅tags';

/* Every list filter in one place, taking the filter set as an argument so the
   facet counts can ask "what if this one chip were different". */
function matchesListWith(t, f) {
  /* The archive is reachable one way only: Status → Archived. Every other
     filter combination, including "Any", is about live work. */
  if (f.status === 'archived') {
    if (!t.archived) return false;
  } else {
    if (t.archived) return false;
    /* A status that no longer exists still passes Any, so a task whose lane
       was removed outside the app can always be found and refiled. */
    if (f.status && t.status !== f.status) return false;
  }
  if (f.project === NO_PROJECT) {
    if (t.project) return false;
  } else if (f.project && t.project !== f.project) return false;

  if (f.tag === NO_TAGS) {
    if (t.tags.length) return false;
  } else if (f.tag && t.tags.indexOf(f.tag) < 0) return false;

  if (f.q && textOf(t).indexOf(f.q) < 0) return false;
  if (excluded(t, f.not)) return false;
  return true;
}

function matchesList(t) { return matchesListWith(t, listFilter); }

/* How many tasks would match if one chip were set to `value`, with every other
   filter left as it is. That is what makes a count trustworthy: a chip reading
   3 means clicking it shows 3, not 3 before the search box has its say. */
function facetCount(key, value) {
  var f = blankListFilter(listFilter);
  f[key] = value;
  var n = 0;
  data.tasks.forEach(function (t) { if (matchesListWith(t, f)) n++; });
  return n;
}

/* ── Theme ────────────────────────────────────────────────────────────── */
function setTheme(mode) {
  document.documentElement.className = mode;
  storageSet(KEY_THEME, mode);
  [['#btnThemeDark', 'dark'], ['#btnThemeLight', 'light']].forEach(function (pair) {
    var b = $(pair[0]);
    b.classList.toggle('on', mode === pair[1]);
    /* aria-pressed rather than aria-selected: these are toggle buttons in a
       group, not tabs, and a screen reader should say which one is on. */
    b.setAttribute('aria-pressed', mode === pair[1] ? 'true' : 'false');
  });
}

/* ── Tabs and routing ─────────────────────────────────────────────────── */
var TABS = ['board', 'list', 'projects', 'tags', 'about', 'settings'];

function showTab(name) {
  /* A selection belongs to the board you made it on: leaving takes it with
     you, so you never come back to a stale one you have forgotten about. */
  /* renderBoard repaints the cards without their selected ring and hides the
     bar, so coming back to the board never shows a selection that is gone. */
  if (name !== 'board' && selection.length) { selection = []; renderBoard(); }
  $$('.tabpage').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + name); });
  $$('.tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
  closeMore();
  window.scrollTo(0, 0);
}

function onTab(name) {
  return $('#tab-' + name).classList.contains('active');
}

/* Whichever tab page is on screen right now, regardless of what the URL says.
   They can disagree: the task drawer rewrites the hash without routing. */
function currentTabName() {
  for (var i = 0; i < TABS.length; i++) if (onTab(TABS[i])) return TABS[i];
  return 'board';
}

/* Sets the hash and makes sure the router runs, even when the hash is already
   what we are setting it to. Assigning an unchanged hash fires no hashchange,
   which is exactly how a tab button ends up doing nothing. */
function goTab(name) {
  /* Set the hash, then route by hand. Assigning location.hash queues
     hashchange as a task rather than firing it now, so anything that runs
     straight after this call would still be looking at the old tab: that is
     what left n and / focusing a field on a page that was still hidden.
     route() is idempotent, so the queued hashchange repeating it is harmless. */
  if (location.hash !== '#' + name) location.hash = name;
  route();
}

/* A field on a hidden tab cannot take focus: the browser refuses silently and
   the keystroke appears to do nothing. So the tab is switched first, and
   switched *synchronously* - assigning location.hash updates the property
   straight away but does not fire hashchange until the current task ends, so
   route() has to be called by hand rather than waited for. */
function goTabThenFocus(name, sel) {
  if (!onTab(name)) goTab(name);
  focusField(sel);
}

function focusField(sel) {
  var el = $(sel);
  if (!el) return;
  el.focus();
  /* Caret at the end rather than selecting what is there, so typing extends an
     existing filter instead of replacing it. */
  if (el.setSelectionRange && typeof el.value === 'string') {
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {}
  }
  /* showTab has just scrolled to the top; make sure the field is actually in
     view on a small screen, where it may sit below the fold. */
  if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}

function closeMore() {
  $('#moreSheet').classList.remove('open');
  $('.tabs [data-tab="settings"]').classList.remove('sheet-open');
}

/* #task/<id> opens a task, #project/<id> switches the board, #<tab> is a tab.
   Task links are what make a card shareable between your own devices. */
function route() {
  var h = (location.hash || '').replace(/^#/, '');
  if (h.indexOf('task/') === 0) {
    var t = taskById(h.slice(5));
    if (t) { showTab('board'); openTask(t.id); return; }
  }
  if (h.indexOf('project/') === 0) {
    var p = projectById(h.slice(8));
    if (p) { ui.project = p.id; saveUI(); showTab('board'); renderAll(); closeDrawer(); return; }
  }
  closeDrawer();
  showTab(TABS.indexOf(h) >= 0 ? h : 'board');
}

/* ── Rendering: nav counts ────────────────────────────────────────────── */
function renderCounts() {
  var live = liveTasks();
  var open = live.filter(function (t) { return !isTerminal(t.status); }).length;
  var boardOpen = tasksOf(currentProject()).filter(function (t) { return !isTerminal(t.status); }).length;
  $('#boardCount').textContent = boardOpen ? String(boardOpen) : '';
  $('#listCount').textContent = live.length ? String(live.length) : '';
  $('#projCount').textContent = activeProjects().length ? String(activeProjects().length) : '';
  $('#tagCount').textContent = allTags().length ? String(allTags().length) : '';
  document.title = open ? 'Listboard (' + open + ')' : 'Listboard';
}

/* ── Rendering: the board ─────────────────────────────────────────────── */
function renderPicker() {
  var sel = $('#projectPicker');
  var cur = currentProject();
  var html = '<option value="">All projects</option>';
  activeProjects().forEach(function (p) {
    html += '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
  });
  html += '<option value="__new">+ New project...</option>';
  sel.innerHTML = html;
  sel.value = cur;
}

/* A project reads like a tag but bolder, and always with its @, matching the
   sigil that files and filters it. */
function projTagHTML(id) {
  return '<span class="tag proj-tag" title="Project">@' + esc(projectName(id)) + '</span>';
}

function cardHTML(t) {
  var h = '<div class="card' + (isSelected(t.id) ? ' selected' : '') +
    '" data-id="' + esc(t.id) + '" style="--st:' + statusHue(t.status) + '">';
  if (t.title) h += '<div class="card-title">' + esc(t.title) + '</div>';
  h += '<div class="card-note' + (t.title ? '' : ' solo') + '">' + esc(t.note) + '</div>';

  var foot = '';
  t.tags.forEach(function (g) { foot += '<span class="tag">' + esc(g) + '</span>'; });
  if (t.priority === 'high') foot += '<span class="prio prio-high">HIGH</span>';
  if (t.priority === 'low') foot += '<span class="prio prio-low">LOW</span>';
  if (foot) foot += '<span class="spacer"></span>';
  if (t.due) {
    foot += '<span class="meta ' + dueClass(t.due) + '" title="Due ' + esc(fmtDate(t.due)) + '">' +
      '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>' +
      esc(dueLabel(t.due)) + '</span>';
  }
  if (t.comments.length) {
    foot += '<span class="meta" title="' + plural(t.comments.length, 'comment') + '">' +
      '<svg viewBox="0 0 24 24"><path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/></svg>' +
      t.comments.length + '</span>';
  }
  if (currentProject() === '' && t.project) {
    /* Written the way it is typed, so the badge on a card and the @project you
       would type to file or filter it are visibly the same thing. */
    foot += projTagHTML(t.project);
  }
  if (foot) h += '<div class="card-foot">' + foot + '</div>';
  return h + '</div>';
}

function renderBoard() {
  var proj = currentProject();
  var p = proj ? projectById(proj) : null;
  $('#boardTitle').textContent = p ? p.name : 'All projects';

  var all = tasksOf(proj);
  var open = all.filter(function (t) { return !isTerminal(t.status); }).length;
  var overdue = all.filter(function (t) { return !isTerminal(t.status) && t.due && t.due < todayStr(); }).length;
  $('#boardSub').textContent = all.length
    ? plural(open, 'open task') + ' of ' + all.length + (overdue ? ', ' + overdue + ' overdue' : '')
    : (p ? 'Nothing here yet. Jot the first task below.' : 'No tasks yet. Jot the first one below.');

  renderBoardProjChips();
  renderBoardTagChips();

  renderSelBar();

  var host = $('#board');
  var html = '';
  statuses().forEach(function (s) {
    var lane = laneOf(proj, s.id).filter(matchesBoard);
    var shown = lane;
    var hidden = 0;
    if (s.terminal && !ui.showAllDone && lane.length > DONE_PREVIEW) {
      shown = lane.slice(0, DONE_PREVIEW);
      hidden = lane.length - DONE_PREVIEW;
    }
    html += '<section class="col" data-status="' + s.id + '" style="--st:' + s.hue + '">' +
      '<div class="col-head"><span class="dot"></span>' + esc(s.label) +
      '<span class="n">' + lane.length + '</span>' +
      /* Closed is the lane that piles up, so it gets the one-click way to
         empty it. It acts on what the lane is actually showing, so a filtered
         board never archives something you cannot see. */
      (s.terminal && lane.length
        ? '<button class="col-act" data-archiveall="1" title="Archive every closed task on this board">Archive all</button>'
        : '') +
      '</div>' +
      '<div class="col-body">';
    if (!shown.length) {
      /* An empty lane and a lane filtered down to nothing look identical, so
         they have to be told apart by whether a filter is on at all. */
      html += '<div class="col-empty">' +
        (boardFiltered() ? 'Nothing matches the filter' :
          s.id === 'new' ? 'Drop a task here' : 'Nothing ' + s.label.toLowerCase()) +
        '</div>';
    }
    shown.forEach(function (t) { html += cardHTML(t); });
    html += '</div>';
    if (hidden) {
      html += '<button class="col-more" data-showall="1">Show ' + hidden + ' more closed</button>';
    }
    html += '</section>';
  });
  host.innerHTML = html;
}

function renderSelBar() {
  var picked = selectedTasks();
  /* An id list that no longer matches anything on the board means the cards
     went away under it; drop them rather than showing a stale count. */
  if (picked.length !== selection.length) {
    selection = picked.map(function (t) { return t.id; });
  }
  var bar = $('#selBar');
  if (!picked.length) { bar.hidden = true; return; }
  bar.hidden = false;
  $('#selCount').textContent = plural(picked.length, 'task') + ' selected';
  /* Only lanes the selection is not already entirely in are worth offering. */
  $('#selActs').innerHTML = statuses().map(function (s) {
    var all = picked.every(function (t) { return t.status === s.id; });
    return '<button class="mini"' + (all ? ' disabled' : '') +
      ' data-selmove="' + s.id + '">' + esc(s.label) + '</button>';
  }).join('') + '<button class="mini" data-selarchive="1">Archive</button>';
}

/* Only worth showing on the all-projects board: anywhere else every card is
   already in the same project. */
function renderBoardProjChips() {
  var row = $('#boardProjRow');
  var host = $('#boardProjChips');
  if (!row || !host) return;

  var pool = tasksOf(currentProject());
  var counts = {};
  pool.forEach(function (t) { counts[t.project] = (counts[t.project] || 0) + 1; });

  var ids = activeProjects().filter(function (p) { return counts[p.id]; })
    .map(function (p) { return p.id; });
  var unfiled = counts[''] || 0;

  /* Nothing to choose between: one project, or a board already scoped to one.
     Hiding the row is all this does. It must never clear the filter itself:
     a render that edits state wipes an @name typed into the filter box, since
     that works on any board whether or not the pills are worth showing. */
  if (currentProject() !== '' || ids.length + (unfiled ? 1 : 0) < 2) {
    row.hidden = true;
    return;
  }
  row.hidden = false;

  var html = '<button class="chip' + (boardFilter.project === null ? ' on' : '') +
    '" data-bproj="" data-all="1" title="Every project on this board">All</button>';
  ids.forEach(function (id) {
    html += '<button class="chip' + (boardFilter.project === id ? ' on' : '') +
      '" data-bproj="' + esc(id) + '">' + esc(projectName(id)) +
      '<span class="n">' + counts[id] + '</span></button>';
  });
  if (unfiled) {
    html += '<button class="chip' + (boardFilter.project === '' ? ' on' : '') +
      '" data-bproj="" title="Tasks with no project">No project' +
      '<span class="n">' + unfiled + '</span></button>';
  }
  host.innerHTML = html;
}

function renderBoardTagChips() {
  var proj = currentProject();
  var counts = {};
  tasksOf(proj).forEach(function (t) {
    t.tags.forEach(function (g) { counts[g] = (counts[g] || 0) + 1; });
  });
  var tags = Object.keys(counts).sort();
  var host = $('#boardTagChips');
  var wrap = host.closest('.filter-row');
  if (wrap) wrap.style.display = tags.length ? '' : 'none';
  /* All comes first and is lit when no tag is chosen, so there is always an
     obvious way back to the whole board. Clicking the active tag again still
     clears it, for anyone who learned it that way. */
  host.innerHTML = '<button class="chip' + (boardFilter.tag === '' ? ' on' : '') +
    '" data-btag="" title="Show every task on this board">All</button>' +
    tags.map(function (g) {
      return '<button class="chip' + (boardFilter.tag === g ? ' on' : '') + '" data-btag="' + esc(g) + '">' +
        esc(g) + '<span class="n">' + counts[g] + '</span></button>';
    }).join('');
}

/* ── Rendering: the flat list ─────────────────────────────────────────── */
/* Every chip carries the count it would actually produce if clicked, with the
   other filters left as they are. Counting each facet on its own was the bug
   behind "Closed 1" sitting above "0 of 20 tasks": the search box had already
   ruled that task out, but the chip had not been told.

   A chip that would yield nothing is dimmed rather than hidden, so the shape
   of the data stays visible instead of the row twitching as you type. */
function chipHTML(attr, value, label, on, title, n) {
  return '<button class="chip' + (on ? ' on' : '') + (!n && !on ? ' zero' : '') +
    '" ' + attr + '="' + esc(value) + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
    esc(label) + '<span class="n">' + n + '</span></button>';
}

function renderListChips() {
  var out = [];

  /* Projects. Any counts everything that passes the other filters, including
     tasks with no project at all; No project is the way to ask for only those. */
  out.push(chipHTML('data-lproj', '', 'Any', listFilter.project === '',
    'Every project, and tasks with none', facetCount('project', '')));
  activeProjects().forEach(function (p) {
    out.push(chipHTML('data-lproj', p.id, p.name, listFilter.project === p.id, '',
      facetCount('project', p.id)));
  });
  var noProj = facetCount('project', NO_PROJECT);
  if (noProj || listFilter.project === NO_PROJECT) {
    out.push(chipHTML('data-lproj', NO_PROJECT, 'No project',
      listFilter.project === NO_PROJECT, 'Tasks filed under no project', noProj));
  }
  $('#listProjChips').innerHTML = out.join('');

  /* Statuses. Any covers every lane, and also any task whose lane has since
     been removed, so nothing can become unreachable. */
  out = [chipHTML('data-lstatus', '', 'Any', listFilter.status === '',
    'Every lane', facetCount('status', ''))];
  statuses().forEach(function (st) {
    out.push(chipHTML('data-lstatus', st.id, st.label, listFilter.status === st.id, '',
      facetCount('status', st.id)));
  });
  /* The only door into the archive. It stays visible at zero so it is findable
     before there is anything behind it. */
  out.push(chipHTML('data-lstatus', 'archived', 'Archived', listFilter.status === 'archived',
    'Archived tasks, hidden from every board', facetCount('status', 'archived')));
  $('#listStatusChips').innerHTML = out.join('');

  /* Tags. Any includes untagged tasks; Untagged is the way to ask for only
     those. */
  var pool = listFilter.status === 'archived' ? archivedTasks() : liveTasks();
  var tags = {};
  pool.forEach(function (t) { t.tags.forEach(function (g) { tags[g] = true; }); });
  var names = Object.keys(tags).sort();
  var row = $('#listTagChips').closest('.filter-row');
  if (row) row.style.display = names.length ? '' : 'none';

  out = [chipHTML('data-ltag', '', 'Any', listFilter.tag === '',
    'Every tag, and tasks with none', facetCount('tag', ''))];
  names.forEach(function (g) {
    out.push(chipHTML('data-ltag', g, g, listFilter.tag === g, '', facetCount('tag', g)));
  });
  var untagged = facetCount('tag', NO_TAGS);
  if (untagged || listFilter.tag === NO_TAGS) {
    out.push(chipHTML('data-ltag', NO_TAGS, 'Untagged', listFilter.tag === NO_TAGS,
      'Tasks with no tags at all', untagged));
  }
  $('#listTagChips').innerHTML = out.join('');
}

function renderList() {
  renderListChips();
  var rows = data.tasks.filter(matchesList).sort(function (a, b) {
    return (b.updated || '').localeCompare(a.updated || '');
  });
  var inArchive = listFilter.status === 'archived';
  var total = inArchive ? archivedTasks().length : liveTasks().length;
  $('#listResultCount').textContent = (rows.length === total
    ? plural(rows.length, 'task')
    : rows.length + ' of ' + total + ' tasks') + (inArchive ? ' in the archive' : '');

  if (!rows.length) {
    $('#listRows').innerHTML = '<div class="empty">' +
      (inArchive ? 'The archive is empty. Archiving a task from its panel puts it here.'
        : data.tasks.length ? 'Nothing matches those filters.'
          : 'No tasks yet. Add one on the Board.') +
      '</div>';
    return;
  }
  $('#listRows').innerHTML = rows.map(function (t) {
    var sub = t.title ? t.note : '';
    return '<div class="trow' + (t.archived ? ' is-archived' : '') + '" data-id="' + esc(t.id) +
      '" style="--st:' + statusHue(t.status) + '">' +
      '<div class="trow-main">' +
      '<div class="trow-title">' + esc(t.title || t.note.split('\n')[0]) + '</div>' +
      (sub ? '<div class="trow-note">' + esc(sub) + '</div>' : '') +
      '<div class="card-foot">' +
      t.tags.map(function (g) { return '<span class="tag">' + esc(g) + '</span>'; }).join('') +
      (t.due ? '<span class="meta ' + dueClass(t.due) + '">Due ' + esc(dueLabel(t.due)) + '</span>' : '') +
      (t.comments.length ? '<span class="meta">' + plural(t.comments.length, 'comment') + '</span>' : '') +
      '</div></div>' +
      '<div class="trow-side">' +
      '<span class="status-badge">' + esc(statusLabel(t.status)) + '</span>' +
      (t.project ? projTagHTML(t.project) : '') +
      /* Reopening is the point of an archive, so it is one click from the row
         rather than buried in the task panel. */
      (t.archived ? '<button class="mini" data-reopen="' + esc(t.id) + '">Reopen</button>' : '') +
      '</div></div>';
  }).join('');
}

/* ── Rendering: projects and tags ─────────────────────────────────────── */
function renderProjects() {
  if (!data.projects.length) {
    $('#projectRows').innerHTML = '<div class="empty">No projects yet. Tasks without one are filed under "No project".</div>';
    return;
  }
  $('#projectRows').innerHTML = data.projects.map(function (p) {
    var all = liveTasks().filter(function (t) { return t.project === p.id; });
    var open = all.filter(function (t) { return !isTerminal(t.status); }).length;
    var arch = archivedTasks().filter(function (t) { return t.project === p.id; }).length;
    return '<div class="arow' + (p.archived ? ' archived' : '') + '" data-pid="' + esc(p.id) + '">' +
      '<span class="arow-name">' + esc(p.name) + (p.archived ? ' <span class="arow-stats">(archived)</span>' : '') + '</span>' +
      '<span class="arow-stats">' + open + ' open / ' + all.length + ' total' +
      (arch ? ' · ' + arch + ' archived' : '') + '</span>' +
      '<span class="arow-acts">' +
      (p.archived ? '' : '<button class="mini" data-pact="open">Open board</button>') +
      '<button class="mini" data-pact="rename">Rename</button>' +
      '<button class="mini" data-pact="archive">' + (p.archived ? 'Unarchive' : 'Archive') + '</button>' +
      '<button class="mini danger" data-pact="delete">Delete</button>' +
      '</span></div>';
  }).join('');
}

function renderTags() {
  var tags = allTags();
  if (!tags.length) {
    $('#tagRows').innerHTML = '<div class="empty">No tags yet. Type <b>#something</b> in the quick-add box, or add tags in a task.</div>';
    return;
  }
  $('#tagRows').innerHTML = tags.map(function (g) {
    return '<div class="arow" data-tag="' + esc(g.tag) + '">' +
      '<span class="arow-name"><span class="tag">' + esc(g.tag) + '</span></span>' +
      '<span class="arow-stats">' + plural(g.n, 'task') + '</span>' +
      '<span class="arow-acts">' +
      '<button class="mini" data-tact="filter">Show tasks</button>' +
      '<button class="mini" data-tact="rename">Rename</button>' +
      '<button class="mini danger" data-tact="remove">Remove everywhere</button>' +
      '</span></div>';
  }).join('');
}

/* ── Rendering: settings ──────────────────────────────────────────────── */
function renderStorageStatus() {
  var bytes = 0;
  var raw = storageGet(KEY_DATA);
  if (raw) bytes = raw.length;
  var kb = (bytes / 1024).toFixed(bytes > 10240 ? 0 : 1);
  var lines = [];
  if (!storageOK) {
    lines.push('<b class="warn">This browser is refusing to save.</b> Private windows and blocked site data both do this. Export a backup now, because nothing typed here will survive a reload.');
  } else {
    lines.push('Saving normally. ' + plural(data.tasks.length, 'task') + ' and ' +
      plural(data.projects.length, 'project') + ', about ' + kb + ' KB.');
  }
  if (rescued) {
    lines.push('<b class="warn">Earlier data could not be read</b> and was copied to <code>lb-data-rescued</code> rather than overwritten. It is still in this browser if you want to recover it by hand.');
  }
  lines.push('Storage is per browser and per device, and clearing site data removes it. There is no server and no account, so backups are the only copy.');
  $('#storageStatus').innerHTML = lines.map(function (l) { return '<p style="margin:.35rem 0">' + l + '</p>'; }).join('');
}

function renderStatusRows() {
  var host = $('#statusRows');
  if (!host) return;
  host.innerHTML = data.statuses.map(function (s, i) {
    var n = liveTasks().filter(function (t) { return t.status === s.id; }).length;
    var builtin = isBuiltin(s.id);
    return '<div class="arow" data-sid="' + esc(s.id) + '">' +
      '<span class="st-swatch" style="--st:var(--st-' + s.color + ')"></span>' +
      '<span class="arow-name">' + esc(s.label) +
      (builtin ? ' <span class="arow-stats">(built in)</span>' : '') + '</span>' +
      '<span class="arow-stats">' + plural(n, 'task') + '</span>' +
      '<span class="arow-acts">' +
      '<select data-sact="color" title="Lane colour" class="st-color">' +
      STATUS_COLORS.map(function (c) {
        return '<option value="' + c + '"' + (c === s.color ? ' selected' : '') + '>' + c + '</option>';
      }).join('') + '</select>' +
      '<label class="st-term" title="Left out of the open counts, and gets the Archive all button">' +
      '<input type="checkbox" data-sact="terminal"' + (s.terminal ? ' checked' : '') + '> closed' +
      '</label>' +
      '<button class="mini" data-sact="up"' + (i === 0 ? ' disabled' : '') + ' title="Move left">&uarr;</button>' +
      '<button class="mini" data-sact="down"' + (i === data.statuses.length - 1 ? ' disabled' : '') + ' title="Move right">&darr;</button>' +
      '<button class="mini" data-sact="rename">Rename</button>' +
      (builtin ? '' : '<button class="mini danger" data-sact="delete">Delete</button>') +
      '</span></div>';
  }).join('');
}

function renderArchiveCount() {
  var n = archivedTasks().length;
  $('#archiveCount').textContent = n ? plural(n, 'task') + ' archived' : 'nothing archived yet';
}

function renderAll() {
  renderCounts();
  renderBackupAge();
  renderStatusRows();
  renderArchiveCount();
  renderPicker();
  renderBoard();
  renderList();
  renderProjects();
  renderTags();
  renderStorageStatus();
}

/* ── The task drawer ──────────────────────────────────────────────────── */
var openId = null;
/* The tab a task was opened from, so closing it goes back there. */
var drawerReturn = '';

function openTask(id) {
  var t = taskById(id);
  if (!t) return;
  openId = id;
  if (!drawerReturn) drawerReturn = currentTabName();
  $('#drawerScrim').hidden = false;
  var d = $('#drawer');
  d.hidden = false;
  drawTaskDrawer(t);
  if (location.hash !== '#task/' + id) history.replaceState(null, '', '#task/' + id);
  var first = $('#dTitle', d);
  if (first && !t.title && !t.note) first.focus();
}

function closeDrawer() {
  if (!openId) return;
  openId = null;
  $('#drawer').hidden = true;
  $('#drawer').innerHTML = '';
  $('#drawerScrim').hidden = true;
  /* Back to the tab the task was opened from, not always the board. Sending
     the URL to #board while the List tab is still on screen leaves the two
     disagreeing, and the Board button then looks broken: the hash is already
     what it wants to set, so nothing happens at all. */
  if ((location.hash || '').indexOf('#task/') === 0) {
    history.replaceState(null, '', '#' + (drawerReturn || currentTabName()));
  }
  drawerReturn = '';
}

function drawTaskDrawer(t) {
  var d = $('#drawer');
  d.innerHTML =
    '<div class="drawer-head">' +
    '<span class="status-badge" id="dBadge" style="--st:' + statusHue(t.status) + '">' + esc(statusLabel(t.status)) + '</span>' +
    (t.archived ? '<span class="status-badge archived-badge">Archived</span>' : '') +
    '<span class="spacer"></span>' +
    '<button class="mini" id="dCopyLink" title="Copy a link straight to this task">Link</button>' +
    '<button class="drawer-x" id="dClose" title="Close (Esc)">&times;</button>' +
    '</div>' +

    '<div class="dfield"><label for="dTitle">Title <span style="text-transform:none;letter-spacing:0">(optional)</span></label>' +
    '<input type="text" id="dTitle" maxlength="140" value="' + esc(t.title) + '" placeholder="Untitled"></div>' +

    '<div class="dfield"><label for="dNote">Note</label>' +
    '<textarea id="dNote" rows="6" placeholder="What is this task?">' + esc(t.note) + '</textarea></div>' +

    '<div class="dfield"><label>Status</label><div class="status-picker" id="dStatus">' +
    statuses().map(function (s) {
      return '<button data-st="' + s.id + '"' + (t.status === s.id ? ' class="on"' : '') + '>' + esc(s.label) + '</button>';
    }).join('') + '</div></div>' +

    '<div class="dfield"><label>Tags</label><div class="tag-editor" id="dTags"></div></div>' +

    '<div class="grid2">' +
    '<div class="dfield"><label for="dProject">Project</label>' +
    '<select id="dProject">' +
    '<option value="">No project</option>' +
    data.projects.map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (t.project === p.id ? ' selected' : '') + '>' +
        esc(p.name) + (p.archived ? ' (archived)' : '') + '</option>';
    }).join('') +
    '</select></div>' +
    '<div class="dfield"><label for="dPriority">Priority</label>' +
    '<select id="dPriority">' +
    ['low', 'normal', 'high'].map(function (p) {
      return '<option value="' + p + '"' + (t.priority === p ? ' selected' : '') + '>' +
        p.charAt(0).toUpperCase() + p.slice(1) + '</option>';
    }).join('') + '</select></div>' +
    '</div>' +

    '<div class="dfield"><label for="dDue">Due date</label>' +
    '<input type="date" id="dDue" value="' + esc(t.due) + '"></div>' +

    '<div class="dfield"><label>Comments</label>' +
    '<div id="dComments"></div>' +
    '<textarea id="dNewComment" rows="2" placeholder="Add a comment or a progress note..."></textarea>' +
    '<div class="row" style="margin-top:.4rem"><button class="mini primary" id="dAddComment">Add comment</button></div>' +
    '</div>' +

    '<div class="dfield"><label>History</label><ul class="activity" id="dActivity"></ul></div>' +

    '<div class="drawer-foot">' +
    (t.archived
      /* Permanent deletion is deliberately a second step, reachable only once
         a task is already out of the way. */
      ? '<button class="primary" id="dReopen">Reopen task</button>' +
        '<button class="danger" id="dDelete">Delete permanently</button>'
      : '<button id="dArchive">Archive task</button>') +
    '<span style="flex:1"></span>' +
    '<span class="hint" id="dSaved">Saved automatically</span>' +
    '</div>';

  drawTags(t);
  drawComments(t);
  drawActivity(t);
  wireDrawer(t);
}

function drawTags(t) {
  var host = $('#dTags');
  host.innerHTML = t.tags.map(function (g) {
    return '<span class="tag-chip">' + esc(g) + '<button data-untag="' + esc(g) + '" title="Remove tag">&times;</button></span>';
  }).join('') +
    '<input type="text" class="tag-input" id="dTagInput" placeholder="add tag, Enter" maxlength="32" list="dTagList">' +
    '<datalist id="dTagList">' + allTags().map(function (g) {
      return '<option value="' + esc(g.tag) + '"></option>';
    }).join('') + '</datalist>';
}

function drawComments(t) {
  var host = $('#dComments');
  if (!t.comments.length) {
    host.innerHTML = '<div class="hint" style="margin-bottom:.5rem">No comments yet.</div>';
    return;
  }
  host.innerHTML = t.comments.map(function (c) {
    return '<div class="comment"><div class="comment-body">' + esc(c.body) + '</div>' +
      '<div class="comment-when">' + esc(fmtWhen(c.created)) +
      '<button data-delcomment="' + esc(c.id) + '">delete</button></div></div>';
  }).join('');
}

function drawActivity(t) {
  var items = [{ at: t.created, what: 'Created' }].concat(
    t.activity.filter(function (a) { return a.what !== 'Created'; }));
  $('#dActivity').innerHTML = items.slice(-12).reverse().map(function (a) {
    return '<li>' + esc(a.what) + ' · ' + esc(fmtWhen(a.at)) + '</li>';
  }).join('');
}

function flashSaved() {
  var el = $('#dSaved');
  if (!el) return;
  el.textContent = 'Saved';
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(function () {
    if ($('#dSaved')) $('#dSaved').textContent = 'Saved automatically';
  }, 1200);
}

function wireDrawer(t) {
  var d = $('#drawer');

  $('#dClose', d).addEventListener('click', function () { closeDrawer(); });

  $('#dCopyLink', d).addEventListener('click', function () {
    var url = location.href.split('#')[0] + '#task/' + t.id;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { toast('Link copied'); },
        function () { toast(url); });
    } else { toast(url); }
  });

  /* Title and note save on a short debounce so typing is never interrupted by
     a re-render, and once more on blur in case the tab is closed mid-pause. */
  var deb;
  function saveText() {
    var nt = $('#dTitle', d), nn = $('#dNote', d);
    if (!nt || !nn) return;
    if (t.title === nt.value && t.note === nn.value) return;
    t.title = nt.value;
    t.note = nn.value;
    touch(t);
    save();
    renderBoard(); renderList(); renderCounts();
    flashSaved();
  }
  [$('#dTitle', d), $('#dNote', d)].forEach(function (el) {
    el.addEventListener('input', function () { clearTimeout(deb); deb = setTimeout(saveText, 500); });
    el.addEventListener('blur', function () { clearTimeout(deb); saveText(); });
  });

  $('#dStatus', d).addEventListener('click', function (e) {
    var b = e.target.closest('[data-st]');
    if (!b) return;
    /* Picking a lane for an archived task means you want it back: reopen it
       rather than quietly filing it into a lane nobody can see. */
    if (t.archived) {
      t.status = b.dataset.st;
      reopenTask(t.id);
      drawTaskDrawer(taskById(t.id));
      return;
    }
    setStatus(t.id, b.dataset.st);
    $$('#dStatus button', d).forEach(function (x) { x.classList.toggle('on', x === b); });
    var badge = $('#dBadge', d);
    badge.textContent = statusLabel(t.status);
    badge.style.setProperty('--st', statusHue(t.status));
    drawActivity(t);
    renderBoard(); renderList(); renderCounts();
    flashSaved();
  });

  $('#dTags', d).addEventListener('click', function (e) {
    var b = e.target.closest('[data-untag]');
    if (!b) return;
    t.tags = t.tags.filter(function (g) { return g !== b.dataset.untag; });
    touch(t); save();
    drawTags(t); wireTagInput(t);
    renderBoard(); renderList(); renderTags(); renderCounts();
    flashSaved();
  });
  wireTagInput(t);

  $('#dProject', d).addEventListener('change', function () {
    var from = projectName(t.project);
    t.project = this.value;
    logActivity(t, 'Moved to ' + projectName(t.project) + ' (from ' + from + ')');
    touch(t);
    /* The lane it lands in is a different lane, so give it a fresh position at
       the top rather than an order borrowed from the old project. */
    var lane = laneOf(t.project, t.status).filter(function (x) { return x.id !== t.id; });
    t.order = lane.length ? lane[0].order - 10 : 0;
    save();
    drawActivity(t);
    renderAll();
    flashSaved();
  });

  $('#dPriority', d).addEventListener('change', function () {
    t.priority = this.value; touch(t); save();
    renderBoard(); renderList(); flashSaved();
  });

  $('#dDue', d).addEventListener('change', function () {
    t.due = this.value || '';
    logActivity(t, t.due ? 'Due ' + fmtDate(t.due) : 'Due date cleared');
    touch(t); save();
    drawActivity(t);
    renderBoard(); renderList(); flashSaved();
  });

  function addComment() {
    var box = $('#dNewComment', d);
    var body = box.value.trim();
    if (!body) return;
    t.comments.push({ id: uid(), body: body, created: nowISO() });
    logActivity(t, 'Commented');
    touch(t); save();
    box.value = '';
    drawComments(t); drawActivity(t);
    renderBoard(); renderList();
    flashSaved();
  }
  $('#dAddComment', d).addEventListener('click', addComment);
  $('#dNewComment', d).addEventListener('keydown', function (e) {
    /* Ctrl/Cmd+Enter files the comment; a bare Enter keeps making paragraphs,
       because comments are the place people write more than one line. */
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addComment(); }
  });

  $('#dComments', d).addEventListener('click', function (e) {
    var b = e.target.closest('[data-delcomment]');
    if (!b) return;
    t.comments = t.comments.filter(function (c) { return c.id !== b.dataset.delcomment; });
    touch(t); save();
    drawComments(t);
    renderBoard(); renderList();
    flashSaved();
  });

  if ($('#dArchive', d)) {
    $('#dArchive', d).addEventListener('click', function () {
      var id = t.id;
      closeDrawer();
      archiveTask(id);
    });
  }
  if ($('#dReopen', d)) {
    $('#dReopen', d).addEventListener('click', function () {
      reopenTask(t.id);
      drawTaskDrawer(taskById(t.id));
    });
  }
  if ($('#dDelete', d)) {
    $('#dDelete', d).addEventListener('click', function () {
      if (!window.confirm('Permanently delete this task? Undo covers this for a few seconds and nothing after that.')) return;
      var id = t.id;
      closeDrawer();
      deleteTask(id);
    });
  }
}

function wireTagInput(t) {
  var inp = $('#dTagInput');
  if (!inp) return;
  function commit() {
    var g = cleanTag(inp.value);
    inp.value = '';
    if (!g || t.tags.indexOf(g) >= 0) return;
    t.tags.push(g);
    touch(t); save();
    drawTags(t); wireTagInput(t);
    $('#dTagInput').focus();
    renderBoard(); renderList(); renderTags(); renderCounts();
    flashSaved();
  }
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    if (e.key === 'Backspace' && !inp.value && t.tags.length) {
      t.tags.pop(); touch(t); save();
      drawTags(t); wireTagInput(t); $('#dTagInput').focus();
      renderBoard(); renderList(); renderTags();
    }
  });
  inp.addEventListener('blur', commit);
}

/* ── Drag and drop ────────────────────────────────────────────────────────
   Pointer events rather than HTML5 drag-and-drop, because the HTML5 API does
   not fire for touch at all. One code path serves mouse and finger:

     - mouse: a drag begins once the pointer has moved 6px with the button down
     - touch: a drag begins after a 380ms long press, so a normal swipe still
       scrolls the column and a normal tap still opens the task

   The card that is being dragged stays where it is at 30% opacity; a cloned
   'flying' copy follows the pointer, and a drop line shows where it will land. */
var drag = null;

/* `touch-action: pan-y` on a card is what lets a finger scroll the lane, but
   it also hands vertical panning to the browser, and a gesture the browser has
   claimed cannot be cancelled afterwards. On iPad that means a long press that
   becomes a drag still scrolls the page underneath it.

   So the moment a touch drag really starts, scrolling is blocked for the rest
   of that gesture by a non-passive touchmove listener. It has to be non-passive
   or preventDefault is ignored, and it has to be added at drag start rather
   than up front, or the board could never be scrolled with a finger at all. */
function blockTouchScroll(e) {
  if (e.cancelable) e.preventDefault();
}
function holdScroll(on) {
  if (on) {
    document.addEventListener('touchmove', blockTouchScroll, { passive: false });
  } else {
    document.removeEventListener('touchmove', blockTouchScroll, { passive: false });
  }
}

function cardUnderPoint(x, y, exceptEl) {
  var els = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
  for (var i = 0; i < els.length; i++) {
    var c = els[i] && els[i].closest ? els[i].closest('.card') : null;
    if (c && c !== exceptEl && !c.classList.contains('flying')) return c;
  }
  return null;
}
function colUnderPoint(x, y) {
  var els = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
  for (var i = 0; i < els.length; i++) {
    var c = els[i] && els[i].closest ? els[i].closest('.col') : null;
    if (c) return c;
  }
  return null;
}

function startDrag(card, x, y) {
  var r = card.getBoundingClientRect();
  var fly = card.cloneNode(true);
  fly.classList.add('flying');
  fly.style.width = r.width + 'px';
  fly.style.left = r.left + 'px';
  fly.style.top = r.top + 'px';
  document.body.appendChild(fly);

  var line = document.createElement('div');
  line.className = 'drop-line';

  /* A selection made just before the drag stays painted underneath it, so
     drop it. iOS in particular will have started one on the long press. */
  try {
    var sel = window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
  } catch (e) {}

  card.classList.add('dragging');
  holdScroll(true);
  /* A multi-card drag shows the whole group lifting, and the ghost carries the
     count so it is obvious how much is about to land. */
  if (isSelected(card.dataset.id) && selection.length > 1) {
    fly.setAttribute('data-count', selectedTasks().length);
    $$('#board .card.selected').forEach(function (c) { c.classList.add('dragging'); });
  }
  document.body.classList.add('dragging-card');

  drag.active = true;
  drag.fly = fly;
  drag.line = line;
  drag.dx = x - r.left;
  drag.dy = y - r.top;
  moveDrag(x, y);
}

function moveDrag(x, y) {
  drag.fly.style.left = (x - drag.dx) + 'px';
  drag.fly.style.top = (y - drag.dy) + 'px';

  /* Nudge the page (and, on a phone, the horizontal board) when the pointer
     reaches an edge, so a card can be dragged somewhere off screen. */
  var pad = 70;
  if (y < pad) window.scrollBy(0, -12);
  else if (y > window.innerHeight - pad) window.scrollBy(0, 12);
  var board = $('#board');
  if (board.scrollWidth > board.clientWidth) {
    var br = board.getBoundingClientRect();
    if (x < br.left + pad) board.scrollLeft -= 12;
    else if (x > br.right - pad) board.scrollLeft += 12;
  }

  var col = colUnderPoint(x, y);
  $$('.col').forEach(function (c) { c.classList.toggle('drop-into', c === col); });
  if (!col) { if (drag.line.parentNode) drag.line.parentNode.removeChild(drag.line); drag.before = undefined; return; }

  var body = $('.col-body', col);
  var over = cardUnderPoint(x, y, drag.card);
  if (over && over.parentNode === body) {
    var r = over.getBoundingClientRect();
    var after = y > r.top + r.height / 2;
    body.insertBefore(drag.line, after ? over.nextSibling : over);
    drag.before = after ? (over.nextElementSibling && over.nextElementSibling.dataset.id) || null : over.dataset.id;
  } else {
    body.appendChild(drag.line);
    drag.before = null;
  }
  drag.col = col.dataset.status;
}

function endDrag(commit) {
  holdScroll(false);
  if (drag.fly && drag.fly.parentNode) drag.fly.parentNode.removeChild(drag.fly);
  if (drag.line && drag.line.parentNode) drag.line.parentNode.removeChild(drag.line);
  $$('#board .card.dragging').forEach(function (c) { c.classList.remove('dragging'); });
  if (drag.card) drag.card.classList.remove('dragging');
  $$('.col').forEach(function (c) { c.classList.remove('drop-into'); });
  document.body.classList.remove('dragging-card');

  var id = drag.card && drag.card.dataset.id;
  var to = drag.col, before = drag.before;
  var wasActive = drag.active;
  drag = null;

  if (commit && wasActive && id && to) {
    var t = taskById(id);
    var moved = t && t.status !== to;
    /* Dragging a card that is part of a selection drags the whole selection,
       which is the only thing that would not surprise someone who just picked
       five cards on purpose. */
    if (isSelected(id) && selection.length > 1) {
      var ids = selectedTasks().map(function (x) { return x.id; });
      var n = selectedTasks().filter(function (x) { return x.status !== to; }).length;
      moveMany(ids, to, before || null);
      clearSelection(true);
      renderBoard(); renderList(); renderCounts();
      if (n) toast(plural(n, 'task') + ' → ' + statusLabel(to));
      return;
    }
    moveTask(id, to, before || null);
    renderBoard(); renderList(); renderCounts();
    if (moved) toast(statusLabel(to));
  }
}

function onPointerDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  var card = e.target.closest ? e.target.closest('.card') : null;
  if (!card || !$('#board').contains(card)) return;
  if (e.target.closest('button, a, input, textarea, select')) return;

  /* Shift (or ctrl/cmd) turns a click into a selection toggle rather than a
     drag or an open. Handled on the way down so the card responds instantly. */
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    e.preventDefault();
    toggleSelect(card.dataset.id);
    drag = null;
    return;
  }

  drag = {
    card: card, id: card.dataset.id, active: false,
    x0: e.clientX, y0: e.clientY,
    touch: e.pointerType === 'touch' || e.pointerType === 'pen',
    timer: null, pointerId: e.pointerId
  };
  /* Capture keeps the moves coming even when the pointer outruns the card.
     It throws if the pointer is already gone, which is harmless here. */
  try { card.setPointerCapture(e.pointerId); } catch (err) {}

  if (drag.touch) {
    /* Long press. A vertical swipe cancels it below, so the column still
       scrolls the way a list is expected to. */
    drag.timer = setTimeout(function () {
      if (!drag || drag.active) return;
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
      startDrag(drag.card, drag.x0, drag.y0);
    }, 380);
  }
}

function onPointerMove(e) {
  if (!drag) return;
  if (drag.active) {
    e.preventDefault();
    moveDrag(e.clientX, e.clientY);
    return;
  }
  var dx = Math.abs(e.clientX - drag.x0), dy = Math.abs(e.clientY - drag.y0);
  if (drag.touch) {
    /* Moved before the long press fired: this is a scroll, not a drag. */
    if (dx > 8 || dy > 8) { clearTimeout(drag.timer); drag = null; }
    return;
  }
  if (dx > 6 || dy > 6) startDrag(drag.card, e.clientX, e.clientY);
}

function onPointerUp(e) {
  if (!drag) return;
  clearTimeout(drag.timer);
  if (!drag.active) {
    /* A press that never became a drag is a tap: open the task. */
    var id = drag.id;
    drag = null;
    if (id) openTask(id);
    return;
  }
  e.preventDefault();
  endDrag(true);
}

function onPointerCancel() {
  if (!drag) return;
  clearTimeout(drag.timer);
  holdScroll(false);
  if (drag.active) endDrag(false); else drag = null;
}

/* ── Dropping things in from outside ──────────────────────────────────────
   Text, links, images and files dragged from another window, the desktop or
   another app land on a lane and become tasks there.

   This is the HTML5 drag-and-drop API, unlike the card dragging above, which
   is pointer-based. The two never collide: cards never fire `dragstart`, so
   anything arriving here came from outside the board.

   Everything a drop carries is untrusted text. It is stored as text and
   escaped at render like any other note; nothing here fetches a dropped URL
   or renders dropped markup. */

var MAX_DROP = 20;

/* A link drag carries markup as well as the URL, and that markup usually holds
   the one thing the URL does not: what the link was called. Parsed, never
   rendered - DOMParser does not run scripts, and only text and the src come
   back out. */
function dropMetaFromHTML(html) {
  var meta = { title: '', src: '' };
  if (!html || !window.DOMParser) return meta;
  try {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var a = doc.querySelector('a[href]');
    var img = doc.querySelector('img[src]');
    if (img) {
      meta.src = img.getAttribute('src') || '';
      meta.title = (img.getAttribute('alt') || '').trim();
    }
    if (a && !meta.title) meta.title = (a.textContent || '').trim().replace(/\s+/g, ' ');
    if (!meta.src && a) meta.src = a.getAttribute('href') || '';
    meta.title = meta.title.slice(0, 140);
  } catch (e) { /* malformed markup is just a drop with no title */ }
  return meta;
}

function htmlToText(html) {
  if (!html || !window.DOMParser) return '';
  try {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    return (doc.body.textContent || '').trim().replace(/\n{3,}/g, '\n\n');
  } catch (e) { return ''; }
}

function isURL(s) { return /^(https?|file|ftp):\/\/\S+$/i.test(s); }

/* Works out what a drop is worth as tasks. Returns [{title, note, tags}]. */
function tasksFromDrop(dt) {
  if (!dt) return [];
  var html = '';
  try { html = dt.getData('text/html') || ''; } catch (e) {}
  var plain = '';
  try { plain = (dt.getData('text/plain') || '').trim(); } catch (e) {}
  var uriRaw = '';
  try { uriRaw = dt.getData('text/uri-list') || dt.getData('URL') || ''; } catch (e) {}

  /* text/uri-list is newline separated and allows # comment lines */
  var uris = uriRaw.split(/\r?\n/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s && s.charAt(0) !== '#'; });
  var meta = dropMetaFromHTML(html);

  if (uris.length) {
    return uris.slice(0, MAX_DROP).map(function (u, i) {
      /* The link text titles the first one only: with several URLs the markup
         describes the set, not each member. */
      return { title: (i === 0 && meta.title && meta.title !== u) ? meta.title : '', note: u };
    });
  }

  /* A file from the desktop. The browser only ever exposes the name, never
     the path, and the file itself is far too big for localStorage, so the
     name is genuinely all there is to keep. */
  var files = dt.files ? Array.prototype.slice.call(dt.files) : [];
  if (files.length) {
    return files.slice(0, MAX_DROP).map(function (f) { return { title: '', note: f.name }; });
  }

  if (plain) {
    /* A bare URL dropped as text is still a URL, and must not have its
       fragment mistaken for a tag. */
    if (isURL(plain)) return [{ title: meta.title && meta.title !== plain ? meta.title : '', note: plain }];
    var parsed = parseEntry(plain);
    return [{ title: '', note: parsed.note, tags: parsed.tags,
              projectToken: parsed.projectToken }];
  }

  var text = htmlToText(html);
  if (text) {
    var p = parseEntry(text);
    return [{ title: '', note: p.note, tags: p.tags,
              projectToken: p.projectToken }];
  }
  return [];
}

function handleDrop(dt, status) {
  var made = tasksFromDrop(dt);
  if (!made.length) { toast('Nothing in that drop to make a task from'); return; }
  /* Dropped text can carry an @project too, so a link filed straight into
     another board never needs a second trip. */
  var moved = null;
  var created = made.map(function (m) {
    var target = projectForEntry(m);
    if (target.id !== currentProject()) moved = target.id;
    return addTask({
      project: target.id,
      title: m.title || '',
      note: m.note,
      tags: m.tags || [],
      status: status
    });
  });
  renderAll();
  if (moved) {
    toast(plural(created.length, 'task') + ' added to ' + projectName(moved),
      'Show', function () { ui.project = moved; saveUI(); renderAll(); });
  } else if (created.length === 1) {
    toast('Added to ' + statusLabel(status), 'Open', function () { openTask(created[0].id); });
  } else {
    toast(plural(created.length, 'task') + ' added to ' + statusLabel(status));
  }
}

/* ── Lanes: actions ───────────────────────────────────────────────────── */
function addStatus(label) {
  label = String(label || '').trim();
  if (!label) return null;
  var dupe = data.statuses.filter(function (s) {
    return s.label.toLowerCase() === label.toLowerCase();
  })[0];
  if (dupe) { toast('There is already a lane called ' + dupe.label); return null; }
  if (data.statuses.length >= 8) { toast('Eight lanes is the limit'); return null; }
  var st = {
    id: statusIdFor(label),
    label: label.slice(0, 40),
    /* Next unused colour, so a new lane never arrives invisible against its
       neighbour. */
    color: STATUS_COLORS.filter(function (c) {
      return !data.statuses.some(function (x) { return x.color === c; });
    })[0] || 'slate',
    terminal: false
  };
  data.statuses.push(st);
  save();
  return st;
}

/* Removing a lane must not remove its work: the tasks move to the first lane,
   which is the one that can never be deleted. */
function deleteStatus(st) {
  if (isBuiltin(st.id)) { toast(st.label + ' ships with every board and cannot be removed'); return; }
  var held = data.tasks.filter(function (t) { return t.status === st.id; });
  /* The first lane that will still be there afterwards. firstStatusId() is not
     good enough: a custom lane can be dragged to the front, and sending its
     tasks to "the first lane" would then send them to the very lane being
     removed, stranding them on a status nothing renders. */
  var left = data.statuses.filter(function (x) { return x.id !== st.id; });
  var to = left.length ? left[0].id : firstStatusId();
  var msg = held.length
    ? 'Remove the ' + st.label + ' lane? Its ' + plural(held.length, 'task') +
      ' will move to ' + statusLabel(to) + '.'
    : 'Remove the ' + st.label + ' lane?';
  if (!window.confirm(msg)) return;
  held.forEach(function (t) {
    t.status = to;
    logActivity(t, st.label + ' lane removed, moved to ' + statusLabel(to));
    touch(t);
  });
  data.statuses = data.statuses.filter(function (x) { return x.id !== st.id; });
  save();
  renderAll();
  toast(held.length ? 'Lane removed, ' + plural(held.length, 'task') + ' moved' : 'Lane removed');
}

function moveStatus(st, delta) {
  var i = data.statuses.indexOf(st);
  var j = i + delta;
  if (i < 0 || j < 0 || j >= data.statuses.length) return;
  data.statuses.splice(j, 0, data.statuses.splice(i, 1)[0]);
  save();
  renderAll();
}

/* ── Example tasks ────────────────────────────────────────────────────────
   A sample project someone can poke at without touching their own work. It is
   tagged with a fixed project id so Remove can find every piece of it again,
   and it never touches anything else. */
var EXAMPLE_PROJECT_ID = 'lb-example-project';

function exampleTasks() {
  var ids = statusIds();
  var mid = ids[1] || ids[0];
  var end = data.statuses.filter(function (s) { return s.terminal; })[0];
  var endId = end ? end.id : ids[ids.length - 1];
  var t = todayStr();
  var d = new Date(); d.setDate(d.getDate() + 3);
  function iso(x) { return x.toISOString(); }
  var soon = iso(d).slice(0, 10);
  var past = '2026-01-15';

  return [
    { note: 'Click any card to open it. Everything about a task lives in that panel: title, note, tags, project, due date, priority and comments.',
      title: 'Start here', status: ids[0], tags: ['example'], priority: 'high' },
    { note: 'Drag a card to another lane. On a phone or tablet, press and hold for a moment first, then drag.',
      status: ids[0], tags: ['example', 'drag'] },
    { note: 'Shift-click two or three cards, then use the bar that appears to move or archive them together.',
      status: ids[0], tags: ['example', 'drag'] },
    { note: 'This one is due today, so its date is highlighted.',
      status: ids[0], tags: ['example'], due: t },
    { note: 'This one is overdue, which is highlighted more loudly.',
      status: mid, tags: ['example'], due: past, priority: 'high' },
    { note: 'Type #tag in the quick-add box to tag a task, and @project to file it on another board, without leaving the keyboard.',
      title: 'Sigils', status: mid, tags: ['example', 'tips'], due: soon },
    { note: 'Comments keep a running thread on a task, and the panel logs every move it has made.',
      status: mid, tags: ['example'],
      comments: ['Left a note here so the card shows a comment count.',
                 'A second one, to prove the thread keeps its order.'] },
    { note: 'Finished work lands in the last lane. Archive all empties it in one go, and undo puts it back.',
      title: 'Closed work', status: endId, tags: ['example'] },
    { note: 'Drop text, a link or a file onto a lane and it becomes a task there.',
      status: endId, tags: ['example', 'tips'] },
    { note: 'An archived task. Find it under List, Status, Archived, and reopen it from there.',
      title: 'Archived example', status: endId, tags: ['example'], archived: true }
  ];
}

function addExamples() {
  if (projectById(EXAMPLE_PROJECT_ID)) {
    toast('The example project is already here');
    ui.project = EXAMPLE_PROJECT_ID; saveUI(); renderAll();
    return;
  }
  data.projects.push({
    id: EXAMPLE_PROJECT_ID, name: 'Example project',
    created: nowISO(), archived: false
  });
  exampleTasks().forEach(function (e, i) {
    var t = normalizeTask({
      id: 'lb-example-' + i,
      project: EXAMPLE_PROJECT_ID,
      title: e.title || '',
      note: e.note,
      tags: e.tags || [],
      status: e.status,
      due: e.due || '',
      priority: e.priority || 'normal',
      archived: !!e.archived,
      created: nowISO(),
      updated: nowISO()
    });
    t.order = i * 10;
    (e.comments || []).forEach(function (c) {
      t.comments.push({ id: uid(), body: c, created: nowISO() });
    });
    logActivity(t, 'Created');
    data.tasks.push(t);
  });
  ui.project = EXAMPLE_PROJECT_ID;
  saveUI();
  save();
  renderAll();
  goTab('board');
  toast('Example project added', 'Remove', removeExamples);
}

function removeExamples() {
  var n = data.tasks.filter(function (t) { return t.project === EXAMPLE_PROJECT_ID; }).length;
  if (!n && !projectById(EXAMPLE_PROJECT_ID)) { toast('No example tasks to remove'); return; }
  data.tasks = data.tasks.filter(function (t) { return t.project !== EXAMPLE_PROJECT_ID; });
  data.projects = data.projects.filter(function (p) { return p.id !== EXAMPLE_PROJECT_ID; });
  if (ui.project === EXAMPLE_PROJECT_ID) { ui.project = ''; saveUI(); }
  save();
  renderAll();
  toast('Example project removed');
}

/* ── Projects and tags: actions ───────────────────────────────────────── */
function addProject(name) {
  name = String(name || '').trim();
  if (!name) return null;
  var dupe = data.projects.filter(function (p) { return p.name.toLowerCase() === name.toLowerCase(); })[0];
  if (dupe) { toast('There is already a project called ' + dupe.name); return dupe; }
  var p = { id: uid(), name: name, created: nowISO(), archived: false };
  data.projects.push(p);
  save();
  return p;
}

function deleteProject(p) {
  var n = data.tasks.filter(function (t) { return t.project === p.id; }).length;
  var msg = n
    ? 'Delete "' + p.name + '"? Its ' + plural(n, 'task') + ' will be kept and filed under "No project".'
    : 'Delete "' + p.name + '"?';
  if (!window.confirm(msg)) return;
  data.tasks.forEach(function (t) {
    if (t.project === p.id) { t.project = ''; logActivity(t, 'Project deleted, task kept'); }
  });
  data.projects = data.projects.filter(function (x) { return x.id !== p.id; });
  if (ui.project === p.id) { ui.project = ''; saveUI(); }
  save();
  renderAll();
  toast(n ? 'Project deleted, ' + plural(n, 'task') + ' kept' : 'Project deleted');
}

function renameTagEverywhere(from, to) {
  to = cleanTag(to);
  if (!to || to === from) return;
  var n = 0;
  data.tasks.forEach(function (t) {
    if (t.tags.indexOf(from) < 0) return;
    t.tags = t.tags.filter(function (g) { return g !== from; });
    if (t.tags.indexOf(to) < 0) t.tags.push(to);
    touch(t); n++;
  });
  save(); renderAll();
  toast('Renamed on ' + plural(n, 'task'));
}

function removeTagEverywhere(tag) {
  var n = data.tasks.filter(function (t) { return t.tags.indexOf(tag) >= 0; }).length;
  if (!window.confirm('Remove #' + tag + ' from ' + plural(n, 'task') + '? The tasks stay.')) return;
  data.tasks.forEach(function (t) {
    if (t.tags.indexOf(tag) < 0) return;
    t.tags = t.tags.filter(function (g) { return g !== tag; });
    touch(t);
  });
  save(); renderAll();
  toast('Tag removed from ' + plural(n, 'task'));
}

/* ── Backup ───────────────────────────────────────────────────────────── */
/* listboard-YYYY-MM-DD-HHMMSS. Seconds are in there so two exports in the
   same minute cannot collide and get silently renamed to "(1)". */
/* ── Keeping the data alive ───────────────────────────────────────────────
   localStorage is not a promise. Browsers evict it under pressure, and Safari
   throws away script-written storage for a site you have not visited in about
   a week. Three things push back, none of which replaces a real backup:

   - persistent storage, which exempts the origin from that eviction
   - installing to the home screen, which exempts it in mobile Safari
   - saying out loud how long it has been since the last export

   Clearing site data by hand still wipes everything, and no web API can stop
   that. The exported file is the only copy that survives it. */

function persistSupported() {
  return !!(navigator.storage && navigator.storage.persist && navigator.storage.persisted);
}

function isInstalled() {
  return !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    navigator.standalone);
}

/* Chrome decides on the spot and usually says yes for a site with real
   engagement; Firefox prompts; Safari does not implement it at all. */
function askPersist() {
  if (!persistSupported()) { renderPersistStatus(); return; }
  navigator.storage.persist().then(function (granted) {
    renderPersistStatus();
    toast(granted
      ? 'This browser will keep your tasks unless you clear them yourself'
      : 'The browser declined for now. Try again after using the board a while.');
  }, function () { renderPersistStatus(); });
}

function renderPersistStatus() {
  var el = $('#persistStatus');
  if (!el) return;
  var btn = $('#btnPersist');
  if (!persistSupported()) {
    el.textContent = 'This browser does not offer persistent storage. ' +
      (isInstalled() ? 'It is installed to your home screen, which is the protection that matters here.'
        : 'Adding it to your home screen is the next best thing, and on iPhone and iPad it is the one that counts.');
    if (btn) btn.disabled = true;
    return;
  }
  navigator.storage.persisted().then(function (yes) {
    el.textContent = yes
      ? 'Storage is persistent: this browser will not evict your tasks to reclaim space.'
      : 'Storage is not persistent yet, so the browser may evict it to reclaim space.';
    if (btn) btn.disabled = yes;
  }, function () {});
}

function lastExportAt() {
  var raw = storageGet(KEY_LAST_EXPORT);
  if (!raw) return null;
  var d = new Date(raw);
  return isNaN(d) ? null : d;
}

function daysSinceExport() {
  var d = lastExportAt();
  if (!d) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function renderBackupAge() {
  var el = $('#backupAge');
  if (!el) return;
  var n = data.tasks.length;
  var days = daysSinceExport();
  if (!n) { el.textContent = 'Nothing to back up yet.'; el.classList.remove('warn-line'); return; }
  if (days === null) {
    el.innerHTML = '<b class="warn">No backup yet.</b> ' + plural(n, 'task') +
      ' live only in this browser.';
    el.classList.add('warn-line');
    return;
  }
  var when = fmtWhen(lastExportAt().toISOString());
  if (days >= BACKUP_NAG_DAYS) {
    el.innerHTML = '<b class="warn">Last backup was ' + plural(days, 'day') + ' ago</b>, on ' +
      esc(when) + '.';
    el.classList.add('warn-line');
  } else {
    el.textContent = 'Last backup ' +
      (days === 0 ? 'today' : days === 1 ? 'yesterday' : plural(days, 'day') + ' ago') +
      ', on ' + when + '.';
    el.classList.remove('warn-line');
  }
}

/* One reminder per session, and only when there is something to lose. */
var naggedBackup = false;
function maybeNagBackup() {
  if (naggedBackup) return;
  naggedBackup = true;
  if (data.tasks.length < 3) return;
  var days = daysSinceExport();
  if (days !== null && days < BACKUP_NAG_DAYS) return;
  toast(days === null
    ? 'These tasks have never been backed up'
    : 'Last backup was ' + plural(days, 'day') + ' ago',
    'Back up', function () { goTab('settings'); exportData(); });
}

/* ── Auto-save to a file ──────────────────────────────────────────────────
   The File System Access API hands back a handle to a file the user picked.
   The handle is structured-cloneable, so it can live in IndexedDB and outlast
   a reload, and Chrome can grant it permission for every visit. After one
   dialog the board writes itself to that file whenever it changes.

   Be honest about the limit: clearing site data takes the handle with it, the
   same as everything else. What it does not take is the file, which is the
   whole point. Point it at a synced folder and there is a copy off this
   machine that survives the browser entirely.

   Chromium desktop only. Firefox and every browser on iOS have no such API,
   so the panel simply never appears there and manual export stays the way. */

var IDB_NAME = 'listboard';
var IDB_STORE = 'kv';
var IDB_HANDLE_KEY = 'autosave-handle';
var AUTOSAVE_DEBOUNCE = 1500;

function autosaveSupported() {
  return !!(window.showSaveFilePicker && window.indexedDB);
}

function idb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = function () {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function idbDo(mode, fn) {
  return idb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(IDB_STORE, mode);
      var req = fn(tx.objectStore(IDB_STORE));
      tx.oncomplete = function () { resolve(req && req.result); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

var autosave = { handle: null, name: '', at: null, error: '', perm: 'granted', timer: null, busy: false };

function autosaveLoad() {
  if (!autosaveSupported()) return Promise.resolve();
  return idbDo('readonly', function (st) { return st.get(IDB_HANDLE_KEY); })
    .then(function (h) {
      if (!h) return;
      autosave.handle = h;
      autosave.name = h.name || 'a file';
      /* queryPermission never prompts. Asking for permission needs a user
         gesture, so whatever it reports is recorded and acted on from a
         button rather than nagged about on load.

         'prompt' here is the ordinary case, not a fault: browsers hand out
         file-write permission for the session, so a refresh drops back to
         asking unless the grant was made permanent in the browser's own
         dialog. 'denied' is the genuine problem. They read very differently
         and must not share a message. */
      return h.queryPermission({ mode: 'readwrite' }).then(function (state) {
        autosave.perm = state;
      });
    })
    .catch(function () { /* no handle, or storage refused: manual export stands */ })
    .then(renderAutosave);
}

function autosavePick() {
  if (!autosaveSupported()) return;
  window.showSaveFilePicker({
    /* Named for the site rather than just the app, so a file sitting in a
       folder months later still says where it came from. */
    suggestedName: 'listboard-github-io.json',
    types: [{ description: 'Listboard backup', accept: { 'application/json': ['.json'] } }]
  }).then(function (h) {
    autosave.handle = h;
    autosave.name = h.name || 'a file';
    autosave.error = '';
    return idbDo('readwrite', function (st) { return st.put(h, IDB_HANDLE_KEY); })
      .then(function () { return autosaveWrite(true); });
  }).catch(function (err) {
    /* Cancelling the dialog is not a failure. */
    if (err && err.name === 'AbortError') return;
    autosave.error = (err && err.message) || 'could not use that file';
    renderAutosave();
  });
}

function autosaveStop() {
  autosave.handle = null; autosave.name = ''; autosave.at = null;
  autosave.error = ''; autosave.perm = 'granted';
  clearTimeout(autosave.timer);
  idbDo('readwrite', function (st) { return st.delete(IDB_HANDLE_KEY); })
    .catch(function () {})
    .then(renderAutosave);
}

/* Writes the same payload the export button produces, so the file is a normal
   backup that Import already understands. */
function autosaveWrite(loud) {
  if (!autosave.handle || autosave.busy) return Promise.resolve();
  autosave.busy = true;
  var h = autosave.handle;
  return h.queryPermission({ mode: 'readwrite' }).then(function (state) {
    autosave.perm = state;
    if (state !== 'granted') throw new Error('permission');
    return h.createWritable();
  }).then(function (w) {
    return w.write(JSON.stringify(backupPayload(), null, 2)).then(function () { return w.close(); });
  }).then(function () {
    autosave.at = new Date();
    autosave.error = '';
    /* An automatic write is a real backup, so the age line and the reminder
       both count it. Otherwise the app would nag while dutifully saving. */
    storageSet(KEY_LAST_EXPORT, autosave.at.toISOString());
    renderBackupAge();
    if (loud) toast('Auto-saving to ' + autosave.name);
  }).catch(function (err) {
    if (!autosave.error) autosave.error = (err && err.message) || 'write failed';
  }).then(function () {
    autosave.busy = false;
    renderAutosave();
  });
}

/* Called on every save(). Debounced, because dragging a card fires several. */
function autosaveSchedule() {
  if (!autosave.handle) return;
  clearTimeout(autosave.timer);
  autosave.timer = setTimeout(function () { autosaveWrite(false); }, AUTOSAVE_DEBOUNCE);
}

function autosaveReconnect() {
  if (!autosave.handle) return;
  autosave.handle.requestPermission({ mode: 'readwrite' }).then(function (state) {
    autosave.perm = state;
    if (state === 'granted') { autosave.error = ''; return autosaveWrite(true); }
    renderAutosave();
  }).catch(function () { renderAutosave(); });
}

function renderAutosave() {
  var panel = $('#autosavePanel');
  if (!panel) return;
  if (!autosaveSupported()) { panel.hidden = true; return; }
  panel.hidden = false;

  var on = !!autosave.handle;
  $('#btnAutosavePick').textContent = on ? 'Choose a different file...' : 'Choose a file...';
  $('#btnAutosaveNow').hidden = !on;
  $('#btnAutosaveStop').hidden = !on;

  var el = $('#autosaveStatus');
  if (!on) {
    el.innerHTML = 'Not set up. Nothing is written anywhere until you pick a file.';
    return;
  }
  /* Paused, which is where a refresh normally leaves things. Said plainly,
     with the way to stop it happening every time. */
  if (autosave.perm === 'prompt') {
    el.innerHTML = 'Paused. Browsers allow writing to a file for one visit at a ' +
      'time, so this asks again after a refresh. ' +
      '<button class="mini" id="btnAutosaveReconnect">Resume</button>' +
      '<span class="hint" style="display:block;margin-top:.4rem">Choosing ' +
      '<b>Allow on every visit</b> in the browser prompt stops it asking again.</span>';
    $('#btnAutosaveReconnect').addEventListener('click', autosaveReconnect);
    return;
  }
  if (autosave.perm === 'denied') {
    el.innerHTML = '<b class="warn">This browser is blocking writes to ' +
      esc(autosave.name) + '.</b> Nothing is being saved to it. Allow file editing ' +
      'for this site in the browser settings, or pick the file again. ' +
      '<button class="mini" id="btnAutosaveReconnect">Try again</button>';
    $('#btnAutosaveReconnect').addEventListener('click', autosaveReconnect);
    return;
  }
  if (autosave.error) {
    el.innerHTML = '<b class="warn">' + esc(autosave.name) + ' could not be written:</b> ' +
      esc(autosave.error);
    return;
  }
  el.textContent = 'Saving to ' + autosave.name +
    (autosave.at ? ', last written ' + fmtWhen(autosave.at.toISOString()) : ', not written yet') + '.';
}

function stamp(d) {
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/* iPadOS reports itself as a Mac, so the touch points are the giveaway. */
function isAppleTouch() {
  var ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Mac/.test(ua) && navigator.maxTouchPoints > 1;
}

/* The anchor has to be in the document before it is clicked: a detached one
   is ignored outright by Firefox and unreliable elsewhere. */
function downloadFile(text, name) {
  var blob = new Blob([text], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    URL.revokeObjectURL(url);
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 1000);
}

/* One shape for every backup, so a file written automatically is the same
   thing Import already reads. */
function backupPayload() {
  return {
    app: 'listboard',
    version: SCHEMA,
    exported: nowISO(),
    theme: document.documentElement.className,
    statuses: data.statuses,
    projects: data.projects,
    tasks: data.tasks
  };
}

function exportData() {
  var now = new Date();
  var payload = backupPayload();
  /* Every export keeps its own name, so backups accumulate instead of the
     browser silently appending "(1)" and leaving you to guess which is newest. */
  var name = 'listboard-' + stamp(now) + '.json';
  var text = JSON.stringify(payload, null, 2);
  var done = 'Exported ' + plural(data.tasks.length, 'task') + ' to ' + name;
  storageSet(KEY_LAST_EXPORT, now.toISOString());
  renderBackupAge();

  /* On iPad and iPhone a plain download link is a dead end: Safari opens the
     JSON in a tab, or saves it under a name of its own choosing, and the
     stamped filename is lost. The share sheet hands over a real File, so
     "Save to Files" keeps the name. */
  if (isAppleTouch() && window.File && navigator.canShare) {
    var file = new File([text], name, { type: 'application/json' });
    if (navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).then(function () {
        $('#ioStatus').textContent = done;
      }, function (err) {
        /* Cancelling the sheet is not a failure worth shouting about. */
        if (err && err.name === 'AbortError') return;
        downloadFile(text, name);
        $('#ioStatus').textContent = done;
      });
      return;
    }
  }
  downloadFile(text, name);
  $('#ioStatus').textContent = done;
}

function importData(file) {
  var reader = new FileReader();
  reader.onload = function () {
    var incoming;
    try { incoming = JSON.parse(reader.result); } catch (e) {
      $('#ioStatus').textContent = 'That file is not valid JSON.'; return;
    }
    if (!incoming || !Array.isArray(incoming.tasks)) {
      $('#ioStatus').textContent = 'That file has no Listboard tasks in it.'; return;
    }
    /* Merge, never replace. A task already here is only overwritten by a copy
       that says it was updated later, so importing an old backup cannot undo
       today's work. */
    var addedP = 0, addedT = 0, updatedT = 0, addedS = 0;
    /* Lanes come across before tasks, or a task filed under an incoming lane
       would be bounced to the first one on the way in. Existing lanes keep
       their own label and colour: this machine's board wins on presentation,
       the file only contributes lanes that are missing entirely. */
    (Array.isArray(incoming.statuses) ? incoming.statuses : []).forEach(function (st) {
      if (!st || !st.id || statusById(st.id)) return;
      data.statuses.push({
        id: String(st.id),
        label: String(st.label || st.id).slice(0, 40),
        color: STATUS_COLORS.indexOf(st.color) >= 0 ? st.color : 'slate',
        terminal: !!st.terminal
      });
      addedS++;
    });
    (Array.isArray(incoming.projects) ? incoming.projects : []).forEach(function (p) {
      if (!p || !p.id || projectById(p.id)) return;
      data.projects.push({
        id: String(p.id), name: String(p.name || 'Untitled'),
        created: p.created || nowISO(), archived: !!p.archived
      });
      addedP++;
    });
    incoming.tasks.forEach(function (raw) {
      if (!raw || !raw.id) return;
      var t = normalizeTask(raw);
      var have = taskById(t.id);
      if (!have) { data.tasks.push(t); addedT++; return; }
      if ((t.updated || '') > (have.updated || '')) {
        var i = data.tasks.indexOf(have);
        data.tasks[i] = t;
        updatedT++;
      }
    });
    save();
    if (incoming.theme === 'light' || incoming.theme === 'dark') setTheme(incoming.theme);
    renderAll();
    $('#ioStatus').textContent = (addedT || updatedT || addedP || addedS)
      ? 'Imported: ' + addedT + ' new, ' + updatedT + ' updated, ' + addedP +
        ' new projects' + (addedS ? ', ' + plural(addedS, 'new lane') : '') + '.'
      : 'Nothing to add; this file matched what is already here.';
    toast('Backup imported');
  };
  reader.readAsText(file);
}

/* ── Quick add ────────────────────────────────────────────────────────── */
/* Works out which project a parsed entry belongs to. An @token that matches
   nothing creates the project, the same way an unseen #tag simply starts
   existing; `made` says so, so the caller can offer a way back. */
function projectForEntry(parsed) {
  if (!parsed.projectToken) return { id: currentProject(), made: null, revived: null };
  var hit = matchProject(parsed.projectToken);
  if (hit) {
    /* Naming an archived project by hand means you are using it again. Filing
       into it while it stays archived would drop the task straight out of
       every board, which looks exactly like losing it. */
    var revived = null;
    if (hit.archived) {
      hit.archived = false;
      revived = hit;
      save();
    }
    return { id: hit.id, made: null, revived: revived };
  }
  var p = addProject(parsed.projectToken);
  return p ? { id: p.id, made: p, revived: null } : { id: currentProject(), made: null, revived: null };
}

function quickAdd() {
  var box = $('#quickNote');
  var text = box.value.trim();
  if (!text) { box.focus(); return; }
  var parsed = parseEntry(text);
  var target = projectForEntry(parsed);
  var t = addTask({
    project: target.id,
    note: parsed.note,
    tags: parsed.tags,
    status: 'new'
  });
  box.value = '';
  autoGrow(box);
  renderAll();

  /* A brand new project is the one outcome worth being able to take back:
     "@listbaord" should not quietly leave a typo in the nav for ever. */
  if (target.made) {
    toast('Added to a new project, ' + target.made.name, 'Undo', function () {
      data.tasks = data.tasks.filter(function (x) { return x.id !== t.id; });
      data.projects = data.projects.filter(function (x) { return x.id !== target.made.id; });
      if (ui.project === target.made.id) { ui.project = ''; saveUI(); }
      save();
      renderAll();
      box.value = text;
      autoGrow(box);
      box.focus();
      toast('Undone, and the text is back in the box');
    });
    return;
  }

  if (target.revived) {
    toast('Added to ' + target.revived.name + ', unarchived to take it', 'Show', function () {
      ui.project = target.id;
      saveUI();
      renderAll();
    });
    return;
  }

  /* Filed somewhere other than the board in front of you: say where it went,
     and offer to follow it. */
  if (target.id !== currentProject()) {
    toast('Added to ' + projectName(target.id), 'Show', function () {
      ui.project = target.id;
      saveUI();
      renderAll();
    });
    return;
  }
  toast('Added to New', 'Open', function () { openTask(t.id); });
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + 'px';
}

/* ── Wiring ───────────────────────────────────────────────────────────── */
function init() {
  /* Seed a first project so an empty install has somewhere obvious to put
     things. Only ever on a truly empty board, never on a cleared one. */
  if (!data.projects.length && !data.tasks.length && !storageGet(KEY_DATA)) {
    data.projects.push({ id: uid(), name: 'General', created: nowISO(), archived: false });
    ui.project = data.projects[0].id;
    save(); saveUI();
  }

  setTheme(storageGet(KEY_THEME) === 'light' ? 'light' : 'dark');

  /* Tabs */
  $$('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      var name = b.dataset.tab;
      /* On a phone the Settings button is the More tab and opens the sheet
         instead of a page. */
      if (name === 'settings' && window.matchMedia('(max-width: 700px)').matches) {
        var sheet = $('#moreSheet');
        var openNow = !sheet.classList.contains('open');
        sheet.classList.toggle('open', openNow);
        b.classList.toggle('sheet-open', openNow);
        return;
      }
      goTab(name);
    });
  });
  $$('.more-tile').forEach(function (b) {
    b.addEventListener('click', function () { goTab(b.dataset.more); });
  });

  /* Board */
  $('#projectPicker').addEventListener('change', function () {
    if (this.value === '__new') {
      var name = window.prompt('Name the new project');
      var p = name && addProject(name);
      ui.project = p ? p.id : currentProject();
    } else {
      ui.project = this.value;
    }
    saveUI();
    /* Switching board is where a filter stops making sense, so this is where
       it is cleared, rather than inside a render. */
    boardFilter.tag = '';
    boardFilter.project = null;
    boardFilter.q = '';
    boardFilter.not = noExclusions();
    $('#boardSearch').value = '';
    selection = [];
    renderAll();
  });
  $('#btnQuickAdd').addEventListener('click', quickAdd);
  $('#quickNote').addEventListener('input', function () { autoGrow(this); });
  $('#quickNote').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); quickAdd(); }
  });
  $('#boardSearch').addEventListener('input', function () {
    applyBoardSearch(this.value);
  });
  $('#boardProjChips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-bproj]');
    if (!b) return;
    /* The All chip and the No project chip both carry an empty value, so they
       are told apart by the marker rather than by the value. */
    var want = b.dataset.all ? null : b.dataset.bproj;
    boardFilter.project = (boardFilter.project === want && want !== null) ? null : want;
    renderBoard();
  });
  $('#boardTagChips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-btag]');
    if (!b) return;
    boardFilter.tag = boardFilter.tag === b.dataset.btag ? '' : b.dataset.btag;
    renderBoard();
  });
  $('#board').addEventListener('click', function (e) {
    if (e.target.closest('[data-showall]')) { ui.showAllDone = true; saveUI(); renderBoard(); return; }
    var aa = e.target.closest('[data-archiveall]');
    if (aa) {
      /* The lane that was clicked, and exactly what it is showing, so a
         filtered board cannot archive something off screen. */
      var lid = aa.closest('.col').dataset.status;
      var closed = laneOf(currentProject(), lid).filter(matchesBoard);
      if (!closed.length) { toast('Nothing in ' + statusLabel(lid) + ' to archive'); return; }
      archiveMany(closed, 'task');
    }
  });

  /* Selection bar */
  $('#selBar').addEventListener('click', function (e) {
    var mv = e.target.closest('[data-selmove]');
    if (mv) {
      var picked = selectedTasks();
      var to = mv.dataset.selmove;
      var n = picked.filter(function (t) { return t.status !== to; }).length;
      moveMany(picked.map(function (t) { return t.id; }), to, null);
      clearSelection(true);
      renderAll();
      toast(plural(n, 'task') + ' → ' + statusLabel(to));
      return;
    }
    if (e.target.closest('[data-selarchive]')) { archiveMany(selectedTasks()); return; }
    if (e.target.closest('#selClear')) clearSelection(true);
  });

  /* Cards: pointer drag, with a plain tap falling through to opening one */
  var board = $('#board');
  board.addEventListener('pointerdown', onPointerDown);
  board.addEventListener('pointermove', onPointerMove);
  board.addEventListener('pointerup', onPointerUp);
  board.addEventListener('pointercancel', onPointerCancel);
  board.addEventListener('contextmenu', function (e) {
    /* A long press on a phone would otherwise raise the text menu mid-drag */
    if (drag && drag.active) e.preventDefault();
  });

  /* Dropping text, links, images and files in from outside.

     The document-level handlers are the safety net: without them a URL
     dropped anywhere else on the page makes the browser navigate away from
     the app, which is a horrible surprise even though nothing is lost. */
  function dropCarriesSomething(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    return Array.prototype.indexOf.call(types, 'text/plain') >= 0 ||
      Array.prototype.indexOf.call(types, 'text/uri-list') >= 0 ||
      Array.prototype.indexOf.call(types, 'text/html') >= 0 ||
      Array.prototype.indexOf.call(types, 'Files') >= 0;
  }

  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) { e.preventDefault(); });

  var dropDepth = 0;
  board.addEventListener('dragenter', function (e) {
    if (!dropCarriesSomething(e)) return;
    e.preventDefault();
    dropDepth++;
    board.classList.add('drop-armed');
  });
  board.addEventListener('dragover', function (e) {
    if (!dropCarriesSomething(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    var col = e.target.closest ? e.target.closest('.col') : null;
    $$('.col').forEach(function (c) { c.classList.toggle('drop-create', c === col); });
  });
  board.addEventListener('dragleave', function () {
    /* dragleave fires for every child crossed, so count entries and exits
       rather than clearing on the first one. */
    dropDepth = Math.max(0, dropDepth - 1);
    if (!dropDepth) clearDropState();
  });
  board.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var col = e.target.closest ? e.target.closest('.col') : null;
    clearDropState();
    /* Dropped on the board but between the lanes: New is where new things go. */
    handleDrop(e.dataTransfer, col ? col.dataset.status : 'new');
  });

  function clearDropState() {
    dropDepth = 0;
    board.classList.remove('drop-armed');
    $$('.col').forEach(function (c) { c.classList.remove('drop-create'); });
  }

  /* List */
  $('#listSearch').addEventListener('input', function () {
    /* Only the exclusions are sigils here. A positive #tag or @project is a
       chip on this page, so typing one stays an ordinary text search. */
    var cut = parseExclusions(this.value);
    listFilter.q = cut.rest.toLowerCase();
    listFilter.not = cut.not;
    renderList();
  });
  $('#tab-list').addEventListener('click', function (e) {
    var re = e.target.closest('[data-reopen]');
    if (re) { reopenTask(re.dataset.reopen); return; }
    var b = e.target.closest('[data-lproj], [data-lstatus], [data-ltag]');
    if (b) {
      if (b.dataset.lproj !== undefined) listFilter.project = b.dataset.lproj;
      if (b.dataset.lstatus !== undefined) listFilter.status = b.dataset.lstatus;
      if (b.dataset.ltag !== undefined) listFilter.tag = b.dataset.ltag;
      renderList();
      return;
    }
    var row = e.target.closest('.trow');
    if (row) openTask(row.dataset.id);
  });
  $('#btnClearListFilters').addEventListener('click', function () {
    listFilter = blankListFilter();
    $('#listSearch').value = '';
    renderList();
  });

  /* Projects */
  $('#btnAddProject').addEventListener('click', function () {
    var inp = $('#newProjectName');
    var p = addProject(inp.value);
    if (p) { inp.value = ''; ui.project = p.id; saveUI(); renderAll(); toast('Project added'); }
  });
  $('#newProjectName').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('#btnAddProject').click(); }
  });
  $('#projectRows').addEventListener('click', function (e) {
    var b = e.target.closest('[data-pact]');
    if (!b) return;
    var p = projectById(b.closest('[data-pid]').dataset.pid);
    if (!p) return;
    if (b.dataset.pact === 'open') { ui.project = p.id; saveUI(); renderAll(); goTab('board'); }
    if (b.dataset.pact === 'rename') {
      var name = window.prompt('Rename project', p.name);
      if (name && name.trim()) { p.name = name.trim(); save(); renderAll(); }
    }
    if (b.dataset.pact === 'archive') {
      p.archived = !p.archived;
      if (p.archived && ui.project === p.id) { ui.project = ''; saveUI(); }
      save(); renderAll();
      toast(p.archived ? 'Archived. Its tasks are untouched.' : 'Unarchived');
    }
    if (b.dataset.pact === 'delete') deleteProject(p);
  });

  /* Tags */
  $('#tagRows').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tact]');
    if (!b) return;
    var tag = b.closest('[data-tag]').dataset.tag;
    if (b.dataset.tact === 'filter') {
      listFilter = blankListFilter({ tag: tag });
      $('#listSearch').value = '';
      renderList();
      goTab('list');
    }
    if (b.dataset.tact === 'rename') {
      var to = window.prompt('Rename #' + tag + ' to', tag);
      if (to) renameTagEverywhere(tag, to);
    }
    if (b.dataset.tact === 'remove') removeTagEverywhere(tag);
  });

  /* Lanes */
  $('#btnAddStatus').addEventListener('click', function () {
    var inp = $('#newStatusName');
    var st = addStatus(inp.value);
    if (st) { inp.value = ''; renderAll(); toast('Lane added: ' + st.label); }
  });
  $('#newStatusName').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('#btnAddStatus').click(); }
  });
  $('#statusRows').addEventListener('change', function (e) {
    var el = e.target.closest('[data-sact]');
    if (!el) return;
    var st = statusById(el.closest('[data-sid]').dataset.sid);
    if (!st) return;
    if (el.dataset.sact === 'color') { st.color = el.value; save(); renderAll(); }
    if (el.dataset.sact === 'terminal') { st.terminal = el.checked; save(); renderAll(); }
  });
  $('#statusRows').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-sact]');
    if (!b) return;
    var st = statusById(b.closest('[data-sid]').dataset.sid);
    if (!st) return;
    if (b.dataset.sact === 'up') moveStatus(st, -1);
    if (b.dataset.sact === 'down') moveStatus(st, 1);
    if (b.dataset.sact === 'delete') deleteStatus(st);
    if (b.dataset.sact === 'rename') {
      var name = window.prompt('Rename lane', st.label);
      if (name && name.trim()) { st.label = name.trim().slice(0, 40); save(); renderAll(); }
    }
  });

  /* Settings */
  $('#btnExamples').addEventListener('click', addExamples);
  $('#btnRemoveExamples').addEventListener('click', removeExamples);
  $('#btnThemeDark').addEventListener('click', function () { setTheme('dark'); });
  $('#btnThemeLight').addEventListener('click', function () { setTheme('light'); });
  $('#btnExport').addEventListener('click', exportData);
  $('#btnImport').addEventListener('click', function () { $('#importFile').click(); });
  $('#importFile').addEventListener('change', function () {
    if (this.files && this.files[0]) importData(this.files[0]);
    this.value = '';
  });

  /* The import zone takes a dropped backup as well as a click. It sits inside
     the document-level drop guard added for the board, so it has to claim the
     event itself. */
  var zone = $('#importDrop');
  zone.addEventListener('click', function () { $('#importFile').click(); });
  zone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#importFile').click(); }
  });
  zone.addEventListener('dragover', function (e) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
  zone.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('over');
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) { $('#ioStatus').textContent = 'That drop had no file in it.'; return; }
    /* Checked by name rather than by type: a .json dragged out of some file
       managers arrives with an empty or invented MIME type. importData reads
       the contents anyway and says so if they are not a backup. */
    if (!/\.json$/i.test(f.name)) {
      $('#ioStatus').textContent = 'Backups are .json files. "' + f.name + '" is not one.';
      return;
    }
    importData(f);
  });
  $('#btnArchiveClosed').addEventListener('click', function () {
    /* Every project, unlike the board's own Archive all, which is scoped to
       the lane in front of you. */
    var closed = liveTasks().filter(function (t) { return isTerminal(t.status); });
    if (!closed.length) { toast('Nothing closed to archive'); return; }
    archiveMany(closed, 'closed task');
  });
  $('#btnViewArchive').addEventListener('click', function () {
    listFilter = blankListFilter({ status: 'archived' });
    $('#listSearch').value = '';
    renderList();
    goTab('list');
  });
  $('#btnPurgeArchived').addEventListener('click', function () {
    var n = archivedTasks().length;
    if (!n) { toast('The archive is empty'); return; }
    if (!window.confirm('Permanently delete ' + plural(n, 'archived task') + '? This cannot be undone.')) return;
    data.tasks = liveTasks();
    save(); renderAll();
    toast(plural(n, 'task') + ' deleted');
  });
  $('#btnResetAll').addEventListener('click', function () {
    if (!window.confirm('Delete every task and project in this browser? This cannot be undone.')) return;
    if (!window.confirm('Really delete everything? Export a backup first if you are not sure.')) return;
    data = emptyData();
    ui = {};
    save(); saveUI(); renderAll();
    toast('Everything deleted');
  });

  /* Drawer */
  $('#drawerScrim').addEventListener('click', closeDrawer);

  /* Keyboard */
  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === 'Escape') {
      if (openId) { closeDrawer(); return; }
      if ($('#moreSheet').classList.contains('open')) { closeMore(); return; }
      if (selection.length) { clearSelection(true); return; }
      if (typing) document.activeElement.blur();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'n') {
      e.preventDefault();
      goTabThenFocus('board', '#quickNote');
    }
    if (e.key === '/') {
      e.preventDefault();
      /* Search where you already are, if that page has a search. Anywhere
         else, the board's filter is the one people mean. */
      if (onTab('list')) { focusField('#listSearch'); return; }
      goTabThenFocus('board', '#boardSearch');
    }
  });

  $('#btnPersist').addEventListener('click', askPersist);
  $('#btnAutosavePick').addEventListener('click', autosavePick);
  $('#btnAutosaveNow').addEventListener('click', function () { autosaveWrite(true); });
  $('#btnAutosaveStop').addEventListener('click', autosaveStop);
  renderAutosave();
  autosaveLoad();
  /* About links through to Settings for the things it only describes. */
  $('#tab-about').addEventListener('click', function (e) {
    var b = e.target.closest('[data-goto]');
    if (b) location.hash = b.dataset.goto;
  });
  renderPersistStatus();
  /* After first paint, so the reminder never lands on a blank screen. */
  setTimeout(maybeNagBackup, 1200);

  wireAutocomplete('#quickNote');
  wireAutocomplete('#boardSearch', 'ok');
  wireAutocomplete('#listSearch', 'only');
  /* The menu is pinned to the viewport, so anything that moves the field has
     to take it down rather than leave it floating somewhere wrong. */
  window.addEventListener('resize', acClose);
  window.addEventListener('scroll', acClose, true);

  window.addEventListener('hashchange', route);
  renderAll();
  route();
}

document.addEventListener('DOMContentLoaded', init);
