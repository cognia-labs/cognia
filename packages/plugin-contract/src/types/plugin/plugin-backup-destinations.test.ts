import { validateBackupDestinationDeclaration } from "./plugin-backup-destinations"

it("validates local identifiers and reserves every Host destination", () => {
  expect(validateBackupDestinationDeclaration({ id: "archive", label: "Archive" })).toEqual([])
  for (const id of [
    "local",
    "webdav",
    "github",
    "googledrive",
    "convex",
    "all",
    "plugin:other/archive",
    "../archive",
    "a/b",
    "",
  ]) {
    expect(validateBackupDestinationDeclaration({ id, label: "Archive" })).not.toEqual([])
  }
  expect(validateBackupDestinationDeclaration(null)).not.toEqual([])
  expect(validateBackupDestinationDeclaration({ id: "archive", label: " " })).not.toEqual([])
})
