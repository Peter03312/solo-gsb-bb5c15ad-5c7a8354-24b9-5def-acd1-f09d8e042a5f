'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

// 每个测试文件独立内存库
const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0 WHERE id = 1;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title, description = '') {
  const r = await call('POST', '/api/editor/events', { body: { title, description } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}

async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}

async function makeRel(earlierId, laterId, source = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId, laterId, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}

test('编辑者接口需要口令；访客接口公开', async () => {
  const r1 = await call('GET', '/api/editor/state', { token: null });
  assert.strictEqual(r1.status, 401);
  const r2 = await call('GET', '/api/editor/state', { token: 'wrong' });
  assert.strictEqual(r2.status, 401);
  const r3 = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(r3.status, 200);
  assert.strictEqual(r3.json.published, false);
});

test('完整发布流程：矛盾主张可共存，选其中一条发布快照', async () => {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1a = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
  const c1b = await makeClaim(e1, { precision: 'year', year: 1958, source: '县水利志第87页' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
  await makeRel(e1, e2, '二人口述一致');

  // 同事件两条矛盾主张并存
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.events.find((e) => e.id === e1).claims.length, 2);

  // 选 c1a（1958-09-12）与 c2（1959 年 5 月）
  const pub = await call('POST', '/api/editor/publish', {
    body: {
      selection: [{ eventId: e1, claimId: c1a }, { eventId: e2, claimId: c2 }],
      baseVersionNo: 0,
      editor: '测试员甲',
      note: '首版',
    },
  });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json));
  assert.strictEqual(pub.json.versionNo, 1);
  assert.strictEqual(pub.json.version.events[0].title, '动员会');
  assert.strictEqual(pub.json.version.events[0].resolvedDate, '1958-09-12');
  assert.strictEqual(pub.json.version.events[1].resolvedDate, '1959-05-01');
  assert.strictEqual(pub.json.version.relations[0].source, '二人口述一致');

  // 访客只能看到发布版与所选出处
  const pubView = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pubView.status, 200);
  assert.strictEqual(pubView.json.currentVersionNo, 1);
  assert.strictEqual(pubView.json.version.events.length, 2);
  const dongyuan = pubView.json.version.events.find((e) => e.title === '动员会');
  assert.strictEqual(dongyuan.claimId, c1a);
  assert.strictEqual(dongyuan.source, '李宝山口述');
});

test('缺主张无法发布并指明事件；无版本时访客看不到草稿', async () => {
  const e1 = await makeEvent('有主张');
  await makeEvent('无主张');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1960, source: '档案' });
  const st = await call('GET', '/api/editor/state');
  const e2 = st.json.events.find((e) => e.title === '无主张').id;

  const r = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: 0 }], baseVersionNo: 0 },
  });
  // claimId 0 不存在 -> bad_selection（而非缺主张，二者都阻止发布）
  assert.strictEqual(r.status, 422);
  assert.ok(['bad_selection', 'missing'].includes(r.json.errors[0].type));
  assert.ok(r.json.errors[0].eventIds.includes(e2));

  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, false);
});

test('成环发布被拒并报出涉事事件与关系；上一版本保留', async () => {
  const e1 = await makeEvent('A');
  const e2 = await makeEvent('B');
  const e3 = await makeEvent('C');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  const c2 = await makeClaim(e2, { precision: 'year', year: 1958, source: 's' });
  const c3 = await makeClaim(e3, { precision: 'year', year: 1958, source: 's' });
  await makeRel(e1, e2);
  await makeRel(e2, e3);

  // 先发一版好的（DAG）
  const ok = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }], baseVersionNo: 0 },
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));

  // 草稿加回边 C->A 形成环，再发 -> 422 cycle，版本仍为 1
  const ringEdgeId = await makeRel(e3, e1, '环边出处');
  const bad = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }], baseVersionNo: 1 },
  });
  assert.strictEqual(bad.status, 422);
  assert.strictEqual(bad.json.errors[0].type, 'cycle');
  assert.deepStrictEqual(new Set(bad.json.errors[0].eventIds), new Set([e1, e2, e3]));
  assert.ok(bad.json.errors[0].relationIds.includes(ringEdgeId));
  assert.match(bad.json.errors[0].message, /成环/);
  assert.match(bad.json.errors[0].detail, /环边出处/);

  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
});

