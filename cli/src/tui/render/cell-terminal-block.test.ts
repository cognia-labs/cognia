/** @jest-environment node */
import { execFileSync } from "node:child_process"
import {
  cellToTerminalBlock,
  cellRenderRevision,
  markdownSpans,
  TerminalBlockCache,
  VERBATIM_RENDER_PREFS,
} from "./cell-terminal-block"
import { RENDER_DEFAULTS } from "../../config/schema"
import { stringWidth } from "../markdown/width"
import type { Cell, ToolCell } from "../state/types"

function renderRealInkFixture(fixture: string): string {
  const script = `
    import {build} from 'esbuild';
    import {spawnSync} from 'node:child_process';
    import {cliEsbuildOptions} from './scripts/build/esbuild-shared.mjs';
    const options=cliEsbuildOptions({root:process.cwd(),entry:'unused',outdir:process.cwd()+'/cli/src/tui/render',entryNames:'unused',banner:false});
    const built=await build({...options,entryPoints:undefined,stdin:{contents:${JSON.stringify(fixture)},resolveDir:process.cwd(),sourcefile:'real-ink-task-check.tsx',loader:'tsx'},write:false,splitting:false,logLevel:'silent'});
    const child=spawnSync(process.execPath,['--input-type=module'],{cwd:process.cwd()+'/cli',input:built.outputFiles[0].text,encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024,env:{...process.env,CI:'',TERM:'xterm-256color',NO_COLOR:'1'}});
    if(child.status!==0) throw new Error('Real Ink fixture failed: '+child.stderr+'\\n'+child.stdout);
    process.stdout.write(child.stdout);
  `
  return execFileSync(process.execPath, ["--input-type=module"], {
    input: script,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  })
}

it("keeps long live tasks within an 80x12 scrollback frame with real Ink, without clearing or replaying Static", () => {
  const fixture = `
    import React from 'react';
    import {render, Box, Text} from 'ink';
    import {Writable, PassThrough} from 'node:stream';
    import assert from 'node:assert/strict';
    import {TuiViewportFrame} from './cli/src/tui/components/app/TuiViewportFrame';
    import {TranscriptRegion} from './cli/src/tui/components/app/TranscriptRegion';
    import {createInitialState} from './cli/src/tui/state/initial';
    import {DEFAULT_RESOLVED_CONFIG} from './cli/src/config/schema';
    const base = createInitialState({...DEFAULT_RESOLVED_CONFIG, cwd: '/work'}, 'real-ink');
    const history = {id:'history',kind:'assistant',raw:'STATIC_HISTORY_SENTINEL'};
    for (const columns of [80,40]) for (const bottomRows of [3,5]) {
      let output='';
      const stdout = new Writable({write(chunk,encoding,done){output+=chunk.toString();done();}});
      Object.assign(stdout,{isTTY:true,columns,rows:12});
      const stdin = new PassThrough();
      const view = step => {
        const task = {id:'tasks',kind:'todo',todos:Array.from({length:14},(_,index)=>({content:'Task '+index,status:index===0?'in_progress':index<=10?'completed':'pending',activeForm:index===0?'Working '+step+' '+ 'long label '.repeat(20)+'\\nSECOND_LINE':undefined}))};
        const state = {...base,cells:step%2?[history]:[history,task],pendingCells:step%2?[task]:[],inflight:{text:'',thinking:'',tools:[{id:'live-tool',kind:'tool',callKey:'live-tool',toolName:'Bash',input:{command:'INFLIGHT_OUTPUT'},status:'done',collapsed:true}]}};
        return <TuiViewportFrame columns={stdout.columns} rows={stdout.rows} fullscreen={false} overlayOpen={false}
          transcript={<TranscriptRegion state={state} fullscreen={false} banner={null} identity={{}} scroll={{}} scrollContentRef={{current:null}} cursor={{state:{}}} mutedColor='gray' columns={stdout.columns} />}
          overlays={null} bottom={<Box height={bottomRows+(step>=2?1:0)} flexShrink={0}><Text>COMPOSER</Text></Box>} />;
      };
      const app = render(view(0),{stdout,stdin,stderr:new PassThrough(),interactive:true,exitOnCtrlC:false,patchConsole:false,maxFps:1000});
      try {
        for(let step=0;step<4;step++) {
          app.rerender(view(step));
          await app.waitUntilRenderFlush();
          await new Promise(resolve=>setTimeout(resolve,25));
        }
      } finally { app.unmount(); await app.waitUntilExit(); app.cleanup(); }
      assert.equal((output.match(/STATIC_HISTORY_SENTINEL/g)||[]).length,1,'Static replayed after a task update');
      assert.ok(!output.includes('\\u001b[2J')&&!output.includes('\\u001b[3J')&&!output.includes('\\u001bc'),'Ink cleared the terminal');
      assert.ok(output.includes('more')&&output.includes('10/14 done'),'missing collapsed task summary');
      assert.ok(output.includes('COMPOSER')&&output.includes('INFLIGHT_OUTPUT'),'live siblings were lost');
      assert.ok(!output.includes('SECOND_LINE'),'bounded task labels wrapped');
    }
    console.log('real Ink: 80x12 and 40x12, 14 tasks, committed/pending, composer 3/5 rows: no clears or Static replay');
  `
  expect(renderRealInkFixture(fixture)).toContain("no clears or Static replay")
}, 35000)

