# Local audio codec dependencies

The generic audio converter uses pinned local packages, inside the disposable audio Worker. Audio bytes are never sent to a codec service. Do not replace a package's bundled implementation on the basis of its wrapper license alone.

| Package                    | Version | License and source                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@wasm-audio-decoders/aac` | 0.0.1   | Wrapper: MIT. Embedded FAAD2: GPL-2.0-or-later, used under GPLv3 terms alongside Cognia's AGPLv3. [Wrapper source](https://github.com/eshaz/wasm-audio-decoders/tree/main/src/aac), [FAAD2 source and copyright header](https://github.com/knik0/faad2/blob/master/libfaad/decoder.c), [license text](https://github.com/knik0/faad2/blob/master/COPYING). |
| `mediabunny`               | 1.62.1  | MPL-2.0. [Pinned source, including license](https://github.com/Vanilagy/mediabunny/tree/v1.62.1). Only the in-memory MP4 reader is used; no URL/file-system source or browser decoder is instantiated.                                                                                                                                                     |

Code from FAAD2 is copyright (c) Nero AG, www.nero.com

The AAC wrapper's `MIT` npm field describes its original JavaScript, not the embedded decoder. Preserve both sets of notices and provide the corresponding source when redistributing codec binaries. The dependency source archives and exact integrity hashes are recorded in `pnpm-lock.yaml`; the wrapper's source map and upstream repository identify the build and decoder source. No dependency source was modified by this integration.

AAC/M4A admission is owned by `lib/audio/aac.ts`; shared formats/limits by `lib/audio/formats.ts`; downmixing, resampling and WAV/SILK output remain in `lib/audio/transcode-core.ts`. ADTS frames are completely validated before decoding. MP4 sample tables, edit lists, byte ranges and encryption are checked before container parsing; irrelevant metadata is masked without changing media offsets. The buffer reader and AAC decoder never receive a path, URL or provider credential.
