//! The third-party components the host terminal ships with.
//!
//! The window the user opens from About is a summary: the direct Rust
//! dependencies, their licences, and the people who built the project. The full
//! normal-dependency closure — hundreds of transitive crates on some targets —
//! is too long for a modal, so it lives in `THIRD_PARTY_LICENSES.md`, which is
//! shipped beside the binary and printed by `bee --licenses`.
//!
//! Both artefacts are generated from `cargo metadata` and `cargo tree` by
//! `dev/gen-licenses.py`; CI runs that generator with `--check` so a dependency
//! bump cannot leave the shipped notice naming an old version. The data below
//! is included rather than parsed at run time: a licence page should not need a
//! file beside the binary to know what the binary contains.

use std::fmt::Write as _;

/// One direct dependency, as the About window names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Component {
    pub name: &'static str,
    pub version: &'static str,
    pub license: &'static str,
    pub url: &'static str,
}

include!("licenses_data.rs");

/// The complete generated notice, exactly as the release archive carries it.
pub const NOTICE: &str = include_str!("../THIRD_PARTY_LICENSES.md");

/// The text `--licenses` prints.
///
/// One string rather than a second renderer: the file in the archive and the
/// answer on a terminal are the same bytes, so a user reading one cannot be
/// told something the other does not say.
pub fn report() -> &'static str {
    NOTICE
}

/// The project's licence, repeated here for the window and the report.
pub const PROJECT_LICENSE: &str = env!("CARGO_PKG_LICENSE");

/// A short line naming the command and the build, for the top of the window.
///
/// The caller passes the name it was invoked as: the same build is installed
/// as `bee` with the interface and as `bee-cli` without it.
pub fn heading(prog: &str) -> String {
    format!("{prog} {}", env!("CARGO_PKG_VERSION"))
}

/// The number of transitive crates, which the window names rather than lists.
pub fn transitive_count() -> usize {
    TOTAL.saturating_sub(COMPONENTS.len())
}

/// The full notice as a terminal report. Kept here so `--licenses` can be read
/// without opening a Markdown viewer, while still being the generated text
/// rather than a second list.
pub fn cli_report(prog: &str) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "{}", heading(prog));
    let _ = writeln!(out, "Project licence: {PROJECT_LICENSE}");
    let _ = writeln!(out, "Repository: {}", env!("CARGO_PKG_REPOSITORY"));
    let _ = writeln!(out);
    out.push_str(NOTICE);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window and the shipped notice are one list, not two that can drift:
    /// every direct component the window paints is in the generated file, and
    /// the full file is what `--licenses` answers.
    #[test]
    fn the_window_and_the_notice_share_one_truth() {
        assert!(!COMPONENTS.is_empty());
        assert!(TOTAL >= COMPONENTS.len());
        assert!(report().contains("Direct dependencies"));
        assert!(report().contains("Transitive dependencies"));
        assert!(report().contains("Contributors"));
        for component in COMPONENTS {
            assert!(
                report().contains(&format!("| {} | {} |", component.name, component.version)),
                "{} {} is on the About window but not in the notice",
                component.name,
                component.version
            );
        }
    }

    /// A licence page with an empty source URL or a blank licence identifier is
    /// a page that names a component without saying what it is. The generator
    /// fills both, and this keeps a future hand edit from quietly leaving one
    /// blank.
    #[test]
    fn every_component_names_its_licence_and_source() {
        for component in COMPONENTS {
            assert!(!component.name.is_empty(), "{component:?}");
            assert!(!component.version.is_empty(), "{component:?}");
            assert!(!component.license.is_empty(), "{component:?}");
            assert!(component.url.starts_with("https://"), "{component:?}");
        }
        assert!(CONTRIBUTORS.contains(&"Novice-PG"));
        assert!(
            TOTAL > COMPONENTS.len(),
            "the closure is more than the direct rows"
        );
    }

    /// The list is a stable, sorted menu: two rows with the same name and
    /// version would be two versions pretending to be one.
    #[test]
    fn the_direct_list_is_sorted_and_unique() {
        let mut seen = std::collections::BTreeSet::new();
        for component in COMPONENTS {
            assert!(seen.insert((component.name, component.version)));
        }
        let names: Vec<&str> = COMPONENTS.iter().map(|component| component.name).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable_by_key(|name| name.to_ascii_lowercase());
        assert_eq!(names, sorted);
    }

    /// A list of SPDX identifiers is not a licence text. The shipped notice
    /// must carry the permission texts themselves, including for the crates
    /// whose published package omitted a licence file.
    #[test]
    fn the_notice_reproduces_the_licence_texts() {
        let notice = report();
        assert!(notice.contains("## Licence texts"), "{notice}");
        assert!(notice.contains("Permission is hereby granted"), "{notice}");
        assert!(notice.contains("Apache License"), "{notice}");
        assert!(notice.contains("THE SOFTWARE IS PROVIDED"), "{notice}");
        assert!(
            !notice.contains("full licence text is available in that"),
            "the notice still points at source instead of carrying the text"
        );
    }

    #[test]
    fn the_cli_report_names_the_build_and_the_generated_page() {
        let report = cli_report("bee");
        assert!(report.starts_with(&heading("bee")));
        assert!(report.contains(PROJECT_LICENSE));
        assert!(report.contains(env!("CARGO_PKG_REPOSITORY")));
        assert!(report.contains("ratatui"));

        // The CLI-only archive invokes the same code as `bee-cli`; the page
        // must name the command the reader can run, not the other face.
        let cli = cli_report("bee-cli");
        assert!(cli.starts_with("bee-cli "), "{cli}");
        assert!(!cli.lines().next().unwrap_or("").starts_with("bee "));
    }
}