it("bounds only the live todo list by terminal rows and prioritizes current and next work in real Ink", () => {
  const fixture = `
    import React from 'react';
    import {render, Box, measureElement} from 'ink';
    import {Writable, PassThrough} from 'node:stream';
    import assert from 'node:assert/strict';
    import {Transcript} from './cli/src/tui/components/Transcript';
    for(const rows of [8,12,18,24,60]) {
      let output='';
      const stdout=new Writable({write(chunk,encoding,done){output+=chunk.toString();done();}});
      Object.assign(stdout,{isTTY:true,columns:40,rows});
      const ref=React.createRef();
      const task={id:'tasks',kind:'todo',todos:Array.from({length:100},(_,i)=>({id:String(i),content:'Task '+i,status:i===99?'in_progress':i<10?'completed':'pending',activeForm:i===99?'CURRENT_WORK':undefined}))};
      const app=render(<Box ref={ref} flexDirection='column'><Transcript cells={[task]} columns={40} /></Box>,{stdout,stdin:new PassThrough(),stderr:new PassThrough(),interactive:true,patchConsole:false,exitOnCtrlC:false});
      try {
        await app.waitUntilRenderFlush();
        const height=measureElement(ref.current).height;
        assert.ok(height>=3&&height<=Math.max(3,Math.floor(rows/3)),'todo budget at '+rows+' rows: '+height);
        assert.ok(output.includes('CURRENT_WORK')&&output.includes('more')&&output.includes('10/100 done'),output);
        assert.ok(!output.includes('☑ Task 0'),output);
        if(height>3) {
          assert.ok(output.indexOf('CURRENT_WORK')<output.indexOf('☐ Task 10'),output);
        }
        if(height>4) {
          assert.ok(output.indexOf('☐ Task 10')<output.indexOf('☐ Task 11'),output);
        }
      } finally {app.unmount();await app.waitUntilExit();app.cleanup();}
    }
    console.log('real Ink todo row budgets passed');
  `
  expect(renderRealInkFixture(fixture)).toContain("real Ink todo row budgets passed")
}, 35000)

it("fits live todos around the real composer, output and overlays on tiny terminals and resize without clearing or replaying Static", () => {
  const fixture = `
    import React from 'react';
    import {render, Box, Text, measureElement} from 'ink';
    import {Writable, PassThrough} from 'node:stream';
    import assert from 'node:assert/strict';
    import {TuiViewportFrame} from './cli/src/tui/components/app/TuiViewportFrame';
    import {TranscriptRegion} from './cli/src/tui/components/app/TranscriptRegion';
    import {Input} from './cli/src/tui/components/Input';
    import {createFrameBuffer} from './cli/src/tui/selection/frame-buffer';
    import {createInitialState} from './cli/src/tui/state/initial';
    import {DEFAULT_RESOLVED_CONFIG} from './cli/src/config/schema';
    const initial=createInitialState({...DEFAULT_RESOLVED_CONFIG,cwd:'/work'},'tiny-live-todos');
    const history={id:'history',kind:'assistant',raw:'STATIC_TINY_TODO_SENTINEL'};
    for(const size of [5,6,7,8,9,10,24]) for(const extras of [false,true]) {
      let output='';
      const stdout=new Writable({write(chunk,encoding,done){output+=chunk.toString();done();}});
      Object.assign(stdout,{isTTY:true,columns:40,rows:size});
      const captured=createFrameBuffer(stdout);
      const stdin=Object.assign(new PassThrough(),{isTTY:true,setRawMode:()=>{},ref:()=>{},unref:()=>{}});
      const frameRef=React.createRef();
      const bottomRef=React.createRef();
      const overlayRef=React.createRef();
      const view=(step,lines=0,showTasks=true)=>{
        const task={id:'todos',kind:'todo',todos:Array.from({length:40},(_,i)=>({id:String(i),content:'Task '+i,status:i===39?'in_progress':i<10?'completed':'pending',activeForm:i===39?'CURRENT '+step:undefined}))};
        const state={...initial,cells:showTasks?[history,task]:[history],inflight:{text:Array.from({length:lines},(_,i)=>'Live line '+(i+1)).join('\\n'),thinking:'',tools:[]}};
        return <Box ref={frameRef} flexDirection='column'><TuiViewportFrame columns={40} rows={stdout.rows} fullscreen={false} overlayOpen={extras}
          transcript={<TranscriptRegion state={state} fullscreen={false} columns={40} banner={null} identity={{}} scroll={{}} scrollContentRef={{current:null}} cursor={{state:{}}} mutedColor='gray' />}
          overlays={<Box ref={overlayRef} flexDirection='column'>{extras&&size>5?<Text>APPROVAL</Text>:null}</Box>}
          bottom={<Box ref={bottomRef} flexDirection='column'>{extras?<Text>STATUS</Text>:null}<Input input={initial.input} dispatch={()=>{}} onSubmit={()=>{}} cwd='/work' width={40} composerRows={2} placeholder='' /></Box>}
        /></Box>;
      };
      const app=render(view(0),{stdout:captured.stdout,stdin,stderr:new PassThrough(),interactive:true,patchConsole:false,exitOnCtrlC:false,maxFps:1000});
      const flush=async()=>{await app.waitUntilRenderFlush();await new Promise(resolve=>setTimeout(resolve,15));};
      try {
        await flush();
        for(let step=1;step<=4;step++) {
          const lines=size>=8&&size!==24&&!extras?step:0;
          if(size===24&&step===2) {stdout.rows=6;stdout.emit('resize');}
          app.rerender(view(step,lines));await flush();
          const withTasks=measureElement(frameRef.current).height;
          const painted=captured.plain().join('\\n');
          app.rerender(view(step,lines,false));await flush();
          const baseline=measureElement(frameRef.current).height;
          const remaining=stdout.rows-1-baseline;
          assert.ok(withTasks<=baseline+Math.max(0,remaining),'todos overflow at '+stdout.rows+' rows: '+withTasks+' vs baseline '+baseline);
          if(remaining<1) assert.equal(withTasks,baseline,'todos must hide when no row remains');
          else if(remaining<=2) {
            assert.equal(withTasks,baseline+1,'tiny todo summary must occupy one row');
            assert.ok(painted.includes('CURRENT '+step)&&painted.includes('10/40'),painted);
          }
          app.rerender(view(step,lines));await flush();
        }
      } finally {app.unmount();await app.waitUntilExit();app.cleanup();}
      const esc=String.fromCharCode(27);
      assert.ok(!output.includes(esc+'[2J')&&!output.includes(esc+'[3J')&&!output.includes(esc+'c'),'clear at '+size+' rows, extras='+extras+' '+JSON.stringify(output));
      assert.equal((output.match(/STATIC_TINY_TODO_SENTINEL/g)||[]).length,1,'Static replay at '+size+' rows, extras='+extras);
    }
    console.log('real Ink tiny terminal, growing output and resize budgets passed');
  `
  expect(renderRealInkFixture(fixture)).toContain(
    "real Ink tiny terminal, growing output and resize budgets passed"
  )
}, 35000)

