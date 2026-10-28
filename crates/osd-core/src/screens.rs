// Screens changed from outside the window: `osd screen new | add | close`.
//
// A layout is the JSON the app saves (see the web client's `lib/layout.ts`):
// `{ groups: [{ id, name, tree, focusedLeafId, zoomedLeafId, projectId }],
// activeGroupId }`, a tree being a `leaf` (a conversation, or `content` such
// as a terminal) or a `split` of two or more. These functions edit one in
// place — add a Screen, add a pane, close a Screen — and touch nothing else,
// so a change made here cannot undo one made in the window. Ids continue the
// app's own `g<n>` / `p<n>` numbering, which it advances past on load.
use serde_json::{json, Value};

/// What a new pane holds.
#[derive(Debug, Clone, PartialEq)]
pub enum Pane {
    Session(String),
    /// `command` is typed into the shell when it first opens (as the app's
    /// own "run an agent" terminals do), e.g. `claude`.
    Terminal { cwd: Option<String>, command: Option<String> },
}

/// The next free `g<n>` and `p<n>` numbers in a layout.
struct Ids {
    group: u64,
    node: u64,
}

impl Ids {
    fn of(layout: &Value) -> Ids {
        fn walk(n: &Value, max: &mut u64) {
            if let Some(k) = n["id"].as_str().and_then(|s| s.strip_prefix('p')).and_then(|s| s.parse().ok()) {
                *max = (*max).max(k);
            }
            for c in n["children"].as_array().into_iter().flatten() {
                walk(c, max);
            }
        }
        let (mut g, mut p) = (0, 0);
        for grp in layout["groups"].as_array().into_iter().flatten() {
            if let Some(k) = grp["id"].as_str().and_then(|s| s.strip_prefix('g')).and_then(|s| s.parse().ok()) {
                g = g.max(k);
            }
            walk(&grp["tree"], &mut p);
        }
        Ids { group: g + 1, node: p + 1 }
    }
    fn group(&mut self) -> String {
        self.group += 1;
        format!("g{}", self.group - 1)
    }
    fn node(&mut self) -> String {
        self.node += 1;
        format!("p{}", self.node - 1)
    }
}

fn leaf(id: String, pane: &Pane) -> Value {
    match pane {
        Pane::Session(s) => json!({ "kind": "leaf", "id": id, "sessionId": s }),
        Pane::Terminal { cwd, command } => {
            let mut content = json!({ "kind": "terminal" });
            if let Some(c) = cwd {
                content["cwd"] = json!(c);
            }
            if let Some(c) = command {
                content["command"] = json!(c);
            }
            json!({ "kind": "leaf", "id": id, "sessionId": null, "content": content })
        }
    }
}

fn split(id: String, dir: &str, children: Vec<Value>) -> Value {
    let n = children.len();
    json!({ "kind": "split", "id": id, "dir": dir, "children": children, "sizes": vec![1.0 / n as f64; n] })
}

/// Panes as a grid read left to right, top to bottom: as many columns as the
/// square root rounds up to (2 panes side by side, 4 as 2×2, 6 as 3×2).
fn grid(mut leaves: Vec<Value>, ids: &mut Ids) -> Value {
    if leaves.len() == 1 {
        return leaves.remove(0);
    }
    let cols = (leaves.len() as f64).sqrt().ceil() as usize;
    let mut rows: Vec<Value> = Vec::new();
    while !leaves.is_empty() {
        let rest = leaves.split_off(cols.min(leaves.len()));
        let row = std::mem::replace(&mut leaves, rest);
        rows.push(if row.len() == 1 { row.into_iter().next().unwrap() } else { split(ids.node(), "row", row) });
    }
    if rows.len() == 1 { rows.remove(0) } else { split(ids.node(), "col", rows) }
}

fn groups(layout: &mut Value) -> &mut Vec<Value> {
    if !layout.is_object() || !layout["groups"].is_array() {
        *layout = json!({ "groups": [], "activeGroupId": "" });
    }
    layout["groups"].as_array_mut().expect("groups is an array")
}