test('时间无解被拒并给见证链；上一版本保留', async () => {
  const e1 = await makeEvent('冬月会议');
  const e2 = await makeEvent('春月会议');
  const c1 = await makeClaim(e1, { precision: 'month', year: 1958, month: 12, source: 's1' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1958, month: 1, source: 's2' });
  await makeRel(e1, e2);

  const r = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, false);
  assert.strictEqual(r.json.errors[0].type, 'temporal');
  assert.deepStrictEqual(r.json.errors[0].eventIds, [e1, e2]);

  const r2 = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 0 },
  });
  assert.strictEqual(r2.status, 422);
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, false);
});

test('版本冲突：两位编辑基于同一版本，后者发布得到 409，且未覆盖前者', async () => {
  const e1 = await makeEvent('事件甲');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });

  // 编辑甲基于 0 发布 -> 第 1 版
  const a = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }], baseVersionNo: 0, editor: '甲' },
  });
  assert.strictEqual(a.status, 201);
  assert.strictEqual(a.json.versionNo, 1);

  // 草稿新增事件；编辑乙仍基于 0 提交
  const e2 = await makeEvent('事件乙');
  const c2 = await makeClaim(e2, { precision: 'year', year: 1960, source: 's2' });
  const b = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 0, editor: '乙' },
  });
  assert.strictEqual(b.status, 409);
  assert.strictEqual(b.json.code, 'VERSION_CONFLICT');
  assert.strictEqual(b.json.currentVersionNo, 1);
  assert.strictEqual(b.json.baseVersionNo, 0);

  // 最新仍为第 1 版（未被乙静默覆盖）
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
  assert.strictEqual(view.json.version.eventCount, 1);

  // 乙重新基于 1 确认后发布 -> 第 2 版
  const b2 = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 1, editor: '乙' },
  });
  assert.strictEqual(b2.status, 201);
  assert.strictEqual(b2.json.versionNo, 2);
  assert.strictEqual(b2.json.version.parentNo, 1);

  // 旧版快照不可变且仍可取
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.status, 200);
  assert.strictEqual(v1.json.version.eventCount, 1);
});

test('发布后继续改草稿不影响已发布快照', async () => {
  const e1 = await makeEvent('老标题');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 3, day: 1, source: 's' });
  await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }], baseVersionNo: 0 },
  });

  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '新标题', description: '改了' } });
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.json.version.events[0].title, '老标题');

  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events[0].title, '老标题');
});

test('自环关系在录入时即被拒绝', async () => {
  const e1 = await makeEvent('X');
  const r = await call('POST', '/api/editor/relations', { body: { earlierId: e1, laterId: e1 } });
  assert.strictEqual(r.status, 400);
});

// ============ 草稿修订号 ============
test('草稿增删改都推进修订号；发布与只读接口不推进', async () => {
  const st0 = await call('GET', '/api/editor/state');
  assert.strictEqual(st0.json.draftRevision, 0);

  const e1 = await makeEvent('修订事件'); // +1
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' }); // +1
  const st1 = await call('GET', '/api/editor/state');
  assert.strictEqual(st1.json.draftRevision, 2);

  await call('PUT', `/api/editor/claims/${c1}`, { body: { precision: 'year', year: 1959, source: 's2' } }); // +1
  await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }], baseVersionNo: 0 },
  }); // 发布只写快照区，不推进草稿修订号
  const st2 = await call('GET', '/api/editor/state');
  assert.strictEqual(st2.json.draftRevision, 3);
  assert.strictEqual(st2.json.currentVersionNo, 1);

  const rel = await call('POST', '/api/editor/relations', { body: { earlierId: e1, laterId: e1 } }); // 自环被拒：不推进
  assert.strictEqual(rel.status, 400);
  // 自环请求走不到事务（上面返回 400），修订号不变
  const st3 = await call('GET', '/api/editor/state');
  assert.strictEqual(st3.json.draftRevision, 3);

  await call('DELETE', `/api/editor/claims/${c1}`); // +1
  const st4 = await call('GET', '/api/editor/state');
  assert.strictEqual(st4.json.draftRevision, 4);
});