it.each(["stream", "tool", "workflow", "slash", "approval", "task-error"])(
  "preserves scrollback %s content with real Ink on a short terminal",
  (scenario) => {
    const fixture = `
      import React from 'react';
      import {render, renderToString, Box, Text} from 'ink';
      import {Writable, PassThrough} from 'node:stream';
      import assert from 'node:assert/strict';
      import {TuiViewportFrame} from './cli/src/tui/components/app/TuiViewportFrame';
      import {TranscriptRegion} from './cli/src/tui/components/app/TranscriptRegion';
      import {Input} from './cli/src/tui/components/Input';
      import {bufferFromText} from './cli/src/tui/input/buffer';
      import {tuiReducer} from './cli/src/tui/state/reducer';
      import {createInitialState} from './cli/src/tui/state/initial';
      import {DEFAULT_RESOLVED_CONFIG} from './cli/src/config/schema';
      const scenario=${JSON.stringify(scenario)};
      const rows=scenario==='slash'?9:scenario==='workflow'||scenario==='approval'?8:12;
      const initial=createInitialState({...DEFAULT_RESOLVED_CONFIG,cwd:'/work'},'real-layout');
      const base={...initial,cells:[{id:'user',kind:'user',text:'QUESTION'}]};
      const text=value=><Text>{value}</Text>;
      const region=state=><TranscriptRegion state={state} fullscreen={false} banner={null} identity={{}} scroll={{}} scrollContentRef={{current:null}} cursor={{state:{}}} mutedColor='gray' columns={40} />;
      const frame=(state,bottom=text('COMPOSER'),overlays=null)=><TuiViewportFrame columns={40} rows={rows} fullscreen={false} overlayOpen={!!overlays} transcript={region(state)} overlays={overlays} bottom={bottom} />;
      if(scenario==='stream') {
        let output='';
        const stdout=new Writable({write(chunk,encoding,done){output+=chunk.toString();done();}});
        Object.assign(stdout,{isTTY:true,columns:40,rows});
        const view=count=>frame({...base,inflight:{text:Array.from({length:count},(_,i)=>'Paragraph '+(i+1)).join('\\n\\n'),thinking:'',tools:[]}});
        const app=render(view(5),{stdout,stdin:new PassThrough(),stderr:new PassThrough(),interactive:true,patchConsole:false,exitOnCtrlC:false,maxFps:1000});
        try {
          await app.waitUntilRenderFlush();
          output='';
          app.rerender(view(20)); await app.waitUntilRenderFlush();
          await new Promise(resolve=>setTimeout(resolve,25));
          assert.ok(output.includes('Paragraph 20'),'newest streaming paragraph was clipped: '+output);
          assert.ok(output.includes('COMPOSER'),'composer was clipped');
        } finally {app.unmount();await app.waitUntilExit();app.cleanup();}
      } else if(scenario==='tool') {
        const state={...base,inflight:{text:'',thinking:'',tools:[{id:'run',kind:'tool',callKey:'run',toolName:'Bash',input:{command:'example'},status:'running',collapsed:false,result:Array.from({length:25},(_,i)=>'Output line '+(i+1)).join('\\n')}]}};
        const output=renderToString(frame(state),{columns:40});
        assert.ok(output.includes('Output line 25'),output);
        assert.ok(output.includes('COMPOSER'),output);
      } else if(scenario==='workflow') {
        const state={...base,workflowRun:{completed:5,currentId:'5',steps:Array.from({length:8},(_,i)=>({id:String(i),label:'Step '+i,status:i<5?'succeeded':i===5?'running':'pending',lastStreamDelta:i===5?'RUNNING_STEP':undefined}))}};
        const output=renderToString(frame(state),{columns:40});
        assert.ok(output.includes('RUNNING_STEP'),output);
        assert.ok(output.includes('COMPOSER'),output);
      } else if(scenario==='slash') {
        const input={...base.input,buffer:bufferFromText('/')};
        const bottom=<Input input={input} dispatch={()=>{}} onSubmit={()=>{}} cwd='/work' width={40} popupRows={3} composerRows={2} />;
        const output=renderToString(frame(base,bottom),{columns:40});
        assert.ok(output.includes('Search: all commands'),'slash palette was not open: '+output);
        assert.ok(output.includes('› /█'),'composer text or cursor was clipped: '+output);
      } else if(scenario==='approval') {
        for(const height of [8,9]) {
          const overlays=<Box flexDirection='column'>{Array.from({length:8},(_,i)=><Text key={i}>APPROVAL {i}</Text>)}</Box>;
          const output=renderToString(<TuiViewportFrame columns={40} rows={height} fullscreen={false} overlayOpen transcript={region(base)} overlays={overlays} bottom={text('Waiting for approval')} />,{columns:40});
          assert.ok(output.includes('Waiting for approval'),output);
        }
      } else {
        let state=tuiReducer(base,{type:'TOOL_CALL',callKey:'bad',toolName:'TaskUpdate',input:{taskId:'404',status:'completed'}});
        state=tuiReducer(state,{type:'TOOL_RESULT',callKey:'bad',toolName:'TaskUpdate',result:'task 404 not found',isError:true});
        for(const committed of [false,true]) {
          if(committed) state=tuiReducer(state,{type:'TURN_COMMIT',result:{text:'',messageId:'m',a2uiSurfaces:{},a2uiSurfaceOrder:[]}});
          const output=renderToString(frame(state),{columns:40});
          assert.ok(output.includes('task 404 not found'),output);
        }
      }
      console.log('real Ink '+scenario+' passed');
    `
    expect(renderRealInkFixture(fixture)).toContain(`real Ink ${scenario} passed`)
  },
  35000
)

