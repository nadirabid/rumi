---
description: "Keep Rumi's plugin UI synchronized without polling packaged bundle files."
kind: "package-bundle"
---

# Rumi client events

English | [中文](README.zh.md)

## Summary

Rumi reflects plugin activation, removal, and explicit rebuild notifications without periodically checking packaged JavaScript files. The app includes this bundle automatically. Development launches retain the stock bundle watcher. This bundle contributes no model-visible input.

## Table of Contents

- [Use this bundle](#use-this-bundle)
- [Configuration](#configuration)
- [Implementation](#implementation)
- [Dev Note](#dev-note)

<a id="use-this-bundle"></a>
## Use this bundle

The Rumi profile includes `@rumi/client-events` from the app's bundled runtime. Its patch disables the stock `client-hmr` host row and mounts `rumi-client-events`; the browser uses the stock event consumer under the Rumi package identity. No separate installation or user setting is needed.

Plugin graph changes, synced configuration, and explicit rebuild notifications reach authorized clients through the `pluginEvents/follow` Remote stream. Restart Rumi after manually editing a packaged bundle. The stock browser consumer owns event delivery and malformed-frame reporting.

<a id="configuration"></a>
## Configuration

| Field | Default | Behavior |
|---|---|---|
| `watchBundles` | `false` | Enables the stock filesystem watcher when true. |
| `pollIntervalMs` | `500` | Positive integer watch interval in milliseconds; unused when watching is disabled. |

Rumi's main process sets `RUMI_DEVELOPMENT` from its packaged state, and the bundled patch selects `watchBundles` from that value. Installed apps use event delivery alone; development launches watch bundles.

<a id="implementation"></a>
## Implementation

The packaged host mounts the upstream PluginEvents service without its bundle watcher. The profile asks the Typert loader to register the upstream Host descriptor, and the browser runs the upstream consumer under Rumi's bundle identity. Every stream starts from a fresh graph shaped by its caller's Remote access.

See [Rumi's build and installation instructions](../../../../RUMI.md#build). The app build and runtime preparation compile the upstream provider and consumer into this bundle. Tests in [client-events.spec.ts](../../tests/client-events.spec.ts) mount the shipped patch through Loader, exercise the provider's stream, and check the development watcher's disposal.

<a id="dev-note"></a>
## Dev Note

Keep protocol changes aligned with the upstream client transport. Do not restore periodic bundle polling in packaged launches to implement plugin graph delivery; the registry already publishes graph and rebuild events.
