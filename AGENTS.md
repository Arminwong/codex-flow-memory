# Flow Memory repository instructions

## Documentation is part of every feature change

`使用说明.md` is the product and behavior specification for this plugin.

Whenever a change affects functionality, UI text or interaction, MCP tools, supported file types, persistence, safety behavior, installation, limitations, or the version number, update `使用说明.md` in the same change. A feature change is incomplete until the documentation matches the tested behavior.

After editing, run the relevant tests and verify that the document does not promise capabilities the plugin cannot currently provide.
