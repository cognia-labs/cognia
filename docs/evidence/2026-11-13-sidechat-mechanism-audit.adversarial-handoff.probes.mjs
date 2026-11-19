/**
 * Controlled SideChat handoff/entry falsification probes.
 * Run from the repository root: node <path-to-this-runner>
 * All generated fixtures, config and logs stay under .cache/.
 * Provider/sidecar sends are fake seams; no external provider is contacted.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = process.cwd()
const output = resolve(root, ".cache/sidechat-adversarial-handoff")
mkdirSync(output, { recursive: true })
const read = (file) => readFileSync(resolve(root, file), "utf8")
const composerCases =
  '\nimport { dispatchComposerAppend } from "@/lib/chat/composer-append"\nimport { ensureResourceWorkbenchSession } from "@/lib/context-workbench/resource-session"\nimport { useSideChatRequestStore } from "@/stores/chat/side-chat-request-store"\njest.mock("@/lib/context-workbench/resource-session", () => ({\n  ...jest.requireActual("@/lib/context-workbench/resource-session"),\n  ensureResourceWorkbenchSession: jest.fn(async () => { throw new Error("repository unavailable") }),\n}))\nfunction renderProbe(onSend: jest.Mock, id = "ses_42") {\n  const Wrapper = withAdapter(makeAdapter())\n  const tree = (target: string) => <Wrapper><Composer session={mkSession({id:target})} onStartNewSession={async()=>undefined} onOpenSettings={()=>undefined} onSend={onSend} onStop={()=>undefined}/></Wrapper>\n  const view = render(tree(id))\n  return {view, tree, textarea: screen.getByRole("textbox") as HTMLTextAreaElement}\n}\ndescribe("adversarial handoff probes", () => {\n  it("OBSERVED Send to main submits unrelated pre-existing draft along with quote", async () => {\n    const onSend = jest.fn(async()=>undefined)\n    const {textarea} = renderProbe(onSend)\n    await act(async()=>{})\n    fireEvent.change(textarea,{target:{value:"UNFINISHED PRIVATE DRAFT"}})\n    const onSubmitted = jest.fn()\n    await act(async()=>{\n      expect(dispatchComposerAppend({sessionId:"ses_42",text:"> side conclusion\\n\\n",submit:true,onSubmitted})).toBe(true)\n    })\n    await waitFor(()=>expect(onSend).toHaveBeenCalledTimes(1))\n    expect(onSend.mock.calls[0][0]).toBe("UNFINISHED PRIVATE DRAFT > side conclusion\\n\\n")\n    expect(onSubmitted).toHaveBeenCalledWith(true)\n    expect(textarea).toHaveValue("")\n  }, 20000)\n  it("OBSERVED failed handoff reports drafted but loses quote after subsequent typing", async () => {\n    let rejectSend!: (error:Error)=>void\n    const onSend = jest.fn(()=>new Promise<void>((_,reject)=>{rejectSend=reject}))\n    const {textarea} = renderProbe(onSend)\n    await act(async()=>{})\n    const onSubmitted = jest.fn()\n    await act(async()=>{dispatchComposerAppend({sessionId:"ses_42",text:"> UNIQUE SIDE CONCLUSION\\n\\n",submit:true,onSubmitted})})\n    await waitFor(()=>expect(onSend).toHaveBeenCalledTimes(1))\n    expect(textarea).toHaveValue("")\n    fireEvent.change(textarea,{target:{value:"new follow-up typing"}})\n    await act(async()=>rejectSend(new Error("provider refused")))\n    await waitFor(()=>expect(onSubmitted).toHaveBeenCalledWith(false))\n    expect(textarea).toHaveValue("new follow-up typing")\n    expect(useComposerIntentStore.getState().pendingBySession.ses_42).toBeUndefined()\n  }, 20000)\n  it("OBSERVED failed side entry erases question even when no request was enqueued", async () => {\n    useSideChatRequestStore.setState({pending:{}})\n    jest.mocked(ensureResourceWorkbenchSession).mockRejectedValueOnce(new Error("repository unavailable"))\n    const onSend = jest.fn(async()=>undefined)\n    const {textarea} = renderProbe(onSend)\n    await act(async()=>{})\n    fireEvent.change(textarea,{target:{value:"/side keep my question"}})\n    fireEvent.keyDown(textarea,{key:"Enter",code:"Enter"})\n    await waitFor(()=>expect(ensureResourceWorkbenchSession).toHaveBeenCalled())\n    await waitFor(()=>expect(textarea).toHaveValue(""))\n    expect(useSideChatRequestStore.getState().pending).toEqual({})\n    expect(onSend).not.toHaveBeenCalled()\n  }, 20000)\n  it("OBSERVED delayed side entry from A clears matching draft in session B", async () => {\n    let resolveAside!: (value:unknown)=>void\n    jest.mocked(ensureResourceWorkbenchSession).mockImplementationOnce(()=>new Promise(resolve=>{resolveAside=resolve}) as never)\n    const onSend = jest.fn(async()=>undefined)\n    const {textarea,view,tree} = renderProbe(onSend,"session-a")\n    await act(async()=>{})\n    fireEvent.change(textarea,{target:{value:"/side same question"}})\n    const calls = jest.mocked(ensureResourceWorkbenchSession).mock.calls.length\n    fireEvent.keyDown(textarea,{key:"Enter",code:"Enter"})\n    await waitFor(()=>expect(ensureResourceWorkbenchSession).toHaveBeenCalledTimes(calls+1))\n    view.rerender(tree("session-b"))\n    await act(async()=>{})\n    fireEvent.change(screen.getByRole("textbox"),{target:{value:"/side same question"}})\n    await act(async()=>resolveAside({id:"aside-a",kind:"resource-workbench"}))\n    await waitFor(()=>expect(screen.getByRole("textbox")).toHaveValue(""))\n    expect(useSideChatRequestStore.getState().pending["aside-a"][0].question).toBe("same question")\n  },20000)\n})\n'
const controllerCases =
  '\nimport { useSideChatRequestStore } from "@/stores/chat/side-chat-request-store"\nimport { useComposerIntentStore } from "@/stores/chat/composer-intent-store"\nit("OBSERVED actual controller cap refusal fulfills: source-extracted panel consumer loses its claimed question", async()=>{\n  isAtCapacityMock.mockReturnValue(true)\n  useSideChatRequestStore.setState({pending:{}})\n  useComposerIntentStore.setState({pendingBySession:{}})\n  const {result}=renderHook(()=>useClaudeChat())\n  await flush()\n  const sessionId="sess-1"\n  useSideChatRequestStore.getState().enqueue(sessionId,"UNIQUE ACCEPTED QUESTION")\n  const sideChatRequests=useSideChatRequestStore.getState().pending[sessionId]\n  const send=(question:string)=>result.current.send(question,undefined,{sessionId,resourceContext:"parent context"})\n  const t=(key:string)=>key\n  const toast={error:jest.fn()}\n  // Verbatim consumer loop copied from the owning panel by generate-probes.mjs.\n  __PANEL_LOOP__\n  await waitFor(()=>expect(isAtCapacityMock).toHaveBeenCalledWith("ai-turn",sessionId))\n  await flush()\n  expect(useSideChatRequestStore.getState().pending[sessionId]).toEqual([])\n  expect(useComposerIntentStore.getState().pendingBySession[sessionId]).toBeUndefined()\n  expect(chatState.sessions[sessionId].messages).toEqual([])\n  expect(sendPromptMock).not.toHaveBeenCalled()\n  expect(toast.error).not.toHaveBeenCalled()\n})\nit("CONTROL actual controller cap refusal rejects when throwOnError is requested",async()=>{\n  isAtCapacityMock.mockReturnValue(true)\n  const {result}=renderHook(()=>useClaudeChat())\n  await flush()\n  await act(async()=>{\n    await expect(result.current.send("keep question",undefined,{sessionId:"sess-1",throwOnError:true})).rejects.toThrow("concurrent_stream_cap_reached")\n  })\n  expect(sendPromptMock).not.toHaveBeenCalled()\n})\n'

function fixtureBefore(file, anchor, alias) {
  const source = read(file)
  const boundary = source.indexOf(anchor)
  if (boundary < 0) throw new Error(`Fixture anchor drifted in ${file}`)
  return source.slice(0, boundary).replace(/(["'])\.\//g, `$1${alias}`)
}

const composer = fixtureBefore(
  "components/chat/composer.test.tsx",
  'describe("Composer — data-hooks integration"',
  "@/components/chat/"
)
writeFileSync(resolve(output, "composer.probe.test.tsx"), composer + composerCases)

const controller = fixtureBefore(
  "hooks/chat/use-claude-chat.test.ts",
  'describe("useClaudeChat — actions"',
  "@/hooks/chat/"
)
const panel = read("components/context-workbench/resource-workbench-chat-panel.tsx")
const start = panel.indexOf("    for (const pending of sideChatRequests) {")
const end = panel.indexOf("\n  }, [", start)
if (start < 0 || end < 0) throw new Error("Panel consumer loop anchor drifted")
writeFileSync(
  resolve(output, "controller.probe.test.ts"),
  controller + controllerCases.replace("__PANEL_LOOP__", panel.slice(start, end))
)

const config = `
import buildConfig from "../../jest.config.ts"
export default async () => {
  const config = await buildConfig()
  const base = (config.projects as any[])[1]
  return {
    ...config,
    rootDir: process.cwd(),
    projects: [{
      ...base,
      rootDir: process.cwd(),
      testEnvironment: "jsdom",
      roots: ["<rootDir>/.cache/sidechat-adversarial-handoff"],
      testMatch: ["<rootDir>/.cache/sidechat-adversarial-handoff/*.probe.test.{ts,tsx}"],
      testPathIgnorePatterns: ["/node_modules/"],
      modulePathIgnorePatterns: ["/node_modules/"],
      cacheDirectory: "<rootDir>/.cache/sidechat-adversarial-handoff/jest-cache",
    }],
  }
}
`
writeFileSync(resolve(output, "jest.probe.config.ts"), config)

const result = spawnSync(
  "pnpm",
  [
    "test",
    "--config",
    ".cache/sidechat-adversarial-handoff/jest.probe.config.ts",
    "--runInBand",
    "--no-coverage",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
)
const stdout = result.stdout ?? ""
const stderr = result.stderr ?? ""
writeFileSync(resolve(output, "all.probe.log"), stdout + stderr)
process.stdout.write(stdout)
process.stderr.write(stderr)
if (result.error) throw result.error
if (result.signal) throw new Error(`Probe process terminated by ${result.signal}`)
process.exitCode = result.status ?? 1
