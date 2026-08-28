/**
 * Household Meal Planner — server side.
 * Bound to a Google Spreadsheet that acts as the database.
 * v5
 */

var SHEET_ING = 'Ingredients';
var SHEET_REC = 'Recipes';
var SHEET_WEEK = 'Week';
var SHEET_LISTS = 'Lists';

var STATUSES = ['Have It', 'Running Low', 'Out'];
var ING_CATEGORIES = ['Dairy', 'Meat', 'Vegetable', 'Fruit', 'Grain', 'Condiment', 'Spice', 'Frozen', 'Canned', 'Other', 'Uncategorized'];
var DISH_CATEGORIES = ['American', 'Asian', 'Italian', 'Mexican', 'Other'];
var PROTEINS = ['Beef', 'Chicken', 'Pork', 'Fish', 'Vegetarian', 'Other'];
var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Public site that serves the app UI (set once GitHub Pages is live)
var SITE_URL = 'https://bbstats.github.io/meal-planner/';

// ---------------------------------------------------------------- web app

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('Meal Planner')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------------------------------------------------------------- JSON API
// Used by the static site: POST {fn, args} with Content-Type text/plain
// (a "simple" request, so no CORS preflight, which Apps Script can't answer).

var API = {
  ping: function () { return { ok: true, app: 'meal-planner' }; },
  getAllData: function () { return getAllData(); },
  saveStatuses: function (changes) { return saveStatuses(changes); },
  planMeal: function (recipeName, choice, allowReplace) { return planMeal(recipeName, choice, allowReplace); },
  unplanMeal: function (date) { return unplanMeal(date); },
  addIngredient: function (name, category) { return addIngredient(name, category); }
};

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    if (!API.hasOwnProperty(req.fn)) throw new Error('Unknown function: ' + req.fn);
    out = API[req.fn].apply(null, req.args || []);
    if (out === undefined) out = { ok: true };
  } catch (err) {
    out = { error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- guided setup menu

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🍽️ Meal Planner')
    .addItem('Finish setup', 'finishSetup')
    .addItem('Setup helper (get my app link)', 'showSidebar')
    .addSeparator()
    .addItem('Start fresh (reset to example data)', 'startFresh')
    .addToUi();
}

function finishSetup() {
  setupSpreadsheet();
  showSidebar();
}

function showSidebar() {
  SpreadsheetApp.getUi().showSidebar(
    HtmlService.createHtmlOutputFromFile('sidebar').setTitle('Meal Planner setup'));
}

/** Wipe all data in this spreadsheet and restore the example data. */
function startFresh() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert('Start fresh',
    'This wipes ALL ingredients, recipes, and planned meals in this spreadsheet and restores the example data. Continue?',
    ui.ButtonSet.OK_CANCEL);
  if (resp !== ui.Button.OK) return;
  var ss = SpreadsheetApp.getActive();
  [SHEET_ING, SHEET_REC, SHEET_WEEK, SHEET_LISTS].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) sh.clear();
  });
  setupSpreadsheet();
  ui.alert('Done! Fresh example data is in place.');
}

/** Called from the setup sidebar: verify a pasted web-app URL really serves this app. */
function checkAppUrl(url) {
  url = String(url || '').trim();
  if (url.indexOf('https://script.google.com/macros/') !== 0) {
    return { ok: false, reason: 'That doesn\'t look like a web app URL — it should start with https://script.google.com/macros/…' };
  }
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'text/plain',
      payload: JSON.stringify({ fn: 'ping' }),
      muteHttpExceptions: true,
      followRedirects: true
    });
    var data = JSON.parse(resp.getContentText());
    if (data && data.app === 'meal-planner') {
      return { ok: true, link: SITE_URL + '?app=' + encodeURIComponent(url) };
    }
    return { ok: false, reason: 'That URL responded, but not with this app. Double-check you copied the "Web app" URL from the deploy dialog.' };
  } catch (err) {
    return { ok: false, reason: 'Could not reach that URL (' + err + '). Is the deployment set to "Anyone"?' };
  }
}

/** Setup info for the sidebar; execUrl is prefilled when Apps Script can tell us. */
function getSetupInfo() {
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  if (url.slice(-4) !== '/exec') url = '';
  return { execUrl: url, siteUrl: SITE_URL };
}

