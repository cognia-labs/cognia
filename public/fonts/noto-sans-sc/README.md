# Noto Sans SC: bundled PDF font

`NotoSansSC-Regular.ttf` is the font the PDF writer embeds for text that
jsPDF's built-in fonts can't draw (`lib/files/document-writer/unicode-font.ts`):
simplified and traditional Chinese (every GBK and Big5 ideograph), Japanese
kana, the Russian alphabet, unaccented Greek letters and typographic
punctuation. It is fetched only when an export needs it. jsPDF embeds a
subset holding just the glyphs a PDF uses, so the exported file stays small.

It covers 30,445 characters, every BMP character the upstream font maps. It
has no Hangul, accented Greek, Ukrainian letters or emoji, and jsPDF reads
only the BMP character map. The writer refuses those characters and names
them.

## Provenance

- Upstream: `ofl/notosanssc/NotoSansSC[wght].ttf` from
  <https://github.com/google/fonts> (Version 2.004, 17,772,300 bytes,
  SHA-256 `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`).
- Licence: SIL Open Font License 1.1, in [`OFL.txt`](./OFL.txt), copied from
  the same directory. The Reserved Font Name is "Source", which this file
  does not use.
- This file: SHA-256
  `9c8264a1f25ad4a3d80a2129348674ec0ac50916efc8d8fc37bdab4d9586be94`,
  10,143,256 bytes.

## How it was made

jsPDF reads TrueType outlines only, and it does not apply variation axes. The
upstream file is a variable font whose default instance is Thin, so it was
instanced at Regular and trimmed with fontTools 4.68.0:

```python
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset

font = instantiateVariableFont(TTFont("NotoSansSC[wght].ttf"), {"wght": 400}, updateFontNames=True)
options = subset.Options()
options.layout_features = []  # jsPDF does no shaping
options.hinting = False
options.drop_tables += ["GSUB", "GPOS", "GDEF", "BASE", "JSTF", "DSIG", "vhea", "vmtx", "VORG", "meta", "STAT"]
options.name_IDs = ["*"]
options.notdef_outline = True
options.glyph_names = False
subsetter = subset.Subsetter(options)
subsetter.populate(unicodes=[c for c in font.getBestCmap() if c <= 0xFFFF])
subsetter.subset(font)
font.save("NotoSansSC-Regular.ttf")
```
