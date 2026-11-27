/** Transactional project awards, pending turn reviews, and private evaluator request history. */
import { createRequire } from 'node:module'
import { closeSync, constants, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HABIT_BADGE_KINDS, badgeCategory } from './badges-kinds.js'

const APPLICATION_ID = 0x52424447 // RBDG
const SCHEMA_VERSION = 3

const CREATE_REVIEWS_SQL = `CREATE TABLE reviews (
  sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'mechanical',
  projectId TEXT NOT NULL, targets TEXT NOT NULL, status TEXT NOT NULL, worker TEXT, pid INTEGER,
  PRIMARY KEY (sessionId, turnEndSeq, scope)
);`

const CREATE_AWARDS_V3_SQL = `CREATE TABLE awards (
  projectId TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL PRIMARY KEY, earnedAt TEXT NOT NULL,
  sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, detail TEXT NOT NULL
);
CREATE UNIQUE INDEX awards_mechanical_unique
  ON awards(projectId, kind)
  WHERE json_extract(detail, '$.category') IS NULL OR json_extract(detail, '$.category') = 'mechanical';
CREATE UNIQUE INDEX awards_habit_turn_unique
  ON awards(projectId, kind, sessionId, turnEndSeq)
  WHERE json_extract(detail, '$.category') = 'habit';`

/** Open the local badge database. Claims serialize reviews within each project across hosts.
 * @param {string} path Database path in the Rumi home.
 * @returns {object} Synchronous transactions and a disposer for this review worker.
 */
