# Kids Book Studio

A **Kids Book** tab on theaibookgenerator.com for making illustrated children's books that print at home as a folded booklet. The novel tabs are unchanged.

## Flow

1. **Book**: title, author, reader age, premise, art style, page count (a multiple of 4, because each folded sheet makes 4 pages), and either one story or chapters.
2. **Cast & Sheets**: drop in a picture of your characters. The writing AI identifies each character and describes them, then the image AI draws character, prop and environment model sheets. Those sheets are sent as references with every page illustration so characters stay consistent.
3. **Story**: write the whole story in one go, or plan chapters and then write each one. You can rewrite single pages or revise the whole story with an instruction. The page budget always matches the booklet size.
4. **Illustrations**: generate, regenerate or upload a picture for each page and the cover. Older versions are kept so you can switch back.
5. **Design**: words and pictures together on one page or on separate facing pages (book-wide, with per-page overrides on the Story tab); title and story fonts (about 30 kid-friendly Google Fonts), size, colors, margins, cover and back-cover layouts, cover title size/height/width/alignment/outline plus subtitle and author-line size and position, blurb, and front/back pages (title page, copyright, dedication, contents, about the author/illustrator, "The End", custom pages). It has a live preview of the spreads.
6. **Print**: booklet imposition for duplex printing on 8.5 × 11 (or A4). Pick short- or long-edge flip, or print fronts only and backs only for printers without duplex. You can also download a standalone print file, or a **PDF with the pages in reading order** (150 or 300 dpi), or print the pages in order and "Save as PDF" for a vector PDF.

### Image generators
- **Gemini** (`gemini-2.5-flash-image`, `gemini-3-pro-image-preview`, or any model id)
- **OpenAI** (`gpt-image-1`, `gpt-image-1-mini`). Reference sheets go through the edits endpoint.
- **ComfyUI** (local, free). Start ComfyUI with `--enable-cors-header "*"` so the page can reach it. The built-in workflow is plain text-to-image with a checkpoint you pick. For character consistency, paste your own API-format workflow using the placeholders `{{prompt}}`, `{{negative}}`, `{{seed}}`, `{{width}}`, `{{height}}`, `{{checkpoint}}`, `{{steps}}`, `{{cfg}}`, and `{{image1}}`, `{{image2}}`… for the reference sheets (uploaded automatically).
- **Placeholder** makes free test images for checking layout and printing.

### Storage
- **Browser** (default): the book is kept in localStorage and the pictures in IndexedDB. Use Export .json/Import to move a book, with its pictures embedded in the file. **Pictures .zip** saves every picture as a normal image file (cover, pages by page number, cast sheets, references; optionally older versions).
- **MCP bridge**: books live on disk in `~/AIBookGenerator/kids-books`, shared with Claude/ChatGPT and updated live.

## MCP: work from Claude Desktop or ChatGPT instead of paying for API tokens

`mcp/server.mjs` is an MCP server with 25 tools: create/open books, cast, `get_writing_brief` → `write_story`, page edits, sheet/page/cover generation, `view_image`, design, back cover, matter pages, print plan, and print-file export. The writing is done by your chat app. Images still use the configured generator, and ComfyUI keeps that free.

```bash
npm install
```

**Claude Desktop**: Settings → Developer → Edit Config:

```json
{
  "mcpServers": {
    "kids-book": {
      "command": "node",
      "args": ["C:\\_Main\\projects\\ai\\novellm\\mcp\\server.mjs"],
      "env": { "COMFY_URL": "http://127.0.0.1:8188" }
    }
  }
}
```

Claude launches the server, which also starts the bridge on `http://127.0.0.1:7801`. On the website, go to Kids Book → Settings → MCP bridge → *Check connection*, then open a book or *Send this book to the bridge*. If Chrome asks to allow access to your local network, allow it. Chrome and Edge work; Safari blocks http://localhost from https pages.

**Bridge without Claude open:**

```bash
npm run kids-mcp
```

**ChatGPT** (desktop/web connectors need an HTTPS URL):

```bash
set KIDSBOOK_MCP_TOKEN=pick-a-long-secret
npm run kids-mcp
cloudflared tunnel --url http://127.0.0.1:7801
```

Then in ChatGPT → Settings → Connectors → Advanced → Developer mode, add `https://<tunnel-host>/mcp/pick-a-long-secret`.

Image keys for MCP-side generation come either from the website (Settings → *Send image-generator settings*, with keys optional) or from the env vars `GEMINI_API_KEY`, `OPENAI_API_KEY`, `COMFY_URL` and `KIDSBOOK_IMAGE_PROVIDER`.

Other env vars: `KIDSBOOK_DATA_DIR`, `KIDSBOOK_PORT`, and `KIDSBOOK_ALLOWED_ORIGINS` (comma-separated; theaibookgenerator.com and localhost are always allowed).

Useful URLs while the bridge runs: `http://127.0.0.1:7801/preview/<bookId>` shows the spreads, and `http://127.0.0.1:7801/print/<bookId>` gives print-ready sheets.

## Code map
- `src/kids/model.js` holds the book model, page plan and saddle-stitch imposition. It is shared by the browser and the MCP server.
- `src/kids/prompts.js` builds the prompts for story, sheets, pages and cover.
- `src/kids/layout.js` is the single HTML/CSS layout engine for preview, print and export, with auto-fit text.
- `src/kids/imageProviders.js` and `src/kids/textAI.js` call the providers. They are isomorphic `fetch` code.
- `src/kids/storage.js` handles IndexedDB/localStorage and the bridge client.
- `src/kids/*.jsx` is the UI, lazy-loaded from `App.jsx`.
- `mcp/server.mjs` and `mcp/store.mjs` are the MCP tools, the HTTP bridge (with SSE live updates) and the file storage.
