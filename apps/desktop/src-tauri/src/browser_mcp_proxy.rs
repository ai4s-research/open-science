//! Ownership boundary for the bundled agent-browser MCP server.
//!
//! OpenCode supplies the current conversation identity through a trusted plugin.
//! This proxy removes model-controlled lifecycle fields from the advertised
//! schemas, blocks tools that can escape the current lease, and adds a private
//! inventory view. The upstream MCP server still performs browser automation.

use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{Command, Stdio};

pub const PROXY_FLAG: &str = "--browser-mcp";
const BROWSER_NAMESPACE: &str = "open-science-desktop";
const LEASE_PREFIX: &str = "osd-";
const INVENTORY_TOOL: &str = "agent_browser_inventory";

const APP_OWNED_ARGUMENTS: &[&str] = &[
    "allowedDomains",
    "session",
    "namespace",
    "restore",
    "restoreSave",
    "restoreCheckUrl",
    "restoreCheckText",
    "restoreCheckFn",
    "extraArgs",
    "headed",
    "webgpu",
];

const BLOCKED_TOOLS: &[&str] = &[
    // These can enumerate/switch another conversation or attach to a browser
    // that the user opened outside Open Science Desktop.
    "agent_browser_session",
    "agent_browser_session_list",
    "agent_browser_session_id",
    "agent_browser_session_info",
    "agent_browser_connect",
    "agent_browser_profiles",
    // These accept nested/free-form commands and can bypass the schema above.
    "agent_browser_batch",
    "agent_browser_plugin_add",
    "agent_browser_plugin_run",
];

/// Run the line-delimited JSON-RPC proxy. `args` starts with the bundled
/// agent-browser path, followed by its normal `mcp` arguments.
pub fn run(args: Vec<OsString>) -> i32 {
    match run_inner(args) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("browser MCP proxy: {error}");
            1
        }
    }
}

