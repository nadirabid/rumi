/** Mount the stock settings shell without restoring Rumi's hidden sidebar. */
window.__ModuleLoader__.load({
  id: '@rumi/settings',
  factory(require) {
    const React = require('react');
    const { closeTopModal } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    /** The stock shell portals its dialog to body; its sidebar trigger stays hidden. */
    function SettingsHost({ renderSlot }) {
      return h('div', { hidden: true }, renderSlot('sidebar.settings', { wide: true }));
    }

    /** The stock launcher supplies its own open action and shortcut registration. */
    function NativeLauncher({ openSettings, openPlugins, subscribe }) {
      React.useEffect(() => subscribe(page => {
        if (page === 'plugins') {
          closeTopModal(document);
          openPlugins();
        } else {
          openSettings();
        }
      }), [openSettings, openPlugins, subscribe]);
      return null;
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        const subscribe = listener => window.__RUMI_SETTINGS__?.subscribe(listener) ?? (() => {});
        const openPlugins = () => ctx.layout.selectPanel('plugins');
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'rumi-native-settings',
          children: { 'sidebar.settings': { kind: 'single', scope: 'root' } },
        }, SettingsHost));
        ctx.slots.inject('settings.launcher', () => ctx.slots.register({
          name: 'settings.launcher', priority: -1,
          inject: () => ({ subscribe, openPlugins }),
        }, NativeLauncher));
      },
    };
  },
});