describe("cellToTerminalBlock", () => {
  it.each([
    ["en", "Todos"],
    ["zh-CN", "任务列表"],
  ] as const)(
    "renders localized tasks, activeForm, and distinct skipped marks (%s)",
    (locale, heading) => {
      const block = cellToTerminalBlock(
        {
          id: "tasks",
          kind: "todo",
          todos: [
            { content: "Build", activeForm: "Building", status: "in_progress" },
            { content: "Ship", status: "skipped" },
            { content: "Done", status: "completed" },
            { content: "Wait", status: "pending" },
          ],
        },
        { width: 80, verbose: false, locale }
      )
      expect(block.plainText).toContain(heading)
      expect(block.plainText).toContain("▣ Building")
      expect(block.plainText).not.toContain("▣ Build\n")
      expect(block.plainText).toContain("⊘ Ship")
      expect(block.plainText).toContain("☑ Done")
      expect(block.plainText).toContain("☐ Wait")
    }
  )
  it("renders image attachments inline with separate targets and retains original export text", () => {
    const cell: Cell = { id: "images", kind: "user", text: '中文 @"/Screen Shot.png" then @/b.png' }
    const block = cellToTerminalBlock(cell, { width: 12, verbose: false })
    expect(block.plainText).toBe("› 中文 [Image 1] then [Image 2]\n")
    const spans = block.lines.flatMap((line) => line.spans).filter((span) => span.attachmentPath)
    expect(
      spans
        .filter((span) => span.attachmentPath === "/Screen Shot.png")
        .map((span) => span.text)
        .join("")
    ).toBe("[Image 1]")
    expect(spans.some((span) => span.attachmentPath === "/b.png")).toBe(true)
    expect(
      cellToTerminalBlock(cell, { width: 80, verbose: false, prefs: VERBATIM_RENDER_PREFS })
        .plainText
    ).toBe(`› ${cell.text}\n`)
  })
  it("keeps markdown structure and copy text available at narrow widths", () => {
    const cell: Cell = {
      id: "a1",
      kind: "assistant",
      raw: "# Heading\n\n- [x] done\n- [ ] todo\n\n> quote\n\n| A | B |\n| - | - |\n| 你 | 🚀 |",
    }
    const block = cellToTerminalBlock(cell, { width: 20, verbose: false })
    expect(block.plainText).toContain("# Heading")
    expect(block.plainText).toContain("☑ done")
    expect(block.plainText).toContain("│ quote")
    expect(block.plainText).toContain("│ A  │ B  │")
    expect(block.rowCount).toBe(block.lines.length)
  })

  // This renderer paints the DEFAULT (fullscreen, virtualized) layout, so an
  // unaligned table here is the table the user actually sees. It used to join
  // cells with a bare " │ " and rule the header with a code-unit count, which
  // meant no column lined up and a CJK header got a half-width rule.
  it("frames a table and aligns its columns in display width", () => {
    const cell: Cell = {
      id: "t1",
      kind: "assistant",
      raw: ["| Model | Note |", "| --- | --- |", "| 模型 | ok |", "| claude | fine |"].join("\n"),
    }
    const rows = cellToTerminalBlock(cell, { width: 80, verbose: false }).plainText.split("\n")
    const framed = rows.filter((row) => row.startsWith("╭") || row.startsWith("│"))
    expect(framed[0]).toBe("╭────────┬──────╮")
    expect(framed[1]).toBe("│ Model  │ Note │")
    // "模型" is 4 display columns, so it is padded by 4 to the 6-wide column and
    // the next edge still lands under the header's.
    expect(framed).toContain("│ 模型   │ ok   │")
    for (const row of framed) expect(row.length > 0).toBe(true)
  })

  it("truncates a table's columns to the terminal instead of wrapping them", () => {
    const cell: Cell = {
      id: "t2",
      kind: "assistant",
      raw: [
        "| Command | Description |",
        "| --- | --- |",
        "| /backend | switch the agent backend for this session |",
      ].join("\n"),
    }
    const block = cellToTerminalBlock(cell, { width: 28, verbose: false })
    const framed = block.plainText.split("\n").filter((row) => row.startsWith("│"))
    for (const row of framed) expect(row.length).toBeLessThanOrEqual(28)
    expect(block.plainText).toContain("…")
  })

  it("never drops a supported content part", () => {
    const parts: Cell[] = [
      {
        id: "sources",
        kind: "content-part",
        partId: "sources",
        part: { type: "sources", sources: [{ id: "s", title: "Ink", url: "https://ink.test" }] },
      },
      {
        id: "a2ui",
        kind: "content-part",
        partId: "a2ui",
        part: { type: "a2ui", surfaceId: "surface", source: "external", payload: {} },
      },
      {
        id: "custom",
        kind: "content-part",
        partId: "custom",
        part: { type: "custom", customType: "plugin.card", summary: "Fallback" },
      },
    ]
    for (const cell of parts) {
      expect(cellToTerminalBlock(cell, { width: 40, verbose: false }).plainText.trim()).not.toBe("")
    }
  })

  it("shows expanded tool output only in verbose mode", () => {
    const cell: Cell = {
      id: "t",
      kind: "tool",
      callKey: "t",
      toolName: "git_show",
      input: { path: "a.txt" },
      status: "done",
      result: "VISIBLE\nSECRET",
      collapsed: true,
    }
    const collapsed = cellToTerminalBlock(cell, { width: 80, verbose: false }).plainText
    expect(collapsed).toContain("↳ VISIBLE")
    expect(collapsed).not.toContain("SECRET")
    expect(cellToTerminalBlock(cell, { width: 80, verbose: true }).plainText).toContain("SECRET")
  })

  it("styles a tool header: status, disclosure, glyph, label and result chip", () => {
    const cell: Cell = {
      id: "t",
      kind: "tool",
      callKey: "t",
      toolName: "grep",
      input: { pattern: "foo" },
      status: "done",
      result: "a.ts:1:foo\nb.ts:2:foo",
      collapsed: true,
    }
    const block = cellToTerminalBlock(cell, { width: 120, verbose: false })
    const header = block.lines[0]
    expect(header.plain).toContain("✓")
    expect(header.plain).toContain("▸")
    expect(header.plain).toContain("⌕")
    expect(header.plain).toContain("Grep foo")
    expect(header.plain).toContain("2 matches")
    // The status glyph is green, the chip is dim: one row, several styles.
    expect(header.spans[0]).toMatchObject({ text: "✓ ", style: "success" })
    expect(header.spans.some((span) => span.style === "muted")).toBe(true)
    expect(header.spans.some((span) => span.bold)).toBe(true)
  })

  it("colours a diff's sign column and indents the body under a rule", () => {
    const cell: Cell = {
      id: "e",
      kind: "tool",
      callKey: "e",
      toolName: "edit",
      input: { file_path: "/a.ts", old_string: "before", new_string: "after" },
      status: "running",
      collapsed: true,
    }
    const block = cellToTerminalBlock(cell, { width: 120, verbose: false })
    expect(block.plainText).toContain("+1 -1")
    const added = block.lines.find((line) => line.plain.includes("+ after"))
    const removed = block.lines.find((line) => line.plain.includes("- before"))
    expect(added?.spans.some((span) => span.style === "success")).toBe(true)
    expect(removed?.spans.some((span) => span.style === "danger")).toBe(true)
    expect(added?.plain.startsWith("  │ ")).toBe(true)
  })

  it("tail-truncates a large diff with a muted marker, keeping the newest lines", () => {
    const content = Array.from({ length: 80 }, (_, i) => `line${i}`).join("\n")
    const cell: Cell = {
      id: "w",
      kind: "tool",
      callKey: "w",
      toolName: "write",
      input: { file_path: "/big.ts", content },
      status: "done",
      collapsed: true,
    }
    const block = cellToTerminalBlock(cell, { width: 120, verbose: false })
    expect(block.plainText).toContain("⋯ 30 earlier lines truncated")
    expect(block.plainText).toContain("line79")
    expect(block.plainText).not.toContain("+ line29")
  })

  it("renders a settled read-only shell command as a compact title-only card", () => {
    const block = cellToTerminalBlock(
      {
        id: "c",
        kind: "tool",
        callKey: "c",
        toolName: "bash",
        input: { command: "git status" },
        status: "done",
        result: "nothing to commit",
        collapsed: true,
      },
      { width: 120, verbose: false }
    )
    expect(block.plainText).toContain("git status")
    expect(block.plainText).not.toContain("↳")
    // Expansion still reveals the output.
    const verbose = cellToTerminalBlock(
      {
        id: "c",
        kind: "tool",
        callKey: "c",
        toolName: "bash",
        input: { command: "git status" },
        status: "done",
        result: "nothing to commit",
        collapsed: true,
      },
      { width: 120, verbose: true }
    )
    expect(verbose.plainText).toContain("nothing to commit")
  })

  it("puts a failure on its own detail row, not in the header chip", () => {
    const cell: Cell = {
      id: "f",
      kind: "tool",
      callKey: "f",
      toolName: "bash",
      input: { command: "false" },
      status: "error",
      isError: true,
      result: "Error: command failed\nstack frame",
      collapsed: true,
    }
    const block = cellToTerminalBlock(cell, { width: 120, verbose: false })
    expect(block.lines[0].plain).not.toContain("Error: command failed")
    expect(block.plainText).toContain("↳ Error: command failed")
    expect(block.plainText).not.toContain("stack frame")
  })

  it("frames a sub-agent dispatch as a delegated agent, not a tool card", () => {
    const cell: Cell = {
      id: "s",
      kind: "tool",
      callKey: "s",
      toolName: "task",
      input: { subagent_type: "reviewer", prompt: "review the diff" },
      status: "done",
      result: "looks good",
      collapsed: true,
    }
    const block = cellToTerminalBlock(cell, { width: 120, verbose: false })
    expect(block.lines[0].plain).toContain("◆ reviewer")
    expect(block.lines[0].plain).toContain("subagent · done")
    expect(block.plainText).toContain("review the diff")
    expect(block.plainText).toContain("↳ looks good")
  })

  it("tints markdown structure instead of painting a whole reply one colour", () => {
    const block = cellToTerminalBlock(
      { id: "a", kind: "assistant", raw: "# Title\n\nsee `code` and [docs](https://x.test)" },
      { width: 120, verbose: false }
    )
    const heading = block.lines.find((line) => line.plain.includes("Title"))
    expect(heading?.spans.every((span) => span.style === "accent")).toBe(true)
    const body = block.lines.find((line) => line.plain.includes("code"))
    expect(body?.spans.some((span) => span.style === "code")).toBe(true)
    expect(body?.spans.some((span) => span.style === "accent" && span.underline)).toBe(true)
  })

  it("honours the transcript render preferences the Ink cards already obeyed", () => {
    const cell: Cell = {
      id: "r",
      kind: "tool",
      callKey: "r",
      toolName: "read",
      input: { file_path: "demo.ts" },
      status: "done",
      collapsed: false,
      result: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"),
    }
    const numbered = cellToTerminalBlock(cell, {
      width: 80,
      verbose: false,
      prefs: { ...RENDER_DEFAULTS, toolResultMaxLines: 3 },
    })
    expect(numbered.plainText).toContain("1 │ line 1")
    expect(numbered.plainText).toContain("+9 more lines hidden")
    expect(numbered.plainText).not.toContain("line 12")

    const plain = cellToTerminalBlock(cell, {
      width: 80,
      verbose: false,
      prefs: { ...RENDER_DEFAULTS, fileLineNumbers: false },
    })
    expect(plain.plainText).toContain("line 1")
    expect(plain.plainText).not.toContain("1 │ line 1")
  })

  it("redirects an oversized result to the pager instead of flooding the viewport", () => {
    const cell: Cell = {
      id: "big",
      kind: "tool",
      callKey: "big",
      toolName: "bash",
      input: { command: "cat huge.log" },
      status: "done",
      collapsed: false,
      result: Array.from({ length: 400 }, (_, i) => `row ${i}`).join("\n"),
    }
    const block = cellToTerminalBlock(cell, { width: 80, verbose: false, prefs: RENDER_DEFAULTS })
    expect(block.plainText).toContain("400 lines total")
    expect(block.plainText).toContain("/expand")
    expect(block.rowCount).toBeLessThan(30)
  })

  it("renders verbatim for the pager: no cap, no gutter", () => {
    const cell: Cell = {
      id: "v",
      kind: "tool",
      callKey: "v",
      toolName: "read",
      input: { file_path: "demo.ts" },
      status: "done",
      collapsed: false,
      result: Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\n"),
    }
    const block = cellToTerminalBlock(cell, {
      width: 80,
      verbose: true,
      prefs: VERBATIM_RENDER_PREFS,
    })
    expect(block.plainText).toContain("row 299")
    expect(block.plainText).not.toContain("/expand")
    expect(block.plainText).not.toContain("1 │ ")
  })

  it("keeps streaming and extended fence fallbacks copyable and safe", () => {
    const raw = [
      "Nested:",
      "- outer",
      "  - inner",
      "",
      "[docs](https://example.test) ![diagram](https://example.test/a.png)",
      "",
      "<script>not executed</script>",
      "",
      "```mermaid",
      "graph TD; A-->B",
      "```",
      "```math",
      "x^2 + y^2",
      "```",
      "```a2ui",
      '{"rootId":"root"}',
      "```",
      "unfinished **stream\u001b[2J",
    ].join("\n")
    for (const width of [20, 40, 80, 160]) {
      const block = cellToTerminalBlock(
        { id: `golden-${width}`, kind: "assistant", raw },
        { width, verbose: false }
      )
      expect(block.plainText).toContain("outer")
      expect(block.plainText).toContain("inner")
      expect(block.plainText).toContain("graph TD; A-->B")
      expect(block.plainText).toContain("x^2 + y^2")
      expect(block.plainText).toContain("rootId")
      expect(block.plainText).toContain("not executed")
      expect(block.plainText).not.toContain("\u001b")
      expect(block.lines.every((line) => line.plain.length === 0 || line.spans.length > 0)).toBe(
        true
      )
    }
  })
})

