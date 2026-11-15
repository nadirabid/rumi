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

Plugin graph changes and explicit rebuild notifications reach connected clients immediately through `/plugins/events`. Packaged launches do not detect manual edits to bundle files; restart Rumi after such edits. Event delivery and malformed-frame reporting remain owned by the stock browser consumer.

<a id="configuration"></a>
## Configuration

| Field | Default | Behavior |
|---|---|---|
| `watchBundles` | `false` | Enables the stock filesystem watcher when true. |
| `pollIntervalMs` | `500` | Positive integer watch interval in milliseconds; unused when watching is disabled. |

Rumi's main process sets `RUMI_DEVELOPMENT` from its packaged state, and the bundled patch selects `watchBundles` from that value. Installed apps use event delivery alone; development launches watch bundles.

<a id="implementation"></a>
## Implementation

The host owns the event route, graph/rebuild subscriptions, and open streams, releasing all three when unloaded. It sends the same graph and rebuild frames as the stock transport. The client build bundles the upstream exported client implementation, including its stream parser, without modifying shared packages.

See [Rumi's build and installation instructions](../../../../RUMI.md#build). The app build and runtime preparation both build this client payload. Tests in [client-events.spec.ts](../../tests/client-events.spec.ts) mount the shipped patch through Loader, exercise a real HTTP event stream, and check the development watcher's disposal.

<a id="dev-note"></a>
## Dev Note

Keep protocol changes aligned with the upstream client transport. Do not restore periodic bundle polling in packaged launches to implement plugin graph delivery; the registry already publishes graph and rebuild events.