fn run_inner(mut args: Vec<OsString>) -> Result<(), String> {
    if args.is_empty() {
        return Err("missing agent-browser executable".to_string());
    }
    let agent_browser = args.remove(0);
    let mut child = Command::new(&agent_browser)
        .args(&args)
        .env("AGENT_BROWSER_NAMESPACE", BROWSER_NAMESPACE)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("could not start agent-browser: {e}"))?;
    let mut child_stdin = child
        .stdin
        .take()
        .ok_or("agent-browser stdin unavailable")?;
    let child_stdout = child
        .stdout
        .take()
        .ok_or("agent-browser stdout unavailable")?;
    let mut child_stdout = BufReader::new(child_stdout);
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let line = line.map_err(|e| format!("could not read MCP request: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let mut request: Value =
            serde_json::from_str(&line).map_err(|e| format!("invalid MCP request JSON: {e}"))?;
        sanitize_tool_call(&mut request);
        let id = request.get("id").cloned();
        let method = request.get("method").and_then(Value::as_str);

        if method == Some("tools/call")
            && request.pointer("/params/name").and_then(Value::as_str) == Some(INVENTORY_TOOL)
        {
            let response = inventory_response(&request, &agent_browser);
            write_json_line(&mut stdout, &response)?;
            continue;
        }

        let mut fresh_open_lease: Option<String> = None;
        if method == Some("tools/call") {
            let name = request
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if name != "agent_browser_tools_profiles" {
                let lease = request
                    .pointer("/params/arguments/session")
                    .and_then(Value::as_str);
                let Some(lease) = lease.filter(|value| valid_lease(value)) else {
                    write_json_line(
                        &mut stdout,
                        &request_tool_result(
                            &request,
                            json!({ "error": "trusted conversation lease was not supplied" }),
                            true,
                        ),
                    )?;
                    continue;
                };
                let open = match browser_session_exists(&agent_browser, lease) {
                    Ok(open) => open,
                    Err(error) => {
                        write_json_line(
                            &mut stdout,
                            &request_tool_result(
                                &request,
                                json!({ "error": format!("could not inspect browser ownership: {error}") }),
                                true,
                            ),
                        )?;
                        continue;
                    }
                };
                let has_url = request
                    .pointer("/params/arguments/url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| !url.trim().is_empty());
                if name == "agent_browser_open" && !has_url {
                    write_json_line(
                        &mut stdout,
                        &request_tool_result(
                            &request,
                            json!({ "error": "open requires a target URL; use browser inventory to inspect an existing lease" }),
                            true,
                        ),
                    )?;
                    continue;
                }
                if !open {
                    if name == "agent_browser_open" {
                        fresh_open_lease = Some(lease.to_string());
                    } else if name == "agent_browser_read" && has_url {
                        // An explicit read URL uses agent-browser's HTTP reader
                        // without launching Chrome.
                    } else if name == "agent_browser_close" {
                        write_json_line(
                            &mut stdout,
                            &request_tool_result(
                                &request,
                                json!({ "released": true, "alreadyClosed": true }),
                                false,
                            ),
                        )?;
                        continue;
                    } else {
                        write_json_line(
                            &mut stdout,
                            &request_tool_result(
                                &request,
                                json!({ "error": "this conversation has no open browser; call browser inventory, then open a target URL" }),
                                true,
                            ),
                        )?;
                        continue;
                    }
                }
            }
        }

        let forwarded = serde_json::to_vec(&request)
            .map_err(|e| format!("could not encode MCP request: {e}"))?;
        child_stdin
            .write_all(&forwarded)
            .and_then(|_| child_stdin.write_all(b"\n"))
            .and_then(|_| child_stdin.flush())
            .map_err(|e| format!("could not forward MCP request: {e}"))?;

        // Notifications have no response. Requests are deliberately serialized:
        // agent-browser itself runs each CLI operation synchronously.
        let Some(id) = id else { continue };
        loop {
            let mut response_line = String::new();
            let read = child_stdout
                .read_line(&mut response_line)
                .map_err(|e| format!("could not read MCP response: {e}"))?;
            if read == 0 {
                return Err("agent-browser MCP exited unexpectedly".to_string());
            }
            let Ok(mut response) = serde_json::from_str::<Value>(response_line.trim()) else {
                // Preserve any upstream non-JSON output for diagnostics without
                // corrupting the JSON-RPC stream.
                eprintln!("agent-browser MCP: {}", response_line.trim());
                continue;
            };
            let is_requested_response = response.get("id") == Some(&id);
            if is_requested_response && method == Some("tools/list") {
                let first_page = request.pointer("/params/cursor").is_none();
                protect_tool_list(&mut response, first_page);
            }
            if is_requested_response
                && response.pointer("/result/isError") != Some(&json!(true))
                && fresh_open_lease.is_some()
            {
                let lease = fresh_open_lease.as_deref().unwrap();
                if let Err(error) = prune_fresh_session(&agent_browser, lease) {
                    let _ = close_browser_session(&agent_browser, lease);
                    response = tool_response(
                        id.clone(),
                        json!({
                            "error": format!("could not isolate copied profile tabs: {error}"),
                            "browserClosed": true
                        }),
                        true,
                    );
                }
            }
            write_json_line(&mut stdout, &response)?;
            if is_requested_response {
                break;
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

fn write_json_line(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, value).map_err(|e| e.to_string())?;
    writer.write_all(b"\n").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

fn sanitize_tool_call(request: &mut Value) {
    if request.get("method").and_then(Value::as_str) != Some("tools/call") {
        return;
    }
    let name = request
        .pointer("/params/name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let Some(arguments) = request
        .pointer_mut("/params/arguments")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    for field in APP_OWNED_ARGUMENTS {
        if *field != "session" {
            arguments.remove(*field);
        }
    }
    if name == "agent_browser_close" {
        arguments.remove("all");
    }
}

fn protect_tool_list(response: &mut Value, include_inventory: bool) {
    let Some(tools) = response
        .pointer_mut("/result/tools")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    tools.retain(|tool| {
        tool.get("name")
            .and_then(Value::as_str)
            .is_none_or(|name| !BLOCKED_TOOLS.contains(&name))
    });
    for tool in tools.iter_mut() {
        let name = tool
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if let Some(properties) = tool
            .pointer_mut("/inputSchema/properties")
            .and_then(Value::as_object_mut)
        {
            for field in APP_OWNED_ARGUMENTS {
                properties.remove(*field);
            }
            if name == "agent_browser_close" {
                properties.remove("all");
            }
        }
        if let Some(required) = tool
            .pointer_mut("/inputSchema/required")
            .and_then(Value::as_array_mut)
        {
            required.retain(|field| {
                field.as_str().is_none_or(|field| {
                    !APP_OWNED_ARGUMENTS.contains(&field)
                        && (name != "agent_browser_close" || field != "all")
                })
            });
        }
        if let Some(description) = tool.get_mut("description") {
            let original = description.as_str().unwrap_or_default();
            *description = json!(format!(
                "{original} Uses only the browser lease owned by the current conversation."
            ));
        }
    }
    if include_inventory
        && !tools
            .iter()
            .any(|tool| tool.get("name") == Some(&json!(INVENTORY_TOOL)))
    {
        tools.push(json!({
            "name": INVENTORY_TOOL,
            "title": "Browser resources",
            "description": "Inspect the current conversation's managed browser and tabs before deciding whether to open, reuse, or close it. Other conversations are reported without URLs or titles. Browsers opened by the user outside Open Science Desktop are never inspected or controlled.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": true }
        }));
    }
}

fn inventory_response(request: &Value, agent_browser: &OsString) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let lease = request
        .pointer("/params/arguments/session")
        .and_then(Value::as_str);
    let result = lease
        .filter(|value| valid_lease(value))
        .ok_or_else(|| "trusted conversation lease was not supplied".to_string())
        .and_then(|lease| browser_inventory(agent_browser, lease));
    match result {
        Ok(inventory) => tool_response(id, inventory, false),
        Err(error) => tool_response(id, json!({ "error": error }), true),
    }
}

fn request_tool_result(request: &Value, body: Value, is_error: bool) -> Value {
    tool_response(
        request.get("id").cloned().unwrap_or(Value::Null),
        body,
        is_error,
    )
}

fn valid_lease(value: &str) -> bool {
    value.starts_with(LEASE_PREFIX)
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn tool_response(id: Value, body: Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string());
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{ "type": "text", "text": text }],
            "isError": is_error
        }
    })
}