describe("TerminalBlockCache", () => {
  it("does not serialize hidden task history in a render revision", () => {
    const cell: Cell = {
      id: "tasks",
      kind: "todo",
      todos: [{ content: "Build", activeForm: "Building", status: "in_progress" }],
    }
    const history: ToolCell = {
      id: "hidden",
      kind: "tool",
      callKey: "hidden",
      toolName: "TaskList",
      status: "done",
      collapsed: true,
      input: {},
      result: {
        toJSON() {
          throw new Error("History must not be serialized")
        },
      },
    }
    expect(cellRenderRevision({ ...cell, toolCalls: [history] })).toBe(cellRenderRevision(cell))
    expect(
      cellRenderRevision({
        ...cell,
        todos: [{ content: "Build", activeForm: "Testing", status: "in_progress" }],
      })
    ).not.toBe(cellRenderRevision(cell))
  })

  it("retains only the newest revision and render options for each cell id", () => {
    const cache = new TerminalBlockCache()
    const build = jest.fn(() =>
      cellToTerminalBlock({ id: "tasks", kind: "todo", todos: [] }, { width: 80, verbose: false })
    )
    for (let index = 0; index < 500; index++) {
      cache.get(
        {
          id: "tasks",
          width: 40 + index,
          theme: `theme-${index}`,
          preferences: "compact",
          revision: `revision-${index}`,
        },
        build
      )
    }
    expect(cache.stats().size).toBe(1)
    cache.get(
      { id: "assistant", width: 80, theme: "dark", preferences: "compact", revision: "first" },
      build
    )
    cache.get(
      { id: "assistant", width: 80, theme: "dark", preferences: "compact", revision: "second" },
      build
    )
    expect(cache.stats().size).toBe(2)
    cache.retain(["assistant"])
    expect(cache.stats().size).toBe(1)
  })
  it("keys entries by id, width, theme, preferences, and revision", () => {
    const cache = new TerminalBlockCache()
    const build = jest.fn(() =>
      cellToTerminalBlock({ id: "n", kind: "notice", message: "x" }, { width: 40, verbose: false })
    )
    const key = { id: "n", width: 40, theme: "dark", preferences: "compact", revision: "x" }
    expect(cache.get(key, build)).toBe(cache.get(key, build))
    expect(build).toHaveBeenCalledTimes(1)
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, size: 1, hitRate: 0.5 })
    cache.get({ ...key, width: 80 }, build)
    expect(build).toHaveBeenCalledTimes(2)
  })
})

