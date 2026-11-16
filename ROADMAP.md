# Roadmap

Open work for PDF Studio. Each item has a short, stable name (`R-SOME_NAME`) instead of a number,
so items can be referred to in commits and issues and finishing one never renumbers the rest.

- **When an item is done, delete it from this file** (in the same commit as the work). What has
  been done is in the git history and, where users need to know, in the README.
- Names are never reused for something else.
- The order within a section is a rough priority, not a commitment.

## Robustness on phones and with large files

PDF Studio claims to work entirely on the device. On a phone, a file that opens fine on a desktop
can exhaust memory, because parsing, previews and export each hold their own copy. These items
make that claim dependable.

### R-DEAD_WORKER_HANDLING

If the browser kills the PDF worker (out of memory is the likely cause on phones), the app
should notice instead of waiting forever. Today [src/worker-client.js](src/worker-client.js) rejects
pending calls only when the worker fires an `error` event, which an out-of-memory kill probably
doesn't do. After the worker dies it is also never restarted, and all parsed sources are gone.

Done when: a dead worker is detected (for example with a timeout or a heartbeat), the user sees
what happened and what to do, and a new worker is started. Either the open files are added
again from their bytes, or the user is told to open them again.

### R-CUT_EXTRA_COPY

Opening a file briefly holds three copies of its bytes: `file.arrayBuffer()`, the copy sent to the
pdf-lib worker, and the copy for pdf.js ([src/app.js](src/app.js) `addFiles` / `addToWorker`,
[src/thumbnails.js](src/thumbnails.js) `openPreviewDocument`). Transfer the original buffer to one
of them and copy once, and drop the main-thread copy as soon as it isn't needed. The extra copy
for retrying a password should only be made when a password is actually asked for.

Done when: opening a file makes at most one copy in addition to the buffer that is transferred.

### R-PHONE_MEMORY_TEST

Check the app on real phones: one low-end or mid-range Android phone (about 3–4 GB RAM, Chrome)
and one iPhone (Safari). Desktop emulation is not enough: it slows the CPU, but it doesn't limit
memory. Use a set of test files: a large scan (many pages of images), a long text PDF, a file with
many small objects, and several files added together. For each one, run open, scroll through all
previews, the Details view, and export, with and without a password.

Done when: the results are written down (in `docs/` or here), and the README line "Very large
files (hundreds of MB) are limited by the browser's memory" is replaced with measured numbers
("on a phone with 4 GB, scans up to about X MB / Y pages worked").

### R-LARGE_FILE_WARNING

Warn before a file is opened when it is likely to be too big for the device. A soft warning, not
a hard limit, because memory use depends on what is in the file (images, number of objects), not
only on its size. Base the threshold on R-PHONE_MEMORY_TEST. Where the browser reports
`navigator.deviceMemory` (Chromium only), the threshold can be lower for small devices.

Done when: opening a file above the threshold says so and lets the user continue or skip it.

### R-CANCEL_LONG_OPERATIONS

Opening files and exporting can't be cancelled; only preview rendering can. Cancelling work in the
worker means terminating it and parsing all open files again (see R-DEAD_WORKER_HANDLING, which
needs the same restart). Only worth doing if R-PHONE_MEMORY_TEST shows that opening a file or
exporting takes long enough on a phone that people would want to stop it.

Done when: a long open or export shows a *Cancel* button, and cancelling leaves the
pages that were already there as they were.

## Editing gaps

Things the editor can't do yet (see *Changing and deleting objects* and *Limitations* in the
README).

### R-DELETE_VECTOR_DRAWINGS

Select and delete vector drawings (lines, shapes, charts), like text and images.

### R-EDIT_INSIDE_GROUPS

Select and delete single parts of a group (form XObject, for example a placed logo or an imported
page). Today a group can only be deleted as a whole.

### R-REMOVE_DELETED_GLYPHS

After text is deleted, the letter shapes of an embedded font can stay in the file. For privacy
marks and deleted names, subset or drop font glyphs that no remaining text uses, so the deleted
text can't be reconstructed from the font.

### R-CHANGED_TEXT_UNICODE

Changed text is set in a standard font, and characters outside Western European text become "?".
Embed a font that covers the new text instead.

### R-KEEP_BOOKMARKS_AND_LINKS

Carry the outline (bookmarks) and links between pages over to the result, pointing at the pages'
new positions. Drop bookmarks and links to deleted pages.

### R-KEEP_FORM_FIELDS

Keep the form structure so that form fields can still be filled in after the pages are rearranged.
Today they still look the same but are no longer fields.

### R-CERTIFICATE_PDFS

Open PDFs protected with public-key security (certificates). Low priority: needs the user's
private key in the browser.

## Design consistency

See [DESIGN.md](DESIGN.md).

### R-TOKENIZE_HARDCODED_COLORS

A few styles in [src/styles.css](src/styles.css) hardcode colours instead of using the tokens, so
they don't follow dark mode: the selection frame (`.pick`, `.draft.select`, and the `.draft`
background use light-mode `#2847c4`), and the mark delete dot (`.mark-delete`, `#d92b2b` instead
of `--danger`). The privacy and highlight colours (`#f03c64`, `#d92b57`, `#e8b800`) are repeated
in several rules and could become custom properties too.

Done when: these rules use custom properties, and the selection frame looks right in dark mode.
