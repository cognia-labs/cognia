"""Symbol citations name the file's own line, whatever the prompt counted from."""
from __future__ import annotations

from repowiki.core.graph import DependencyGraph
from repowiki.core.models import (
    FileDoc,
    FileInfo,
    ModuleDoc,
    ProjectContext,
    Symbol,
    WikiData,
)
from repowiki.core.wiki_builder import WikiBuilder
from repowiki.llm.prompts import build_module_prompt
from repowiki.pipeline import anchor_symbol_lines

SOURCE = "\n\ndef parse():\n    return 1\n\nclass Foo:\n    pass\n"


def _project() -> ProjectContext:
    return ProjectContext(
        name="x",
        root="/tmp/x",
        files=[
            FileInfo(path="example.py", size=len(SOURCE), content=SOURCE, lines=8),
            FileInfo(path="plain.py", size=5, content="x = 1\n", lines=2),
        ],
    )


def _wiki(*symbols: tuple[str, str, int]) -> WikiData:
    files: dict[str, list[Symbol]] = {}
    for path, name, line in symbols:
        files.setdefault(path, []).append(Symbol(name=name, kind="function", line=line))
    return WikiData(
        modules=[
            ModuleDoc(
                name="core",
                files=[FileDoc(path=p, key_symbols=s) for p, s in files.items()],
            )
        ]
    )


def test_the_prompt_still_counts_from_the_first_non_blank_line():
    # The contract this translation honours; if the prompt changes, so must it.
    system = build_module_prompt("core", "files", "summary", "en")[0]["content"]
    assert "first non-blank line" in system


def test_a_file_opening_with_blank_lines_is_cited_at_its_own_line():
    # `parse` is the first non-blank line (prompt line 1) and file line 3.
    wiki_data = _wiki(("example.py", "parse", 1), ("example.py", "Foo", 4))
    anchor_symbol_lines(wiki_data, _project())
    symbols = wiki_data.modules[0].files[0].key_symbols
    assert [s.line for s in symbols] == [3, 6]
    page = next(
        p
        for p in WikiBuilder().build(_project(), wiki_data, DependencyGraph()).pages
        if p.id == "modules/core"
    )
    assert "`example.py:3`" in page.content
    assert "`example.py:1`" not in page.content


def test_unknown_lines_and_files_without_leading_blanks_are_left_alone():
    wiki_data = _wiki(("example.py", "opaque", 0), ("plain.py", "x", 1), ("gone.py", "y", 2))
    anchor_symbol_lines(wiki_data, _project())
    lines = [s.line for f in wiki_data.modules[0].files for s in f.key_symbols]
    assert lines == [0, 1, 2]
