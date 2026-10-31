//! OpenCode 2's API, read back in the shapes the gateway's `/v1` contract has
//! always answered with.
//!
//! `/v1` is what `osd`, scripts and agents call; until OpenCode 2 it passed the
//! runtime's own answers through. OpenCode 2 replaced those answers — typed
//! messages instead of messages with parts, `{data}` envelopes, forms instead of
//! questions — so the gateway translates here and the contract stays put. The
//! web client has its own translation (the SDK's `OpenCodeClient`); this is the
//! same mapping for the handful of fields `/v1` carries.
use serde_json::{json, Map, Value};

/// The `data` of an OpenCode 2 response envelope, or the body itself.
pub fn data(body: Value) -> Value {
    match body {
        Value::Object(mut m) if m.contains_key("data") => m.remove("data").unwrap_or(Value::Null),
        other => other,
    }
}

/// A session as `/v1/sessions` has always listed it: the folder at
/// `directory`, the rest as the runtime keeps it.
pub fn session(s: &Value) -> Value {
    let mut out = Map::new();
    for key in ["id", "title", "parentID", "time", "metadata", "model"] {
        if let Some(v) = s.get(key).filter(|v| !v.is_null()) {
            out.insert(key.into(), v.clone());
        }
    }
    if let Some(dir) = s.pointer("/location/directory").and_then(Value::as_str) {
        out.insert("directory".into(), json!(dir));
    }
    Value::Object(out)
}

/// The first line of an OpenCode error's message (some carry a stack).
fn error_text(e: &Value) -> Option<String> {
    let msg = e
        .pointer("/data/message")
        .or_else(|| e.get("message"))
        .and_then(Value::as_str)?;
    msg.lines().next().map(str::to_string)
}

/// Tools OpenCode 2 renamed, under the names `/v1` readers know.
fn tool_name(name: &str) -> &str {
    match name {
        "shell" => "bash",
        "subagent" => "task",
        "todo" => "todowrite",
        other => other,
    }
}

fn content_text(content: &Value) -> Option<String> {
    let text: String = content
        .as_array()?
        .iter()
        .filter(|c| c["type"] == "text")
        .filter_map(|c| c["text"].as_str())
        .collect();
    (!text.is_empty()).then_some(text)
}

fn message(id: &Value, role: &str, created: Option<&Value>, completed: Option<&Value>, parts: Vec<Value>) -> Value {
    let mut time = Map::new();
    if let Some(c) = created.filter(|v| !v.is_null()) {
        time.insert("created".into(), c.clone());
    }
    if let Some(c) = completed.filter(|v| !v.is_null()) {
        time.insert("completed".into(), c.clone());
    }
    json!({ "info": { "id": id, "role": role, "time": Value::Object(time) }, "parts": parts })
}

/// A session's history in the shape `/v1/sessions/:id/messages` has always had:
/// `[{info: {id, role, time, error?, agent?}, parts: [...]}]`.
///
/// A turn ends at an `idle` record, and each model step is its own message, so
/// the last step of a turn still running is COMPLETED. It is reopened here —
/// `time.completed` dropped — when no idle record has closed its turn, because
/// "the last assistant message is completed" is what `/v1` readers (and
/// `session_status`) take for "the turn is over".
pub fn messages(wire: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut open_assistant: Option<usize> = None;
    let mut turn_closed = true;
    for m in wire {
        let created = m.pointer("/time/created");
        match m["type"].as_str().unwrap_or("") {
            "user" => {
                let mut parts = vec![json!({ "type": "text", "text": m["text"].as_str().unwrap_or("") })];
                for f in m["files"].as_array().into_iter().flatten() {
                    parts.push(json!({ "type": "file", "filename": f["name"] }));
                }
                out.push(message(&m["id"], "user", created, None, parts));
                turn_closed = false;
                open_assistant = None;
            }
            "assistant" => {
                let mut parts = Vec::new();
                for c in m["content"].as_array().into_iter().flatten() {
                    match c["type"].as_str() {
                        Some("text") => parts.push(json!({ "type": "text", "text": c["text"] })),
                        Some("reasoning") => parts.push(json!({ "type": "reasoning", "text": c["text"] })),
                        Some("tool") => {
                            let state = &c["state"];
                            let status = match state["status"].as_str() {
                                Some("streaming") | None => "pending",
                                Some(s) => s,
                            };
                            let mut st = json!({ "status": status, "input": state["input"] });
                            if let Some(out) = content_text(&state["content"]) {
                                st["output"] = json!(out);
                            }
                            if status == "error" {
                                st["error"] = json!(error_text(&state["error"]).unwrap_or_else(|| "Tool failed".into()));
                            }
                            parts.push(json!({
                                "type": "tool",
                                "tool": tool_name(c["name"].as_str().unwrap_or("")),
                                "callID": c["id"],
                                "state": st,
                            }));
                        }
                        _ => {}
                    }
                }
                let mut msg = message(&m["id"], "assistant", created, m.pointer("/time/completed"), parts);
                if let Some(e) = error_text(&m["error"]) {
                    msg["info"]["error"] = json!({ "data": { "message": e } });
                }
                if let Some(agent) = m["agent"].as_str() {
                    msg["info"]["agent"] = json!(agent);
                }
                out.push(msg);
                open_assistant = Some(out.len() - 1);
            }
            "shell" => {
                // A "!" command the user ran: OpenCode 1 stored it as a
                // synthetic user marker and an assistant bash result.
                let status = match m["status"].as_str() {
                    Some("running") => "running",
                    Some("exited") => "completed",
                    _ => "error",
                };
                let marker = json!({ "type": "text", "text": "", "synthetic": true });
                out.push(message(&json!(format!("{}:user", m["id"].as_str().unwrap_or(""))), "user", created, None, vec![marker]));
                let tool = json!({
                    "type": "tool",
                    "tool": "bash",
                    "callID": m.get("shellID").unwrap_or(&m["id"]),
                    "state": { "status": status, "input": { "command": m["command"] }, "output": m.pointer("/output/output") },
                });
                out.push(message(&m["id"], "assistant", created, m.pointer("/time/completed"), vec![tool]));
            }
            "synthetic" => {
                if m.pointer("/metadata/ai4s/source").and_then(Value::as_str) == Some("background-review") {
                    let text = json!({ "type": "text", "text": m["text"], "synthetic": true });
                    out.push(message(&m["id"], "assistant", created, created, vec![text]));
                } else {
                    // Runtime-to-model input (a goal continuation, a subagent's
                    // notice): never shown, but it starts a turn.
                    turn_closed = false;
                    open_assistant = None;
                }
            }
            "idle" => {
                turn_closed = true;
                open_assistant = None;
            }
            _ => {}
        }
    }
    if let (false, Some(i)) = (turn_closed, open_assistant) {
        if let Some(time) = out[i]["info"]["time"].as_object_mut() {
            time.remove("completed");
        }
    }
    out
}