// ---------------------------------------------------------------- one-time setup

/**
 * Run this once from the Apps Script editor after creating the project.
 * Creates all tabs, headers, dropdown validations, and example data.
 * Safe to re-run: it only seeds sheets that are empty.
 */
function setupSpreadsheet() {
  var ss = SpreadsheetApp.getActive();

  // Lists tab (feeds every dropdown and the app's filter menus)
  var lists = getOrCreateSheet_(ss, SHEET_LISTS);
  if (lists.getLastRow() === 0) {
    lists.getRange(1, 1, 1, 4)
      .setValues([['Ingredient Categories', 'Dish Categories', 'Proteins', 'Statuses']])
      .setFontWeight('bold');
    writeColumn_(lists, 1, ING_CATEGORIES);
    writeColumn_(lists, 2, DISH_CATEGORIES);
    writeColumn_(lists, 3, PROTEINS);
    writeColumn_(lists, 4, STATUSES);
    lists.setFrozenRows(1);
  }

  // Ingredients tab
  var ing = getOrCreateSheet_(ss, SHEET_ING);
  if (ing.getLastRow() === 0) {
    ing.getRange(1, 1, 1, 3)
      .setValues([['Ingredient', 'Category', 'Status']])
      .setFontWeight('bold');
    ing.setFrozenRows(1);
    var sampleIngredients = [
      ['Chicken Breast', 'Meat', 'Have It'],
      ['Soy Sauce', 'Condiment', 'Running Low'],
      ['Rice', 'Grain', 'Have It'],
      ['Broccoli', 'Vegetable', 'Out'],
      ['Garlic', 'Vegetable', 'Have It'],
      ['Ground Beef', 'Meat', 'Have It'],
      ['Spaghetti', 'Grain', 'Have It'],
      ['Crushed Tomatoes', 'Canned', 'Have It'],
      ['Onion', 'Vegetable', 'Running Low'],
      ['Parmesan', 'Dairy', 'Have It']
    ];
    ing.getRange(2, 1, sampleIngredients.length, 3).setValues(sampleIngredients);
  }
  setDropdown_(ing, 2, lists.getRange('A2:A200')); // Category
  setDropdown_(ing, 3, lists.getRange('D2:D20'));  // Status

  // Recipes tab
  var rec = getOrCreateSheet_(ss, SHEET_REC);
  if (rec.getLastRow() === 0) {
    rec.getRange(1, 1, 1, 6)
      .setValues([['Recipe', 'Link', 'Prep Time (min)', 'Dish Category', 'Protein', 'Ingredients']])
      .setFontWeight('bold');
    rec.setFrozenRows(1);
    rec.getRange(2, 1, 2, 6).setValues([
      ['Chicken Teriyaki', 'https://www.allrecipes.com/recipe/128532/simple-teriyaki-chicken/', 30, 'Asian', 'Chicken',
        'Chicken Breast, Soy Sauce, Rice, Broccoli, Garlic'],
      ['Spaghetti Bolognese', 'https://www.allrecipes.com/recipe/158140/spaghetti-bolognese/', 45, 'Italian', 'Beef',
        'Ground Beef, Spaghetti, Crushed Tomatoes, Onion, Garlic, Parmesan']
    ]);
    rec.setColumnWidth(2, 260);
    rec.setColumnWidth(6, 360);
  }
  setDropdown_(rec, 4, lists.getRange('B2:B200')); // Dish Category
  setDropdown_(rec, 5, lists.getRange('C2:C200')); // Protein

  // Week tab (written by the app on 'Plan')
  var week = getOrCreateSheet_(ss, SHEET_WEEK);
  if (week.getLastRow() === 0) {
    week.getRange(1, 1, 1, 3)
      .setValues([['Date', 'Day', 'Recipe']])
      .setFontWeight('bold');
    week.setFrozenRows(1);
  }
  week.getRange('A:A').setNumberFormat('@'); // keep dates as plain yyyy-MM-dd strings

  // Drop the default empty tab if it's still around
  var sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() === 0 && ss.getSheets().length > 4) {
    ss.deleteSheet(sheet1);
  }
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function writeColumn_(sheet, col, values) {
  sheet.getRange(2, col, values.length, 1).setValues(values.map(function (v) { return [v]; }));
}

