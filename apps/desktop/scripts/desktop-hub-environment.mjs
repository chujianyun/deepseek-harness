/** Resolve the user center a packaged Desktop signs in to from file-owned release settings. */

/**
 * Resolve the bundled user-center settings before preparing artifacts or accessing signing hardware.
 * Every package needs both values: Desktop opens its workspace only after a user-center sign-in, and an
 * installed application has no other source for them.
 * @param {NodeJS.ProcessEnv} environment File-owned release settings.
 * @returns {{ origin: string, clientId: string }} The HTTPS user-center origin and its registered DSH client id.
 */
export function resolveDesktopHubEnvironment(environment) {
  const value = environment.DSH_DESKTOP_HUB_ORIGIN
  let url
  try { url = new URL(value ?? '') } catch { throw new Error('desktop package: DSH_DESKTOP_HUB_ORIGIN requires an HTTPS origin') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('desktop package: DSH_DESKTOP_HUB_ORIGIN requires an HTTPS origin without credentials, path, query, or fragment')
  }
  const clientId = environment.DSH_DESKTOP_HUB_CLIENT_ID
  if (clientId === undefined || !/^[\w.-]+$/u.test(clientId)) {
    throw new Error('desktop package: DSH_DESKTOP_HUB_CLIENT_ID requires the DSH client id registered in the user center')
  }
  return { origin: url.origin, clientId }
}