fn browser_inventory(agent_browser: &OsString, lease: &str) -> Result<Value, String> {
    let sessions = run_agent_json(
        agent_browser,
        &[
            "--namespace",
            BROWSER_NAMESPACE,
            "--json",
            "session",
            "list",
        ],
    )?;
    let sessions = sessions
        .pointer("/data/sessions")
        .and_then(Value::as_array)
        .ok_or("agent-browser returned an invalid session list")?;
    let current_open = sessions.iter().any(|value| value.as_str() == Some(lease));
    let mut other_conversations = 0usize;
    let mut legacy_app_sessions = 0usize;
    for session in sessions.iter().filter_map(Value::as_str) {
        if session == lease {
            continue;
        }
        if session.starts_with(LEASE_PREFIX) {
            other_conversations += 1;
        } else {
            legacy_app_sessions += 1;
        }
    }

    let tabs = if current_open {
        run_agent_json(
            agent_browser,
            &[
                "--namespace",
                BROWSER_NAMESPACE,
                "--session",
                lease,
                "--json",
                "tab",
                "list",
            ],
        )?
        .pointer("/data/tabs")
        .cloned()
        .unwrap_or_else(|| json!([]))
    } else {
        json!([])
    };

    Ok(json!({
        "policy": {
            "externalUserBrowsers": {
                "managed": false,
                "inspected": false,
                "action": "never attach, navigate, or close"
            },
            "otherConversations": {
                "detailsVisible": false,
                "action": "leave untouched; their owner or idle/app-exit cleanup reclaims them"
            }
        },
        "currentConversation": {
            "browserOpen": current_open,
            "owner": "current_conversation",
            "canReuse": current_open,
            "canClose": current_open,
            "tabs": tabs,
            "recommendedAction": if current_open { "reuse current browser and existing tab when suitable" } else { "open one browser; the lease will be assigned automatically" },
            "finishAction": if current_open { "close the current browser after the task unless the user asks to keep it open" } else { "nothing to reclaim" }
        },
        "otherManagedResources": {
            "openBrowserCount": other_conversations,
            "owner": "other_conversations",
            "canInspectTabs": false,
            "canReuse": false,
            "canClose": false
        },
        "legacyManagedResources": {
            "openBrowserCount": legacy_app_sessions,
            "canReuse": false,
            "canCloseFromConversation": false,
            "cleanup": "idle timeout or app exit"
        }
    }))
}

fn browser_session_exists(agent_browser: &OsString, lease: &str) -> Result<bool, String> {
    let sessions = run_agent_json(
        agent_browser,
        &[
            "--namespace",
            BROWSER_NAMESPACE,
            "--json",
            "session",
            "list",
        ],
    )?;
    Ok(sessions
        .pointer("/data/sessions")
        .and_then(Value::as_array)
        .is_some_and(|sessions| sessions.iter().any(|value| value.as_str() == Some(lease))))
}

