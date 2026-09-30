'use strict';

// 从任一已发布版本预览 / 恢复草稿。
//
// 预览（previewRestore）只读，列出该版事件、被选主张、「先于」关系，
// 以及当前草稿中将被替换的内容，不修改任何数据。
//
// 确认（confirmRestore）须提交预览时拿到的草稿修订号 draftRevision
// 和当时的最新版本号 latestVersionNo：
//   - 版本不存在 -> 404；
//   - 确认前草稿发生过任何增删改（修订号变化）-> 409，不改数据；
//   - 确认前最新版本号变化（期间有新版发布）-> 409，不改数据；
// 确认成功时在单个事务内原子替换整个草稿（events/claims/relations），
// 按快照重建关联，只恢复该版被选主张（同一事件未入选的矛盾主张不恢复）。
// 历史快照表与访客年表始终不受影响。

const { getDb } = require('./db');
const { ordinalFromIso } = require('./dates');

function currentDraftRevision(db = getDb()) {
  const row = db.prepare('SELECT revision FROM draft_meta WHERE id = 1').get();
  return row ? row.revision : 0;
}

// 在事务末尾推进一次草稿修订号。供全部草稿增删改接口与恢复确认使用。
function bumpDraftRevision(db = getDb()) {
  db.prepare('UPDATE draft_meta SET revision = revision + 1 WHERE id = 1').run();
}

// 快照主张行没有 year/month/day 数值列，按精度由区间起点恢复。
function snapshotClaimParts(ev) {
  const ord = ordinalFromIso(ev.intervalStart);
  const d = new Date(ord * 86400000);
  const year = d.getUTCFullYear();
  if (ev.precision === 'year') return { year, month: null, day: null };
  const month = d.getUTCMonth() + 1;
  if (ev.precision === 'month') return { year, month, day: null };
  return { year, month, day: d.getUTCDate() };
}

function draftEventApi(e, claims) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    claims,
  };
}

function claimRowToApi(c) {
  return {
    id: c.id,
    eventId: c.event_id,
    precision: c.precision,
    year: c.year,
    month: c.month,
    day: c.day,
    dateLabel: c.date_label,
    intervalStart: c.interval_start,
    intervalEnd: c.interval_end,
    source: c.source,
    note: c.note,
  };
}

function relationRowToApi(r) {
  return {
    id: r.id,
    earlierId: r.earlier_id,
    laterId: r.later_id,
    source: r.source,
    note: r.note,
  };
}

// 当前草稿全貌（预览时展示「将被替换的内容」）。
function readDraft(db) {
  const events = db.prepare('SELECT * FROM events ORDER BY id').all().map((e) => {
    const claims = db
      .prepare('SELECT * FROM claims WHERE event_id = ? ORDER BY id')
      .all(e.id)
      .map(claimRowToApi);
    return draftEventApi(e, claims);
  });
  const relations = db.prepare('SELECT * FROM relations ORDER BY id').all().map(relationRowToApi);
  return { events, relations };
}

// 版本快照全貌，结构与 /api/public/versions/:no 一致；不存在返回 null。
function readVersionSnapshot(db, no) {
  const v = db
    .prepare(
      `SELECT id, version_no AS versionNo, parent_no AS parentNo, editor, note,
              published_at AS publishedAt
         FROM versions WHERE version_no = ?`
    )
    .get(no);
  if (!v) return null;
  const events = db
    .prepare(
      `SELECT event_id AS eventId, title, description, claim_id AS claimId, precision,
              date_label AS dateLabel, interval_start AS intervalStart,
              interval_end AS intervalEnd, resolved_date AS resolvedDate,
              source, claim_note AS claimNote, sort_order AS sortOrder
         FROM version_events WHERE version_id = ? ORDER BY sort_order`
    )
    .all(v.id);
  const relations = db
    .prepare(
      `SELECT relation_id AS relationId, earlier_event_id AS earlierEventId,
              later_event_id AS laterEventId, source, note, sort_order AS sortOrder
         FROM version_relations WHERE version_id = ? ORDER BY sort_order`
    )
    .all(v.id);
  return {
    versionNo: v.versionNo,
    parentNo: v.parentNo,
    editor: v.editor,
    note: v.note,
    publishedAt: v.publishedAt,
    events,
    relations,
  };
}

// ---------- 预览（只读，绝不改数据） ----------
function previewRestore(versionNo) {
  const db = getDb();
  const snapshot = readVersionSnapshot(db, versionNo);
  if (!snapshot) {
    throw { status: 404, message: `版本 ${versionNo} 不存在，无法预览恢复` };
  }
  const draft = readDraft(db);
  const latest = db.prepare('SELECT MAX(version_no) AS no FROM versions').get().no || 0;
  return {
    versionNo: snapshot.versionNo,
    currentVersionNo: latest,
    draftRevision: currentDraftRevision(db),
    version: snapshot,
    draftToReplace: draft,
  };
}