/// Add a Screen holding `panes` (at least one), filed under `project` (the
/// app's project id; "" is Default). Returns its id and each pane's id, in
/// order. The window keeps showing whatever it shows; a layout with no Screen
/// yet shows this one.
pub fn new_screen(layout: &mut Value, name: &str, panes: &[Pane], project: &str) -> Result<(String, Vec<String>), String> {
    if panes.is_empty() {
        return Err("a Screen needs at least one pane".into());
    }
    let mut ids = Ids::of(layout);
    let pane_ids: Vec<String> = panes.iter().map(|_| ids.node()).collect();
    let leaves = pane_ids.iter().zip(panes).map(|(id, p)| leaf(id.clone(), p)).collect();
    let tree = grid(leaves, &mut ids);
    let id = ids.group();
    let group = json!({
        "id": id, "name": name.trim(), "tree": tree,
        "focusedLeafId": pane_ids[0], "zoomedLeafId": null, "projectId": project,
    });
    groups(layout).push(group);
    if layout["activeGroupId"].as_str().is_none_or(str::is_empty) {
        layout["activeGroupId"] = json!(id);
    }
    Ok((id, pane_ids))
}

/// Add a pane to a Screen. `beside` a pane of it: right of that pane, which
/// gives up half its width. Otherwise beside what is there: a Screen of one row
/// gains a column, anything else becomes the left of two. Returns the pane's id.
pub fn add_pane(layout: &mut Value, screen: &str, pane: &Pane, beside: Option<&str>) -> Result<String, String> {
    let mut ids = Ids::of(layout);
    let g = groups(layout)
        .iter_mut()
        .find(|g| g["id"] == screen)
        .ok_or_else(|| format!("no Screen {screen}"))?;
    let id = ids.node();
    let mut new = Some(leaf(id.clone(), pane));
    if let Some(at) = beside {
        insert_right(&mut g["tree"], at, &mut new, &mut ids);
        if new.is_some() {
            return Err(format!("no pane {at} on Screen {screen}"));
        }
        return Ok(id);
    }
    let new = new.take().unwrap();
    let tree = g["tree"].take();
    g["tree"] = if tree.is_null() {
        new
    } else if tree["kind"] == "split" && tree["dir"] == "row" {
        let mut children = tree["children"].as_array().cloned().unwrap_or_default();
        children.push(new);
        split(tree["id"].as_str().unwrap_or("p0").to_string(), "row", children)
    } else {
        split(ids.node(), "row", vec![tree, new])
    };
    if g["focusedLeafId"].is_null() {
        g["focusedLeafId"] = json!(id);
    }
    Ok(id)
}

/// Put `new` right of the leaf `at`: into its row, or a new row of the two.
/// `new` is taken once it is placed.
fn insert_right(node: &mut Value, at: &str, new: &mut Option<Value>, ids: &mut Ids) {
    if node["kind"] == "leaf" {
        if node["id"] == at {
            if let Some(n) = new.take() {
                *node = split(ids.node(), "row", vec![node.take(), n]);
            }
        }
        return;
    }
    let in_row = node["dir"] == "row";
    let Some(children) = node["children"].as_array_mut() else { return };
    let i = children.iter().position(|c| c["kind"] == "leaf" && c["id"] == at);
    if let (true, Some(i)) = (in_row, i) {
        children.insert(i + 1, new.take().unwrap_or_default());
        let n = children.len();
        let mut sizes: Vec<f64> = node["sizes"].as_array().into_iter().flatten().filter_map(Value::as_f64).collect();
        if sizes.len() + 1 == n {
            let half = sizes[i] / 2.0;
            sizes[i] = half;
            sizes.insert(i + 1, half);
        } else {
            sizes = vec![1.0 / n as f64; n];
        }
        node["sizes"] = json!(sizes);
        return;
    }
    for child in children.iter_mut() {
        insert_right(child, at, new, ids);
        if new.is_none() {
            return;
        }
    }
}

