//! Parse and execute generated completion scripts in their target shell.

use std::io::{self, Write};
use std::process::{Command, Output, Stdio};

use linkr_tui::cli::{completion_script, FLAGS};

fn zsh(script: &str, syntax_only: bool) -> Option<Output> {
    let mut command = Command::new("zsh");
    command.arg("-f");
    if syntax_only {
        command.arg("-n");
    }
    let mut child = match command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            eprintln!("skipping shell integration test: zsh is not installed");
            return None;
        }
        Err(error) => panic!("could not start zsh: {error}"),
    };
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(script.as_bytes())
        .expect("write completion script");
    Some(child.wait_with_output().expect("zsh exits"))
}

#[test]
fn zsh_completion_has_valid_shell_syntax_for_both_commands() {
    for program in ["bee", "bee-cli"] {
        let script = completion_script("zsh", program).expect("zsh completion");
        let Some(output) = zsh(&script, true) else {
            return;
        };
        assert!(
            output.status.success(),
            "{program}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn zsh_completion_passes_one_literal_spec_per_flag() {
    for (program, function) in [("bee", "_bee"), ("bee-cli", "_bee_cli")] {
        let script = completion_script("zsh", program).expect("zsh completion");
        // Completion widgets require ZLE. Capture the native function's
        // arguments to verify expansion without an interactive terminal.
        let probe = format!(
            "set -e\nsetopt GLOB_SUBST SH_WORD_SPLIT\n\
             compdef() {{ [[ \"$1\" == \"{function}\" && \"$2\" == \"{program}\" ]]; }}\n\
             _arguments() {{ printf '%s\\0' \"$@\"; }}\n\
             {script}\n{function}\n"
        );
        let Some(output) = zsh(&probe, false) else {
            return;
        };
        assert!(
            output.status.success(),
            "{program}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let specs: Vec<&str> = output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|bytes| !bytes.is_empty())
            .map(|bytes| std::str::from_utf8(bytes).expect("UTF-8 spec"))
            .collect();
        assert_eq!(specs.len(), FLAGS.len(), "{program}: {specs:?}");
        for (spec, flag) in specs.iter().zip(FLAGS) {
            assert!(spec.starts_with(&format!("{}[", flag.name)), "{spec:?}");
        }
        assert!(specs.contains(&"--help[print this help]"));
        assert!(specs.contains(&"--lang[interface language]:lang:('zh' 'en')"));
        assert!(specs.contains(
            &"--lan-host[dial the bridge's WebSocket; host, host:port or ws:// URL]:lan host:"
        ));
        assert!(specs.contains(&"--wifi[join a network as SSID\\[,PASSWORD\\]]:wifi:"));
        assert!(specs.contains(&"--print-frame[render one frame as text and exit]::print frame:"));
        assert!(specs.contains(
            &"--lan-token-file[read that token from a file instead]:lan token file:_files"
        ));
    }
}
