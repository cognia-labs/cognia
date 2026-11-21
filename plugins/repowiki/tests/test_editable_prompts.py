"""The prompts' system wording as Prompt Center slots (ADR-0236, audit F10).

Three things must hold for an edit to be safe: with no edit the model sees
exactly upstream's text; an edit replaces only the wording, never the protocol
sentences a parser relies on or the language instruction; and a failed read of
the user's edit fails the call instead of quietly sending the shipped text.
"""

from __future__ import annotations

import pytest

from repowiki import host as host_module
from repowiki.host import (
    PROMPT_MAX_CHARS,
    HostBridge,
    HostUnavailableError,
    LLMClient,
    LLMError,
    forget_registered_prompts,
    prompt_declarations,
    prompt_label_keys,
    register_prompts,
    set_host,
)
from repowiki.llm.prompts import (
    EDITABLE_PROMPTS,
    build_architecture_prompt,
    build_chat_prompt,
    build_codemap_enrich_prompt,
    build_codemap_skeleton_prompt,
    build_deep_research_prompt,
    build_module_prompt,
    build_overview_prompt,
    build_query_expansion_prompt,
    build_reading_guide_prompt,
    build_repair_prompt,
    compose_system,
)

#: Every builder, called the way the analyzer and the tools call it.
BUILDERS = {
    "overview": lambda lang: build_overview_prompt("tree", "keys", lang),
    "module": lambda lang: build_module_prompt("core", "files", "summary", lang),
    "architecture": lambda lang: build_architecture_prompt("tree", "mods", lang),
    "reading-guide": lambda lang: build_reading_guide_prompt("ranks", "mods", lang),
    "chat": lambda lang: build_chat_prompt("q", "ctx", lang),
    "query-expansion": lambda lang: build_query_expansion_prompt("q", lang),
    "deep-research": lambda lang: build_deep_research_prompt("q", "ctx", 1, 3, lang),
    "codemap-skeleton": lambda lang: build_codemap_skeleton_prompt("q", "ctx", lang),
    "codemap-enrich": lambda lang: build_codemap_enrich_prompt("{}", "ctx", lang),
}


class PromptHost(HostBridge):
    """Records registrations, resolutions and the system text a run was sent."""

    def __init__(self, *, overrides=None, resolve_raises=None, register_answer=None):
        self.overrides = overrides or {}
        self.resolve_raises = resolve_raises
        self.register_answer = register_answer
        self.declarations: list[dict] | None = None
        self.resolved: list[str] = []
        self.systems: list[str] = []
        self.prompts: list[str] = []

    async def prompts_register(self, declarations):
        self.declarations = declarations
        if self.register_answer is not None:
            return self.register_answer
        return {
            "promptIds": [f"plugin:cognia-repowiki/{entry['id']}" for entry in declarations]
        }

    async def prompts_resolve(self, prompt_id):
        self.resolved.append(prompt_id)
        if self.resolve_raises:
            raise self.resolve_raises
        if prompt_id in self.overrides:
            return {"text": self.overrides[prompt_id], "source": "override"}
        return {"text": EDITABLE_PROMPTS[prompt_id].default, "source": "default"}

    async def agent_run(self, prompt, options):
        self.prompts.append(prompt)
        self.systems.append(options.get("system") or "")
        return {"text": "ok", "usage": {}}


@pytest.fixture(autouse=True)
def isolate_registration():
    forget_registered_prompts()
    yield
    forget_registered_prompts()
    set_host(None)


# -- the split keeps upstream's text ---------------------------------------


def test_every_builder_names_a_registered_wording_and_sends_it_unchanged():
    assert set(BUILDERS) == set(EDITABLE_PROMPTS)
    for prompt_id, build in BUILDERS.items():
        system = build("zh")[0]
        assert system["role"] == "system"
        assert system["prompt_id"] == prompt_id
        assert system["content"] == compose_system(
            EDITABLE_PROMPTS[prompt_id].default, prompt_id, system["prompt_tail"]
        )


def test_module_wording_keeps_the_line_counting_rule_out_of_reach():
    # The pipeline re-anchors symbol lines on this exact rule (F15); an edit of
    # the wording must not be able to drop it.
    module = EDITABLE_PROMPTS["module"]
    assert "1-based" not in module.default
    assert build_module_prompt("core", "files", "summary", "en")[0]["content"] == (
        "You are a senior engineer documenting your own code. "
        "Be direct and specific. No filler. "
        "Explain what each file does, how files relate to each other, "
        "and what the key functions/classes are. "
        "When you mention a function or class, include the line "
        "number it is defined on (counted from the file's first "
        "non-blank line shown in the snippet, 1-based). "
        "Respond in English."
    )


def test_query_expansion_keeps_its_line_format_and_has_no_language_line():
    system = build_query_expansion_prompt("q")[0]
    assert system["prompt_tail"] == ""
    assert system["content"] == (
        "You rewrite natural-language code questions into search terms for a "
        "lexical code index. Output ONLY the terms — identifiers, filenames, "
        "concepts — one per line, at most 12 lines. No numbering, no "
        "commentary, no full sentences."
    )
    assert EDITABLE_PROMPTS["query-expansion"].localized is False


def test_every_default_keeps_its_required_fragments():
    for prompt in EDITABLE_PROMPTS.values():
        for fragment in prompt.required_fragments:
            assert fragment in prompt.default, (prompt.id, fragment)
        assert len(prompt.default) <= PROMPT_MAX_CHARS


# -- declarations ------------------------------------------------------------


