---
"cognia-next": minor
---

The CLI keeps one sign-in per local account. `cognia-agent logto login --account <id>` signs a person in to that account, the same one `serve`, `account-sync` and `host login` act for. The account then stays theirs: signing in as anyone else is refused unless `--rebind` hands it over. Two Hosts on one machine therefore no longer share whoever signed in last, and `logto status` lists every account and the person it acts for. Multi-tenant Hosts can now be paired with `host login --endpoint <url> --account <id>`. Existing installs need to sign in once more, because `~/.cognia/logto.json` is no longer read.
