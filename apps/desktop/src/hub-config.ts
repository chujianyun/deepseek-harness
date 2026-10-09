/**
 * The user center Desktop signs in to. A packaged application carries the release's settings in its
 * manifest (`dshHub`); `DSH_HUB_ORIGIN` with `DSH_HUB_CLIENT_ID` in the Host environment replace them,
 * so development and test launches point at their own user center.
 */

/**
 * Prefix of every user-center configuration failure. The failure reaches the fatal dialog as text
 * through the renderer's boot report, so the dialog recognizes it by this prefix.
 */
export const HUB_NOT_CONFIGURED = 'desktop: no usable user center is configured'

/** A DSH client id as the user center issues it; packaging applies the same rule. */
const CLIENT_ID = /^[\w.-]+$/u

/** User-center settings bundled into a packaged Desktop. */
export interface DesktopHubConfig {
  readonly origin: string
  readonly clientId: string
}

/**
 * Validate the manifest's bundled user-center settings.
 * @param manifest - The parsed application manifest.
 * @returns The bundled settings, or `undefined` when the manifest carries none.
 * @throws Error carrying {@link HUB_NOT_CONFIGURED} when `dshHub` is present but malformed.
 */
export function resolveDesktopHubConfig(manifest: unknown): DesktopHubConfig | undefined {
  if (typeof manifest !== 'object' || manifest === null || !('dshHub' in manifest)) return undefined
  const value = manifest.dshHub
  if (typeof value !== 'object' || value === null || !('origin' in value) || !('clientId' in value)
    || typeof value.origin !== 'string' || typeof value.clientId !== 'string' || !CLIENT_ID.test(value.clientId)
    || URL.parse(value.origin)?.protocol !== 'https:' || URL.parse(value.origin)?.origin !== value.origin) {
    throw new Error(`${HUB_NOT_CONFIGURED} (the bundled user-center settings are invalid)`)
  }
  return { origin: value.origin, clientId: value.clientId }
}

/**
 * The Host environment with the user center filled in.
 * @param environment - The environment the Host would otherwise receive.
 * @param bundled - The packaged application's settings, if any.
 * @returns `environment` unchanged when it names a complete user center, otherwise with the bundled settings added.
 * @throws Error carrying {@link HUB_NOT_CONFIGURED} when the environment names only half a user center,
 *   or when neither it nor the package names one.
 */
export function desktopHubEnvironment(environment: NodeJS.ProcessEnv, bundled: DesktopHubConfig | undefined): NodeJS.ProcessEnv {
  const origin = environment['DSH_HUB_ORIGIN'] ?? ''
  const clientId = environment['DSH_HUB_CLIENT_ID'] ?? ''
  if (origin !== '' || clientId !== '') {
    if (origin === '' || !CLIENT_ID.test(clientId)) {
      throw new Error(`${HUB_NOT_CONFIGURED} (set both DSH_HUB_ORIGIN and DSH_HUB_CLIENT_ID)`)
    }
    return environment
  }
  if (bundled === undefined) throw new Error(`${HUB_NOT_CONFIGURED} (DSH_HUB_ORIGIN and DSH_HUB_CLIENT_ID)`)
  return { ...environment, DSH_HUB_ORIGIN: bundled.origin, DSH_HUB_CLIENT_ID: bundled.clientId }
}