test('删除事件连带其主张与关系，整个操作只推进一次修订号', async () => {
  const e1 = await makeEvent('A');
  const e2 = await makeEvent('B');
  await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  await makeClaim(e2, { precision: 'year', year: 1959, source: 's' });
  await makeRel(e1, e2);
  const before = (await call('GET', '/api/editor/state')).json.draftRevision;
  await call('DELETE', `/api/editor/events/${e1}`);
  const after = (await call('GET', '/api/editor/state')).json.draftRevision;
  assert.strictEqual(after, before + 1);
  // 关系随事件级联删除
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.relations.length, 0);
  assert.strictEqual(st.json.events.length, 1);
});

// ============ 从历史版本恢复草稿 ============
async function publishV1AndV2() {
  // v1：2 个事件，每事件 2 条主张，1 条关系；只发布其中一条选择
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1a = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '口述甲' });
  const c1b = await makeClaim(e1, { precision: 'year', year: 1958, source: '志书' }); // 未入选
  const c2a = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '口述乙' });
  const c2b = await makeClaim(e2, { precision: 'year', year: 1960, source: '档案' }); // 未入选
  const relId = await makeRel(e1, e2, '二人口述一致');
  const pub1 = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1a }, { eventId: e2, claimId: c2a }], baseVersionNo: 0, editor: '甲', note: '第一版' },
  });
  assert.strictEqual(pub1.status, 201, JSON.stringify(pub1.json));

  // v2：草稿加一个事件后发布
  const e3 = await makeEvent('抽水机到站');
  const c3 = await makeClaim(e3, { precision: 'year', year: 1962, source: '口述丙' });
  await makeRel(e2, e3);
  const pub2 = await call('POST', '/api/editor/publish', {
    body: {
      selection: [{ eventId: e1, claimId: c1a }, { eventId: e2, claimId: c2a }, { eventId: e3, claimId: c3 }],
      baseVersionNo: 1, editor: '甲', note: '第二版',
    },
  });
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json));
  return { e1, e2, e3, c1a, c1b, c2a, c2b, c3, relId };
}

test('恢复预览只读：列出该版与将被替换的草稿，不改任何数据', async () => {
  await publishV1AndV2();
  const before = await call('GET', '/api/editor/state');

  const pv = await call('POST', '/api/editor/restore/preview', { body: { versionNo: 1 } });
  assert.strictEqual(pv.status, 200, JSON.stringify(pv.json));
  assert.strictEqual(pv.json.versionNo, 1);
  assert.strictEqual(pv.json.currentVersionNo, 2);
  assert.strictEqual(pv.json.draftRevision, before.json.draftRevision);
  // 该版事件 / 被选主张 / 关系
  assert.strictEqual(pv.json.version.events.length, 2);
  const vev = pv.json.version.events[0];
  assert.strictEqual(vev.title, '动员会');
  assert.strictEqual(vev.intervalStart, '1958-09-12');
  assert.strictEqual(vev.source, '口述甲');
  assert.strictEqual(pv.json.version.relations.length, 1);
  assert.strictEqual(pv.json.version.relations[0].source, '二人口述一致');
  // 将被替换的当前草稿（v2 后 3 个事件、3 条关系含未发布关系）
  assert.strictEqual(pv.json.draftToReplace.events.length, 3);
  assert.strictEqual(pv.json.draftToReplace.relations.length, 2);

  // 预览前后草稿完全一致（修订号、事件数都没变）
  const after = await call('GET', '/api/editor/state');
  assert.strictEqual(after.json.draftRevision, before.json.draftRevision);
  assert.strictEqual(after.json.events.length, before.json.events.length);
});

test('预览不存在的版本报 404；参数非法报 400', async () => {
  const r = await call('POST', '/api/editor/restore/preview', { body: { versionNo: 99 } });
  assert.strictEqual(r.status, 404);
  const r2 = await call('POST', '/api/editor/restore/preview', { body: {} });
  assert.strictEqual(r2.status, 400);
});

