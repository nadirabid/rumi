/** Removal of legacy Desktop Host cookies from Electron session storage. */

/** Prefix of cookies used by earlier releases. */
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
 * Remove legacy Host cookies for the loopback hostname across all ports.
 * @param cookies - Electron's session cookie store.
 * @param launchUrl - Address of the owned Host.
 * @returns Completion after every matching cookie is removed.
 */
export async function clearLaunchCookies(cookies: LaunchCookieStore, launchUrl: string): Promise<void> {
  const origin = new URL(launchUrl).origin
  for (const cookie of await cookies.get({ url: origin })) {
    if (!cookie.name.startsWith(LAUNCH_COOKIE_PREFIX)) continue
    await cookies.remove(origin, cookie.name)
  }
}
