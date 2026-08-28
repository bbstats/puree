# Get your own Meal Planner (free, ~10 minutes)

Your meal data lives in **your own** Google spreadsheet — nobody else can see it.
You'll copy the template, click a few buttons, and end up with a private app link
for your household.

## What you need
- A Google account (a normal @gmail.com is fine)
- 10 minutes on a laptop (easier than a phone for the one-time setup)

## Steps

1. **Copy the template.** Open the "Make a copy" link you were given and click
   **Make a copy**. You now own a spreadsheet called "Copy of Meal Planner Template" —
   rename it if you like.

2. **Run setup.** In your new spreadsheet's menu bar, click **🍽️ Meal Planner →
   Finish setup**. (If you don't see the menu, wait a few seconds and reload the page.)
   - Google will ask for permission. You'll see a scary "Google hasn't verified this app"
     screen — that's normal for personal scripts. Click **Advanced → Go to … (unsafe) →
     Allow**. It's your own copy of the code, running in your own account, touching only
     this spreadsheet.

3. **Publish your app.** A helper panel opens on the right with numbered steps —
   follow them (Extensions → Apps Script → Deploy → New deployment → Web app,
   "Execute as: Me", "Who has access: Anyone"). Copy the Web app URL it gives you.

4. **Get your link.** Paste that URL into the helper panel and click
   **Check & get my app link**. It hands you your personal app link — open it,
   bookmark it, and on Android use Chrome's **⋮ → Add to Home screen**.
   Share the link with everyone in your house; you all see the same pantry.

## Using it day to day
- Add **recipes** and **ingredients** directly in the spreadsheet (there are two example
  recipes showing the format — the Ingredients column is just comma-separated names).
- Every ingredient gets a **category** via the dropdown in its row.
- Want new cuisines/proteins/categories in the app's menus? Add them on the **Lists** tab.
- The app: **Pantry** tracks what you have; open a **Meal**, adjust what you're low on,
  hit **Plan**; **Week** shows your dinners; **Needed** is your shopping list.

## FAQ
- **"Anyone" access?!** The URL contains a ~70-character random key — nobody finds it
  without you sharing it. It also can only read/write this one spreadsheet.
- **Something broke?** 🍽️ Meal Planner → **Start fresh** resets the spreadsheet to the
  example data.