describe("rich fullscreen Markdown", () => {
  it("exports styled document spans with link footnotes, rules, and unbounded nested blocks", () => {
    const raw =
      "#### Heading \u0060code\u0060\n\n> **bold** _italic_ [link](https://x.test)\n\n- item\n\n  continuation\n\n| [Header](./header) | B |\n| --- | --- |\n| [body](./body) | value |\n\n---\n\n~~~diff\n-old\n+new\n~~~"
    const spans = markdownSpans(raw, true)
    const text = spans.map((span) => span.text).join("")
    expect(text).toContain("[1] ./header")
    expect(text).toContain("[2] ./body")
    expect(text).toContain("─".repeat(24))
    expect(text).toContain("    continuation")
    expect(spans.some((span) => span.bold && span.text === "bold")).toBe(true)
    expect(spans.some((span) => span.italic && span.text === "italic")).toBe(true)
    expect(text).toContain("+new")
  })

  it("preserves nested blocks, image targets, and narrow table contents", () => {
    const raw =
      "- first\n\n  continued\n\n  > - [x] checked\n  >\n  > ~~~diff file.patch\n  > -old\n  > +new\n  > ~~~\n\n| A | B |\n| --- | --- |\n| alpha | beta |\n\n![map](./map.png)"
    const block = cellToTerminalBlock(
      { id: "rich", kind: "assistant", raw },
      { width: 80, verbose: false }
    )
    for (const part of [
      "continued",
      "☑ checked",
      "╭─ diff",
      "-old",
      "+new",
      "alpha",
      "beta",
      "[image: map] (./map.png)",
    ])
      expect(block.plainText).toContain(part)
    const narrow = cellToTerminalBlock(
      { id: "narrow", kind: "assistant", raw },
      { width: 10, verbose: false }
    )
    expect(narrow.plainText).toContain("A: alpha")
    expect(narrow.plainText).toContain("B: beta")
    expect(narrow.lines.every((line) => line.plain.length <= 10)).toBe(true)
  })

  it("keeps hard breaks and strips entity-encoded controls throughout streaming", () => {
    const raw = "one  \ntwo\n\n> ~~~diff\n> +new\n> ~~~\n\n&#27;[2J &#1114112;"
    for (let i = 0; i <= raw.length; i++) {
      const block = cellToTerminalBlock(
        { id: "stream", kind: "assistant", raw: raw.slice(0, i) },
        { width: 20, verbose: false }
      )
      expect(block.plainText).not.toContain("\u001b")
    }
    const block = cellToTerminalBlock(
      { id: "final", kind: "assistant", raw },
      { width: 20, verbose: false }
    )
    expect(block.plainText).toContain("one\ntwo")
    expect(block.plainText).toContain("�")
  })

  it("keeps wrapped tasks and quotes under their gutters in physical rows", () => {
    const block = cellToTerminalBlock(
      {
        id: "hang",
        kind: "assistant",
        raw: "- [x] abcdefghijklmnop\n\n  continuation\n\n> abcdefghijklmnop",
      },
      { width: 12, verbose: false }
    )
    expect(block.plainText).not.toContain("[x]")
    expect(block.plainText).toContain("  ☑ abcdefgh\n    ijklmnop")
    expect(block.plainText).toContain("│ abcdefghij\n│ klmnop")
    expect(block.lines[0].spans[0].style).toBe("success")
    expect(
      markdownSpans("> - task\n>\n> ~~~\n> code\n> ~~~")
        .map((span) => span.text)
        .join("")
    ).toContain("│   • task")
  })
})

