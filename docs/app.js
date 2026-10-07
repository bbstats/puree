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
  var draft = null;           // in-progress new recipe (kept until saved or cancelled)
  var editingIng = null;      // pantry name being edited in the edit popup
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
  function findIngredient(name) {
    return db.ingredients.filter(function (i) {
      return i.name.toLowerCase() === name.toLowerCase();
    })[0];
  }
  function pantryStatus(name) {
    var hit = findIngredient(name);
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
    if (tab !== 'meals' && tab !== 'meal' && tab !== 'recipe') pendingDay = null;
    currentTab = tab;
    ['pantry', 'meals', 'week', 'shop', 'meal', 'recipe'].forEach(function (v) {
      $('view-' + v).hidden = (v !== tab);
    });
    document.querySelectorAll('.tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    var titles = { pantry: 'Pantry', meals: 'Meals', week: 'This Week', shop: 'Needed This Week', meal: 'Meal', recipe: '' };
    $('viewTitle').textContent = tab === 'meal' && openRecipe ? '' : titles[tab];
    if (tab === 'pantry') renderPantry();
    if (tab === 'meals') renderMeals();
    if (tab === 'week') renderWeek();
    if (tab === 'shop') renderShop();
    if (tab === 'meal') renderMealDetail();
    if (tab === 'recipe') renderRecipeForm();
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
    view.querySelectorAll('.ing-edit[data-ing]').forEach(function (el) {
      el.addEventListener('click', function () { openEditModal(el.dataset.ing); });
    });
  }

  function pantryRow(i, showCat) {
    return '<div class="row"><div class="ing-edit" data-ing="' + esc(i.name) + '">' +
      '<div class="name">' + esc(i.name) + ' <span class="edit-hint">✎</span></div>' +
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
  $('addName').onkeydown = function (e) { if (e.key === 'Enter') $('addConfirm').click(); };
  $('editName').onkeydown = function (e) { if (e.key === 'Enter') $('editConfirm').click(); };
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

  // ------------------------------------------------------------ edit ingredient

  function categoryOptions(selected) {
    var cats = db.lists.ingredientCategories.slice();
    if (selected && cats.indexOf(selected) === -1) cats.push(selected);
    return cats.map(function (c) {
      return '<option' + (c === selected ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
  }

  function recipesUsing(name) {
    return db.recipes.filter(function (r) {
      return r.ingredients.some(function (n) { return n.toLowerCase() === name.toLowerCase(); });
    });
  }

  function openEditModal(name) {
    var item = findIngredient(name);
    if (!item) return;
    editingIng = item.name;
    $('editName').value = item.name;
    $('editCategory').innerHTML = categoryOptions(item.category);
    var n = recipesUsing(item.name).length;
    $('editNote').hidden = !n;
    $('editNote').textContent = 'Renaming also updates the ' + n + ' recipe' + (n === 1 ? '' : 's') + ' that use it.';
    showModal('editModal');
  }

  $('editCancel').onclick = hideModals;
  $('editConfirm').onclick = function () {
    var oldName = editingIng;
    var item = findIngredient(oldName);
    var newName = $('editName').value.replace(/,/g, '').replace(/\s+/g, ' ').trim();
    var category = $('editCategory').value;
    if (!item || !newName) return;
    if (newName === item.name && category === item.category) { hideModals(); return; }
    var clash = findIngredient(newName);
    if (clash && clash !== item) {
      toast('"' + clash.name + '" is already in the pantry');
      return;
    }
    hideModals();
    // Apply locally (pantry + recipe lists), then sync; on failure reload from the sheet.
    recipesUsing(oldName).forEach(function (r) {
      r.ingredients = r.ingredients.map(function (n) {
        return n.toLowerCase() === oldName.toLowerCase() ? newName : n;
      });
    });
    item.name = newName;
    item.category = category;
    renderPantry();
    call('updateIngredient', oldName, newName, category).then(function (r) {
      if (r && r.ok) {
        toast('Saved ' + newName);
        return;
      }
      toast(r && r.reason === 'exists' ? '"' + newName + '" is already in the pantry' : 'Could not save — try again');
      return resync();
    }).catch(function (e) {
      toast('Could not save — ' + (e.message || 'try again'));
      return resync();
    });
  };

  function resync() {
    return loadData().then(function () { switchTab(currentTab); }).catch(function () {});
  }

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
      html += '<div class="empty">No meals match. Add one below.</div>';
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
    html += '<div class="fab-row"><button class="btn primary wide" id="addRecipeBtn">' +
      (draft ? '✎ Continue new recipe' : '+ Add recipe') + '</button></div>';
    view.innerHTML = html;

    $('addRecipeBtn').onclick = openRecipeForm;
    $('mf-cat').onchange = function () { mealFilter.dishCategory = this.value; renderMeals(); };
    $('mf-prot').onchange = function () { mealFilter.protein = this.value; renderMeals(); };
    $('mf-sort').onchange = function () { mealFilter.sort = this.value; renderMeals(); };
    view.querySelectorAll('.meal-card').forEach(function (card) {
      card.addEventListener('click', function () { openMeal(card.dataset.recipe, 'meals'); });
    });
  }

  // ------------------------------------------------------------ new recipe form

  function openRecipeForm() {
    if (!draft) {
      var pick = function (list) { return list.indexOf('Other') !== -1 ? 'Other' : (list[0] || ''); };
      draft = {
        name: '', link: '', prepTime: '',
        dishCategory: mealFilter.dishCategory !== 'All' ? mealFilter.dishCategory : pick(db.lists.dishCategories),
        protein: mealFilter.protein !== 'All' ? mealFilter.protein : pick(db.lists.proteins),
        ingredients: []
      };
    }
    switchTab('recipe');
  }

  function draftIsEmpty() {
    return !draft || (!draft.name && !draft.link && !draft.prepTime && !draft.ingredients.length);
  }

  function renderRecipeForm() {
    var view = $('view-recipe');
    if (!draft) { view.innerHTML = ''; return; }
    view.innerHTML =
      '<div class="detail-top"><button class="back-btn" id="rfBack">←</button><h2>New recipe</h2></div>' +
      '<div class="card form-card">' +
        '<label class="field"><span>Name</span>' +
          '<input type="text" id="rfName" autocomplete="off" placeholder="e.g. Chicken Tacos"></label>' +
        '<label class="field"><span>Recipe link <em>optional</em></span>' +
          '<input type="url" id="rfLink" autocomplete="off" placeholder="Website, Google Photos, or Doc link"></label>' +
        '<div class="field-row">' +
          '<label class="field"><span>Prep (min)</span>' +
            '<input type="number" id="rfPrep" inputmode="numeric" min="0" step="5"></label>' +
          '<label class="field"><span>Cuisine</span>' +
            selectHtml('rfCat', db.lists.dishCategories, draft.dishCategory) + '</label>' +
          '<label class="field"><span>Protein</span>' +
            selectHtml('rfProt', db.lists.proteins, draft.protein) + '</label>' +
        '</div>' +
      '</div>' +
      '<div class="group-head">Ingredients</div>' +
      '<div class="card form-card">' +
        '<div id="rfChips" class="ing-chips"></div>' +
        '<input type="text" id="rfIng" class="ing-input" autocomplete="off" enterkeyhint="enter" ' +
          'placeholder="Type an ingredient, then Enter">' +
        '<div id="rfSuggest" class="suggest"></div>' +
      '</div>' +
      '<div class="detail-actions">' +
        '<button class="btn ghost" id="rfCancel">Cancel</button>' +
        '<button class="btn primary" id="rfSave">Save recipe</button>' +
      '</div>';

    // Values go in via .value so nothing typed needs HTML escaping
    $('rfName').value = draft.name;
    $('rfLink').value = draft.link;
    $('rfPrep').value = draft.prepTime;
    $('rfName').oninput = function () { draft.name = this.value; };
    $('rfLink').oninput = function () { draft.link = this.value; };
    $('rfPrep').oninput = function () { draft.prepTime = this.value; };
    // If a saved choice was since removed from the Lists tab, keep what's on screen
    draft.dishCategory = $('rfCat').value;
    draft.protein = $('rfProt').value;
    $('rfCat').onchange = function () { draft.dishCategory = this.value; };
    $('rfProt').onchange = function () { draft.protein = this.value; };

    var ingInput = $('rfIng');
    ingInput.oninput = function () {
      // Typing or pasting commas splits into separate ingredients
      if (this.value.indexOf(',') !== -1) {
        var parts = this.value.split(',');
        var rest = parts.pop();
        parts.forEach(addDraftIngredient);
        this.value = rest.replace(/^\s+/, '');
        renderDraftChips();
      }
      renderSuggestions();
    };
    ingInput.onkeydown = function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (addDraftIngredient(this.value)) this.value = '';
        renderDraftChips();
        renderSuggestions();
      }
    };

    $('rfBack').onclick = function () { switchTab('meals'); };
    $('rfCancel').onclick = function () {
      if (!draftIsEmpty() && !confirm('Discard this recipe?')) return;
      draft = null;
      switchTab('meals');
    };
    $('rfSave').onclick = saveRecipe;

    renderDraftChips();
    renderSuggestions();
  }

  /** Add an ingredient to the draft, using the pantry's spelling when it matches. */
  function addDraftIngredient(raw) {
    var name = String(raw).replace(/\s+/g, ' ').trim();
    if (!name) return false;
    var known = findIngredient(name);
    if (known) name = known.name;
    var dup = draft.ingredients.some(function (n) { return n.toLowerCase() === name.toLowerCase(); });
    if (!dup) draft.ingredients.push(name);
    return true;
  }

  function renderDraftChips() {
    var box = $('rfChips');
    box.innerHTML = draft.ingredients.length
      ? draft.ingredients.map(function (n, idx) {
          var isNew = !findIngredient(n);
          return '<button class="ing-chip' + (isNew ? ' new' : '') + '" data-idx="' + idx + '" title="Remove">' +
            esc(n) + (isNew ? ' <small>new</small>' : '') + ' <span class="x">✕</span></button>';
        }).join('')
      : '<div class="hint">No ingredients yet. Pick from your pantry or type new ones.</div>';
    box.querySelectorAll('.ing-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        draft.ingredients.splice(Number(btn.dataset.idx), 1);
        renderDraftChips();
        renderSuggestions();
      });
    });
  }

  function renderSuggestions() {
    var box = $('rfSuggest');
    var q = $('rfIng').value.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!q) { box.innerHTML = ''; return; }
    var chosen = {};
    draft.ingredients.forEach(function (n) { chosen[n.toLowerCase()] = true; });
    var matches = db.ingredients.filter(function (i) {
      var k = i.name.toLowerCase();
      return !chosen[k] && k.indexOf(q) !== -1;
    }).sort(function (a, b) {
      var as = a.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      var bs = b.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      return as - bs || a.name.localeCompare(b.name);
    }).slice(0, 6);
    var exact = findIngredient(q) || chosen[q];
    var typed = $('rfIng').value.replace(/\s+/g, ' ').trim();
    box.innerHTML = matches.map(function (i) {
      return '<button class="suggest-item" data-name="' + esc(i.name) + '">' + esc(i.name) +
        ' <small>' + esc(i.category) + '</small></button>';
    }).join('') + (exact ? '' :
      '<button class="suggest-item add" data-name="' + esc(typed) + '">+ Add "' + esc(typed) + '" (new)</button>');
    box.querySelectorAll('.suggest-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        addDraftIngredient(btn.dataset.name);
        $('rfIng').value = '';
        renderDraftChips();
        renderSuggestions();
        $('rfIng').focus();
      });
    });
  }

  function saveRecipe() {
    // Anything still sitting in the ingredient box counts
    if (addDraftIngredient($('rfIng').value)) $('rfIng').value = '';
    var name = draft.name.replace(/\s+/g, ' ').trim();
    if (!name) {
      toast('Give the recipe a name');
      $('rfName').focus();
      return;
    }
    var taken = db.recipes.filter(function (r) { return r.name.toLowerCase() === name.toLowerCase(); })[0];
    if (taken) {
      toast('"' + taken.name + '" already exists');
      return;
    }
    var link = draft.link.trim();
    if (link && !/^[a-z][a-z0-9+.-]*:/i.test(link)) link = 'https://' + link;

    var btn = $('rfSave');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    var done = function () { btn.disabled = false; btn.textContent = 'Save recipe'; };
    call('addRecipe', {
      name: name,
      link: link,
      prepTime: draft.prepTime,
      dishCategory: draft.dishCategory,
      protein: draft.protein,
      ingredients: draft.ingredients
    }).then(function (r) {
      done();
      if (r && r.ok) {
        db.recipes.push(r.recipe);
        (r.added || []).forEach(function (n) {
          if (!findIngredient(n)) db.ingredients.push({ name: n, category: 'Uncategorized', status: 'Have It' });
        });
        draft = null;
        toast(r.added && r.added.length
          ? 'Saved! ' + r.added.length + ' new ingredient' + (r.added.length === 1 ? '' : 's') +
            ' added to Pantry as Uncategorized'
          : 'Saved ' + r.recipe.name);
        openMeal(r.recipe.name, 'meals');
      } else if (r && r.reason === 'exists') {
        toast('"' + name + '" already exists');
      } else {
        toast('Could not save — try again');
      }
    }).catch(function (e) {
      done();
      toast('Could not save — ' + (e.message || 'try again'));
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
    ['planModal', 'addModal', 'editModal'].forEach(function (m) { $(m).hidden = (m !== id); });
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
  // unless mid-edit (meal detail, new-recipe form, or an open popup).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && db && currentTab !== 'meal' &&
        currentTab !== 'recipe' && $('overlay').hidden) {
      resync();
    }
  });

  if ('serviceWorker' in navigator) {
    try { navigator.serviceWorker.register('sw.js'); } catch (e) {}
  }
})();
