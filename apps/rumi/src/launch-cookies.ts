/** Session cookies minted by earlier launches of this app. */

/** Every launch mints `dsh-auth-<authority hash>`; the Host accepts only its own. */
const LAUNCH_COOKIE_PREFIX = 'dsh-auth-'

/** The subset of Electron's cookie store this module needs. */
export interface LaunchCookieStore {
  /**
   * @param filter - URL filter; the origin of the current launch.
   * @returns cookies stored for it.
   */
  get(filter: { url: string }): Promise<readonly { name: string }[]>
  /**
   * @param url - cookie origin.
   * @param name - cookie to remove.
   * @returns completion.
   */
  remove(url: string, name: string): Promise<void>
}

/**
 * Drop launch cookies left by earlier runs.
 *
 * A launch token is minted for one authority and dies with that process, but
 * its cookie outlives it. The Host rejects the welcome's authenticated fetch
 * once enough stale ones are sent alongside the fresh cookie, and nothing else
 * prunes them — so the app clears them before connecting. The current launch's
 * cookie is minted by that connect, after this runs.
 * @param cookies - Electron's session cookie store.
 * @param launchUrl - URL the Host reported ready at; its origin scopes the sweep.
 * @returns completion; a store failure leaves the launch to fail loudly at connect.
 */
export async function clearLaunchCookies(cookies: LaunchCookieStore, launchUrl: string): Promise<void> {
  const origin = new URL(launchUrl).origin
  for (const cookie of await cookies.get({ url: origin })) {
    if (!cookie.name.startsWith(LAUNCH_COOKIE_PREFIX)) continue
    await cookies.remove(origin, cookie.name)
  }
}
