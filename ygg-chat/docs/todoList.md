---
paths:
  - "client/ygg-chat-r/server/tools/todoMd.ts"
---

# TODO List Tool: `server/tools/todoMd.ts`

This tool provides file-backed TODO storage as Markdown files. Names are **auto-generated** using a dictionary of fun words (e.g., "goku-sage-ember"). Four actions: create, list, read, edit.

## Storage Location

- `YGG_TODO_DIRECTORY` (optional): Override the storage directory via environment variable.
- Default: the injected host data directory (Electron `userData` or standalone `YGG_DATA_DIR`), or `${process.cwd()}/.ygg-chat-r/todos-storage` as fallback.
- All TODO files are stored in a `todos/` subfolder with `.md` extension.

## Actions

### `create`
Create a new todo list with auto-generated name. The name uses the ID_DICTIONARY to generate unique 3-word combinations.

**Parameters:**
- `content` (required): Full Markdown content for the todo list

**Returns:**
```json
{
  "success": true,
  "id": "goku-sage-ember",
  "created": true,
  "content": "# Tasks\n- [ ] Task 1"
}
```

### `list`
Returns the 5 most recently modified todo lists, sorted by modification time (newest first).

**Parameters:** None

**Returns:**
```json
{
  "success": true,
  "lists": [
    { "id": "goku-sage-ember", "modifiedAt": "2024-01-15T10:30:00.000Z" }
  ]
}
```

### `read`
Read the contents of a specific todo list.

**Parameters:**
- `name` (required): The auto-generated todo list name (e.g., "goku-sage-ember")

**Returns:**
```json
{
  "success": true,
  "exists": true,
  "content": "# Tasks\n- [ ] Task 1\n- [x] Task 2"
}
```

### `edit`
Find and replace a line in an existing todo list. Useful for marking items complete or updating text.

**Parameters:**
- `name` (required): The todo list name
- `search` / `replacement`: Text to search for and the full replacement line; every line containing the search text is replaced.
- `edits`: Alternative non-empty array of `{search, replacement}` operations, applied sequentially to evolving lines. If any search has no match, no changes are written.

**Returns:**
```json
{
  "success": true,
  "message": "Updated 1 edit",
  "content": "# Shopping List\n- [x] Buy milk",
  "edits": [
    {
      "search": "Buy milk",
      "replacement": "- [x] Buy milk",
      "matchCount": 1,
      "success": true,
      "message": "Updated 1 line containing \"Buy milk\""
    }
  ]
}
```

## Usage Examples

### Create a shopping list (name auto-generated)
```json
{
  "action": "create",
  "content": "# Shopping List\n- [ ] Buy milk\n- [ ] Buy bread\n- [ ] Buy eggs"
}
```
Returns: `{ "id": "vegeta-aurora-drift", ... }`. Pass that `id` as `name` to read/edit.

### Mark an item as complete
```json
{
  "action": "edit",
  "name": "vegeta-aurora-drift",
  "search": "Buy milk",
  "replacement": "- [x] Buy milk"
}
```

### Update item text
```json
{
  "action": "edit",
  "name": "vegeta-aurora-drift",
  "search": "Buy bread",
  "replacement": "- [ ] Buy sourdough bread"
}
```

### List recent todo lists
```json
{
  "action": "list"
}
```

### Read a specific list
```json
{
  "action": "read",
  "name": "vegeta-aurora-drift"
}
```

## ID Dictionary

Names are generated from this dictionary of words:
- ember, atlas, sage, haven, lumen, quill, cinder, aurora
- drift, marble, pioneer, fern, opal, orbit, spark, basil
- cascade, north, horizon, goku, vegeta, piccolo, gohan
- freeza, cell, bulma, trunks, broly, gurren, lagann

Example names: `goku-sage-ember`, `vegeta-aurora-drift`, `piccolo-cascade-north`
