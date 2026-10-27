/**
 * Rumi brand — browser half.
 *
 * Occupies the sidebar brand seats so the app shows its own wordmark instead
 * of the DeepSeek Harness mark. Plain components, no build step: the shell
 * provides React and the slot registry at runtime.
 */
window.__ModuleLoader__.load({
  id: '@rumi/brand',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * The wordmark, not a glyph: the app icon is the word "rumi" set in Arial,
     * and the sidebar and hero repeat it in the same face so the mark inside
     * the app matches the one in the Dock.
     */
    const FONT = 'Arial, Helvetica, "Helvetica Neue", sans-serif';

    /** Plain wordmark; `size` is the caller's icon box, scaled to set type. */
    function Wordmark({ size = 26, className }) {
      return h('span', {
        className,
        role: 'img',
        'aria-label': 'Rumi',
        style: {
          fontFamily: FONT,
          fontSize: Math.round(size * 0.65),
          fontWeight: 400,
          letterSpacing: '-0.012em',
          lineHeight: 1,
          whiteSpace: 'nowrap',
          userSelect: 'none',
          color: 'inherit',
        },
      }, 'rumi');
    }

    /** The wordmark already names the product; the name seat stays empty. */
    function NoName() {
      return null;
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
          name: 'sidebar.brand.mark',
          id: 'rumi-brand',
        }, Wordmark));
        ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
          name: 'sidebar.brand.name',
          id: 'rumi-brand',
        }, NoName));
        ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
          name: 'conversation.hero.brand.mark',
          id: 'rumi-brand',
        }, Wordmark));
      },
    };
  },
});