export function openBadgeStore(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  closeSync(openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600))
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const db = new DatabaseSync(path)
  const owner = randomUUID()
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE')
    const { application_id: application } = db.prepare('PRAGMA application_id').get()
    const { user_version: version } = db.prepare('PRAGMA user_version').get()
    if (application === 0 && version === 0 && !db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
      db.exec(`${CREATE_REVIEWS_SQL}
      ${CREATE_AWARDS_V3_SQL}
      CREATE TABLE requests (
        id INTEGER PRIMARY KEY, sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, payload TEXT NOT NULL
      );
      PRAGMA application_id=${APPLICATION_ID};
      PRAGMA user_version=${SCHEMA_VERSION}`)
    } else if (application === APPLICATION_ID && (version === 1 || version === 2)) {
      if (version === 1) {
        db.exec(`CREATE TABLE reviews_v2 (
          sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'mechanical',
          projectId TEXT NOT NULL, targets TEXT NOT NULL, status TEXT NOT NULL, worker TEXT, pid INTEGER,
          PRIMARY KEY (sessionId, turnEndSeq, scope)
        );
        INSERT INTO reviews_v2(sessionId, turnEndSeq, scope, projectId, targets, status, worker, pid)
          SELECT sessionId, turnEndSeq, 'mechanical', projectId, targets, status, worker, pid FROM reviews;
        DROP TABLE reviews;
        ALTER TABLE reviews_v2 RENAME TO reviews;`)
      }
      db.exec(`CREATE TABLE awards_v3 (
        projectId TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL PRIMARY KEY, earnedAt TEXT NOT NULL,
        sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, detail TEXT NOT NULL
      );
      INSERT INTO awards_v3(projectId, kind, id, earnedAt, sessionId, turnEndSeq, detail)
        SELECT projectId, kind, id, earnedAt, sessionId, turnEndSeq, detail FROM awards;
      DROP TABLE awards;
      ALTER TABLE awards_v3 RENAME TO awards;
      CREATE UNIQUE INDEX awards_mechanical_unique
        ON awards(projectId, kind)
        WHERE json_extract(detail, '$.category') IS NULL OR json_extract(detail, '$.category') = 'mechanical';
      CREATE UNIQUE INDEX awards_habit_turn_unique
        ON awards(projectId, kind, sessionId, turnEndSeq)
        WHERE json_extract(detail, '$.category') = 'habit';
      PRAGMA user_version=${SCHEMA_VERSION}`)
    } else if (application !== APPLICATION_ID || version !== SCHEMA_VERSION) {
      throw new Error('The badge database has an unrecognized schema')
    }
    db.exec('COMMIT')
    for (const { pid } of db.prepare("SELECT DISTINCT pid FROM reviews WHERE status='running'").all()) {
      try { process.kill(pid, 0) }
      catch (error) {
        if (error.code === 'ESRCH') db.prepare("UPDATE reviews SET status='pending',worker=NULL,pid=NULL WHERE pid=?").run(pid)
        else if (error.code !== 'EPERM') throw error
      }
    }
  } catch (error) { db.close(); throw error }

  function finish(job, status) {
    const scope = job.scope ?? 'mechanical'
    const result = db.prepare('UPDATE reviews SET status=?,worker=NULL,pid=NULL WHERE sessionId=? AND turnEndSeq=? AND scope=? AND worker=?')
      .run(status, job.sessionId, job.turnEndSeq, scope, owner)
    if (result.changes !== 1) throw new Error('Badge review ownership changed')
  }

  return {
    enqueue(projectId, sessionId, turnEndSeq, targets, scope = 'mechanical') {
      db.prepare(`INSERT OR IGNORE INTO reviews(projectId,sessionId,turnEndSeq,scope,targets,status) VALUES(?,?,?,?,?,'pending')`)
        .run(projectId, sessionId, turnEndSeq, scope, JSON.stringify(targets))
    },
    take(projectId) {
      const row = db.prepare(`UPDATE reviews SET status='running',worker=?,pid=? WHERE rowid=(
        SELECT rowid FROM reviews WHERE projectId=? AND status='pending'
          AND NOT EXISTS(SELECT 1 FROM reviews WHERE projectId=? AND status='running')
        ORDER BY rowid LIMIT 1
      ) RETURNING projectId,sessionId,turnEndSeq,scope,targets`).get(owner, process.pid, projectId, projectId)
      return row ? { ...row, targets: JSON.parse(row.targets) } : null
    },
    recordRequest(job, request) {
      db.prepare('INSERT INTO requests(sessionId,turnEndSeq,payload) VALUES(?,?,?)')
        .run(job.sessionId, job.turnEndSeq, JSON.stringify(request))
    },
    /** @returns {object[]} Award IDs, kinds, and optional habit paths inserted by the committed transaction. */
    commit(job, awards) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const inserted = []
        const findMechanical = db.prepare('SELECT id, detail FROM awards WHERE projectId=? AND kind=? LIMIT 1')
        const insertAward = db.prepare('INSERT OR IGNORE INTO awards(projectId,kind,id,earnedAt,sessionId,turnEndSeq,detail) VALUES(?,?,?,?,?,?,?)')
        const promoteMechanical = db.prepare('UPDATE awards SET sessionId=?,turnEndSeq=?,detail=? WHERE id=?')
        for (const award of awards) {
          const category = badgeCategory(award.kind)
          const normalized = category ? { category, ...award } : award
          const payload = JSON.stringify(normalized)
          if (category === 'habit') {
            const id = randomUUID()
            const result = insertAward.run(job.projectId, award.kind, id, new Date().toISOString(), job.sessionId, job.turnEndSeq, payload)
            if (result.changes === 1) {
              inserted.push({ id, kind: award.kind, ...(award.path ? { path: award.path } : {}) })
            }
          } else {
            const existing = findMechanical.get(job.projectId, award.kind)
            if (!existing) {
              const id = randomUUID()
              const result = insertAward.run(job.projectId, award.kind, id, new Date().toISOString(), job.sessionId, job.turnEndSeq, payload)
              if (result.changes === 1) inserted.push({ id, kind: award.kind })
            } else {
              const previous = JSON.parse(existing.detail)
              if (previous.working === false && award.working === true) {
                promoteMechanical.run(job.sessionId, job.turnEndSeq, payload, existing.id)
              }
            }
          }
        }
        finish(job, 'done')
        db.exec('COMMIT')
        return inserted
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    fail(job) { finish(job, 'failed') },
    retry(projectId, sessionId) {
      return Number(db.prepare("UPDATE reviews SET status='pending' WHERE status='failed' AND projectId=? AND sessionId=?").run(projectId, sessionId).changes)
    },
    earnedKinds(projectId) {
      return [...new Set(db.prepare('SELECT kind FROM awards WHERE projectId=?').all(projectId).map(row => row.kind))]
    },
    /** Summarize previously earned habit awards for one project and current session watermark.
     * @param {string} projectId Registered project ID.
     * @param {string} sessionId Active session ID for per-session turnEndSeq watermarks.
     * @returns {Record<string, {count: number, lastEarnedAt: string | null, lastSessionTurnEndSeq: number, recentEvidence: string[]}>}
     */
    priorHabitAwards(projectId, sessionId) {
      const rows = db.prepare('SELECT kind, sessionId, turnEndSeq, earnedAt, detail FROM awards WHERE projectId=? ORDER BY earnedAt ASC, rowid ASC').all(projectId)
      const summary = {}
      for (const kind of HABIT_BADGE_KINDS) {
        summary[kind] = { count: 0, lastEarnedAt: null, lastSessionTurnEndSeq: -1, recentEvidence: [] }
      }
      for (const row of rows) {
        if (!HABIT_BADGE_KINDS.includes(row.kind)) continue
        const entry = summary[row.kind]
        entry.count += 1
        entry.lastEarnedAt = row.earnedAt
        if (row.sessionId === sessionId && row.turnEndSeq > entry.lastSessionTurnEndSeq) {
          entry.lastSessionTurnEndSeq = row.turnEndSeq
        }
        const parsed = JSON.parse(row.detail)
        if (typeof parsed?.evidence === 'string' && parsed.evidence.trim()) {
          entry.recentEvidence.push(parsed.evidence.trim())
          if (entry.recentEvidence.length > 3) entry.recentEvidence.shift()
        }
      }
      return summary
    },
    pendingByProject() {
      return db.prepare(`SELECT projectId,sessionId,status,count(*) AS count FROM reviews WHERE status!='done' GROUP BY projectId,sessionId,status`).all()
    },
    awards() {
      return db.prepare('SELECT * FROM awards ORDER BY earnedAt DESC, id').all().map(({ detail, ...row }) => {
        const parsed = JSON.parse(detail)
        return { category: badgeCategory(row.kind), ...parsed, ...row }
      })
    },
    close() {
      try { db.prepare("UPDATE reviews SET status='pending',worker=NULL,pid=NULL WHERE worker=?").run(owner) }
      finally { db.close() }
    },
  }
}
