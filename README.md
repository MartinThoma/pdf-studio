# PDF Studio

Rearrange, rotate and delete PDF pages in the browser, combine several PDFs into one, and
download the result. Everything happens on your device: no upload, no account, no server.
After the first visit it works offline, and it can be installed as an app.

![PDF Studio with pages from two PDFs, two of them selected](docs/screenshot.png)

## Features

- **Open** one or more PDFs: drop them anywhere on the page, or use *Add PDFs*.
- **Reorder** by dragging pages; select several pages to move them together.
- **Rotate** left or right, **delete** pages; every page shows where it comes from.
- **Undo and redo** for every change.
- **Download** the result as a new PDF.
- **Keyboard**: arrows to move around, <kbd>Ctrl</kbd>+arrows to move pages, <kbd>R</kbd> to
  rotate, <kbd>Del</kbd> to delete, <kbd>Ctrl</kbd>+<kbd>Z</kbd> to undo, <kbd>?</kbd> for all
  shortcuts.
- **Touch screens**: tap to select, press and hold to drag.
- Light and dark mode, phone to desktop.

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