/// A copied Chrome login may contain its old "Sessions" files. On the first
/// launch, keep only the page agent-browser navigated for this lease, so tabs
/// from the user's real Chrome are never exposed to or modified by the model.
fn prune_fresh_session(agent_browser: &OsString, lease: &str) -> Result<(), String> {
    let tabs = run_agent_json(
        agent_browser,
        &[
            "--namespace",
            BROWSER_NAMESPACE,
            "--session",
            lease,
            "--json",
            "tab",
            "list",
        ],
    )?;
    let tabs = tabs
        .pointer("/data/tabs")
        .and_then(Value::as_array)
        .ok_or("agent-browser returned an invalid tab list")?;
    let keep = tabs
        .iter()
        .find(|tab| tab.get("active") == Some(&json!(true)))
        .or_else(|| tabs.first())
        .and_then(|tab| tab.get("tabId"))
        .and_then(Value::as_str)
        .ok_or("new browser has no target tab")?;
    for tab in tabs {
        let Some(tab_id) = tab.get("tabId").and_then(Value::as_str) else {
            continue;
        };
        if tab_id != keep {
            run_agent_json(
                agent_browser,
                &[
                    "--namespace",
                    BROWSER_NAMESPACE,
                    "--session",
                    lease,
                    "--json",
                    "tab",
                    "close",
                    tab_id,
                ],
            )?;
        }
    }
    Ok(())
}

fn close_browser_session(agent_browser: &OsString, lease: &str) -> Result<(), String> {
    run_agent_json(
        agent_browser,
        &[
            "--namespace",
            BROWSER_NAMESPACE,
            "--session",
            lease,
            "--json",
            "close",
        ],
    )
    .map(|_| ())
}

fn run_agent_json(agent_browser: &OsString, args: &[&str]) -> Result<Value, String> {
    let output = Command::new(agent_browser)
        .args(args)
        .output()
        .map_err(|e| format!("could not run agent-browser inventory: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "agent-browser inventory failed".to_string()
        } else {
            format!("agent-browser inventory failed: {stderr}")
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("invalid agent-browser inventory JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_schema_hides_ownership_escape_hatches() {
        let mut response = json!({
            "result": { "tools": [
                {
                    "name": "agent_browser_open",
                    "description": "Open.",
                    "inputSchema": {
                        "properties": { "url": {}, "session": {}, "allowedDomains": {} },
                        "required": ["url"]
                    }
                },
                {
                    "name": "agent_browser_close",
                    "description": "Close.",
                    "inputSchema": { "properties": { "all": {}, "session": {} } }
                },
                { "name": "agent_browser_session_list", "inputSchema": {} },
                { "name": "agent_browser_connect", "inputSchema": {} },
                { "name": "agent_browser_batch", "inputSchema": {} }
            ]}
        });

        protect_tool_list(&mut response, true);
        let tools = response
            .pointer("/result/tools")
            .unwrap()
            .as_array()
            .unwrap();
        let names: Vec<_> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect();
        assert_eq!(
            names,
            vec!["agent_browser_open", "agent_browser_close", INVENTORY_TOOL]
        );
        assert!(tools[0]
            .pointer("/inputSchema/properties/session")
            .is_none());
        assert!(tools[0]
            .pointer("/inputSchema/properties/allowedDomains")
            .is_none());
        assert!(tools[1].pointer("/inputSchema/properties/all").is_none());
    }

    #[test]
    fn lease_names_are_narrow_and_app_owned() {
        assert!(valid_lease("osd-ses_123-abc"));
        assert!(!valid_lease("titles"));
        assert!(!valid_lease("osd-other/session"));
    }

    #[test]
    fn forwarded_calls_keep_only_the_trusted_lease() {
        let mut request = json!({
            "method": "tools/call",
            "params": {
                "name": "agent_browser_close",
                "arguments": {
                    "session": "osd-ses_current",
                    "namespace": "other",
                    "allowedDomains": ["example.com"],
                    "extraArgs": ["--session", "other"],
                    "all": true
                }
            }
        });
        sanitize_tool_call(&mut request);
        assert_eq!(
            request.pointer("/params/arguments"),
            Some(&json!({ "session": "osd-ses_current" }))
        );
    }
}
