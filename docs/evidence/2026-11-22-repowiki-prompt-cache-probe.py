"""Reproduce a stale RepoWiki overview with real SQLite and a synthetic Host."""

import asyncio
import json

from repowiki.core.analyzer import Analyzer
from repowiki.core.cache import Cache
from repowiki.core.models import FileInfo, ProjectContext
from repowiki.host import HostBridge, LLMClient, register_prompts, set_host


class FixtureHost(HostBridge):
    def __init__(self):
        self.wording = "Revision A"
        self.systems = []

    async def prompts_register(self, declarations):
        return {"promptIds": [f"plugin:cognia-repowiki/{entry['id']}" for entry in declarations]}

    async def prompts_resolve(self, prompt_id):
        assert prompt_id == "overview"
        return {"text": self.wording, "source": "override"}

    async def agent_run(self, prompt, options):
        self.systems.append(options["system"])
        return {"text": json.dumps({"name": "sample", "one_liner": self.wording}), "usage": {}}


class ScanFixtureHost(FixtureHost):
    def __init__(self):
        super().__init__()
        self.resolved = []
        self.requests = []

    async def prompts_resolve(self, prompt_id):
        self.resolved.append(prompt_id)
        return {"text": f"{self.wording} [{prompt_id}]", "source": "override"}

    async def agent_run(self, prompt, options):
        self.requests.append(options.copy())
        marker = f"{self.wording}/{options['model']}"
        return {"text": json.dumps({
            "name": "sample",
            "one_liner": marker,
            "purpose": marker,
        }), "usage": {}}


async def full_scan_probe():
    host = ScanFixtureHost()
    set_host(host)
    cache = Cache(":memory:")
    await cache.init()
    try:
        await register_prompts()
        text = "def greet():\n    return 'hi'\n"
        project = ProjectContext(
            name="sample", root="/synthetic", file_tree="src/greeting.py",
            files=[FileInfo(path="src/main.py", content=text, size=len(text),
                            lines=2, language="python", is_entrypoint=True)],
        )

        async def scan(language, model):
            return await Analyzer(LLMClient(model=model), cache, language=language).analyze(project)

        first = await scan("en", "fixture-model-a")
        assert len(host.requests) == 4
        assert set(host.resolved) == {"overview", "module", "architecture", "reading-guide"}
        assert "Revision A [overview]" in host.requests[0]["system"]
        assert first.overview.one_liner == "Revision A/fixture-model-a"
        assert first.modules[0].purpose == "Revision A/fixture-model-a"
        assert (await scan("en", "fixture-model-a")) == first
        assert len(host.requests) == 4  # Positive warm-cache control.

        host.wording = "Revision B"
        assert (await scan("en", "fixture-model-a")) == first
        assert (await scan("zh", "fixture-model-a")) == first
        assert (await scan("zh", "fixture-model-b")) == first
        assert len(host.requests) == len(host.resolved) == 4

        assert await cache.clear() == 4
        fresh = await scan("zh", "fixture-model-b")
        assert fresh.overview.one_liner == "Revision B/fixture-model-b"
        assert fresh.modules[0].purpose == "Revision B/fixture-model-b"
        assert "Revision B [overview]" in host.requests[4]["system"]
        assert "请用中文回答" in host.requests[4]["system"]
        assert len(host.requests) == 8
        edited = project.model_copy(deep=True)
        edited.files[0].content = text.replace("'hi'", "'yo'")
        analyzer = Analyzer(LLMClient(model="fixture-model-b"), cache, language="zh")
        assert analyzer._build_key_files_context(project) != analyzer._build_key_files_context(edited)
        assert analyzer._overview_hash(project, analyzer._structure_hash(project)) == (
            analyzer._overview_hash(edited, analyzer._structure_hash(edited))
        )

        def module_file(name, body):
            return FileInfo(path=f"src/{name}.py", content=body, size=len(body),
                            lines=1, language="python")

        first_context, first_key = analyzer._build_module_context(
            "src", [module_file("one", "abc"), module_file("two", "d")]
        )
        next_context, next_key = analyzer._build_module_context(
            "src", [module_file("three", "a"), module_file("four", "bcd")]
        )
        assert first_context != next_context and first_key == next_key
        print(json.dumps({
            "name": "Scan analyzer",
            "cachedStages": host.resolved[:4],
            "initialRequests": 4,
            "additionalRequestsAfterRevisionLocaleAndModelChange": 0,
            "additionalRequestsAfterCacheClear": 4,
            "sameOverviewKeyAfterEntrypointEdit": True,
            "sameModuleKeyAfterPathAndContentBoundaryChanges": True,
        }))
    finally:
        await cache.close()
        set_host(None)


async def main():
    host = FixtureHost()
    set_host(host)
    cache = Cache(":memory:")
    await cache.init()
    try:
        await register_prompts()
        project = ProjectContext(name="sample", root="/synthetic")
        analyzer = Analyzer(LLMClient(), cache, language="en")
        first = await analyzer._generate_overview(project, "", "same-tree-hash")
        assert first.one_liner == "Revision A" and "Revision A" in host.systems[-1]

        host.wording = "Revision B"
        cached = await analyzer._generate_overview(project, "", "same-tree-hash")
        assert cached.one_liner == "Revision A" and len(host.systems) == 1

        await cache.clear()
        refreshed = await analyzer._generate_overview(project, "", "same-tree-hash")
        assert refreshed.one_liner == "Revision B"
        assert len(host.systems) == 2 and "Revision B" in host.systems[-1]
        print(json.dumps({
            "initial": first.one_liner,
            "reused": cached.one_liner,
            "after_cache_clear": refreshed.one_liner,
            "model_calls": len(host.systems),
        }))
    finally:
        await cache.close()
        set_host(None)
    await full_scan_probe()


if __name__ == "__main__":
    asyncio.run(main())
