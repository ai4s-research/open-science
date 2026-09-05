// A small argument parser.
//
// Hand-rolled rather than pulled from crates.io for the same reason the gateway
// is std-only: `osd` ships to compute nodes, and every dependency is something
// that has to be audited and rebuilt there. The grammar is deliberately tiny —
// `osd <command> [subcommand] [positional…] [--flag] [--key value]`.
use std::collections::HashMap;

/// Flags that never take a value. Anything else spelled `--x` consumes the
/// next argument, so an unknown flag fails loudly instead of eating a word of
/// the prompt.
const BOOLEANS: &[&str] = &["json", "lan", "wait", "help", "quiet", "all", "force"];

pub struct Args {
    pub command: String,
    pub sub: String,
    pub positional: Vec<String>,
    flags: HashMap<String, String>,
    switches: Vec<String>,
}

impl Args {
    pub fn parse(argv: Vec<String>) -> Result<Args, String> {
        let mut positional = Vec::new();
        let mut flags = HashMap::new();
        let mut switches = Vec::new();
        let mut it = argv.into_iter();
        let mut rest_is_positional = false;
        while let Some(arg) = it.next() {
            if rest_is_positional {
                positional.push(arg);
                continue;
            }
            if arg == "--" {
                // Everything after `--` is text, not flags — this is what lets a
                // prompt contain "--" without being parsed.
                rest_is_positional = true;
            } else if let Some(name) = arg.strip_prefix("--") {
                let (name, inline) = match name.split_once('=') {
                    Some((n, v)) => (n.to_string(), Some(v.to_string())),
                    None => (name.to_string(), None),
                };
                if BOOLEANS.contains(&name.as_str()) {
                    switches.push(name);
                } else {
                    let value = match inline {
                        Some(v) => v,
                        None => it
                            .next()
                            .ok_or_else(|| format!("--{name} needs a value"))?,
                    };
                    flags.insert(name, value);
                }
            } else if arg == "-h" {
                switches.push("help".into());
            } else {
                positional.push(arg);
            }
        }
        let command = if positional.is_empty() { String::new() } else { positional.remove(0) };
        // A second bare word is the subcommand only for the grouped commands;
        // `osd session send <id>` must not lose its id.
        let sub = match command.as_str() {
            "session" | "project" | "run" | "fs" | "permission" | "auth" | "model" | "approval"
                if !positional.is_empty() =>
            {
                positional.remove(0)
            }
            _ => String::new(),
        };
        Ok(Args { command, sub, positional, flags, switches })
    }

    pub fn value(&self, name: &str) -> Option<String> {
        self.flags.get(name).cloned()
    }

    pub fn has(&self, name: &str) -> bool {
        self.switches.iter().any(|s| s == name)
    }

    /// A required positional, named for the error message.
    pub fn at(&self, index: usize, name: &str) -> Result<String, String> {
        self.positional
            .get(index)
            .cloned()
            .ok_or_else(|| format!("missing <{name}>"))
    }

    /// Every positional from `index` on, joined — how a prompt is read.
    pub fn rest(&self, index: usize) -> String {
        self.positional.get(index..).unwrap_or_default().join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Args {
        Args::parse(line.split_whitespace().map(str::to_string).collect()).expect("parses")
    }

    #[test]
    fn splits_command_subcommand_and_positionals() {
        let a = parse("session send ses_123 hello there");
        assert_eq!(a.command, "session");
        assert_eq!(a.sub, "send");
        assert_eq!(a.at(0, "session").unwrap(), "ses_123");
        assert_eq!(a.rest(1), "hello there");
    }

    #[test]
    fn a_command_with_no_subcommand_keeps_its_positionals() {
        let a = parse("server --port 4098");
        assert_eq!(a.command, "server");
        assert_eq!(a.sub, "");
        assert_eq!(a.value("port").as_deref(), Some("4098"));
    }

    #[test]
    fn switches_and_valued_flags_are_told_apart() {
        let a = parse("session send ses_1 do it --wait --model anthropic/claude --json");
        assert!(a.has("wait"));
        assert!(a.has("json"));
        assert_eq!(a.value("model").as_deref(), Some("anthropic/claude"));
        assert_eq!(a.rest(1), "do it");
    }

    #[test]
    fn inline_values_and_a_double_dash_terminator() {
        let a = parse("session send ses_1 --model=openai/gpt-5 -- --not-a-flag");
        assert_eq!(a.value("model").as_deref(), Some("openai/gpt-5"));
        assert_eq!(a.rest(1), "--not-a-flag");
    }

    #[test]
    fn a_valued_flag_with_nothing_after_it_is_an_error() {
        let err = match Args::parse(vec!["session".into(), "send".into(), "--model".into()]) {
            Err(e) => e,
            Ok(_) => panic!("a flag with no value must not parse"),
        };
        assert!(err.contains("--model"), "{err}");
    }
}
