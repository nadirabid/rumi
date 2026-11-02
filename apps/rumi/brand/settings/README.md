# Rumi native settings

English | [中文](README.zh.md)

Rumi → Settings… (⌘,) opens the stock DSH settings dialog. Rumi → Plugins… opens the stock Plugins page. Their forms, available options, storage, and validation remain owned by the stock plugins; this bundle has no editable configuration or credential routes.

Rumi disables the navigation sidebar. This bundle declares its `sidebar.settings` slot under `shell.overlay` and renders the stock settings shell inside a hidden container. The shell's dialog portals to the document body; its unused sidebar trigger stays hidden. A `settings.launcher` occupant subscribes to native menu events and calls the shell's own `openSettings` action. The stock shell registers the keyboard shortcut. The Plugins action closes an open modal and selects the existing Plugins panel.

The native preload exposes the menu subscription only on Rumi's product origin. Unmounting the launcher removes its subscription. The integration contributes no model-visible input.
