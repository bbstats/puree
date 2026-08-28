# Household Meal Planner

A tiny web app for planning the week's dinners and tracking the pantry, backed entirely by a
Google Sheet — free, no servers, and the "database" is a spreadsheet you can edit by hand.

Works on Android (Chrome → "Add to Home screen") and any laptop browser. One shared pantry
per household: anyone with the household's app link sees and edits the same data.

**Architecture (two halves):**
- **UI**: a static site at https://bbstats.github.io/meal-planner/ (this repo's `docs/`
  folder via GitHub Pages). It stores no data; each device connects it to a household's
  own endpoint (`?app=<exec-url>` link or paste box, kept in localStorage).
- **Data**: each household's own Google spreadsheet with the bound Apps Script in this
  repo, deployed as an anonymous web app that answers JSON (`doPost` in `Code.js`).
  Households are fully independent — see `SHARE.md` for the copy-the-template setup.

## What's in here

| File | Purpose |
|---|---|
| `docs/` | The static site (GitHub Pages): `index.html`, `app.js`, `styles.css`, PWA manifest + icons |
| `appsscript.json` | Apps Script manifest (web app config) |
| `Code.js` | Server: spreadsheet setup, JSON API (`doPost`), guided-setup menu (appears as `Code.gs` in the editor) |
| `sidebar.html` | In-spreadsheet setup helper (deploy steps + app-link generator) |
| `index.html` / `styles.html` / `app-js.html` | Legacy HtmlService version of the UI, still served at the `/exec` URL as a fallback (shows Google's banner) |
| `SHARE.md` | Novice-friendly instructions for setting up your own household |

## Setup — option A: clasp (recommended, keeps code in this folder)

Requires Node.js.

```
npm install -g @google/clasp
clasp login
```

Then enable the Apps Script API for your account (one time):
https://script.google.com/home/usersettings → "Google Apps Script API" → On.

From this folder:

```
clasp create --type sheets --title "Meal Planner"
clasp push -f
clasp open
```

`clasp create` makes a new Google Spreadsheet with a bound script; `clasp push -f` uploads
these files; `clasp open` opens the script editor. Continue with **First run** below.

## Setup — option B: no tools, copy/paste

1. Go to https://sheets.google.com and create a blank spreadsheet named "Meal Planner".
2. In the sheet: **Extensions → Apps Script**.
3. In the editor:
   - Replace the contents of `Code.gs` with `Code.js` from this folder.
   - **+ → HTML** three times, named exactly `index`, `styles`, `app-js`; paste in the
     matching files.
   - **Project Settings → check "Show appsscript.json"**, then paste in `appsscript.json`.
4. Continue with **First run**.

## First run

1. In the Apps Script editor, select the function **`setupSpreadsheet`** in the toolbar and
   hit **Run**. Approve the authorization prompt (it's your own script touching your own
   sheet). This creates the four tabs — `Ingredients`, `Recipes`, `Week`, `Lists` — with
   dropdowns and two example recipes.
2. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone** (the URL is unguessable; only people you give it to find it)
3. Copy the web app URL. Open it on your phone and laptop; on Android use Chrome's
   **⋮ → Add to Home screen** to get an app icon.
4. Optional: in `appsscript.json` (or Project Settings), set your time zone so "today" and
   week boundaries are right — it defaults to `America/New_York`.

If you later change the code, push again (`clasp push -f`) and use
**Deploy → Manage deployments → ✏️ → New version** so the same URL picks up the update.

## The spreadsheet is the database

### `Ingredients` — one row per pantry item

| Ingredient | Category | Status |
|---|---|---|
| Chicken Breast | Meat | Have It |
| Soy Sauce | Condiment | Running Low |

- **Category** and **Status** are dropdowns fed from the `Lists` tab, so spellings stay
  consistent. That's how ingredients get their category: pick it from the dropdown when you
  add a row (or when adding from the app's "+ Add ingredient" button).
- Status is only ever **Have It / Running Low / Out**.

### `Recipes` — one row per meal

| Recipe | Link | Prep Time (min) | Dish Category | Protein | Ingredients |
|---|---|---|---|---|---|
| Chicken Teriyaki | https://… | 30 | Asian | Chicken | Chicken Breast, Soy Sauce, Rice, Broccoli, Garlic |
| Spaghetti Bolognese | https://… | 45 | Italian | Beef | Ground Beef, Spaghetti, Crushed Tomatoes, Onion, Garlic, Parmesan |

- **Link** can be anything clickable: a recipe website, a Google Photos link to a photo of a
  cookbook page, or a Google Doc with the recipe typed out.
- **Ingredients** is a comma-separated list. Names should match the `Ingredients` tab; if you
  use a new name, the app auto-adds it to the pantry as **Uncategorized / Have It** — set its
  real category in the sheet when you notice it.

### `Week`
Written by the app when you hit **Plan**. You normally don't touch it, but you can.

### `Lists`
The allowed values for every dropdown and every filter menu in the app (ingredient
categories, dish categories, proteins). **Add a value here** (e.g. a "Thai" dish category)
and it shows up everywhere — no code changes.

## Using the app

- **Pantry** — filter by category/status, sort by category, status, or name. Tap a status
  pill to cycle Have It → Running Low → Out.
- **Meals** — filter by cuisine/protein, sort by prep time. Each card shows how many
  ingredients you're missing. Tap a meal: recipe link at the very top, ingredients listed
  most-needed first, tap pills to adjust availability. **Save** updates the pantry;
  **Plan** updates the pantry *and* asks which day — "Choose for me" (default) picks a
  random open day from today onward, or pick a specific day (it asks before replacing an
  already-planned day).
- **Week** — this week's dinners, Sun–Sat, today highlighted. Tap a meal to reopen it,
  ✕ to unplan it.