/// Close a Screen. Its conversations and shells are not touched — closing a
/// Screen in the app removes the panes, not what they show. The last Screen
/// is emptied instead (the app always has one), and a window showing the
/// closed Screen moves to the first.
pub fn close_screen(layout: &mut Value, screen: &str) -> Result<(), String> {
    let gs = groups(layout);
    let at = gs.iter().position(|g| g["id"] == screen).ok_or_else(|| format!("no Screen {screen}"))?;
    if gs.len() == 1 {
        let g = &mut gs[0];
        g["tree"] = Value::Null;
        g["focusedLeafId"] = Value::Null;
        g["zoomedLeafId"] = Value::Null;
        g["name"] = json!("");
        return Ok(());
    }
    gs.remove(at);
    let first = gs[0]["id"].clone();
    if layout["activeGroupId"] == screen {
        layout["activeGroupId"] = first;
    }
    Ok(())
}

/// The project a folder belongs to: the deepest project whose folder is it or
/// contains it (the sidebar's rule), else "" (Default).
pub fn project_for(dir: &str, projects: &[(String, String)]) -> String {
    let key = dir.trim_end_matches(['/', '\\']);
    projects
        .iter()
        .filter(|(_, path)| {
            let p = path.trim_end_matches(['/', '\\']);
            key == p || key.strip_prefix(p).is_some_and(|rest| rest.starts_with(['/', '\\']))
        })
        .max_by_key(|(_, path)| path.len())
        .map(|(id, _)| id.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn existing() -> Value {
        json!({ "activeGroupId": "g7", "groups": [
            { "id": "g7", "name": "Mine", "tree": { "kind": "split", "id": "p12", "dir": "col", "sizes": [0.5, 0.5], "children": [
                { "kind": "leaf", "id": "p10", "sessionId": "ses_a" }, { "kind": "leaf", "id": "p11", "sessionId": "ses_b" } ] },
              "focusedLeafId": "p10", "zoomedLeafId": null, "projectId": "" } ] })
    }

    #[test]
    fn a_new_screen_is_a_grid_with_fresh_ids_and_leaves_the_rest_alone() {
        let mut l = existing();
        let before = l["groups"][0].clone();
        let panes: Vec<Pane> = (1..=6).map(|i| Pane::Session(format!("s{i}"))).collect();
        let (id, pane_ids) = new_screen(&mut l, " Six ", &panes, "proj1").unwrap();
        assert_eq!(id, "g8");
        assert_eq!(pane_ids, ["p13", "p14", "p15", "p16", "p17", "p18"]);
        assert_eq!(l["groups"][0], before, "the window's Screen is untouched");
        assert_eq!(l["activeGroupId"], "g7", "and stays the one on display");
        let g = &l["groups"][1];
        assert_eq!((g["name"].as_str(), g["projectId"].as_str(), g["focusedLeafId"].as_str()), (Some("Six"), Some("proj1"), Some("p13")));
        // 6 panes: 3 columns × 2 rows.
        let t = &g["tree"];
        assert_eq!((t["dir"].as_str(), t["children"].as_array().unwrap().len()), (Some("col"), 2));
        assert_eq!(t["children"][0]["dir"], "row");
        assert_eq!(t["children"][0]["children"].as_array().unwrap().len(), 3);
        assert_eq!(t["children"][1]["children"][2]["sessionId"], "s6");
    }

    #[test]
    fn grids_of_one_two_and_three() {
        let mut l = Value::Null;
        let (_, ids) = new_screen(&mut l, "", &[Pane::Terminal { cwd: Some("/repo".into()), command: Some("claude".into()) }], "").unwrap();
        let g = &l["groups"][0];
        assert_eq!(g["tree"]["id"], ids[0].as_str());
        assert_eq!(g["tree"]["content"], json!({ "kind": "terminal", "cwd": "/repo", "command": "claude" }));
        assert_eq!(l["activeGroupId"], g["id"], "the only Screen is the one shown");
        new_screen(&mut l, "", &[Pane::Session("a".into()), Pane::Session("b".into())], "").unwrap();
        assert_eq!(l["groups"][1]["tree"]["dir"], "row");
        new_screen(&mut l, "", &[Pane::Session("a".into()), Pane::Session("b".into()), Pane::Session("c".into())], "").unwrap();
        // 3 panes: 2 columns, then one alone below.
        let t = &l["groups"][2]["tree"];
        assert_eq!((t["dir"].as_str(), t["children"][0]["dir"].as_str(), t["children"][1]["kind"].as_str()), (Some("col"), Some("row"), Some("leaf")));
        assert!(new_screen(&mut l, "", &[], "").is_err());
    }

    #[test]
    fn a_pane_is_added_beside_and_a_screen_closed() {
        let mut l = existing();
        let id = add_pane(&mut l, "g7", &Pane::Session("ses_c".into()), None).unwrap();
        let t = &l["groups"][0]["tree"];
        assert_eq!((t["dir"].as_str(), t["children"][1]["sessionId"].as_str()), (Some("row"), Some("ses_c")));
        assert_eq!(t["children"][0]["id"], "p12", "the old column kept whole");
        // A row gains a column rather than nesting again.
        add_pane(&mut l, "g7", &Pane::Terminal { cwd: None, command: None }, None).unwrap();
        assert_eq!(l["groups"][0]["tree"]["children"].as_array().unwrap().len(), 3);
        assert_eq!(id, "p13");
        assert!(add_pane(&mut l, "g99", &Pane::Terminal { cwd: None, command: None }, None).is_err());

        let (g2, _) = new_screen(&mut l, "", &[Pane::Session("x".into())], "").unwrap();
        l["activeGroupId"] = json!(g2);
        close_screen(&mut l, &g2).unwrap();
        assert_eq!((l["groups"].as_array().unwrap().len(), l["activeGroupId"].as_str()), (1, Some("g7")));
        close_screen(&mut l, "g7").unwrap();
        assert_eq!(l["groups"][0]["tree"], Value::Null, "the last Screen is emptied, not removed");
        assert!(close_screen(&mut l, "g99").is_err());
    }

    #[test]
    fn a_pane_is_added_right_of_a_given_pane() {
        // In a column: the pane becomes a row of itself and the new one.
        let mut l = existing();
        let id = add_pane(&mut l, "g7", &Pane::Session("ses_c".into()), Some("p10")).unwrap();
        let top = &l["groups"][0]["tree"]["children"][0];
        assert_eq!((top["dir"].as_str(), top["children"][0]["id"].as_str(), top["children"][1]["id"].as_str()), (Some("row"), Some("p10"), Some(id.as_str())));
        assert_eq!(l["groups"][0]["tree"]["children"][1]["id"], "p11", "the other pane untouched");
        // In a row: inserted right after it, taking half its width.
        add_pane(&mut l, "g7", &Pane::Session("ses_d".into()), Some("p10")).unwrap();
        let top = &l["groups"][0]["tree"]["children"][0];
        let order: Vec<_> = top["children"].as_array().unwrap().iter().map(|c| c["sessionId"].as_str().unwrap()).collect();
        assert_eq!(order, ["ses_a", "ses_d", "ses_c"]);
        assert_eq!(top["sizes"], json!([0.25, 0.25, 0.5]));
        assert!(add_pane(&mut l, "g7", &Pane::Session("x".into()), Some("p99")).is_err());
    }

    #[test]
    fn a_folder_belongs_to_the_deepest_project_containing_it() {
        let projects = vec![("a".to_string(), "/w/projects/a".to_string()), ("ab".to_string(), "/w/projects/a/b".to_string())];
        assert_eq!(project_for("/w/projects/a", &projects), "a");
        assert_eq!(project_for("/w/projects/a/b/c", &projects), "ab");
        assert_eq!(project_for("/w/projects/abc", &projects), "");
        assert_eq!(project_for("/w/sessions/x", &projects), "");
    }
}
