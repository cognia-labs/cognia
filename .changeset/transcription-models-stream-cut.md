---
"cognia-next": patch
---

Attachment transcription now offers each provider's real transcription models (for example OpenAI's gpt-transcribe and whisper-1, Groq's Whisper, Mistral's Voxtral) instead of its chat models, refuses chat models for audio and transcription-only models for describing video frames, and hides providers whose transcription Cognia cannot reach. Streamed read-aloud no longer splits a spaced card or phone number across two fragments: when the text around an early cut is sensitive, the first fragment waits for the sentence to end.
