# ADMP Documentation

Generated documentation for the Agent Dispatch Messaging Protocol.

| File | Audience | Description |
|------|----------|-------------|
| [AGENT-GUIDE.md](AGENT-GUIDE.md) | AI agents & developers | Full integration guide with code examples |
| [API-REFERENCE.md](API-REFERENCE.md) | Developers | Complete endpoint reference (50+ endpoints) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Operators & contributors | System architecture with Mermaid diagrams |
| [ERROR-CODES.md](ERROR-CODES.md) | Developers & agents | All error codes with retry guidance |
| [../llms.txt](../llms.txt) | AI agents | Concise machine-readable reference |

## Regenerating

These docs are generated from source code using the [docs-generator config](../docs-generator.json).

To regenerate after source changes:

```
/docs-generator
```

This runs the docs-generator skill in Claude Code, reading all source files listed in `docs-generator.json` and regenerating the output files.
