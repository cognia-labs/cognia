//! Reject host-private and subpath imports in the author's own source, BEFORE
//! esbuild runs.
//!
//! ## Why a pre-build scan is load-bearing
//!
//! The host already refuses a bundle whose text names a `@/` module
//! (`lib/plugin/security/import-boundary.ts`, called from the loader before
//! `(0, eval)`). That check runs on the BUNDLED output, and esbuild is perfectly
//! capable of resolving a monorepo `@/` alias through the author's own
//! `tsconfig.json` and inlining the target. Once inlined, the specifier string
//! is gone: the loader sees a clean bundle and evaluates host code that was
//! never meant to leave the app. The post-bundle scan is a last line, not a
//! boundary.
//!
//! Scanning the author's source tree closes that hole, and it fails at the only
//! moment where the diagnostic can name the file and line the author wrote.
//!
//! ## What is forbidden
//!
//! Author code may import the roots `@cognia/plugin-sdk` and
//! `@cognia/plugin-ui`, and nothing else from this project:
//!
//!   * every `@/` alias — those resolve only inside the cognia monorepo, so a
//!     plugin using one cannot be built anywhere else;
//!   * every `@cognia/plugin-{sdk,ui}` SUBPATH — the package still exports
//!     several for host and tooling use, but the author-facing contract is one
//!     root surface, which is what lets those subpaths be reorganised without
//!     breaking a published plugin.
//!
//! The same policy is enforced over first-party plugins in CI by
//! `scripts/plugin/check-author-imports.mjs`; keep the two in step.

use std::path::{Path, PathBuf};

use super::report::{Diagnostic, Severity};

const SOURCE_EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs"];

/// Directories that never hold author source. `dist` and `target` are build
/// output (scanning them would re-report the very inlining we are preventing),
/// and `node_modules` is dependencies.
const SKIPPED_DIRS: &[&str] = &["node_modules", "dist", "target", "build", "out", ".git"];

const HOST_PRIVATE_ALIAS: &str = "@/";
const SDK_PACKAGES: &[&str] = &["@cognia/plugin-sdk/", "@cognia/plugin-ui/"];

/// A specifier the author may not use, with why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForbiddenImport {
    pub specifier: String,
    pub kind: ForbiddenKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForbiddenKind {
    /// `@/…` — an alias private to the cognia monorepo.
    HostPrivate,
    /// `@cognia/plugin-sdk/x` — real package, but not the author surface.
    SdkSubpath,
}

impl ForbiddenKind {
    fn code(self) -> &'static str {
        match self {
            Self::HostPrivate => "source.import.host_private",
            Self::SdkSubpath => "source.import.sdk_subpath",
        }
    }

    fn hint(self) -> &'static str {
        match self {
            Self::HostPrivate => {
                "`@/` resolves only inside the cognia repository. Import the value from \
                 `@cognia/plugin-sdk` or `@cognia/plugin-ui` instead; if it is not exported \
                 there, it is not part of the plugin contract yet."
            }
            Self::SdkSubpath => {
                "Import from the package root instead — `@cognia/plugin-sdk` or \
                 `@cognia/plugin-ui`. Subpaths are host/tooling internals and several of \
                 them do not resolve outside this repository at all."
            }
        }
    }
}

fn classify(specifier: &str) -> Option<ForbiddenKind> {
    if specifier.starts_with(HOST_PRIVATE_ALIAS) {
        return Some(ForbiddenKind::HostPrivate);
    }
    if SDK_PACKAGES
        .iter()
        .any(|package| specifier.starts_with(package) && specifier.len() > package.len())
    {
        return Some(ForbiddenKind::SdkSubpath);
    }
    None
}

/// True when `prefix` (everything before an opening quote) puts that string in
/// module-specifier position: `from "x"`, `import "x"`, `import("x")`,
/// `require("x")`.
fn is_specifier_position(prefix: &str) -> bool {
    let trimmed = prefix.trim_end();
    if let Some(head) = trimmed.strip_suffix('(') {
        let head = head.trim_end();
        return ends_with_word(head, "import") || ends_with_word(head, "require");
    }
    ends_with_word(trimmed, "from") || ends_with_word(trimmed, "import")
}