describe("fullscreen tool readability", () => {
  const tool = (overrides: Partial<ToolCell> = {}): ToolCell => ({
    id: "readable",
    kind: "tool",
    callKey: "readable",
    toolName: "bash",
    input: { command: "pnpm test" },
    status: "done",
    collapsed: false,
    ...overrides,
  })

  it.each([20, 32, 80])(
    "bounds structured previews and retains readable action/output at width %s",
    (width) => {
      const cell = tool({
        result: { exit_code: 0, stdout: "passed\n" + "界".repeat(400), files: ["a.ts", "b.ts"] },
      })
      const block = cellToTerminalBlock(cell, { width, verbose: false })
      expect(block.plainText).toContain("Exit code:")
      expect(block.plainText).toContain("Stdout:")
      expect(block.plainText).not.toContain('"exit_code"')
      expect(block.plainText).toContain("/expand")
      expect(block.lines.every((line) => stringWidth(line.plain) <= width)).toBe(true)
      expect(block.rowCount).toBeLessThan(20)
      expect(
        block.lines
          .flatMap((line) => line.spans)
          .filter((span) => span.text.includes("pnpm test"))
          .every((span) => span.style === "plain")
      ).toBe(true)
      expect(
        block.lines
          .flatMap((line) => line.spans)
          .some((span) => span.text.includes("Exit code:") && span.style === "plain")
      ).toBe(true)
    }
  )

  it("preserves full source and object fields for the explicit verbatim pager", () => {
    const value = "x".repeat(500)
    const block = cellToTerminalBlock(tool({ result: { stdout: value, exit_code: 0 } }), {
      width: 20,
      verbose: true,
      prefs: VERBATIM_RENDER_PREFS,
    })
    expect(block.plainText).toContain('"stdout"')
    expect(block.plainText).toContain(value)
    expect(block.plainText).not.toContain("/expand")
  })

  it("keeps array text blocks readable and image bodies elided", () => {
    const block = cellToTerminalBlock(
      tool({
        result: {
          content: [
            { type: "text", text: "first\nsecond" },
            { type: "image", mimeType: "image/png", data: "A".repeat(2000) },
          ],
        },
      }),
      { width: 80, verbose: false }
    )
    expect(block.plainText).toContain("first")
    expect(block.plainText).toContain("second")
    expect(block.plainText).toContain("<image>")
    expect(block.plainText).not.toContain("A".repeat(100))
  })

  it("uses the same bounded body for delegated results and honors disabled gutters", () => {
    const block = cellToTerminalBlock(
      tool({ toolName: "task", input: { description: "review" }, result: { status: "complete" } }),
      {
        width: 32,
        verbose: true,
        prefs: { ...RENDER_DEFAULTS, fileLineNumbers: false, toolResultMaxLines: 0 },
      }
    )
    expect(block.plainText).toContain("Status: complete")
    expect(block.plainText).not.toContain("1 │")
  })

  it("keeps empty and unavailable results safe", () => {
    const empty = cellToTerminalBlock(tool({ result: "" }), { width: 32, verbose: true })
    expect(empty.plainText).not.toContain("/expand")
    const result = Object.defineProperty({}, "bad", {
      enumerable: true,
      get() {
        throw new Error("unavailable")
      },
    })
    const unavailable = cellToTerminalBlock(tool({ result }), { width: 80, verbose: true })
    expect(unavailable.plainText).toContain("[unavailable tool result]")
  })

  it("keeps completed command output at normal contrast", () => {
    // A non-read-only command keeps its collapsed `↳` preview row — read-only
    // ones compact to a title-only card instead.
    const block = cellToTerminalBlock(
      tool({ input: { command: "mv a b" }, result: "working tree clean", collapsed: true }),
      { width: 80, verbose: false }
    )
    expect(
      block.lines
        .flatMap((line) => line.spans)
        .some((span) => span.text.includes("working tree clean") && span.style === "plain")
    ).toBe(true)
  })
})

