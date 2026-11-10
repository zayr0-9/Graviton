# Ygg-Chat Skills

Skills are folders containing instructions that teach the AI how to perform specialized tasks.

## Installing Skills

Use the Skills settings panel in the app to:
- Browse and install skills from GitHub
- Import local skill folders
- Enable/disable installed skills

## Creating Your Own Skills

Each skill is a folder containing at minimum a `SKILL.md` file:

```
my-skill/
├── SKILL.md          # Required - instructions and metadata
├── scripts/          # Optional - executable scripts
├── references/       # Optional - additional documentation
└── assets/           # Optional - templates, images, data files
```

### SKILL.md Format

```markdown
---
name: my-skill
description: A clear description of what this skill does and when to use it.
---

# My Skill Instructions

Step-by-step instructions for the AI to follow...
```

## Learn More

- Agent Skills Specification: https://agentskills.io/specification
- Official Skills Repository: https://github.com/anthropics/skills
