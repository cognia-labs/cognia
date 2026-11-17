import { render } from "@testing-library/react"

import type { TextInputContext } from "@/components/ai-elements/prompt-input"

import { VoiceTranscriptionBridge } from "./voice-transcription-bridge"

let transcribe: ((text: string) => void) | null = null
const voiceProps = jest.fn()
jest.mock("./voice-controls", () => ({
  VoiceControls: (props: { disabled?: boolean; onTranscription: (text: string) => void }) => {
    voiceProps(props)
    transcribe = props.onTranscription
    return null
  },
}))

function textInputWith(initial: string) {
  let value = initial
  return {
    get value() {
      return value
    },
    setInput: jest.fn((next: string) => {
      value = next
    }),
  } as unknown as TextInputContext
}

beforeEach(() => {
  transcribe = null
  voiceProps.mockClear()
})

it("appends dictated text to the draft with one separating space", () => {
  const textInput = textInputWith("draft")
  render(<VoiceTranscriptionBridge disabled textInput={textInput} />)
  expect(voiceProps).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: true }))

  transcribe?.("hello")
  expect(textInput.value).toBe("draft hello")

  transcribe?.("   ")
  expect(textInput.setInput).toHaveBeenCalledTimes(1)
})

it("adds no space after one the draft already ends with", () => {
  const textInput = textInputWith("draft ")
  render(<VoiceTranscriptionBridge textInput={textInput} />)

  transcribe?.("again")
  expect(textInput.value).toBe("draft again")
})
