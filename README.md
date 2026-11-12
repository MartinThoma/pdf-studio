# PDF Studio

Rearrange, rotate and delete PDF pages in the browser, combine several PDFs into one, and
download the result. Everything happens on your device: no upload, no account, no server.
After the first visit it works offline, and it can be installed as an app.

![PDF Studio with pages from two PDFs, two of them selected](docs/screenshot.png)

## Features

- **Open** one or more PDFs: drop them anywhere on the page, or use *Add PDFs*.
- **Reorder** by dragging pages; select several pages to move them together.
- **Rotate** left or right, **delete** pages; every page shows where it comes from.
- **Details view**: one page large, with a strip of all pages to go through them (arrow keys,
  <kbd>D</kbd> / <kbd>G</kbd> switch between *Details* and *Arrange*).
- **Highlight** text in five colours, and **mark private parts** (names, addresses, contact data, numbers) by
  dragging over them. See [Privacy marks](#privacy-marks).
- **Select objects** in the Details view and change or delete them: text, images, annotations
  the PDF came with, and your own marks. See [Changing and deleting objects](#changing-and-deleting-objects).
- **Page operations in the Details view** are in the strip on the left: drag a page to move it,
  hover for the bin, right-click to rotate or delete. Type a page number to jump there.
- **Undo and redo** for every change.
- **Download** the result as a new PDF.
- **Keyboard**: arrows to move around, <kbd>Ctrl</kbd>+arrows to move pages, <kbd>R</kbd> to
  rotate, <kbd>Del</kbd> to delete, <kbd>Ctrl</kbd>+<kbd>Z</kbd> to undo, <kbd>?</kbd> for all
  shortcuts.
- **Touch screens**: tap to select, press and hold to drag.
- **Install** as an app (button in the top bar): opens in its own window and works without
  internet. Chrome, Edge and Android show their install prompt; on Safari and Firefox the button
  explains the steps.
- Light and dark mode, phone to desktop.

## Privacy marks

In the Details view, pick *Mark private* (<kbd>P</kbd>), choose what it is (name, address, email /
phone, ID / number, other) and drag over the text. The marked text is read from the page; if there
is none (a scan) type it into the list on the right. Every mark also has a comment field there. Marks are saved with the PDF as standard
highlight annotations, so every viewer shows them, and in the list as JSON (*Privacy list*), so a
pseudonymizing tool does not have to read the PDF at all.

![Details view with a private mark and a highlight](docs/screenshot-details.png)

**In the PDF**, each private mark is a `/Highlight` annotation with
- `/Contents`: the marked text, `/Subj`: `Privacy: Name` (or Address, …), `/NM`: a unique id,
- `/QuadPoints`: one box per line of text,
- `/PdfStudio`: `<< /Kind /Privacy /Category (name) /Placeholder ([NAME_1]) /Id (…) /Comment (…) >>`.

A highlight's comment is its `/Contents`, so viewers show it as the note; for a private mark `/Contents`
stays the marked text and the comment is in `/PdfStudio` and in the privacy list.

**In the privacy list** (`…-privacy.json`):

```json
{
  "format": "pdf-studio-privacy/1",
  "replacements": { "[NAME_1]": "Jane Doe", "[ADDRESS_1]": "Hauptstr. 1, Ulm" },
  "entries": [
    { "id": "m3", "page": 2, "category": "name", "text": "Jane Doe",
      "comment": "", "placeholder": "[NAME_1]", "rects": [[72, 640.5, 131.2, 652.5]] }
  ]
}
```

The same text in the same category always gets the same placeholder, so one person stays one
person across all pages. A tool replaces every `text` by its `placeholder` (pages and rects tell
where), and `replacements` turns the placeholders back into the originals later. Pages are
numbered as in the result, coordinates are PDF points with the origin at the bottom left. The
list contains the private texts in clear: keep it as safe as the original PDF.

Marks only annotate; they do not remove anything. Pages deleted in the editor take their marks
with them.

## Changing and deleting objects

In the Details view the *Select* tool (<kbd>S</kbd>) is active unless you pick another one. The
object under the pointer gets a dashed frame; a click selects it, dragging a rectangle selects
everything whose middle is inside, <kbd>Shift</kbd>-click adds to the selection. Clicking the
same spot again reaches what lies underneath (the text under a mark). The panel on the right
then offers what can be done: **change the text** of a text, and **delete** (<kbd>Del</kbd>).
Undo brings everything back.

- **Deleted text and images are really removed**, not covered: the page's content is rewritten
  without them, and the data of a deleted image leaves the file unless another page still shows
  it. The editor then draws the rewritten page, so what you see is what the download contains.
- **Changed text** replaces the old text, which is removed the same way. The new text is set in
  the standard font closest to the old one (Helvetica, Times or Courier, bold and italic kept),
  at the same place, size, direction and colour, so it can look a little different, and it is
  not fitted to the old width. Characters outside Western European text become "?".
- Text comes in the pieces the PDF stores it in. Depending on the program that made the PDF,
  one piece is a line, a word or sometimes a single letter; drag a rectangle to take several.
  The text after a deleted piece keeps its place.
- **Annotations** that were already in the PDF (comments, links, form fields, highlights) can be
  deleted the same way.
- Not possible yet: vector drawings (lines, shapes, charts), and single parts of a *group* (a
  form XObject, e.g. a placed logo or an imported page), which can only be deleted as a whole.
  The frame shows what a click will take.
- The font data stays in the file, so a deleted name leaves no text, but the letter shapes of
  an embedded font may remain.

## Privacy

- PDFs are read and written in the browser (pdf.js for the previews, pdf-lib for the result).
- The page's Content Security Policy blocks every request to another server, so files can't be
  sent anywhere even by mistake.
- Deleted pages are really gone. The result is a new file that contains only the kept pages,
  not the old pages as unused objects. Links between pages are cut before copying, so a link to a
  deleted page can't pull that page back in.

## Use it

It's a static site: any web server that serves the repository root works. Locally:

```bash
make run         # prints http://localhost:8000/ and the address for other devices
```

No `npm install` is needed for that. Other devices on the network can use the app, but over plain
`http://` browsers don't allow service workers, so offline mode and installing only work on
`localhost` or behind HTTPS.

Opening `index.html` directly from disk (`file://`) does not work, because browsers block ES
modules and web workers there.

To publish it, serve the repository root as it is, for example with GitHub Pages
(Settings → Pages → *Deploy from a branch*, `main`, `/ (root)`). All runtime files, including the
libraries in `vendor/`, are committed, so no build step is needed.

## Limitations

- **Encrypted PDFs** (a password, or permission restrictions only) are rejected with a message.
  Remove the protection first.
- **Not carried over:** bookmarks (outline), links between pages, and the form structure. Form
  fields still look the same but can no longer be filled in. Title, author, subject and keywords
  come from the first page's file.
- Very large files (hundreds of MB) are limited by the browser's memory.

## Development

| Command | What it does |
|---|---|
| `make run` | Local server, also reachable from the local network; prints the URLs and rewrites `asset-manifest.js` when files change (`npm start`: this computer only) |
| `npm test` | Unit tests (page operations, PDF assembly, offline file list) |
| `npm run test:browser` | End-to-end test in headless Chrome, including offline; updates the screenshots in `docs/` |
| `npm run vendor` | Copies pdf.js and pdf-lib from `node_modules/` to `vendor/` (after updating them) |
| `npm run manifest` | Rewrites `asset-manifest.js` (the files the service worker caches) |
| `npm run icons` | Renders `icons/icon.svg` into the PNG icons |

The browser test and the icon script use the installed Google Chrome through Playwright. If
Chrome is somewhere else, set `CHROME=/path/to/chrome`; set `HEADED=1` to watch the test.

### How it fits together

| File | Role |
|---|---|
| `index.html`, `src/styles.css` | Page and styles |
| `src/app.js` | UI: page grid, selection, dragging, keyboard, toasts, upload, download |
| `src/model.js` | The page list as pure functions (insert, move, rotate, remove) plus undo history |
| `src/thumbnails.js` | Previews with pdf.js, rendered lazily and kept as small JPEGs |
| `src/pdf-worker.js`, `src/worker-client.js` | Web worker that parses uploads and builds the result |
| `src/assemble.js` | Builds the result with pdf-lib: copy, rotate, strip cross-page references, drop unused objects |
| `sw.js`, `asset-manifest.js` | Service worker: caches all files on install, serves them offline |
| `vendor/` | pdf.js and pdf-lib, copied by `npm run vendor` (versions in `vendor/VERSIONS.md`) |

After changing any file the app loads, run `npm run manifest` (or keep `make run` running) and
commit `asset-manifest.js` too; `npm test` fails if you forget. Browsers that already have the
app then get the new version and offer *Reload*.

## License

MIT, see [LICENSE](LICENSE). Bundled libraries: pdf.js (Apache-2.0) and pdf-lib (MIT); their
license files are in `vendor/`.
