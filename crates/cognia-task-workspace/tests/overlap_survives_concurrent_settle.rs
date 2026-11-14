//! ADR-0255 across two service connections (postfix review P02).
//!
//! A run settles while a second connection begins on the same directory and
//! writes there. The second begin marks the settling run overlapped in the
//! database; the settle must still decide reversibility from that mark, not
//! from the copy of the run it read before its capture. Otherwise Undo of
//! the first run removes the second run's file while it is still running.
//!
//! The capture is held open by a `git` wrapper on `PATH` that blocks the
//! first `git status`. Changing `PATH` is process-wide, which is why this is
//! the only test in its own integration binary.

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use cognia_task_workspace::{BeginTaskRun, IrreversibleReason, RunState, ServiceConfig, TaskWorkspaceService};
use tempfile::TempDir;

fn observed(root: &Path, task: &str, session: &str) -> BeginTaskRun {
    let mut input: BeginTaskRun = serde_json::from_value(serde_json::json!({
        "taskId": task,
        "sessionId": session,
        "runId": task,
        "agentId": "agent",
        "agentKind": "assistant",
        "workspaceRoot": root,
        "observeInPlace": true,
    }))
    .unwrap();
    input.observe_in_place = true;
    input
}

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(root)
        .args(["-c", "user.name=test", "-c", "user.email=test@example.com"])
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

fn real_git() -> String {
    let output = Command::new("sh").args(["-c", "command -v git"]).output().unwrap();
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

#[test]
fn a_mark_stored_by_another_connection_during_settle_keeps_the_patch_irreversible() {
    let base = TempDir::new().unwrap();
    let root = base.path().join("repo");
    fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-q"]);
    fs::write(root.join("base.txt"), "base\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "base"]);
    let data = base.path().join("data");
    let first = Arc::new(TaskWorkspaceService::open(ServiceConfig::new(data.clone())).unwrap());
    let second = TaskWorkspaceService::open(ServiceConfig::new(data)).unwrap();
    first.begin_run(observed(&root, "first", "session-a")).unwrap();

    let barrier = base.path().join("barrier");
    fs::create_dir_all(&barrier).unwrap();
    let bin = base.path().join("bin");
    fs::create_dir_all(&bin).unwrap();
    let wrapper = format!(
        "#!/bin/sh\ncase \" $* \" in *\" status \"*) if /bin/mkdir \"{barrier}/once\" 2>/dev/null; then \
         /usr/bin/touch \"{barrier}/entered\"; n=0; while [ ! -f \"{barrier}/release\" ] && [ $n -lt 1500 ]; \
         do /bin/sleep 0.02; n=$((n+1)); done; fi ;; esac\nexec '{git}' \"$@\"\n",
        barrier = barrier.display(),
        git = real_git(),
    );
    fs::write(bin.join("git"), wrapper).unwrap();
    fs::set_permissions(bin.join("git"), fs::Permissions::from_mode(0o755)).unwrap();
    let path = std::env::var("PATH").unwrap();
    std::env::set_var("PATH", format!("{}:{path}", bin.display()));

    let settling = {
        let first = Arc::clone(&first);
        std::thread::spawn(move || first.settle_run("first"))
    };
    let mut entered = false;
    for _ in 0..1500 {
        if barrier.join("entered").exists() {
            entered = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if !entered {
        fs::write(barrier.join("release"), "").unwrap();
        let _ = settling.join();
        panic!("the settle capture never reached the barrier");
    }
    // Sharing stays allowed: the second run begins while the first settles.
    let peer = second.begin_run(observed(&root, "second", "session-b")).unwrap();
    assert!(peer.overlapped);
    assert!(second.list_runs("first").unwrap()[0].overlapped);
    fs::write(root.join("peer.txt"), "peer\n").unwrap();
    fs::write(barrier.join("release"), "").unwrap();
    let settled = settling.join().unwrap();
    std::env::set_var("PATH", path);
    settled.unwrap();

    let run = first.list_runs("first").unwrap().remove(0);
    assert!(run.overlapped, "the mark another connection stored was overwritten");
    let patch = first.get_patch_set("first").unwrap().unwrap();
    assert!(!patch.reversible);
    assert_eq!(patch.irreversible_reason, Some(IrreversibleReason::Overlap));
    assert!(first.undo_patch_set("first").is_err());
    assert!(root.join("peer.txt").is_file());
    assert_eq!(second.list_runs("second").unwrap()[0].state, RunState::Running);
}