test('确认恢复：原子替换整个草稿、只恢复被选主张、重建关系，返回映射与待选主张', async () => {
  const ids = await publishV1AndV2();

  // 草稿目前是 v2 后状态（3 事件、3 条主张发布选择外还有未入选矛盾主张、2 关系）
  const stBefore = await call('GET', '/api/editor/state');
  assert.strictEqual(stBefore.json.events.length, 3);
  assert.strictEqual(stBefore.json.events.find((e) => e.id === ids.e1).claims.length, 2);

  const pv = await call('POST', '/api/editor/restore/preview', { body: { versionNo: 1 } });
  assert.strictEqual(pv.status, 200);

  const cf = await call('POST', '/api/editor/restore/confirm', {
    body: { versionNo: 1, draftRevision: pv.json.draftRevision, latestVersionNo: 2 },
  });
  assert.strictEqual(cf.status, 200, JSON.stringify(cf.json));

  // 修订号推进一次
  assert.ok(cf.json.draftRevision > pv.json.draftRevision);
  assert.strictEqual(cf.json.draftRevision, pv.json.draftRevision + 1);

  // 草稿变为第 1 版内容：2 事件，每事件仅 1 条（被选）主张，1 条关系
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.events.length, 2);
  assert.deepStrictEqual(st.json.events.map((e) => e.title).sort(), ['动员会', '通水会']);
  for (const e of st.json.events) {
    assert.strictEqual(e.claims.length, 1, `事件「${e.title}」应只剩 1 条被选主张`);
  }
  assert.strictEqual(st.json.relations.length, 1);

  // 被恢复的是当版所选主张（口述甲 1958-09-12 / 口述乙 1959-05），未入选主张不回来
  const restoredE1 = st.json.events.find((e) => e.title === '动员会');
  assert.strictEqual(restoredE1.claims[0].source, '口述甲');
  assert.strictEqual(restoredE1.claims[0].precision, 'day');
  assert.strictEqual(restoredE1.claims[0].year, 1958);
  assert.strictEqual(restoredE1.claims[0].month, 9);
  assert.strictEqual(restoredE1.claims[0].day, 12);
  const restoredE2 = st.json.events.find((e) => e.title === '通水会');
  assert.strictEqual(restoredE2.claims[0].precision, 'month');
  assert.strictEqual(restoredE2.claims[0].month, 5);
  assert.strictEqual(restoredE2.claims[0].day, null);
  assert.strictEqual(st.json.relations[0].source, '二人口述一致');

  // 关联按快照重建：关系两端指向新草稿事件 id
  const newE1 = restoredE1.id;
  const newE2 = restoredE2.id;
  assert.strictEqual(st.json.relations[0].earlierId, newE1);
  assert.strictEqual(st.json.relations[0].laterId, newE2);

  // 旧快照 id -> 新草稿 id 映射
  assert.strictEqual(cf.json.idMap.events[String(ids.e1)], newE1);
  assert.strictEqual(cf.json.idMap.events[String(ids.e2)], newE2);
  assert.strictEqual(cf.json.idMap.claims[String(ids.c1a)], restoredE1.claims[0].id);
  assert.strictEqual(cf.json.idMap.relations[String(ids.relId)], st.json.relations[0].id);
  // 未入选主张不出现在映射里
  assert.strictEqual(cf.json.idMap.claims[String(ids.c1b)], undefined);

  // 待选主张：每事件一条，供编辑台继续校验发布
  assert.strictEqual(cf.json.selection.length, 2);
  assert.deepStrictEqual(cf.json.pendingSelection, cf.json.selection);
  const selByNewEvent = new Map(cf.json.selection.map((s) => [s.eventId, s.claimId]));
  assert.strictEqual(selByNewEvent.get(newE1), restoredE1.claims[0].id);
  assert.strictEqual(selByNewEvent.get(newE2), restoredE2.claims[0].id);

  // 历史快照与访客年表不变
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 2);
  assert.strictEqual(view.json.version.events.length, 3);
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.json.version.events.length, 2);
  const v2 = await call('GET', '/api/public/versions/2', { token: null });
  assert.strictEqual(v2.json.version.events.length, 3);

  // 恢复后的草稿可继续走现有校验与发布（baseVersionNo=2）-> 第 3 版
  const validate = await call('POST', '/api/editor/validate', {
    body: { selection: cf.json.selection.map((s) => ({ eventId: s.eventId, claimId: s.claimId })) },
  });
  assert.strictEqual(validate.json.ok, true, JSON.stringify(validate.json));
  const pub3 = await call('POST', '/api/editor/publish', {
    body: {
      selection: cf.json.selection.map((s) => ({ eventId: s.eventId, claimId: s.claimId })),
      baseVersionNo: 2, editor: '乙', note: '回到第1版内容重新发布',
    },
  });
  assert.strictEqual(pub3.status, 201, JSON.stringify(pub3.json));
  assert.strictEqual(pub3.json.versionNo, 3);
  assert.strictEqual(pub3.json.version.parentNo, 2);
  assert.strictEqual(pub3.json.version.events.length, 2);
});

