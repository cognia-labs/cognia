---
"cognia-next": minor
---

Harden file management integrity, failure feedback, recovery, and cross-layout ergonomics across Files, FileSpace, native workspace files, and SFTP:

- Stream full UTF-8 document bytes over `files_library_read_chunk` when paired `files_library_get` truncates at 128 KiB, refusing silent truncation on download, zip export, preview, and chat staging.
- Carry per-file version tokens on `WorkspaceFileChunk` and `FilesRemoteReadChunk` so equal-size replacements mid-read retry cleanly instead of splicing versions across Files, FileSpace share uploads, and paired reads.
- Guarantee unique, collision-free virtual paths in FileSpace across `asset-`/`cognia-upload:`/`video-` prefixes and literal `~` filenames, and persist partial SFTP download bytes across pause/failure with remote mtime/size validation on resume.
- Harden native workspace root-alias deletion/rename/copy guards, prevent copying or renaming directories into themselves before creating destination folders, surface skipped symlinks on recursive copy, bound `read_workspace_file` prefix I/O, propagate unreadable-directory errors, degrade to metadata polling when desktop `plugin_fs_watch` fails, and scope workspace search caches by active Host.
- Refresh paired body-search hits on list refresh, surface body-search errors and bounded/truncated search scope notices with retry, expand paged Files views synchronously on keyboard navigation, and add menu/mobile folder moves, folder-hierarchy imports, and cross-layout sort controls.