function setDropdown_(sheet, col, sourceRange) {
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(sourceRange, true)
    .setAllowInvalid(true)
    .build();
  sheet.getRange(2, col, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
}

// ---------------------------------------------------------------- read API

/**
 * Everything the app needs in one call.
 */
function getAllData() {
  var ss = SpreadsheetApp.getActive();
  var ingredients = readIngredients_(ss);
  var recipes = readRecipes_(ss);

  // Auto-create any recipe ingredient the pantry hasn't seen yet
  // (status "Have It", category "Uncategorized" — categorize it in the Sheet).
  var known = {};
  ingredients.forEach(function (i) { known[i.name.toLowerCase()] = true; });
  var missing = [];
  recipes.forEach(function (r) {
    r.ingredients.forEach(function (n) {
      var key = n.toLowerCase();
      if (!known[key]) {
        known[key] = true;
        missing.push(n);
      }
    });
  });
  if (missing.length) {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var sh = ss.getSheetByName(SHEET_ING);
      var rows = missing.map(function (n) { return [n, 'Uncategorized', 'Have It']; });
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
    } finally {
      lock.releaseLock();
    }
    ingredients = readIngredients_(ss);
  }

  var weekDates = currentWeekDates_();
  return {
    ingredients: ingredients,
    recipes: recipes,
    week: readWeek_(ss, weekDates),
    weekDates: weekDates,
    today: todayStr_(),
    lists: readLists_(ss)
  };
}

function readIngredients_(ss) {
  var sh = ss.getSheetByName(SHEET_ING);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues()
    .filter(function (r) { return String(r[0]).trim() !== ''; })
    .map(function (r) {
      return {
        name: String(r[0]).trim(),
        category: String(r[1]).trim() || 'Uncategorized',
        status: normalizeStatus_(r[2])
      };
    });
}

function readRecipes_(ss) {
  var sh = ss.getSheetByName(SHEET_REC);
  if (!sh || sh.getLastRow() < 2) return [];
  var n = sh.getLastRow() - 1;
  var values = sh.getRange(2, 1, n, 6).getValues();
  var rich = sh.getRange(2, 2, n, 1).getRichTextValues();
  var out = [];
  for (var i = 0; i < n; i++) {
    var name = String(values[i][0]).trim();
    if (!name) continue;
    var link = String(values[i][1]).trim();
    if (!/^https?:\/\//i.test(link)) {
      // Cell may be display text with an attached hyperlink
      var url = rich[i][0] && rich[i][0].getLinkUrl();
      if (url) link = url;
    }
    out.push({
      name: name,
      link: link,
      prepTime: Number(values[i][2]) || 0,
      dishCategory: String(values[i][3]).trim() || 'Other',
      protein: String(values[i][4]).trim() || 'Other',
      ingredients: String(values[i][5]).split(',')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s !== ''; })
    });
  }
  return out;
}

function readWeek_(ss, weekDates) {
  var sh = ss.getSheetByName(SHEET_WEEK);
  if (!sh || sh.getLastRow() < 2) return [];
  var inWeek = {};
  weekDates.forEach(function (d) { inWeek[d.date] = true; });
  return sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues()
    .map(function (r) {
      return { date: cellDateStr_(r[0]), day: String(r[1]), recipe: String(r[2]).trim() };
    })
    .filter(function (e) { return inWeek[e.date] && e.recipe !== ''; });
}

function readLists_(ss) {
  var sh = ss.getSheetByName(SHEET_LISTS);
  var result = {
    ingredientCategories: ING_CATEGORIES,
    dishCategories: DISH_CATEGORIES,
    proteins: PROTEINS
  };
  if (!sh || sh.getLastRow() < 2) return result;
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  var col = function (c) {
    return values.map(function (r) { return String(r[c]).trim(); })
      .filter(function (v) { return v !== ''; });
  };
  var a = col(0), b = col(1), c = col(2);
  if (a.length) result.ingredientCategories = a;
  if (b.length) result.dishCategories = b;
  if (c.length) result.proteins = c;
  return result;
}

// ---------------------------------------------------------------- write API

/**
 * Batch-update ingredient statuses. changes: [{name, status}]
 * Unknown ingredients are appended (category "Uncategorized").
 */