test('确认前草稿被改过 -> 409 DRAFT_REVISION_CONFLICT 且不改数据', async () => {
  await publishV1AndV2();
  const pv = await call('POST', '/api/editor/restore/preview', { body: { versionNo: 1 } });

  // 另一位编辑者在预览后改动草稿
  await makeEvent('预览后新加的事件');

  const cf = await call('POST', '/api/editor/restore/confirm', {
    body: { versionNo: 1, draftRevision: pv.json.draftRevision, latestVersionNo: pv.json.currentVersionNo },
  });
  assert.strictEqual(cf.status, 409, JSON.stringify(cf.json));
  assert.strictEqual(cf.json.code, 'DRAFT_REVISION_CONFLICT');
  assert.strictEqual(cf.json.previewDraftRevision, pv.json.draftRevision);
  assert.ok(cf.json.currentDraftRevision > pv.json.draftRevision);

  // 草稿没被替换：仍是 3 个原事件 + 新加的 1 个
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.events.length, 4);
  assert.ok(st.json.events.some((e) => e.title === '抽水机到站'));
});

test('确认前发布了新版本 -> 409 VERSION_CONFLICT 且不改数据', async () => {
  const ids = await publishV1AndV2();
  const pv = await call('POST', '/api/editor/restore/preview', { body: { versionNo: 1 } });

  // 预览后发布第 3 版（不改草稿，只产生新版本号）
  const st = await call('GET', '/api/editor/state');
  const sel = st.json.events.map((e) => ({ eventId: e.id, claimId: e.claims[0].id }));
  const pub3 = await call('POST', '/api/editor/publish', {
    body: { selection: sel, baseVersionNo: 2 },
  });
  assert.strictEqual(pub3.status, 201);

  const cf = await call('POST', '/api/editor/restore/confirm', {
    body: { versionNo: 1, draftRevision: pv.json.draftRevision, latestVersionNo: 2 },
  });
  assert.strictEqual(cf.status, 409, JSON.stringify(cf.json));
  assert.strictEqual(cf.json.code, 'VERSION_CONFLICT');
  assert.strictEqual(cf.json.baseVersionNo, 2);
  assert.strictEqual(cf.json.currentVersionNo, 3);

  // 草稿未被替换：仍是 v2 的 3 事件结构
  const stAfter = await call('GET', '/api/editor/state');
  assert.strictEqual(stAfter.json.events.length, 3);
  assert.strictEqual(stAfter.json.events.find((e) => e.id === ids.e1).claims.length, 2);
});

test('确认恢复不存在的版本报 404；非法参数报 400', async () => {
  const r = await call('POST', '/api/editor/restore/confirm', {
    body: { versionNo: 99, draftRevision: 0, latestVersionNo: 0 },
  });
  assert.strictEqual(r.status, 404);
  const r2 = await call('POST', '/api/editor/restore/confirm', {
    body: { versionNo: 1, draftRevision: 'x', latestVersionNo: 0 },
  });
  assert.strictEqual(r2.status, 400);
});

test('恢复接口同样需要编辑者口令', async () => {
  const r = await call('POST', '/api/editor/restore/preview', { token: null, body: { versionNo: 1 } });
  assert.strictEqual(r.status, 401);
  const r2 = await call('POST', '/api/editor/restore/confirm', {
    token: null, body: { versionNo: 1, draftRevision: 0, latestVersionNo: 0 },
  });
  assert.strictEqual(r2.status, 401);
});
