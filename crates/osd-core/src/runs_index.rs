// Runs read-model: a SQLite index derived from the append-only runs logs
// (`runs.jsonl` + `remote-runs.jsonl`). The JSONL stays the durable source of
// truth; this index is disposable — rebuilt lazily from the logs by byte
// watermark — and serves fast, keyset-paginated, faceted, searched queries that
// scale to hundreds of thousands of runs without loading the whole log into
// memory. Only the app writes the DB (never the skills/helper), so there is no
// migration and no cross-process write contention.
use std::path::{Path, PathBuf};

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use crate::env::Env;
use crate::runs::RunRecord;
use crate::runtime::base_workspace_dir;

const DB_FILE: &str = "runs.db";
/// Bump to force a full rebuild when the schema or ingest logic changes.
const SCHEMA_VERSION: i64 = 1;
const RUNS_FILE: &str = "runs.jsonl";
const REMOTE_RUNS_FILE: &str = "remote-runs.jsonl";
/// Hard cap on a page so a bad `limit` can't ask for everything.
const MAX_LIMIT: u32 = 200;

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunQuery {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Time filter: only runs at or after this epoch-seconds instant.
    #[serde(default)]
    pub since_ts: Option<i64>,
    /// Keyset cursor: return rows strictly older than (before_ts, before_rowid).
    #[serde(default)]
    pub before_ts: Option<i64>,
    #[serde(default)]
    pub before_rowid: Option<i64>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPage {
    pub rows: Vec<RunRecord>,
    /// Total rows matching the full filter (for the header count).
    pub total: u32,
    /// Facet counts under the search/session/date context (not narrowed by the
    /// selected status/surface, so toggling one never zeroes the others).
    pub facets: Facets,
    /// Cursor for the next (older) page, or null at the end.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<Cursor>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    pub status: Vec<Facet>,
    pub surface: Vec<Facet>,
}

#[derive(serde::Serialize)]
pub struct Facet {
    pub value: String,
    pub count: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub ts: i64,
    pub rowid: i64,
}

fn db_path(root: &Path) -> PathBuf {
    root.join(".openscience").join(DB_FILE)
}

/// Open (creating if needed) the per-workspace index, ensuring the schema. A
/// schema-version mismatch drops and rebuilds from scratch.
pub fn open_index(root: &Path) -> Result<Connection, String> {
    let path = db_path(root);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER);",
    )
    .map_err(|e| e.to_string())?;
    let ver: i64 = conn
        .query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    if ver != SCHEMA_VERSION {
        conn.execute_batch("DROP TABLE IF EXISTS runs;").map_err(|e| e.to_string())?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS runs (
            run_id     TEXT PRIMARY KEY,
            ts         INTEGER NOT NULL,
            status     TEXT,
            surface    TEXT,
            session_id TEXT,
            command    TEXT,
            json       TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_runs_ts ON runs(ts DESC);
         CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
         CREATE INDEX IF NOT EXISTS idx_runs_surface ON runs(surface);
         CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);",
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?1)",
        params![SCHEMA_VERSION],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn get_wm(conn: &Connection, key: &str) -> i64 {
    conn.query_row("SELECT value FROM meta WHERE key=?1", params![key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
        .unwrap_or(0)
}

/// Every runs log under the base folder: the base's own `.openscience/`, new
/// workspaces under `projects/` and `sessions/`, plus legacy root-level
/// workspaces. This is what makes the index GLOBAL — one DB over all sessions,
/// with per-session views being just a `session_id` filter.
fn source_files(base: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![base.to_path_buf()];
    if let Ok(entries) = std::fs::read_dir(base) {
        for e in entries.flatten() {
            let name = e.file_name();
            let path = e.path();
            if !path.is_dir() || name.to_string_lossy().starts_with('.') {
                continue;
            }
            if matches!(
                name.to_string_lossy().as_ref(),
                crate::runtime::PROJECTS_DIR_NAME | crate::runtime::SESSIONS_DIR_NAME
            ) {
                if let Ok(children) = std::fs::read_dir(path) {
                    dirs.extend(children.flatten().map(|child| child.path()).filter(|p| p.is_dir()));
                }
            } else {
                // Compatibility: releases before the structured layout created
                // every project/session directly under the base directory.
                dirs.push(path);
            }
        }
    }
    // An in-place import is intentionally outside the base tree. It is still a
    // registered workspace, so include its run logs without opening arbitrary
    // external directories.
    let base_canon = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
    dirs.extend(
        crate::project::project_workspace_dirs(base)
            .into_iter()
            .filter(|dir| !dir.starts_with(&base_canon)),
    );
    dirs.sort();
    dirs.dedup();
    dirs.into_iter()
        .flat_map(|d| [RUNS_FILE, REMOTE_RUNS_FILE].map(|f| d.join(".openscience").join(f)))
        .collect()
}

/// Watermark key for one log file (per absolute path — each session's file
/// advances independently).
fn wm_key(path: &Path) -> String {
    format!("wm:{}", path.to_string_lossy())
}

/// Bring the index up to date with every runs log under `base`. Cheap when
/// nothing changed (a stat + watermark compare per file). If any log shrank
/// (replaced/truncated), rebuild the whole index from zero.
pub fn sync_index(conn: &Connection, base: &Path) -> Result<(), String> {
    let files = source_files(base);
    let shrank = files.iter().any(|p| {
        let size = std::fs::metadata(p).map(|m| m.len() as i64).unwrap_or(0);
        size < get_wm(conn, &wm_key(p))
    });
    if shrank {
        conn.execute("DELETE FROM runs", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM meta WHERE key LIKE 'wm:%'", []).map_err(|e| e.to_string())?;
    }
    for p in &files {
        ingest_source(conn, p, &wm_key(p))?;
    }
    Ok(())
}

/// Ingest complete new lines from one log file since its watermark. Only whole
/// lines (up to the last newline) are ingested, so a concurrent partial append
/// is never parsed; the watermark advances past the last complete line.
fn ingest_source(conn: &Connection, path: &Path, wm_key: &str) -> Result<(), String> {
    let wm = get_wm(conn, wm_key);
    let bytes = match read_from(path, wm) {
        Some(b) if !b.is_empty() => b,
        _ => return Ok(()),
    };
    let text = String::from_utf8_lossy(&bytes);
    let last_nl = match text.rfind('\n') {
        Some(i) => i,
        None => return Ok(()), // no complete line yet
    };
    let complete = &text[..last_nl];

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR IGNORE INTO runs(run_id,ts,status,surface,session_id,command,json)
                 VALUES(?1,?2,?3,?4,?5,?6,?7)",
            )
            .map_err(|e| e.to_string())?;
        for line in complete.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(rec) = serde_json::from_str::<RunRecord>(line) else {
                continue; // skip a corrupt line, never fatal
            };
            let surface = rec.surface.clone().unwrap_or_else(|| "local".into());
            stmt.execute(params![
                rec.run_id,
                rec.ts as i64,
                rec.status,
                surface,
                rec.session_id,
                rec.command,
                line,
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    set_wm_tx(&tx, wm_key, wm + (last_nl as i64) + 1)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn set_wm_tx(tx: &rusqlite::Transaction, key: &str, value: i64) -> Result<(), String> {
    tx.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?1,?2)", params![key, value])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Read a file from byte offset `from` to EOF. None if unreadable/missing.
fn read_from(path: &Path, from: i64) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(from.max(0) as u64)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Build the WHERE clause + params shared by result and facet queries.
/// `include_status`/`include_surface` let facet counts omit their own dimension.
fn where_clause(
    q: &RunQuery,
    include_status: bool,
    include_surface: bool,
    include_cursor: bool,
) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut p: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(s) = q.search.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        // command OR any path in the json (outputs/code) — a scan over an
        // indexed table; FTS5 is the future upgrade if this gets hot.
        clauses.push("(command LIKE ?  OR json LIKE ?)".into());
        let like = format!("%{s}%");
        p.push(Box::new(like.clone()));
        p.push(Box::new(like));
    }
    if include_status {
        if let Some(s) = q.status.as_ref().filter(|s| !s.is_empty()) {
            clauses.push("status = ?".into());
            p.push(Box::new(s.clone()));
        }
    }
    if include_surface {
        if let Some(s) = q.surface.as_ref().filter(|s| !s.is_empty()) {
            clauses.push("surface = ?".into());
            p.push(Box::new(s.clone()));
        }
    }
    if let Some(s) = q.session_id.as_ref().filter(|s| !s.is_empty()) {
        clauses.push("session_id = ?".into());
        p.push(Box::new(s.clone()));
    }
    // Time filter is a base filter (applies to results, counts, AND facets).
    if let Some(since) = q.since_ts {
        clauses.push("ts >= ?".into());
        p.push(Box::new(since));
    }
    if include_cursor {
        if let (Some(ts), Some(rowid)) = (q.before_ts, q.before_rowid) {
            clauses.push("(ts < ? OR (ts = ? AND rowid < ?))".into());
            p.push(Box::new(ts));
            p.push(Box::new(ts));
            p.push(Box::new(rowid));
        }
    }
    let sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    (sql, p)
}

fn count_where(conn: &Connection, q: &RunQuery, inc_status: bool, inc_surface: bool) -> Result<u32, String> {
    let (w, p) = where_clause(q, inc_status, inc_surface, false);
    let sql = format!("SELECT COUNT(*) FROM runs{w}");
    conn.query_row(&sql, params_from_iter(p.iter()), |r| r.get::<_, i64>(0))
        .map(|n| n as u32)
        .map_err(|e| e.to_string())
}

fn facet(conn: &Connection, q: &RunQuery, column: &str, inc_status: bool, inc_surface: bool) -> Result<Vec<Facet>, String> {
    let (w, p) = where_clause(q, inc_status, inc_surface, false);
    let sql = format!(
        "SELECT COALESCE({column},'') v, COUNT(*) c FROM runs{w} GROUP BY {column} ORDER BY c DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(p.iter()), |r| {
            Ok(Facet { value: r.get::<_, String>(0)?, count: r.get::<_, i64>(1)? as u32 })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Query a keyset-paginated, faceted page of runs.
pub fn query_runs(conn: &Connection, q: &RunQuery) -> Result<RunPage, String> {
    let limit = q.limit.unwrap_or(50).clamp(1, MAX_LIMIT);
    // Result rows: all filters + cursor.
    let (w, p) = where_clause(q, true, true, true);
    let sql = format!("SELECT rowid, ts, json FROM runs{w} ORDER BY ts DESC, rowid DESC LIMIT {}", limit + 1);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let fetched = stmt
        .query_map(params_from_iter(p.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // We fetch limit+1 to know whether an older page exists.
    let has_more = fetched.len() as u32 > limit;
    let page = &fetched[..fetched.len().min(limit as usize)];
    let next = if has_more {
        page.last().map(|(rowid, ts, _)| Cursor { ts: *ts, rowid: *rowid })
    } else {
        None
    };
    let rows = page
        .iter()
        .filter_map(|(_, _, json)| serde_json::from_str::<RunRecord>(json).ok())
        .collect();

    Ok(RunPage {
        rows,
        total: count_where(conn, q, true, true)?,
        facets: Facets {
            // Each facet omits its own dimension so toggling one keeps the others visible.
            status: facet(conn, q, "status", false, true)?,
            surface: facet(conn, q, "surface", true, false)?,
        },
        next,
    })
}

/// Open + sync the index (reads new log bytes, writes the DB) and query it.
pub fn query_runs_cmd(env: &Env, query: RunQuery) -> Result<RunPage, String> {
    // Global index, keyed to the base folder: it aggregates every session's
    // logs. The Runs page queries it unfiltered; a session's Runs pane passes
    // `sessionId` to narrow to its own runs.
    let base = base_workspace_dir(env)?;
    let conn = open_index(&base)?;
    sync_index(&conn, &base)?;
    query_runs(&conn, &query)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ai4s-runidx-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".openscience")).unwrap();
        dir
    }

    fn write_log(root: &Path, file: &str, lines: &[&str]) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join(".openscience").join(file))
            .unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    fn rec(run_id: &str, ts: i64, status: &str, surface: Option<&str>, command: &str) -> String {
        let surf = surface.map(|s| format!(r#","surface":"{s}""#)).unwrap_or_default();
        format!(r#"{{"runId":"{run_id}","ts":{ts},"status":"{status}"{surf},"command":"{command}","code":[],"outputs":[]}}"#)
    }

    #[test]
    fn ingests_incrementally_by_watermark_and_is_idempotent() {
        let root = temp_root("wm");
        write_log(&root, RUNS_FILE, &[&rec("r1", 100, "ok", None, "python a.py")]);
        let conn = open_index(&root).unwrap();
        sync_index(&conn, &root).unwrap();
        assert_eq!(query_runs(&conn, &RunQuery::default()).unwrap().total, 1);

        // Re-sync with no new bytes → no change (idempotent).
        sync_index(&conn, &root).unwrap();
        assert_eq!(query_runs(&conn, &RunQuery::default()).unwrap().total, 1);

        // Append two more → only the new lines are ingested.
        write_log(&root, RUNS_FILE, &[&rec("r2", 200, "failed", None, "python b.py"), &rec("r3", 300, "ok", None, "make train")]);
        sync_index(&conn, &root).unwrap();
        let page = query_runs(&conn, &RunQuery::default()).unwrap();
        assert_eq!(page.total, 3);
        // Newest first.
        assert_eq!(page.rows[0].run_id, "r3");
        assert_eq!(page.rows[2].run_id, "r1");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn merges_remote_runs_and_a_partial_last_line_is_deferred() {
        let root = temp_root("remote");
        write_log(&root, RUNS_FILE, &[&rec("local1", 100, "ok", None, "python a.py")]);
        write_log(&root, REMOTE_RUNS_FILE, &[&rec("remote1", 250, "ok", Some("hpc"), "sbatch j.slurm")]);
        // A partial (newline-less) line mid-flight must NOT be ingested yet.
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(root.join(".openscience").join(RUNS_FILE)).unwrap();
        write!(f, "{}", rec("partial", 400, "ok", None, "python c.py")).unwrap(); // no trailing \n

        let conn = open_index(&root).unwrap();
        sync_index(&conn, &root).unwrap();
        let page = query_runs(&conn, &RunQuery::default()).unwrap();
        assert_eq!(page.total, 2); // local1 + remote1, NOT partial
        assert_eq!(page.rows[0].run_id, "remote1"); // ts 250 newest

        // Complete the partial line → now it ingests.
        writeln!(f).unwrap();
        sync_index(&conn, &root).unwrap();
        assert_eq!(query_runs(&conn, &RunQuery::default()).unwrap().total, 3);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn filters_search_status_surface_and_reports_facets() {
        let root = temp_root("filter");
        write_log(
            &root,
            RUNS_FILE,
            &[
                &rec("a", 100, "ok", None, "python train.py"),
                &rec("b", 200, "failed", None, "python train.py --bad"),
                &rec("c", 300, "ok", Some("hpc"), "sbatch fit.slurm"),
            ],
        );
        let conn = open_index(&root).unwrap();
        sync_index(&conn, &root).unwrap();

        // Search narrows to matching command.
        let q = RunQuery { search: Some("train".into()), ..Default::default() };
        assert_eq!(query_runs(&conn, &q).unwrap().total, 2);

        // Status filter.
        let q = RunQuery { status: Some("failed".into()), ..Default::default() };
        let page = query_runs(&conn, &q).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].run_id, "b");

        // Surface filter.
        let q = RunQuery { surface: Some("hpc".into()), ..Default::default() };
        assert_eq!(query_runs(&conn, &q).unwrap().total, 1);

        // Time filter (since_ts) — and it composes with other filters (AND).
        let q = RunQuery { since_ts: Some(200), ..Default::default() };
        assert_eq!(query_runs(&conn, &q).unwrap().total, 2); // ts 200 and 300
        let q = RunQuery { since_ts: Some(200), status: Some("ok".into()), ..Default::default() };
        assert_eq!(query_runs(&conn, &q).unwrap().total, 1); // only ts=300 ok

        // Facets: status counts don't collapse when a status is selected.
        let q = RunQuery { status: Some("ok".into()), ..Default::default() };
        let facets = query_runs(&conn, &q).unwrap().facets;
        let ok = facets.status.iter().find(|f| f.value == "ok").map(|f| f.count);
        let failed = facets.status.iter().find(|f| f.value == "failed").map(|f| f.count);
        assert_eq!(ok, Some(2));
        assert_eq!(failed, Some(1)); // still visible though status=ok is selected

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn indexes_runs_across_session_subfolders_and_filters_by_session() {
        let root = temp_root("global");
        // Structured project + session, plus one legacy root-level workspace.
        for (workspace, sess, ts) in [
            ("projects/study", "ses_a", 100),
            ("sessions/2026-07-28-0900", "ses_b", 200),
            ("2026-07-01-0800", "ses_legacy", 300),
        ] {
            let dir = root.join(workspace).join(".openscience");
            std::fs::create_dir_all(&dir).unwrap();
            let line = format!(
                r#"{{"runId":"run_{sess}","ts":{ts},"status":"ok","command":"python x.py","sessionId":"{sess}","code":[],"outputs":[]}}"#
            );
            use std::io::Write;
            writeln!(std::fs::File::create(dir.join(RUNS_FILE)).unwrap(), "{line}").unwrap();
        }
        let conn = open_index(&root).unwrap();
        sync_index(&conn, &root).unwrap();

        // Global view: structured and legacy workspaces are all indexed.
        assert_eq!(query_runs(&conn, &RunQuery::default()).unwrap().total, 3);
        // Per-session view: only that session's runs.
        let q = RunQuery { session_id: Some("ses_a".into()), ..Default::default() };
        let page = query_runs(&conn, &q).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].run_id, "run_ses_a");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn keyset_pagination_walks_older_pages_without_gaps_or_repeats() {
        let root = temp_root("page");
        let lines: Vec<String> = (0..5).map(|i| rec(&format!("r{i}"), 100 + i, "ok", None, "python x.py")).collect();
        write_log(&root, RUNS_FILE, &lines.iter().map(|s| s.as_str()).collect::<Vec<_>>());
        let conn = open_index(&root).unwrap();
        sync_index(&conn, &root).unwrap();

        let p1 = query_runs(&conn, &RunQuery { limit: Some(2), ..Default::default() }).unwrap();
        assert_eq!(p1.rows.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>(), vec!["r4", "r3"]);
        let cur = p1.next.expect("more pages");

        let p2 = query_runs(
            &conn,
            &RunQuery { limit: Some(2), before_ts: Some(cur.ts), before_rowid: Some(cur.rowid), ..Default::default() },
        )
        .unwrap();
        assert_eq!(p2.rows.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>(), vec!["r2", "r1"]);
        let cur = p2.next.expect("one more");

        let p3 = query_runs(
            &conn,
            &RunQuery { limit: Some(2), before_ts: Some(cur.ts), before_rowid: Some(cur.rowid), ..Default::default() },
        )
        .unwrap();
        assert_eq!(p3.rows.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>(), vec!["r0"]);
        assert!(p3.next.is_none()); // end

        let _ = std::fs::remove_dir_all(root);
    }
}