/// `ends_with` plus a word boundary, so `platform` does not read as `from`.
fn ends_with_word(haystack: &str, word: &str) -> bool {
    let Some(head) = haystack.strip_suffix(word) else {
        return false;
    };
    head.chars()
        .next_back()
        .is_none_or(|c| !c.is_alphanumeric() && c != '_' && c != '$' && c != '.')
}

/// Every forbidden specifier in one file, in source order.
///
/// Hand-rolled rather than regex-driven because the scan has to be string- and
/// comment-aware in the same pass: a doc comment naming `@/lib/utils` is prose,
/// and a URL like `"http://x"` must not read as the start of a line comment.
/// (`plugins/impeccable`, one of only two plugins already root-only, carries
/// exactly such a doc comment in its vendored declarations.)
pub fn find_forbidden_imports(source: &str) -> Vec<ForbiddenImport> {
    let bytes = source.as_bytes();
    let mut found = Vec::new();
    let mut index = 0usize;

    while index < bytes.len() {
        match bytes[index] {
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                while index < bytes.len() {
                    if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
                        index += 2;
                        break;
                    }
                    index += 1;
                }
            }
            quote @ (b'"' | b'\'' | b'`') => {
                let start = index + 1;
                let mut end = start;
                while end < bytes.len() && bytes[end] != quote {
                    // Skip the escaped byte so `"a\"b"` stays one literal.
                    end += if bytes[end] == b'\\' { 2 } else { 1 };
                }
                if end <= bytes.len() {
                    let literal = &source[start..end.min(source.len())];
                    if is_specifier_position(&source[..index]) {
                        if let Some(kind) = classify(literal) {
                            found.push(ForbiddenImport {
                                specifier: literal.to_string(),
                                kind,
                            });
                        }
                    }
                }
                index = end + 1;
            }
            _ => index += 1,
        }
    }

    found
}

fn collect_source_files(root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if SKIPPED_DIRS.contains(&name.as_ref()) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_source_files(&path, files);
        } else if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| SOURCE_EXTENSIONS.contains(&ext))
        {
            files.push(path);
        }
    }
}

/// Scan the plugin's own source tree and report every forbidden import as an
/// error diagnostic. Files that cannot be read are skipped rather than failing
/// the lint: an unreadable file is a different problem, and reporting it here
/// would bury the import diagnostics the author can act on.
pub fn scan_author_imports(root: &Path) -> Vec<Diagnostic> {
    let mut files = Vec::new();
    collect_source_files(root, &mut files);
    files.sort();

    let mut diagnostics = Vec::new();
    for file in files {
        let Ok(source) = std::fs::read_to_string(&file) else {
            continue;
        };
        let relative = file.strip_prefix(root).unwrap_or(&file);
        let display = relative.to_string_lossy().replace('\\', "/");

        let mut seen: Vec<String> = Vec::new();
        for forbidden in find_forbidden_imports(&source) {
            if seen.contains(&forbidden.specifier) {
                continue;
            }
            seen.push(forbidden.specifier.clone());
            diagnostics.push(Diagnostic {
                severity: Severity::Error,
                field: display.clone(),
                code: forbidden.kind.code().to_string(),
                message: format!(
                    "{display} imports `{}`, which plugin authors may not use.",
                    forbidden.specifier
                ),
                hint: Some(forbidden.kind.hint().to_string()),
            });
        }
    }
    diagnostics
}

#[cfg(test)]
mod tests {
    use super::*;

    fn specifiers(source: &str) -> Vec<String> {
        find_forbidden_imports(source)
            .into_iter()
            .map(|found| found.specifier)
            .collect()
    }

