//! Whether the interpreter a plugin runs on meets what the Host and the plugin
//! ask for (ENV03, ADR-0258).
//!
//! Two requirements apply: the Host's own minimum (the version `host.py` is
//! written for) and the plugin's `[project].requires-python` from its
//! `pyproject.toml`, when it has one. Missing either one is a warning only:
//! the user may know their interpreter better than the check does, and an
//! interpreter that really cannot run the plugin still fails at import with
//! its own error. What the check cannot tell (no version, an unreadable
//! requirement) is reported too, so silence always means it passed.

use std::path::Path;
use std::str::FromStr;

use pep440_rs::{Version, VersionSpecifiers};
use serde::Serialize;

use super::discover::{parse_python_version, MIN_VERSION};

/// The file a plugin states its Python requirement in.
const PYPROJECT: &str = "pyproject.toml";

/// Larger than any real `pyproject.toml`; a bigger file is not read.
const PYPROJECT_MAX_BYTES: u64 = 1024 * 1024;

/// Why a plugin's requirement could not be evaluated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequirementProblem {
    /// `pyproject.toml` could not be read or is not valid TOML.
    InvalidPyproject,
    /// `requires-python` is not a string.
    NotAString,
    /// `requires-python` is not a PEP 440 specifier set.
    InvalidSpecifier,
}

/// What the plugin's `pyproject.toml` says about Python.
#[derive(Debug, Clone)]
pub enum RequiresPython {
    /// No `pyproject.toml`, or no `requires-python` in it.
    Absent,
    Declared {
        raw: String,
        specifiers: VersionSpecifiers,
    },
    Unreadable {
        problem: RequirementProblem,
        /// The value as written, when there was a string to show.
        raw: Option<String>,
        /// What went wrong, for the log.
        detail: String,
    },
}

/// A reason to doubt the interpreter. It never stops the plugin loading.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum InterpreterWarning {
    /// The interpreter did not report a version: it would not run, printed no
    /// `Python X.Y.Z` banner, or did not answer in time.
    VersionUnknown,
    /// Older than the Host supports.
    BelowHostMinimum { version: String, minimum: String },
    /// Outside the plugin's `requires-python`.
    RequirementUnmet {
        version: String,
        requirement: String,
    },
    /// The plugin's `requires-python` could not be evaluated.
    RequirementUnreadable {
        problem: RequirementProblem,
        #[serde(skip_serializing_if = "Option::is_none")]
        requirement: Option<String>,
    },
}

/// Read `requires-python` from the plugin's root. The root has already been
/// checked to be a real directory free of symlinks; the file itself is read
/// without following a link.
pub fn read_requires_python(plugin_root: &Path) -> RequiresPython {
    let path = plugin_root.join(PYPROJECT);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return RequiresPython::Absent
        }
        Err(error) => return unreadable_pyproject(format!("stat {PYPROJECT}: {error}")),
    };
    if !metadata.is_file() {
        return unreadable_pyproject(format!("{PYPROJECT} is not a regular file"));
    }
    if metadata.len() > PYPROJECT_MAX_BYTES {
        return unreadable_pyproject(format!(
            "{PYPROJECT} is {} bytes, more than the {PYPROJECT_MAX_BYTES} read",
            metadata.len()
        ));
    }
    let bytes = match crate::contained_path::read_existing_plugin_file(plugin_root, PYPROJECT) {
        Ok(bytes) => bytes,
        Err(error) => return unreadable_pyproject(error),
    };
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => return unreadable_pyproject(format!("{PYPROJECT} is not UTF-8")),
    };
    parse_requires_python(&text)
}

fn unreadable_pyproject(detail: String) -> RequiresPython {
    RequiresPython::Unreadable {
        problem: RequirementProblem::InvalidPyproject,
        raw: None,
        detail,
    }
}

fn parse_requires_python(text: &str) -> RequiresPython {
    let document = match text.parse::<toml_edit::DocumentMut>() {
        Ok(document) => document,
        Err(error) => return unreadable_pyproject(format!("{PYPROJECT}: {error}")),
    };
    let Some(value) = document
        .get("project")
        .and_then(|project| project.get("requires-python"))
    else {
        return RequiresPython::Absent;
    };
    let Some(raw) = value.as_str() else {
        return RequiresPython::Unreadable {
            problem: RequirementProblem::NotAString,
            raw: None,
            detail: format!("[project].requires-python in {PYPROJECT} is not a string"),
        };
    };
    match VersionSpecifiers::from_str(raw) {
        Ok(specifiers) => RequiresPython::Declared {
            raw: raw.trim().to_string(),
            specifiers,
        },
        Err(error) => RequiresPython::Unreadable {
            problem: RequirementProblem::InvalidSpecifier,
            raw: Some(raw.trim().to_string()),
            detail: format!("requires-python \"{}\": {error}", raw.trim()),
        },
    }
}

