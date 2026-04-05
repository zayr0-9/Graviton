![Banner](docs/assets/images/banner2.png)

# Graviton

Graviton is a **local-first AI workspace** and an **agent harness**:
it can **read & write files**, **search code**, **run shell commands**, and **invoke tools**—while also supporting **parallel + branching workflows** and **stateful inline apps**.

> Core thesis: **LLMs work best with iterative workflows**

---

## What you get

### 1) Parallel + branching workflows (Heimdall tree)

Humans don’t solve problems linearly. Graviton is built around **branching conversations** and **tree navigation** so you can explore tangents, test alternatives, and keep clean context boundaries.

- **Every edit is a branch** (no history loss)
- **Non-linear exploration** without context pollution
- **Search across your full chat history**

#### Demo videos

https://github.com/user-attachments/assets/e57ef035-fb6d-417b-ae62-ca24cb5b8889

https://github.com/user-attachments/assets/6ea5744a-6ee8-4b57-bdf1-dc6bf7132d22

### 2) AI apps

Tools can return **HTML** that renders in a sandboxed iframe _inside the chat thread_ (or in a Tool Manager overlay). This enables “AI Apps”, not just text, context from these apps is excluded from the chat:

- dashboards
- editors
- workflow runners
- file/search UIs
- generators (PDF/PPTX/media pipelines), etc.
- games?

#### AI apps demos

Custom apps in chat

https://github.com/user-attachments/assets/88a9b8fd-ce8a-4cec-ad94-b6ae897c72a3

Extra features overview

https://github.com/user-attachments/assets/4593e725-6635-45e4-b245-31c8d39a33cc

### 4) Persistent background agent (Beta)

In desktop mode, Graviton supports a persistent “global agent” loop that can run queued work in the background via the same chat/tool stack (with explicit permission gates).

### 5) A builder ecosystem (custom tools + MCP + skills)

Graviton includes:

- built-in tools (file ops, search, shell, etc.)
- **custom tools** (drop-in tool folders, create your own)
- **MCP integration**
- skills (installable capability bundles)

---

## VS Code Integration

The companion VS Code extension provides seamless workspace integration:

- Access files in your VS Code workspace directly
- Insert file contents into chat using the `@` symbol
- Add selected context from IDE

Get the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=GravitonAI97.yggdrasil-extension).

## The Vision Behind Graviton

Born from frustration with linear LLM interfaces that fail to match human thinking patterns, Graviton represents a fundamental shift in how we interact with AI systems.

### Preserving Thought History

Our conversations with AI systems contain valuable records of how we think, reason and solve problems. Graviton transforms these interactions into navigable mind maps, showing how you approach any topic.

### Addressing the Documentation Crisis

Traditional programming preserved change history through version control and documentation. With AI-generated code often discarded in chat conversations, we're losing crucial development context. Graviton provides proper logging and easy access to AI usage history.

### Superior Learning Tool

By encapsulating different topics into isolated branches, Graviton prevents both:

- **Context pollution** for the LLM
- **Visual pollution** for the user
- **Growing token cost**

This creates cleaner, more focused learning experiences.

Our back-and-forth conversations with AI systems generate valuable data that's currently being wasted. Graviton's mission is to help users better visualize and manage this conversation data, transforming ephemeral chat into persistent, navigable knowledge structures.

## Future

This project has grown a bit too much and I think it would do better as an opensource project. I see the future of Graviton as a layer running on top of windows/mac/linux, an abstraction fully automated with an agent.
Each user can with a prompt, adjust the UI/UX of their app, make it more productive for themselves, or easier to use for someone with visual impairment for example.

Bespoke software, for everyone.

## Current Status

Graviton is now out of beta. It is pretty stable in its main operation. If you encounter any bug or have a feature request, please open an issue on GitHub.

I would love to have feedback and contributions from the community.

---

## Project Structure

```
yggdrasil_client/
└── ygg-chat/
    ├── client/
    │   └── ygg-chat-r/     # React UI + Electron runtime + local server + tools
    ├── shared/             # Shared types/assets
    └── docs/               # Documentation
```

## Getting Started (Development)

## Build

```bash
cd ygg-chat/client/ygg-chat-r
npm install --workspaces=false --include=optional
npm run build:win
```

Dependent on your platform you can use -

`npm run build:win`
`npm run build:linux`
`npm run build:mac`

### If you run into native module issues, try:

```bash
npm --prefix client/ygg-chat-r run rebuild:client
```

```bash
cd ygg-chat/client/ygg-chat-r
npm install --workspaces=false --include=optional
npm run dev
```

- Web UI: http://localhost:5173

### Electron (desktop dev)

```bash
cd ygg-chat/client/ygg-chat-r
npm run electron
```

### Why not MIT from day one?

We are currently using AGPL-3.0 to discourage closed-source forks/clones during the early stage.
We will revisit licensing (MIT) once the project reaches stronger maturity/traction.

# License

Licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. See [LICENSE](license.md). If you run a modified version as a network service, the AGPL requires you to offer the corresponding source code to users of that service.
