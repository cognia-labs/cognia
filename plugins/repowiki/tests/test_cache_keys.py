"""Cache key granularity: arch / guide should not invalidate on body edits."""
from __future__ import annotations

from repowiki.core.analyzer import Analyzer
from repowiki.core.models import FileInfo, ProjectContext


def _project(files: list[FileInfo]) -> ProjectContext:
    return ProjectContext(
        name="x", root="/tmp/x", files=files,
        file_tree="\n".join(f.path for f in files),
    )


def _file(path: str, content: str, size: int | None = None) -> FileInfo:
    body = content
    return FileInfo(
        path=path,
        size=size if size is not None else len(body.encode()),
        language="python",
        lines=body.count("\n") + 1,
        preview=body,
        content=body,
    )


def test_structure_hash_ignores_source_body_changes():
    """editing the body of a regular source file with the same size
    must not change the structure hash that arch / guide cache uses."""
    p1 = _project([_file("src/foo.py", "def a(): return 1\n", size=200)])
    p2 = _project([_file("src/foo.py", "def b(): return 2\n", size=200)])

    assert Analyzer._structure_hash(p1) == Analyzer._structure_hash(p2)


def test_structure_hash_changes_when_file_added():
    p1 = _project([_file("src/foo.py", "x", size=10)])
    p2 = _project([
        _file("src/foo.py", "x", size=10),
        _file("src/bar.py", "y", size=10),
    ])

    assert Analyzer._structure_hash(p1) != Analyzer._structure_hash(p2)


def test_structure_hash_changes_when_size_changes():
    p1 = _project([_file("src/foo.py", "x", size=10)])
    p2 = _project([_file("src/foo.py", "x", size=20)])

    assert Analyzer._structure_hash(p1) != Analyzer._structure_hash(p2)


def test_overview_hash_changes_with_readme_edit():
    """README content does affect overview, even with same structure."""
    structure = Analyzer._structure_hash(_project([_file("README.md", "v1", size=10)]))

    p1 = _project([_file("README.md", "Project Foo\n\nDoes things.", size=10)])
    p2 = _project([_file("README.md", "Project Bar\n\nDoes other things.", size=10)])

    h1 = Analyzer._overview_hash(p1, structure)
    h2 = Analyzer._overview_hash(p2, structure)
    assert h1 != h2


def test_overview_hash_stable_for_unrelated_source_edit():
    """editing src/foo.py should NOT bust overview cache (README untouched, same size)."""
    structure_p1 = Analyzer._structure_hash(_project([
        _file("README.md", "Same readme", size=20),
        _file("src/foo.py", "v1 body", size=100),
    ]))
    structure_p2 = Analyzer._structure_hash(_project([
        _file("README.md", "Same readme", size=20),
        _file("src/foo.py", "v2 body", size=100),
    ]))

    p1 = _project([
        _file("README.md", "Same readme", size=20),
        _file("src/foo.py", "v1 body", size=100),
    ])
    p2 = _project([
        _file("README.md", "Same readme", size=20),
        _file("src/foo.py", "v2 body", size=100),
    ])

    assert structure_p1 == structure_p2
    assert Analyzer._overview_hash(p1, structure_p1) == Analyzer._overview_hash(p2, structure_p2)


def test_overview_hash_changes_with_same_size_entrypoint_or_config_edit():
    ep1 = FileInfo(
        path="src/main.py",
        size=30,
        language="python",
        lines=2,
        preview="def main():\n    return 1\n",
        content="def main():\n    return 1\n",
        is_entrypoint=True,
    )
    ep2 = FileInfo(
        path="src/main.py",
        size=30,
        language="python",
        lines=2,
        preview="def main():\n    return 2\n",
        content="def main():\n    return 2\n",
        is_entrypoint=True,
    )
    p1 = _project([ep1])
    p2 = _project([ep2])
    s1 = Analyzer._structure_hash(p1)
    s2 = Analyzer._structure_hash(p2)
    assert s1 == s2
    assert Analyzer._overview_hash(p1, s1) != Analyzer._overview_hash(p2, s2)


