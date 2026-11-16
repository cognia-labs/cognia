---
"cognia-next": patch
---

Long streamed replies render with far less work: finished paragraphs are no longer re-parsed or re-animated as new text arrives, the ink reveal runs only on the paragraph being written (and not at all in replies past 12,000 characters), and a large code block that is still streaming re-highlights at most five times a second. A 50 KB reply now builds about a quarter of the page it used to while streaming.
