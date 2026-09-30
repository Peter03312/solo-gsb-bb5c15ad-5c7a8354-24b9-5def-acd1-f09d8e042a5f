'use strict';

// 编辑台：草稿 CRUD + 逐事件选定主张 + 发布乐观并发控制
const $ = (sel) => document.querySelector(sel);

const PREC_LABEL = { year: '精确到年', month: '精确到月', day: '精确到日' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const store = {
  get token() { return localStorage.getItem('editorToken') || ''; },
  set token(v) { localStorage.setItem('editorToken', v); },
  get editor() { return localStorage.getItem('editorName') || ''; },
  set editor(v) { localStorage.setItem('editorName', v); },
  get selections() {
    try { return JSON.parse(localStorage.getItem('selections') || '{}'); }
    catch { return {}; }
  },
  setSelection(eventId, claimId) {
    const m = this.selections;
    m[eventId] = claimId;
    localStorage.setItem('selections', JSON.stringify(m));
  },
  clearSelections() { localStorage.removeItem('selections'); },
};

let state = { events: [], relations: [], currentVersionNo: 0, draftRevision: 0 };
let baseVersionNo = 0; // 发起修改时所基于的版本号
let conflictData = null;
let restoreData = null; // 当前打开的「恢复草稿」预览

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Editor-Token': store.token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 无响应体 */ }
  if (res.status === 401) {
    showGlobal('warn', data?.message || '请先在右上角输入正确的编辑者口令。');
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const err = new Error(data?.message || `请求失败（${res.status}）`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function showGlobal(kind, html) {
  $('#globalMsg').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

function showPublishResult(kind, html) {
  $('#publishResult').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

// ---------- 渲染 ----------
function render() {
  $('#versionTag').textContent =
    state.currentVersionNo === 0
      ? `尚无已发布版本（草稿未公开）· 草稿修订号 ${state.draftRevision}`
      : `当前已发布：第 ${state.currentVersionNo} 版 · 草稿修订号 ${state.draftRevision}`;

  const sel = store.selections;
  $('#eventList').innerHTML = state.events.map((ev) => {
    const claims = ev.claims.map((c) => {
      const checked = sel[ev.id] === c.id ? 'checked' : '';
      return `
        <div class="claim ${checked ? 'selected' : ''}" data-claim="${c.id}">
          <div class="row">
            <div style="flex:0 0 auto;padding-top:2px">
              <input type="radio" name="sel-${ev.id}" data-select-claim="${c.id}" ${checked} style="width:auto" />
            </div>
            <div style="flex:1">
              <strong>${esc(c.dateLabel)}</strong>
              <span class="badge prec">${PREC_LABEL[c.precision]}</span>
              <span class="badge">区间 ${c.intervalStart} ~ ${c.intervalEnd}</span>
              <div class="source"><b>出处：</b>${esc(c.source || '（未注明）')}</div>
              ${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}
            </div>
            <div style="flex:0 0 auto">
              <button class="danger" data-del-claim="${c.id}" type="button">删除主张</button>
            </div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="card event-card" id="event-card-${ev.id}" data-event="${ev.id}">
        <div class="row">
          <div class="field">
            <label>事件标题</label>
            <input type="text" value="${esc(ev.title)}" data-edit-title="${ev.id}" />
          </div>
          <div style="flex:0 0 auto">
            <button class="secondary" data-save-event="${ev.id}" type="button">保存</button>
            <button class="danger" data-del-event="${ev.id}" type="button">删除事件</button>
          </div>
        </div>
        <label style="margin-top:6px">描述</label>
        <textarea data-edit-desc="${ev.id}">${esc(ev.description)}</textarea>

        <h3 style="margin-top:10px">时间主张${ev.claims.length === 0 ? '（尚无主张，无法发布）' : `（${ev.claims.length} 条，发布时单选）`}</h3>
        ${claims || '<p class="muted">暂无主张</p>'}

        <div class="claim" style="border-style:dashed">
          <h3>新增主张</h3>
          <div class="row">
            <div class="field" style="max-width:130px">
              <label>精度</label>
              <select data-new-precision="${ev.id}">
                <option value="day">精确到日</option>
                <option value="month">精确到月</option>
                <option value="year">精确到年</option>
              </select>
            </div>
            <div class="field" style="max-width:110px"><label>年</label><input type="number" min="1" max="9999" data-new-year="${ev.id}" placeholder="1958" /></div>
            <div class="field js-month" style="max-width:100px"><label>月</label><input type="number" min="1" max="12" data-new-month="${ev.id}" placeholder="3" /></div>
            <div class="field js-day" style="max-width:100px"><label>日</label><input type="number" min="1" max="31" data-new-day="${ev.id}" placeholder="12" /></div>
          </div>
          <label style="margin-top:6px">出处（受访人 / 档案 / 页码）</label>
          <input type="text" data-new-source="${ev.id}" placeholder="如：李宝山口述，2021-07-05 访谈" />
          <label style="margin-top:6px">考异备注（可选，记录矛盾说法）</label>
          <textarea data-new-note="${ev.id}"></textarea>
          <div style="margin-top:8px"><button data-add-claim="${ev.id}" type="button">添加主张</button></div>
        </div>
      </div>`;
  }).join('') || '<p class="muted">草稿中还没有事件。</p>';

  // 精度联动
  document.querySelectorAll('select[data-new-precision]').forEach((selEl) => {
    const card = selEl.closest('.event-card');
    const apply = () => {
      const p = selEl.value;
      card.querySelector('.js-month').style.display = p === 'year' ? 'none' : '';
      card.querySelector('.js-day').style.display = p === 'day' ? '' : 'none';
    };
    selEl.addEventListener('change', apply);
    apply();
  });

  renderRelations();
}

function titleOf(id) {
  const ev = state.events.find((e) => e.id === id);
  return ev ? ev.title : `#${id}`;
}

function renderRelations() {
  const opts = state.events.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  $('#relEarlier').innerHTML = opts;
  $('#relLater').innerHTML = opts;

  $('#relList').innerHTML = state.relations.length
    ? state.relations.map((r) => `
        <div class="rel-line" id="rel-line-${r.id}">
          <strong>${esc(titleOf(r.earlierId))}</strong>
          <span class="badge">先于</span>
          <strong>${esc(titleOf(r.laterId))}</strong>
          <button class="danger" data-del-rel="${r.id}" type="button" style="float:right">删除</button>
          ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
          ${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}
        </div>`).join('')
    : '<p class="muted">尚无先后关系。</p>';
}

async function loadState() {
  state = await api('GET', '/api/editor/state');
  baseVersionNo = state.currentVersionNo;
  // 清掉已失效的选择
  const valid = new Map();
  state.events.forEach((e) => e.claims.forEach((c) => valid.set(c.id, e.id)));
  const m = store.selections;
  let changed = false;
  for (const [eid, cid] of Object.entries(m)) {
    if (valid.get(cid) !== Number(eid)) { delete m[eid]; changed = true; }
  }
  if (changed) localStorage.setItem('selections', JSON.stringify(m));
  render();
  loadVersions();
}

async function loadVersions() {
  const data = await api('GET', '/api/editor/versions');
  $('#versionList').innerHTML = data.versions.length
    ? data.versions.map((v) => `
        <div class="rel-line">
          <strong>第 ${v.versionNo} 版</strong>
          <span class="muted">${v.publishedAt.replace('T', ' ').slice(0, 16)} UTC · ${esc(v.editor || '匿名')}${v.parentNo ? ` · 基于第 ${v.parentNo} 版` : ''}</span>
          ${v.note ? `<div>${esc(v.note)}</div>` : ''}
          <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
            <a href="/api/public/versions/${v.versionNo}" target="_blank">查看该版快照 JSON</a>
            <button class="secondary" type="button" data-restore-preview="${v.versionNo}" style="padding:2px 12px;font-size:13px">从此版恢复草稿…</button>
          </div>
        </div>`).join('')
    : '尚无版本。';
}

// ---------- 发布 ----------
function gatherSelection() {
  const m = store.selections;
  return state.events.map((e) => ({ eventId: e.id, claimId: Number(m[e.id]) }));
}

function clientCheck() {
  const missing = state.events.filter((e) => !store.selections[e.id]);
  if (state.events.length === 0) return '草稿中没有事件，无法发布。';
  if (missing.length) return `还有 ${missing.length} 个事件未选定主张：${missing.map((e) => `「${e.title}」`).join('、')}`;
  return null;
}

async function doValidate() {
  const err = clientCheck();
  if (err) { showPublishResult('error', esc(err)); return; }
  try {
    const data = await api('POST', '/api/editor/validate', { selection: gatherSelection() });
    if (!data.ok) {
      renderSolverErrors(data.errors);
    } else {
      showPublishResult('ok', `
        <b>校验通过，可以发布。</b>系统确定的具体日期：
        <ol style="margin:6px 0">
          ${data.preview.map((p) => `<li>${esc(p.resolvedDate)} — ${esc(p.title)}（主张区间 ${p.intervalStart} ~ ${p.intervalEnd}）</li>`).join('')}
        </ol>`);
    }
  } catch (e) {
    showPublishResult('error', esc(e.message));
  }
}

function renderSolverErrors(errors) {
  const typeName = { missing: '缺少主张', cycle: '关系成环', temporal: '时间无解', bad_selection: '主张选择无效', broken_relation: '关系失效' };
  const items = errors.map((er, i) => {
    const targets = [...new Set(er.eventIds.map((id) => `#event-card-${id}`))].join(',');
    return `<li data-targets="${targets}" title="点击定位事件">
      <b>[${typeName[er.type] || er.type}]</b> ${esc(er.message)}
      ${er.detail ? `<div class="muted">涉事关系：${esc(er.detail)}</div>` : ''}
      ${er.relationIds && er.relationIds.length ? `<div class="muted">涉事关系 id：${er.relationIds.join(', ')}</div>` : ''}
    </li>`;
  }).join('');
  showPublishResult('error', `
    <b>无法发布，上一已发布版本保持不变。</b>
    <ul class="error-list">${items}</ul>`);
  document.querySelectorAll('#publishResult .error-list li').forEach((li) => {
    li.addEventListener('click', () => {
      const targets = (li.dataset.targets || '').split(',').filter(Boolean);
      const first = targets[0] && document.querySelector(targets[0]);
      if (first) {
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targets.forEach((t) => document.querySelector(t)?.classList.add('has-error', 'highlight-flash'));
        setTimeout(() => targets.forEach((t) => document.querySelector(t)?.classList.remove('highlight-flash')), 1800);
      }
    });
  });
}

async function doPublish() {
  const err = clientCheck();
  if (err) { showPublishResult('error', esc(err)); return; }
  const btn = $('#btnPublish');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/publish', {
      selection: gatherSelection(),
      baseVersionNo,
      editor: store.editor || '匿名编辑',
      note: $('#publishNote').value,
    });
    showPublishResult('ok', `已发布 <b>第 ${data.versionNo} 版</b>（不可变快照）。访客年表已更新。<a href="/" target="_blank">打开访客年表</a>`);
    $('#publishNote').value = '';
    await loadState();
  } catch (e) {
    if (e.status === 422 && e.body?.errors) {
      renderSolverErrors(e.body.errors);
    } else if (e.status === 409) {
      conflictData = e.body;
      showConflictDialog(e.body);
      showPublishResult('error', esc(e.message));
    } else {
      showPublishResult('error', esc(e.message));
    }
  } finally {
    btn.disabled = false;
  }
}

function showConflictDialog(body) {
  const cur = body.currentVersion;
  const list = (evs) => (evs || []).map((e) => `<li>${esc(e.title)}</li>`).join('');
  $('#conflictBody').innerHTML = `
    <p>你发起修改时基于的是<b>第 ${body.baseVersionNo} 版</b>，但另一位编辑者已经在此期间发布了
       <b>第 ${body.currentVersionNo} 版</b>，系统<b>没有</b>覆盖对方的版本。</p>
    ${cur ? `
      <div class="card" style="background:#fff">
        <h3>第 ${cur.versionNo} 版概况</h3>
        <p class="muted">发布于 ${cur.publishedAt.replace('T', ' ').slice(0, 16)} UTC · 编辑者：${esc(cur.editor || '匿名')}${cur.note ? ' · 说明：' + esc(cur.note) : ''}</p>
        <p>事件 ${cur.eventCount} 个，先后关系 ${cur.relationCount} 条。</p>
      </div>` : ''}
    <p class="muted">点击下方按钮后，草稿区将刷新为最新状态，<b>请逐条重新确认每个事件的主张选择</b>，再重新发布；若不重新确认，你的提交不会被接受。</p>`;
  $('#conflictDialog').showModal();
}

// ---------- 从历史版本恢复草稿 ----------
async function openRestorePreview(versionNo) {
  $('#restoreDialog').showModal();
  $('#restoreBody').innerHTML = '加载中…';
  $('#refreshRestorePreview').hidden = true;
  $('#restoreConfirm').disabled = true;
  try {
    restoreData = await api('POST', '/api/editor/restore/preview', { versionNo: Number(versionNo) });
    renderRestorePreview();
    $('#restoreConfirm').disabled = false;
  } catch (e) {
    restoreData = null;
    $('#restoreBody').innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
}

function renderRestorePreview() {
  const d = restoreData;
  if (!d) return;
  const v = d.version;
  const eventsHtml = v.events.map((ev) => `
    <li>
      <strong>${esc(ev.title)}</strong>
      <span class="badge prec">${PREC_LABEL[ev.precision]}</span>
      <span class="badge">被选主张：${esc(ev.dateLabel)}（区间 ${ev.intervalStart} ~ ${ev.intervalEnd}）</span>
      <div class="source"><b>出处：</b>${esc(ev.source || '（未注明）')}</div>
      ${ev.claimNote ? `<div class="muted">${esc(ev.claimNote)}</div>` : ''}
      <div class="muted">求解日期：${esc(ev.resolvedDate)}</div>
    </li>`).join('');
  const relsHtml = v.relations.length
    ? v.relations.map((r) => `
        <li><strong>${esc(snapshotTitle(v, r.earlierEventId))}</strong>
          <span class="badge">先于</span>
          <strong>${esc(snapshotTitle(v, r.laterEventId))}</strong>
          ${r.source ? `<span class="muted">（出处：${esc(r.source)}）</span>` : ''}
        </li>`).join('')
    : '<li class="muted">（无「先于」关系）</li>';

  const oldEvents = d.draftToReplace.events;
  const oldRels = d.draftToReplace.relations;
  const oldClaimCount = oldEvents.reduce((n, e) => n + e.claims.length, 0);
  const oldList = oldEvents.length
    ? oldEvents.map((e) => `「${esc(e.title)}」${e.claims.length ? `（${e.claims.length} 条主张）` : '（无主张）'}`).join('、')
    : '（草稿为空）';

  $('#restoreBody').innerHTML = `
    <p>将把<b>整个草稿</b>替换为 <b>第 ${d.versionNo} 版</b> 的快照内容
       <span class="muted">（发布于 ${v.publishedAt.replace('T', ' ').slice(0, 16)} UTC · 编辑者：${esc(v.editor || '匿名')}）</span>。
       历史快照与访客年表不变；恢复后仍可继续校验并发布为新版本。</p>
    <div class="card" style="background:#fff">
      <h3>该版将恢复的内容</h3>
      <ul style="margin:4px 0">${eventsHtml}</ul>
      <h3 style="margin-top:8px">「先于」关系（${v.relations.length} 条）</h3>
      <ul style="margin:4px 0">${relsHtml}</ul>
      <p class="muted">每个事件只恢复该版<b>被选</b>的 1 条主张；该版未入选的矛盾主张不会恢复。</p>
    </div>
    <div class="card" style="background:#fff;border-left:4px solid var(--danger)">
      <h3>当前草稿中将被替换丢弃的内容</h3>
      <p class="muted">事件 ${oldEvents.length} 个、主张 ${oldClaimCount} 条、关系 ${oldRels.length} 条，将整体清空并按快照重建。</p>
      <div class="source">${esc(oldList)}</div>
    </div>
    <p class="muted">预览不改动数据。确认时会校验草稿修订号（预览时为 ${d.draftRevision}）与最新版本号（${d.currentVersionNo}）；
       若此间草稿被改过或发布了新版本，将报冲突且不替换任何内容。</p>`;
  $('#restoreConfirm').disabled = false;
  $('#refreshRestorePreview').hidden = true;
}

function snapshotTitle(version, eventId) {
  const ev = version.events.find((e) => e.eventId === eventId);
  return ev ? ev.title : `#${eventId}`;
}

async function doRestoreConfirm() {
  if (!restoreData) return;
  const btn = $('#restoreConfirm');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/restore/confirm', {
      versionNo: restoreData.versionNo,
      draftRevision: restoreData.draftRevision,
      latestVersionNo: restoreData.currentVersionNo,
    });
    // 用旧 id -> 新 id 映射把本浏览器保存的主张单选迁移到恢复后的新行
    const m = store.selections;
    const next = {};
    for (const item of data.selection) {
      next[item.eventId] = item.claimId;
    }
    // 保留映射不到的旧选择（理论上不会有），避免误丢编辑者意图
    for (const [eid, cid] of Object.entries(m)) {
      const newEventId = data.idMap.events[eid];
      if (newEventId == null) { next[eid] = cid; continue; }
      if (next[newEventId] == null) next[newEventId] = data.idMap.claims[cid];
    }
    localStorage.setItem('selections', JSON.stringify(next));
    const restoredNo = data.versionNo;
    restoreData = null;
    $('#restoreDialog').close();
    showPublishResult('ok', `
      已按 <b>第 ${restoredNo} 版</b> 快照原子替换整个草稿：恢复事件 ${data.selection.length} 个（各带该版被选主张）、
      关系 ${data.idMap ? Object.keys(data.idMap.relations).length : 0} 条；草稿修订号现为 ${data.draftRevision}。
      历史快照与访客年表未变，可继续「校验能否发布」后发布为新版本。`);
    await loadState();
  } catch (e) {
    btn.disabled = false;
    if (e.status === 409) {
      // 草稿或最新版本在预览后发生变化：留在弹窗中，提示重新预览
      $('#refreshRestorePreview').hidden = false;
      const extra = e.body?.code === 'VERSION_CONFLICT'
        ? `预览后已发布第 ${e.body.currentVersionNo} 版。`
        : `草稿已被修改（修订号 ${e.body?.previewDraftRevision} → ${e.body?.currentDraftRevision}）。`;
      const box = document.createElement('div');
      box.className = 'alert error';
      box.textContent = `${extra}数据未被改动，请重新预览后再确认。`;
      $('#restoreBody').prepend(box);
    } else {
      const box = document.createElement('div');
      box.className = 'alert error';
      box.textContent = e.message;
      $('#restoreBody').prepend(box);
    }
  }
}

// ---------- 事件委托：增删改 ----------
async function onClick(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  if (t.id === 'tokenSave') {
    store.token = $('#tokenInput').value.trim();
    showGlobal('ok', '口令已保存到本浏览器。');
    await loadState();
    return;
  }
  if (t.id === 'btnValidate') return doValidate();
  if (t.id === 'btnPublish') return doPublish();

  if (t.id === 'conflictCancel') { $('#conflictDialog').close(); return; }
  if (t.id === 'conflictReload') {
    $('#conflictDialog').close();
    await loadState();
    showGlobal('warn', `已刷新到第 ${baseVersionNo} 版后的最新草稿。请重新确认各事件的主张选择，再点击发布。`);
    return;
  }

  const restorePreview = t.dataset && t.dataset.restorePreview;
  if (restorePreview !== undefined) return openRestorePreview(Number(restorePreview));
  if (t.id === 'restoreCancel') { $('#restoreDialog').close(); restoreData = null; return; }
  if (t.id === 'restoreConfirm') return doRestoreConfirm();
  if (t.id === 'refreshRestorePreview' && restoreData) {
    return openRestorePreview(restoreData.versionNo);
  }

  const addEvent = t.dataset && t.dataset.addEvent !== undefined;
  if (t.id === 'btnAddEvent') {
    const title = $('#newEventTitle').value.trim();
    if (!title) { showGlobal('error', '事件标题不能为空。'); return; }
    await api('POST', '/api/editor/events', { title, description: $('#newEventDesc').value });
    $('#newEventTitle').value = ''; $('#newEventDesc').value = '';
    await loadState();
    return;
  }

  const saveEvent = t.dataset && t.dataset.saveEvent;
  if (saveEvent) {
    const id = Number(saveEvent);
    const title = document.querySelector(`[data-edit-title="${id}"]`).value.trim();
    const description = document.querySelector(`[data-edit-desc="${id}"]`).value;
    if (!title) { showGlobal('error', '事件标题不能为空。'); return; }
    await api('PUT', `/api/editor/events/${id}`, { title, description });
    await loadState();
    return;
  }

  const delEvent = t.dataset && t.dataset.delEvent;
  if (delEvent) {
    if (!confirm(`删除事件「${titleOf(Number(delEvent))}」将同时删除其全部主张与相关先后关系，确定？`)) return;
    await api('DELETE', `/api/editor/events/${delEvent}`);
    await loadState();
    return;
  }

  const addClaim = t.dataset && t.dataset.addClaim;
  if (addClaim) {
    const id = Number(addClaim);
    const precision = document.querySelector(`[data-new-precision="${id}"]`).value;
    const year = Number(document.querySelector(`[data-new-year="${id}"]`).value);
    const monthEl = document.querySelector(`[data-new-month="${id}"]`);
    const dayEl = document.querySelector(`[data-new-day="${id}"]`);
    const payload = {
      precision,
      year,
      month: precision === 'year' ? undefined : Number(monthEl.value),
      day: precision === 'day' ? Number(dayEl.value) : undefined,
      source: document.querySelector(`[data-new-source="${id}"]`).value,
      note: document.querySelector(`[data-new-note="${id}"]`).value,
    };
    try {
      const data = await api('POST', `/api/editor/events/${id}/claims`, payload);
      store.setSelection(id, data.claim.id); // 新增主张默认选中，可改
      await loadState();
    } catch (err) { showGlobal('error', esc(err.message)); }
    return;
  }

  const delClaim = t.dataset && t.dataset.delClaim;
  if (delClaim) {
    if (!confirm('删除这条时间主张？')) return;
    await api('DELETE', `/api/editor/claims/${delClaim}`);
    await loadState();
    return;
  }

  if (t.id === 'btnAddRel') {
    const earlierId = Number($('#relEarlier').value);
    const laterId = Number($('#relLater').value);
    if (earlierId === laterId) { showGlobal('error', '一个事件不能先于自身。'); return; }
    try {
      await api('POST', '/api/editor/relations', {
        earlierId, laterId, source: $('#relSource').value,
      });
      $('#relSource').value = '';
      await loadState();
    } catch (err) { showGlobal('error', esc(err.message)); }
    return;
  }

  const delRel = t.dataset && t.dataset.delRel;
  if (delRel) {
    await api('DELETE', `/api/editor/relations/${delRel}`);
    await loadState();
  }
}

function onChange(e) {
  const claimId = e.target.dataset && e.target.dataset.selectClaim;
  if (claimId !== undefined) {
    const card = e.target.closest('.event-card');
    store.setSelection(Number(card.dataset.event), Number(claimId));
    render();
  }
}

// ---------- 启动 ----------
document.addEventListener('click', (e) => {
  onClick(e).catch((err) => {
    if (err.message !== 'unauthorized') showGlobal('error', esc(err.message));
  });
});
document.addEventListener('change', onChange);

$('#tokenInput').value = store.token;
$('#editorName').value = store.editor;
$('#editorName').addEventListener('input', (e) => { store.editor = e.target.value; });

(async function init() {
  if (!store.token) {
    showGlobal('warn', '请先在右上角输入编辑者口令（默认 <code>editor</code>，可用环境变量 EDITOR_TOKEN 修改），然后点“保存口令”。');
    return;
  }
  try {
    await loadState();
  } catch (err) {
    if (err.message !== 'unauthorized') showGlobal('error', esc(err.message));
  }
})();
