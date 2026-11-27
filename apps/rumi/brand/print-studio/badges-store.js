/** Transactional project awards, pending turn reviews, and private evaluator request history. */
import { createRequire } from 'node:module'
import { closeSync, constants, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { badgeCategory } from './badges-kinds.js'

const APPLICATION_ID = 0x52424447 // RBDG
const SCHEMA_VERSION = 2

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
      db.exec(`CREATE TABLE reviews (
        sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'mechanical',
        projectId TEXT NOT NULL, targets TEXT NOT NULL, status TEXT NOT NULL, worker TEXT, pid INTEGER,
        PRIMARY KEY (sessionId, turnEndSeq, scope)
      );
      CREATE TABLE awards (
        projectId TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, earnedAt TEXT NOT NULL,
        sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, detail TEXT NOT NULL,
        PRIMARY KEY (projectId, kind)
      );
      CREATE TABLE requests (
        id INTEGER PRIMARY KEY, sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, payload TEXT NOT NULL
      );
      PRAGMA application_id=${APPLICATION_ID};
      PRAGMA user_version=${SCHEMA_VERSION}`)
    } else if (application === APPLICATION_ID && version === 1) {
      db.exec(`CREATE TABLE reviews_v2 (
        sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'mechanical',
        projectId TEXT NOT NULL, targets TEXT NOT NULL, status TEXT NOT NULL, worker TEXT, pid INTEGER,
        PRIMARY KEY (sessionId, turnEndSeq, scope)
      );
      INSERT INTO reviews_v2(sessionId, turnEndSeq, scope, projectId, targets, status, worker, pid)
        SELECT sessionId, turnEndSeq, 'mechanical', projectId, targets, status, worker, pid FROM reviews;
      DROP TABLE reviews;
      ALTER TABLE reviews_v2 RENAME TO reviews;
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
    /** @returns {object[]} Award IDs and kinds inserted by the committed transaction. */
    commit(job, awards) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const inserted = []
        const write = db.prepare(`INSERT INTO awards(projectId,kind,id,earnedAt,sessionId,turnEndSeq,detail) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(projectId,kind) DO UPDATE SET sessionId=excluded.sessionId,turnEndSeq=excluded.turnEndSeq,detail=excluded.detail
          WHERE json_extract(awards.detail,'$.working')=0 AND json_extract(excluded.detail,'$.working')=1
          RETURNING id,kind`)
        for (const award of awards) {
          const id = randomUUID()
          const saved = write.get(job.projectId, award.kind, id, new Date().toISOString(), job.sessionId, job.turnEndSeq, JSON.stringify(award))
          if (saved?.id === id) inserted.push({ id, kind: award.kind })
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
      return db.prepare('SELECT kind FROM awards WHERE projectId=?').all(projectId).map(row => row.kind)
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
