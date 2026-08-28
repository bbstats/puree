(function () {
  'use strict';

  // ------------------------------------------------------------ endpoint plumbing
  // The site holds no data. Each household connects it to their own Apps Script
  // web app URL, remembered per-device in localStorage.

  var APP_KEY = 'mealPlannerAppUrl';
  var URL_PREFIX = 'https://script.google.com/macros/';
  var APP_URL = null;

  function getStoredUrl() {
    try { return localStorage.getItem(APP_KEY); } catch (e) { return null; }
  }
  function storeUrl(url) {
    try { localStorage.setItem(APP_KEY, url); } catch (e) {}
  }
  function clearUrl() {
    try { localStorage.removeItem(APP_KEY); } catch (e) {}
  }

  var db = null;              // { ingredients, recipes, week, weekDates, today, lists }
  var currentTab = 'pantry';
  var pantryFilter = { category: 'All', status: 'All', sort: 'Category' };
  var mealFilter = { dishCategory: 'All', protein: 'All', sort: 'Name' };
  var openRecipe = null;      // recipe object shown in meal detail
  var mealEdits = {};         // ingredient name -> status (local edits in detail view)
  var mealOrder = [];         // snapshot ordering of detail ingredient list
  var cameFrom = 'meals';
  var pendingDay = null;      // day tapped from an empty Week slot; preselects it when planning
  var savingCount = 0;

  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------ server calls

  function call(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    setSaving(1);
    return fetch(APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fn, args: args }),
      redirect: 'follow'
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.error) throw new Error(data.error);
        return data;
      })
      .then(
        function (d) { setSaving(-1); return d; },
        function (e) { setSaving(-1); throw e; }
      );
  }

  function setSaving(delta) {
    savingCount = Math.max(0, savingCount + delta);
    $('saving').hidden = savingCount === 0;
  }

  // ------------------------------------------------------------ helpers

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var STATUS_ORDER = ['Have It', 'Running Low', 'Out'];

  function statusClass(s) {
    return s === 'Out' ? 'out' : (s === 'Running Low' ? 'low' : 'have');
  }
  function statusRank(s) { // lower = more urgent
    return s === 'Out' ? 0 : (s === 'Running Low' ? 1 : 2);
  }
  function nextStatus(s) {
    return STATUS_ORDER[(STATUS_ORDER.indexOf(s) + 1) % 3];
  }
  function pantryStatus(name) {
    var hit = db.ingredients.filter(function (i) {
      return i.name.toLowerCase() === name.toLowerCase();
    })[0];
    return hit ? hit.status : 'Have It';
  }
  function shortDate(iso) { // '2026-08-30' -> '8/30'
    var p = iso.split('-');
    return Number(p[1]) + '/' + Number(p[2]);
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  function selectHtml(id, options, selected, allLabel) {
    var opts = allLabel ? ['All'].concat(options) : options;
    return '<select id="' + id + '">' + opts.map(function (o) {
      var label = (o === 'All' && allLabel) ? allLabel : o;
      return '<option value="' + esc(o) + '"' + (o === selected ? ' selected' : '') + '>' +
        esc(label) + '</option>';
    }).join('') + '</select>';
  }

  // ------------------------------------------------------------ navigation

  function switchTab(tab) {
    // A day tapped in Week only stays "pending" while picking a meal for it
    if (tab !== 'meals' && tab !== 'meal') pendingDay = null;
    currentTab = tab;
    ['pantry', 'meals', 'week', 'shop', 'meal'].forEach(function (v) {
      $('view-' + v).hidden = (v !== tab);
    });
    document.querySelectorAll('.tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    var titles = { pantry: 'Pantry', meals: 'Meals', week: 'This Week', shop: 'Needed This Week', meal: 'Meal' };
    $('viewTitle').textContent = tab === 'meal' && openRecipe ? '' : titles[tab];
    if (tab === 'pantry') renderPantry();
    if (tab === 'meals') renderMeals();
    if (tab === 'week') renderWeek();
    if (tab === 'shop') renderShop();
    if (tab === 'meal') renderMealDetail();
    window.scrollTo(0, 0);
  }

  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.dataset.tab); });
  });

  // ------------------------------------------------------------ pantry

  function renderPantry() {
    var view = $('view-pantry');
    var cats = db.lists.ingredientCategories.slice();
    db.ingredients.forEach(function (i) {
      if (cats.indexOf(i.category) === -1) cats.push(i.category);
    });

    var items = db.ingredients.filter(function (i) {
      return (pantryFilter.category === 'All' || i.category === pantryFilter.category) &&
             (pantryFilter.status === 'All' || i.status === pantryFilter.status);
    });

    var html = '<div class="filterbar">' +
      selectHtml('pf-cat', cats, pantryFilter.category, 'All categories') +
      selectHtml('pf-status', STATUS_ORDER, pantryFilter.status, 'All statuses') +
      selectHtml('pf-sort', ['Category', 'Status', 'Name'], pantryFilter.sort) +
      '</div>';

    if (!items.length) {
      html += '<div class="empty">No ingredients match. Add some below or in the Google Sheet.</div>';
    } else if (pantryFilter.sort === 'Category') {
      var byCat = {};
      items.forEach(function (i) { (byCat[i.category] = byCat[i.category] || []).push(i); });
      cats.forEach(function (c) {
        if (!byCat[c]) return;
        byCat[c].sort(function (a, b) { return a.name.localeCompare(b.name); });
        html += '<div class="group-head">' + esc(c) + '</div><div class="card">' +
          byCat[c].map(function (i) { return pantryRow(i, false); }).join('') + '</div>';
      });
    } else {
      items.sort(pantryFilter.sort === 'Status'
        ? function (a, b) { return statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name); }
        : function (a, b) { return a.name.localeCompare(b.name); });
      html += '<div class="card">' +
        items.map(function (i) { return pantryRow(i, true); }).join('') + '</div>';
    }

    html += '<div class="fab-row"><button class="btn primary wide" id="addIngBtn">+ Add ingredient</button></div>' +
      '<div class="switch-link"><a href="#" id="switchHousehold">Switch household</a></div>';
    view.innerHTML = html;

    $('pf-cat').onchange = function () { pantryFilter.category = this.value; renderPantry(); };
    $('pf-status').onchange = function () { pantryFilter.status = this.value; renderPantry(); };
    $('pf-sort').onchange = function () { pantryFilter.sort = this.value; renderPantry(); };
    $('addIngBtn').onclick = openAddModal;
    $('switchHousehold').onclick = function (e) {
      e.preventDefault();
      if (confirm('Disconnect this device from the current household? You\'ll need the app URL to reconnect.')) {
        clearUrl();
        location.reload();
      }
    };

    view.querySelectorAll('.pill[data-ing]').forEach(function (btn) {
      btn.addEventListener('click', function () { cyclePantry(btn.dataset.ing); });
    });
  }

  function pantryRow(i, showCat) {
    return '<div class="row"><div><div class="name">' + esc(i.name) + '</div>' +
      (showCat ? '<div class="sub">' + esc(i.category) + '</div>' : '') + '</div>' +
      '<button class="pill ' + statusClass(i.status) + '" data-ing="' + esc(i.name) + '">' +
      esc(i.status) + '</button></div>';
  }

  /** Cycle an ingredient's pantry status, re-render via rerender(), sync to server. */
  function cycleStatus(name, rerender) {
    var item = db.ingredients.filter(function (i) {
      return i.name.toLowerCase() === name.toLowerCase();
    })[0];
    var prev = item ? item.status : null;
    var next = nextStatus(prev || 'Have It');
    if (item) item.status = next;
    else db.ingredients.push({ name: name, category: 'Uncategorized', status: next });
    rerender();
    call('saveStatuses', [{ name: name, status: next }]).catch(function (e) {
      if (item) item.status = prev;
      rerender();
      toast('Could not save — ' + (e.message || 'check your connection'));
    });
  }

  function cyclePantry(name) {
    cycleStatus(name, renderPantry);
  }

  // ------------------------------------------------------------ add ingredient

  function openAddModal() {
    $('addName').value = '';
    $('addCategory').innerHTML = db.lists.ingredientCategories.map(function (c) {
      return '<option>' + esc(c) + '</option>';
    }).join('');
    showModal('addModal');
    $('addName').focus();
  }

  $('addCancel').onclick = hideModals;
  $('addConfirm').onclick = function () {
    var name = $('addName').value.trim();
    var category = $('addCategory').value;
    if (!name) return;
    hideModals();
    db.ingredients.push({ name: name, category: category, status: 'Have It' });
    renderPantry();
    call('addIngredient', name, category).then(function (r) {
      if (!r.ok && r.reason === 'exists') toast('"' + name + '" is already in the pantry');
      else toast('Added ' + name);
    }).catch(function (e) {
      db.ingredients = db.ingredients.filter(function (i) { return i.name !== name; });
      renderPantry();
      toast('Could not add — ' + (e.message || 'try again'));
    });
  };

  // ------------------------------------------------------------ meals list

  function renderMeals() {
    var view = $('view-meals');
    var recipes = db.recipes.filter(function (r) {
      return (mealFilter.dishCategory === 'All' || r.dishCategory === mealFilter.dishCategory) &&
             (mealFilter.protein === 'All' || r.protein === mealFilter.protein);
    });
    if (mealFilter.sort === 'Prep time ↑') recipes.sort(function (a, b) { return a.prepTime - b.prepTime; });
    else if (mealFilter.sort === 'Prep time ↓') recipes.sort(function (a, b) { return b.prepTime - a.prepTime; });
    else recipes.sort(function (a, b) { return a.name.localeCompare(b.name); });

    var html = '<div class="filterbar">' +
      selectHtml('mf-cat', db.lists.dishCategories, mealFilter.dishCategory, 'All cuisines') +
      selectHtml('mf-prot', db.lists.proteins, mealFilter.protein, 'All proteins') +
      selectHtml('mf-sort', ['Name', 'Prep time ↑', 'Prep time ↓'], mealFilter.sort) +
      '</div>';

    if (!recipes.length) {
      html += '<div class="empty">No meals match. Add recipes in the Google Sheet\'s Recipes tab.</div>';
    } else {
      html += recipes.map(function (r) {
        var out = 0, low = 0;
        r.ingredients.forEach(function (n) {
          var s = pantryStatus(n);
          if (s === 'Out') out++;
          else if (s === 'Running Low') low++;
        });
        var warn = out > 0
          ? '<div class="meal-warn out">' + out + ' out' + (low ? ', ' + low + ' running low' : '') + '</div>'
          : low > 0
            ? '<div class="meal-warn low">' + low + ' running low</div>'
            : '<div class="meal-warn ok">All ingredients on hand</div>';
        return '<div class="card meal-card" data-recipe="' + esc(r.name) + '">' +
          '<h3>' + esc(r.name) + '</h3>' +
          '<div class="meal-meta">' +
            (r.prepTime ? '<span class="chip">⏱ ' + r.prepTime + ' min</span>' : '') +
            '<span class="chip">' + esc(r.dishCategory) + '</span>' +
            '<span class="chip">' + esc(r.protein) + '</span>' +
          '</div>' + warn + '</div>';
      }).join('');
    }
    view.innerHTML = html;

    $('mf-cat').onchange = function () { mealFilter.dishCategory = this.value; renderMeals(); };
    $('mf-prot').onchange = function () { mealFilter.protein = this.value; renderMeals(); };
    $('mf-sort').onchange = function () { mealFilter.sort = this.value; renderMeals(); };
    view.querySelectorAll('.meal-card').forEach(function (card) {
      card.addEventListener('click', function () { openMeal(card.dataset.recipe, 'meals'); });
    });
  }

  // ------------------------------------------------------------ meal detail

  function openMeal(recipeName, from) {
    openRecipe = db.recipes.filter(function (r) { return r.name === recipeName; })[0];
    if (!openRecipe) { toast('Recipe not found — refresh?'); return; }
    cameFrom = from;
    mealEdits = {};
    openRecipe.ingredients.forEach(function (n) { mealEdits[n] = pantryStatus(n); });
    // Snapshot order (Out → Running Low → Have It) so rows don't jump while toggling
    mealOrder = openRecipe.ingredients.slice().sort(function (a, b) {
      return statusRank(mealEdits[a]) - statusRank(mealEdits[b]) || a.localeCompare(b);
    });
    switchTab('meal');
  }

  function renderMealDetail() {
    var r = openRecipe;
    var view = $('view-meal');
    if (!r) { view.innerHTML = ''; return; }

    var linkHtml = r.link
      ? '<a class="recipe-link" href="' + esc(r.link) + '" target="_blank" rel="noopener">📖 Open Recipe</a>'
      : '<span class="recipe-link disabled">No recipe link yet — add one in the Sheet</span>';

    view.innerHTML =
      '<div class="detail-top"><button class="back-btn" id="mealBack">←</button>' +
      '<h2>' + esc(r.name) + '</h2></div>' +
      linkHtml +
      '<div class="meal-meta" style="padding:0 2px 12px">' +
        (r.prepTime ? '<span class="chip">⏱ ' + r.prepTime + ' min</span>' : '') +
        '<span class="chip">' + esc(r.dishCategory) + '</span>' +
        '<span class="chip">' + esc(r.protein) + '</span>' +
      '</div>' +
      '<div class="group-head">Ingredients — most needed first</div>' +
      '<div class="card">' + mealOrder.map(function (n) {
        var s = mealEdits[n];
        return '<div class="row"><div class="name">' + esc(n) + '</div>' +
          '<button class="pill ' + statusClass(s) + '" data-ing="' + esc(n) + '">' + esc(s) + '</button></div>';
      }).join('') + '</div>' +
      '<div class="detail-actions">' +
        '<button class="btn ghost" id="mealSave">Save</button>' +
        '<button class="btn primary" id="mealPlan">Plan</button>' +
      '</div>';

    $('mealBack').onclick = function () { switchTab(cameFrom); };
    $('mealSave').onclick = function () { saveMealEdits(true); };
    $('mealPlan').onclick = openPlanModal;
    view.querySelectorAll('.pill[data-ing]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var n = btn.dataset.ing;
        mealEdits[n] = nextStatus(mealEdits[n]);
        btn.className = 'pill ' + statusClass(mealEdits[n]);
        btn.textContent = mealEdits[n];
      });
    });
  }

  /** Push detail-view status edits into the pantry. */
  function saveMealEdits(announce) {
    var changes = [];
    Object.keys(mealEdits).forEach(function (n) {
      if (mealEdits[n] !== pantryStatus(n)) changes.push({ name: n, status: mealEdits[n] });
    });
    if (!changes.length) {
      if (announce) toast('No changes to save');
      return Promise.resolve();
    }
    changes.forEach(function (ch) {
      var item = db.ingredients.filter(function (i) {
        return i.name.toLowerCase() === ch.name.toLowerCase();
      })[0];
      if (item) item.status = ch.status;
      else db.ingredients.push({ name: ch.name, category: 'Uncategorized', status: ch.status });
    });
    return call('saveStatuses', changes).then(function () {
      if (announce) toast('Pantry updated');
    }).catch(function (e) {
      toast('Could not save — ' + (e.message || 'try again'));
      throw e;
    });
  }

  // ------------------------------------------------------------ plan popup

  function openPlanModal() {
    saveMealEdits(false);
    $('planRecipeName').textContent = openRecipe.name;
    var plannedByDate = {};
    db.week.forEach(function (e) { plannedByDate[e.date] = e.recipe; });

    $('planOptions').innerHTML =
      '<label><input type="radio" name="planDay" value="auto"' +
        (pendingDay ? '' : ' checked') + '> ✨ Choose for me</label>' +
      db.weekDates.map(function (w) {
        var taken = plannedByDate[w.date];
        return '<label><input type="radio" name="planDay" value="' + w.day + '"' +
          (w.day === pendingDay ? ' checked' : '') + '>' +
          w.day + ' ' + shortDate(w.date) +
          (taken ? '<span class="taken">' + esc(taken) + '</span>' : '') +
          '</label>';
      }).join('');
    showModal('planModal');
  }

  $('planCancel').onclick = hideModals;
  $('planConfirm').onclick = function () {
    var choice = document.querySelector('input[name="planDay"]:checked').value;
    hideModals();
    submitPlan(choice, false);
  };

  function submitPlan(choice, allowReplace) {
    var recipeName = openRecipe.name;
    call('planMeal', recipeName, choice, allowReplace).then(function (r) {
      if (r && r.ok) {
        db.week = db.week.filter(function (e) { return e.date !== r.date; });
        db.week.push({ date: r.date, day: r.day, recipe: recipeName });
        toast('Planned for ' + r.day + ' ' + shortDate(r.date));
        switchTab('week');
      } else if (r && r.reason === 'conflict') {
        if (confirm(r.day + ' already has ' + r.existingRecipe + '. Replace it?')) {
          submitPlan(choice, true);
        }
      } else if (r && r.reason === 'full') {
        toast('Every day this week is planned — pick a day to replace');
      } else {
        toast('Could not plan that — try again');
      }
    }).catch(function (e) {
      toast('Could not plan — ' + (e.message || 'try again'));
    });
  }

  // ------------------------------------------------------------ week

  function renderWeek() {
    var view = $('view-week');
    var plannedByDate = {};
    db.week.forEach(function (e) { plannedByDate[e.date] = e.recipe; });

    view.innerHTML = '<div class="card">' + db.weekDates.map(function (w) {
      var recipe = plannedByDate[w.date];
      var r = recipe && db.recipes.filter(function (x) { return x.name === recipe; })[0];
      var isToday = w.date === db.today;
      var mid;
      if (recipe) {
        mid = '<div class="week-meal" data-recipe="' + esc(recipe) + '">' +
          '<div class="name">' + esc(recipe) + '</div>' +
          (r && r.prepTime ? '<div class="sub">⏱ ' + r.prepTime + ' min · ' + esc(r.dishCategory) + '</div>' : '') +
          '</div><button class="x-btn" data-date="' + w.date + '" title="Remove">✕</button>';
      } else {
        mid = '<div class="week-empty" data-day="' + w.day + '" data-date="' + w.date +
          '">Nothing planned — tap to pick a meal</div>';
      }
      return '<div class="row week-day' + (isToday ? ' today-row' : '') + '">' +
        '<div class="day-label"><b>' + w.day + '</b><small>' + shortDate(w.date) + '</small></div>' +
        mid + '</div>';
    }).join('') + '</div>';

    view.querySelectorAll('.week-meal').forEach(function (el) {
      el.addEventListener('click', function () { openMeal(el.dataset.recipe, 'week'); });
    });
    view.querySelectorAll('.week-empty').forEach(function (el) {
      el.addEventListener('click', function () {
        pendingDay = el.dataset.day;
        switchTab('meals');
        toast('Pick a meal for ' + el.dataset.day + ' ' + shortDate(el.dataset.date));
      });
    });
    view.querySelectorAll('.x-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var date = btn.dataset.date;
        var removed = db.week.filter(function (e) { return e.date === date; });
        db.week = db.week.filter(function (e) { return e.date !== date; });
        renderWeek();
        call('unplanMeal', date).catch(function () {
          db.week = db.week.concat(removed);
          renderWeek();
          toast('Could not remove — try again');
        });
      });
    });
  }

  // ------------------------------------------------------------ needed this week

  function renderShop() {
    var view = $('view-shop');

    // Union of ingredients across this week's planned dinners
    var used = {}; // lowercase name -> { name, recipes: [] }
    db.week.forEach(function (e) {
      var r = db.recipes.filter(function (x) { return x.name === e.recipe; })[0];
      if (!r) return;
      r.ingredients.forEach(function (n) {
        var key = n.toLowerCase();
        if (!used[key]) used[key] = { name: n, recipes: [] };
        if (used[key].recipes.indexOf(r.name) === -1) used[key].recipes.push(r.name);
      });
    });

    var items = Object.keys(used).map(function (k) {
      var ing = db.ingredients.filter(function (i) { return i.name.toLowerCase() === k; })[0];
      return {
        name: used[k].name,
        recipes: used[k].recipes,
        category: ing ? ing.category : 'Uncategorized',
        status: ing ? ing.status : 'Have It'
      };
    });

    if (!items.length) {
      view.innerHTML = '<div class="empty">No dinners planned yet — plan some meals and everything they need shows up here.</div>';
      return;
    }

    items.sort(function (a, b) {
      return statusRank(a.status) - statusRank(b.status) ||
        a.category.localeCompare(b.category) ||
        a.name.localeCompare(b.name);
    });

    var groupLabels = { 'Out': '🔴 Need to buy', 'Running Low': '🟡 Running low', 'Have It': '🟢 Have it' };
    var html = '';
    var lastStatus = null;
    items.forEach(function (i) {
      if (i.status !== lastStatus) {
        if (lastStatus !== null) html += '</div>';
        html += '<div class="group-head">' + groupLabels[i.status] + '</div><div class="card">';
        lastStatus = i.status;
      }
      html += '<div class="row"><div><div class="name">' + esc(i.name) + '</div>' +
        '<div class="sub">' + esc(i.category) + ' · ' + esc(i.recipes.join(', ')) + '</div></div>' +
        '<button class="pill ' + statusClass(i.status) + '" data-ing="' + esc(i.name) + '">' +
        esc(i.status) + '</button></div>';
    });
    html += '</div>';
    view.innerHTML = html;

    view.querySelectorAll('.pill[data-ing]').forEach(function (btn) {
      btn.addEventListener('click', function () { cycleStatus(btn.dataset.ing, renderShop); });
    });
  }

  // ------------------------------------------------------------ modals

  function showModal(id) {
    $('overlay').hidden = false;
    ['planModal', 'addModal'].forEach(function (m) { $(m).hidden = (m !== id); });
  }
  function hideModals() { $('overlay').hidden = true; }
  $('overlay').addEventListener('click', function (e) {
    if (e.target === this) hideModals();
  });

  // ------------------------------------------------------------ boot

  function loadData() {
    return call('getAllData').then(function (data) { db = data; });
  }

  function startApp() {
    $('connect').hidden = true;
    $('loading').hidden = false;
    loadData().then(function () {
      $('loading').hidden = true;
      $('app').hidden = false;
      switchTab('pantry');
    }).catch(function (e) {
      $('loading').innerHTML = '<p>Could not load data: ' + esc(e.message || e) + '</p>' +
        '<p><a href="#" onclick="localStorage.removeItem(\'' + APP_KEY + '\');location.reload();return false;">Reconnect to a different household</a></p>';
    });
  }

  function showConnect(errorMsg) {
    $('connect').hidden = false;
    var err = $('connectError');
    err.hidden = !errorMsg;
    if (errorMsg) err.textContent = errorMsg;
  }

  $('connectBtn').onclick = function () {
    var url = $('connectUrl').value.trim();
    if (url.indexOf(URL_PREFIX) !== 0) {
      showConnect('That doesn\'t look right — the URL should start with ' + URL_PREFIX + ' and end in /exec.');
      return;
    }
    var btn = $('connectBtn');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    APP_URL = url;
    call('ping').then(function (r) {
      btn.disabled = false;
      btn.textContent = 'Connect';
      if (r && (r.app === 'puree' || r.app === 'meal-planner')) {
        storeUrl(url);
        startApp();
      } else {
        APP_URL = null;
        showConnect('That URL responded, but not with this app — double-check it\'s the Web app URL from the deploy dialog.');
      }
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = 'Connect';
      APP_URL = null;
      showConnect('Could not reach that URL (' + (e.message || e) + '). Is the deployment set to "Anyone"?');
    });
  };

  // ?app=<exec-url> deep link (from the setup sidebar) takes priority, then storage
  var params = new URLSearchParams(location.search);
  var fromParam = params.get('app');
  if (fromParam && fromParam.indexOf(URL_PREFIX) === 0) {
    storeUrl(fromParam);
    history.replaceState(null, '', location.pathname);
  }

  APP_URL = getStoredUrl();
  if (APP_URL) startApp();
  else showConnect();

  // Re-sync when the tab regains focus (e.g. spouse changed something),
  // unless mid-edit in the meal detail view.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && db && currentTab !== 'meal') {
      loadData().then(function () { switchTab(currentTab); }).catch(function () {});
    }
  });

  if ('serviceWorker' in navigator) {
    try { navigator.serviceWorker.register('sw.js'); } catch (e) {}
  }
})();