/// An open permission request as `/v1/permissions` listed it (OpenCode 1's
/// field names; the action under the name `/v1` readers know).
pub fn permission(p: &Value) -> Value {
    json!({
        "id": p["id"],
        "sessionID": p["sessionID"],
        "permission": tool_name(p["action"].as_str().unwrap_or("")),
        "patterns": p["resources"],
        "title": p["message"],
    })
}

/// An open form as `/v1/questions` listed a question: one question per field.
pub fn question(form: &Value) -> Value {
    let questions: Vec<Value> = form["fields"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|f| {
            let options: Vec<Value> = if f["type"] == "boolean" {
                vec![json!({ "label": "Yes" }), json!({ "label": "No" })]
            } else {
                f["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|o| json!({ "label": o["label"], "description": o["description"] }))
                    .collect()
            };
            let custom = f["custom"].as_bool().unwrap_or(options.is_empty());
            json!({
                "question": f.get("title").or(f.get("description")).unwrap_or(&f["key"]),
                "header": form["title"],
                "options": options,
                "multiple": f["type"] == "multiselect",
                "custom": custom,
            })
        })
        .collect();
    json!({ "id": form["id"], "sessionID": form["sessionID"], "questions": questions })
}

/// `/v1`'s answer — one list of chosen labels per question — as the form's
/// answer: a label goes back as its option's value, typed words as themselves.
pub fn form_answer(form: &Value, answers: &Value) -> Value {
    let mut out = Map::new();
    for (i, f) in form["fields"].as_array().into_iter().flatten().enumerate() {
        let Some(key) = f["key"].as_str() else { continue };
        let picked: Vec<&str> = answers[i].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let value_of = |label: &str| -> Value {
            f["options"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|o| o["label"] == label)
                .map(|o| o["value"].clone())
                .unwrap_or_else(|| json!(label))
        };
        match f["type"].as_str() {
            Some("multiselect") => {
                out.insert(key.into(), Value::Array(picked.iter().map(|l| value_of(l)).collect()));
            }
            Some("boolean") => {
                out.insert(key.into(), json!(picked.first() == Some(&"Yes")));
            }
            _ => {
                if let Some(first) = picked.first() {
                    out.insert(key.into(), value_of(first));
                }
            }
        }
    }
    Value::Object(out)
}

/// `"provider/model"` as OpenCode 2's model reference. None when there is no
/// separator, or either half is empty — a typo must be reported, never
/// silently dropped into a default model.
pub fn model_ref(model: &str, variant: Option<&str>) -> Option<Value> {
    let (provider, id) = model.split_once('/')?;
    if provider.is_empty() || id.is_empty() {
        return None;
    }
    let mut r = json!({ "providerID": provider, "id": id });
    if let Some(v) = variant.filter(|v| !v.is_empty()) {
        r["variant"] = json!(v);
    }
    Some(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_keeps_its_fields_and_names_its_folder() {
        let s = json!({"id":"ses_1","title":"T","location":{"directory":"/ws"},"time":{"created":1,"updated":2},"metadata":{"ai4s":{"archived":3}},"cost":0});
        assert_eq!(
            session(&s),
            json!({"id":"ses_1","title":"T","directory":"/ws","time":{"created":1,"updated":2},"metadata":{"ai4s":{"archived":3}}})
        );
        assert_eq!(data(json!({"data":[1]})), json!([1]));
        assert_eq!(data(json!([2])), json!([2]));
    }

    #[test]
    fn history_reads_back_as_messages_with_parts() {
        let wire = vec![
            json!({"id":"u","type":"user","time":{"created":1},"text":"run it"}),
            json!({"id":"a","type":"assistant","agent":"build","time":{"created":2,"completed":3},"content":[
                {"type":"text","text":"ok"},
                {"type":"tool","id":"t1","name":"shell","state":{"status":"completed","input":{"command":"ls"},"content":[{"type":"text","text":"x\n"}]}},
                {"type":"tool","id":"t2","name":"edit","state":{"status":"error","input":{},"error":{"type":"x","message":"boom\nstack"}}}
            ]}),
            json!({"id":"i","type":"idle","time":{"created":4}}),
            json!({"id":"r","type":"synthetic","time":{"created":5},"text":"review","metadata":{"ai4s":{"source":"background-review"}}}),
        ];
        let m = messages(&wire);
        assert_eq!(m.len(), 3);
        assert_eq!(m[0]["info"]["role"], "user");
        assert_eq!(m[0]["parts"][0]["text"], "run it");
        assert_eq!(m[1]["info"]["agent"], "build");
        assert_eq!(m[1]["info"]["time"]["completed"], 3);
        assert_eq!(m[1]["parts"][1], json!({"type":"tool","tool":"bash","callID":"t1","state":{"status":"completed","input":{"command":"ls"},"output":"x\n"}}));
        assert_eq!(m[1]["parts"][2]["state"]["error"], "boom");
        assert_eq!(m[2]["info"]["role"], "assistant");
        assert_eq!(m[2]["parts"][0]["text"], "review");
    }

    #[test]
    fn a_turn_no_idle_record_has_closed_is_still_running() {
        let wire = vec![
            json!({"id":"u","type":"user","time":{"created":1},"text":"go"}),
            json!({"id":"a","type":"assistant","time":{"created":2,"completed":3},"content":[],"error":{"type":"api","message":"quota"}}),
        ];
        let m = messages(&wire);
        assert!(m[1]["info"]["time"].get("completed").is_none());
        assert_eq!(m[1]["info"]["error"]["data"]["message"], "quota");
        // A goal's continuation starts a turn too, and is never shown.
        let goal = vec![
            json!({"id":"a","type":"assistant","time":{"created":1,"completed":2},"content":[]}),
            json!({"id":"i","type":"idle","time":{"created":3}}),
            json!({"id":"c","type":"synthetic","time":{"created":4},"text":"continue","metadata":{"source":"goal"}}),
            json!({"id":"b","type":"assistant","time":{"created":5,"completed":6},"content":[]}),
        ];
        let m = messages(&goal);
        assert_eq!(m.len(), 2);
        assert!(m[1]["info"]["time"].get("completed").is_none());
    }

    #[test]
    fn a_user_shell_run_reads_as_its_marker_and_bash_result() {
        let m = messages(&[json!({"id":"sh","type":"shell","time":{"created":1,"completed":2},"command":"pwd","status":"exited","shellID":"s1","output":{"output":"/ws\n"}})]);
        assert_eq!(m[0]["parts"][0]["synthetic"], true);
        assert_eq!(m[1]["parts"][0]["tool"], "bash");
        assert_eq!(m[1]["parts"][0]["state"]["output"], "/ws\n");
    }

    #[test]
    fn forms_read_as_questions_and_answers_go_back_as_values() {
        let form = json!({"id":"f","sessionID":"s","title":"Pick","fields":[
            {"key":"c","type":"string","title":"Colour","options":[{"value":"r","label":"Red"},{"value":"b","label":"Blue"}]},
            {"key":"t","type":"multiselect","title":"Tags","options":[{"value":"x","label":"X"}]},
            {"key":"ok","type":"boolean","title":"Go?"},
            {"key":"n","type":"string","title":"Note"}
        ]});
        let q = question(&form);
        assert_eq!(q["questions"][0]["options"][1]["label"], "Blue");
        assert_eq!(q["questions"][1]["multiple"], true);
        assert_eq!(q["questions"][3]["custom"], true);
        assert_eq!(
            form_answer(&form, &json!([["Blue"], ["X"], ["Yes"], ["typed"]])),
            json!({"c":"b","t":["x"],"ok":true,"n":"typed"})
        );
    }

    #[test]
    fn permissions_and_models_in_v1_terms() {
        let p = permission(&json!({"id":"p","sessionID":"s","action":"shell","resources":["rm x"],"message":"Run rm?"}));
        assert_eq!(p, json!({"id":"p","sessionID":"s","permission":"bash","patterns":["rm x"],"title":"Run rm?"}));
        assert_eq!(model_ref("openrouter/qwen/x", Some("high")), Some(json!({"providerID":"openrouter","id":"qwen/x","variant":"high"})));
        assert_eq!(model_ref("nope", None), None);
        assert_eq!(model_ref("/x", None), None);
    }
}
