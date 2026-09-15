---
paths:
  - "client/ygg-chat-r/server/tools/todoMd.ts"
---

# TODO List Tool: `electron/tools/todoMd.ts`

This tool provides file-backed TODO storage as Markdown files. Names are **auto-generated** using a dictionary of fun words (e.g., "goku-sage-ember"). Four actions: create, list, read, edit.

## Storage Location

- `YGG_TODO_DIRECTORY` (optional): Override the storage directory via environment variable.
- Default: Electron's `userData` directory, or `${process.cwd()}/.ygg-chat-r/todos-storage` as fallback.
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
  "name": "goku-sage-ember",
  "path": "/path/to/todos/goku-sage-ember.md",
  "created": true
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
    { "name": "goku-sage-ember", "path": "/path/to/todos/goku-sage-ember.md", "modifiedAt": "2024-01-15T10:30:00.000Z" }
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
  "name": "goku-sage-ember",
  "path": "/path/to/todos/goku-sage-ember.md",
  "exists": true,
  "content": "# Tasks\n- [ ] Task 1\n- [x] Task 2"
}
```

### `edit`
Find and replace a line in an existing todo list. Useful for marking items complete or updating text.

**Parameters:**
- `name` (required): The todo list name
- `search` (required): Text to search for (matches any line containing this text)
- `replacement` (required): The full replacement line

**Returns:**
```json
{
  "name": "goku-sage-ember",
  "path": "/path/to/todos/goku-sage-ember.md",
  "success": true,
  "linesMatched": 1,
  "message": "Replaced 1 line(s) containing \"Buy milk\""
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
Returns: `{ "name": "vegeta-aurora-drift", ... }`

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
