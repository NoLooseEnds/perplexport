# Perplexport

Chrome extension that exports Perplexity chats to Markdown, JSON, or the clipboard — including bulk ZIP export from a project.

## Install (unpacked / developer mode)

1. Clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select this folder

## Usage

### Single thread
1. Open a chat (`/search/…`)
2. Click **Markdown** / **JSON** (last used format is remembered)

### Bulk from a project
1. Open a project (`/projects/…`) with the Sessions list
2. Click **Bulk** in the bottom-right
3. The extension scrolls the list, finds `/search/` links, and lets you select threads
4. **Start export** opens each thread in the background, collects content temporarily, and downloads a single **ZIP** at the end

Filenames inside the ZIP: `YYYY-MM-DD-title.md` / `.json`.

Everything runs locally in the browser. Bulk export needs the `tabs` permission so each thread can be opened in the background.

## License

[MIT](LICENSE)
