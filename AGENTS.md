# Guide for AI assistants (Muse and others)

This repo holds two personal web apps for Kaysen Stevens, hosted on Netlify as static files. There is no build step, no package.json, and no server.

| Path | App | What it is |
|---|---|---|
| `index.html` | D2D Tracker | Solar door-to-door sales tracker. Large single file; don't touch it unless asked. |
| `recruit/index.html` | Recruit CRM | Tracks people Kaysen could recruit into his life insurance agency. Served at `/recruit/`. |
| `tools/crm.mjs` | CRM data CLI | Read and write the Recruit CRM's cloud data directly (see below). |

## How the Recruit CRM is built

- One HTML file: CSS in `<style>`, all JS in one `<script>`, no framework, no modules. Keep it that way. Load outside libraries only from a CDN `<script>` tag.
- Icons: Tabler webfont (`<i class="ti ti-name">`).
- Colors: CSS variables on `:root`, in a dark theme that matches the D2D Tracker. Use the variables and don't hard-code colors.
- Rendering: `render()` rebuilds the current view from `state` with template strings. Pass every user-provided value through `esc()`.
- Mutations follow one pattern: change `state` → `touchR(r)` on each recruit you changed → `save()` → `render()`.
- `save()` writes to `localStorage` (`recruit_crm_v1`) and, when signed in, to Firestore after an 800ms debounce.
- Views: `today`, `board`, `stats`, `templates`, `import`, `muse`. Pop-ups use `openSheet(html)` / `closeSheet()`.
- It must work well on a phone (390px wide, bottom nav) and on desktop (sidebar). Check both.

### Key logic (don't break these)

- Today's list sorts by `contactSort`: never-contacted recruits first, then oldest `lastTouchAt`.
- Due: a recruit is due when `nextAt` (a snooze) has arrived; otherwise when `lastTouchAt` plus the warm or cold interval (`settings.warmDays` / `settings.coldDays`) has arrived. Never-contacted recruits are always due.
- `logTouch()` moves a Prospect to Reached Out automatically. Type `note` doesn't count as contact.
- `maxStage` is the furthest stage index ever reached, and the Stats funnel uses it. Dead doesn't lower it.
- Sync merges by recruit `id`, and the higher `updatedAt` wins. Deleted ids go into `state.deleted` so they don't come back.

## Data format

Firestore document `recruit_crm/{firebase uid}`, field `state` = `JSON.stringify(state)`:

```jsonc
{
  "v": 1,
  "settings": { "me": "Kaysen", "warmDays": 2, "coldDays": 1 },
  "templates": [{ "id": "…", "name": "Warm opener", "body": "Hey {first}, …" }],
  "deleted": ["<ids of deleted recruits>"],
  "recruits": [{
    "id": "unique string",
    "name": "Jake Peterson",            // required
    "phone": "", "email": "", "city": "", "instagram": "", "howKnow": "", "referredBy": "", "notes": "",
    "source": "d2d | social | referral | other",
    "temp": "warm | cold",
    "stage": "prospect | reached | interview_set | interview_had | committed | licensed | dead",
    "maxStage": 0,                      // index into the stage list above, never goes down
    "createdAt": 0, "updatedAt": 0,     // ms timestamps
    "lastTouchAt": null, "lastReplyAt": null,
    "nextAt": null,                     // snooze: next touch date (ms, start of day)
    "interviewAt": null,                // when stage is interview_set
    "deadAt": null, "reviveAt": null, "deadReason": "",  // when stage is dead; reviveAt null = never revisit
    "touches": [                        // newest first
      { "id": "…", "at": 0, "type": "text | call | dm | inperson | note | stage", "note": "", "replied": false }
    ]
  }]
}
```

Template placeholders: `{first}`, `{name}`, `{me}`, `{interview}`.

## Reading and editing the data

**Option A: through the app (any AI chat).** In the app's Muse tab, Kaysen taps **Copy for Muse** to copy a readable snapshot plus instructions. Muse replies with `{"changes": [...]}`. Kaysen pastes the reply back, previews it, and applies it. The supported ops are listed in `musePrompt()` and implemented in `applyOps()`. If you add an op, update both.

**Option B: directly (when you can run code).**

```bash
export FIREBASE_API_KEY=… FIREBASE_PROJECT_ID=… CRM_EMAIL=… CRM_PASSWORD=…
node tools/crm.mjs pull            # writes recruits.json
# edit recruits.json
node tools/crm.mjs push            # uploads it; refuses if the app changed the data since your pull
```

Rules for direct edits:
- New recruits need a unique `id` (e.g. `Date.now().toString(36) + random`), a `name`, a `stage`, a `temp`, and `touches: []`.
- Log contact by adding a touch at the front of `touches` and setting `lastTouchAt`. Also set `lastReplyAt` if they replied, and clear `nextAt`.
- When you change a stage, add a `stage` touch with the note `"Old Label → New Label"`.
- `push` stamps `updatedAt` and records deletions for you. It also saves a backup in `backups/`.
- Never delete recruits unless Kaysen asks. Never commit `recruits.json`, `backups/`, or credentials (they're in `.gitignore`).

## Testing changes to the app

```bash
python3 -m http.server 8765    # then open http://localhost:8765/recruit/
```

Click through Today, Board, Stats, Templates, Import, and Muse at desktop width and at 390px wide, and check the browser console for errors. Firebase sync needs a real project, but everything else works offline with localStorage.