fn minimum_label() -> String {
    format!("{}.{}", MIN_VERSION.0, MIN_VERSION.1)
}

/// The first reason to doubt `version`, if any. Checked in order: a version
/// to compare at all, the Host minimum, then the plugin's requirement.
pub fn interpreter_warning(
    version: Option<&str>,
    requirement: &RequiresPython,
) -> Option<InterpreterWarning> {
    let Some((version, parsed)) =
        version.and_then(|text| parse_python_version(text).map(|parsed| (text, parsed)))
    else {
        return Some(InterpreterWarning::VersionUnknown);
    };
    if parsed < MIN_VERSION {
        return Some(InterpreterWarning::BelowHostMinimum {
            version: version.to_string(),
            minimum: minimum_label(),
        });
    }
    match requirement {
        RequiresPython::Absent => None,
        RequiresPython::Unreadable { problem, raw, .. } => {
            Some(InterpreterWarning::RequirementUnreadable {
                problem: *problem,
                requirement: raw.clone(),
            })
        }
        RequiresPython::Declared { raw, specifiers } => {
            // pip compares `sys.version_info[:3]`: a 3.13.0rc1 interpreter is
            // 3.13.0 here too.
            let release = Version::new([
                u64::from(parsed.0),
                u64::from(parsed.1),
                u64::from(parsed.2),
            ]);
            (!specifiers.contains(&release)).then(|| InterpreterWarning::RequirementUnmet {
                version: version.to_string(),
                requirement: raw.clone(),
            })
        }
    }
}