    #[test]
    fn flags_every_directory_under_the_alias() {
        // The loader's old four-prefix list is exactly why `plugins/web-tools`
        // could reach `@/packages/plugin-sdk/src/host` and still load.
        assert_eq!(
            specifiers(
                r#"
                import type { PluginContext } from "@/types/plugin"
                import "@/lib/plugin/side-effect"
                const c = require("@/components/private")
                const s = await import("@/stores/private")
                import { gate } from "@/packages/plugin-sdk/src/host"
                import { useThing } from "@/hooks/ui/use-thing"
                "#
            ),
            vec![
                "@/types/plugin",
                "@/lib/plugin/side-effect",
                "@/components/private",
                "@/stores/private",
                "@/packages/plugin-sdk/src/host",
                "@/hooks/ui/use-thing",
            ]
        );
    }

    #[test]
    fn flags_sdk_subpaths_but_allows_both_roots() {
        assert_eq!(
            specifiers(
                r#"
                import { definePlugin } from "@cognia/plugin-sdk"
                import { Button } from "@cognia/plugin-ui"
                import { definePlugin as d } from "@cognia/plugin-sdk/manifest"
                import type { Ctx } from "@cognia/plugin-sdk/context"
                import { cn } from "@cognia/plugin-ui/cn"
                "#
            ),
            vec![
                "@cognia/plugin-sdk/manifest",
                "@cognia/plugin-sdk/context",
                "@cognia/plugin-ui/cn",
            ]
        );
    }

    #[test]
    fn leaves_third_party_and_relative_specifiers_alone() {
        assert!(specifiers(
            r#"
            import ky from "ky"
            import { helper } from "./helper"
            import { shared } from "../shared"
            import react from "react"
            "#
        )
        .is_empty());
    }

    #[test]
    fn a_comment_naming_an_alias_is_prose() {
        assert!(specifiers(
            r#"
            /** Mirrors `cn` from "@/lib/utils". */
            // was: import { cn } from "@/lib/utils"
            import { cn } from "@cognia/plugin-ui"
            "#
        )
        .is_empty());
    }

    #[test]
    fn a_url_is_not_the_start_of_a_line_comment() {
        // A naive comment stripper eats the rest of the file here and silently
        // stops finding imports.
        assert_eq!(
            specifiers(
                r#"
                const endpoint = "https://example.com/x"
                import { thing } from "@/lib/after-the-url"
                "#
            ),
            vec!["@/lib/after-the-url"]
        );
    }

    #[test]
    fn a_bare_string_is_not_a_specifier() {
        // Only strings in module-specifier position count; `platform` must not
        // read as `from`.
        assert!(specifiers(
            r#"
            const note = "@/lib/not-an-import"
            const platform = "@/lib/still-not-one"
            "#
        )
        .is_empty());
    }

    #[test]
    fn classifies_the_two_kinds_apart() {
        let found = find_forbidden_imports(
            r#"
            import a from "@/lib/a"
            import b from "@cognia/plugin-sdk/manifest"
            "#,
        );
        assert_eq!(found[0].kind, ForbiddenKind::HostPrivate);
        assert_eq!(found[1].kind, ForbiddenKind::SdkSubpath);
    }

    #[test]
    fn scan_reports_one_diagnostic_per_file_and_specifier() {
        let dir =
            std::env::temp_dir().join(format!("cognia-source-imports-{}", std::process::id()));
        let src = dir.join("src");
        std::fs::create_dir_all(&src).unwrap();
        // Repeated specifier in one file collapses to a single diagnostic.
        std::fs::write(
            src.join("index.ts"),
            "import a from \"@/lib/a\"\nimport b from \"@/lib/a\"\nimport c from \"@/lib/c\"\n",
        )
        .unwrap();
        // Build output is not author source.
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        std::fs::write(dir.join("dist/index.js"), "require(\"@/lib/bundled\")").unwrap();

        let diagnostics = scan_author_imports(&dir);
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(diagnostics.len(), 2);
        assert!(diagnostics.iter().all(|d| d.severity == Severity::Error));
        assert!(diagnostics.iter().all(|d| d.field == "src/index.ts"));
        assert!(diagnostics
            .iter()
            .all(|d| d.code == "source.import.host_private"));
    }
}