def test_declarations_carry_the_shipped_wording_and_translated_titles():
    labels = {"prompt.chat.title": "向百科提问", "prompt.chat.description": "回答问题的措辞"}
    declarations = {entry["id"]: entry for entry in prompt_declarations(labels)}

    assert list(declarations) == list(EDITABLE_PROMPTS)
    chat = declarations["chat"]
    assert chat["title"] == "向百科提问"
    assert chat["description"] == "回答问题的措辞"
    assert chat["defaultBody"] == EDITABLE_PROMPTS["chat"].default
    assert chat["group"] == "knowledge"
    assert chat["maxChars"] == PROMPT_MAX_CHARS
    # Tool calls carry no session, so a workspace override could never apply.
    assert all(entry["scopes"] == ["account"] for entry in declarations.values())
    assert "requiredFragments" not in chat
    # A missing translation keeps the English title rather than a raw key.
    assert declarations["overview"]["title"] == "Project overview"
    assert declarations["codemap-enrich"]["requiredFragments"] == ["'guide'", "'diagram'"]


def test_output_contracts_name_the_fixed_text_sent_after_the_wording():
    declarations = {entry["id"]: entry for entry in prompt_declarations()}
    assert EDITABLE_PROMPTS["module"].protocol in declarations["module"]["outputContract"]
    assert "language" in declarations["chat"]["outputContract"]
    assert "language" not in declarations["query-expansion"]["outputContract"]


def test_label_keys_cover_every_title_and_description():
    keys = prompt_label_keys()
    assert len(keys) == 2 * len(EDITABLE_PROMPTS)
    assert "prompt.codemap-enrich.description" in keys


# -- registration ------------------------------------------------------------


async def test_registration_returns_the_namespaced_ids():
    fake = PromptHost()
    set_host(fake)
    ids = await register_prompts()
    assert ids == [f"plugin:cognia-repowiki/{prompt_id}" for prompt_id in EDITABLE_PROMPTS]
    assert [entry["id"] for entry in fake.declarations] == list(EDITABLE_PROMPTS)


async def test_a_refused_registration_leaves_every_call_on_the_shipped_wording():
    fake = PromptHost(register_answer={"promptIds": ["only-one"]})
    set_host(fake)
    with pytest.raises(HostUnavailableError):
        await register_prompts()

    await LLMClient().complete(build_chat_prompt("q", "ctx", "en"))
    assert fake.resolved == []
    assert fake.systems == [build_chat_prompt("q", "ctx", "en")[0]["content"]]


# -- resolution --------------------------------------------------------------


async def test_without_a_registration_nothing_is_resolved():
    fake = PromptHost()
    set_host(fake)
    await LLMClient().complete(build_module_prompt("core", "files", "summary", "en"))
    assert fake.resolved == []
    shipped = build_module_prompt("core", "files", "summary", "en")[0]["content"]
    assert fake.systems == [shipped]


async def test_an_override_replaces_only_the_wording():
    fake = PromptHost(overrides={"module": "You write terse module notes for maintainers."})
    set_host(fake)
    await register_prompts()

    await LLMClient().complete(build_module_prompt("core", "files", "summary", "zh"))

    assert fake.resolved == ["module"]
    assert fake.systems == [
        "You write terse module notes for maintainers. "
        + EDITABLE_PROMPTS["module"].protocol
        + " 请用中文回答。"
    ]


async def test_each_call_reads_the_current_text_so_a_new_edit_applies_next():
    fake = PromptHost()
    set_host(fake)
    await register_prompts()
    llm = LLMClient()

    await llm.complete(build_chat_prompt("q", "ctx", "en"))
    fake.overrides["chat"] = "Answer like a code reviewer."
    await llm.complete(build_chat_prompt("q", "ctx", "en"))

    assert fake.resolved == ["chat", "chat"]
    assert fake.systems[0].startswith(EDITABLE_PROMPTS["chat"].default)
    assert fake.systems[1] == "Answer like a code reviewer. Respond in English."


async def test_a_repair_round_resolves_the_same_wording_again():
    fake = PromptHost(overrides={"overview": "Explain it to a new hire."})
    set_host(fake)
    await register_prompts()
    original = build_overview_prompt("tree", "keys", "en")

    await LLMClient().complete(build_repair_prompt(original, "not json", ["name"]))

    assert fake.systems == ["Explain it to a new hire. Respond in English."]


async def test_a_failed_read_fails_the_call_instead_of_sending_the_shipped_text():
    fake = PromptHost(resolve_raises=RuntimeError("snapshot unavailable"))
    set_host(fake)
    await register_prompts()

    with pytest.raises(LLMError, match="prompt resolution failed"):
        await LLMClient().complete(build_chat_prompt("q", "ctx", "en"))
    assert fake.systems == []


async def test_a_malformed_answer_fails_the_call():
    class Malformed(PromptHost):
        async def prompts_resolve(self, prompt_id):
            return {"source": "default"}

    fake = Malformed()
    set_host(fake)
    await register_prompts()

    with pytest.raises(LLMError, match="returned no text"):
        await LLMClient().complete(build_chat_prompt("q", "ctx", "en"))
    assert fake.systems == []


async def test_forgetting_the_registration_returns_to_the_shipped_wording():
    fake = PromptHost(overrides={"chat": "Overridden."})
    set_host(fake)
    await register_prompts()
    forget_registered_prompts()

    await LLMClient().complete(build_chat_prompt("q", "ctx", "en"))
    assert fake.resolved == []
    assert host_module._REGISTERED_PROMPTS == set()
