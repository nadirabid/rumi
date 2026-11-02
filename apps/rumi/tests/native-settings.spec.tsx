// @vitest-environment jsdom
/** Native actions delegate to the stock settings shell and Plugins panel. */
import * as React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('mounts the stock settings slot and delegates native menu actions', async () => {
  type LauncherProps = { openSettings: () => void; openPlugins: () => void; subscribe: (listener: (page: string) => void) => () => void }
  type HostProps = { renderSlot: (name: string, props: { wide: boolean }) => React.ReactNode }
  type Registration = { name: string; children?: object; inject?: () => Omit<LauncherProps, 'openSettings'> }
  let loaded!: { factory: (require: (name: string) => unknown) => { apply: (ctx: object) => void } }
  vi.stubGlobal('__ModuleLoader__', { load: (entry: typeof loaded) => { loaded = entry } })
  await import('../brand/settings/client.js')
  let listener!: (page: string) => void
  const off = vi.fn()
  vi.stubGlobal('__RUMI_SETTINGS__', { subscribe: (callback: typeof listener) => { listener = callback; return off } })
  const entries = new Map<string, { options: Registration; component: React.ComponentType<LauncherProps & HostProps> }>()
  const selectPanel = vi.fn(), openSettings = vi.fn(), closeTopModal = vi.fn()
  loaded.factory(name => name === 'react' ? React : { closeTopModal }).apply({
    layout: { selectPanel },
    slots: {
      inject: (_name: string, callback: () => void) => { callback() },
      register: (options: Registration, component: React.ComponentType<LauncherProps & HostProps>) => {
        entries.set(options.name, { options, component })
        return () => {}
      },
    },
  })
  const host = entries.get('shell.overlay')!
  expect(host.options.children).toEqual({ 'sidebar.settings': { kind: 'single', scope: 'root' } })
  const launcher = entries.get('settings.launcher')!
  const injected = launcher.options.inject!()
  const renderSlot = vi.fn(() => <span>Stock settings shell</span>)
  const mounted = render(React.createElement(host.component, { ...injected, openSettings, renderSlot }))
  expect(renderSlot).toHaveBeenCalledWith('sidebar.settings', { wide: true })
  expect(mounted.container.firstElementChild?.hasAttribute('hidden')).toBe(true)
  mounted.unmount()
  const bridge = render(React.createElement(launcher.component, { ...injected, openSettings, renderSlot }))
  act(() => { listener('settings') })
  expect(openSettings).toHaveBeenCalledOnce()
  expect(selectPanel).not.toHaveBeenCalled()
  act(() => { listener('plugins') })
  expect(closeTopModal).toHaveBeenCalledWith(document)
  expect(selectPanel).toHaveBeenCalledWith('plugins')
  bridge.unmount()
  expect(off).toHaveBeenCalledOnce()
})