def test_module_digest_distinguishes_file_boundaries_and_paths():
    _, d1 = Analyzer._build_module_context(
        "mod", [_file("mod/a.py", "ab"), _file("mod/b.py", "c")]
    )
    _, d2 = Analyzer._build_module_context(
        "mod", [_file("mod/a.py", "a"), _file("mod/b.py", "bc")]
    )
    _, d3 = Analyzer._build_module_context(
        "mod", [_file("mod/renamed.py", "ab"), _file("mod/b.py", "c")]
    )
    assert d1 != d2
    assert d1 != d3


async def test_analyzer_cache_invalidates_on_prompt_revision_language_and_model(tmp_path):
    from repowiki.core.cache import Cache
    from repowiki.host import HostBridge, LLMClient, forget_registered_prompts, register_prompts, set_host

    class ProbeHost(HostBridge):
        def __init__(self):
            self.wording = "Revision A"
            self.runs: list[tuple[str, dict]] = []
            self.resolve_records: list[tuple[str, bool]] = []

        async def prompts_register(self, declarations):
            return {"promptIds": [f"plugin:cognia-repowiki/{d['id']}" for d in declarations]}

        async def prompts_resolve(self, prompt_id, *, record: bool = False):
            self.resolve_records.append((prompt_id, record))
            return {"text": f"{self.wording} ({prompt_id})", "source": "override"}

        async def agent_run(self, prompt, options):
            self.runs.append((prompt, options))
            system = options.get("system") or ""
            if "(overview)" in system:
                return {"text": '{"name":"demo","one_liner":"Demo pitch"}', "usage": {}}
            if "(module)" in system:
                return {"text": '{"name":"core","purpose":"Core logic","files":[]}', "usage": {}}
            if "(architecture)" in system:
                return {"text": '{"mermaid":"graph TD\\n  A-->B","explanation":"flow"}', "usage": {}}
            return {"text": '{"summary":"start","entry_points":[]}', "usage": {}}

    host = ProbeHost()
    set_host(host)
    cache = Cache(db_path=tmp_path / "cache.db")
    await cache.init()
    try:
        await register_prompts()
        project = _project([
            FileInfo(
                path="README.md",
                size=12,
                language="markdown",
                lines=1,
                preview="# Demo\n",
                content="# Demo\n",
                is_config=True,
            ),
            _file("src/core/mod.py", "def run():\n    return 1\n"),
        ])

        # 1 overview + 2 modules (root, core) + 1 architecture + 1 reading-guide = 5 calls.
        await Analyzer(LLMClient(model="m-1"), cache, language="en").analyze(project)
        assert len(host.runs) == 5
        assert [rec for _, rec in host.resolve_records if rec] == [True] * 5

        # Exact warm rerun: 0 new model calls and 0 new `record=True` usage marks.
        host.resolve_records.clear()
        await Analyzer(LLMClient(model="m-1"), cache, language="en").analyze(project)
        assert len(host.runs) == 5
        assert all(not rec for _, rec in host.resolve_records)

        # Prompt Center revision change invalidates all stages.
        host.wording = "Revision B"
        await Analyzer(LLMClient(model="m-1"), cache, language="en").analyze(project)
        assert len(host.runs) == 10
        assert "Revision B (overview)" in (host.runs[-5][1].get("system") or "")

        # Language change invalidates all stages.
        await Analyzer(LLMClient(model="m-1"), cache, language="zh").analyze(project)
        assert len(host.runs) == 15

        # Model change invalidates all stages.
        await Analyzer(LLMClient(model="m-2"), cache, language="zh").analyze(project)
        assert len(host.runs) == 20
    finally:
        await cache.close()
        forget_registered_prompts()
        set_host(None)