describe("fullscreen tool lifecycle boundaries", () => {
  const tool = (overrides: Partial<ToolCell>): ToolCell => ({
    id: "lifecycle",
    kind: "tool",
    callKey: "lifecycle",
    toolName: "bash",
    input: {},
    status: "done",
    collapsed: true,
    ...overrides,
  })
  it("retains namespace, title and cancellation when no result body exists", () => {
    const block = cellToTerminalBlock(
      tool({ toolName: "mcp__fs__read", displayTitle: "Inspect source", status: "cancelled" }),
      { width: 80, verbose: false }
    )
    expect(block.plainText).toContain("[mcp]")
    expect(block.plainText).toContain("Inspect source")
    expect(block.plainText).toContain("stopped")
    expect(block.plainText).not.toContain("▸")
  })
  it("does not invent previews for running, empty or user-cancelled output", () => {
    for (const cell of [
      tool({ status: "running", result: "partial" }),
      tool({ result: "" }),
      tool({ status: "cancelled", result: "Cancelled by user." }),
    ]) {
      const block = cellToTerminalBlock(cell, { width: 80, verbose: false })
      expect(block.plainText).not.toContain("↳")
      expect(block.plainText).not.toContain("Cancelled by user.")
    }
  })
  it("keeps cancelled delegated work distinct from expanded successful replies", () => {
    const block = cellToTerminalBlock(
      tool({ toolName: "task", status: "cancelled", result: "Cancelled by user." }),
      { width: 80, verbose: true }
    )
    expect(block.plainText).toContain("stopped")
    expect(block.plainText).not.toContain("▾")
  })
})
