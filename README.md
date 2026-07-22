# epub-mcp-server

## Description

**`epub-mcp-server`** is a Model Context Protocol (MCP) server that lets AI agents create, read, and edit EPUB novels. It exposes tools for reading and writing an EPUB's metadata, chapters, navigation, cover, spine, manifest, guide, and other resources — effectively giving an LLM the ability to understand and manipulate EPUB structure directly.

Written in TypeScript, it runs on **Bun** or **Deno** using the stdio transport protocol, making it suitable for integration with any MCP-compatible client such as Claude Desktop.

---

## Table of Contents

- [Installation](#installation)
  - [Prerequisites: Node.js](#prerequisites-nodejs)
  - [Option A — Direct from GitHub (Bun or Deno)](#option-a--direct-from-github-bun-or-deno)
  - [Option B — Global NPM Install](#option-b--global-npm-install)
- [Usage](#usage)
- [Features](#features)

---

## Installation

### Prerequisites: Node.js

Node.js is required for **Option B** (Global NPM Install). If you plan to use that option, install it first using one of these methods:

- **Windows / macOS**: Download the LTS installer from [nodejs.org](https://nodejs.org/) and run it.
- **Linux (apt)**: `curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs`
- **Homebrew (macOS / Linux)**: `brew install node`

Verify the installation by running `node --version` and `npm --version` in your terminal.

### Option A — Direct from GitHub (Bun or Deno)

If you have **Bun**, **Deno**, or **both** installed, you can run the server directly from `raw.githubusercontent.com` without installing it locally. No compilation or OS code-signing warnings needed.

> ⚠️ **Rate-limit notice:** This path fetches the server from `raw.githubusercontent.com` every time your MCP client starts. GitHub enforces an anonymous usage policy that limits unauthenticated requests to **60 per hour** (across all of `github.com` and its subdomains). If you exceed this limit, requests will be rejected with a `403 Forbidden` error until the window resets. Frequent restarts can trigger this — for heavy use, see [Option B](#option-b--global-npm-install) which caches everything locally.

### Option B — Global NPM Install

If you prefer a traditional Node.js/NPM setup, install the package globally from the npm registry. This downloads all dependencies locally so the server boots instantly and works 100% offline.

```bash
npm install -g epub-mcp-server
```

To update later: `npm update -g epub-mcp-server`

Because this installs a pre-built package from the registry (rather than cloning and building the repo locally), it avoids the Windows npm/node-tar `ENOENT` race that git-based (`github:user/repo`) installs are prone to.

---

## Usage

Add a configuration block to your MCP client's config file (e.g., `claude_desktop_config.json` or `.mcp.json`). Select the entries that apply to you:

**Using Bun only:**

```json
{
  "mcpServers": {
    "epub-mcp-server-bun": {
      "command": "bun",
      "args": ["run", "https://raw.githubusercontent.com/dmongrel/epub-mcp-server/master/src/index.ts"]
    }
  }
}
```

**Using Deno only:**

```json
{
  "mcpServers": {
    "epub-mcp-server-deno": {
      "command": "deno",
      "args": ["run", "--allow-env", "--allow-read", "--allow-write", "https://raw.githubusercontent.com/dmongrel/epub-mcp-server/master/src/index.ts"]
    }
  }
}
```

**Using both Bun and Deno:**

```json
{
  "mcpServers": {
    "epub-mcp-server-bun": {
      "command": "bun",
      "args": ["run", "https://raw.githubusercontent.com/dmongrel/epub-mcp-server/master/src/index.ts"]
    },
    "epub-mcp-server-deno": {
      "command": "deno",
      "args": ["run", "--allow-env", "--allow-read", "--allow-write", "https://raw.githubusercontent.com/dmongrel/epub-mcp-server/master/src/index.ts"]
    }
  }
}
```

**Using global NPM install:**

```json
{
  "mcpServers": {
    "epub-mcp-server": {
      "command": "epub-mcp-server",
      "args": []
    }
  }
}
```

---

## Features

**27 MCP tools** organized across 10 categories:

### EPUB Lifecycle
- **`new_epub`** — Create a blank EPUB on disk with title, author, and cache it in memory.
- **`read_epub`** — Parse an existing .epub from disk; returns metadata, reading order, and TOC (cached via LRU).
- **`save_epub`** — Write all cached edits back to disk atomically.
- **`close_epub`** — Free a cached EPUB's memory slot (discards unsaved edits unless already saved).
- **`reload_epub`** — Discard cache and re-parse from disk, restoring a clean state.
- **`get_cache_status`** — List all EPUBs currently held in memory with their dirty flags.
- **`get_epubs_list`** — Scan a directory for .epub files (with optional recursion).

### Content & Chapters
- **`get_chapter`** — Read one content document by its internal id, returning both plain text and raw XHTML markup.
- **`edit_chapter`** — Create, edit, or remove chapters. Supports markdown with auto-chapter splitting and full XHTML input.
- **`convert_manuscript`** — Convert an entire `.txt`, `.md`, or `.html` manuscript into EPUB chapters in one call, splitting on chapter markers.

### Metadata (Dublin Core)
- **`get_metadata`** — Read all metadata fields: identifiers, titles, languages, creators, contributors, publishers, dates, subjects, description, rights, and custom metas.
- **`edit_metadata`** — Create, edit, or remove individual metadata entries with rich attribute support (scheme, role, lang, refines, etc.).

### Covers
- **`get_cover`** — Read the front cover image; returns base64 data or writes directly to disk. Supports EPUB 3 `cover-image` and legacy EPUB 2 meta pointers.
- **`edit_cover`** — Create (adds manifest item, XHTML wrapper, spine entry, landmark, guide reference), replace, or remove the front cover.
- **`edit_back_cover`** — Create, edit, or remove a back cover image with spine/landmark/guide wiring.

### Spine & Reading Order
- **`get_spine`** — Read reading order including page progression direction (ltr/rtl), linear flags, and properties.
- **`edit_spine`** — Add, reorder, or remove spine entries; adjust linear flag and properties.

### Manifest
- **`get_manifest`** — List every manifest item with id, media type, properties (cover-image, nav, scripted), fallbacks, and media-overlay references.
- **`edit_manifest`** — Modify existing items' media type, properties, or fallback/media-overlay pointers.

### Guide (Legacy EPUB 2)
- **`get_guide`** — Read legacy guide landmarks (type, title, href).
- **`edit_guide`** — Create, edit, or remove individual guide references by type.

### Navigation & TOC
- **`get_navigation`** — Read navigation document: table of contents, landmarks, and page-list as a typed tree structure. Includes NCX presence flag.
- **`edit_navigation`** — Create nested entries, edit labels/hrefs/types, or remove entries with their children. Auto-syncs legacy NCX for TOC changes.

### Resources (Stylesheets, Fonts, Media)
- **`get_resource`** — Read any non-content manifest resource as text or base64; write directly to disk via `sourcePath`.
- **`edit_resource`** — Create (adds to manifest, not spine), replace, or remove resources. Media type auto-guessed from extension.

### Utility
- **`get_context`** — List all available tools with descriptions and extended usage guidance.