/// One line for the plugin's log and the app log.
pub fn warning_line(warning: &InterpreterWarning, requirement: &RequiresPython) -> String {
    match warning {
        InterpreterWarning::VersionUnknown => {
            "interpreter check: the interpreter reported no Python version; \
             the plugin loads anyway"
                .to_string()
        }
        InterpreterWarning::BelowHostMinimum { version, minimum } => format!(
            "interpreter check: Python {version} is older than the {minimum} the host needs; \
             the plugin loads anyway"
        ),
        InterpreterWarning::RequirementUnmet {
            version,
            requirement,
        } => format!(
            "interpreter check: Python {version} does not satisfy requires-python \
             \"{requirement}\"; the plugin loads anyway"
        ),
        InterpreterWarning::RequirementUnreadable { .. } => {
            let detail = match requirement {
                RequiresPython::Unreadable { detail, .. } => detail.as_str(),
                _ => "requires-python could not be read",
            };
            format!("interpreter check: {detail}; the version was not checked against it")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declared(raw: &str) -> RequiresPython {
        parse_requires_python(&format!(
            "[project]\nname = \"demo\"\nrequires-python = \"{raw}\"\n"
        ))
    }

    #[test]
    fn reads_requires_python_from_the_project_table() {
        match declared(">=3.10") {
            RequiresPython::Declared { raw, .. } => assert_eq!(raw, ">=3.10"),
            other => panic!("expected a declared requirement, got {other:?}"),
        }
        assert!(matches!(
            parse_requires_python("[project]\nrequires-python = \">=3.10\"\n"),
            RequiresPython::Declared { .. }
        ));
        assert!(matches!(
            parse_requires_python("project = { requires-python = \">=3.10\" }\n"),
            RequiresPython::Declared { .. }
        ));
    }

    #[test]
    fn absent_without_a_project_requirement() {
        assert!(matches!(parse_requires_python(""), RequiresPython::Absent));
        assert!(matches!(
            parse_requires_python("[tool.ruff]\nline-length = 100\n"),
            RequiresPython::Absent
        ));
        assert!(matches!(
            parse_requires_python("[project]\nname = \"demo\"\n"),
            RequiresPython::Absent
        ));
    }

    #[test]
    fn unreadable_requirements_say_why() {
        assert!(matches!(
            parse_requires_python("[project\n"),
            RequiresPython::Unreadable {
                problem: RequirementProblem::InvalidPyproject,
                ..
            }
        ));
        assert!(matches!(
            parse_requires_python("[project]\nrequires-python = 3.10\n"),
            RequiresPython::Unreadable {
                problem: RequirementProblem::NotAString,
                ..
            }
        ));
        match declared("3.10") {
            RequiresPython::Unreadable {
                problem: RequirementProblem::InvalidSpecifier,
                raw,
                ..
            } => assert_eq!(raw.as_deref(), Some("3.10")),
            other => panic!("expected an invalid specifier, got {other:?}"),
        }
    }

    #[test]
    fn reads_the_file_from_the_plugin_root() {
        let root = tempfile::tempdir().unwrap();
        assert!(matches!(
            read_requires_python(root.path()),
            RequiresPython::Absent
        ));
        std::fs::write(
            root.path().join(PYPROJECT),
            "[project]\nrequires-python = \">=3.11\"\n",
        )
        .unwrap();
        assert!(matches!(
            read_requires_python(root.path()),
            RequiresPython::Declared { .. }
        ));
    }

    #[test]
    fn a_directory_or_oversized_file_is_unreadable() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(PYPROJECT)).unwrap();
        assert!(matches!(
            read_requires_python(root.path()),
            RequiresPython::Unreadable {
                problem: RequirementProblem::InvalidPyproject,
                ..
            }
        ));

        let root = tempfile::tempdir().unwrap();
        let padding = "#".repeat(PYPROJECT_MAX_BYTES as usize + 1);
        std::fs::write(root.path().join(PYPROJECT), padding).unwrap();
        assert!(matches!(
            read_requires_python(root.path()),
            RequiresPython::Unreadable {
                problem: RequirementProblem::InvalidPyproject,
                ..
            }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_pyproject_is_not_followed() {
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("elsewhere.toml");
        std::fs::write(&target, "[project]\nrequires-python = \">=3.11\"\n").unwrap();
        let root = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(&target, root.path().join(PYPROJECT)).unwrap();
        assert!(matches!(
            read_requires_python(root.path()),
            RequiresPython::Unreadable {
                problem: RequirementProblem::InvalidPyproject,
                ..
            }
        ));
    }

    #[test]
    fn no_warning_when_both_requirements_hold() {
        assert_eq!(
            interpreter_warning(Some("3.12.4"), &declared(">=3.10")),
            None
        );
        assert_eq!(
            interpreter_warning(Some("3.9.0"), &RequiresPython::Absent),
            None
        );
    }

    #[test]
    fn an_unknown_version_is_reported_first() {
        assert_eq!(
            interpreter_warning(None, &declared("3.10")),
            Some(InterpreterWarning::VersionUnknown)
        );
        assert_eq!(
            interpreter_warning(Some("not a version"), &RequiresPython::Absent),
            Some(InterpreterWarning::VersionUnknown)
        );
    }

    #[test]
    fn the_host_minimum_comes_before_the_plugin_requirement() {
        assert_eq!(
            interpreter_warning(Some("3.8.18"), &declared(">=3.10")),
            Some(InterpreterWarning::BelowHostMinimum {
                version: "3.8.18".into(),
                minimum: "3.9".into(),
            })
        );
    }

    #[test]
    fn an_unmet_requirement_names_both_sides() {
        assert_eq!(
            interpreter_warning(Some("3.9.18"), &declared(">=3.10")),
            Some(InterpreterWarning::RequirementUnmet {
                version: "3.9.18".into(),
                requirement: ">=3.10".into(),
            })
        );
        // A release candidate counts as its release, as pip counts it.
        assert_eq!(
            interpreter_warning(Some("3.13.0rc1"), &declared(">=3.13")),
            None
        );
    }

    #[test]
    fn an_unreadable_requirement_is_a_warning_of_its_own() {
        assert_eq!(
            interpreter_warning(Some("3.12.0"), &declared("3.10")),
            Some(InterpreterWarning::RequirementUnreadable {
                problem: RequirementProblem::InvalidSpecifier,
                requirement: Some("3.10".into()),
            })
        );
    }

    #[test]
    fn warnings_serialize_in_the_wire_shape() {
        assert_eq!(
            serde_json::to_value(InterpreterWarning::VersionUnknown).unwrap(),
            serde_json::json!({ "kind": "version-unknown" })
        );
        assert_eq!(
            serde_json::to_value(InterpreterWarning::RequirementUnmet {
                version: "3.9.18".into(),
                requirement: ">=3.10".into(),
            })
            .unwrap(),
            serde_json::json!({
                "kind": "requirement-unmet",
                "version": "3.9.18",
                "requirement": ">=3.10",
            })
        );
        assert_eq!(
            serde_json::to_value(InterpreterWarning::RequirementUnreadable {
                problem: RequirementProblem::NotAString,
                requirement: None,
            })
            .unwrap(),
            serde_json::json!({ "kind": "requirement-unreadable", "problem": "not-a-string" })
        );
    }

    #[test]
    fn log_lines_carry_the_detail() {
        let requirement = declared("3.10");
        let warning = interpreter_warning(Some("3.12.0"), &requirement).unwrap();
        let line = warning_line(&warning, &requirement);
        assert!(line.contains("requires-python \"3.10\""), "{line}");
        assert!(
            warning_line(&InterpreterWarning::VersionUnknown, &RequiresPython::Absent)
                .contains("no Python version")
        );
    }
}