function saveStatuses(changes) {
  if (!changes || !changes.length) return { ok: true };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_ING);
    var last = sh.getLastRow();
    var rowByName = {};
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r, i) {
        rowByName[String(r[0]).trim().toLowerCase()] = i + 2;
      });
    }
    var appends = [];
    changes.forEach(function (ch) {
      var status = normalizeStatus_(ch.status);
      var row = rowByName[String(ch.name).trim().toLowerCase()];
      if (row) {
        sh.getRange(row, 3).setValue(status);
      } else {
        appends.push([String(ch.name).trim(), 'Uncategorized', status]);
      }
    });
    if (appends.length) {
      sh.getRange(sh.getLastRow() + 1, 1, appends.length, 3).setValues(appends);
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Plan a dinner. choice: 'auto' or a day name ('Sun'..'Sat').
 * allowReplace: overwrite an already-planned day.
 */
function planMeal(recipeName, choice, allowReplace) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActive();
    var sh = ss.getSheetByName(SHEET_WEEK);
    var weekDates = currentWeekDates_();
    var today = todayStr_();

    // Existing plan rows for this week, keyed by date
    var existing = {};
    if (sh.getLastRow() >= 2) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r, i) {
        var d = cellDateStr_(r[0]);
        if (weekDates.some(function (w) { return w.date === d; }) && String(r[2]).trim() !== '') {
          existing[d] = { row: i + 2, recipe: String(r[2]).trim() };
        }
      });
    }

    var target;
    if (choice === 'auto') {
      var open = weekDates.filter(function (w) { return w.date >= today && !existing[w.date]; });
      if (!open.length) open = weekDates.filter(function (w) { return !existing[w.date]; });
      if (!open.length) return { ok: false, reason: 'full' };
      target = open[Math.floor(Math.random() * open.length)];
    } else {
      target = weekDates.filter(function (w) { return w.day === choice; })[0];
      if (!target) return { ok: false, reason: 'badday' };
      var taken = existing[target.date];
      if (taken && taken.recipe !== recipeName && !allowReplace) {
        return { ok: false, reason: 'conflict', day: target.day, existingRecipe: taken.recipe };
      }
    }

    if (existing[target.date]) {
      sh.getRange(existing[target.date].row, 3).setValue(recipeName);
    } else {
      sh.getRange(sh.getLastRow() + 1, 1, 1, 3)
        .setValues([[target.date, target.day, recipeName]]);
    }
    return { ok: true, day: target.day, date: target.date };
  } finally {
    lock.releaseLock();
  }
}

/** Remove a planned dinner by its yyyy-MM-dd date. */
function unplanMeal(date) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_WEEK);
    if (sh.getLastRow() < 2) return { ok: true };
    var values = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      if (cellDateStr_(values[i][0]) === date) sh.deleteRow(i + 2);
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function addIngredient(name, category) {
  name = String(name || '').trim();
  if (!name) return { ok: false, reason: 'empty' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_ING);
    if (sh.getLastRow() >= 2) {
      var names = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < names.length; i++) {
        if (String(names[i][0]).trim().toLowerCase() === name.toLowerCase()) {
          return { ok: false, reason: 'exists' };
        }
      }
    }
    sh.getRange(sh.getLastRow() + 1, 1, 1, 3)
      .setValues([[name, category || 'Uncategorized', 'Have It']]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- helpers

function normalizeStatus_(v) {
  var s = String(v).trim().toLowerCase();
  if (s === 'out') return 'Out';
  if (s === 'running low' || s === 'low') return 'Running Low';
  return 'Have It';
}

function todayStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Sun..Sat of the current week as [{date: 'yyyy-MM-dd', day: 'Sun'}, ...] */
function currentWeekDates_() {
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var dayIdx = Number(Utilities.formatDate(now, tz, 'u')) % 7; // u: Mon=1..Sun=7 -> Sun=0
  // Anchor to midday so DST transitions can't shift the formatted date
  var base = now.getTime() + (12 - Number(Utilities.formatDate(now, tz, 'H'))) * 3600000;
  var out = [];
  for (var i = 0; i < 7; i++) {
    var d = new Date(base + (i - dayIdx) * 24 * 60 * 60 * 1000);
    out.push({ date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'), day: DAY_NAMES[i] });
  }
  return out;
}

/** Week-sheet Date cells are text, but handle real Dates too. */
function cellDateStr_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v).trim();
}
