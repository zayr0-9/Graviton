// shared/builtinToolDefinitions.ts
// Canonical static built-in tool schemas shared by frontend + headless server.

export interface SharedToolDefinition {
  name: string
  enabled: boolean
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

export const BUILTIN_TOOL_DEFINITIONS: SharedToolDefinition[] = [
  {
    name: 'todo_list',
    enabled: true,
    description:
      'Manage Markdown todo lists stored as .md files. Names are auto-generated (e.g., "goku-sage-ember"). Four actions: create, list, read, edit.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'read', 'edit'],
          description:
            'Action to perform: "create" = create a new todo list (name auto-generated, returns the generated name); "list" = show 5 most recent todo lists; "read" = get contents of a specific list by name; "edit" = find and replace a line in an existing list.',
        },
        name: {
          type: 'string',
          description:
            'Todo list name (required for read, edit). Use the auto-generated name returned from "create" or shown in "list".',
        },
        content: {
          type: 'string',
          description:
            'Full Markdown content for "create" action. Use standard Markdown checkbox format: "- [ ] Task" for pending, "- [x] Task" for completed.',
        },
        search: {
          type: 'string',
          description:
            'For "edit" action: text to search for. Matches any line containing this text. Example: "Buy milk" will match line "- [ ] Buy milk".',
        },
        replacement: {
          type: 'string',
          description:
            'For "edit" action: the full replacement line. Example: to mark done, use "- [x] Buy milk". To update text, use "- [ ] Buy 2% milk".',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'plan_md',
    enabled: true,
    description:
      'Create, list, read, edit, display, or clarify Markdown plans stored in the project .ygg/plans directory. Use clarify to ask the user structured planning questions with selectable options plus a manual answer option; the user answers are returned as the tool result so the model can continue.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'read', 'edit', 'display', 'clarify'],
          description:
            'Action to perform: create writes a new Markdown plan; list shows recent plans; read returns one plan; edit replaces matching lines; display shows a plan to the user; clarify asks the user interactive questions and returns their answers.',
        },
        name: {
          type: 'string',
          description: 'Plan name. Required for read, edit, and display; optional for create.',
        },
        content: {
          type: 'string',
          description: 'Markdown content for the create action.',
        },
        search: {
          type: 'string',
          description: 'For edit action: line substring to find. Every line containing this text is replaced.',
        },
        replacement: {
          type: 'string',
          description: 'For edit action: full replacement line.',
        },
        cwd: {
          type: 'string',
          description: 'Workspace directory whose .ygg/plans directory stores plan files.',
        },
        questions: {
          type: 'array',
          description:
            'Clarification questions for the user before final plan output. Used only with action=clarify. Each question may provide options; the UI will always include a manual answer option.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              question: { type: 'string' },
              description: { type: 'string' },
              manualLabel: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                  additionalProperties: false,
                },
              },
            },
            required: ['question'],
            additionalProperties: false,
          },
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'theme_manager',
    enabled: true,
    description:
      'Manage custom chat theme JSON files in the managed .ygg/custom-themes directory. Use "template" to get the full schema/default theme, "list" to inspect saved themes, "read" to load one by name, "save" to write a validated theme JSON file, or "delete" to remove a saved theme.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['template', 'list', 'read', 'save', 'delete'],
          description:
            'Action to perform: "template" returns the default theme JSON/schema, "list" shows saved themes, "read" loads one theme by name, "save" validates and writes a theme JSON file, and "delete" removes a saved theme.',
        },
        name: {
          type: 'string',
          description:
            'Theme name or file slug. Required for "read" and "delete". Optional for "save"; if omitted, the tool uses theme.name.',
        },
        theme: {
          type: 'object',
          description:
            'Full or partial theme JSON object for "save". Missing keys are filled from the default theme schema before writing.',
          additionalProperties: true,
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'fetch_chats',
    enabled: true,
    description:
      'Browse local chats and branches. Can list chats, fetch compact chat summaries by id, search chats, search top-level messages, search note summaries, fetch notes for a conversation, or read a linear message segment from a specific branch starting at a message id.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_chats', 'get_chats', 'search_chats', 'search_messages', 'search_notes', 'get_notes', 'read_branch'],
          description:
            'Action to perform: "list_chats" returns recent chats with compact metadata and top-level branch messages. "get_chats" returns one or more chats by conversation id. "search_chats" searches chats by title using the same local search path used by the sidebar. "search_messages" searches top-level user messages using the same local path used by the sidebar message search. "search_notes" searches note summaries using the note-memory search endpoint and returns matching conversation/message ids plus relevant note snippets. "get_notes" returns all notes for a specific conversation with message ids. "read_branch" returns a linear segment of messages from a specific message id until a branch point or the end of the branch.',
        },
        conversationId: {
          type: 'string',
          description: 'Conversation id for "get_chats" or "get_notes". Optional for "list_chats".',
        },
        conversationIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple conversation ids for "get_chats".',
        },
        userId: {
          type: 'string',
          description: 'User id for "search_chats", "search_messages", or "search_notes". Optional when it can be inferred from the current conversation or provided conversationId.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id filter for "search_chats", "search_messages", or "search_notes".',
        },
        query: {
          type: 'string',
          description: 'Search query for "search_chats", "search_messages", or "search_notes".',
        },
        branchPointAncestorId: {
          type: 'string',
          description: 'Optional branch parent id used by note fetching flows.',
        },
        messageId: {
          type: 'string',
          description: 'Required for "read_branch". Starting message id for the branch read.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum number of returned chats or notes depending on action (default 50).',
        },
        includeEmpty: {
          type: 'boolean',
          description: 'For note fetching, include messages even when note is empty/null. Default is false.',
        },
        includeContentPreview: {
          type: 'boolean',
          description: 'If true, include truncated content_preview fields where applicable. Default is true for chat and branch reads.',
        },
        previewChars: {
          type: 'integer',
          minimum: 20,
          maximum: 1200,
          description: 'Maximum characters for content previews (default 180).',
        },
        offset: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'For "read_branch", number of linear messages to return starting from skip (default 10).',
        },
        skip: {
          type: 'integer',
          minimum: 0,
          description: 'For "read_branch", number of messages to skip from the start of the computed linear branch segment.',
        },
      },
    },
  },
  {
    name: 'internalLink',
    enabled: true,
    description:
      'Resolve in-app navigation links for projects, conversations, and message branches. Accepts projectId, conversationId, and/or messageId and returns a normalized internal route for clickable UI navigation.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Optional project id. If used alone, routes to the project conversation page.',
        },
        project_id: {
          type: 'string',
          description: 'Alias for projectId.',
        },
        conversationId: {
          type: 'string',
          description: 'Optional conversation id. Routes to the chat for that conversation.',
        },
        conversation_id: {
          type: 'string',
          description: 'Alias for conversationId.',
        },
        messageId: {
          type: 'string',
          description:
            'Optional message id. If provided, the tool resolves its conversation and returns a route anchored to that message branch.',
        },
        message_id: {
          type: 'string',
          description: 'Alias for messageId.',
        },
        chatMessageId: {
          type: 'string',
          description: 'Alias for messageId (chat message id).',
        },
        label: {
          type: 'string',
          description: 'Optional display label for UI rendering.',
        },
      },
    },
  },
  {
    name: 'read_file',
    enabled: true,
    description:
      'Read the contents of a text file (code, config, docs). Supports reading full files, single ranges, or multiple disjoint ranges. Returns file metadata (line endings, encoding, modification time) and optional content hash for validation. Range info is in metadata only - content returned matches exactly what is in the file. Rejects likely-binary files and truncates large files for safety.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path to read (absolute or relative)' },
        cwd: {
          type: 'string',
          description:
            'Optional working directory to resolve relative paths from. Must stay within workspace scope when a workspace root is set.',
        },
        maxBytes: {
          type: 'integer',
          minimum: 1,
          maximum: 5242880,
          description: 'Optional safety limit on bytes to read (1 to 5MB); defaults to 204800 (200KB)',
        },
        startLine: {
          type: 'integer',
          minimum: 1,
          description:
            'Optional 1-based line number to start reading from (inclusive). Use for single range reads. Ignored if ranges is provided.',
        },
        endLine: {
          type: 'integer',
          minimum: 1,
          description:
            'Optional 1-based line number to stop reading at (inclusive). Use with startLine for single range. Ignored if ranges is provided.',
        },
        ranges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              startLine: { type: 'integer', minimum: 1, description: '1-based start line (inclusive)' },
              endLine: { type: 'integer', minimum: 1, description: '1-based end line (inclusive)' },
            },
            required: ['startLine', 'endLine'],
          },
          description:
            'Array of line range objects to read multiple disjoint sections. Format: [{"startLine": 10, "endLine": 50}, {"startLine": 100, "endLine": 150}]. Range details are returned in metadata.ranges field. Takes precedence over startLine/endLine params.',
        },
        includeHash: {
          type: 'boolean',
          description: 'Calculate SHA256 content hash for validation with edit_file (default false)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_files',
    enabled: true,
    description:
      "Read multiple text/code/config files and return a single concatenated string, separated by each file's relative path header.",
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'Array of file paths to read. Example: ["src/index.ts", "src/utils.ts", "/absolute/path/file.js"]',
        },
        baseDir: {
          type: 'string',
          description: 'Optional base directory used to compute the relative path header.',
        },
        cwd: {
          type: 'string',
          description:
            'Optional working directory to resolve relative paths from. Must stay within workspace scope when a workspace root is set.',
        },
        maxBytes: {
          type: 'integer',
          minimum: 1,
          maximum: 5242880,
          description: 'Optional per-file safety limit on bytes to read (1 to 5MB); defaults to 204800 (200KB)',
        },
        startLine: {
          type: 'integer',
          minimum: 1,
          description: 'Optional 1-based line number to start reading from (inclusive). Applies to all files.',
        },
        endLine: {
          type: 'integer',
          minimum: 1,
          description: 'Optional 1-based line number to stop reading at (inclusive). Applies to all files.',
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'read_file_continuation',
    enabled: true,
    description:
      'Read the next chunk of a file after a specific line number. Designed for pagination to avoid duplicate reads. Use this when you previously read a file up to line N and want to continue reading from line N+1. Returns file metadata and optional content hash for validation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path to read (absolute or relative)' },
        cwd: {
          type: 'string',
          description:
            'Optional working directory to resolve relative paths from. Must stay within workspace scope when a workspace root is set.',
        },
        afterLine: {
          type: 'integer',
          minimum: 0,
          description: '1-based line number to start reading after (exclusive). Use 0 to read from the beginning.',
        },
        numLines: {
          type: 'integer',
          minimum: 1,
          description: 'Number of lines to read after the specified line',
        },
        maxBytes: {
          type: 'integer',
          minimum: 1,
          maximum: 5242880,
          description: 'Optional safety limit on bytes to read (1 to 5MB); defaults to 204800 (200KB)',
        },
        includeHash: {
          type: 'boolean',
          description: 'Calculate SHA256 content hash for validation with edit_file (default false)',
        },
      },
      required: ['path', 'afterLine', 'numLines'],
    },
  },
  {
    name: 'create_file',
    enabled: true,
    description: 'Create a new text file with optional parent directory creation and overwrite support.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to create (absolute or relative).' },
        content: { type: 'string', description: 'Initial content to write to the file; defaults to empty.' },
        cwd: {
          type: 'string',
          description: 'Optional working directory to resolve relative paths from. Must stay within workspace scope when a workspace root is set.',
        },
        createParentDirs: {
          type: 'boolean',
          description: 'If true, create parent directories as needed (default true).',
        },
        overwrite: { type: 'boolean', description: 'If true, overwrite existing file (default false).' },
        executable: { type: 'boolean', description: 'If true, make the file executable on POSIX systems.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'delete_file',
    enabled: true,
    description: 'Delete a file at the specified path. Optionally restrict deletions to specific file extensions.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to delete (absolute or relative).' },
        allowedExtensions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Restrict deletions to specific extensions. Example: [".txt", ".json", ".log"]. Include the dot prefix.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'view_image',
    enabled: true,
    description:
      'View a local image from the filesystem. Use this when given a full filepath to an image, including generated_images paths, and you need to inspect it visually. Returns an input_image data URL for the model plus metadata. Do not use for non-image files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Local filesystem path to an image file, absolute or relative to cwd/workspace.' },
        cwd: {
          type: 'string',
          description: 'Optional working directory used to resolve relative paths. Must stay within workspace scope when provided.',
        },
        detail: {
          type: 'string',
          enum: ['high', 'original'],
          description: 'Image detail hint. Use high by default; use original only when exact pixel-level detail is needed.',
        },
        maxBytes: {
          type: 'integer',
          minimum: 1,
          maximum: 20971520,
          description: 'Optional maximum image file size in bytes. Defaults to 20MB.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    enabled: true,
    description:
      'Edit a file using search/replace or append. Operations: "replace" (all occurrences), "replace_first" (first match only), "append" (add to end). Uses layered matching: exact -> line-ending normalized -> whitespace normalized -> fuzzy. approxStartLine and approxEndLine are required on every call; replace_first uses them to search a local window first, then falls back to full-file search if needed. Escape sequences like \\n, \\t, \\r are interpreted in search patterns by default. Replacement text is treated literally by default to avoid accidental source corruption. Supports content validation using hash and metadata from read_file to prevent editing stale content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path to the file to edit' },
        operation: {
          type: 'string',
          enum: ['replace', 'replace_first', 'append'],
          description: 'Type of edit operation',
        },
        searchPattern: {
          type: 'string',
          description:
            'REQUIRED for replace/replace_first operations. The exact text pattern to find in the file. Escape sequences like \\n (newline), \\t (tab), \\r (carriage return) are interpreted by default.',
        },
        replacement: {
          type: 'string',
          description:
            'REQUIRED for replace/replace_first operations. The text to replace the search pattern with. Treated literally by default; include actual newlines in the string when needed.',
        },
        approxStartLine: {
          type: 'integer',
          minimum: 1,
          description:
            'REQUIRED. Approximate start line hint. replace_first searches a local window around this line first (default Â±100 lines) before falling back to full-file search.',
        },
        approxEndLine: {
          type: 'integer',
          minimum: 1,
          description:
            'REQUIRED. Approximate end line hint. Combine with approxStartLine to bound the preferred window. For non-range edits you can pass the same value for start and end.',
        },
        content: {
          type: 'string',
          description: 'REQUIRED for append operation. The content to append to the end of the file.',
        },
        createBackup: { type: 'boolean', description: 'Whether to create a backup before editing (default false)' },
        encoding: { type: 'string', description: 'File encoding (default utf8)' },
        validateContent: {
          type: 'boolean',
          description: 'Validate file has not changed since read using metadata checks when provided (default true)',
        },
        expectedHash: {
          type: 'string',
          description: 'Optional SHA256 content hash from read_file. Accepted for compatibility, but mismatches do not block editing.',
        },
        expectedMetadata: {
          type: 'object',
          properties: {
            lineEnding: { type: 'string', enum: ['\n', '\r\n', 'mixed'] },
            hasBOM: { type: 'boolean' },
            encoding: { type: 'string' },
            lastModified: { type: 'string' },
            inode: { type: 'number' },
          },
          description: 'Expected file metadata from read_file for validation',
        },
      },
      required: ['path', 'operation', 'approxStartLine', 'approxEndLine'],
    },
  },
  {
    name: 'multi_edit',
    enabled: true,
    description:
      'Apply multiple edit_file-style operations sequentially across one or more files. Each item uses the same search/replace or append behavior as edit_file and returns a per-item result summary.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'The path to the file to edit' },
              operation: {
                type: 'string',
                enum: ['replace', 'replace_first', 'append'],
                description: 'Type of edit operation',
              },
              searchPattern: {
                type: 'string',
                description:
                  'REQUIRED for replace/replace_first operations. The exact text pattern to find in the file. Escape sequences like \n (newline), \t (tab), \r (carriage return) are interpreted by default.',
              },
              replacement: {
                type: 'string',
                description:
                  'REQUIRED for replace/replace_first operations. The text to replace the search pattern with. Treated literally by default; include actual newlines in the string when needed.',
              },
              approxStartLine: {
                type: 'integer',
                minimum: 1,
                description:
                  'Optional approximate start line hint. replace_first searches a local window around this line first (default Â±100 lines) before falling back to full-file search.',
              },
              approxEndLine: {
                type: 'integer',
                minimum: 1,
                description:
                  'Optional approximate end line hint. Combine with approxStartLine to bound the preferred window. For non-range edits you can pass the same value for start and end.',
              },
              content: {
                type: 'string',
                description: 'REQUIRED for append operation. The content to append to the end of the file.',
              },
              expectedHash: {
                type: 'string',
                description: 'Optional SHA256 content hash from read_file. Accepted for compatibility, but mismatches do not block editing.',
              },
              expectedMetadata: {
                type: 'object',
                properties: {
                  lineEnding: { type: 'string', enum: ['\n', '\r\n', 'mixed'] },
                  hasBOM: { type: 'boolean' },
                  encoding: { type: 'string' },
                  lastModified: { type: 'string' },
                  inode: { type: 'number' },
                },
                description: 'Expected file metadata from read_file for validation',
              },
            },
            required: ['path', 'operation'],
          },
          description:
            'Ordered list of edit operations to execute sequentially. Later edits run after earlier edits complete, so you can edit the same file multiple times in one call.',
        },
        stopOnError: {
          type: 'boolean',
          description: 'If true, stop after the first failed edit (default true). If false, continue processing remaining edits.',
        },
        createBackup: { type: 'boolean', description: 'Whether to create a backup before each edit (default false)' },
        encoding: { type: 'string', description: 'File encoding (default utf8)' },
        validateContent: {
          type: 'boolean',
          description: 'Validate each file has not changed since read using hash/metadata (default true)',
        },
      },
      required: ['edits'],
    },
  },
  {
    name: 'search_history',
    enabled: false,
    description: 'Search chat history across user, project, or conversation using the DB FTS utilities.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to run' },
        userId: {
          type: 'integer',
          description: 'User ID to scope search. Pass null or omit to search all users.',
        },
        projectId: {
          type: 'integer',
          description: 'Project ID to scope search. Pass null or omit to search all projects.',
        },
        conversationId: {
          type: 'integer',
          description: 'Conversation ID to scope search. Pass null or omit to search all conversations.',
        },
        limit: { type: 'integer', description: 'Optional result limit (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'brave_search',
    enabled: true,
    description:
      'Search the web using Brave Search API. Returns web search results with titles, URLs, and descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to execute' },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Number of results to return (default 10, max 20)',
        },
        offset: { type: 'integer', minimum: 0, description: 'Number of results to skip (default 0)' },
        safesearch: {
          type: 'string',
          enum: ['strict', 'moderate', 'off'],
          description: 'Safe search setting (default moderate)',
        },
        country: { type: 'string', description: 'Country code for localized results (e.g., "US", "GB")' },
        search_lang: {
          type: 'string',
          description:
            'Language for search results using Brave-supported codes (e.g., "en", "es", "pt-br", "zh-hant"). Must be one of Brave Search API\'s allowed values.',
        },
        extra_snippets: { type: 'boolean', description: 'Include extra snippets in results' },
        summary: { type: 'boolean', description: 'Include AI-generated summary' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ripgrep',
    enabled: true,
    description:
      'Search files using ripgrep (rg). Supports regex, file filtering, context lines. Limits: max 500 matches, 5000 total chars, 500 chars/line. Use glob filter (e.g., "*.ts"), maxCount, or narrower patterns if limits exceeded.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex or literal string)' },
        searchPath: {
          type: 'string',
          description: 'Directory or file path to search (defaults to current directory ".")',
        },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive search (default false for case-insensitive)' },
        lineNumbers: { type: 'boolean', description: 'Include line numbers in results (default true)' },
        count: {
          type: 'boolean',
          description: 'Count matches per file instead of showing line content (default false)',
        },
        filesWithMatches: { type: 'boolean', description: 'List only filenames with matches (default false)' },
        maxCount: { type: 'integer', minimum: 1, description: 'Maximum matches per file' },
        glob: { type: 'string', description: 'File pattern glob (e.g., "*.ts", "src/**/*.js")' },
        hidden: { type: 'boolean', description: 'Search hidden files and directories (default false)' },
        noIgnore: { type: 'boolean', description: 'Ignore .gitignore rules (default false)' },
        contextLines: {
          type: 'integer',
          minimum: 0,
          description: 'Show N lines of context before and after matches',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    enabled: true,
    description:
      'Run bash commands inside the workspace. On Windows/Electron, paths are automatically converted to the default WSL distribution for compatibility.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        description: {
          type: 'string',
          description:
            'Brief human-readable explanation of what the command is for. Required so humans can quickly understand the purpose of the bash call without parsing the command itself.',
        },
        cwd: { type: 'string', description: 'Working directory for the command' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Environment variables as key-value object. Example: {"NODE_ENV": "production", "DEBUG": "true"}',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 100,
          maximum: 120000,
          description: 'Optional timeout in milliseconds (default 0 meaning no timeout)',
        },
        maxOutputChars: {
          type: 'integer',
          minimum: 100,
          maximum: 500000,
          description: 'Optional limit on total captured output characters (default 20000)',
        },
      },
      required: ['command', 'description'],
    },
  },
  {
    name: 'powershell',
    enabled: true,
    description:
      'Run native PowerShell commands inside the workspace. Intended for Windows-specific shell syntax and tooling. On non-Windows platforms this uses pwsh when available.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to execute' },
        description: {
          type: 'string',
          description:
            'Brief human-readable explanation of what the command is for. Required so humans can quickly understand the purpose of the PowerShell call without parsing the command itself.',
        },
        cwd: { type: 'string', description: 'Working directory for the command' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Environment variables as key-value object. Example: {"NODE_ENV": "production", "DEBUG": "true"}',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 100,
          maximum: 120000,
          description: 'Optional timeout in milliseconds (default 0 meaning no timeout)',
        },
        maxOutputChars: {
          type: 'integer',
          minimum: 100,
          maximum: 500000,
          description: 'Optional limit on total captured output characters (default 20000)',
        },
      },
      required: ['command', 'description'],
    },
  },
  {
    name: 'html_renderer',
    enabled: true,
    description:
      'Render and sanitize an HTML snippet. Returns sanitized HTML suitable for embedding as a content block. Always treat output as untrusted; client will re-sanitize before rendering.',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'Raw HTML to sanitize and return' },
        allowUnsafe: {
          type: 'boolean',
          description:
            'If true, skip sanitization (not recommended). Defaults to false. Output is still re-sanitized client-side.',
        },
      },
      required: ['html'],
    },
  },
  {
    name: 'glob',
    enabled: true,
    description: 'Search for files using glob patterns with flexible matching and filtering options',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files (e.g., "*.ts", "src/**/*.js")' },
        cwd: { type: 'string', description: 'Current working directory to search from' },
        ignore: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Patterns to exclude. String or array. Example: ["node_modules/**", "*.test.ts"] or "dist/**"',
        },
        dot: { type: 'boolean', description: 'Include dotfiles (default: false)' },
        absolute: { type: 'boolean', description: 'Return absolute paths (default: false)' },
        mark: { type: 'boolean', description: 'Add / suffix to directories (default: false)' },
        nosort: { type: 'boolean', description: 'Do not sort results (default: false)' },
        nocase: { type: 'boolean', description: 'Case-insensitive matching on Windows (default: false)' },
        nodir: { type: 'boolean', description: 'Do not match directories (default: false)' },
        follow: { type: 'boolean', description: 'Follow symbolic links (default: false)' },
        realpath: { type: 'boolean', description: 'Return resolved absolute paths (default: false)' },
        stat: { type: 'boolean', description: 'Call stat() on all results (default: false)' },
        withFileTypes: { type: 'boolean', description: 'Return file type objects instead of paths (default: false)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'browse_web',
    enabled: true,
    description:
      'Browse a web page and extract its content, including text, headings, links, images, and metadata. Uses Playwright to handle JavaScript-rendered content. Supports both headless and non-headless modes for bot detection avoidance. Use headless mode as default unless specified by user.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'The URL to browse and extract content from' },
        waitForSelector: {
          type: 'string',
          description: 'Optional CSS selector to wait for before extracting content',
        },
        timeout: {
          type: 'integer',
          minimum: 5000,
          maximum: 60000,
          description: 'Timeout in milliseconds (default 30000)',
        },
        waitForNetworkIdle: {
          type: 'boolean',
          description: 'Wait for network to be idle before extracting (default true)',
        },
        extractImages: { type: 'boolean', description: 'Extract image information (default true)' },
        extractLinks: { type: 'boolean', description: 'Extract link information (default true)' },
        extractMetadata: { type: 'boolean', description: 'Extract page metadata (default true)' },
        headless: {
          type: 'boolean',
          description: 'Run browser in headless mode (default true). Set to false to avoid bot detection.',
        },
        useUserProfile: {
          type: 'boolean',
          description:
            'Use existing browser profile with your cookies and extensions (default false). Only works with headless=false.',
        },
        userDataDir: {
          type: 'string',
          description:
            'Browser profile path for useUserProfile=true. Linux: "~/.config/google-chrome", Windows: "%LOCALAPPDATA%\\Google\\Chrome\\User Data", macOS: "~/Library/Application Support/Google/Chrome"',
        },
        retries: {
          type: 'integer',
          minimum: 0,
          maximum: 5,
          description: 'Number of retry attempts if browsing fails (default 2)',
        },
        retryDelay: {
          type: 'integer',
          minimum: 100,
          maximum: 10000,
          description: 'Delay between retries in milliseconds (default 1000)',
        },
        useBrave: { type: 'boolean', description: 'Use Brave browser instead of Chromium (default false)' },
        executablePath: {
          type: 'string',
          description: 'Custom path to browser executable (overrides useBrave)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'custom_tool_manager',
    enabled: true,
    description:
      'Manage and invoke custom tools on demand. Actions: list/get definitions, invoke a custom tool by name, enable/disable tools, add/remove tools, reload definitions, and configure auto-refresh watcher settings.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'invoke', 'enable', 'disable', 'add', 'remove', 'reload', 'settings'],
          description:
            'Action to perform: "list" and "get" discover tools, "invoke" executes a custom tool, "enable"/"disable" toggle availability, "add"/"remove" manage tool folders, "reload" re-scan tools, and "settings" gets/updates auto-refresh watcher settings.',
        },
        names: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For "get" action: array of tool names to retrieve full definitions for. Example: ["my_tool", "another_tool"]',
        },
        name: {
          type: 'string',
          description: 'Tool name for "invoke", "enable", "disable", or "remove" actions.',
        },
        args: {
          type: 'object',
          description:
            'For "invoke" action: argument object to pass to the target custom tool. Must match that tool\'s inputSchema.',
          default: {},
        },
        sourcePath: {
          type: 'string',
          description: 'For "add" action: source directory path containing definition.json and index.js.',
        },
        directoryName: {
          type: 'string',
          description: 'Optional target directory name inside the managed custom-tools folder when using "add".',
        },
        overwrite: {
          type: 'boolean',
          description: 'For "add" action: overwrite existing target directory if true.',
        },
        autoRefresh: {
          type: 'boolean',
          description: 'For "settings" action: enable or disable filesystem auto-refresh watcher.',
        },
        refreshDebounceMs: {
          type: 'integer',
          minimum: 100,
          maximum: 5000,
          description: 'For "settings" action: debounce delay in milliseconds for watcher-triggered reloads.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'mcp_manager',
    enabled: true,
    description:
      'Discover MCP servers on demand. Use "list" to see configured servers, "get" for details, "stop" to stop a server, and "list_tools" to start a server if needed and retrieve its tools.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'stop', 'list_tools'],
          description: 'Action to perform',
        },
        name: {
          type: 'string',
          description: 'MCP server name (required for get/start/stop/restart/list_tools)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'skill_manager',
    enabled: true,
    description:
      'Discover and activate specialized skills that provide detailed instructions for specific tasks. Use "list" to see available skills, "activate" to load a skill\'s instructions, or "load_resource" to fetch additional files (scripts, references, assets) from a skill.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'activate', 'load_resource'],
          description:
            'Action to perform: "list" = show all enabled skills; "activate" = load skill instructions; "load_resource" = fetch a resource file from the skill',
        },
        name: {
          type: 'string',
          description: 'Skill name (required for activate and load_resource actions)',
        },
        resourcePath: {
          type: 'string',
          description:
            'Path to resource file within the skill (e.g., "references/FORMS.md"). Required for load_resource action.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'subagent',
    enabled: true,
    description:
      'Spawn an agentic sub-agent to perform complex tasks using tool calls. The subagent can use tools like read_file, ripgrep, browse_web etc. to accomplish tasks autonomously. Messages are persisted and can be reviewed. Use orchestratorMode=true to specify exact tools, or false to use pre-configured default tools.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The task prompt for the subagent. Be specific and provide all necessary context.',
        },
        model: {
          type: 'string',
          description:
            'Model to use for the subagent (e.g., "anthropic/claude-sonnet-4", "openai/gpt-4o", "google/gemini-2.0-flash"). If omitted, defaults to the Global Agent model from Settings (or openai/gpt-5.1-codex-mini when unset).',
        },
        systemPrompt: {
          type: 'string',
          description: 'Optional system prompt to set the subagent behavior/persona.',
        },
        temperature: {
          type: 'number',
          minimum: 0,
          maximum: 2,
          description: 'Sampling temperature (0-2, default 0.7). Lower = more focused, higher = more creative.',
        },
        orchestratorMode: {
          type: 'boolean',
          description:
            'If true, use tools specified in `tools` parameter. If false, use pre-configured subagent tool list from settings. Default: false.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Tool names to enable for subagent (only used when orchestratorMode=true). Example: ["read_file", "bash", "ripgrep", "brave_search"]. The subagent tool itself is always excluded to prevent recursion.',
        },
        inheritAutoApprove: {
          type: 'boolean',
          description:
            'If true, inherit parent auto-approve setting for tool calls. If false, always require approval for subagent tool calls. Default: true.',
        },
        sessionId: {
          type: 'string',
          description:
            'Optional existing subagent session id to resume. Only used when resume=true. Phase 1 resume requires the conversation messages to already be loaded in the frontend cache.',
        },
        resume: {
          type: 'boolean',
          description:
            'If true and sessionId is provided, continue an existing persisted subagent session instead of starting a new one.',
        },
      },
      required: ['prompt'],
    },
  },
]

export default BUILTIN_TOOL_DEFINITIONS