// ---------- 确认：原子替换整个草稿 ----------
function confirmRestore({ versionNo, draftRevision, latestVersionNo }) {
  const db = getDb();

  const snapshot = readVersionSnapshot(db, versionNo);
  if (!snapshot) {
    throw { status: 404, message: `版本 ${versionNo} 不存在，无法恢复` };
  }

  const tx = db.transaction(() => {
    // 与发布相同的乐观约定：在事务内再次确认，避免并发静默覆盖。
    const revNow = currentDraftRevision(db);
    if (revNow !== draftRevision) {
      throw {
        status: 409,
        code: 'DRAFT_REVISION_CONFLICT',
        message: `草稿已被修改：预览时修订号为 ${draftRevision}，当前为 ${revNow}。请重新预览后再确认恢复。`,
        previewDraftRevision: draftRevision,
        currentDraftRevision: revNow,
      };
    }
    const latestNow = db.prepare('SELECT MAX(version_no) AS no FROM versions').get().no || 0;
    if (latestNow !== latestVersionNo) {
      throw {
        status: 409,
        code: 'VERSION_CONFLICT',
        message: `预览后已发布新版本：预览时最新为第 ${latestVersionNo} 版，当前为第 ${latestNow} 版。请重新预览后再确认恢复。`,
        baseVersionNo: latestVersionNo,
        currentVersionNo: latestNow,
      };
    }

    // 1) 清空整个草稿（claims/relations 借外键 ON DELETE CASCADE 一并删除，
    //    但显式删除更直观，也保证关系来源事件若有遗漏时不留残边）。
    db.prepare('DELETE FROM relations').run();
    db.prepare('DELETE FROM claims').run();
    db.prepare('DELETE FROM events').run();

    const insEvent = db.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
    const insClaim = db.prepare(`
      INSERT INTO claims
        (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insRel = db.prepare(
      'INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)'
    );

    // 2) 按快照重建事件，仅恢复该版被选主张（每事件一条）。
    const eventMap = new Map(); // 快照事件 id（event_id 列）-> 新草稿事件
    for (const ev of snapshot.events) {
      const info = insEvent.run(ev.title, ev.description);
      const newEventId = Number(info.lastInsertRowid);
      eventMap.set(ev.eventId, newEventId);
      const parts = snapshotClaimParts(ev);
      const claimInfo = insClaim.run(
        newEventId,
        ev.precision,
        parts.year,
        parts.month,
        parts.day,
        ev.dateLabel,
        ev.intervalStart,
        ev.intervalEnd,
        ev.source || '',
        ev.claimNote || ''
      );
      eventMap.set(ev.eventId, {
        eventId: newEventId,
        claimId: Number(claimInfo.lastInsertRowid),
        oldClaimId: ev.claimId,
        title: ev.title,
      });
    }

    // 3) 按快照重建「先于」关系。
    const relations = [];
    for (const r of snapshot.relations) {
      const earlierId = eventMap.get(r.earlierEventId);
      const laterId = eventMap.get(r.laterEventId);
      // 正常情况下快照内每条关系两端都在快照事件中；防御性跳过异常快照。
      if (!earlierId || !laterId) continue;
      const info = insRel.run(earlierId.eventId, laterId.eventId, r.source || '', r.note || '');
      relations.push({
        id: Number(info.lastInsertRowid),
        oldRelationId: r.relationId,
        earlierId: earlierId.eventId,
        laterId: laterId.eventId,
      });
    }

    // 整个恢复只推进一次修订号（而非按插入条数推进）。
    bumpDraftRevision(db);

    const events = [...eventMap.entries()].map(([oldEventId, m]) => ({
      oldEventId,
      eventId: m.eventId,
      oldClaimId: m.oldClaimId,
      claimId: m.claimId,
      title: m.title,
    }));

    return { events, relations };
  });

  const { events, relations } = tx();

  // 旧快照 id -> 新草稿 id 映射，供编辑台把本地选择迁移到新行。
  const eventIdMap = {};
  const claimIdMap = {};
  const relationIdMap = {};
  const selection = [];
  for (const e of events) {
    eventIdMap[e.oldEventId] = e.eventId;
    claimIdMap[e.oldClaimId] = e.claimId;
    selection.push({ eventId: e.eventId, claimId: e.claimId, oldEventId: e.oldEventId, oldClaimId: e.oldClaimId });
  }
  for (const r of relations) {
    relationIdMap[r.oldRelationId] = r.id;
  }

  // 返回替换后的草稿全貌，编辑台可直接渲染并继续校验 / 发布。
  const draft = readDraft(db);

  return {
    ok: true,
    versionNo: snapshot.versionNo,
    currentVersionNo: latestVersionNo,
    draftRevision: currentDraftRevision(db),
    idMap: { events: eventIdMap, claims: claimIdMap, relations: relationIdMap },
    // 恢复后每个事件只有当版被选主张，供编辑台继续校验发布。
    selection,
    pendingSelection: selection,
    ...draft,
  };
}

module.exports = {
  previewRestore,
  confirmRestore,
  currentDraftRevision,
  bumpDraftRevision,
};
